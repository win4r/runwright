/**
 * The abort protocol at the moment a step's effect would start (plan 4.1): when a cause has already aborted the
 * call by the time the handler would be invoked, the provider request sent or the memo body run (it landed while
 * the "started" record was being committed), the effect does not start and the call ends exactly as the same
 * cause ends it in flight. The first two tests drive a fake SessionCore; the others drive real runs, with a store
 * wrapper that makes the abort land at that moment (R09D-engine-01).
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { delay } from "../../src/core/clock.ts";
import { systemClock } from "../../src/core/clock.ts";
import { createIdSource } from "../../src/core/ids.ts";
import { createGrowingRedactor } from "../../src/core/redact.ts";
import { createLogger } from "../../src/log/logger.ts";
import type { ModelRegistry } from "../../src/models/types.ts";
import type { CommitBatch, JournalRecord, RunRecord, Store } from "../../src/store/types.ts";
import { createToolRegistry } from "../../src/tools/registry.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import { createRunContext, type AbortCause, type CallHandle, type SessionCore } from "../../src/engine/context.ts";
import { ControlSignal } from "../../src/engine/control.ts";
import { applyRecord, createReplayState } from "../../src/engine/state.ts";
import type { Driver, EngineDeps } from "../../src/engine/types.ts";
import { commandGate, createHarness, reply, storeWith, type Harness } from "../helpers/engine.ts";
import { testAgentDefinition } from "../helpers/store.ts";
import { waitFor } from "../helpers/wait.ts";

function fakeCore(tool: ToolDefinition, abortedBy: AbortCause): { core: SessionCore; batches: CommitBatch[] } {
  const limits = { maxCostMicros: null, maxToolCalls: null, maxTurns: null, allowUnpriced: false };
  const state = createReplayState(limits);
  const batches: CommitBatch[] = [];
  const deps = {
    clock: systemClock, ids: createIdSource(), logger: createLogger({ write: () => undefined }), tools: createToolRegistry([tool]),
    config: { denyTools: [], toolResultBytes: 16_384 },
  } as unknown as EngineDeps;
  const core: SessionCore = {
    deps,
    run: { id: "run_1", agentId: "agent_1" } as RunRecord,
    definition: testAgentDefinition({ tools: [{ name: tool.name }] }),
    workspace: "/nonexistent",
    signal: new AbortController().signal,
    logger: deps.logger,
    redactor: createGrowingRedactor(),
    toolSecrets: {},
    state,
    learning: null,
    inflight: new Map(),
    reserved: { micros: 0, turns: 0, toolStarts: 0 }, repairTurns: new Map(),
    checkControl: () => undefined,
    async commit(input, onApplied) {
      const batch = typeof input === "function" ? input() : input;
      if (batch === null) return [];
      batches.push(batch);
      const stored = batch.records.map((r, i): JournalRecord => ({
        runId: "run_1", seq: state.records.length + i + 1, epoch: 1, ts: 0, type: r.type, key: r.key ?? null, data: r.data,
      }));
      for (const record of stored) applyRecord(state, record);
      onApplied?.();
      return stored;
    },
    // The abort arrived while tool.started was being committed: every handle is born aborted.
    register(): CallHandle {
      const controller = new AbortController();
      controller.abort(new Error(`aborted: ${abortedBy}`));
      return { signal: controller.signal, cause: () => abortedBy, dispose: () => undefined };
    },
    deadlineAt: () => null,
    expirePendings: async () => undefined,
    toolScope: () => null,
  };
  return { core, batches };
}

function tool(effect: "read" | "write", calls: { n: number }): ToolDefinition {
  return {
    name: "act", description: "Acts.", parameters: { type: "object", properties: {} }, effect,
    handler: async () => {
      calls.n++;
      return { content: "acted" };
    },
  };
}

test("a write call already aborted by a pause is not invoked: interrupted with a pending, then paused", async () => {
  const calls = { n: 0 };
  const { core, batches } = fakeCore(tool("write", calls), "pause");
  const ctx = createRunContext(core, "");
  await assert.rejects(ctx.tool("t1.c0", { name: "act", args: {} }), (e: unknown) => e instanceof ControlSignal && e.reason === "paused");
  assert.equal(calls.n, 0);
  assert.deepEqual(batches.map((b) => b.records.map((r) => r.type)), [["tool.started"], ["tool.interrupted", "pending.opened"]]);
  assert.deepEqual(batches[1]?.records[0]?.data, { tool: "act", args: {}, attempt: 1, reason: "pause" });
  assert.deepEqual(batches[1]?.openPendings?.[0]?.detail, { tool: "act", args: {}, attempt: 1, reason: "pause" });
});

test("a read call already aborted by a forced shutdown is not invoked and leaves only its tool.started", async () => {
  const calls = { n: 0 };
  const { core, batches } = fakeCore(tool("read", calls), "shutdown");
  const ctx = createRunContext(core, "");
  await assert.rejects(ctx.tool("t1.c0", { name: "act", args: {} }), (e: unknown) => e instanceof ControlSignal && e.reason === "released");
  assert.equal(calls.n, 0);
  assert.deepEqual(batches.map((b) => b.records.map((r) => r.type)), [["tool.started"]]);
});

// ------------------------------------------------------------------ real runs

/** A write tool that creates `marker.txt` in the workspace and counts its invocations. */
function markTool(calls: { n: number }): ToolDefinition {
  return {
    name: "mark", description: "Writes a marker file.", parameters: { type: "object", properties: {} }, effect: "write",
    handler: async (_args, context) => {
      calls.n++;
      await writeFile(join(context.workspace, "marker.txt"), "written");
      return { content: "marked" };
    },
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const noModels: ModelRegistry = {
  resolve: async () => ({ generate: async () => reply({ text: "unused" }) }),
};

async function markHarness(t: TestContext, driver: (h: () => Harness) => Driver, wrapStore: (store: Store) => Store) {
  const calls = { n: 0 };
  let harness: Harness | null = null;
  const get = (): Harness => harness as Harness;
  const h = await createHarness(t, { models: noModels, tools: [markTool(calls)], drivers: { agent: driver(get) }, wrapStore });
  harness = h;
  const agent = await h.saveAgent({ tools: [{ name: "mark" }] });
  return { h, calls, agentId: agent.id };
}

test("a write call cancelled while its tool.started is committed: the handler is not invoked, tool.finished aborted, run cancelled", async (t) => {
  const gate = commandGate();
  let once = false;
  const { h, calls, agentId } = await markHarness(t, (get) => async (ctx) => {
    if (!once) {
      once = true;
      await gate.hold(get().store, ctx.run.id, { type: "cancel", reason: "stop it" });
    }
    const step = ctx.tool("w", { name: "mark", args: {} });
    gate.releaseSoon();
    return (await step).content;
  }, gate.wrap);
  const run = await h.start(agentId);
  const done = await h.until(run.id, ["cancelled", "completed", "failed"]);
  assert.equal(done.status, "cancelled");
  assert.equal(calls.n, 0, "the handler was never invoked");
  assert.equal(await exists(join(h.dir, "workspaces", run.id, "marker.txt")), false);
  const journal = await h.journal(run.id);
  const types = journal.filter((r) => r.key === "w").map((r) => r.type);
  assert.deepEqual(types, ["tool.started", "tool.finished"]);
  const finished = journal.find((r) => r.type === "tool.finished");
  assert.equal(finished?.data["outcome"], "aborted");
  assert.equal(finished?.data["isError"], true);
  assert.equal(finished?.data["content"], 'tool "mark" was aborted');
});

test("a write call whose runner is fenced while tool.started is committed: not invoked, nothing written after, the takeover asks a person", async (t) => {
  let fenced = false;
  let harness: Harness | null = null;
  const wrap = (store: Store): Store => storeWith(store, {
    async commit(lease, batch) {
      const result = await store.commit(lease, batch);
      if (!fenced && batch.records.some((r) => r.type === "tool.started" && r.key === "w")) {
        fenced = true;
        await (harness as Harness).runner.abandon();
      }
      return result;
    },
  });
  const { h, calls, agentId } = await markHarness(t, () => async (ctx) => (await ctx.tool("w", { name: "mark", args: {} })).content, wrap);
  harness = h;
  const run = await h.start(agentId);
  await waitFor(() => fenced);
  await delay(50);
  assert.equal(calls.n, 0, "the fenced session did not invoke the handler");
  assert.equal(await exists(join(h.dir, "workspaces", run.id, "marker.txt")), false);
  const first = await h.journal(run.id);
  const started = first.find((r) => r.type === "tool.started");
  assert.ok(started !== undefined);
  assert.deepEqual(first.filter((r) => r.seq > started.seq).map((r) => r.type), [], "the fenced session wrote nothing after tool.started");

  await h.crashAndReplace();
  await h.until(run.id, "waiting");
  const pendings = await h.pendings(run.id);
  assert.equal(pendings.length, 1);
  assert.equal(pendings[0]?.kind, "interrupted");
  assert.equal(pendings[0]?.stepKey, "w");
  assert.equal(calls.n, 0, "the takeover asks a person before running a write call again");
  const journal = await h.journal(run.id);
  assert.deepEqual(journal.filter((r) => r.epoch === started.epoch && r.seq > started.seq), [], "nothing of the fenced epoch after tool.started");
});

test("a tool call whose enclosing deadline passes while tool.started is committed: not invoked, journalled timeout", async (t) => {
  const wrap = (store: Store): Store => storeWith(store, {
    async commit(lease, batch) {
      const result = await store.commit(lease, batch);
      if (batch.records.some((r) => r.type === "tool.started" && r.key === "w")) await delay(250);
      return result;
    },
  });
  const { h, calls, agentId } = await markHarness(t, () => async (ctx) => {
    try {
      await ctx.deadline(80, (scoped) => scoped.tool("w", { name: "mark", args: {} }));
      return { code: null };
    } catch (error) {
      return { code: (error as { code?: string }).code ?? String(error) };
    }
  }, wrap);
  const run = await h.start(agentId);
  const done = await h.until(run.id, ["completed", "failed", "cancelled"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.deepEqual(done.output, { code: "deadline_exceeded" });
  assert.equal(calls.n, 0);
  assert.equal(await exists(join(h.dir, "workspaces", run.id, "marker.txt")), false);
  const finished = (await h.records(run.id, "tool.finished"))[0];
  assert.equal(finished?.outcome, "timeout");
  assert.equal(finished?.isError, true);
  assert.equal(finished?.content, 'tool "mark" was stopped: the deadline of the enclosing call passed');
});

/** A model registry that counts provider requests and releases the gate once the step resolved its provider. */
function gatedModels(gate: ReturnType<typeof commandGate>) {
  const counts = { generate: 0 };
  const models: ModelRegistry = {
    resolve: async () => {
      gate.releaseSoon();
      return {
        generate: async () => {
          counts.generate++;
          return reply({ text: "answer", usage: { inputTokens: 10, outputTokens: 2 } });
        },
      };
    },
  };
  return { models, counts };
}

const modelStep = (gate: ReturnType<typeof commandGate>, get: () => Harness, command: { type: "cancel"; reason: string | null } | { type: "pause" }): Driver => {
  let once = false;
  return async (ctx) => {
    if (!once) {
      once = true;
      await gate.hold(get().store, ctx.run.id, command);
    }
    const result = await ctx.model("m", { purpose: "run", system: "s", messages: [{ role: "user", content: "hi" }], maxOutputTokens: 100 });
    return { text: result.text };
  };
};

for (const kind of ["cancel", "pause"] as const) {
  test(`a model attempt aborted by a ${kind} while model.started is committed: no request is sent, model.interrupted charged the worst case`, async (t) => {
    const gate = commandGate();
    const { models, counts } = gatedModels(gate);
    let harness: Harness | null = null;
    const command = kind === "cancel" ? { type: "cancel" as const, reason: null } : { type: "pause" as const };
    const h = await createHarness(t, { models, drivers: { agent: modelStep(gate, () => harness as Harness, command) }, wrapStore: gate.wrap });
    harness = h;
    const agent = await h.saveAgent();
    const run = await h.start(agent.id);
    const stopped = await h.until(run.id, kind === "cancel" ? ["cancelled", "completed", "failed"] : ["paused", "completed", "failed"]);
    assert.equal(stopped.status, kind === "cancel" ? "cancelled" : "paused");
    assert.equal(counts.generate, 0, "the provider was never called");
    const started = (await h.records(run.id, "model.started"))[0];
    assert.ok(started !== undefined && typeof started.worstCaseMicros === "number");
    const interrupted = await h.records(run.id, "model.interrupted");
    assert.deepEqual(interrupted, [{ model: started.model, reason: kind, assumedCostMicros: started.worstCaseMicros, attempt: 1 }]);
    assert.equal(stopped.usage.costMicros, started.worstCaseMicros, "the assumed charge is in the usage totals");
    assert.equal(stopped.usage.outputTokens, 100);
    if (kind === "pause") {
      await h.send(run.id, { type: "resume" });
      const done = await h.until(run.id, ["completed", "failed"]);
      assert.equal(done.status, "completed", JSON.stringify(done.error));
      assert.equal(counts.generate, 1, "the attempt is sent on resume");
      assert.equal(done.usage.costMicros, started.worstCaseMicros + 10 + 2 * 5);
    }
  });
}

for (const recordType of ["node", "step"] as const) {
  test(`a memo cancelled while its ${recordType}.started is committed: the body is not called`, async (t) => {
    const gate = commandGate();
    const body = { n: 0 };
    let once = false;
    let harness: Harness | null = null;
    const driver: Driver = async (ctx) => {
      if (!once) {
        once = true;
        await gate.hold((harness as Harness).store, ctx.run.id, { type: "cancel", reason: null });
      }
      const step = ctx.memo("m", { recordType, name: "body" }, async () => {
        body.n++;
        return "ran";
      });
      gate.releaseSoon();
      return await step;
    };
    const h = await createHarness(t, { models: noModels, drivers: { agent: driver }, wrapStore: gate.wrap });
    harness = h;
    const agent = await h.saveAgent();
    const run = await h.start(agent.id);
    const done = await h.until(run.id, ["cancelled", "completed", "failed"]);
    assert.equal(done.status, "cancelled");
    assert.equal(body.n, 0);
    const types = (await h.journal(run.id)).filter((r) => r.key === "m").map((r) => r.type);
    assert.deepEqual(types, [`${recordType}.started`]);
  });
}
