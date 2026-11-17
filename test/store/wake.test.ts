/**
 * A waiting run's wake time (`transition.wakeAt`): the store requeues the run at `claimRuns` once the instant
 * passed, without a command and without a journal record; a command clears it; it is only valid on `waiting`.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { openTestStore, testAgentDefinition } from "../helpers/store.ts";
import { createFakeClock, type FakeClock } from "../../src/core/clock.ts";
import { isRunwrightError } from "../../src/core/errors.ts";
import type { ClaimedRun, RunStatus, Store, StoreEvent } from "../../src/store/types.ts";

const T0 = 1_000_000;

async function setup(t: TestContext): Promise<{ store: Store; clock: FakeClock; events: StoreEvent[] }> {
  const clock = createFakeClock(T0);
  const { store } = await openTestStore(t, { clock });
  await store.saveAgent({ id: "a", definition: testAgentDefinition() });
  const events: StoreEvent[] = [];
  const unsubscribe = store.subscribe((event) => events.push(event));
  t.after(unsubscribe);
  return { store, clock, events };
}

async function claimOne(store: Store): Promise<ClaimedRun> {
  const [claim] = await store.claimRuns({ runnerId: "r", limit: 1, leaseMs: 60_000 });
  assert.ok(claim !== undefined, "a run was claimed");
  return claim;
}

/** A new run, claimed and left waiting (with `wakeAt` when given). */
async function waitingRun(store: Store, wakeAt?: number): Promise<ClaimedRun> {
  await store.createRun({ agentId: "a", input: { message: "", data: null } });
  const claim = await claimOne(store);
  await store.commit(claim.lease, {
    records: [{ type: "run.waiting", data: { pendingIds: [] } }],
    transition: wakeAt === undefined ? { to: "waiting" } : { to: "waiting", wakeAt },
  });
  return claim;
}

/** The run row's wake_at, read straight from the file. */
function wakeAtOf(path: string, runId: string): unknown {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare("SELECT wake_at FROM runs WHERE id = ?").get(runId)?.["wake_at"];
  } finally {
    db.close();
  }
}

test("a waiting run with a wake time is claimed at the instant, not before, with a run.queued event and no journal record", async (t) => {
  const { store, clock, events } = await setup(t);
  const first = await waitingRun(store, T0 + 500);
  const journalBefore = (await store.readJournal(first.run.id)).length;
  clock.advance(499);
  assert.deepEqual(await store.claimRuns({ runnerId: "r2", limit: 5, leaseMs: 60_000 }), []);
  assert.equal((await store.getRun(first.run.id))?.status, "waiting");
  events.length = 0;
  clock.advance(1);
  const claimed = await store.claimRuns({ runnerId: "r2", limit: 5, leaseMs: 60_000 });
  assert.deepEqual(claimed.map((c) => c.run.id), [first.run.id]);
  const run = await store.getRun(first.run.id);
  assert.equal(run?.status, "running");
  assert.equal(run?.epoch, first.run.epoch + 1);
  assert.equal(run?.leaseOwner, "r2");
  assert.deepEqual(events.filter((e) => e.type === "run.queued"), [{ type: "run.queued", runId: first.run.id }]);
  assert.equal((await store.readJournal(first.run.id)).length, journalBefore, "the wake writes no journal record");
});

test("a waiting run without a wake time is never claimed by time alone", async (t) => {
  const { store, clock } = await setup(t);
  const claim = await waitingRun(store);
  clock.advance(365 * 24 * 3_600_000);
  assert.deepEqual(await store.claimRuns({ runnerId: "r", limit: 5, leaseMs: 60_000 }), []);
  assert.equal((await store.getRun(claim.run.id))?.status, "waiting");
});

test("a command that requeues a waiting run clears its wake time", async (t) => {
  const { store, clock } = await setup(t);
  const claim = await waitingRun(store, T0 + 1_000);
  clock.advance(10);
  await store.enqueueCommand(claim.run.id, { type: "message", text: "hello" });
  assert.equal((await store.getRun(claim.run.id))?.status, "queued");
  const again = await claimOne(store);
  assert.equal(again.run.id, claim.run.id);
  // Leave it waiting again without a wake time (the command consumed), then pass the old instant.
  const [command] = await store.listCommands(claim.run.id, { unconsumedOnly: true });
  await store.commit(again.lease, { records: [], consumeCommands: [command?.id ?? ""], transition: { to: "waiting" } });
  clock.advance(5_000);
  assert.deepEqual(await store.claimRuns({ runnerId: "r", limit: 5, leaseMs: 60_000 }), []);
  assert.equal((await store.getRun(claim.run.id))?.status, "waiting");
});

test("a wake time on a transition other than waiting, or one that is not a finite number, is bad_request and writes nothing", async (t) => {
  const { store } = await setup(t);
  await store.createRun({ agentId: "a", input: { message: "", data: null } });
  const claim = await claimOne(store);
  const cases: { to: RunStatus; wakeAt: unknown }[] = [
    { to: "paused", wakeAt: T0 + 10 },
    { to: "completed", wakeAt: T0 + 10 },
    { to: "queued", wakeAt: T0 + 10 },
    { to: "waiting", wakeAt: Number.NaN },
    { to: "waiting", wakeAt: Number.POSITIVE_INFINITY },
    { to: "waiting", wakeAt: "soon" },
  ];
  for (const { to, wakeAt } of cases) {
    const before = await store.getRun(claim.run.id);
    await assert.rejects(store.commit(claim.lease, {
      records: [{ type: "x.y", data: {} }],
      transition: { to, wakeAt: wakeAt as number },
    }), (e: unknown) => isRunwrightError(e) && e.code === "bad_request", `${to} ${String(wakeAt)}`);
    const after = await store.getRun(claim.run.id);
    assert.equal(after?.journalSeq, before?.journalSeq, "no record was written");
    assert.equal(after?.status, "running");
  }
});

test("transitions other than waiting leave wake_at NULL", async (t) => {
  const clock = createFakeClock(T0);
  const { store, path } = await openTestStore(t, { clock });
  await store.saveAgent({ id: "a", definition: testAgentDefinition() });
  await store.createRun({ agentId: "a", input: { message: "", data: null } });
  let claim = await claimOne(store);
  await store.commit(claim.lease, { records: [], transition: { to: "waiting", wakeAt: T0 + 50 } });
  assert.equal(wakeAtOf(path, claim.run.id), T0 + 50);
  clock.advance(50);
  claim = await claimOne(store);
  assert.equal(wakeAtOf(path, claim.run.id), null, "the wake clears it");
  await store.commit(claim.lease, { records: [], transition: { to: "queued" } });
  assert.equal(wakeAtOf(path, claim.run.id), null);
  claim = await claimOne(store);
  await store.commit(claim.lease, { records: [], transition: { to: "paused" } });
  assert.equal(wakeAtOf(path, claim.run.id), null);
  await store.enqueueCommand(claim.run.id, { type: "resume" });
  claim = await claimOne(store);
  const [resume] = await store.listCommands(claim.run.id, { unconsumedOnly: true });
  await store.commit(claim.lease, { records: [], consumeCommands: [resume?.id ?? ""], transition: { to: "failed", error: { code: "internal", message: "x" } } });
  assert.equal(wakeAtOf(path, claim.run.id), null);
});

test("more than 100 due runs: one claim requeues 100, the next the rest; runs that do not fit the limit stay queued", async (t) => {
  const { store, clock } = await setup(t);
  const ids: string[] = [];
  for (let i = 0; i < 105; i++) ids.push((await waitingRun(store, T0 + 10 + i)).run.id);
  clock.advance(1_000);
  const first = await store.claimRuns({ runnerId: "r", limit: 1, leaseMs: 60_000 });
  assert.deepEqual(first.map((c) => c.run.id), [ids[0]], "earliest wake first");
  const statuses = async (): Promise<Map<string, RunStatus>> => {
    const out = new Map<string, RunStatus>();
    for (const id of ids) out.set(id, (await store.getRun(id))?.status ?? "failed");
    return out;
  };
  let now = await statuses();
  assert.equal([...now.values()].filter((s) => s === "queued").length, 99);
  assert.equal([...now.values()].filter((s) => s === "waiting").length, 5);
  assert.deepEqual(ids.slice(100).map((id) => now.get(id)), ["waiting", "waiting", "waiting", "waiting", "waiting"]);
  const second = await store.claimRuns({ runnerId: "r", limit: 1, leaseMs: 60_000 });
  assert.equal(second.length, 1);
  now = await statuses();
  assert.equal([...now.values()].filter((s) => s === "waiting").length, 0, "the second claim requeued the rest");
  assert.equal([...now.values()].filter((s) => s === "queued").length, 103);
  assert.equal([...now.values()].filter((s) => s === "running").length, 2);
});
