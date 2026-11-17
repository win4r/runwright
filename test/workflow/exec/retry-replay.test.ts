/**
 * R15D-workflow-01: a node's backoff is waited once. The wait before attempt n + 1 ends at
 * `node.retry(n).ts + node.retry(n).data.delayMs` in every session, a session that arrives after that instant does
 * not wait at all, and the total wait across sessions is never longer than the journalled `delayMs`. Time is a
 * fake clock shared by the store and the engine, and every engine wait is a timer of that clock, so a test sees
 * exactly which waits were asked for.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { RunwrightError } from "../../../src/core/errors.ts";
import type { JsonObject } from "../../../src/core/json.ts";
import type { Driver } from "../../../src/engine/types.ts";
import type { CommitBatch, JournalRecord, Lease, Store } from "../../../src/store/types.ts";
import type { WorkflowNode } from "../../../src/workflow/types.ts";
import { createHarness, fakeModels, fakeTimers, reply, storeWith, type FakeTimers } from "../../helpers/engine.ts";
import { doc, setupWorkflow, type WorkflowSetup } from "./helpers.ts";

const START = Date.UTC(2026, 10, 16, 12, 0, 0);
const BACKOFF = 10_000;
/** `claimSession` leases are 30 s: advancing past this lets the next session claim a run a fenced one held. */
const PAST_LEASE = 30_001;

/** A tool node whose first invocation fails and whose second succeeds, retried once after a 10 s backoff. */
const fetchNode: WorkflowNode = {
  id: "fetch", kind: "tool", tool: "flaky", args: { label: "a", failTimes: 1 },
  retry: { maxAttempts: 2, backoffMs: BACKOFF },
};

interface Crashable {
  /** Makes the next commit that journals `node.finished` of `nodeId` fail as if the lease had been lost. */
  crashAt(nodeId: string): void;
  wrap(store: Store): Store;
}

/** A store wrapper that fences the session when it is about to journal a node's finish: a crash just before it. */
function crashable(): Crashable {
  let armed: string | null = null;
  return {
    crashAt(nodeId) {
      armed = nodeId;
    },
    wrap: (store) => storeWith(store, {
      async commit(lease: Lease, batch: CommitBatch) {
        if (armed !== null && batch.records.some((r) => r.type === "node.finished" && r.data["name"] === armed)) {
          armed = null;
          throw new RunwrightError("lease_lost", "the test crashed the session before node.finished");
        }
        return store.commit(lease, batch);
      },
    }),
  };
}

async function setup(t: TestContext): Promise<{ s: WorkflowSetup; timers: FakeTimers; crash: Crashable }> {
  const timers = fakeTimers(START);
  const crash = crashable();
  const s = await setupWorkflow(t, { harness: { clock: timers.clock, sleep: timers.sleep, wrapStore: crash.wrap, autoStart: false } });
  return { s, timers, crash };
}

function retryRecord(journal: readonly JournalRecord[]): JournalRecord {
  const found = journal.filter((r) => r.type === "node.retry");
  assert.equal(found.length, 1, "exactly one node.retry");
  return found[0] as JournalRecord;
}

test("(R15D-workflow-01) a restart after the backoff and a successful retry finishes the node without waiting or running again", async (t) => {
  const { s, timers, crash } = await setup(t);
  const agent = await s.agent({ workflow: doc(fetchNode, { $ref: "steps.fetch.content" }) });
  const run = await s.h.start(agent, { data: {} });
  const first = await s.h.claimSession();
  await timers.untilWaiting();
  const retry = retryRecord(await s.h.journal(run.id));
  assert.equal(retry.ts, START);
  assert.deepEqual(timers.pending(), [START + BACKOFF]);

  crash.crashAt("fetch");
  timers.advance(BACKOFF);
  await first.session.done;
  assert.equal(s.counters.get("flaky", "a"), 2, "attempt 2 ran and finished before the crash");

  timers.advance(PAST_LEASE);
  await s.h.claimSession();
  const done = await s.h.until(run.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(done.output, "a");
  assert.deepEqual(timers.requested, [BACKOFF], "the second session asked for no wait");
  assert.deepEqual(timers.pending(), []);
  assert.equal(s.counters.get("flaky", "a"), 2, "the tool did not run again");
});

test("(R15D-workflow-01) inside an enclosing deadline with 1 s left, the replayed node succeeds instead of waiting its backoff again", async (t) => {
  const { s, timers, crash } = await setup(t);
  const deadlineMs = BACKOFF + PAST_LEASE + 1000;
  const root: WorkflowNode = { id: "outer", kind: "sequence", deadlineMs, steps: [fetchNode] };
  const agent = await s.agent({ workflow: doc(root, { $ref: "steps.fetch.content" }) });
  const run = await s.h.start(agent, { data: {} });
  const first = await s.h.claimSession();
  await timers.untilWaiting();
  crash.crashAt("fetch");
  timers.advance(BACKOFF);
  await first.session.done;

  timers.advance(PAST_LEASE);
  assert.equal(START + deadlineMs - timers.clock.now(), 1000, "the enclosing deadline has 1 s left");
  await s.h.claimSession();
  const done = await s.h.until(run.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.deepEqual(timers.requested, [BACKOFF]);
  assert.equal(s.counters.get("flaky", "a"), 2);
});

/** Pauses the run 4 s into its 10 s backoff and resumes it; `between` runs while it is paused. */
async function pauseInBackoff(s: WorkflowSetup, timers: FakeTimers, between: () => void): Promise<string> {
  const agent = await s.agent({ workflow: doc(fetchNode, { $ref: "steps.fetch.content" }) });
  const run = await s.h.start(agent, { data: {} });
  const first = await s.h.claimSession();
  await timers.untilWaiting();
  timers.advance(4000);
  await s.h.send(run.id, { type: "pause" });
  await first.session.done;
  assert.equal((await s.h.store.getRun(run.id))?.status, "paused");
  assert.deepEqual(timers.pending(), [], "the pause ended the wait");
  between();
  await s.h.send(run.id, { type: "resume" });
  await s.h.claimSession();
  return run.id;
}

test("(R15D-workflow-01) a pause 4 s into a 10 s backoff: the resumed session waits the 6 s that are left", async (t) => {
  const { s, timers } = await setup(t);
  const runId = await pauseInBackoff(s, timers, () => undefined);
  await timers.untilWaiting();
  assert.deepEqual(timers.requested, [BACKOFF, 6000]);
  assert.deepEqual(timers.pending(), [START + BACKOFF]);
  assert.equal(s.counters.get("flaky", "a"), 1, "attempt 2 waits for the rest of the backoff");
  timers.advance(6000);
  const done = await s.h.until(runId, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(s.counters.get("flaky", "a"), 2);
});

test("(R15D-workflow-01) a clock that stepped back between sessions: the wait is capped at the journalled delayMs", async (t) => {
  const { s, timers } = await setup(t);
  const runId = await pauseInBackoff(s, timers, () => timers.clock.set(START - 60_000));
  await timers.untilWaiting();
  assert.deepEqual(timers.requested, [BACKOFF, BACKOFF], "never more than delayMs, although the instant is 70 s away");
  timers.advance(BACKOFF);
  const done = await s.h.until(runId, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
});

test("(R15D-workflow-01) emit returns the stored record, the same on its first write, a repeat and a replay", async (t) => {
  const seen: JsonObject[] = [];
  const driver: Driver = async (ctx) => {
    const first = await ctx.emit("note", "test.noted", { n: seen.length });
    const again = await ctx.emit("note", "test.noted", { n: 99 });
    assert.equal(again, first);
    seen.push({ seq: first.seq, ts: first.ts, type: first.type, key: first.key, data: first.data });
    await ctx.ask("q", { question: "go on?" });
    return { seq: first.seq };
  };
  const h = await createHarness(t, { models: fakeModels(() => reply({})), drivers: { agent: driver } });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id);
  await h.until(run.id, "waiting");
  const [pending] = await h.pendings(run.id);
  assert.ok(pending !== undefined);
  await h.send(run.id, { type: "answer", pendingId: pending.id, answer: "yes" });
  const done = await h.until(run.id, "completed");
  const stored = (await h.journal(run.id)).filter((r) => r.type === "test.noted");
  assert.equal(stored.length, 1);
  const record = stored[0] as JournalRecord;
  const expected = { seq: record.seq, ts: record.ts, type: "test.noted", key: "note", data: { n: 0 } };
  assert.deepEqual(seen, [expected, expected], "the first session and the replaying one got the same record");
  assert.deepEqual(done.output, { seq: record.seq });
});

test("a model call resumed after model.retry sends its next attempt without sleeping the engine's backoff again", async (t) => {
  const timers = fakeTimers(START);
  let requests = 0;
  const models = fakeModels(() => {
    requests += 1;
    if (requests === 1) throw new RunwrightError("model_transient", "HTTP 503", { details: { status: 503, billing: "none" } });
    return reply({ text: "done" });
  }, { policy: { maxAttempts: 3, baseMs: BACKOFF, maxMs: BACKOFF }, random: () => 1, sleep: timers.sleep });
  const h = await createHarness(t, { models, clock: timers.clock, sleep: timers.sleep, autoStart: false });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id);
  const first = await h.claimSession();
  await timers.untilWaiting();
  assert.deepEqual(timers.requested, [BACKOFF]);
  timers.advance(4000);
  await h.send(run.id, { type: "pause" });
  await first.session.done;
  await h.send(run.id, { type: "resume" });
  await h.claimSession();
  const done = await h.until(run.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(requests, 2);
  assert.deepEqual(timers.requested, [BACKOFF], "the engine's own backoff is not served again after a resume");
  const retries = await h.records(run.id, "model.retry");
  assert.deepEqual(retries.map((r) => [r.attempt, r.delayMs, r.retryAfterMs ?? null]), [[1, BACKOFF, null]]);
});
