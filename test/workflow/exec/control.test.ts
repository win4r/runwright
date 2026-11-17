import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { ToolDefinition } from "../../../src/tools/types.ts";
import { waitFor } from "../../helpers/wait.ts";
import { doc, nodeFinished, setupWorkflow, untilRecord } from "./helpers.ts";

const schemas = {
  Input: { type: "object" },
  Summary: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
  Output: {},
};
const oneTool = doc({ id: "act", kind: "tool", tool: "count", args: { label: "act" } }, { $ref: "steps.act.content" }, { schemas });

test("a tool node with policy ask opens an approval and continues after approval", async (t) => {
  const s = await setupWorkflow(t);
  const agentId = await s.agent({ workflow: oneTool, tools: [{ name: "count", policy: "ask" }] });
  const run = await s.h.start(agentId, { data: {} });
  await s.h.until(run.id, "waiting");
  const [pending] = await s.h.pendings(run.id);
  assert.equal(pending?.kind, "approval");
  assert.equal(pending?.stepKey, "wf/act#1");
  assert.equal(s.counters.get("count", "act"), 0);
  await s.h.send(run.id, { type: "approve", pendingId: pending?.id ?? "", always: false });
  const done = await s.h.until(run.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(done.output, "act");
  assert.equal(s.counters.get("count", "act"), 1);
});

test("a tool a person denies fails the node", async (t) => {
  const s = await setupWorkflow(t);
  const agentId = await s.agent({ workflow: oneTool, tools: [{ name: "count", policy: "ask" }] });
  const run = await s.h.start(agentId, { data: {} });
  await s.h.until(run.id, "waiting");
  const [pending] = await s.h.pendings(run.id);
  await s.h.send(run.id, { type: "deny", pendingId: pending?.id ?? "", reason: "not today" });
  const done = await s.h.until(run.id, ["completed", "failed"]);
  assert.equal(done.status, "failed");
  assert.match(done.error?.message ?? "", /node "act" failed: .*denied.*not today/);
  assert.equal(s.counters.get("count", "act"), 0);
});

test("a tool on the server deny list is refused inside a workflow", async (t) => {
  const s = await setupWorkflow(t, { engine: { denyTools: ["count"] } });
  const done = await s.run(await s.agent({ workflow: oneTool }), {});
  assert.equal(done.status, "failed");
  assert.match(done.error?.message ?? "", /deny list/);
  assert.equal(s.counters.get("count", "act"), 0);
});

test("a tool not granted to the agent is refused inside a workflow", async (t) => {
  const s = await setupWorkflow(t);
  const done = await s.run(await s.agent({ workflow: oneTool, tools: [{ name: "probe" }] }), {});
  assert.equal(done.status, "failed");
  assert.match(done.error?.message ?? "", /not granted/);
  assert.equal(s.counters.get("count", "act"), 0);
});

test("the agent's maxToolCalls pauses a workflow and raising it resumes", async (t) => {
  const s = await setupWorkflow(t);
  const workflow = doc({
    id: "main", kind: "sequence", steps: [
      { id: "a", kind: "tool", tool: "count", args: { label: "a" } },
      { id: "b", kind: "tool", tool: "count", args: { label: "b" } },
    ],
  }, { $ref: "steps.b.content" }, { schemas });
  const run = await s.h.start(await s.agent({ workflow, limits: { maxToolCalls: 1 } }), { data: {} });
  await s.h.until(run.id, "waiting");
  const [pending] = await s.h.pendings(run.id);
  assert.equal(pending?.kind, "tool_budget");
  assert.equal(s.counters.get("count", "a"), 1);
  assert.equal(s.counters.get("count", "b"), 0);
  await s.h.send(run.id, { type: "limits", limits: { maxToolCalls: 3 } });
  const done = await s.h.until(run.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(s.counters.get("count", "a"), 1);
  assert.equal(s.counters.get("count", "b"), 1);
});

test("the agent's maxTurns pauses a workflow before a model node and raising it resumes", async (t) => {
  const s = await setupWorkflow(t);
  const workflow = doc({
    id: "main", kind: "sequence", steps: [
      { id: "m1", kind: "model", prompt: "one", output: "Summary" },
      { id: "m2", kind: "model", prompt: "two", output: "Summary" },
    ],
  }, { $ref: "steps.m2.text" }, { schemas });
  const script = { steps: { m1: { output: { text: "1" } }, m2: { output: { text: "2" } } } };
  const run = await s.h.start(await s.agent({ workflow, script, limits: { maxTurns: 1 } }), { data: {} });
  await s.h.until(run.id, "waiting");
  const [pending] = await s.h.pendings(run.id);
  assert.equal(pending?.kind, "turn_limit");
  assert.equal(pending?.stepKey, "wf/m2#1");
  await s.h.send(run.id, { type: "limits", limits: { maxTurns: 2 } });
  const done = await s.h.until(run.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(done.output, "2");
});

test("a spend cap pauses before a model node with the least extra budget and resumes after a raise", async (t) => {
  const s = await setupWorkflow(t);
  const workflow = doc({
    id: "main", kind: "sequence", steps: [
      { id: "a", kind: "tool", tool: "count", args: { label: "a" } },
      { id: "m", kind: "model", prompt: "summarize", output: "Summary" },
    ],
  }, { $ref: "steps.m.text" }, { schemas });
  const agentId = await s.agent({ workflow, script: { steps: { m: { output: { text: "summed" } } } } });
  const run = await s.h.start(agentId, { data: {} }, { maxCostMicros: 1000 });
  await s.h.until(run.id, "waiting");
  const [pending] = await s.h.pendings(run.id);
  assert.equal(pending?.kind, "spend_cap");
  assert.equal(pending?.stepKey, "wf/m#1");
  const needed = pending?.detail["neededMicros"];
  assert.ok(typeof needed === "number" && needed > 0);
  assert.equal((await s.h.journal(run.id)).some((r) => r.type === "model.started"), false);
  await s.h.send(run.id, { type: "limits", limits: { maxCostMicros: 1000 + (needed as number) } });
  const done = await s.h.until(run.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(done.output, "summed");
  assert.equal(s.counters.get("count", "a"), 1);
});

test("cancel during a map stops the run and starts no further items", async (t) => {
  const s = await setupWorkflow(t);
  const workflow = doc({
    id: "m", kind: "map", over: { $ref: "input.items" }, as: "item", concurrency: 2, maxItems: 10,
    run: { id: "work", kind: "tool", tool: "count", args: { label: "{{vars.item}}", delayMs: 5000 } },
  }, { $ref: "steps.m" }, { schemas });
  const run = await s.h.start(await s.agent({ workflow }), { data: { items: ["a", "b", "c", "d", "e"] } });
  await untilRecord(s.h, run.id, (r) => r.type === "tool.started" && r.key === "wf/m[1]/work#1");
  await s.h.send(run.id, { type: "cancel", reason: "enough" });
  const done = await s.h.until(run.id, ["cancelled", "completed", "failed"]);
  assert.equal(done.status, "cancelled");
  assert.equal(s.counters.total("count"), 2);
  assert.equal(nodeFinished(await s.h.journal(run.id)).some((f) => f.name === "m"), false);
});

/** A tool whose first invocation waits until aborted; later invocations return at once. Counts invocations. */
function hangsOnce(name: string, effect: "read" | "write"): { tool: ToolDefinition; calls: () => number } {
  let calls = 0;
  return {
    tool: {
      name, description: name, parameters: { type: "object", properties: {} }, effect,
      handler: async (_args, context) => {
        calls++;
        if (calls === 1) {
          await new Promise((_resolve, reject) => context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true }));
        }
        return { content: `${name} done (${calls})` };
      },
    },
    calls: () => calls,
  };
}

async function pauseDuringToolNode(t: TestContext, effect: "read" | "write") {
  const s = await setupWorkflow(t);
  const slow = hangsOnce("slow_node", effect);
  s.h.tools.register(slow.tool);
  const workflow = doc({ id: "act", kind: "tool", tool: "slow_node", args: {} }, { $ref: "steps.act.content" }, { schemas });
  const run = await s.h.start(await s.agent({ workflow, tools: [{ name: "slow_node" }] }), { data: {} });
  await untilRecord(s.h, run.id, (r) => r.type === "tool.started" && r.key === "wf/act#1");
  await waitFor(() => slow.calls() === 1);
  await s.h.send(run.id, { type: "pause" });
  const paused = await s.h.until(run.id, ["paused", "failed"]);
  assert.equal(paused.status, "paused", "the node did not fail");
  const journal = await s.h.journal(run.id);
  assert.equal(journal.some((r) => r.type === "tool.finished"), false);
  assert.equal(nodeFinished(journal).some((f) => f.name === "act"), false);
  return { s, slow, runId: run.id };
}

test("a write tool node aborted by a pause waits on an interrupted pending after resume; retry completes the workflow", async (t) => {
  const { s, slow, runId } = await pauseDuringToolNode(t, "write");
  const [pending] = await s.h.pendings(runId);
  assert.equal(pending?.kind, "interrupted");
  assert.equal(pending?.stepKey, "wf/act#1");
  assert.equal(pending?.detail["reason"], "pause");
  await s.h.send(runId, { type: "resume" });
  await waitFor(async () => (await s.h.store.getRun(runId))?.status === "waiting");
  assert.equal(slow.calls(), 1);
  await s.h.send(runId, { type: "resolve_interrupted", pendingId: (pending as { id: string }).id, action: "retry", result: null });
  const done = await s.h.until(runId, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(done.output, "slow_node done (2)");
  assert.equal(slow.calls(), 2);
});

test("a read tool node aborted by a pause is simply run again after resume", async (t) => {
  const { s, slow, runId } = await pauseDuringToolNode(t, "read");
  assert.deepEqual(await s.h.pendings(runId), []);
  await s.h.send(runId, { type: "resume" });
  const done = await s.h.until(runId, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(done.output, "slow_node done (2)");
  assert.equal(slow.calls(), 2);
});
