import { test } from "node:test";
import assert from "node:assert/strict";
import type { JsonObject } from "../../src/core/json.ts";
import type { ModelRequest } from "../../src/models/types.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import { newRecord } from "../../src/engine/journal-types.ts";
import { createHarness, fakeModels, reply, toolReply, type Harness } from "../helpers/engine.ts";
import { waitFor } from "../helpers/wait.ts";

function lastToolContent(request: ModelRequest): string {
  const tools = request.messages.filter((m) => m.role === "tool");
  const last = tools[tools.length - 1];
  return last !== undefined && last.role === "tool" ? last.content : "";
}

/** Turn 1 calls `tool`; turn 2 answers with the content of the last tool result. */
function modelsCalling(tool: string, args: JsonObject = {}) {
  return fakeModels((request) => (request.meta.turn === 1 ? toolReply(tool, args) : reply({ text: lastToolContent(request) })));
}

function countingTool(name: string, options: Partial<ToolDefinition> = {}): { tool: ToolDefinition; calls: () => number } {
  let calls = 0;
  return {
    tool: {
      name, description: name, parameters: { type: "object", properties: {} }, effect: "write",
      handler: async () => {
        calls++;
        return { content: `${name} ran (${calls})` };
      },
      ...options,
    },
    calls: () => calls,
  };
}

/**
 * Builds the journal of a runner that died between tool.started and tool.finished: claimed by a dead runner
 * with a short lease, turn 1 finished with one tool call, the call journalled as started.
 */
async function crashedRun(h: Harness, agentId: string, tool: string): Promise<string> {
  const run = await h.start(agentId);
  const [claimed] = await h.store.claimRuns({ runnerId: "runner_dead", limit: 1, leaseMs: 50 });
  assert.ok(claimed !== undefined && claimed.run.id === run.id);
  const model = "scripted/scripted-1";
  await h.store.commit(claimed.lease, {
    records: [
      newRecord("run.claimed", { runnerId: "runner_dead" }),
      newRecord("model.started", {
        model, purpose: "run", step: null, turn: 1, countsAsTurn: true, inputTokensEstimate: 10, maxOutputTokens: 100, worstCaseMicros: 510,
      }, "t1"),
      newRecord("model.finished", {
        model, purpose: "run", text: "", toolCalls: [{ id: "call_1", name: tool, args: {} }], output: null, stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, costMicros: 35, durationMs: 1,
      }, "t1"),
      newRecord("tool.started", { callId: "call_1", tool, args: {}, effect: "write", attempt: 1 }, "t1.c0"),
    ],
    counters: { toolCalls: 1, turns: 1 },
  });
  return run.id;
}

async function interruptedPending(h: Harness, runId: string) {
  await h.until(runId, "waiting");
  const pendings = await h.pendings(runId);
  assert.equal(pendings.length, 1);
  const [pending] = pendings;
  assert.ok(pending !== undefined);
  assert.equal(pending.kind, "interrupted");
  assert.equal(pending.stepKey, "t1.c0");
  assert.equal(pending.detail["attempt"], 1);
  assert.equal(pending.detail["reason"], "crash");
  return pending;
}

test("an interrupted write tool pauses the run; retry runs the handler again", async (t) => {
  const write = countingTool("write_note");
  const h = await createHarness(t, { models: modelsCalling("write_note"), tools: [write.tool], autoStart: false });
  const agent = await h.saveAgent({ tools: [{ name: "write_note" }] });
  const runId = await crashedRun(h, agent.id, "write_note");
  h.runner.start();
  const pending = await interruptedPending(h, runId);
  assert.equal(write.calls(), 0, "a write tool is never re-run without a decision");
  assert.deepEqual(await h.records(runId, "tool.interrupted"), [{ tool: "write_note", args: {}, attempt: 1, reason: "crash" }]);

  await h.send(runId, { type: "resolve_interrupted", pendingId: pending.id, action: "retry", result: null });
  const done = await h.until(runId, "completed");
  assert.equal(write.calls(), 1);
  assert.deepEqual(done.output, { text: "write_note ran (1)" });
  assert.deepEqual((await h.records(runId, "tool.started")).map((r) => r.attempt), [1, 2]);
  assert.equal(done.usage.toolCalls, 1, "a retry does not count against the tool-call budget again");
});

test("skip returns the person's result to the driver without running the tool", async (t) => {
  const write = countingTool("write_note");
  const h = await createHarness(t, { models: modelsCalling("write_note"), tools: [write.tool], autoStart: false });
  const agent = await h.saveAgent({ tools: [{ name: "write_note" }] });
  const runId = await crashedRun(h, agent.id, "write_note");
  h.runner.start();
  const pending = await interruptedPending(h, runId);
  await h.send(runId, { type: "resolve_interrupted", pendingId: pending.id, action: "skip", result: "the note was already written" });
  const done = await h.until(runId, "completed");
  assert.equal(write.calls(), 0);
  assert.deepEqual(done.output, { text: "the note was already written" });
  const [finished] = await h.records(runId, "tool.finished");
  assert.equal(finished?.outcome, "skipped");
});

test("cancel while resolving an interrupted call cancels the run", async (t) => {
  const write = countingTool("write_note");
  const h = await createHarness(t, { models: modelsCalling("write_note"), tools: [write.tool], autoStart: false });
  const agent = await h.saveAgent({ tools: [{ name: "write_note" }] });
  const runId = await crashedRun(h, agent.id, "write_note");
  h.runner.start();
  const pending = await interruptedPending(h, runId);
  await h.send(runId, { type: "resolve_interrupted", pendingId: pending.id, action: "cancel", result: null });
  await h.until(runId, "cancelled");
  assert.equal(write.calls(), 0);
  assert.equal((await h.store.getPending(pending.id))?.status, "resolved");
});

test("a crash during a hanging write tool leaves it interrupted, and retry works", async (t) => {
  let calls = 0;
  const hanging: ToolDefinition = {
    name: "deploy", description: "Deploys.", parameters: { type: "object", properties: {} }, effect: "write",
    handler: async (_args, context) => {
      calls++;
      if (calls === 1) {
        await new Promise((_resolve, reject) => context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true }));
      }
      return { content: "deployed" };
    },
  };
  const h = await createHarness(t, { models: modelsCalling("deploy"), tools: [hanging] });
  const agent = await h.saveAgent({ tools: [{ name: "deploy" }] });
  const run = await h.start(agent.id);
  await waitFor(() => calls === 1);
  await h.crashAndReplace();
  const pending = await interruptedPending(h, run.id);
  assert.equal(calls, 1);
  await h.send(run.id, { type: "resolve_interrupted", pendingId: pending.id, action: "retry", result: null });
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, { text: "deployed" });
  assert.equal(calls, 2);
});

test("read tools and idempotent write tools are retried automatically after a crash", async (t) => {
  for (const options of [{ effect: "read" as const }, { idempotent: true }]) {
    const tool = countingTool("safe_tool", options);
    const h = await createHarness(t, { models: modelsCalling("safe_tool"), tools: [tool.tool], autoStart: false });
    const agent = await h.saveAgent({ tools: [{ name: "safe_tool" }] });
    const runId = await crashedRun(h, agent.id, "safe_tool");
    h.runner.start();
    const done = await h.until(runId, "completed");
    assert.deepEqual(done.output, { text: "safe_tool ran (1)" });
    assert.equal(tool.calls(), 1);
    assert.deepEqual((await h.records(runId, "tool.started")).map((r) => r.attempt), [1, 2]);
    assert.equal((await h.records(runId, "pending.opened")).length, 0);
  }
});

test("a resumable tool is invoked again and replays its own inner steps", async (t) => {
  let calls = 0;
  const askTool: ToolDefinition = {
    name: "ask_someone", description: "Asks a person.", parameters: { type: "object", properties: {} }, effect: "write", resumable: true,
    handler: async (_args, context) => {
      calls++;
      const { answer } = await context.steps.ask("q", { question: "What colour?" });
      return { content: `they said ${answer}` };
    },
  };
  const h = await createHarness(t, { models: modelsCalling("ask_someone"), tools: [askTool] });
  const agent = await h.saveAgent({ tools: [{ name: "ask_someone" }] });
  const run = await h.start(agent.id);
  await h.until(run.id, "waiting");
  const [pending] = await h.pendings(run.id);
  assert.equal(pending?.stepKey, "t1.c0/q");
  await h.crashAndReplace();
  await h.send(run.id, { type: "answer", pendingId: (pending as { id: string }).id, answer: "green" });
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, { text: "they said green" });
  assert.equal(calls, 2);
  assert.equal((await h.records(run.id, "tool.started")).length, 1);
  assert.equal((await h.records(run.id, "tool.interrupted")).length, 0);
});
