import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createFakeClock } from "../../src/core/clock.ts";
import { isRunwrightError } from "../../src/core/errors.ts";
import { openSqliteStore } from "../../src/store/sqlite.ts";
import type { Store, TriggerRecord } from "../../src/store/types.ts";
import { fireTrigger, type TriggerInput } from "../../src/triggers/service.ts";
import { openTestStore } from "../helpers/store.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { authed, errorOf, startTestServer, testAgentDefinition } from "./support.ts";

const cron: TriggerInput = {
  name: "Nightly", kind: "cron", agentId: "a", cron: { expression: "0 3 * * *", timeZone: "UTC" }, message: "tidy up",
  limits: { maxCostMicros: 50_000 },
};

test("triggers are created, listed, fetched, changed and deleted", async (t) => {
  const s = await startTestServer(t);
  await s.client.saveAgent(testAgentDefinition({ name: "A" }));
  const response = await authed(s, "/v1/triggers", { method: "POST", json: cron });
  assert.equal(response.status, 201);
  const { trigger } = (await response.json()) as { trigger: { id: string; nextFireAt: number | null; enabled: boolean } };
  assert.equal(trigger.enabled, true);
  assert.ok(trigger.nextFireAt !== null && trigger.nextFireAt > Date.now());
  assert.deepEqual((await s.client.listTriggers()).map((x) => x.id), [trigger.id]);
  assert.equal((await s.client.getTrigger(trigger.id)).name, "Nightly");

  const off = await s.client.updateTrigger(trigger.id, { enabled: false });
  assert.equal(off.enabled, false);
  assert.equal(off.nextFireAt, null);
  assert.equal(off.cron?.expression, "0 3 * * *");
  const recapped = await s.client.updateTrigger(trigger.id, { limits: { maxCostMicros: 9 }, enabled: true });
  assert.equal(recapped.limits.maxCostMicros, 9);
  const switched = await s.client.updateTrigger(trigger.id, { kind: "webhook", webhook: { secretName: "HOOK_SECRET" } });
  assert.equal(switched.kind, "webhook");
  assert.equal(switched.cron, null);

  await s.client.deleteTrigger(trigger.id);
  assert.equal((await errorOf(await authed(s, `/v1/triggers/${trigger.id}`))).status, 404);
  assert.equal((await errorOf(await authed(s, `/v1/triggers/${trigger.id}`, { method: "DELETE" }))).status, 404);
});

test("an invalid trigger is validation_failed; an unknown agent is 404", async (t) => {
  const s = await startTestServer(t);
  await s.client.saveAgent(testAgentDefinition({ name: "A" }));
  const noCap = await errorOf(await authed(s, "/v1/triggers", { method: "POST", json: { ...cron, limits: {} } }));
  assert.equal(noCap.code, "validation_failed");
  assert.ok((noCap.details?.["problems"] as { path: string }[]).some((p) => p.path === "$.limits.maxCostMicros"));
  const badCron = await errorOf(await authed(s, "/v1/triggers", { method: "POST", json: { ...cron, cron: { expression: "@daily" } } }));
  assert.equal(badCron.code, "validation_failed");
  const ghost = await errorOf(await authed(s, "/v1/triggers", { method: "POST", json: { ...cron, agentId: "ghost" } }));
  assert.equal(ghost.status, 404);
  const created = await s.client.createTrigger(cron);
  const ghostPatch = await errorOf(await authed(s, `/v1/triggers/${created.id}`, { method: "PATCH", json: { agentId: "ghost" } }));
  assert.equal(ghostPatch.status, 404);
});

test("fire starts a capped run each time; a disabled trigger is 409", async (t) => {
  const s = await startTestServer(t);
  await s.client.saveAgent(testAgentDefinition({ name: "A" }));
  const trigger = await s.client.createTrigger(cron);
  const fired = await authed(s, `/v1/triggers/${trigger.id}/fire`, { method: "POST", json: { data: { reason: "manual" } } });
  assert.equal(fired.status, 202);
  const { run, created } = (await fired.json()) as { run: { id: string; limits: { maxCostMicros: number }; trigger: unknown; input: unknown }; created: boolean };
  assert.equal(created, true);
  assert.equal(run.limits.maxCostMicros, 50_000);
  assert.deepEqual(run.trigger, { id: trigger.id, kind: "manual" });
  assert.deepEqual(run.input, { message: "tidy up", data: { reason: "manual" } });
  const second = await s.client.fireTrigger(trigger.id);
  assert.notEqual(second.run.id, run.id);
  assert.equal((await s.client.listRuns({ triggerId: trigger.id })).runs.length, 2);
  await s.client.updateTrigger(trigger.id, { enabled: false });
  const disabled = await errorOf(await authed(s, `/v1/triggers/${trigger.id}/fire`, { method: "POST", json: {} }));
  assert.equal(disabled.status, 409);
  assert.equal(disabled.code, "trigger_disabled");
});

/**
 * A store whose getAgent runs `interfere` once before answering. The PATCHes below change the agent, so the route
 * looks the new agent up between reading the trigger and writing it: the interference lands exactly there, as a
 * concurrent request would.
 */
async function interferingStore(t: TestContext, dir: string): Promise<{ store: Store; inner: Store; arm(fn: (inner: Store) => Promise<void>): void }> {
  const inner = await openSqliteStore({ path: join(dir, "runwright.db") });
  t.after(() => inner.close());
  let pending: ((inner: Store) => Promise<void>) | null = null;
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "getAgent") {
        return async (id: string) => {
          const run = pending;
          pending = null;
          if (run !== null) await run(target);
          return target.getAgent(id);
        };
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Store;
  return { store, inner, arm: (fn) => { pending = fn; } };
}

test("a trigger deleted while a PATCH is being handled is not recreated by it", async (t) => {
  const dir = await makeTempDir(t, "runwright-trigger-race-");
  const { store, inner, arm } = await interferingStore(t, dir);
  const s = await startTestServer(t, { dir, store });
  await s.client.saveAgent(testAgentDefinition({ name: "A" }));
  await s.client.saveAgent(testAgentDefinition({ name: "B" }), "b");
  const trigger = await s.client.createTrigger(cron);
  let deleted = false;
  arm(async (target) => {
    deleted = await target.deleteTrigger(trigger.id);
  });
  const patch = await errorOf(await authed(s, `/v1/triggers/${trigger.id}`, { method: "PATCH", json: { agentId: "b" } }));
  assert.equal(patch.status, 404);
  assert.equal(deleted, true, "the trigger was deleted during the PATCH");
  assert.equal(await inner.getTrigger(trigger.id), null);
  assert.deepEqual(await s.client.listTriggers(), []);
});

test("a PATCH that overlaps another change merges into it instead of overwriting it", async (t) => {
  const dir = await makeTempDir(t, "runwright-trigger-cas-");
  const { store, inner, arm } = await interferingStore(t, dir);
  const s = await startTestServer(t, { dir, store });
  await s.client.saveAgent(testAgentDefinition({ name: "A" }));
  await s.client.saveAgent(testAgentDefinition({ name: "B" }), "b");
  const trigger = await s.client.createTrigger(cron);
  // While the PATCH that moves the trigger to agent b is in flight, a person turns the trigger off.
  arm(async (target) => {
    const current = await target.getTrigger(trigger.id);
    assert.ok(current !== null);
    assert.equal(await target.updateTrigger({ ...current, enabled: false, nextFireAt: null }, current), "updated");
  });
  const moved = await s.client.updateTrigger(trigger.id, { agentId: "b" });
  assert.equal(moved.agentId, "b");
  assert.equal(moved.enabled, false, "the overlapping disable was not lost");
  assert.equal(moved.nextFireAt, null);
  assert.deepEqual(await inner.getTrigger(trigger.id), moved);
});

test("a trigger's message and name are stored redacted on create and on update", async (t) => {
  const s = await startTestServer(t);
  const named = "trigger-secret-value-77";
  await s.client.setSecret("TOOL_KEY", named);
  await s.client.saveAgent(testAgentDefinition({ name: "A", secrets: ["TOOL_KEY"] }));
  const created = await s.client.createTrigger({
    name: `nightly ${named}`, kind: "cron", agentId: "a", cron: { expression: "0 0 1 1 *" }, message: `say ${named}`,
    limits: { maxCostMicros: 1000 },
  });
  const stored = await s.client.getTrigger(created.id);
  assert.equal(stored.message, "say [redacted]");
  assert.equal(stored.name, "nightly [redacted]");
  const updated = await s.client.updateTrigger(created.id, { message: `now ${encodeURIComponent(named)}` });
  assert.equal(updated.message, "now [redacted]");
  const fired = await s.client.fireTrigger(created.id, { value: named });
  assert.deepEqual(fired.run.input, { message: "now [redacted]", data: { value: "[redacted]" } });
  assert.ok(!JSON.stringify(await s.client.listTriggers()).includes(named));
});

test("fireTrigger on a disabled trigger returns the run its key already started and refuses a new fire", async (t) => {
  const s = await startTestServer(t);
  await s.client.saveAgent(testAgentDefinition({ name: "A" }));
  const created = await s.client.createTrigger(cron);
  const trigger = await s.store.getTrigger(created.id);
  assert.ok(trigger !== null);
  const deps = { store: s.store, clock: createFakeClock(5_000) };
  const fire = { dedupeKey: `cron:${trigger.id}:slot-1`, kind: "cron" as const, data: { slot: 1 } };
  const first = await fireTrigger(deps, trigger, fire);
  assert.equal(first.created, true);
  assert.equal((await s.store.getTrigger(trigger.id))?.lastFiredAt, 5_000);

  const off = await s.client.updateTrigger(trigger.id, { enabled: false });
  const disabled = await s.store.getTrigger(off.id);
  assert.ok(disabled !== null && !disabled.enabled);
  const later = { store: s.store, clock: createFakeClock(9_000) };
  const again = await fireTrigger(later, disabled, fire);
  assert.deepEqual([again.created, again.run.id], [false, first.run.id]);
  const lax = await fireTrigger(later, disabled, { ...fire, data: { slot: "a different payload" } });
  assert.deepEqual([lax.created, lax.run.id], [false, first.run.id], "trigger fires are not strict");
  assert.equal((await s.store.getTrigger(trigger.id))?.lastFiredAt, 5_000, "a duplicate does not touch lastFiredAt");

  await assert.rejects(fireTrigger(later, disabled, { ...fire, dedupeKey: `cron:${trigger.id}:slot-2` }), (error: unknown) =>
    isRunwrightError(error) && error.code === "trigger_disabled" && error.details?.["triggerId"] === trigger.id);
  const manual = await errorOf(await authed(s, `/v1/triggers/${trigger.id}/fire`, { method: "POST", json: {} }));
  assert.deepEqual([manual.status, manual.code], [409, "trigger_disabled"]);
  assert.equal((await s.client.listRuns({ triggerId: trigger.id })).runs.length, 1);
});

type Change = (inner: Store, current: TriggerRecord) => Promise<void>;

/**
 * (R08-01) A raw store whose getTrigger answers with the stored row and then, when armed, changes that trigger
 * through the real store before the route goes on: once, or on every read.
 */
function changingAfterRead(inner: Store): { store: Store; arm(change: Change, every?: boolean): void } {
  let pending: Change | null = null;
  let repeat = false;
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "getTrigger") {
        return async (id: string) => {
          const row = await target.getTrigger(id);
          const change = pending;
          if (change !== null && row !== null) {
            if (!repeat) pending = null;
            await change(target, row);
          }
          return row;
        };
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Store;
  return { store, arm: (change, every = false) => { pending = change; repeat = every; } };
}

const disable: Change = async (inner, current) => {
  assert.equal(await inner.updateTrigger({ ...current, enabled: false, nextFireAt: null }, current), "updated");
};
const remove: Change = async (inner, current) => {
  assert.equal(await inner.deleteTrigger(current.id), true);
};
const lowerCap: Change = async (inner, current) => {
  const cap = (current.limits.maxCostMicros ?? 50_000) - 1;
  assert.equal(await inner.updateTrigger({ ...current, limits: { ...current.limits, maxCostMicros: cap } }, current), "updated");
};

async function changingServer(t: TestContext) {
  const { store: inner, dir } = await openTestStore(t);
  const { store, arm } = changingAfterRead(inner);
  const s = await startTestServer(t, { store, dir });
  await s.client.saveAgent(testAgentDefinition({ name: "A" }));
  const trigger = await s.client.createTrigger(cron);
  return { s, inner, arm, trigger };
}

test("(R08-01) a manual fire whose trigger is disabled or deleted right after the route read it starts nothing", async (t) => {
  const { s, arm, trigger } = await changingServer(t);
  arm(disable);
  const disabled = await errorOf(await authed(s, `/v1/triggers/${trigger.id}/fire`, { method: "POST", json: {} }));
  assert.deepEqual([disabled.status, disabled.code], [409, "trigger_disabled"]);
  assert.equal((await s.client.listRuns({ triggerId: trigger.id })).runs.length, 0);

  const other = await s.client.createTrigger({ ...cron, name: "Other" });
  arm(remove);
  const gone = await errorOf(await authed(s, `/v1/triggers/${other.id}/fire`, { method: "POST", json: {} }));
  assert.deepEqual([gone.status, gone.code, gone.message], [404, "not_found", `trigger ${other.id} not found`]);
  assert.equal((await s.client.listRuns({ triggerId: other.id })).runs.length, 0);
  assert.deepEqual((await s.client.listTriggers()).map((x) => x.id), [trigger.id]);
});

test("(R08-01) a manual fire whose trigger is edited once after the read fires the new definition; one that keeps changing is 409", async (t) => {
  const { s, inner, arm, trigger } = await changingServer(t);
  arm(lowerCap);
  const fired = await authed(s, `/v1/triggers/${trigger.id}/fire`, { method: "POST", json: { data: 1 } });
  assert.equal(fired.status, 202);
  const { run, created } = (await fired.json()) as { run: { limits: { maxCostMicros: number } }; created: boolean };
  assert.equal(created, true);
  assert.equal(run.limits.maxCostMicros, 49_999, "the cap stored when the run was created");

  arm(lowerCap, true);
  const busy = await errorOf(await authed(s, `/v1/triggers/${trigger.id}/fire`, { method: "POST", json: {} }));
  arm(async () => {});
  assert.deepEqual([busy.status, busy.code, busy.message], [409, "conflict", `trigger ${trigger.id} kept changing while it was being fired; try again`]);
  assert.equal(busy.details?.["triggerId"], trigger.id);
  assert.equal((await s.client.listRuns({ triggerId: trigger.id })).runs.length, 1);
  assert.equal((await inner.getTrigger(trigger.id))?.limits.maxCostMicros, 49_996, "three reads, three changes");
});

test("a PATCH that leaves the schedule alone keeps a due nextFireAt; a schedule change or re-enable stores the next one", async (t) => {
  const { store: raw, dir } = await openTestStore(t);
  const s = await startTestServer(t, { store: raw, dir });
  await s.client.saveAgent(testAgentDefinition({ name: "A" }));
  const created = await s.client.createTrigger({ ...cron, cron: { expression: "0 0 1 1 *", timeZone: "UTC" } });
  const stored = await raw.getTrigger(created.id);
  assert.ok(stored !== null);
  const past = Date.now() - 60_000;
  await raw.saveTrigger({ ...stored, nextFireAt: past });

  const renamed = await s.client.updateTrigger(created.id, { name: "Renamed" });
  assert.equal(renamed.nextFireAt, past);
  assert.equal((await raw.getTrigger(created.id))?.nextFireAt, past, "the due fire is not skipped");

  const moved = await s.client.updateTrigger(created.id, { cron: { expression: "0 0 2 1 *" } });
  assert.ok(moved.nextFireAt !== null && moved.nextFireAt > Date.now());
  await raw.saveTrigger({ ...((await raw.getTrigger(created.id)) as TriggerRecord), nextFireAt: past });
  assert.equal((await s.client.updateTrigger(created.id, { enabled: false })).nextFireAt, null);
  const back = await s.client.updateTrigger(created.id, { enabled: true });
  assert.ok(back.nextFireAt !== null && back.nextFireAt > Date.now());
  assert.equal((await raw.getTrigger(created.id))?.nextFireAt, back.nextFireAt);
});

test("trigger limits have a maximum: 1e308 and one above it are 400 with the path", async (t) => {
  const s = await startTestServer(t);
  await s.client.saveAgent(testAgentDefinition({ name: "A" }));
  for (const value of [1e308, Number.MAX_SAFE_INTEGER + 1]) {
    for (const field of ["maxCostMicros", "maxToolCalls", "maxTurns"]) {
      const error = await errorOf(await authed(s, "/v1/triggers", {
        method: "POST", json: { ...cron, limits: { maxCostMicros: 50_000, [field]: value } },
      }));
      assert.equal(error.status, 400, `${field} ${value}`);
      assert.equal(error.code, "validation_failed");
      const paths = ((error.details?.["problems"] ?? []) as { path: string }[]).map((p) => p.path);
      assert.ok(paths.includes(`$.limits.${field}`), `${field} ${value}: ${JSON.stringify(paths)}`);
    }
  }
  assert.deepEqual(await s.client.listTriggers(), []);
  const created = await authed(s, "/v1/triggers", { method: "POST", json: cron });
  assert.equal(created.status, 201);
  const { trigger } = (await created.json()) as { trigger: { id: string } };
  for (const value of [1e308, Number.MAX_SAFE_INTEGER + 1]) {
    const error = await errorOf(await authed(s, `/v1/triggers/${trigger.id}`, { method: "PATCH", json: { limits: { maxCostMicros: value } } }));
    assert.equal(error.status, 400, `PATCH ${value}`);
    assert.equal(error.code, "validation_failed");
    assert.ok(((error.details?.["problems"] ?? []) as { path: string }[]).some((p) => p.path === "$.limits.maxCostMicros"));
  }
  assert.equal((await s.client.getTrigger(trigger.id)).limits.maxCostMicros, 50_000);
});
