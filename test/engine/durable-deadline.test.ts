/**
 * Durable deadlines (plan 3.5, Rule T; the engine half of R10-03). A deadline scope given `startedAt` expires at
 * `startedAt + deadlineMs` in every session; a pending opened inside a deadline carries that instant as
 * `detail.expiresAt`; a waiting run is woken at it and every reader of a pending fails its step instead of waiting
 * on an expired one; commands created at or after the instant are rejected; a paused run is not woken.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createFakeClock, delay, type FakeClock } from "../../src/core/clock.ts";
import { createIdSource } from "../../src/core/ids.ts";
import { isRunwrightError } from "../../src/core/errors.ts";
import type { Json, JsonObject } from "../../src/core/json.ts";
import { createGrowingRedactor } from "../../src/core/redact.ts";
import { createLogger } from "../../src/log/logger.ts";
import type { CommandRecord, CommitBatch, JournalRecord, PendingRecord, RunRecord } from "../../src/store/types.ts";
import { createToolRegistry } from "../../src/tools/registry.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import { planCommands } from "../../src/engine/commands.ts";
import { createRunContext, type CallHandle, type SessionCore } from "../../src/engine/context.ts";
import { isControlSignal } from "../../src/engine/control.ts";
import { applyRecord, createReplayState, pendingExpiry } from "../../src/engine/state.ts";
import type { Driver, EngineConfig, EngineDeps, RunContext } from "../../src/engine/types.ts";
import { createHarness, fakeModels, reply, type Harness } from "../helpers/engine.ts";
import { testAgentDefinition } from "../helpers/store.ts";
import { waitFor } from "../helpers/wait.ts";

/** Upper bound for a run to fail once its instant passed (the old code waited for ever). */
const PATIENCE_MS = 3_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Counts { body: number; handler: number }

/** `act`: a write tool that counts its calls and returns at once; `block`: a write tool that waits on its signal. */
function tools(counts: Counts): ToolDefinition[] {
  const parameters = { type: "object", properties: {} };
  return [
    {
      name: "act", description: "acts", effect: "write", parameters,
      async handler() {
        counts.handler++;
        return { content: "acted" };
      },
    },
    {
      name: "block", description: "blocks", effect: "write", parameters,
      async handler(_args, context) {
        counts.handler++;
        await delay(10_000, context.signal);
        return { content: "unblocked" };
      },
    },
  ];
}

async function setup(
  t: TestContext, driver: Driver, options?: { engine?: Partial<EngineConfig>; policy?: "ask" | "allow" },
): Promise<{ h: Harness; counts: Counts; agentId: string }> {
  const counts: Counts = { body: 0, handler: 0 };
  const h = await createHarness(t, {
    models: fakeModels(() => reply({ text: "ok" })), tools: tools(counts), drivers: { agent: driver },
    ...(options?.engine === undefined ? {} : { engine: options.engine }),
  });
  const policy = options?.policy ?? "allow";
  const agent = await h.saveAgent({ tools: [{ name: "act", policy }, { name: "block", policy: "allow" }] });
  return { h, counts, agentId: agent.id };
}

/** The code and message a promise rejected with, or `{value}`. Control signals are rethrown. */
async function settle(promise: Promise<unknown>): Promise<Json> {
  try {
    return { value: (await promise) as Json };
  } catch (error) {
    if (isRunwrightError(error)) return { code: error.code, message: error.message };
    throw error;
  }
}

function startedTs(journal: readonly JournalRecord[], type: string, key: string): number {
  const record = journal.find((r) => r.type === type && r.key === key);
  assert.ok(record !== undefined, `${type} ${key} is journalled`);
  return record.ts;
}

async function onlyPending(h: Harness, runId: string): Promise<PendingRecord> {
  const all = (await h.store.listPendings({ runId }, { limit: 100 })).items;
  assert.equal(all.length, 1, JSON.stringify(all));
  return all[0] as PendingRecord;
}

function expiredError(run: RunRecord, message: string): void {
  assert.equal(run.status, "failed");
  assert.equal(run.error?.code, "deadline_exceeded", JSON.stringify(run.error));
  assert.equal(run.error?.message, message);
}

/** The node-style step every test below runs: a memo whose body runs a scope bounded from the memo's start. */
function boundedNode<T extends Json>(ctx: RunContext, deadlineMs: number, body: (scoped: RunContext) => Promise<T>): Promise<T> {
  return ctx.memo<T>("node", { recordType: "node", name: "node" }, (step) => ctx.deadline(deadlineMs, body, { startedAt: step.startedAt }));
}

test("memo hands its body the ts of the started record, the same value after a crash and replay", async (t) => {
  const seen: number[] = [];
  const { h, agentId } = await setup(t, async (ctx) => ctx.memo("m", { recordType: "step", name: "m" }, async (step) => {
    seen.push(step.startedAt);
    if (seen.length === 1) await ctx.sleep(10_000);
    return step.startedAt;
  }));
  const run = await h.start(agentId);
  await waitFor(() => seen.length === 1);
  await h.crashAndReplace();
  const done = await h.until(run.id, "completed");
  const ts = startedTs(await h.journal(run.id), "step.started", "m");
  assert.deepEqual(seen, [ts, ts]);
  assert.equal(done.output, ts);
});

test("a waiting scope with startedAt fails at its instant with no command: the pending is closed as expired first", async (t) => {
  const { h, agentId } = await setup(t, async (ctx) => boundedNode(ctx, 200, async (s) => (await s.ask("q", { question: "Go on?" })).answer));
  const run = await h.start(agentId);
  await h.until(run.id, "waiting");
  const startedAt = startedTs(await h.journal(run.id), "node.started", "node");
  const pending = await onlyPending(h, run.id);
  assert.equal(pending.detail["expiresAt"], startedAt + 200);
  assert.deepEqual(pending.detail, { question: "Go on?", choices: [], expiresAt: startedAt + 200 });
  const done = await h.until(run.id, ["completed", "failed"], PATIENCE_MS);
  expiredError(done, "the deadline of 200 ms passed");
  assert.ok((done.finishedAt ?? 0) >= startedAt + 200, "not before the instant");
  const closed = await h.store.getPending(pending.id);
  assert.equal(closed?.status, "resolved");
  assert.deepEqual(closed?.resolution, { expired: true, expiresAt: startedAt + 200 });
  const journal = await h.journal(run.id);
  const resolved = journal.find((r) => r.type === "pending.resolved");
  const failed = journal.find((r) => r.type === "run.failed");
  assert.ok(resolved !== undefined && failed !== undefined && resolved.seq < failed.seq);
  assert.deepEqual(resolved.data, { pendingId: pending.id, kind: "question", resolution: { expired: true, expiresAt: startedAt + 200 }, commandId: null });
  assert.equal(journal.filter((r) => r.type === "command.applied").length, 0, "no command was sent");
});

test("the instant survives a crash while waiting and a restart with no runner in between", async (t) => {
  for (const variant of ["crash", "restart"] as const) {
    await t.test(variant, async (tt) => {
      const { h, agentId } = await setup(tt, async (ctx) => boundedNode(ctx, 250, async (s) => (await s.ask("q", { question: "?" })).answer));
      const run = await h.start(agentId);
      await h.until(run.id, "waiting");
      const startedAt = startedTs(await h.journal(run.id), "node.started", "node");
      if (variant === "crash") {
        await h.crashAndReplace();
      } else {
        await h.runner.stop();
        await sleep(startedAt + 400 - Date.now());
        assert.equal((await h.store.getRun(run.id))?.status, "waiting", "no runner: nothing moves");
        h.runner = h.newRunner();
      }
      const done = await h.until(run.id, ["completed", "failed"], PATIENCE_MS);
      expiredError(done, "the deadline of 250 ms passed");
      assert.ok((done.finishedAt ?? 0) >= startedAt + 250);
      assert.equal((await onlyPending(h, run.id)).resolution?.["expired"], true);
    });
  }
});

test("ask with its own expiresAt and no scope: expiry closes the question, and a replay rejects the same way without a new pending", async (t) => {
  const rejections: Json[] = [];
  const { h, agentId } = await setup(t, async (ctx) => {
    const first = await ctx.memo("n", { recordType: "step", name: "n" }, async (step) => {
      const outcome = await settle(ctx.ask("q", { question: "Soon?", expiresAt: step.startedAt + 200 }));
      rejections.push(outcome);
      return outcome;
    });
    // The memo above finished; asking the expired question again (a replayed driver does) rejects the same way.
    const again = await settle(ctx.ask("q", { question: "Soon?", expiresAt: 0 }));
    rejections.push(again);
    const next = await ctx.ask("next", { question: "And now?" });
    return { first, next: next.answer };
  });
  const run = await h.start(agentId);
  await h.until(run.id, "waiting");
  const startedAt = startedTs(await h.journal(run.id), "step.started", "n");
  const question = (await h.store.listPendings({ runId: run.id }, { limit: 10 })).items.find((p) => p.stepKey === "q");
  assert.equal(question?.detail["expiresAt"], startedAt + 200);
  await waitFor(async () => (await h.pendings(run.id)).some((p) => p.stepKey === "next"), { timeoutMs: PATIENCE_MS });
  const [next] = (await h.pendings(run.id)).filter((p) => p.stepKey === "next");
  await h.send(run.id, { type: "answer", pendingId: next?.id ?? "", answer: "now" });
  const done = await h.until(run.id, "completed", PATIENCE_MS);
  const expected = { code: "deadline_exceeded", message: "the question was not answered before its deadline" };
  assert.deepEqual(done.output, { first: expected, next: "now" });
  assert.deepEqual(rejections, [expected, expected, expected], "the second pass rejected the same way");
  const journal = await h.journal(run.id);
  assert.equal(journal.filter((r) => r.type === "pending.opened" && r.key === "q").length, 1, "no new pending for the expired question");
  const resolution = journal.find((r) => r.type === "pending.resolved" && r.key === "q")?.data["resolution"];
  assert.deepEqual(resolution, { expired: true, expiresAt: startedAt + 200 });
});

test("an answer accepted before the instant wins however late the run resumes; one sent after it is rejected", async (t) => {
  for (const late of [false, true]) {
    await t.test(late ? "sent after the instant" : "sent before the instant", async (tt) => {
      const { h, agentId } = await setup(tt, async (ctx) => ctx.memo("n", { recordType: "step", name: "n" }, async (step) =>
        (await ctx.ask("q", { question: "Which?", expiresAt: step.startedAt + 300 })).answer));
      const run = await h.start(agentId);
      await h.until(run.id, "waiting");
      const startedAt = startedTs(await h.journal(run.id), "step.started", "n");
      const pending = await onlyPending(h, run.id);
      await h.runner.stop();
      if (late) await sleep(startedAt + 350 - Date.now());
      await h.send(run.id, { type: "answer", pendingId: pending.id, answer: "this one" });
      await sleep(startedAt + 400 - Date.now());
      h.runner = h.newRunner();
      const done = await h.until(run.id, ["completed", "failed"], PATIENCE_MS);
      const journal = await h.journal(run.id);
      if (!late) {
        assert.equal(done.status, "completed", JSON.stringify(done.error));
        assert.equal(done.output, "this one");
        assert.deepEqual((await h.store.getPending(pending.id))?.resolution, { answer: "this one" });
        return;
      }
      expiredError(done, "the question was not answered before its deadline");
      const rejected = journal.find((r) => r.type === "command.rejected");
      assert.equal(rejected?.data["reason"], `pending ${pending.id} expired at ${new Date(startedAt + 300).toISOString()}`);
      assert.deepEqual((await h.store.getPending(pending.id))?.resolution, { expired: true, expiresAt: startedAt + 300 });
    });
  }
});

test("a scope whose instant passes while the run is paused: nothing wakes it; on resume it fails and the body does not run again", async (t) => {
  let bodies = 0;
  let after = 0;
  const { h, agentId } = await setup(t, async (ctx) => boundedNode(ctx, 300, async (s) => {
    bodies++;
    await s.sleep(5_000);
    after++;
    return null;
  }));
  const run = await h.start(agentId);
  await waitFor(() => bodies === 1);
  await h.send(run.id, { type: "pause" });
  await h.until(run.id, "paused");
  const startedAt = startedTs(await h.journal(run.id), "node.started", "node");
  await sleep(startedAt + 500 - Date.now());
  assert.equal((await h.store.getRun(run.id))?.status, "paused", "a paused run is not woken by its deadline");
  await h.send(run.id, { type: "resume" });
  const done = await h.until(run.id, ["completed", "failed"], PATIENCE_MS);
  expiredError(done, "the deadline of 300 ms passed");
  assert.equal(bodies, 1, "the scope was entered after its instant: the body was not called");
  assert.equal(after, 0);
});

test("a scope entered after its instant (crash, takeover after the lease) does not call its body", async (t) => {
  let bodies = 0;
  const { h, agentId } = await setup(t, async (ctx) => boundedNode(ctx, 150, async (s) => {
    bodies++;
    await s.sleep(5_000);
    return null;
  }));
  const run = await h.start(agentId);
  await waitFor(() => bodies === 1);
  await h.crashAndReplace();
  const done = await h.until(run.id, ["completed", "failed"], PATIENCE_MS);
  expiredError(done, "the deadline of 150 ms passed");
  assert.equal(bodies, 1);
  const startedAt = startedTs(await h.journal(run.id), "node.started", "node");
  assert.ok((done.finishedAt ?? 0) >= startedAt + 150);
});

test("nested: a pending carries the earliest enclosing instant, and a tool call's enclosure passes it through", async (t) => {
  const asker: ToolDefinition = {
    name: "asker", description: "asks", effect: "read", resumable: true, parameters: { type: "object", properties: {} },
    async handler(_args, context) {
      const { answer } = await context.steps.ask("inner", { question: "From the tool?" });
      return { content: answer };
    },
  };
  const outerFirst = async (ctx: RunContext): Promise<Json> => boundedNode(ctx, 2_000, (outer) =>
    outer.deadline(5_000, async (inner) => (await inner.ask("q", { question: "?" })).answer));
  const innerFirst = async (ctx: RunContext): Promise<Json> => boundedNode(ctx, 5_000, (outer) =>
    outer.deadline(2_000, async (inner) => (await inner.ask("q", { question: "?" })).answer));
  const viaTool = async (ctx: RunContext): Promise<Json> => boundedNode(ctx, 2_000, async (outer) =>
    (await outer.tool("t", { name: "asker", args: {} })).content);
  for (const [name, driver, expect] of [
    ["the outer instant is earlier", outerFirst, "outer"],
    ["the inner instant is earlier", innerFirst, "inner"],
    ["through a tool call", viaTool, "outer"],
  ] as const) {
    await t.test(name, async (tt) => {
      const h = await createHarness(tt, { models: fakeModels(() => reply({ text: "ok" })), tools: [asker], drivers: { agent: driver } });
      const agent = await h.saveAgent({ tools: [{ name: "asker" }] });
      const before = Date.now();
      const run = await h.start(agent.id);
      await h.until(run.id, "waiting");
      const startedAt = startedTs(await h.journal(run.id), "node.started", "node");
      const pending = await onlyPending(h, run.id);
      const at = pendingExpiry(pending);
      if (expect === "outer") {
        assert.equal(at, startedAt + 2_000);
      } else {
        assert.ok(at !== null && at < startedAt + 5_000 && at >= before + 2_000, String(at));
      }
      await h.send(run.id, { type: "cancel", reason: null });
      await h.until(run.id, "cancelled");
    });
  }
});

test("the runner's wake timer, not its poll, wakes a waiting run; a stopped runner's timer is cleared", async (t) => {
  await t.test("woken by the timer", async (tt) => {
    const { h, agentId } = await setup(tt, async (ctx) => boundedNode(ctx, 150, async (s) => (await s.ask("q", { question: "?" })).answer),
      { engine: { pollMs: 60_000 } });
    const run = await h.start(agentId);
    await h.until(run.id, "waiting");
    const done = await h.until(run.id, ["completed", "failed"], PATIENCE_MS);
    expiredError(done, "the deadline of 150 ms passed");
  });
  await t.test("cleared on stop", async (tt) => {
    const { h, agentId } = await setup(tt, async (ctx) => boundedNode(ctx, 300, async (s) => (await s.ask("q", { question: "?" })).answer),
      { engine: { pollMs: 60_000 } });
    const run = await h.start(agentId);
    await h.until(run.id, "waiting");
    const startedAt = startedTs(await h.journal(run.id), "node.started", "node");
    const claims = (await h.records(run.id, "run.claimed")).length;
    await h.runner.stop();
    assert.ok(Date.now() < startedAt + 300, "stopped before the instant");
    await sleep(startedAt + 550 - Date.now());
    assert.equal((await h.store.getRun(run.id))?.status, "waiting");
    assert.equal((await h.records(run.id, "run.claimed")).length, claims, "nothing claimed the run");
  });
});

test("no hot loop: an approval under a scope without startedAt that nobody gives fails the run once its instant passed", async (t) => {
  const { h, counts, agentId } = await setup(t, async (ctx) =>
    (await ctx.deadline(200, (s) => s.tool("t", { name: "act", args: {} }))).content, { policy: "ask" });
  const run = await h.start(agentId);
  await h.until(run.id, "waiting");
  const claimsBefore = (await h.records(run.id, "run.claimed")).length;
  const pending = await onlyPending(h, run.id);
  const expiresAt = pendingExpiry(pending);
  assert.ok(expiresAt !== null);
  const done = await h.until(run.id, ["completed", "failed"], PATIENCE_MS);
  expiredError(done, "the tool call was not approved before the deadline");
  assert.deepEqual((await h.store.getPending(pending.id))?.resolution, { expired: true, expiresAt });
  assert.equal(counts.handler, 0, "the tool never ran");
  const journal = await h.journal(run.id);
  assert.equal(journal.filter((r) => r.type === "tool.started").length, 0);
  assert.equal(journal.filter((r) => r.type === "tool.finished").length, 0, "an expired approval is not a denial");
  assert.ok(journal.filter((r) => r.type === "run.claimed").length <= claimsBefore + 2, "woken once, not bounced");
});

test("an expired interrupted-call pending fails the run with deadline_exceeded, not a cancel", async (t) => {
  const { h, counts, agentId } = await setup(t, async (ctx) =>
    (await ctx.deadline(300, (s) => s.tool("t", { name: "block", args: {} }))).content);
  const run = await h.start(agentId);
  await waitFor(() => counts.handler === 1);
  await h.crashAndReplace();
  const done = await h.until(run.id, ["completed", "failed", "cancelled"], PATIENCE_MS + 1_000);
  expiredError(done, "the interrupted tool call was not resolved before the deadline");
  const interrupted = (await h.store.listPendings({ runId: run.id }, { limit: 10 })).items.filter((p) => p.kind === "interrupted");
  assert.equal(interrupted.length, 1);
  assert.equal(interrupted[0]?.resolution?.["expired"], true);
  assert.equal(counts.handler, 1, "the write call was not repeated");
});

test("an expired limit pending is not reopened: the run fails with deadline_exceeded", async (t) => {
  const { h, agentId } = await setup(t, async (ctx) =>
    (await ctx.deadline(200, (s) => s.model("m", { purpose: "run", system: "s", messages: [{ role: "user", content: "hi" }] }))).text);
  const run = await h.start(agentId, undefined, { maxCostMicros: 1 });
  await h.until(run.id, "waiting");
  assert.equal((await onlyPending(h, run.id)).kind, "spend_cap");
  const done = await h.until(run.id, ["completed", "failed"], PATIENCE_MS);
  expiredError(done, "the limit was not raised before the deadline");
  const opened = (await h.records(run.id, "pending.opened")).filter((d) => d.pending.kind === "spend_cap");
  assert.equal(opened.length, 1, "no second spend_cap pending");
  assert.equal((await onlyPending(h, run.id)).resolution?.["expired"], true);
});

test("an approval before the instant runs the tool; one sent after it is rejected and the tool does not run", async (t) => {
  await t.test("in time", async (tt) => {
    const { h, counts, agentId } = await setup(tt, async (ctx) =>
      boundedNode(ctx, 2_000, async (s) => (await s.tool("t", { name: "act", args: {} })).content), { policy: "ask" });
    const run = await h.start(agentId);
    await h.until(run.id, "waiting");
    const pending = await onlyPending(h, run.id);
    await h.send(run.id, { type: "approve", pendingId: pending.id, always: false });
    const done = await h.until(run.id, ["completed", "failed"], PATIENCE_MS);
    assert.equal(done.status, "completed", JSON.stringify(done.error));
    assert.equal(done.output, "acted");
    assert.equal(counts.handler, 1);
  });
  await t.test("late", async (tt) => {
    const { h, counts, agentId } = await setup(tt, async (ctx) =>
      boundedNode(ctx, 300, async (s) => (await s.tool("t", { name: "act", args: {} })).content), { policy: "ask" });
    const run = await h.start(agentId);
    await h.until(run.id, "waiting");
    const startedAt = startedTs(await h.journal(run.id), "node.started", "node");
    const pending = await onlyPending(h, run.id);
    await h.runner.stop();
    await sleep(startedAt + 350 - Date.now());
    await h.send(run.id, { type: "approve", pendingId: pending.id, always: false });
    h.runner = h.newRunner();
    const done = await h.until(run.id, ["completed", "failed"], PATIENCE_MS);
    expiredError(done, "the deadline of 300 ms passed");
    const rejected = (await h.records(run.id, "command.rejected"))[0];
    assert.equal(rejected?.reason, `pending ${pending.id} expired at ${new Date(startedAt + 300).toISOString()}`);
    assert.equal(counts.handler, 0);
    assert.equal((await h.journal(run.id)).filter((r) => r.type === "tool.started").length, 0);
  });
});

test("leaving for waiting with an already expired pending never stores a due wake: the run fails directly", async (t) => {
  const { h, agentId } = await setup(t, async (ctx) => {
    const [asked, slept] = await Promise.allSettled([
      ctx.deadline(100, async (s) => (await s.ask("q", { question: "?" })).answer),
      ctx.sleep(400),
    ]);
    if (asked.status === "rejected") throw asked.reason;
    if (slept.status === "rejected") throw slept.reason;
    return asked.value;
  });
  const run = await h.start(agentId);
  const done = await h.until(run.id, ["completed", "failed"], PATIENCE_MS);
  expiredError(done, "the question was not answered before its deadline");
  const journal = await h.journal(run.id);
  assert.equal(journal.filter((r) => r.type === "run.waiting").length, 0, "the run never left for waiting with a due wake");
  const resolved = journal.find((r) => r.type === "pending.resolved");
  const failed = journal.find((r) => r.type === "run.failed");
  assert.ok(resolved !== undefined && failed !== undefined && resolved.seq < failed.seq);
  assert.equal((resolved.data["resolution"] as JsonObject)["expired"], true);
  assert.equal(journal.filter((r) => r.type === "run.claimed").length, 1, "one claim: the run never left running");
});

test("startedAt and expiresAt that are not finite numbers are bad_request; nothing is journalled and the body is not called", async (t) => {
  let bodies = 0;
  const { h, agentId } = await setup(t, async (ctx) => [
    await settle(ctx.deadline(100, async () => {
      bodies++;
      return null;
    }, { startedAt: Number.NaN })),
    await settle(ctx.deadline(100, async () => {
      bodies++;
      return null;
    }, { startedAt: Number.POSITIVE_INFINITY })),
    await settle(ctx.ask("q", { question: "?", expiresAt: "soon" as unknown as number })),
    await settle(ctx.ask("q2", { question: "?", expiresAt: Number.NaN })),
  ]);
  const run = await h.start(agentId);
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, [
    { code: "bad_request", message: "a deadline's startedAt must be a finite number" },
    { code: "bad_request", message: "a deadline's startedAt must be a finite number" },
    { code: "bad_request", message: "a question's expiresAt must be a finite number" },
    { code: "bad_request", message: "a question's expiresAt must be a finite number" },
  ]);
  assert.equal(bodies, 0);
  assert.equal((await h.journal(run.id)).filter((r) => r.key !== null).length, 0, "no step record");
});

// ------------------------------------------------------------------ boundaries ("expired" is now >= expiresAt)

/** A session core over a fake clock that records commits and expirePendings calls. */
function fakeCore(clock: FakeClock): { core: SessionCore; batches: CommitBatch[]; expiries: number[] } {
  const state = createReplayState({ maxCostMicros: null, maxToolCalls: null, maxTurns: null, allowUnpriced: false });
  const batches: CommitBatch[] = [];
  const expiries: number[] = [];
  const deps = {
    clock, ids: createIdSource(), logger: createLogger({ write: () => undefined }), tools: createToolRegistry([]),
    config: { denyTools: [], toolResultBytes: 16_384 },
  } as unknown as EngineDeps;
  const core: SessionCore = {
    deps, run: { id: "run_1", agentId: "agent_1" } as RunRecord, definition: testAgentDefinition(), workspace: "/nonexistent",
    signal: new AbortController().signal, logger: deps.logger, redactor: createGrowingRedactor(), toolSecrets: {}, state,
    learning: null, inflight: new Map(), reserved: { micros: 0, turns: 0, toolStarts: 0 }, repairTurns: new Map(),
    checkControl: () => undefined,
    async commit(input) {
      const batch = typeof input === "function" ? input() : input;
      if (batch === null) return [];
      batches.push(batch);
      const stored = batch.records.map((r, i): JournalRecord => ({
        runId: "run_1", seq: state.records.length + i + 1, epoch: 1, ts: clock.now(), type: r.type, key: r.key ?? null, data: r.data,
      }));
      for (const record of stored) applyRecord(state, record);
      return stored;
    },
    register(): CallHandle {
      return { signal: new AbortController().signal, cause: () => null, dispose: () => undefined };
    },
    deadlineAt: () => null,
    async expirePendings() {
      expiries.push(clock.now());
    },
    toolScope: () => null,
  };
  return { core, batches, expiries };
}

test("a scope entered exactly at its instant is expired; one millisecond before, its body runs", async () => {
  const clock = createFakeClock(1_000_000);
  const { core, expiries } = fakeCore(clock);
  const ctx = createRunContext(core, "");
  let bodies = 0;
  const body = async (): Promise<string> => {
    bodies++;
    return "ran";
  };
  await assert.rejects(ctx.deadline(100, body, { startedAt: 1_000_000 - 100 }),
    (e: unknown) => isRunwrightError(e) && e.code === "deadline_exceeded" && e.message === "the deadline of 100 ms passed");
  assert.equal(bodies, 0);
  assert.deepEqual(expiries, [1_000_000], "the expired pendings are closed before it rejects");
  assert.equal(await ctx.deadline(100, body, { startedAt: 1_000_000 - 99 }), "ran");
  assert.equal(bodies, 1);
});

test("a question whose instant is now is not opened; one a millisecond later is opened with it", async () => {
  const clock = createFakeClock(2_000_000);
  const { core, batches } = fakeCore(clock);
  const ctx = createRunContext(core, "");
  await assert.rejects(ctx.ask("q", { question: "?", expiresAt: 2_000_000 }),
    (e: unknown) => isRunwrightError(e) && e.code === "deadline_exceeded" && e.message === "the question was not answered before its deadline");
  assert.equal(batches.length, 0, "nothing journalled");
  await assert.rejects(ctx.ask("q", { question: "?", expiresAt: 2_000_001 }), (e: unknown) => isControlSignal(e) && e.reason === "waiting");
  const opened = batches[0]?.openPendings?.[0];
  assert.deepEqual(opened?.detail, { question: "?", choices: [], expiresAt: 2_000_001 });
  // The same question read at its instant: closed through expirePendings, then still open here, so it waits.
  clock.advance(1);
  await assert.rejects(ctx.ask("q", { question: "?", expiresAt: 2_000_001 }), (e: unknown) => isControlSignal(e) && e.reason === "waiting");
});

test("planCommands rejects a command created at the pending's instant and applies one created a millisecond before", () => {
  const state = createReplayState({ maxCostMicros: null, maxToolCalls: null, maxTurns: null, allowUnpriced: false });
  const detail: JsonObject = { question: "?", choices: [], expiresAt: 5_000 };
  applyRecord(state, {
    runId: "run_1", seq: 1, epoch: 1, ts: 1_000, type: "pending.opened", key: "q",
    data: { pending: { id: "pend_1", kind: "question", stepKey: "q", title: "?", detail } },
  });
  const command = (id: string, createdAt: number): CommandRecord => ({
    id, runId: "run_1", command: { type: "answer", pendingId: "pend_1", answer: id }, createdAt, consumedAt: null,
  });
  const late = planCommands(state, [command("cmd_late", 5_000)]);
  assert.deepEqual(late?.batch.records.map((r) => [r.type, r.data["reason"] ?? null]), [
    ["command.rejected", `pending pend_1 expired at ${new Date(5_000).toISOString()}`],
  ]);
  assert.equal(late?.batch.resolvePendings, undefined, "the pending stays open for the engine to close");
  const early = planCommands(state, [command("cmd_early", 4_999)]);
  assert.deepEqual(early?.batch.resolvePendings, [{ id: "pend_1", resolution: { answer: "cmd_early" } }]);
});
