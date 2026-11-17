import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { openTestStore, testAgentDefinition } from "../helpers/store.ts";
import { createFakeClock, type FakeClock } from "../../src/core/clock.ts";
import { isRunwrightError } from "../../src/core/errors.ts";
import type { ClaimedRun, NewUsage, Store } from "../../src/store/types.ts";
import { DatabaseSync } from "node:sqlite";
import { recordFieldsWith } from "../../src/store/record-fields.ts";

const code = (c: string) => (e: unknown): boolean => isRunwrightError(e) && e.code === c;

async function claimed(t: TestContext, clock?: FakeClock): Promise<{ store: Store; claim: ClaimedRun }> {
  const { store } = await openTestStore(t, clock === undefined ? undefined : { clock });
  await store.saveAgent({ id: "a", definition: testAgentDefinition() });
  await store.createRun({ agentId: "a", input: { message: "", data: null } });
  const [claim] = await store.claimRuns({ runnerId: "r", limit: 1, leaseMs: 10_000 });
  return { store, claim: claim! };
}

const usage = (costMicros: number | null, purpose: NewUsage["purpose"] = "run"): NewUsage => ({
  model: "scripted/scripted-1", purpose, inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1, costMicros, assumed: false,
});

test("records get dense seq, the lease epoch and the commit time", async (t) => {
  const clock = createFakeClock(50_000);
  const { store, claim } = await claimed(t, clock);
  clock.advance(7);
  const a = await store.commit(claim.lease, { records: [{ type: "run.claimed", data: { runnerId: "r" } }, { type: "inbox.taken", key: "i0", data: { messages: [] } }] });
  assert.deepEqual(a.records.map((r) => [r.seq, r.epoch, r.ts, r.key]), [[2, 1, 50_007, null], [3, 1, 50_007, "i0"]]);
  const b = await store.commit(claim.lease, { records: [{ type: "x", data: {} }] });
  assert.equal(b.records[0]!.seq, 4);
  assert.equal(b.run.journalSeq, 4);
  assert.deepEqual((await store.readJournal(claim.run.id)).map((r) => r.seq), [1, 2, 3, 4]);
  const empty = await store.commit(claim.lease, { records: [] });
  assert.deepEqual(empty.records, []);
  assert.equal(empty.run.journalSeq, 4);
});

test("a failing batch is atomic: nothing of it is written", async (t) => {
  const { store, claim } = await claimed(t);
  const before = await store.getRun(claim.run.id);
  await assert.rejects(store.commit(claim.lease, {
    records: [{ type: "tool.started", key: "k", data: {} }],
    openPendings: [{ id: "pnd_1", kind: "question", stepKey: "k", title: "Q?", detail: { question: "Q?", choices: [] } }],
    usage: [usage(5)],
    counters: { toolCalls: 1, turns: 1 },
    resolvePendings: [{ id: "pnd_missing", resolution: {} }],
  }), code("conflict"));
  assert.deepEqual(await store.getRun(claim.run.id), before);
  assert.equal((await store.readJournal(claim.run.id)).length, 1);
  assert.equal(await store.getPending("pnd_1"), null);
  assert.deepEqual(await store.usageSummary({ groupBy: "model" }), []);
});

test("a terminal commit stores the output and ends the lease", async (t) => {
  const { store, claim } = await claimed(t);
  await store.commit(claim.lease, { records: [], transition: { to: "completed", output: { ok: true } } });
  const run = await store.getRun(claim.run.id);
  assert.equal(run?.status, "completed");
  assert.deepEqual(run?.output, { ok: true });
  assert.equal(run?.leaseOwner, null);
  assert.equal(run?.leaseExpiresAt, null);
  assert.ok(run?.finishedAt !== null);
  await assert.rejects(store.commit(claim.lease, { records: [], transition: { to: "failed" } }), code("lease_lost"));
});

test("illegal_transition from running to a status not in the table", async (t) => {
  const { store, claim } = await claimed(t);
  await assert.rejects(store.commit(claim.lease, { records: [{ type: "x", data: {} }], transition: { to: "bogus" as "queued" } }), code("illegal_transition"));
  assert.equal((await store.readJournal(claim.run.id)).length, 1);
});

test("transitions set output, error, finished_at and clear the lease", async (t) => {
  const clock = createFakeClock(9_000);
  const { store, claim } = await claimed(t, clock);
  clock.advance(5);
  const waiting = await store.commit(claim.lease, { records: [], transition: { to: "waiting" } });
  assert.equal(waiting.run.status, "waiting");
  assert.equal(waiting.run.finishedAt, null);
  assert.equal(waiting.run.leaseOwner, null);
  assert.equal(waiting.run.epoch, 1, "epoch never decreases");
  const wake = await store.enqueueCommand(claim.run.id, { type: "message", text: "hi" });
  const [again] = await store.claimRuns({ runnerId: "r", limit: 1, leaseMs: 1000 });
  assert.equal(again!.lease.epoch, 2);
  const failed = await store.commit(again!.lease, { records: [], consumeCommands: [wake.id],
    transition: { to: "failed", error: { code: "internal", message: "boom" } } });
  assert.deepEqual(failed.run.error, { code: "internal", message: "boom" });
  assert.equal(failed.run.finishedAt, 9_005);
});

test("release to queued makes the run claimable again at once", async (t) => {
  const clock = createFakeClock(1_000);
  const { store, claim } = await claimed(t, clock);
  const released = await store.commit(claim.lease, { records: [{ type: "run.released", data: { reason: "shutdown" } }], transition: { to: "queued" } });
  assert.equal(released.run.status, "queued");
  const [next] = await store.claimRuns({ runnerId: "r2", limit: 1, leaseMs: 1000 });
  assert.equal(next?.run.id, claim.run.id);
});

test("usage rows add to run totals; a null cost makes the cost unknown", async (t) => {
  const { store, claim } = await claimed(t);
  const one = await store.commit(claim.lease, { records: [], usage: [usage(100), usage(50, "grader")] });
  assert.deepEqual(one.run.usage, { inputTokens: 20, outputTokens: 8, cacheReadTokens: 4, cacheWriteTokens: 2, costMicros: 150,
    costUnknown: false, toolCalls: 0, turns: 0 });
  const two = await store.commit(claim.lease, { records: [], usage: [usage(null)] });
  assert.equal(two.run.usage.costUnknown, true);
  assert.equal(two.run.usage.costMicros, 150, "known costs still add up");
  const three = await store.commit(claim.lease, { records: [], usage: [usage(1)] });
  assert.equal(three.run.usage.costUnknown, true, "unknown stays unknown");
  assert.equal(three.run.usage.costMicros, 151);
});

test("counters increment and setLimits replaces the limits", async (t) => {
  const { store, claim } = await claimed(t);
  await store.commit(claim.lease, { records: [], counters: { toolCalls: 2, turns: 1 } });
  const result = await store.commit(claim.lease, { records: [], counters: { turns: 2 },
    setLimits: { maxCostMicros: 10, maxToolCalls: 3, maxTurns: null, allowUnpriced: true } });
  assert.equal(result.run.usage.toolCalls, 2);
  assert.equal(result.run.usage.turns, 3);
  assert.deepEqual(result.run.limits, { maxCostMicros: 10, maxToolCalls: 3, maxTurns: null, allowUnpriced: true });
});

for (const to of ["waiting", "paused", "completed", "failed", "cancelled"] as const) {
  test(`a transition to ${to} is refused with commands_pending while a command is unconsumed, and writes nothing`, async (t) => {
    const { store, claim } = await claimed(t);
    const command = await store.enqueueCommand(claim.run.id, { type: "cancel", reason: "late" });
    const before = await store.getRun(claim.run.id);
    const refused = await store.commit(claim.lease, {
      records: [{ type: `run.${to}`, data: {} }], usage: [usage(5)], counters: { turns: 1 }, transition: { to },
    }).then(() => null, (error: unknown) => error);
    assert.ok(code("commands_pending")(refused), `expected commands_pending, got ${String(refused)}`);
    assert.deepEqual((refused as { details?: unknown }).details, { runId: claim.run.id, commandIds: [command.id] });
    assert.deepEqual(await store.getRun(claim.run.id), before, "the run row is unchanged");
    assert.equal((await store.readJournal(claim.run.id)).length, 1, "journal seq unchanged");
    assert.equal((await store.listCommands(claim.run.id, { unconsumedOnly: true })).length, 1);

    const ok = await store.commit(claim.lease, { records: [{ type: `run.${to}`, data: {} }], consumeCommands: [command.id], transition: { to } });
    assert.equal(ok.run.status, to);
    assert.deepEqual(await store.listCommands(claim.run.id, { unconsumedOnly: true }), []);
  });
}

test("the exact completion batch of a session is refused while a cancel is unconsumed", async (t) => {
  const { store, claim } = await claimed(t);
  await store.enqueueCommand(claim.run.id, { type: "cancel", reason: null });
  await assert.rejects(store.commit(claim.lease, {
    records: [{ type: "run.completed", data: { output: null } }], transition: { to: "completed", output: null },
  }), code("commands_pending"));
  assert.equal((await store.getRun(claim.run.id))?.status, "running");
});

test("a release to queued keeps unconsumed commands for the next claim", async (t) => {
  const { store, claim } = await claimed(t);
  const command = await store.enqueueCommand(claim.run.id, { type: "message", text: "for later" });
  const released = await store.commit(claim.lease, { records: [{ type: "run.released", data: { reason: "shutdown" } }], transition: { to: "queued" } });
  assert.equal(released.run.status, "queued");
  assert.deepEqual((await store.listCommands(claim.run.id, { unconsumedOnly: true })).map((c) => c.id), [command.id]);
});

test("a commit without a transition is never refused for unconsumed commands", async (t) => {
  const { store, claim } = await claimed(t);
  await store.enqueueCommand(claim.run.id, { type: "message", text: "x" });
  const ok = await store.commit(claim.lease, { records: [{ type: "x", data: {} }] });
  assert.equal(ok.records.length, 1);
});

test("a record's declared fields are not stored: the returned record, the data column and a later read have none", async (t) => {
  const { store, path } = await openTestStore(t);
  await store.saveAgent({ id: "a", definition: testAgentDefinition() });
  await store.createRun({ agentId: "a", input: { message: "", data: null } });
  const [claim] = await store.claimRuns({ runnerId: "r", limit: 1, leaseMs: 10_000 });
  const data = { name: "learning.given", value: { promptSection: "notes", given: [], tools: [] } };
  const fields = recordFieldsWith("step.finished", "value", { fields: { promptSection: "text" } });
  const result = await store.commit(claim!.lease, { records: [{ type: "step.finished", key: "learning/given", data, fields }] });
  const [returned] = result.records;
  assert.ok(returned !== undefined);
  assert.equal(Object.hasOwn(returned, "fields"), false, "the returned JournalRecord has no fields");
  assert.deepEqual(returned.data, data);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db.prepare("SELECT data FROM journal WHERE run_id = ? AND type = 'step.finished'").all(claim!.run.id) as { data: string }[];
    assert.deepEqual(rows.map((row) => JSON.parse(row.data)), [data], "the data column holds the data, nothing more");
  } finally {
    db.close();
  }
  const read = (await store.readJournal(claim!.run.id)).filter((r) => r.type === "step.finished");
  assert.deepEqual(read.map((r) => [Object.hasOwn(r, "fields"), r.key, r.data]), [[false, "learning/given", data]]);
});
