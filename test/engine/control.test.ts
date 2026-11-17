import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { delay } from "../../src/core/clock.ts";
import type { GenerateOptions, ModelRequest, ModelResponse } from "../../src/models/types.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import type { Driver } from "../../src/engine/types.ts";
import { createHarness, fakeModels, reply, toolReply } from "../helpers/engine.ts";
import { waitFor } from "../helpers/wait.ts";

function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/** A tool that waits `ms` (or until aborted when `honourAbort`), counting calls and noting whether it saw an abort. */
function waitingTool(name: string, ms: number, honourAbort: boolean) {
  const seen = { calls: 0, aborted: false };
  const tool: ToolDefinition = {
    name, description: name, parameters: { type: "object", properties: {} }, effect: "write",
    handler: async (_args, context) => {
      seen.calls++;
      try {
        await delay(ms, honourAbort ? context.signal : undefined);
      } catch (error) {
        seen.aborted = context.signal.aborted;
        throw error;
      }
      return { content: `${name} finished` };
    },
  };
  return { tool, seen };
}

function lastTool(request: ModelRequest): string {
  const results = request.messages.filter((m) => m.role === "tool");
  const last = results[results.length - 1];
  return last !== undefined && last.role === "tool" ? last.content : "none";
}

test("cancel aborts an in-flight model call and ends the run cancelled", async (t) => {
  let sawAbort = false;
  const models = fakeModels(async (_request: ModelRequest, options: GenerateOptions): Promise<ModelResponse> => {
    try {
      return await untilAborted(options.signal);
    } finally {
      sawAbort = options.signal.aborted;
    }
  });
  const h = await createHarness(t, { models });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id);
  await waitFor(async () => (await h.journal(run.id)).some((r) => r.type === "model.started"));
  await h.send(run.id, { type: "cancel", reason: "changed my mind" });
  const done = await h.until(run.id, "cancelled");
  assert.ok(sawAbort);
  assert.deepEqual((await h.records(run.id, "model.interrupted")).map((r) => r.reason), ["cancel"]);
  assert.deepEqual(await h.records(run.id, "run.cancelled"), [{ reason: "changed my mind" }]);
  assert.ok(done.finishedAt !== null);
});

test("cancel aborts an in-flight tool call; the handler sees the signal", async (t) => {
  const slow = waitingTool("slow", 10_000, true);
  const h = await createHarness(t, { models: fakeModels(() => toolReply("slow", {})), tools: [slow.tool] });
  const agent = await h.saveAgent({ tools: [{ name: "slow" }] });
  const run = await h.start(agent.id);
  await waitFor(() => slow.seen.calls === 1);
  await h.send(run.id, { type: "cancel", reason: null });
  await h.until(run.id, "cancelled");
  assert.equal(slow.seen.aborted, true);
  const [finished] = await h.records(run.id, "tool.finished");
  assert.equal(finished?.outcome, "aborted");
});

test("cancel of a waiting run cancels it and closes its pendings", async (t) => {
  const driver: Driver = async (ctx) => {
    await ctx.ask("q", { question: "Ready?" });
    return null;
  };
  const h = await createHarness(t, { models: fakeModels(() => reply({})), drivers: { agent: driver } });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id);
  await h.until(run.id, "waiting");
  await h.send(run.id, { type: "cancel", reason: "no longer needed" });
  const done = await h.until(run.id, "cancelled");
  assert.equal(done.openPendings, 0);
  assert.deepEqual((await h.store.listPendings({ status: "open" }, { limit: 10 })).items, []);
  await assert.rejects(h.send(run.id, { type: "resume" }), /already cancelled/);
});

test("pause aborts an in-flight model call; resume issues it again exactly once and completes", async (t) => {
  let calls = 0;
  const models = fakeModels(async (_request, options) => {
    calls++;
    if (calls === 1) return untilAborted(options.signal);
    return reply({ text: "resumed" });
  });
  const h = await createHarness(t, { models });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id);
  await waitFor(async () => (await h.journal(run.id)).some((r) => r.type === "model.started"));
  await h.send(run.id, { type: "pause" });
  const paused = await h.until(run.id, "paused");
  assert.equal(paused.leaseOwner, null);
  assert.deepEqual((await h.records(run.id, "model.interrupted")).map((r) => r.reason), ["pause"]);
  assert.equal(calls, 1);
  await h.send(run.id, { type: "resume" });
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, { text: "resumed" });
  assert.equal(calls, 2);
  const starts = (await h.journal(run.id)).filter((r) => r.type === "model.started" && r.key === "t1");
  assert.equal(starts.length, 2);
});

/**
 * A tool whose first call waits `ms` honouring its signal (then later calls return at once). It counts calls and
 * notes whether the first call saw an abort.
 */
function slowFirst(name: string, ms: number, extra: Partial<ToolDefinition> = {}) {
  const seen = { calls: 0, aborted: false };
  const tool: ToolDefinition = {
    name, description: name, parameters: { type: "object", properties: {} }, effect: "write",
    handler: async (_args, context) => {
      seen.calls++;
      const call = seen.calls;
      if (call === 1) {
        try {
          await delay(ms, context.signal);
        } catch (error) {
          seen.aborted = context.signal.aborted;
          throw error;
        }
      }
      return { content: `${name} finished (call ${call})` };
    },
    ...extra,
  };
  return { tool, seen };
}

const callsThenEcho = (name: string) => fakeModels((request) => (request.meta.turn === 1 ? toolReply(name, {}) : reply({ text: lastTool(request) })));

test("pause aborts a cooperative write tool: interrupted with a pending, waiting after resume, retry completes", async (t) => {
  const slow = slowFirst("deploy", 10_000);
  const h = await createHarness(t, { models: callsThenEcho("deploy"), tools: [slow.tool] });
  const agent = await h.saveAgent({ tools: [{ name: "deploy" }] });
  const run = await h.start(agent.id);
  await waitFor(() => slow.seen.calls === 1);
  const pausedAt = Date.now();
  await h.send(run.id, { type: "pause" });
  await h.until(run.id, "paused", 2000);
  assert.ok(Date.now() - pausedAt < 1500, "the pause took effect without waiting for the tool");
  assert.equal(slow.seen.aborted, true);
  assert.deepEqual(await h.records(run.id, "tool.interrupted"), [{ tool: "deploy", args: {}, attempt: 1, reason: "pause" }]);
  assert.deepEqual(await h.records(run.id, "tool.finished"), [], "an aborted call is never journalled as finished");
  const [pending] = await h.pendings(run.id);
  assert.equal(pending?.kind, "interrupted");
  assert.deepEqual(pending?.detail, { tool: "deploy", args: {}, attempt: 1, reason: "pause" });

  await h.send(run.id, { type: "resume" });
  await waitFor(async () => (await h.records(run.id, "command.applied")).some((r) => r.command.type === "resume"));
  await h.until(run.id, "waiting");
  assert.equal(slow.seen.calls, 1);
  await h.send(run.id, { type: "resolve_interrupted", pendingId: (pending as { id: string }).id, action: "retry", result: null });
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, { text: "deploy finished (call 2)" });
  assert.equal(slow.seen.calls, 2);
  assert.deepEqual((await h.records(run.id, "tool.started")).map((r) => r.attempt), [1, 2]);
});

test("pause aborts a cooperative read tool; after resume it runs again by itself", async (t) => {
  const slow = slowFirst("lookup", 10_000, { effect: "read" });
  const h = await createHarness(t, { models: callsThenEcho("lookup"), tools: [slow.tool] });
  const agent = await h.saveAgent({ tools: [{ name: "lookup" }] });
  const run = await h.start(agent.id);
  await waitFor(() => slow.seen.calls === 1);
  await h.send(run.id, { type: "pause" });
  await h.until(run.id, "paused", 2000);
  assert.equal(slow.seen.aborted, true);
  assert.deepEqual(await h.records(run.id, "tool.finished"), []);
  assert.deepEqual(await h.records(run.id, "tool.interrupted"), []);
  assert.deepEqual(await h.pendings(run.id), []);
  await h.send(run.id, { type: "resume" });
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, { text: "lookup finished (call 2)" });
  assert.deepEqual((await h.records(run.id, "tool.started")).map((r) => r.attempt), [1, 2]);
  assert.equal((await h.records(run.id, "pending.opened")).length, 0);
});

test("pause with a tool that ignores the signal: it finishes ok, the run pauses at the next step boundary", async (t) => {
  const slow = waitingTool("slow", 150, false);
  const h = await createHarness(t, { models: callsThenEcho("slow"), tools: [slow.tool] });
  const agent = await h.saveAgent({ tools: [{ name: "slow" }] });
  const run = await h.start(agent.id);
  await waitFor(() => slow.seen.calls === 1);
  await h.send(run.id, { type: "pause" });
  await h.until(run.id, "paused");
  const [finished] = await h.records(run.id, "tool.finished");
  assert.equal(finished?.outcome, "ok");
  assert.equal((await h.records(run.id, "model.started")).length, 1, "no new step started after the pause");
  assert.deepEqual(await h.pendings(run.id), []);
  await h.send(run.id, { type: "resume" });
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, { text: "slow finished" });
  assert.equal(slow.seen.calls, 1);
});

test("stop() releases a run to queued; another runner finishes it without repeating steps", async (t) => {
  const slow = waitingTool("slow", 150, false);
  const models = fakeModels((request) => (request.meta.turn === 1 ? toolReply("slow", {}) : reply({ text: lastTool(request) })));
  const h = await createHarness(t, { models, tools: [slow.tool] });
  const agent = await h.saveAgent({ tools: [{ name: "slow" }] });
  const run = await h.start(agent.id);
  await waitFor(() => slow.seen.calls === 1);
  await h.runner.stop({ graceMs: 5000 });
  const released = await h.store.getRun(run.id);
  assert.equal(released?.status, "queued");
  assert.deepEqual(await h.records(run.id, "run.released"), [{ reason: "shutdown" }]);
  assert.equal((await h.records(run.id, "tool.finished"))[0]?.outcome, "ok");
  h.newRunner();
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, { text: "slow finished" });
  assert.equal(slow.seen.calls, 1);
});

/** Starts a run whose turn-1 tool hangs on its first call, then force-stops the runner after a 50 ms grace period. */
async function forcedShutdown(t: TestContext, slow: ReturnType<typeof slowFirst>) {
  const h = await createHarness(t, { models: callsThenEcho(slow.tool.name), tools: [slow.tool] });
  const agent = await h.saveAgent({ tools: [{ name: slow.tool.name }] });
  const run = await h.start(agent.id);
  await waitFor(() => slow.seen.calls === 1);
  await h.runner.stop({ graceMs: 50 });
  assert.equal((await h.store.getRun(run.id))?.status, "queued");
  assert.equal(slow.seen.aborted, true);
  assert.deepEqual(await h.records(run.id, "run.released"), [{ reason: "forced shutdown" }]);
  assert.deepEqual((await h.journal(run.id)).filter((r) => r.type === "tool.finished" && r.key === "t1.c0"), [],
    "a call aborted by a forced shutdown is never journalled as finished");
  return { h, runId: run.id };
}

async function interruptedByShutdown(t: TestContext, slow: ReturnType<typeof slowFirst>) {
  const { h, runId } = await forcedShutdown(t, slow);
  assert.deepEqual(await h.records(runId, "tool.interrupted"), [{ tool: slow.tool.name, args: {}, attempt: 1, reason: "shutdown" }]);
  const open = await h.pendings(runId);
  assert.equal(open.length, 1);
  assert.equal(open[0]?.kind, "interrupted");
  assert.deepEqual(open[0]?.detail, { tool: slow.tool.name, args: {}, attempt: 1, reason: "shutdown" });
  h.newRunner();
  await h.until(runId, "waiting");
  assert.equal(slow.seen.calls, 1, "the write is not run again without a decision");
  return { h, runId, pendingId: (open[0] as { id: string }).id };
}

test("forced shutdown during a write tool: interrupted with a pending; retry on a new runner runs it again", async (t) => {
  const slow = slowFirst("deploy", 10_000);
  const { h, runId, pendingId } = await interruptedByShutdown(t, slow);
  await h.send(runId, { type: "resolve_interrupted", pendingId, action: "retry", result: null });
  const done = await h.until(runId, "completed");
  assert.deepEqual(done.output, { text: "deploy finished (call 2)" });
  assert.equal(slow.seen.calls, 2);
  const [finished] = await h.records(runId, "tool.finished");
  assert.equal(finished?.outcome, "ok");
});

test("forced shutdown during a write tool: skip hands the person's result to the model", async (t) => {
  const slow = slowFirst("deploy", 10_000);
  const { h, runId, pendingId } = await interruptedByShutdown(t, slow);
  await h.send(runId, { type: "resolve_interrupted", pendingId, action: "skip", result: "it was deployed by hand" });
  const done = await h.until(runId, "completed");
  assert.deepEqual(done.output, { text: "it was deployed by hand" });
  assert.equal(slow.seen.calls, 1);
});

test("forced shutdown during a read tool: a new runner runs it again by itself", async (t) => {
  const slow = slowFirst("lookup", 10_000, { effect: "read" });
  const { h, runId } = await forcedShutdown(t, slow);
  assert.deepEqual(await h.records(runId, "tool.interrupted"), []);
  assert.deepEqual(await h.pendings(runId), []);
  h.newRunner();
  const done = await h.until(runId, "completed");
  assert.deepEqual(done.output, { text: "lookup finished (call 2)" });
  assert.deepEqual((await h.records(runId, "tool.started")).map((r) => r.attempt), [1, 2]);
  assert.equal((await h.records(runId, "pending.opened")).length, 0);
});

test("forced shutdown during a resumable tool: invoked again, its inner steps replayed", async (t) => {
  let inner = 0;
  let calls = 0;
  let aborted = false;
  const resumable: ToolDefinition = {
    name: "pipeline", description: "Runs a pipeline.", parameters: { type: "object", properties: {} }, effect: "write", resumable: true,
    handler: async (_args, context) => {
      calls++;
      const prepared = await context.steps.memo("prepare", { recordType: "step", name: "prepare" }, async () => {
        inner++;
        return `prepared ${inner}`;
      });
      if (calls === 1) {
        try {
          await delay(10_000, context.signal);
        } catch (error) {
          aborted = context.signal.aborted;
          throw error;
        }
      }
      return { content: `${prepared}, call ${calls}` };
    },
  };
  const h = await createHarness(t, { models: callsThenEcho("pipeline"), tools: [resumable] });
  const agent = await h.saveAgent({ tools: [{ name: "pipeline" }] });
  const run = await h.start(agent.id);
  await waitFor(() => calls === 1 && inner === 1);
  await waitFor(async () => (await h.records(run.id, "step.finished")).length === 1);
  await h.runner.stop({ graceMs: 50 });
  assert.equal(aborted, true);
  assert.equal((await h.store.getRun(run.id))?.status, "queued");
  assert.deepEqual(await h.records(run.id, "tool.finished"), []);
  h.newRunner();
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, { text: "prepared 1, call 2" });
  assert.equal(inner, 1, "the inner step was replayed, not run again");
  assert.equal((await h.records(run.id, "tool.started")).length, 1);
  assert.deepEqual(await h.records(run.id, "tool.interrupted"), []);
});
