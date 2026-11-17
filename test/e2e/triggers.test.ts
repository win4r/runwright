/**
 * Triggers through the whole app (brief 3.7): a cron trigger fires on the app's clock and starts a capped run
 * that completes, missed fire times after downtime are coalesced into one run, and a signed webhook delivery
 * starts one run while its redelivery returns the same run, also after the trigger was turned off (R04-01 class).
 * A stepped day-of-month cron (`0 0 *\/2 * *`) fires on odd days only (R04-04).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakeClock } from "../../src/core/clock.ts";
import { signWebhook } from "../../src/triggers/webhook.ts";
import { waitFor } from "../helpers/wait.ts";
import { startTestApp } from "../fixtures/app.ts";
import { scriptedAgent, waitForStatus } from "../fixtures/runs.ts";

const START = Date.UTC(2026, 0, 5, 12, 0, 30);

test("a cron trigger starts one capped run per due time, coalescing missed fires", { timeout: 30_000 }, async (t) => {
  const clock = createFakeClock(START);
  const { client } = await startTestApp(t, { app: { clock }, configure: (config) => { config.triggers.tickMs = 20; } });
  const { agent } = await client.saveAgent(scriptedAgent({ name: "Cron target", script: { turns: [{ text: "tick handled" }] } }), "cron-target");
  const trigger = await client.createTrigger({
    name: "every minute", kind: "cron", agentId: agent.id, cron: { expression: "* * * * *", timeZone: "Europe/Paris" },
    message: "scheduled work", limits: { maxCostMicros: 50_000 },
  });
  assert.equal(trigger.nextFireAt, Date.UTC(2026, 0, 5, 12, 1, 0));
  assert.deepEqual((await client.listRuns({ triggerId: trigger.id })).runs, [], "nothing is due yet");

  clock.advance(45_000);
  const first = await waitFor(async () => (await client.listRuns({ triggerId: trigger.id })).runs[0], { timeoutMs: 5000 });
  assert.equal(first.trigger?.kind, "cron");
  assert.equal(first.limits.maxCostMicros, 50_000);
  assert.equal(first.input.message, "scheduled work");
  const done = await waitForStatus(client, first.id, ["completed", "failed", "waiting"]);
  assert.equal(done.run.status, "completed");
  assert.deepEqual(done.run.output, { text: "tick handled" });
  assert.equal((await client.getTrigger(trigger.id)).nextFireAt, Date.UTC(2026, 0, 5, 12, 2, 0));

  // Ten minutes of "downtime": one run, with the missed fire times counted.
  clock.advance(10 * 60_000);
  const runs = await waitFor(async () => {
    const list = (await client.listRuns({ triggerId: trigger.id })).runs;
    return list.length >= 2 ? list : null;
  }, { timeoutMs: 5000 });
  await waitFor(async () => (await client.getTrigger(trigger.id)).nextFireAt === Date.UTC(2026, 0, 5, 12, 12, 0), { timeoutMs: 5000 });
  assert.equal((await client.listRuns({ triggerId: trigger.id })).runs.length, 2, "missed fires were coalesced into one run");
  const second = runs[0]!;
  const data = second.input.data as { missedFires?: number };
  assert.equal(data.missedFires, 9);
  assert.equal((await waitForStatus(client, second.id, ["completed", "failed", "waiting"])).run.status, "completed");

  await client.updateTrigger(trigger.id, { enabled: false });
  clock.advance(5 * 60_000);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal((await client.listRuns({ triggerId: trigger.id })).runs.length, 2, "a disabled trigger starts nothing");
});

test("a signed webhook starts a run once; a redelivery returns the same run", { timeout: 30_000 }, async (t) => {
  const { app, client } = await startTestApp(t);
  const secret = "webhook-signing-secret-1234";
  await client.setSecret("HOOK_SECRET", secret);
  const { agent } = await client.saveAgent(scriptedAgent({ name: "Hook target", script: { turns: [{ text: "hook handled" }] } }), "hook-target");
  const trigger = await client.createTrigger({
    name: "deploys", kind: "webhook", agentId: agent.id, webhook: { secretName: "HOOK_SECRET" },
    message: "a deploy happened", limits: { maxCostMicros: 50_000 },
  });

  const deliver = async (delivery: string, signWith = secret, header?: string): Promise<Response> => {
    const body = Buffer.from(JSON.stringify({ delivery, service: "api", version: 7 }));
    const timestamp = Math.floor(Date.now() / 1000);
    return fetch(`${app.url}/v1/hooks/${trigger.id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Runwright-Timestamp": String(timestamp),
        "X-Runwright-Signature": signWebhook(signWith, timestamp, body),
        ...(header === undefined ? {} : { "X-Runwright-Delivery": header }),
      },
      body,
    });
  };

  const forged = await deliver("delivery-0", "not-the-right-secret");
  assert.equal(forged.status, 401);
  const firstResponse = await deliver("delivery-1");
  assert.equal(firstResponse.status, 202);
  const first = (await firstResponse.json()) as { runId: string; duplicate: boolean };
  assert.equal(first.duplicate, false);
  const again = (await (await deliver("delivery-1")).json()) as { runId: string; duplicate: boolean };
  assert.deepEqual(again, { runId: first.runId, duplicate: true });
  // A captured delivery replayed with another delivery header is refused through the real app and starts nothing.
  for (const header of ["delivery-2", "delivery-3"]) {
    const replay = await deliver("delivery-1", secret, header);
    assert.equal(replay.status, 400, header);
    assert.equal(((await replay.json()) as { error: { code: string } }).error.code, "bad_request");
  }

  const { run } = await waitForStatus(client, first.runId, ["completed", "failed", "waiting"]);
  assert.equal(run.status, "completed");
  assert.equal(run.trigger?.kind, "webhook");
  assert.equal(run.limits.maxCostMicros, 50_000);
  assert.deepEqual(run.output, { text: "hook handled" });
  assert.equal((await client.listRuns({ triggerId: trigger.id })).runs.length, 1, "the redelivery started no second run");
});

test("R04-01 class: a webhook delivery redelivered after the trigger was turned off returns its run; a new delivery is refused", { timeout: 30_000 }, async (t) => {
  const { app, client } = await startTestApp(t);
  const secret = "webhook-signing-secret-5678";
  await client.setSecret("HOOK_SECRET", secret);
  const { agent } = await client.saveAgent(scriptedAgent({ name: "Hook target", script: { turns: [{ text: "hook handled" }] } }), "hook-target");
  const trigger = await client.createTrigger({
    name: "deploys", kind: "webhook", agentId: agent.id, webhook: { secretName: "HOOK_SECRET" }, message: "a deploy happened", limits: { maxCostMicros: 50_000 },
  });
  const deliver = async (delivery: string): Promise<{ status: number; body: { runId?: string; duplicate?: boolean; error?: { code: string } } }> => {
    const body = Buffer.from(JSON.stringify({ delivery, service: "api", version: 8 }));
    const timestamp = Math.floor(Date.now() / 1000);
    const response = await fetch(`${app.url}/v1/hooks/${trigger.id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json", "X-Runwright-Timestamp": String(timestamp),
        "X-Runwright-Signature": signWebhook(secret, timestamp, body), "X-Runwright-Delivery": delivery,
      },
      body,
    });
    return { status: response.status, body: (await response.json()) as { runId?: string; duplicate?: boolean; error?: { code: string } } };
  };

  const first = await deliver("delivery-7");
  assert.deepEqual([first.status, first.body.duplicate], [202, false]);
  await waitForStatus(client, first.body.runId as string, ["completed", "failed"]);
  await client.updateTrigger(trigger.id, { enabled: false });

  const again = await deliver("delivery-7");
  assert.equal(again.status, 202);
  assert.deepEqual(again.body, { runId: first.body.runId, duplicate: true });
  const fresh = await deliver("delivery-8");
  assert.equal(fresh.status, 409);
  assert.equal(fresh.body.error?.code, "trigger_disabled");
  assert.deepEqual((await client.listRuns({ triggerId: trigger.id })).runs.map((r) => r.id), [first.body.runId], "one run");
});

test("R04-04: a cron trigger `0 0 */2 * *` created on an odd day next fires two days later, not on the even day between", { timeout: 30_000 }, async (t) => {
  const clock = createFakeClock(Date.parse("2026-11-01T09:00:00Z"));
  const { client } = await startTestApp(t, { app: { clock }, configure: (config) => { config.triggers.tickMs = 20; } });
  const { agent } = await client.saveAgent(scriptedAgent({ name: "Odd days", script: { turns: [{ text: "done" }] } }), "odd-days");
  const trigger = await client.createTrigger({
    name: "odd days", kind: "cron", agentId: agent.id, cron: { expression: "0 0 */2 * *", timeZone: "UTC" }, message: "odd day work", limits: { maxCostMicros: 50_000 },
  });
  assert.equal(trigger.nextFireAt, Date.parse("2026-11-03T00:00:00Z"));

  clock.set(Date.parse("2026-11-02T00:00:30Z"));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual((await client.listRuns({ triggerId: trigger.id })).runs, [], "2 November is not a fire day");

  clock.set(Date.parse("2026-11-03T00:00:30Z"));
  const run = await waitFor(async () => (await client.listRuns({ triggerId: trigger.id })).runs[0], { timeoutMs: 5000 });
  assert.equal(run.trigger?.kind, "cron");
  await waitFor(async () => (await client.getTrigger(trigger.id)).nextFireAt === Date.parse("2026-11-05T00:00:00Z"), { timeoutMs: 5000 });
  assert.equal((await waitForStatus(client, run.id, ["completed", "failed"])).run.status, "completed");
});
