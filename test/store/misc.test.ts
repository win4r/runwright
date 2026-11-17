import { test } from "node:test";
import assert from "node:assert/strict";
import { openTestStore, testAgentDefinition } from "../helpers/store.ts";
import { createFakeClock } from "../../src/core/clock.ts";
import { isRunwrightError } from "../../src/core/errors.ts";
import type { TriggerRecord } from "../../src/store/types.ts";

const code = (c: string) => (e: unknown): boolean => isRunwrightError(e) && e.code === c;

test("triggers: insert, replace, list, delete", async (t) => {
  const { store } = await openTestStore(t);
  const cron: TriggerRecord = {
    id: "trg_1", name: "nightly", kind: "cron", agentId: "a", enabled: true,
    cron: { expression: "0 3 * * *", timeZone: "Europe/Berlin" }, webhook: null, message: "Run the report",
    limits: { maxCostMicros: 50_000, maxToolCalls: null, maxTurns: 10, allowUnpriced: false },
    lastFiredAt: null, nextFireAt: 123, createdAt: 1, updatedAt: 1,
  };
  const hook: TriggerRecord = { ...cron, id: "trg_2", name: "hook", kind: "webhook", cron: null, webhook: { secretName: "HOOK_SECRET" },
    nextFireAt: null, createdAt: 2, updatedAt: 2 };
  await store.saveTrigger(cron);
  await store.saveTrigger(hook);
  assert.deepEqual(await store.getTrigger("trg_1"), cron);
  assert.deepEqual(await store.getTrigger("trg_2"), hook);
  const updated = { ...cron, name: "nightly v2", enabled: false, nextFireAt: 900, updatedAt: 3 };
  await store.saveTrigger(updated);
  assert.deepEqual(await store.listTriggers(), [updated, hook]);
  assert.equal(await store.deleteTrigger("trg_1"), true);
  assert.equal(await store.deleteTrigger("trg_1"), false);
  assert.equal(await store.getTrigger("trg_1"), null);
});

function cronRecord(overrides?: Partial<TriggerRecord>): TriggerRecord {
  return {
    id: "trg_1", name: "nightly", kind: "cron", agentId: "a", enabled: true,
    cron: { expression: "0 3 * * *", timeZone: "Europe/Berlin" }, webhook: null, message: "Run the report",
    limits: { maxCostMicros: 50_000, maxToolCalls: null, maxTurns: 10, allowUnpriced: false },
    lastFiredAt: null, nextFireAt: 123, createdAt: 1, updatedAt: 1, ...overrides,
  };
}

test("saveTrigger on an existing row updates the definition but keeps lastFiredAt", async (t) => {
  const clock = createFakeClock(5_000);
  const { store } = await openTestStore(t, { clock });
  await store.saveAgent({ id: "a", definition: testAgentDefinition() });
  await store.saveTrigger(cronRecord({ lastFiredAt: 42 }));
  const stored = await store.getTrigger("trg_1");
  assert.equal(stored?.lastFiredAt, 42, "an insert stores lastFiredAt as given");
  assert.ok(stored !== null);
  const fired = await store.fireTrigger({
    trigger: stored, kind: "manual", idempotencyKey: "manual:trg_1:r1", firedAt: 4_000,
    run: { input: { message: stored.message, data: null }, limits: { maxCostMicros: 50_000 } },
  });
  assert.equal(fired.outcome, "started");
  const edited = cronRecord({ name: "renamed", message: "New text", enabled: false, nextFireAt: null, lastFiredAt: null, updatedAt: 9 });
  await store.saveTrigger(edited);
  assert.deepEqual(await store.getTrigger("trg_1"), { ...edited, lastFiredAt: 4_000 });
});

test("secrets store sealed bytes only", async (t) => {
  const clock = createFakeClock(1_000);
  const { store } = await openTestStore(t, { clock });
  const sealed = new Uint8Array([1, 0, 255, 7, 9]);
  assert.deepEqual(await store.putSecret("B_KEY", sealed), { updatedAt: 1_000 });
  clock.advance(10);
  await store.putSecret("A_KEY", new Uint8Array([2]));
  clock.advance(10);
  assert.deepEqual(await store.putSecret("B_KEY", new Uint8Array([3, 3])), { updatedAt: 1_020 });
  const got = await store.getSecret("B_KEY");
  assert.ok(got);
  assert.ok(got.sealed instanceof Uint8Array);
  assert.deepEqual([...got.sealed], [3, 3]);
  assert.equal(got.updatedAt, 1_020);
  assert.deepEqual(await store.listSecrets(), [{ name: "A_KEY", updatedAt: 1_010 }, { name: "B_KEY", updatedAt: 1_020 }]);
  assert.equal(await store.deleteSecret("A_KEY"), true);
  assert.equal(await store.deleteSecret("A_KEY"), false);
  assert.equal(await store.getSecret("A_KEY"), null);
});

test("runners: upsert, list, remove", async (t) => {
  const { store } = await openTestStore(t);
  const info = { id: "runner_b", pid: 42, hostname: "box", concurrency: 8, startedAt: 1, lastSeenAt: 2 };
  await store.upsertRunner(info);
  await store.upsertRunner({ ...info, id: "runner_a" });
  await store.upsertRunner({ ...info, lastSeenAt: 99 });
  assert.deepEqual(await store.listRunners(), [{ ...info, id: "runner_a" }, { ...info, lastSeenAt: 99 }]);
  await store.removeRunner("runner_a");
  await store.removeRunner("runner_none");
  assert.deepEqual((await store.listRunners()).map((r) => r.id), ["runner_b"]);
});

const conflict = (reason: string) => (e: unknown): boolean =>
  isRunwrightError(e) && e.code === "conflict" && e.details?.["reason"] === reason;

test("archiveJournal deletes a finished run's journal and marks it archived", async (t) => {
  const clock = createFakeClock(3_000);
  const { store } = await openTestStore(t, { clock });
  await store.saveAgent({ id: "a", definition: testAgentDefinition() });
  const { run } = await store.createRun({ agentId: "a", input: { message: "", data: null } });
  const whole = { path: "/a", records: 1, lastSeq: 1 };
  await assert.rejects(store.archiveJournal(run.id, whole), conflict("not_terminal"));
  const [claim] = await store.claimRuns({ runnerId: "r", limit: 1, leaseMs: 1000 });
  await assert.rejects(store.archiveJournal(run.id, whole), conflict("not_terminal"));
  await store.commit(claim!.lease, { records: [{ type: "x", data: {} }, { type: "run.completed", data: { output: null } }], transition: { to: "completed" } });
  clock.advance(5);
  assert.equal(await store.archiveJournal(run.id, { path: "/data/archive/2026-01/r.jsonl.gz", records: 3, lastSeq: 3 }), 3);
  assert.deepEqual(await store.readJournal(run.id), []);
  const after = await store.getRun(run.id);
  assert.equal(after?.journalArchivedAt, 3_005);
  assert.equal(after?.journalSeq, 3);
  await assert.rejects(store.archiveJournal("run_none", whole), code("not_found"));
});

test("archiveJournal refuses a second call and a journal that does not match, changing nothing", async (t) => {
  const clock = createFakeClock(3_000);
  const { store } = await openTestStore(t, { clock });
  await store.saveAgent({ id: "a", definition: testAgentDefinition() });
  const { run } = await store.createRun({ agentId: "a", input: { message: "", data: null } });
  const [claim] = await store.claimRuns({ runnerId: "r", limit: 1, leaseMs: 1000 });
  await store.commit(claim!.lease, { records: [{ type: "x", data: {} }, { type: "run.completed", data: {} }], transition: { to: "completed" } });
  const journal = await store.readJournal(run.id);
  const runBefore = await store.getRun(run.id);

  for (const wrong of [{ records: 2, lastSeq: 3 }, { records: 3, lastSeq: 2 }, { records: 4, lastSeq: 4 }, { records: 0, lastSeq: 0 }]) {
    await assert.rejects(store.archiveJournal(run.id, { path: "/a", ...wrong }), conflict("journal_changed"), JSON.stringify(wrong));
    assert.deepEqual(await store.readJournal(run.id), journal);
    assert.deepEqual(await store.getRun(run.id), runBefore);
  }

  clock.advance(5);
  assert.equal(await store.archiveJournal(run.id, { path: "/first", records: 3, lastSeq: 3 }), 3);
  const archived = await store.getRun(run.id);
  clock.advance(5);
  await assert.rejects(store.archiveJournal(run.id, { path: "/second", records: 3, lastSeq: 3 }), conflict("already_archived"));
  await assert.rejects(store.archiveJournal(run.id, { path: "/second", records: 0, lastSeq: 0 }), conflict("already_archived"));
  assert.deepEqual(await store.getRun(run.id), archived);
  assert.equal(archived?.journalArchivedAt, 3_005);
});

test("a closed store refuses work with store_error", async (t) => {
  const { store } = await openTestStore(t);
  await store.close();
  await store.close();
  await assert.rejects(store.listAgents(), code("store_error"));
  await assert.rejects(store.putSecret("X_KEY", new Uint8Array([1])), code("store_error"));
});

test("updateTrigger is a compare-and-set of the definition and never recreates a deleted trigger", async (t) => {
  const { store } = await openTestStore(t);
  await store.saveAgent({ id: "a", definition: testAgentDefinition() });
  const original = cronRecord();
  await store.saveTrigger(original);
  const fired = await store.fireTrigger({
    trigger: original, kind: "cron", idempotencyKey: "cron:trg_1:123", firedAt: 500,
    run: { input: { message: original.message, data: null }, limits: { maxCostMicros: 50_000 } }, cron: { slot: 123, nextFireAt: 600 },
  });
  assert.equal(fired.outcome, "started");
  const edited = cronRecord({ name: "nightly v2", enabled: false, nextFireAt: null, lastFiredAt: null, createdAt: 99, updatedAt: 7 });
  // Firing bookkeeping changed meanwhile, the definition did not: the update applies and keeps lastFiredAt.
  assert.equal(await store.updateTrigger(edited, original), "updated");
  assert.deepEqual(await store.getTrigger("trg_1"), { ...edited, lastFiredAt: 500, createdAt: 1 });

  // A second writer that read the original definition is refused, and the first change stays.
  const stale = cronRecord({ message: "a different job", updatedAt: 8 });
  assert.equal(await store.updateTrigger(stale, original), "changed");
  assert.equal((await store.getTrigger("trg_1"))?.name, "nightly v2");
  assert.equal((await store.getTrigger("trg_1"))?.message, "Run the report");

  assert.equal(await store.deleteTrigger("trg_1"), true);
  assert.equal(await store.updateTrigger(edited, edited), "missing");
  assert.equal(await store.getTrigger("trg_1"), null);
  assert.deepEqual(await store.listTriggers(), []);
});
