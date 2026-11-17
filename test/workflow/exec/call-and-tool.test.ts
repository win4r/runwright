import { test } from "node:test";
import assert from "node:assert/strict";
import type { JsonSchema } from "../../../src/schema/validate.ts";
import type { WorkflowDocument, WorkflowNode } from "../../../src/workflow/types.ts";
import { asObject, doc, setupWorkflow, untilRecord } from "./helpers.ts";

const summary = { type: "object", required: ["text"], properties: { text: { type: "string" } } };

function child(name: string, root: WorkflowNode, result: WorkflowDocument["result"], input: JsonSchema = { type: "object" }): WorkflowDocument {
  return {
    format: "runwright.workflow/v1", name, schemas: { In: input, Out: {}, Summary: summary }, input: "In", output: "Out", root, result,
  };
}

const callTop = (target: string, input: WorkflowDocument["result"] = {}): WorkflowDocument =>
  doc({ id: "sub", kind: "call", workflow: target, input }, { $ref: "steps.sub" });

test("an inline sub-workflow runs on its own input and its input schema is enforced", async (t) => {
  const s = await setupWorkflow(t);
  const inner = child("inner", { id: "echo", kind: "tool", tool: "count", args: { label: "inner", value: "{{input.n}}" } },
    { $ref: "steps.echo.data" }, { type: "object", required: ["n"], properties: { n: { type: "string" } } });
  const ok = await s.run(await s.agent({ workflow: { ...callTop("inner", { n: { $ref: "input.n" } }), workflows: { inner } } }), { n: "7" });
  assert.equal(ok.status, "completed", JSON.stringify(ok.error));
  assert.equal(ok.output, "7");

  const bad = await s.run(await s.agent({ workflow: { ...callTop("inner", { n: { $ref: "input.n" } }), name: "bad", workflows: { inner } } }), { n: 7 });
  assert.equal(bad.status, "failed");
  assert.match(bad.error?.message ?? "", /node "sub" failed: validation_failed: .*\$\.n/);
});

test("a saved sub-workflow is resolved once and journalled with its version", async (t) => {
  const s = await setupWorkflow(t);
  await s.h.store.saveWorkflow({
    name: "greeter", source: "api",
    document: child("greeter", { id: "hello", kind: "tool", tool: "count", args: { label: "hello", value: "hello {{input.who}}" } }, { $ref: "steps.hello.data" }),
  });
  const done = await s.run(await s.agent({ workflow: callTop("greeter", { who: "Bo" }) }), {});
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(done.output, "hello Bo");
  const resolved = (await s.h.journal(done.id)).filter((r) => r.type === "step.finished" && r.data["name"] === "workflow.resolve");
  assert.deepEqual(resolved.map((r) => [r.key, r.data["value"]]), [["wf/sub/resolve", { version: 1 }]]);
});

test("an unknown saved workflow fails the call node", async (t) => {
  const s = await setupWorkflow(t);
  const done = await s.run(await s.agent({ workflow: callTop("nowhere") }), {});
  assert.equal(done.status, "failed");
  assert.match(done.error?.message ?? "", /node "sub" failed: unknown workflow "nowhere"/);
});

test("the saved version is pinned across a crash even when a new version is saved meanwhile", async (t) => {
  const s = await setupWorkflow(t);
  const version = (tag: string): WorkflowDocument => child("pinned", { id: "main", kind: "sequence", steps: [
    { id: "mark", kind: "tool", tool: "count", args: { label: `mark-${tag}` } },
    { id: "slow", kind: "model", prompt: "x", output: "Summary" },
  ] }, `${tag}:{{steps.slow.text}}`);
  await s.h.store.saveWorkflow({ name: "pinned", source: "api", document: version("v1") });
  const script = { steps: { slow: { output: { text: "done" }, delayMs: 400 } } };
  const run = await s.h.start(await s.agent({ workflow: callTop("pinned"), script }), { data: {} });
  await untilRecord(s.h, run.id, (r) => r.type === "model.started" && r.key === "wf/sub>/slow#1");
  await s.h.crashAndReplace();
  const saved = await s.h.store.saveWorkflow({ name: "pinned", source: "api", document: version("v2") });
  assert.equal(saved.workflow.version, 2);
  const done = await s.h.until(run.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(done.output, "v1:done");
  assert.equal(s.counters.get("count", "mark-v1"), 1);
  assert.equal(s.counters.get("count", "mark-v2"), 0);
});

test("sub-workflow calls are limited to a depth of 16", async (t) => {
  const s = await setupWorkflow(t);
  // Two saved workflows that call each other: a run checks each one alone (it sees no cycle), so the bound stops it.
  await s.h.store.saveWorkflow({
    name: "ping", source: "api",
    document: child("ping_doc", { id: "again", kind: "call", workflow: "pong", input: {} }, { $ref: "steps.again" }),
  });
  await s.h.store.saveWorkflow({
    name: "pong", source: "api",
    document: child("pong_doc", { id: "again", kind: "call", workflow: "ping", input: {} }, { $ref: "steps.again" }),
  });
  const done = await s.run(await s.agent({ workflow: callTop("ping") }), {});
  assert.equal(done.status, "failed");
  assert.match(done.error?.message ?? "", /nest deeper than 16/);
  const resolves = (await s.h.journal(done.id)).filter((r) => r.type === "step.finished" && r.data["name"] === "workflow.resolve");
  assert.equal(resolves.length, 16);
});

const greetFlow = child("greet_flow", { id: "main", kind: "sequence", steps: [
  { id: "greet", kind: "tool", tool: "count", args: { label: "greet", value: "hi {{input.who}}" } },
  { id: "slow", kind: "model", prompt: "{{steps.greet.data}}", output: "Summary" },
] }, { greeting: { $ref: "steps.greet.data" }, slow: { $ref: "steps.slow.text" } });

const callerScript = (name: string) => ({
  turns: [
    { toolCalls: [{ name: "run_workflow", args: { name, input: { who: "Ann" } } }] },
    { text: "got {{last_result}}" },
  ],
  steps: { slow: { output: { text: "slow {{first_message}}" }, delayMs: 300 } },
});

test("run_workflow called from an agent runs a saved workflow and is resumable across a crash", async (t) => {
  const s = await setupWorkflow(t);
  await s.h.store.saveWorkflow({ name: "greet", source: "api", document: greetFlow });
  const agentId = await s.agent({ script: callerScript("greet"), tools: [{ name: "run_workflow" }, { name: "count" }] });
  const run = await s.h.start(agentId, { data: null });
  await untilRecord(s.h, run.id, (r) => r.type === "model.started" && r.key === "t1.c0/wf/slow#1");
  await s.h.crashAndReplace();
  const done = await s.h.until(run.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(asObject(done.output)["text"], `got {"greeting":"hi Ann","slow":"slow hi Ann"}`);
  assert.equal(s.counters.get("count", "greet"), 1);
  const journal = await s.h.journal(run.id);
  const finished = journal.filter((r) => r.type === "tool.finished" && r.key === "t1.c0");
  assert.equal(finished.length, 1);
  assert.deepEqual(finished[0]?.data["data"], { greeting: "hi Ann", slow: "slow hi Ann" });
});

test("tool calls inside run_workflow obey the agent's policy", async (t) => {
  const s = await setupWorkflow(t);
  await s.h.store.saveWorkflow({ name: "greet", source: "api", document: greetFlow });
  const agentId = await s.agent({ script: callerScript("greet"), tools: [{ name: "run_workflow" }, { name: "count", policy: "ask" }] });
  const run = await s.h.start(agentId, { data: null });
  await s.h.until(run.id, "waiting");
  const [pending] = await s.h.pendings(run.id);
  assert.equal(pending?.kind, "approval");
  assert.equal(pending?.stepKey, "t1.c0/wf/greet#1");
  assert.equal(s.counters.get("count", "greet"), 0);
  await s.h.send(run.id, { type: "approve", pendingId: pending?.id ?? "", always: false });
  const done = await s.h.until(run.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(s.counters.get("count", "greet"), 1);

  const denied = await s.agent({ script: callerScript("greet"), tools: [{ name: "run_workflow" }] });
  const refused = await s.run(denied, null);
  assert.equal(refused.status, "completed");
  assert.match(String(asObject(refused.output)["text"]), /^got workflow "greet" failed: node "greet" failed: .*not granted/);
  assert.equal(s.counters.get("count", "greet"), 1);
});

test("run_workflow with an unknown name returns an error result", async (t) => {
  const s = await setupWorkflow(t);
  const done = await s.run(await s.agent({ script: callerScript("missing"), tools: [{ name: "run_workflow" }] }), null);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(asObject(done.output)["text"], `got unknown workflow "missing"`);
  const [finished] = await s.h.records(done.id, "tool.finished");
  assert.equal(finished?.isError, true);
});

// ---- R14D-workflow-01: `args` is a map of argument expressions, resolved one by one (plan 2.6) ----

test("arguments named __proto__ and constructor reach the tool as own properties and pollute nothing", async (t) => {
  const s = await setupWorkflow(t);
  const received: Record<string, unknown>[] = [];
  s.h.tools.register({
    name: "keys", description: "records its arguments", effect: "read", parameters: { type: "object" },
    async handler(args) {
      received.push(args);
      return { content: "ok", data: { own: Object.keys(args) } };
    },
  });
  const args = JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"$ref": "input.c"}, "plain": "v {{input.c}}"}') as WorkflowNode;
  assert.ok(Object.hasOwn(args, "__proto__"), "the document holds __proto__ as an argument name");
  const workflow = doc({ id: "t", kind: "tool", tool: "keys", args } as unknown as WorkflowNode, { $ref: "steps.t.data" });
  const done = await s.run(await s.agent({ workflow, tools: [{ name: "keys" }] }), { c: "x" });
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.deepEqual(done.output, { own: ["__proto__", "constructor", "plain"] });
  const got = received[0] as Record<string, unknown>;
  assert.deepEqual(Object.getOwnPropertyDescriptor(got, "__proto__")?.value, { polluted: true });
  assert.equal(got["constructor"], "x");
  assert.equal(got["plain"], "v x");
  assert.equal(Object.getPrototypeOf(got) === Object.prototype || Object.getPrototypeOf(got) === null, true);
  assert.equal(({} as Record<string, unknown>)["polluted"], undefined, "Object.prototype is untouched");
  const started = (await s.h.journal(done.id)).find((r) => r.type === "tool.started");
  assert.deepEqual(Object.keys(started?.data["args"] as object), ["__proto__", "constructor", "plain"]);
});

test("a document saved without validation, with a reference in place of args, cannot run: runtime validation rejects it", async (t) => {
  const s = await setupWorkflow(t);
  for (const args of [{ $ref: "input" }, { $literal: { label: "x" } }]) {
    const workflow = doc({ id: "t", kind: "tool", tool: "probe", args } as unknown as WorkflowNode, { $ref: "steps.t.data" });
    const done = await s.run(await s.agent({ workflow }), { label: "x" });
    assert.equal(done.status, "failed");
    assert.equal(done.error?.code, "workflow_invalid");
    assert.match(done.error?.message ?? "", /\$\.root\.args: `args` must be an object of argument expressions, not a reference or a literal form/);
    assert.equal(s.counters.total("probe"), 0, "the tool never ran");
  }
});
