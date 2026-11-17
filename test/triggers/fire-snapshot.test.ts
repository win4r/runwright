/**
 * (R08-01) A fire from a trigger record read before the trigger was disabled, deleted or edited starts no run from
 * that record: the service hands the record to the store, which compares it with the stored row in the
 * transaction that would create the run. Also buildTrigger's cursor rule (an update that keeps the schedule keeps
 * a due fire time).
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createFakeClock, type FakeClock } from "../../src/core/clock.ts";
import { isRunwrightError } from "../../src/core/errors.ts";
import { createIdSource } from "../../src/core/ids.ts";
import type { Store, TriggerFireResult, TriggerRecord } from "../../src/store/types.ts";
import { buildTrigger, fireResult, fireTrigger, fireTriggerOnce, type TriggerFire } from "../../src/triggers/service.ts";
import { openTestStore, testAgentDefinition } from "../helpers/store.ts";

const START = Date.parse("2026-01-01T00:00:00Z");
const MINUTE = 60_000;

interface Setup { store: Store; clock: FakeClock }

async function setup(t: TestContext): Promise<Setup> {
  const clock = createFakeClock(START);
  const { store } = await openTestStore(t, { clock });
  await store.saveAgent({ id: "agent-a", definition: testAgentDefinition() });
  await store.saveAgent({ id: "agent-b", definition: testAgentDefinition({ name: "B" }) });
  return { store, clock };
}

type Kind = "manual" | "webhook" | "cron" | "cron with its slot";
const KINDS: readonly Kind[] = ["manual", "webhook", "cron", "cron with its slot"];

async function savedTrigger(s: Setup, kind: Kind): Promise<TriggerRecord> {
  const input = kind === "webhook"
    ? { name: "hook", kind: "webhook", agentId: "agent-a", message: "go", webhook: { secretName: "HOOK" }, limits: { maxCostMicros: 1000 } }
    : { name: "minutely", kind: "cron", agentId: "agent-a", message: "go", cron: { expression: "* * * * *" }, limits: { maxCostMicros: 1000 } };
  const built = buildTrigger(input, { ids: createIdSource({ clock: s.clock }), clock: s.clock });
  await s.store.saveTrigger(built);
  const stored = await s.store.getTrigger(built.id);
  assert.ok(stored !== null);
  return stored;
}

/** A fire of `kind` from `record`; the scheduled variant names the record's cursor as its slot. */
function fireOf(kind: Kind, record: TriggerRecord, key: string): TriggerFire {
  const fireKind = kind === "cron with its slot" ? "cron" : kind;
  const base: TriggerFire = { dedupeKey: `${fireKind}:${record.id}:${key}`, kind: fireKind, data: { key } };
  if (kind !== "cron with its slot" || record.nextFireAt === null) return base;
  return { ...base, cron: { slot: record.nextFireAt, nextFireAt: record.nextFireAt + MINUTE } };
}

async function runsOf(store: Store, triggerId: string) {
  return (await store.listRuns({ triggerId }, { limit: 100 })).items;
}

const code = (expected: string, check?: (error: { message: string; details?: Record<string, unknown> }) => boolean) => (error: unknown): boolean =>
  isRunwrightError(error) && error.code === expected && (check === undefined || check(error));

type Edit = "cap" | "agent" | "message";

for (const kind of KINDS) {
  test(`(R08-01) ${kind}: a snapshot read before the trigger was disabled starts nothing`, async (t) => {
    const s = await setup(t);
    const snapshot = await savedTrigger(s, kind);
    const first = await fireTrigger(s, snapshot, fireOf(kind, snapshot, "first"));
    assert.equal(first.created, true);
    const current = await s.store.getTrigger(snapshot.id);
    assert.ok(current !== null);
    assert.equal(await s.store.updateTrigger({ ...current, enabled: false, nextFireAt: null, limits: { ...current.limits, maxCostMicros: 5 } }, current), "updated");
    await assert.rejects(fireTrigger(s, snapshot, fireOf(kind, snapshot, "second")), code("trigger_disabled"));
    const again = await fireTrigger(s, snapshot, fireOf(kind, snapshot, "first"));
    assert.deepEqual([again.created, again.run.id], [false, first.run.id], "the key that started a run still gets it");
    assert.deepEqual((await runsOf(s.store, snapshot.id)).map((r) => r.id), [first.run.id]);
  });

  test(`(R08-01) ${kind}: a snapshot read before the trigger was deleted starts nothing`, async (t) => {
    const s = await setup(t);
    const snapshot = await savedTrigger(s, kind);
    const first = await fireTrigger(s, snapshot, fireOf(kind, snapshot, "first"));
    assert.equal(await s.store.deleteTrigger(snapshot.id), true);
    await assert.rejects(fireTrigger(s, snapshot, fireOf(kind, snapshot, "second")),
      code("not_found", (e) => e.message === `trigger ${snapshot.id} not found` && e.details?.["triggerId"] === snapshot.id));
    const again = await fireTrigger(s, snapshot, fireOf(kind, snapshot, "first"));
    assert.deepEqual([again.created, again.run.id], [false, first.run.id]);
    assert.equal((await runsOf(s.store, snapshot.id)).length, 1);
    assert.deepEqual(await s.store.listTriggers(), []);
  });

  for (const edit of ["cap", "agent", "message"] as const satisfies readonly Edit[]) {
    test(`(R08-01) ${kind}: a snapshot read before the ${edit} was edited is refused; the fresh record fires with the new ${edit}`, async (t) => {
      const s = await setup(t);
      const snapshot = await savedTrigger(s, kind);
      const first = await fireTrigger(s, snapshot, fireOf(kind, snapshot, "first"));
      const current = await s.store.getTrigger(snapshot.id);
      assert.ok(current !== null);
      const change: Partial<TriggerRecord> = edit === "cap" ? { limits: { ...current.limits, maxCostMicros: 5 } }
        : edit === "agent" ? { agentId: "agent-b" } : { message: "the new job" };
      assert.equal(await s.store.updateTrigger({ ...current, ...change }, current), "updated");
      await assert.rejects(fireTrigger(s, snapshot, fireOf(kind, snapshot, "second")),
        code("conflict", (e) => e.message === `trigger ${snapshot.id} changed while it was firing; try again` && e.details?.["outcome"] === "changed"));
      assert.equal((await runsOf(s.store, snapshot.id)).length, 1, "no run from the old definition");
      const again = await fireTrigger(s, snapshot, fireOf(kind, snapshot, "first"));
      assert.deepEqual([again.created, again.run.id], [false, first.run.id]);

      const fresh = await s.store.getTrigger(snapshot.id);
      assert.ok(fresh !== null);
      const { run, created } = await fireTrigger(s, fresh, fireOf(kind, fresh, "third"));
      assert.equal(created, true);
      if (edit === "cap") assert.equal(run.limits.maxCostMicros, 5);
      if (edit === "agent") assert.equal(run.agentId, "agent-b");
      if (edit === "message") assert.equal(run.input.message, "the new job");
    });
  }
}

test("fireTriggerOnce returns every outcome without throwing; fireResult maps each to its run or error", async (t) => {
  const s = await setup(t);
  const trigger = await savedTrigger(s, "cron");
  const once = (record: TriggerRecord, fire: TriggerFire): Promise<TriggerFireResult> => fireTriggerOnce(s, record, fire);
  s.clock.advance(7);
  const started = await once(trigger, fireOf("manual", trigger, "a"));
  assert.equal(started.outcome, "started");
  assert.equal((await s.store.getTrigger(trigger.id))?.lastFiredAt, START + 7, "firedAt is the service's clock");
  assert.equal((await once(trigger, fireOf("manual", trigger, "a"))).outcome, "duplicate");
  assert.equal((await once({ ...trigger, name: "other" }, fireOf("manual", trigger, "b"))).outcome, "changed");
  assert.equal((await once(trigger, { ...fireOf("manual", trigger, "c"), cron: { slot: 1, nextFireAt: 2 } })).outcome, "stale");
  const ghost = buildTrigger({ name: "ghost", kind: "cron", agentId: "nobody", message: "", cron: { expression: "* * * * *" }, limits: { maxCostMicros: 1 } },
    { ids: createIdSource({ clock: s.clock }), clock: s.clock });
  await s.store.saveTrigger(ghost);
  const ghostRecord = await s.store.getTrigger(ghost.id);
  assert.ok(ghostRecord !== null);
  assert.equal((await once(ghostRecord, fireOf("manual", ghostRecord, "d"))).outcome, "agent_missing");
  const off = await s.store.getTrigger(trigger.id);
  assert.ok(off !== null);
  await s.store.updateTrigger({ ...off, enabled: false }, off);
  assert.equal((await once(trigger, fireOf("manual", trigger, "e"))).outcome, "disabled");
  await s.store.deleteTrigger(trigger.id);
  assert.equal((await once(trigger, fireOf("manual", trigger, "f"))).outcome, "missing");

  assert.ok(started.outcome === "started");
  assert.deepEqual(fireResult(trigger, started), { run: started.run, created: true });
  assert.deepEqual(fireResult(trigger, { outcome: "duplicate", run: started.run }), { run: started.run, created: false });
  assert.throws(() => fireResult(trigger, { outcome: "disabled" }),
    code("trigger_disabled", (e) => e.message === `trigger ${trigger.id} is turned off` && e.details?.["triggerId"] === trigger.id));
  assert.throws(() => fireResult(trigger, { outcome: "missing" }), code("not_found", (e) => e.message === `trigger ${trigger.id} not found`));
  assert.throws(() => fireResult(ghostRecord, { outcome: "agent_missing" }),
    code("not_found", (e) => e.message === "agent nobody not found" && e.details?.["agentId"] === "nobody"));
  for (const outcome of ["changed", "stale", "no_run"] as const) {
    assert.throws(() => fireResult(trigger, { outcome }), code("conflict", (e) =>
      e.message === `trigger ${trigger.id} changed while it was firing; try again` && e.details?.["outcome"] === outcome
      && e.details["triggerId"] === trigger.id), outcome);
  }
});

test("buildTrigger keeps the cursor of an unchanged schedule and computes it after a schedule change or re-enable", () => {
  const clock = createFakeClock(START);
  const ids = createIdSource({ clock });
  const input = { name: "five", kind: "cron", agentId: "a", message: "m", cron: { expression: "*/5 * * * *" }, limits: { maxCostMicros: 9 } };
  const existing = buildTrigger(input, { ids, clock });
  assert.equal(existing.nextFireAt, START + 5 * MINUTE);
  // The probe: at 0:05:00.5, before the scheduler's tick, a rename keeps the 0:05 fire that is due.
  clock.set(START + 5 * MINUTE + 500);
  assert.equal(buildTrigger({ ...input, name: "renamed" }, { ids, clock, existing }).nextFireAt, START + 5 * MINUTE);
  assert.equal(buildTrigger({ ...input, cron: { expression: "*/10 * * * *" } }, { ids, clock, existing }).nextFireAt, START + 10 * MINUTE);
  assert.equal(buildTrigger({ ...input, cron: { expression: "*/5 * * * *", timeZone: "Asia/Kolkata" } }, { ids, clock, existing }).nextFireAt, START + 10 * MINUTE);
  assert.equal(buildTrigger({ ...input, enabled: true }, { ids, clock, existing: { ...existing, enabled: false } }).nextFireAt, START + 10 * MINUTE);
  assert.equal(buildTrigger(input, { ids, clock, existing: { ...existing, nextFireAt: null } }).nextFireAt, START + 10 * MINUTE);
  assert.equal(buildTrigger({ ...input, enabled: false }, { ids, clock, existing }).nextFireAt, null);
});

test("(R15D-store-02) buildTrigger refuses a name or message that is not well-formed Unicode", () => {
  const clock = createFakeClock(START);
  const base = { name: "hook", kind: "webhook", agentId: "agent-a", message: "go", webhook: { secretName: "HOOK" }, limits: { maxCostMicros: 1000 } };
  for (const [field, patch] of [["name", { name: "hook \ud800" }], ["message", { message: "go \udc00" }]] as const) {
    assert.throws(() => buildTrigger({ ...base, ...patch }, { ids: createIdSource({ clock }), clock }), (e: unknown) =>
      isRunwrightError(e) && e.code === "validation_failed"
      && e.message === `$.${field}: ${field} must be well-formed Unicode (no unpaired surrogate)`);
  }
  assert.equal(buildTrigger({ ...base, name: "hook 🚀" }, { ids: createIdSource({ clock }), clock }).name, "hook 🚀");
});

test("(R15D-tools-02) a fire pins the revision it is given; one the agent does not have is agent_missing and creates nothing", async (t) => {
  const s = await setup(t);
  await s.store.saveAgent({ id: "agent-a", definition: testAgentDefinition({ instructions: "Revision two." }) });
  const trigger = await savedTrigger(s, "webhook");
  const fire = (delivery: string, revision?: number) => s.store.fireTrigger({
    trigger, kind: "webhook", idempotencyKey: `webhook:${trigger.id}:${delivery}`, firedAt: START,
    run: { input: { message: "go", data: null }, limits: {}, ...(revision === undefined ? {} : { revision }) },
  });
  const pinned = await fire("d-1", 1);
  assert.equal(pinned.outcome === "started" ? pinned.run.revision : null, 1);
  const current = await fire("d-2");
  assert.equal(current.outcome === "started" ? current.run.revision : null, 2);
  assert.deepEqual(await fire("d-3", 7), { outcome: "agent_missing" });
  assert.equal(await s.store.findIdempotentRun({ idempotencyKey: `webhook:${trigger.id}:d-3` }), null);
});
