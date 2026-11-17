/**
 * Contract C4: a saved workflow keeps its storage identity at run time. A document is resolved by the name it is
 * stored under, never by its own `name` field: `run_workflow` and a saved `call` target validate it as the saved
 * name, an agent's embedded workflow has no identity (`null`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateWorkflow } from "../../../src/workflow/validate.ts";
import type { WorkflowDocument } from "../../../src/workflow/types.ts";
import { asObject, doc, setupWorkflow } from "./helpers.ts";

/** A trivial workflow: one counting tool call, its data as the result. */
const helper = (): WorkflowDocument =>
  doc({ id: "work", kind: "tool", tool: "count", args: { label: "helper", value: "done" } }, { $ref: "steps.work.data" }, { name: "helper" });

/** A document whose own `name` is `name` and whose root calls the saved workflow `target`. */
const caller = (name: string, target: string): WorkflowDocument =>
  doc({ id: "inner", kind: "call", workflow: target, input: {} }, { $ref: "steps.inner" }, { name });

const runWorkflowScript = (name: string) => ({
  turns: [{ toolCalls: [{ name: "run_workflow", args: { name, input: {} } }] }, { text: "got {{last_result}}" }],
});

test("a workflow saved as main whose name is helper, calling the saved helper, runs through run_workflow and a call node", async (t) => {
  const s = await setupWorkflow(t);
  await s.h.store.saveWorkflow({ name: "helper", source: "api", document: helper() });
  await s.h.store.saveWorkflow({ name: "main", source: "api", document: caller("helper", "helper") });

  const viaTool = await s.run(await s.agent({ script: runWorkflowScript("main"), tools: [{ name: "run_workflow" }, { name: "count" }] }), null);
  assert.equal(viaTool.status, "completed", JSON.stringify(viaTool.error));
  assert.equal(asObject(viaTool.output)["text"], `got "done"`);

  const viaCall = await s.run(await s.agent({ workflow: caller("third", "main") }), {});
  assert.equal(viaCall.status, "completed", JSON.stringify(viaCall.error));
  assert.equal(viaCall.output, "done");
  assert.equal(s.counters.get("count", "helper"), 2);
});

test("an agent's embedded workflow named helper that calls the saved helper runs", async (t) => {
  const s = await setupWorkflow(t);
  await s.h.store.saveWorkflow({ name: "helper", source: "api", document: helper() });
  const done = await s.run(await s.agent({ workflow: caller("helper", "helper") }), {});
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(done.output, "done");
  assert.equal(s.counters.get("count", "helper"), 1);
});

test("a saved workflow that really calls itself is a call cycle when it is saved and when it runs", async (t) => {
  const looping = caller("whatever", "loop");
  const atSave = validateWorkflow(looping, { savedAs: "loop" });
  assert.deepEqual(atSave.problems.filter((p) => p.code === "call_cycle").map((p) => [p.path, p.message]),
    [["$.root.workflow", "call nodes form a cycle: loop -> loop"]]);

  const s = await setupWorkflow(t);
  await s.h.store.saveWorkflow({ name: "loop", source: "api", document: looping });
  const viaCall = await s.run(await s.agent({ workflow: caller("top", "loop") }), {});
  assert.equal(viaCall.status, "failed");
  assert.match(viaCall.error?.message ?? "", /call nodes form a cycle: loop -> loop/);

  const viaTool = await s.run(await s.agent({ script: runWorkflowScript("loop"), tools: [{ name: "run_workflow" }] }), null);
  assert.equal(viaTool.status, "completed", JSON.stringify(viaTool.error));
  assert.match(String(asObject(viaTool.output)["text"]), /^got workflow "loop" failed: .*call nodes form a cycle: loop -> loop/);
});
