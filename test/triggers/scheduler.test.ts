import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createFakeClock, type FakeClock } from "../../src/core/clock.ts";
import { RunwrightError } from "../../src/core/errors.ts";
import { createIdSource } from "../../src/core/ids.ts";
import { createLogger } from "../../src/log/logger.ts";
import type { Store, TriggerFireInput, TriggerFireResult, TriggerRecord } from "../../src/store/types.ts";
import { idempotencyDigest } from "../../src/store/idempotency.ts";
import { createTriggerScheduler } from "../../src/triggers/scheduler.ts";
import { buildTrigger, fireTrigger } from "../../src/triggers/service.ts";
import { openTestStore, testAgentDefinition } from "../helpers/store.ts";
import { waitFor } from "../helpers/wait.ts";

const START = Date.parse("2026-01-01T00:00:00Z");
const CAP = 250_000;

async function setup(t: TestContext): Promise<{ store: Store; clock: FakeClock; agentId: string; dir: string; lines: string[] }> {
  const clock = createFakeClock(START);
  const { store, dir } = await openTestStore(t, { clock });
  const { agent } = await store.saveAgent({ definition: testAgentDefinition({ limits: { maxToolCalls: 7 } }) });
  return { store, clock, agentId: agent.id, dir, lines: [] };
}

function cronTrigger(agentId: string, clock: FakeClock, overrides?: Record<string, unknown>): TriggerRecord {
  return buildTrigger(
    { name: "every five", kind: "cron", agentId, message: "tick", cron: { expression: "*/5 * * * *" }, limits: { maxCostMicros: CAP }, ...overrides },
    { ids: createIdSource({ clock }), clock },
  );
}

function scheduler(store: Store, clock: FakeClock, lines: string[], tickMs = 1000) {
  return createTriggerScheduler({ store, clock, tickMs, logger: createLogger({ level: "debug", clock, write: (line) => lines.push(line) }) });
}

async function runsOf(store: Store, triggerId: string) {
  return (await store.listRuns({ triggerId }, { limit: 100 })).items;
}

test("buildTrigger validates everything at once and computes the next fire time", () => {
  const clock = createFakeClock(START);
  const ids = createIdSource({ clock });
  assert.throws(() => buildTrigger({ kind: "cron", name: "", limits: { maxCostMicros: 0, extra: 1 }, cron: { expression: "61 * * * *" }, junk: 1 }, { ids, clock }),
    (error: unknown) => {
      assert.ok(error instanceof RunwrightError);
      assert.equal(error.code, "validation_failed");
      const paths = (error.details?.["problems"] as { path: string }[]).map((p) => p.path).sort();
      assert.deepEqual(paths, ["$.agentId", "$.cron.expression", "$.junk", "$.limits.extra", "$.limits.maxCostMicros", "$.message", "$.name"]);
      return true;
    });
  assert.throws(() => buildTrigger({ name: "w", kind: "webhook", agentId: "a", message: "", limits: { maxCostMicros: 5 } }, { ids, clock }),
    (error: unknown) => error instanceof RunwrightError && /\$\.webhook/.test(error.message));
  assert.throws(() => buildTrigger({ name: "c", kind: "cron", agentId: "a", message: "", limits: {}, cron: { expression: "* * * * *", timeZone: "Nowhere/Land" } }, { ids, clock }),
    (error: unknown) => error instanceof RunwrightError && /maxCostMicros/.test(error.message) && /time zone/.test(error.message));
  assert.throws(() => buildTrigger("nope", { ids, clock }), (error: unknown) => error instanceof RunwrightError && error.code === "validation_failed");

  const trigger = cronTrigger("agent-1", clock);
  assert.equal(trigger.enabled, true);
  assert.deepEqual(trigger.cron, { expression: "*/5 * * * *", timeZone: "UTC" });
  assert.equal(trigger.nextFireAt, START + 5 * 60_000);
  assert.deepEqual(trigger.limits, { maxCostMicros: CAP, maxToolCalls: null, maxTurns: null, allowUnpriced: false });
  assert.equal(trigger.lastFiredAt, null);

  const webhook = buildTrigger({ name: "hook", kind: "webhook", agentId: "a", message: "go", webhook: { secretName: "HOOK_SECRET" }, limits: { maxCostMicros: 9, maxTurns: 3 } }, { ids, clock });
  assert.equal(webhook.nextFireAt, null);
  assert.equal(webhook.limits.maxTurns, 3);

  clock.advance(60_000);
  const updated = buildTrigger({ name: "renamed", kind: "cron", agentId: "agent-1", message: "tick", enabled: false, cron: { expression: "0 * * * *" }, limits: { maxCostMicros: CAP } },
    { ids, clock, existing: { ...trigger, lastFiredAt: 123 } });
  assert.equal(updated.id, trigger.id);
  assert.equal(updated.createdAt, trigger.createdAt);
  assert.equal(updated.updatedAt, START + 60_000);
  assert.equal(updated.lastFiredAt, 123);
  assert.equal(updated.enabled, false);
  assert.equal(updated.nextFireAt, null);
});

test("a due cron trigger starts one run with the trigger's cap and moves to its next fire time", async (t) => {
  const { store, clock, agentId, lines } = await setup(t);
  const trigger = cronTrigger(agentId, clock);
  await store.saveTrigger(trigger);
  const s = scheduler(store, clock, lines);

  clock.set(START + 4 * 60_000);
  assert.equal(await s.tick(), 0);
  clock.set(START + 5 * 60_000);
  assert.equal(await s.tick(), 1);
  assert.equal(await s.tick(), 0);

  const [run] = await runsOf(store, trigger.id);
  assert.ok(run !== undefined);
  assert.deepEqual(run.input, { message: "tick", data: { scheduledFor: "2026-01-01T00:05:00.000Z", missedFires: 0, missedFiresCapped: false } });
  assert.equal(run.limits.maxCostMicros, CAP);
  assert.equal(run.limits.maxToolCalls, 7, "the agent's own limits still apply where the trigger sets none");
  assert.deepEqual(run.trigger, { id: trigger.id, kind: "cron" });
  assert.equal(run.idempotencyKey, idempotencyDigest(`cron:${trigger.id}:${START + 5 * 60_000}`));

  const saved = await store.getTrigger(trigger.id);
  assert.equal(saved?.nextFireAt, START + 10 * 60_000);
  assert.equal(saved?.lastFiredAt, START + 5 * 60_000);
});

test("a downtime covering many fire times starts exactly one run and reports the missed fires", async (t) => {
  const { store, clock, agentId, lines } = await setup(t);
  const trigger = cronTrigger(agentId, clock);
  await store.saveTrigger(trigger);
  const s = scheduler(store, clock, lines);

  clock.set(Date.parse("2026-01-01T03:07:30Z"));
  assert.equal(await s.tick(), 1);
  assert.equal(await s.tick(), 0);
  const runs = await runsOf(store, trigger.id);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0]?.input.data, { scheduledFor: "2026-01-01T00:05:00.000Z", missedFires: 36, missedFiresCapped: false });
  assert.equal((await store.getTrigger(trigger.id))?.nextFireAt, Date.parse("2026-01-01T03:10:00Z"));
});

test("two schedulers on two store handles ticking at the same instant start one run", async (t) => {
  const { store, clock, agentId, dir, lines } = await setup(t);
  const { store: second } = await openTestStore(t, { clock, dir });
  const trigger = cronTrigger(agentId, clock);
  await store.saveTrigger(trigger);
  clock.set(START + 5 * 60_000);
  const results = await Promise.all([scheduler(store, clock, lines).tick(), scheduler(second, clock, lines).tick()]);
  assert.equal(results[0] + results[1], 1);
  assert.equal((await runsOf(store, trigger.id)).length, 1);
});

test("(pins) one cron slot fired twice starts one run, its key stored as the digest", async (t) => {
  const { store, clock, agentId, lines } = await setup(t);
  const trigger = cronTrigger(agentId, clock);
  await store.saveTrigger(trigger);
  const slot = START + 5 * 60_000;
  clock.set(slot);
  assert.equal(await scheduler(store, clock, lines).tick(), 1);
  const [run] = await runsOf(store, trigger.id);
  assert.ok(run !== undefined);
  const refire = await fireTrigger({ store, clock }, trigger, {
    dedupeKey: `cron:${trigger.id}:${slot}`, kind: "cron", data: { scheduledFor: new Date(slot).toISOString(), missedFires: 1 },
  });
  assert.deepEqual([refire.created, refire.run.id], [false, run.id]);
  assert.equal(refire.run.idempotencyKey, idempotencyDigest(`cron:${trigger.id}:${slot}`));
  assert.equal((await runsOf(store, trigger.id)).length, 1);
});

test("disabled triggers never fire, and fireTrigger refuses them", async (t) => {
  const { store, clock, agentId, lines } = await setup(t);
  const trigger = { ...cronTrigger(agentId, clock), enabled: false, nextFireAt: START + 5 * 60_000 };
  await store.saveTrigger(trigger);
  clock.set(START + 24 * 3_600_000);
  assert.equal(await scheduler(store, clock, lines).tick(), 0);
  assert.equal((await runsOf(store, trigger.id)).length, 0);
  await assert.rejects(fireTrigger({ store, clock }, trigger, { dedupeKey: "manual:1", kind: "manual", data: null }),
    (error: unknown) => error instanceof RunwrightError && error.code === "trigger_disabled");
});

test("fireTrigger twice with one dedupe key returns the same run", async (t) => {
  const { store, clock, agentId } = await setup(t);
  const trigger = buildTrigger({ name: "hook", kind: "webhook", agentId, message: "delivered", webhook: { secretName: "HOOK" }, limits: { maxCostMicros: CAP } },
    { ids: createIdSource({ clock }), clock });
  await store.saveTrigger(trigger);
  clock.advance(1000);
  const first = await fireTrigger({ store, clock }, trigger, { dedupeKey: `webhook:${trigger.id}:d-1`, kind: "webhook", data: { a: 1 } });
  const again = await fireTrigger({ store, clock }, trigger, { dedupeKey: `webhook:${trigger.id}:d-1`, kind: "webhook", data: { a: 2 } });
  assert.equal(first.created, true);
  assert.equal(again.created, false);
  assert.equal(again.run.id, first.run.id);
  assert.deepEqual(first.run.input, { message: "delivered", data: { a: 1 } });
  assert.equal(first.run.limits.maxCostMicros, CAP);
  assert.equal((await store.getTrigger(trigger.id))?.lastFiredAt, START + 1000);
  const other = await fireTrigger({ store, clock }, trigger, { dedupeKey: `webhook:${trigger.id}:d-2`, kind: "webhook", data: null });
  assert.notEqual(other.run.id, first.run.id);
});

test("a trigger whose agent is gone is logged and skipped without throwing", async (t) => {
  const { store, clock, agentId, lines } = await setup(t);
  const ghost = cronTrigger("ghost-agent", clock, { name: "ghost" });
  const real = cronTrigger(agentId, clock);
  await store.saveTrigger(ghost);
  await store.saveTrigger(real);
  clock.set(START + 5 * 60_000);
  assert.equal(await scheduler(store, clock, lines).tick(), 1);
  assert.ok(lines.some((line) => line.includes("ghost-agent") && line.includes('"level":"warn"')));
  assert.equal((await store.getTrigger(ghost.id))?.nextFireAt, START + 10 * 60_000);
});

test("start runs ticks on a timer and stop waits for the tick in progress", async (t) => {
  const { store, clock, agentId, lines } = await setup(t);
  const trigger = cronTrigger(agentId, clock);
  await store.saveTrigger(trigger);
  clock.set(START + 5 * 60_000);
  const s = scheduler(store, clock, lines, 10);
  s.start();
  s.start();
  t.after(() => s.stop());
  await waitFor(async () => (await runsOf(store, trigger.id)).length === 1);
  clock.set(START + 10 * 60_000);
  await waitFor(async () => (await runsOf(store, trigger.id)).length === 2);
  await s.stop();
  clock.set(START + 60 * 60_000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await runsOf(store, trigger.id)).length, 2);
});

test("a tickMs longer than one timer can hold waits between ticks instead of ticking every millisecond", async (t) => {
  const { store, clock, agentId, lines } = await setup(t);
  const trigger = cronTrigger(agentId, clock);
  await store.saveTrigger(trigger);
  clock.set(START + 5 * 60_000);
  const warnings: string[] = [];
  const onWarning = (warning: Error): void => {
    warnings.push(warning.name);
  };
  process.on("warning", onWarning);
  t.after(() => process.off("warning", onWarning));
  const s = scheduler(store, clock, lines, 3_000_000_000);
  s.start();
  t.after(() => s.stop());
  await waitFor(async () => (await store.getTrigger(trigger.id))?.nextFireAt === START + 10 * 60_000);
  assert.equal((await runsOf(store, trigger.id)).length, 1, "the first tick runs at start");
  clock.set(START + 10 * 60_000);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((await runsOf(store, trigger.id)).length, 1, "no second tick within 200 ms");
  assert.equal((await store.getTrigger(trigger.id))?.nextFireAt, START + 10 * 60_000);
  assert.deepEqual(warnings.filter((name) => name === "TimeoutOverflowWarning"), []);
});

type Interference = "disable" | "delete";
type Moment = "before the fire" | "after the fire";

/**
 * A view of `store` on which a person changes the trigger once, around its fire: right before the store's
 * fireTrigger runs (after the caller read the trigger), or right after it returns. The change goes through the
 * underlying store, as the API would make it.
 */
function interfering(store: Store, triggerId: string, change: Interference, moment: Moment): Store {
  const interfere = async (): Promise<void> => {
    if (change === "delete") {
      await store.deleteTrigger(triggerId);
      return;
    }
    const current = await store.getTrigger(triggerId);
    assert.ok(current !== null);
    await store.saveTrigger({ ...current, enabled: false, nextFireAt: null });
  };
  return fireView(store, async (fire) => {
    if (moment === "before the fire") await interfere();
    const result = await fire();
    if (moment === "after the fire") await interfere();
    return result;
  });
}

/** A view of `store` whose fireTrigger is `around(the real call)`, once; every other member is the store's. */
function fireView(store: Store, around: (fire: () => Promise<TriggerFireResult>) => Promise<TriggerFireResult>): Store {
  let used = false;
  return new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      if (property === "fireTrigger") {
        return async (input: TriggerFireInput) => {
          if (used) return target.fireTrigger(input);
          used = true;
          return around(() => target.fireTrigger(input));
        };
      }
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  });
}

const isCode = (expected: string) => (error: unknown): boolean => error instanceof RunwrightError && error.code === expected;

for (const moment of ["before the fire", "after the fire"] as const) {
  const fires = moment === "after the fire";

  test(`a cron trigger disabled while it fires (${moment}) stays disabled with no next fire time`, async (t) => {
    const { store, clock, agentId, lines } = await setup(t);
    const trigger = cronTrigger(agentId, clock);
    await store.saveTrigger(trigger);
    clock.set(START + 5 * 60_000);
    assert.equal(await scheduler(interfering(store, trigger.id, "disable", moment), clock, lines).tick(), fires ? 1 : 0);
    assert.equal((await runsOf(store, trigger.id)).length, fires ? 1 : 0);
    const saved = await store.getTrigger(trigger.id);
    assert.equal(saved?.enabled, false);
    assert.equal(saved?.nextFireAt, null);
    clock.set(START + 60 * 60_000);
    assert.equal(await scheduler(store, clock, lines).tick(), 0, "a disabled trigger does not fire again");
    assert.ok(!lines.some((line) => line.includes('"level":"error"')));
  });

  test(`a cron trigger deleted while it fires (${moment}) stays deleted`, async (t) => {
    const { store, clock, agentId, lines } = await setup(t);
    const trigger = cronTrigger(agentId, clock);
    await store.saveTrigger(trigger);
    clock.set(START + 5 * 60_000);
    assert.equal(await scheduler(interfering(store, trigger.id, "delete", moment), clock, lines).tick(), fires ? 1 : 0);
    assert.equal((await runsOf(store, trigger.id)).length, fires ? 1 : 0);
    assert.equal(await store.getTrigger(trigger.id), null);
    assert.deepEqual(await store.listTriggers(), []);
  });

  test(`a manual fire of a trigger disabled (${moment}) keeps it disabled`, async (t) => {
    const { store, clock, agentId } = await setup(t);
    const trigger = cronTrigger(agentId, clock);
    await store.saveTrigger(trigger);
    clock.advance(1000);
    const firing = fireTrigger({ store: interfering(store, trigger.id, "disable", moment), clock }, trigger,
      { dedupeKey: "manual:x", kind: "manual", data: null });
    if (fires) assert.equal((await firing).created, true);
    else await assert.rejects(firing, isCode("trigger_disabled"));
    assert.equal((await runsOf(store, trigger.id)).length, fires ? 1 : 0);
    const saved = await store.getTrigger(trigger.id);
    assert.equal(saved?.enabled, false);
    assert.equal(saved?.nextFireAt, null);
  });

  test(`a manual fire of a trigger deleted (${moment}) does not recreate it`, async (t) => {
    const { store, clock, agentId } = await setup(t);
    const trigger = cronTrigger(agentId, clock);
    await store.saveTrigger(trigger);
    const firing = fireTrigger({ store: interfering(store, trigger.id, "delete", moment), clock }, trigger,
      { dedupeKey: "manual:y", kind: "manual", data: null });
    if (fires) assert.equal((await firing).created, true);
    else await assert.rejects(firing, (error: unknown) => isCode("not_found")(error) && (error as Error).message === `trigger ${trigger.id} not found`);
    assert.equal((await runsOf(store, trigger.id)).length, fires ? 1 : 0);
    assert.equal(await store.getTrigger(trigger.id), null);
  });

  test(`a cron trigger whose schedule is edited while it fires (${moment}) keeps the person's next fire time`, async (t) => {
    const { store, clock, agentId, lines } = await setup(t);
    const trigger = cronTrigger(agentId, clock);
    await store.saveTrigger(trigger);
    clock.set(START + 5 * 60_000);
    const hourly = buildTrigger({ name: "hourly", kind: "cron", agentId, message: "tick", cron: { expression: "0 * * * *" }, limits: { maxCostMicros: CAP } },
      { ids: createIdSource({ clock }), clock, existing: trigger });
    const view = fireView(store, async (fire) => {
      if (!fires) await store.saveTrigger(hourly);
      const result = await fire();
      if (fires) await store.saveTrigger(hourly);
      return result;
    });
    assert.equal(await scheduler(view, clock, lines).tick(), fires ? 1 : 0);
    assert.equal((await runsOf(store, trigger.id)).length, fires ? 1 : 0);
    const saved = await store.getTrigger(trigger.id);
    assert.deepEqual(saved?.cron, { expression: "0 * * * *", timeZone: "UTC" });
    assert.equal(saved?.nextFireAt, START + 60 * 60_000);
    assert.equal(saved?.name, "hourly");
    assert.equal(saved?.lastFiredAt, fires ? START + 5 * 60_000 : null, "only a fire that started a run sets lastFiredAt");
    if (!fires) assert.ok(lines.some((line) => line.includes('"msg":"trigger fire skipped"') && line.includes('"outcome":"changed"')));
  });
}

type PersonChange = "disable" | "delete" | "lower the cap";

/**
 * (R08-01) A store whose listTriggers answers with the rows and then, once, lets a person change the trigger
 * through the real store before the scheduler goes on with what it read.
 */
function changedAfterList(store: Store, triggerId: string, change: PersonChange): Store {
  let done = false;
  return new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      if (property === "listTriggers") {
        return async () => {
          const rows = await target.listTriggers();
          if (done) return rows;
          done = true;
          const current = await target.getTrigger(triggerId);
          assert.ok(current !== null);
          if (change === "delete") await target.deleteTrigger(triggerId);
          else if (change === "disable") assert.equal(await target.updateTrigger({ ...current, enabled: false, nextFireAt: null }, current), "updated");
          else assert.equal(await target.updateTrigger({ ...current, limits: { ...current.limits, maxCostMicros: 5 } }, current), "updated");
          return rows;
        };
      }
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  });
}

for (const change of ["disable", "delete", "lower the cap"] as const) {
  test(`(R08-01) a trigger changed right after the scheduler read it (${change}) starts no run from the old record`, async (t) => {
    const { store, clock, agentId, lines } = await setup(t);
    const trigger = cronTrigger(agentId, clock);
    await store.saveTrigger(trigger);
    clock.set(START + 5 * 60_000);
    const s = scheduler(changedAfterList(store, trigger.id, change), clock, lines);
    assert.equal(await s.tick(), 0);
    assert.deepEqual(await runsOf(store, trigger.id), []);
    const saved = await store.getTrigger(trigger.id);
    if (change === "delete") assert.equal(saved, null);
    else if (change === "disable") {
      assert.equal(saved?.enabled, false);
      assert.equal(saved?.nextFireAt, null);
    } else {
      assert.equal(saved?.limits.maxCostMicros, 5);
      assert.equal(saved?.nextFireAt, START + 5 * 60_000, "the edit kept the due cursor");
    }
    assert.ok(!lines.some((line) => line.includes('"level":"error"')), "a skipped fire is not an error");
    const outcome = change === "delete" ? "missing" : change === "disable" ? "disabled" : "changed";
    assert.ok(lines.some((line) => line.includes('"level":"debug"') && line.includes('"msg":"trigger fire skipped"') && line.includes(`"outcome":"${outcome}"`)));

    assert.equal(await s.tick(), change === "lower the cap" ? 1 : 0, "the following tick reads the trigger again");
    const runs = await runsOf(store, trigger.id);
    if (change === "lower the cap") {
      assert.equal(runs.length, 1);
      assert.equal(runs[0]?.limits.maxCostMicros, 5, "the run carries the cap stored when it was created");
      assert.equal((await store.getTrigger(trigger.id))?.nextFireAt, START + 10 * 60_000);
    } else {
      assert.deepEqual(runs, []);
    }
  });
}

/** One minute after START. */
const minute = (n: number): number => START + n * 60_000;

async function everyMinute(t: TestContext): Promise<{ a: Store; b: Store; clockA: FakeClock; clockB: FakeClock; trigger: TriggerRecord; lines: string[] }> {
  const clockA = createFakeClock(START);
  const clockB = createFakeClock(START);
  const { store: a, dir } = await openTestStore(t, { clock: clockA });
  const { store: b } = await openTestStore(t, { clock: clockB, dir });
  const { agent } = await a.saveAgent({ definition: testAgentDefinition() });
  const trigger = cronTrigger(agent.id, clockA, { cron: { expression: "* * * * *" } });
  assert.equal(trigger.nextFireAt, minute(1));
  await a.saveTrigger(trigger);
  return { a, b, clockA, clockB, trigger, lines: [] };
}

test("(R08-02) a late scheduler that commits last does not move the cursor back or start a second run", async (t) => {
  const { a, b, clockA, clockB, trigger, lines } = await everyMinute(t);
  let reached: () => void = () => {};
  const atGate = new Promise<void>((resolve) => { reached = resolve; });
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const gated = fireView(a, async (fire) => {
    reached();
    await gate;
    return fire();
  });
  clockA.set(minute(2));
  const late = scheduler(gated, clockA, lines).tick();
  await atGate;
  clockB.set(minute(5));
  const sb = scheduler(b, clockB, lines);
  assert.equal(await sb.tick(), 1);
  assert.equal((await b.getTrigger(trigger.id))?.nextFireAt, minute(6));
  open();
  assert.equal(await late, 0, "the late scheduler finds its slot consumed");
  assert.equal((await b.getTrigger(trigger.id))?.nextFireAt, minute(6), "the cursor did not move back to minute 3");
  assert.equal((await runsOf(b, trigger.id)).length, 1);
  assert.equal(await sb.tick(), 0, "no second run for the fire times already coalesced");
  assert.equal((await runsOf(b, trigger.id)).length, 1);
  assert.ok(!lines.some((line) => line.includes('"level":"error"')));
});

test("(R08-02) a scheduler that read before another one fired finds the slot used and fires the next one once", async (t) => {
  const { a, b, clockA, clockB, trigger, lines } = await everyMinute(t);
  const early = await b.listTriggers();
  let replayed = false;
  const stale = new Proxy(b, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      if (property === "listTriggers") {
        return async () => {
          if (replayed) return target.listTriggers();
          replayed = true;
          return early;
        };
      }
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  });
  clockA.set(minute(2));
  assert.equal(await scheduler(a, clockA, lines).tick(), 1);
  assert.equal((await a.getTrigger(trigger.id))?.nextFireAt, minute(3));
  clockB.set(minute(5));
  const sb = scheduler(stale, clockB, lines);
  assert.equal(await sb.tick(), 0, "the slot of minute 1 already has its run");
  assert.equal((await a.getTrigger(trigger.id))?.nextFireAt, minute(3));
  assert.ok(lines.some((line) => line.includes('"msg":"trigger fire skipped"') && line.includes('"outcome":"duplicate"')));
  assert.equal(await sb.tick(), 1);
  const runs = await runsOf(a, trigger.id);
  assert.equal(runs.length, 2);
  const newest = runs.find((run) => (run.input.data as { scheduledFor: string }).scheduledFor === new Date(minute(3)).toISOString());
  assert.deepEqual(newest?.input.data, { scheduledFor: new Date(minute(3)).toISOString(), missedFires: 2, missedFiresCapped: false });
  assert.equal((await a.getTrigger(trigger.id))?.nextFireAt, minute(6));
});

test("(R04-04) a stepped day-of-month trigger counts only its own days as missed fires", async (t) => {
  const { store, clock, agentId, lines } = await setup(t);
  const trigger = { ...cronTrigger(agentId, clock, { cron: { expression: "0 0 */2 * *" } }), nextFireAt: Date.parse("2026-11-03T00:00:00Z") };
  await store.saveTrigger(trigger);
  clock.set(Date.parse("2026-11-08T12:00:00Z"));
  const s = scheduler(store, clock, lines);
  assert.equal(await s.tick(), 1);
  assert.equal(await s.tick(), 0);
  const runs = await runsOf(store, trigger.id);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0]?.input.data, { scheduledFor: "2026-11-03T00:00:00.000Z", missedFires: 2, missedFiresCapped: false }, "5 and 7 November");
  assert.equal((await store.getTrigger(trigger.id))?.nextFireAt, Date.parse("2026-11-09T00:00:00Z"));
});

test("(R04-04) a stepped day-of-month trigger created on any day stores its next odd day", () => {
  const clock = createFakeClock(Date.parse("2026-11-02T00:30:00Z"));
  const onEvenDay = cronTrigger("agent-1", clock, { cron: { expression: "0 0 */2 * *" } });
  assert.equal(onEvenDay.nextFireAt, Date.parse("2026-11-03T00:00:00Z"));
  clock.set(Date.parse("2026-11-03T00:30:00Z"));
  const afterOddFire = cronTrigger("agent-1", clock, { cron: { expression: "0 0 */2 * *" } });
  assert.equal(afterOddFire.nextFireAt, Date.parse("2026-11-05T00:00:00Z"));
  clock.set(Date.parse("2026-10-31T00:30:00Z"));
  const monthEnd = cronTrigger("agent-1", clock, { cron: { expression: "0 0 */2 * *" } });
  assert.equal(monthEnd.nextFireAt, Date.parse("2026-11-01T00:00:00Z"), "the step restarts at 1 each month");
});

test("the missed-fire count says when it stopped at its bound", async (t) => {
  for (const [due, missedFires, missedFiresCapped] of [[1441, 999, true], [5, 4, false], [1000, 999, true], [999, 998, false]] as const) {
    const { store, clock, agentId, lines } = await setup(t);
    const trigger = cronTrigger(agentId, clock, { name: "every minute", cron: { expression: "* * * * *" } });
    await store.saveTrigger(trigger);
    assert.equal(trigger.nextFireAt, START + 60_000);
    clock.set(START + due * 60_000);
    assert.equal(await scheduler(store, clock, lines).tick(), 1);
    const runs = await runsOf(store, trigger.id);
    assert.equal(runs.length, 1, `${due} due`);
    assert.deepEqual(runs[0]?.input.data, { scheduledFor: new Date(START + 60_000).toISOString(), missedFires, missedFiresCapped }, `${due} due`);
    const fired = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((record) => record["msg"] === "trigger fired");
    assert.ok(fired !== undefined, lines.join("\n"));
    assert.deepEqual([fired["missedFires"], fired["missedFiresCapped"]], [missedFires, missedFiresCapped]);
  }
});

test("(R14D-tools-02) a trigger whose next fire is eleven years away keeps it and fires again then", async (t) => {
  const { store, clock, agentId, lines } = await setup(t);
  clock.set(Date.parse("2026-11-16T00:00:00Z"));
  const trigger = cronTrigger(agentId, clock, { cron: { expression: "0 0 */30 2 1" } });
  assert.equal(trigger.nextFireAt, Date.parse("2027-02-01T00:00:00Z"));
  await store.saveTrigger(trigger);
  const s = scheduler(store, clock, lines);
  clock.set(Date.parse("2027-02-01T00:00:30Z"));
  assert.equal(await s.tick(), 1);
  assert.equal((await store.getTrigger(trigger.id))?.nextFireAt, Date.parse("2038-02-01T00:00:00Z"), "not null: the schedule still fires");
  clock.set(Date.parse("2037-12-31T00:00:00Z"));
  assert.equal(await s.tick(), 0);
  clock.set(Date.parse("2038-02-01T00:01:00Z"));
  assert.equal(await s.tick(), 1);
  const runs = await runsOf(store, trigger.id);
  assert.deepEqual(runs.map((run) => (run.input.data as { scheduledFor: string }).scheduledFor).sort(), ["2027-02-01T00:00:00.000Z", "2038-02-01T00:00:00.000Z"]);
  let after = 2039;
  while (new Date(Date.UTC(after, 1, 1)).getUTCDay() !== 1) after++;
  assert.equal((await store.getTrigger(trigger.id))?.nextFireAt, Date.UTC(after, 1, 1), "the next February 1st on a Monday");
});

test("(R14D-tools-02) a schedule that never fires is stored with no next fire time and never fires", async (t) => {
  const { store, clock, agentId, lines } = await setup(t);
  const trigger = cronTrigger(agentId, clock, { cron: { expression: "0 0 30 2 *" } });
  assert.equal(trigger.nextFireAt, null);
  await store.saveTrigger(trigger);
  clock.set(Date.parse("2400-01-01T00:00:00Z"));
  assert.equal(await scheduler(store, clock, lines).tick(), 0);
});

test("start after stop schedules nothing", async (t) => {
  const { store, clock, agentId, lines } = await setup(t);
  const trigger = cronTrigger(agentId, clock);
  await store.saveTrigger(trigger);
  clock.set(START + 5 * 60_000);
  const s = scheduler(store, clock, lines, 10);
  await s.stop();
  s.start();
  t.after(() => s.stop());
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await runsOf(store, trigger.id)).length, 0, "no tick ran");
  const running = scheduler(store, clock, lines, 10);
  running.start();
  await waitFor(async () => (await runsOf(store, trigger.id)).length === 1);
  await running.stop();
  running.start();
  clock.set(START + 10 * 60_000);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await runsOf(store, trigger.id)).length, 1, "a scheduler started again after its stop does not tick");
});
