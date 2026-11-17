/**
 * Store.fireTrigger: one transaction that looks the key up, reads the stored trigger and creates the run only from
 * the definition that is stored (R08-01), moving a cron cursor only from the slot it consumes (R08-02); and
 * updateTrigger, which keeps the cursor of an unchanged schedule.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createFakeClock, type FakeClock } from "../../src/core/clock.ts";
import { isRunwrightError } from "../../src/core/errors.ts";
import { idempotencyDigest, requestFingerprint } from "../../src/store/idempotency.ts";
import type { Store, StoreEvent, TriggerFireInput, TriggerRecord } from "../../src/store/types.ts";
import { openTestStore, testAgentDefinition } from "../helpers/store.ts";

const START = Date.UTC(2026, 0, 1);
const minute = (n: number): number => START + n * 60_000;

interface Setup { store: Store; clock: FakeClock; dir: string }

async function setup(t: TestContext): Promise<Setup> {
  const clock = createFakeClock(START);
  const { store, dir } = await openTestStore(t, { clock });
  await store.saveAgent({ id: "agent-a", definition: testAgentDefinition({ limits: { maxToolCalls: 7 } }) });
  await store.saveAgent({ id: "agent-b", definition: testAgentDefinition({ name: "Other" }) });
  return { store, clock, dir };
}

function cronRecord(overrides?: Partial<TriggerRecord>): TriggerRecord {
  return {
    id: "trg_c", name: "every minute", kind: "cron", agentId: "agent-a", enabled: true,
    cron: { expression: "* * * * *", timeZone: "UTC" }, webhook: null, message: "tick",
    limits: { maxCostMicros: 1000, maxToolCalls: null, maxTurns: null, allowUnpriced: false },
    lastFiredAt: null, nextFireAt: minute(1), createdAt: START, updatedAt: START, ...overrides,
  };
}

function hookRecord(overrides?: Partial<TriggerRecord>): TriggerRecord {
  return cronRecord({ id: "trg_w", name: "hook", kind: "webhook", cron: null, webhook: { secretName: "HOOK" }, nextFireAt: null, ...overrides });
}

/** Saves `record` and returns it as stored. */
async function saved(store: Store, record: TriggerRecord): Promise<TriggerRecord> {
  await store.saveTrigger(record);
  const stored = await store.getTrigger(record.id);
  assert.ok(stored !== null);
  return stored;
}

function fire(trigger: TriggerRecord, overrides?: Partial<TriggerFireInput>): TriggerFireInput {
  return {
    trigger, kind: "manual", idempotencyKey: `manual:${trigger.id}:r-1`, firedAt: minute(1),
    run: { input: { message: trigger.message, data: { n: 1 } }, limits: { maxCostMicros: trigger.limits.maxCostMicros ?? 1 } },
    ...overrides,
  };
}

async function allRuns(store: Store) {
  return (await store.listRuns({}, { limit: 100 })).items;
}

/** Runs `act`, then asserts that no run exists and that the trigger (or its absence) is what it was before. */
async function writesNothing(s: Setup, id: string, act: () => Promise<unknown>): Promise<void> {
  const before = await s.store.getTrigger(id);
  const runs = await allRuns(s.store);
  s.clock.advance(1_000);
  await act();
  assert.deepEqual(await s.store.getTrigger(id), before);
  assert.deepEqual(await allRuns(s.store), runs);
}

test("started: the run is the trigger's, journalled and queued; only the firing columns change", async (t) => {
  const s = await setup(t);
  const { store, clock } = s;
  const trigger = await saved(store, cronRecord());
  const events: StoreEvent[] = [];
  const unsubscribe = store.subscribe((event) => events.push(event));
  clock.set(minute(3));
  const result = await store.fireTrigger(fire(trigger, { firedAt: minute(2) }));
  unsubscribe();
  assert.equal(result.outcome, "started");
  assert.ok(result.outcome === "started");
  const { run } = result;
  assert.equal(run.agentId, "agent-a");
  assert.deepEqual(run.input, { message: "tick", data: { n: 1 } });
  assert.deepEqual(run.limits, { maxCostMicros: 1000, maxToolCalls: 7, maxTurns: null, allowUnpriced: false }, "merged with the agent's limits");
  assert.deepEqual(run.trigger, { id: trigger.id, kind: "manual" });
  assert.equal(run.idempotencyKey, idempotencyDigest(`manual:${trigger.id}:r-1`));
  assert.equal(run.status, "queued");
  const journal = await store.readJournal(run.id);
  assert.equal(journal.length, 1);
  assert.equal(journal[0]?.type, "run.created");
  assert.deepEqual(journal[0]?.data["trigger"], { id: trigger.id, kind: "manual" });
  assert.deepEqual(events, [{ type: "run.queued", runId: run.id }]);
  assert.deepEqual(await store.getTrigger(trigger.id), { ...trigger, lastFiredAt: minute(2), updatedAt: minute(3) },
    "without cron the cursor is untouched and no definition column changes");

  const scheduled = await store.fireTrigger(fire(trigger, { kind: "cron", idempotencyKey: "cron:k-2", cron: { slot: minute(1), nextFireAt: minute(4) }, firedAt: minute(3) }));
  assert.equal(scheduled.outcome, "started");
  assert.deepEqual(await store.getTrigger(trigger.id), { ...trigger, lastFiredAt: minute(3), nextFireAt: minute(4), updatedAt: minute(3) });

  const moved = await store.getTrigger(trigger.id);
  assert.ok(moved !== null);
  const last = await store.fireTrigger(fire(moved, { kind: "cron", idempotencyKey: "cron:k-3", cron: { slot: minute(4), nextFireAt: null } }));
  assert.equal(last.outcome, "started");
  assert.equal((await store.getTrigger(trigger.id))?.nextFireAt, null, "a null next fire time is stored too");
});

test("the request hash is the given fingerprint, or computed from agent, input and limits as createRun does", async (t) => {
  const { store } = await setup(t);
  const trigger = await saved(store, hookRecord());
  const input = fire(trigger, { kind: "webhook" });
  const result = await store.fireTrigger(input);
  assert.equal(result.outcome, "started");
  const expected = requestFingerprint({ agentId: "agent-a", input: input.run!.input, limits: input.run!.limits });
  assert.equal(await store.findIdempotentRun({ idempotencyKey: input.idempotencyKey, requestFingerprint: expected }).then((r) => r?.id),
    result.outcome === "started" ? result.run.id : "", "the stored hash matches, so a strict lookup with it is no mismatch");
  const given = "a".repeat(64);
  const second = await store.fireTrigger(fire(trigger, { kind: "webhook", idempotencyKey: "k-given", run: { ...input.run!, requestFingerprint: given } }));
  assert.equal(second.outcome, "started");
  await assert.rejects(store.findIdempotentRun({ idempotencyKey: "k-given", requestFingerprint: expected }),
    (error: unknown) => isRunwrightError(error) && error.code === "idempotency_mismatch");
  await assert.rejects(store.fireTrigger(fire(trigger, { idempotencyKey: "k-bad", run: { ...input.run!, requestFingerprint: "nope" } })),
    (error: unknown) => isRunwrightError(error) && error.code === "validation_failed");
});

test("duplicate: a used key returns its run and writes nothing, whatever the trigger's state", async (t) => {
  const s = await setup(t);
  const { store } = s;
  const trigger = await saved(store, hookRecord());
  const first = await store.fireTrigger(fire(trigger, { kind: "webhook" }));
  assert.ok(first.outcome === "started");
  const same = async (record: TriggerRecord, data: unknown): Promise<void> => {
    await writesNothing(s, trigger.id, async () => {
      const again = await store.fireTrigger(fire(record, { kind: "webhook", run: { input: { message: "other", data: data as null }, limits: { maxCostMicros: 2 } } }));
      assert.equal(again.outcome, "duplicate");
      assert.equal(again.outcome === "duplicate" ? again.run.id : "", first.run.id);
    });
  };
  await same(trigger, { n: 2 });
  const live = await store.getTrigger(trigger.id);
  assert.ok(live !== null);
  assert.equal(await store.updateTrigger({ ...live, enabled: false }, live), "updated");
  await same(trigger, null);
  const off = await store.getTrigger(trigger.id);
  assert.ok(off !== null);
  assert.equal(await store.updateTrigger({ ...off, enabled: true, name: "edited", message: "new" }, off), "updated");
  await same(trigger, null);
  assert.equal(await store.deleteTrigger(trigger.id), true);
  await same(trigger, null);
  assert.deepEqual(await store.listTriggers(), []);
  assert.equal((await allRuns(store)).length, 1);
});

test("missing, disabled and changed write nothing; changed is any definition field, never the firing columns", async (t) => {
  const s = await setup(t);
  const { store } = s;
  const outcome = async (record: TriggerRecord, expected: string, extra?: Partial<TriggerFireInput>): Promise<void> => {
    await writesNothing(s, record.id, async () => {
      assert.equal((await store.fireTrigger(fire(record, { idempotencyKey: `k-${expected}-${Math.random()}`, ...extra }))).outcome, expected);
    });
  };
  await outcome(cronRecord({ id: "trg_none" }), "missing");

  const trigger = await saved(store, cronRecord());
  const variants: [string, Partial<TriggerRecord>][] = [
    ["name", { name: "renamed" }],
    ["agentId", { agentId: "agent-b" }],
    ["message", { message: "another job" }],
    ["maxCostMicros", { limits: { ...trigger.limits, maxCostMicros: 5 } }],
    ["maxToolCalls", { limits: { ...trigger.limits, maxToolCalls: 3 } }],
    ["maxTurns", { limits: { ...trigger.limits, maxTurns: 3 } }],
    ["allowUnpriced", { limits: { ...trigger.limits, allowUnpriced: true } }],
    ["cron expression", { cron: { expression: "*/5 * * * *", timeZone: "UTC" } }],
    ["time zone", { cron: { expression: "* * * * *", timeZone: "Europe/Berlin" } }],
    ["kind", { kind: "webhook", cron: null, webhook: { secretName: "HOOK" } }],
    ["enabled", { enabled: false }],
  ];
  for (const [label, change] of variants) {
    await writesNothing(s, trigger.id, async () => {
      const result = await store.fireTrigger(fire({ ...trigger, ...change }, { idempotencyKey: `k-${label}` }));
      assert.equal(result.outcome, "changed", label);
    });
  }
  const hook = await saved(store, hookRecord());
  await writesNothing(s, hook.id, async () => {
    assert.equal((await store.fireTrigger(fire({ ...hook, webhook: { secretName: "OTHER" } }, { kind: "webhook", idempotencyKey: "k-secret" }))).outcome, "changed");
  });

  // A record that differs only in its firing columns and timestamps fires.
  const bookkeeping = { ...trigger, lastFiredAt: 1, nextFireAt: 2, createdAt: 3, updatedAt: 4 };
  assert.equal((await store.fireTrigger(fire(bookkeeping, { idempotencyKey: "k-bookkeeping" }))).outcome, "started");

  const current = await store.getTrigger(trigger.id);
  assert.ok(current !== null);
  assert.equal(await store.updateTrigger({ ...current, enabled: false, nextFireAt: null }, current), "updated");
  await outcome(trigger, "disabled");
  await outcome({ ...trigger, name: "other", message: "other", limits: { ...trigger.limits, maxCostMicros: 1 } }, "disabled");
  await outcome({ ...trigger, enabled: false }, "disabled");
});

test("(R08-02) stale: a slot that is not the stored cursor starts nothing and leaves the cursor", async (t) => {
  const s = await setup(t);
  const { store } = s;
  const trigger = await saved(store, cronRecord());
  const slot = minute(1);
  const first = await store.fireTrigger(fire(trigger, { kind: "cron", idempotencyKey: `cron:${trigger.id}:${slot}`, cron: { slot, nextFireAt: minute(10) } }));
  assert.equal(first.outcome, "started");
  for (const later of [minute(5), minute(20)]) {
    await writesNothing(s, trigger.id, async () => {
      const result = await store.fireTrigger(fire(trigger, { kind: "cron", idempotencyKey: `cron:${trigger.id}:other-${later}`, cron: { slot, nextFireAt: later } }));
      assert.equal(result.outcome, "stale");
    });
    assert.equal((await store.getTrigger(trigger.id))?.nextFireAt, minute(10));
  }
  const hook = await saved(store, hookRecord());
  await writesNothing(s, hook.id, async () => {
    assert.equal((await store.fireTrigger(fire(hook, { kind: "webhook", cron: { slot: 0, nextFireAt: 1 } }))).outcome, "stale");
  });
});

test("(R08-02) the late writer of the same slot gets duplicate and leaves the cursor where the first one put it", async (t) => {
  const s = await setup(t);
  const { store } = s;
  const trigger = await saved(store, cronRecord());
  const key = `cron:${trigger.id}:${minute(1)}`;
  const b = await store.fireTrigger(fire(trigger, { kind: "cron", idempotencyKey: key, cron: { slot: minute(1), nextFireAt: minute(6) } }));
  assert.equal(b.outcome, "started");
  await writesNothing(s, trigger.id, async () => {
    const a = await store.fireTrigger(fire(trigger, { kind: "cron", idempotencyKey: key, cron: { slot: minute(1), nextFireAt: minute(3) } }));
    assert.equal(a.outcome, "duplicate");
  });
  assert.equal((await store.getTrigger(trigger.id))?.nextFireAt, minute(6));
});

test("a run for the slot whose cursor never moved is settled by the next fire of that slot", async (t) => {
  const s = await setup(t);
  const { store, clock } = s;
  const trigger = await saved(store, cronRecord());
  const key = `cron:${trigger.id}:${minute(1)}`;
  const legacy = await store.createRun({ agentId: "agent-a", input: { message: "tick", data: null }, idempotencyKey: key, trigger: { id: trigger.id, kind: "cron" } });
  assert.equal((await store.getTrigger(trigger.id))?.nextFireAt, minute(1), "createRun does not touch the trigger");
  clock.advance(500);
  const healed = await store.fireTrigger(fire(trigger, { kind: "cron", idempotencyKey: key, cron: { slot: minute(1), nextFireAt: minute(2) } }));
  assert.deepEqual([healed.outcome, healed.outcome === "duplicate" ? healed.run.id : ""], ["duplicate", legacy.run.id]);
  assert.deepEqual(await store.getTrigger(trigger.id), { ...trigger, nextFireAt: minute(2), updatedAt: START + 500 });
  await writesNothing(s, trigger.id, async () => {
    assert.equal((await store.fireTrigger(fire(trigger, { kind: "cron", idempotencyKey: key, cron: { slot: minute(1), nextFireAt: minute(2) } }))).outcome, "duplicate");
  });
  assert.equal((await allRuns(store)).length, 1);
});

test("agent_missing: no run; a scheduled fire consumes its slot, a manual one writes nothing", async (t) => {
  const s = await setup(t);
  const { store, clock } = s;
  const ghost = await saved(store, cronRecord({ agentId: "ghost", lastFiredAt: 77 }));
  await writesNothing(s, ghost.id, async () => {
    assert.equal((await store.fireTrigger(fire(ghost))).outcome, "agent_missing");
  });
  clock.set(minute(2));
  const result = await store.fireTrigger(fire(ghost, { kind: "cron", idempotencyKey: "cron:ghost", cron: { slot: minute(1), nextFireAt: minute(3) } }));
  assert.equal(result.outcome, "agent_missing");
  assert.deepEqual(await store.getTrigger(ghost.id), { ...ghost, nextFireAt: minute(3), updatedAt: minute(2) }, "lastFiredAt unchanged");
  assert.deepEqual(await allRuns(store), []);
});

test("lastFiredAt never moves backwards", async (t) => {
  const { store } = await setup(t);
  const trigger = await saved(store, hookRecord());
  assert.equal((await store.fireTrigger(fire(trigger, { idempotencyKey: "k-late", firedAt: 9_000 }))).outcome, "started");
  assert.equal((await store.fireTrigger(fire(trigger, { idempotencyKey: "k-early", firedAt: 4_000 }))).outcome, "started");
  assert.equal((await store.getTrigger(trigger.id))?.lastFiredAt, 9_000);
});

test("no_run: without a run, a fresh key writes nothing and a used key is duplicate", async (t) => {
  const s = await setup(t);
  const { store } = s;
  const trigger = await saved(store, cronRecord());
  const { run: _unused, ...withoutRun } = fire(trigger);
  await writesNothing(s, trigger.id, async () => {
    assert.equal((await store.fireTrigger({ ...withoutRun, idempotencyKey: "fresh", cron: { slot: minute(1), nextFireAt: minute(2) } })).outcome, "no_run");
  });
  const started = await store.fireTrigger(fire(trigger, { idempotencyKey: "used" }));
  assert.ok(started.outcome === "started");
  const again = await store.fireTrigger({ ...withoutRun, idempotencyKey: "used" });
  assert.deepEqual([again.outcome, again.outcome === "duplicate" ? again.run.id : ""], ["duplicate", started.run.id]);
});

test("a next fire time that is not later than the slot is refused before anything is written", async (t) => {
  const s = await setup(t);
  const { store } = s;
  const trigger = await saved(store, cronRecord());
  for (const nextFireAt of [minute(1), minute(0), Number.NaN]) {
    await writesNothing(s, trigger.id, async () => {
      await assert.rejects(store.fireTrigger(fire(trigger, { kind: "cron", cron: { slot: minute(1), nextFireAt } })),
        (error: unknown) => isRunwrightError(error) && error.code === "internal" && /later than the slot/.test(error.message));
    });
  }
});

test("two store handles firing one slot at once start one run and move the cursor forward once", async (t) => {
  const s = await setup(t);
  const { store: second } = await openTestStore(t, { clock: s.clock, dir: s.dir });
  const trigger = await saved(s.store, cronRecord());
  const key = `cron:${trigger.id}:${minute(1)}`;
  const results = await Promise.all([
    s.store.fireTrigger(fire(trigger, { kind: "cron", idempotencyKey: key, cron: { slot: minute(1), nextFireAt: minute(5) } })),
    second.fireTrigger(fire(trigger, { kind: "cron", idempotencyKey: key, cron: { slot: minute(1), nextFireAt: minute(6) } })),
  ]);
  const outcomes = results.map((r) => r.outcome);
  assert.equal(outcomes.filter((o) => o === "started").length, 1);
  assert.ok(outcomes.every((o) => o === "started" || o === "duplicate" || o === "stale"), outcomes.join());
  assert.equal((await allRuns(s.store)).length, 1);
  const cursor = (await second.getTrigger(trigger.id))?.nextFireAt;
  assert.ok(cursor === minute(5) || cursor === minute(6));
  assert.ok(cursor > minute(1));
});

test("a fire never inserts a trigger", async (t) => {
  const { store } = await setup(t);
  const trigger = await saved(store, cronRecord());
  const hook = await saved(store, hookRecord());
  await store.deleteTrigger(trigger.id);
  await store.deleteTrigger(hook.id);
  assert.equal((await store.fireTrigger(fire(trigger, { kind: "cron", cron: { slot: minute(1), nextFireAt: minute(2) } }))).outcome, "missing");
  assert.equal((await store.fireTrigger(fire(trigger, { idempotencyKey: "k-manual" }))).outcome, "missing");
  assert.equal((await store.fireTrigger(fire(hook, { kind: "webhook", idempotencyKey: "k-hook" }))).outcome, "missing");
  assert.deepEqual(await store.listTriggers(), []);
});

test("updateTrigger keeps the stored cursor of an unchanged schedule and writes it when the schedule or enabled changes", async (t) => {
  const { store } = await setup(t);
  // (a) A rename while a fire is due keeps the due cursor.
  const due = await saved(store, cronRecord({ nextFireAt: minute(5) }));
  assert.equal(await store.updateTrigger({ ...due, name: "renamed", nextFireAt: minute(10) }, due), "updated");
  assert.equal((await store.getTrigger(due.id))?.nextFireAt, minute(5));
  assert.equal((await store.getTrigger(due.id))?.name, "renamed");

  // (b) A fire moved the cursor between the caller's read and its update: the moved cursor stays.
  const read = await saved(store, cronRecord({ nextFireAt: minute(1) }));
  assert.equal((await store.fireTrigger(fire(read, { kind: "cron", idempotencyKey: "k-b", cron: { slot: minute(1), nextFireAt: minute(2) } }))).outcome, "started");
  assert.equal(await store.updateTrigger({ ...read, message: "new text", nextFireAt: minute(7) }, read), "updated");
  assert.equal((await store.getTrigger(read.id))?.nextFireAt, minute(2));

  // (c) A changed expression, a changed time zone, disabling and enabling store the caller's cursor.
  const changes: [string, Partial<TriggerRecord>, Partial<TriggerRecord>, number | null][] = [
    ["expression", {}, { cron: { expression: "*/5 * * * *", timeZone: "UTC" }, nextFireAt: minute(9) }, minute(9)],
    ["time zone", {}, { cron: { expression: "* * * * *", timeZone: "Europe/Berlin" }, nextFireAt: minute(8) }, minute(8)],
    ["disable", {}, { enabled: false, nextFireAt: null }, null],
    ["enable", { enabled: false, nextFireAt: minute(3) }, { enabled: true, nextFireAt: minute(9) }, minute(9)],
    // (d) A stored cursor of null is replaced.
    ["null cursor", { nextFireAt: null }, { name: "named", nextFireAt: minute(4) }, minute(4)],
  ];
  for (const [label, stored, change, expected] of changes) {
    const current = await saved(store, cronRecord({ nextFireAt: minute(5), ...stored }));
    assert.equal(await store.updateTrigger({ ...current, ...change }, current), "updated", label);
    assert.equal((await store.getTrigger(current.id))?.nextFireAt, expected, label);
  }
});
