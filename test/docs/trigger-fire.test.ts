/**
 * The docs state how a trigger fires (R08-01, R08-02): one transaction on the stored trigger, the cursor moved
 * only from the slot the fire consumes, and an edit that keeps the schedule keeps a due fire time. Each statement
 * sits next to a check of the code that implements it, in architecture.md, api.md, security.md and the
 * "Triggers" section of configuration.md.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createFakeClock } from "../../src/core/clock.ts";
import { isRunwrightError } from "../../src/core/errors.ts";
import { createIdSource } from "../../src/core/ids.ts";
import { createLogger } from "../../src/log/logger.ts";
import { createTriggerScheduler } from "../../src/triggers/scheduler.ts";
import { buildTrigger, fireTrigger } from "../../src/triggers/service.ts";
import { openTestStore, testAgentDefinition } from "../helpers/store.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const START = Date.parse("2026-01-01T00:00:00Z");
const MINUTE = 60_000;

function doc(name: string): Promise<string> {
  return readFile(join(ROOT, name), "utf8");
}

/** The text of a `## heading` section, up to the next `## ` heading. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n## ${heading}\n`);
  assert.ok(start >= 0, `section "${heading}" exists`);
  const end = text.indexOf("\n## ", start + 1);
  return text.slice(start, end === -1 ? undefined : end);
}

/** Markdown wraps lines; compare with every run of whitespace as one space. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

test("architecture.md states that a fire is one transaction on the stored trigger, and a stale snapshot starts nothing", async (t) => {
  const triggers = flat(section(await doc("docs/architecture.md"), "Triggers"));
  // 1. One transaction; the key first; then the stored row decides.
  assert.match(triggers, /A fire is one store transaction, `fireTrigger`, for all three kinds of key \(`cron:…`, `webhook:…`, `manual:…`\)/);
  assert.match(triggers, /the run is created only if the row exists, is enabled, and its definition \(name, kind, agent, enabled, cron, webhook, message, limits\) equals the one the caller read and built the run from\. Otherwise nothing is written and the outcome is `missing` \(404\), `disabled` \(409 `trigger_disabled`\) or `changed`/);
  // 2. What a run carries.
  assert.match(triggers, /So a run never starts from a trigger that was disabled, deleted or edited after the caller read it: it always carries the agent, message and cap that are stored at the moment it is created/);
  // 3. Retries on changed.
  assert.match(triggers, /On `changed`, `POST \/v1\/triggers\/:id\/fire` and `POST \/v1\/hooks\/:id` read the trigger again and repeat \(a delivery's signature is verified again, against the secret the trigger names now\), up to three times, then 409 `conflict`; the cron scheduler skips the trigger until its next tick/);
  // 5. The agent is gone.
  assert.match(triggers, /a trigger whose agent no longer exists starts nothing \(`agent_missing`\), and a scheduled fire of it still consumes its slot/);
  assert.ok(!/deleted trigger'?s? redelivery gets its run/.test(triggers), "a deleted trigger answers 404 at the route");

  const clock = createFakeClock(START);
  const { store } = await openTestStore(t, { clock });
  await store.saveAgent({ id: "docs-agent", definition: testAgentDefinition() });
  const built = buildTrigger({ name: "hook", kind: "webhook", agentId: "docs-agent", message: "go", webhook: { secretName: "HOOK" }, limits: { maxCostMicros: 1000 } },
    { ids: createIdSource({ clock }), clock });
  await store.saveTrigger(built);
  const snapshot = await store.getTrigger(built.id);
  assert.ok(snapshot !== null);
  assert.equal(await store.updateTrigger({ ...snapshot, enabled: false, limits: { ...snapshot.limits, maxCostMicros: 5 } }, snapshot), "updated");
  await assert.rejects(fireTrigger({ store, clock }, snapshot, { dedupeKey: `webhook:${snapshot.id}:d-1`, kind: "webhook", data: null }),
    (error: unknown) => isRunwrightError(error) && error.code === "trigger_disabled");
  assert.deepEqual((await store.listRuns({ triggerId: snapshot.id }, { limit: 10 })).items, [], "a disabled-after-read fire starts nothing");
});

test("architecture.md states that the cursor only moves forward from the slot a fire consumes", async (t) => {
  const triggers = flat(section(await doc("docs/architecture.md"), "Triggers"));
  // 4. The slot.
  assert.match(triggers, /A scheduled fire names the slot it consumes, the `nextFireAt` the scheduler read\. The same transaction creates the run, sets `lastFiredAt` and moves `nextFireAt` from that slot to the next fire time, and only while the stored `nextFireAt` still equals the slot/);
  assert.match(triggers, /A scheduler that is late finds the slot consumed \(`stale`, or `duplicate` for the same slot\) and writes nothing, so the cursor only moves forward and schedulers on several processes cannot start a second run for fire times another one has already coalesced\. `lastFiredAt` never moves backwards/);

  const clock = createFakeClock(START);
  const { store } = await openTestStore(t, { clock });
  await store.saveAgent({ id: "docs-agent", definition: testAgentDefinition() });
  const built = buildTrigger({ name: "minutely", kind: "cron", agentId: "docs-agent", message: "go", cron: { expression: "* * * * *" }, limits: { maxCostMicros: 1000 } },
    { ids: createIdSource({ clock }), clock });
  await store.saveTrigger(built);
  const trigger = await store.getTrigger(built.id);
  assert.ok(trigger !== null && trigger.nextFireAt === START + MINUTE);
  const slot = START + MINUTE;
  const base = { trigger, kind: "cron" as const, idempotencyKey: `cron:${trigger.id}:${slot}`, run: { input: { message: "go", data: null }, limits: { maxCostMicros: 1000 } } };
  assert.equal((await store.fireTrigger({ ...base, firedAt: START + 5 * MINUTE, cron: { slot, nextFireAt: START + 6 * MINUTE } })).outcome, "started");
  assert.equal((await store.fireTrigger({ ...base, firedAt: START + 2 * MINUTE, cron: { slot, nextFireAt: START + 3 * MINUTE } })).outcome, "duplicate");
  const after = await store.getTrigger(trigger.id);
  assert.equal(after?.nextFireAt, START + 6 * MINUTE, "a late cursor write does not move the cursor");
  assert.equal(after?.lastFiredAt, START + 5 * MINUTE);
});

test("architecture.md states that an edit which keeps the schedule keeps a due fire time", async (t) => {
  const triggers = flat(section(await doc("docs/architecture.md"), "Triggers"));
  // 6. PATCH.
  assert.match(triggers, /A change through `PATCH \/v1\/triggers\/:id` is written with `updateTrigger`, a compare-and-set/);
  assert.match(triggers, /A change that leaves an enabled cron trigger enabled with its expression and time zone as they are keeps the stored `nextFireAt`, so an unrelated edit never skips a fire time that is due/);
  assert.match(triggers, /a changed schedule, or turning the trigger on, stores the next fire time after now/);

  const clock = createFakeClock(START);
  const { store } = await openTestStore(t, { clock });
  const input = { name: "five", kind: "cron", agentId: "docs-agent", message: "go", cron: { expression: "*/5 * * * *" }, limits: { maxCostMicros: 1000 } };
  const built = buildTrigger(input, { ids: createIdSource({ clock }), clock });
  await store.saveTrigger(built);
  const existing = await store.getTrigger(built.id);
  assert.ok(existing !== null);
  clock.set(START + 5 * MINUTE + 500);
  const renamed = buildTrigger({ ...input, name: "renamed" }, { ids: createIdSource({ clock }), clock, existing });
  assert.equal(await store.updateTrigger(renamed, existing), "updated");
  assert.equal((await store.getTrigger(built.id))?.nextFireAt, START + 5 * MINUTE, "a rename keeps a due cursor");
});

test("api.md and security.md state that a fire uses the trigger as stored", async () => {
  const api = flat(await doc("docs/api.md"));
  assert.match(api, /A fire starts a run only from the trigger as it is stored at that moment: when the trigger is turned off, deleted or changed while `POST \/v1\/triggers\/:id\/fire` or a delivery is being handled, the request gets 409 `trigger_disabled`, 404, or is handled again under the new definition \(409 `conflict` if the trigger keeps changing\)/);
  assert.match(api, /a change that leaves an enabled cron trigger's expression and time zone as they are keeps its `nextFireAt`, a changed schedule or turning it on stores the next fire time after now/);
  assert.match(flat(section(await doc("docs/api.md"), "Webhooks")), /When the trigger changes while a delivery is handled, the delivery is verified again against the signing secret the trigger names now/);
  assert.match(flat(section(await doc("docs/security.md"), "Webhooks")), /The check is made on the stored trigger inside the transaction that creates the run, so a delivery that arrives while the trigger is being turned off, deleted or changed cannot start a run from the old definition/);
});

test("configuration.md states that a scheduled fire moves the cursor in its own transaction and an edit keeps a due fire", async (t) => {
  const triggers = flat(section(await doc("docs/configuration.md"), "Triggers"));
  assert.match(triggers, /The run and the new `nextFireAt` are written in one transaction, and only while the stored `nextFireAt` is still the fire time the scheduler read, so several schedulers on the same data directory start one run per coalesced fire and a late one cannot move the next fire time back/);
  assert.match(triggers, /A trigger that is disabled, deleted or edited before that transaction starts no run from the old definition: the scheduler skips it and fires it again, under the new definition, at its next due time/);
  assert.match(triggers, /An edit that leaves the schedule of an enabled cron trigger unchanged \(same expression and time zone\) keeps its next fire time, so a fire that is due is not skipped; a changed schedule, or turning the trigger on, stores the next fire time after now/);
  assert.match(triggers, /A fire writes only the trigger's `lastFiredAt`, `nextFireAt` and `updatedAt`, so a change made after it is kept, and a deleted trigger is not recreated/);

  const clock = createFakeClock(START);
  const { store, dir } = await openTestStore(t, { clock });
  const { store: second } = await openTestStore(t, { clock, dir });
  await store.saveAgent({ id: "docs-agent", definition: testAgentDefinition() });
  const input = { name: "five", kind: "cron", agentId: "docs-agent", message: "go", cron: { expression: "*/5 * * * *" }, limits: { maxCostMicros: 1000 } };
  const built = buildTrigger(input, { ids: createIdSource({ clock }), clock });
  await store.saveTrigger(built);
  const read = await store.getTrigger(built.id);
  assert.ok(read !== null);
  clock.set(START + 5 * MINUTE + 500);
  const quiet = createLogger({ level: "error", clock, write: () => undefined });
  const first = createTriggerScheduler({ store, clock, logger: quiet, tickMs: 1000 });
  const late = createTriggerScheduler({ store: second, clock, logger: quiet, tickMs: 1000 });

  // An edit that keeps the schedule, made while the slot is due, then a stale snapshot fires nothing.
  const renamed = buildTrigger({ ...input, name: "renamed" }, { ids: createIdSource({ clock }), clock, existing: read });
  assert.equal(await store.updateTrigger(renamed, read), "updated");
  assert.equal((await store.getTrigger(built.id))?.nextFireAt, START + 5 * MINUTE, "the due fire time is kept");
  await assert.rejects(fireTrigger({ store, clock }, read, { dedupeKey: `manual:${read.id}:old`, kind: "manual", data: null }),
    (error: unknown) => isRunwrightError(error) && error.code === "conflict");

  // Two schedulers on two handles of one database: one run for the slot, the cursor moves forward once.
  const [a, b] = await Promise.all([first.tick(), late.tick()]);
  assert.equal(a + b, 1);
  const runs = (await store.listRuns({ triggerId: built.id }, { limit: 10 })).items;
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.input.message, "go");
  const after = await store.getTrigger(built.id);
  assert.equal(after?.name, "renamed", "the run started under the stored definition");
  assert.equal(after?.nextFireAt, START + 10 * MINUTE);

  // A fire writes only its columns: a delete after it is kept.
  assert.equal(await store.deleteTrigger(built.id), true);
  clock.set(START + 10 * MINUTE);
  assert.equal(await first.tick(), 0);
  assert.equal(await store.getTrigger(built.id), null, "a deleted trigger is not recreated");
});

test("the removed firing-columns writer is named nowhere in the docs", async () => {
  const removed = ["record", "Trigger", "Fire"].join("");
  const files = ["README.md", ...(await readdir(join(ROOT, "docs"))).filter((name) => name.endsWith(".md")).map((name) => `docs/${name}`)];
  assert.ok(files.length > 3);
  for (const file of files) assert.ok(!(await doc(file)).includes(removed), file);
});
