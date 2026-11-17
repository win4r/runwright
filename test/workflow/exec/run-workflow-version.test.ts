import { test } from "node:test";
import assert from "node:assert/strict";
import type { JsonObject } from "../../../src/core/json.ts";
import type { WorkflowDocument } from "../../../src/workflow/types.ts";
import { asObject, setupWorkflow, untilRecord } from "./helpers.ts";

const summary = { type: "object", required: ["text"], properties: { text: { type: "string" } } };

/** Version `tag` of the saved workflow "report": marks itself with a counting tool, then a slow model step. */
function version(tag: string): WorkflowDocument {
  return {
    format: "runwright.workflow/v1", name: "report", schemas: { In: {}, Out: {}, Summary: summary }, input: "In", output: "Out",
    root: { id: "main", kind: "sequence", steps: [
      { id: "mark", kind: "tool", tool: "count", args: { label: `mark-${tag}` } },
      { id: "slow", kind: "model", prompt: "x", output: "Summary" },
    ] },
    result: `${tag}:{{steps.slow.text}}`,
  };
}

function caller(args: JsonObject, delayMs = 0) {
  return {
    turns: [
      { toolCalls: [{ name: "run_workflow", args }] },
      { text: "got {{last_result}}" },
    ],
    steps: { slow: { output: { text: "done" }, delayMs } },
  };
}

const TOOLS = [{ name: "run_workflow" }, { name: "count" }];

test("run_workflow runs exactly the version asked for, and the latest without one", async (t) => {
  const s = await setupWorkflow(t);
  await s.h.store.saveWorkflow({ name: "report", source: "api", document: version("v1") });
  assert.equal((await s.h.store.saveWorkflow({ name: "report", source: "api", document: version("v2") })).workflow.version, 2);

  const pinned = await s.run(await s.agent({ script: caller({ name: "report", version: 1 }), tools: TOOLS }), null);
  assert.equal(pinned.status, "completed", JSON.stringify(pinned.error));
  assert.equal(asObject(pinned.output)["text"], `got "v1:done"`);
  const resolved = (await s.h.journal(pinned.id)).filter((r) => r.type === "step.finished" && r.data["name"] === "workflow.resolve");
  assert.deepEqual(resolved.map((r) => r.data["value"]), [{ version: 1 }]);

  const latest = await s.run(await s.agent({ script: caller({ name: "report" }), tools: TOOLS, instructions: "Latest." }), null);
  assert.equal(latest.status, "completed", JSON.stringify(latest.error));
  assert.equal(asObject(latest.output)["text"], `got "v2:done"`);
  assert.deepEqual([s.counters.get("count", "mark-v1"), s.counters.get("count", "mark-v2")], [1, 1]);
});

test("an unknown version is an error result and runs nothing", async (t) => {
  const s = await setupWorkflow(t);
  await s.h.store.saveWorkflow({ name: "report", source: "api", document: version("v1") });
  const done = await s.run(await s.agent({ script: caller({ name: "report", version: 7 }), tools: TOOLS }), null);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(asObject(done.output)["text"], `got unknown workflow "report" version 7`);
  const [finished] = await s.h.records(done.id, "tool.finished");
  assert.equal(finished?.isError, true);
  assert.equal(s.counters.total("count"), 0);
  const journal = await s.h.journal(done.id);
  assert.equal(journal.some((r) => r.type === "model.started" && (r.key ?? "").includes("/wf/")), false);
});

test("the version argument is validated: not an integer of at least 1 is refused before anything runs", async (t) => {
  const s = await setupWorkflow(t);
  await s.h.store.saveWorkflow({ name: "report", source: "api", document: version("v1") });
  const done = await s.run(await s.agent({ script: caller({ name: "report", version: 0 }), tools: TOOLS }), null);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  const [finished] = await s.h.records(done.id, "tool.finished");
  assert.equal(finished?.isError, true);
  assert.match(String(finished?.content), /version/);
  assert.equal(s.counters.total("count"), 0);
});

for (const [label, args] of [["an explicit version", { name: "report", version: 1 }], ["the latest", { name: "report" }]] as const) {
  test(`a call resumed after a crash keeps ${label} pinned when a new version is saved meanwhile`, async (t) => {
    const s = await setupWorkflow(t);
    await s.h.store.saveWorkflow({ name: "report", source: "api", document: version("v1") });
    const agentId = await s.agent({ script: caller(args, 400), tools: TOOLS });
    const run = await s.h.start(agentId, { data: null });
    await untilRecord(s.h, run.id, (r) => r.type === "model.started" && r.key === "t1.c0/wf/slow#1");
    await s.h.crashAndReplace();
    assert.equal((await s.h.store.saveWorkflow({ name: "report", source: "api", document: version("v2") })).workflow.version, 2);
    const done = await s.h.until(run.id, ["completed", "failed"], 8000);
    assert.equal(done.status, "completed", JSON.stringify(done.error));
    assert.equal(asObject(done.output)["text"], `got "v1:done"`);
    assert.deepEqual([s.counters.get("count", "mark-v1"), s.counters.get("count", "mark-v2")], [1, 0]);
    const resolved = (await s.h.journal(run.id)).filter((r) => r.type === "step.finished" && r.data["name"] === "workflow.resolve");
    assert.deepEqual(resolved.map((r) => r.data["value"]), [{ version: 1 }]);
  });
}
