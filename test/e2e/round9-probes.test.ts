/**
 * Trigger fires and durations end to end, through `createApp` and the HTTP API (the client).
 *
 * Findings R08-01, R08-02 and R08-03. Pinned here: a fire starts a run only from the trigger as stored (a
 * lowered cap is used, a disabled trigger answers 409 `trigger_disabled`, a deleted one 404); a PATCH that
 * leaves the schedule as it is keeps a due `nextFireAt`; two schedulers on one database start one run per slot
 * and never move the cursor back; a redelivered webhook keeps its run through an edit and a disable; a workflow
 * deadline above the timer limit is refused when the agent is saved; an over-limit setting is refused at load.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentDefinition } from "../../src/agents/definition.ts";
import { createFakeClock } from "../../src/core/clock.ts";
import { isRunwrightError } from "../../src/core/errors.ts";
import { loadConfig } from "../../src/config/load.ts";
import { createLogger } from "../../src/log/logger.ts";
import { openSqliteStore } from "../../src/store/sqlite.ts";
import { createTriggerScheduler } from "../../src/triggers/scheduler.ts";
import { signWebhook } from "../../src/triggers/webhook.ts";
import { WORKFLOW_FORMAT } from "../../src/workflow/types.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { waitFor } from "../helpers/wait.ts";
import { startTestApp } from "../fixtures/app.ts";
import { scriptedAgent, waitForStatus } from "../fixtures/runs.ts";

const MINUTE = 60_000;

/** The error a client call rejected with. */
async function rejection(promise: Promise<unknown>): Promise<{ code: string; status: number; problems: { path: string }[] }> {
  try {
    await promise;
  } catch (error) {
    assert.ok(isRunwrightError(error), String(error));
    const problems = (error.details?.["problems"] ?? []) as { path: string }[];
    return { code: error.code, status: error.status, problems };
  }
  assert.fail("the call resolved");
}

/** A workflow agent whose root is one model node `ask` with the given deadline; the scripted step answers at once. */
function deadlineAgent(name: string, deadlineMs: number): AgentDefinition {
  const definition = scriptedAgent({ name, script: { steps: { ask: { output: { text: "ok" } } } } });
  definition.workflow = {
    format: WORKFLOW_FORMAT, name: "ask_flow",
    schemas: {
      Input: { type: "object" }, Output: {},
      Summary: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
    },
    input: "Input", output: "Output",
    root: { id: "ask", kind: "model", prompt: "Say ok", output: "Summary", deadlineMs },
    result: { $ref: "steps.ask.text" },
  };
  return definition;
}

test("R08-01: a manual fire uses the stored trigger: the lowered cap, then 409 when disabled, then 404 when deleted", { timeout: 20_000 }, async (t) => {
  const { client } = await startTestApp(t);
  const { agent } = await client.saveAgent(scriptedAgent({ name: "Fire target", script: { turns: [{ text: "done" }] } }), "fire-target");
  const trigger = await client.createTrigger({
    name: "yearly", kind: "cron", agentId: agent.id, cron: { expression: "0 0 1 1 *" }, message: "work", limits: { maxCostMicros: 50_000 },
  });
  await client.updateTrigger(trigger.id, { limits: { maxCostMicros: 7 } });
  const fired = await client.fireTrigger(trigger.id);
  assert.equal(fired.created, true);
  assert.equal(fired.run.limits.maxCostMicros, 7, "the run carries the cap stored now");

  await client.updateTrigger(trigger.id, { enabled: false });
  const disabled = await rejection(client.fireTrigger(trigger.id));
  assert.deepEqual([disabled.status, disabled.code], [409, "trigger_disabled"]);
  await client.deleteTrigger(trigger.id);
  const deleted = await rejection(client.fireTrigger(trigger.id));
  assert.deepEqual([deleted.status, deleted.code], [404, "not_found"]);
  assert.deepEqual((await client.listRuns({ triggerId: trigger.id })).runs.map((r) => r.id), [fired.run.id], "one run");
});

test("R08-02: a PATCH that keeps the schedule keeps a due nextFireAt; a new schedule moves it", { timeout: 20_000 }, async (t) => {
  const start = Date.UTC(2026, 0, 5, 12, 0, 30);
  const clock = createFakeClock(start);
  const { client } = await startTestApp(t, { app: { clock }, configure: (config) => { config.triggers.tickMs = 2_000_000; } });
  const { agent } = await client.saveAgent(scriptedAgent({ name: "Five", script: { turns: [{ text: "done" }] } }), "five");
  const trigger = await client.createTrigger({
    name: "every five", kind: "cron", agentId: agent.id, cron: { expression: "*/5 * * * *" }, message: "work", limits: { maxCostMicros: 50_000 },
  });
  const due = trigger.nextFireAt;
  assert.equal(due, Date.UTC(2026, 0, 5, 12, 5, 0));
  clock.set(due + 500);

  const renamed = await client.updateTrigger(trigger.id, { name: "renamed" });
  assert.equal(renamed.name, "renamed");
  assert.equal(renamed.nextFireAt, due, "the due fire time is kept, not moved to the next slot");
  const hourly = await client.updateTrigger(trigger.id, { cron: { expression: "0 * * * *" } });
  assert.equal(hourly.nextFireAt, Date.UTC(2026, 0, 5, 13, 0, 0), "a changed schedule stores the next fire time after now");
  assert.deepEqual((await client.listRuns({ triggerId: trigger.id })).runs, [], "the scheduler did not tick during the test");
});

test("R08-02: two schedulers on one database start one run per slot and never move the cursor back", { timeout: 20_000 }, async (t) => {
  const start = Date.UTC(2026, 0, 5, 12, 0, 0);
  const clock = createFakeClock(start);
  const { client, dir } = await startTestApp(t, { app: { clock }, configure: (config) => { config.triggers.tickMs = 20; } });
  const second = await openSqliteStore({ path: join(dir, "data", "runwright.db"), clock });
  const other = createTriggerScheduler({ store: second, clock, tickMs: 20, logger: createLogger({ level: "error", clock, write: () => undefined }) });
  t.after(async () => {
    await other.stop();
    await second.close();
  });
  other.start();

  const { agent } = await client.saveAgent(scriptedAgent({ name: "Minutely", script: { turns: [{ text: "done" }] } }), "minutely");
  const trigger = await client.createTrigger({
    name: "every minute", kind: "cron", agentId: agent.id, cron: { expression: "* * * * *" }, message: "work", limits: { maxCostMicros: 50_000 },
  });
  const cursors: number[] = [trigger.nextFireAt as number];
  const cursor = async (): Promise<number> => {
    const value = (await client.getTrigger(trigger.id)).nextFireAt as number;
    cursors.push(value);
    return value;
  };
  const runs = async () => (await client.listRuns({ triggerId: trigger.id })).runs;

  clock.advance(61_000);
  await waitFor(async () => (await runs()).length === 1 && (await cursor()) === start + 2 * MINUTE, { timeoutMs: 5000 });
  clock.advance(5 * MINUTE);
  await waitFor(async () => (await runs()).length === 2, { timeoutMs: 5000 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const all = await runs();
  assert.equal(all.length, 2, "one run per coalesced slot, whichever scheduler fired it");
  const latest = all.find((run) => (run.input.data as { scheduledFor?: string }).scheduledFor === new Date(start + 2 * MINUTE).toISOString());
  assert.ok(latest !== undefined, JSON.stringify(all.map((run) => run.input.data)));
  assert.equal((latest.input.data as { missedFires: number }).missedFires, 4);
  const last = await cursor();
  assert.ok(last > clock.now(), "the cursor is later than the clock");
  assert.equal(last, start + 7 * MINUTE);
  for (let i = 1; i < cursors.length; i++) {
    assert.ok((cursors[i] as number) >= (cursors[i - 1] as number), `the cursor never decreased: ${cursors.join(", ")}`);
  }
});

test("R08-01: a redelivered webhook keeps its run through an edit and a disable; a new delivery is refused", { timeout: 20_000 }, async (t) => {
  const { app, client } = await startTestApp(t);
  const secret = "webhook-signing-secret-9090";
  await client.setSecret("HOOK_SECRET", secret);
  const { agent } = await client.saveAgent(scriptedAgent({ name: "Hook target", script: { turns: [{ text: "hook handled" }] } }), "hook-target");
  const trigger = await client.createTrigger({
    name: "deploys", kind: "webhook", agentId: agent.id, webhook: { secretName: "HOOK_SECRET" }, message: "a deploy happened", limits: { maxCostMicros: 50_000 },
  });
  const deliver = async (delivery: string): Promise<{ status: number; body: { runId?: string; duplicate?: boolean; error?: { code: string } } }> => {
    const body = Buffer.from(JSON.stringify({ delivery, service: "api" }));
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

  const first = await deliver("delivery-1");
  assert.deepEqual([first.status, first.body.duplicate], [202, false]);
  await client.updateTrigger(trigger.id, { message: "a deploy happened, look closer" });
  assert.deepEqual(await deliver("delivery-1"), { status: 202, body: { runId: first.body.runId, duplicate: true } });
  await client.updateTrigger(trigger.id, { enabled: false });
  assert.deepEqual(await deliver("delivery-1"), { status: 202, body: { runId: first.body.runId, duplicate: true } });
  const fresh = await deliver("delivery-2");
  assert.equal(fresh.status, 409);
  assert.equal(fresh.body.error?.code, "trigger_disabled");
  assert.deepEqual((await client.listRuns({ triggerId: trigger.id })).runs.map((r) => r.id), [first.body.runId], "one run");
});

test("R08-03: a workflow deadline above the timer limit is refused at save; the limit itself runs to the end", { timeout: 20_000 }, async (t) => {
  const { client } = await startTestApp(t);
  const refused = await rejection(client.saveAgent(deadlineAgent("Too long", 2147483648), "too-long"));
  assert.equal(refused.status, 400);
  assert.ok(refused.problems.some((p) => p.path.endsWith("root.deadlineMs")), JSON.stringify(refused.problems));

  const { agent } = await client.saveAgent(deadlineAgent("Longest", 2147483647), "longest");
  const { run } = await client.startRun({ agentId: agent.id, data: {} });
  const { run: done } = await waitForStatus(client, run.id, ["completed", "failed", "cancelled", "waiting"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.deepEqual(done.output, "ok");
});

test("R08-03: a duration setting above the timer limit is refused when the configuration is loaded", async (t) => {
  const dataDir = await makeTempDir(t, "runwright-e2e-config-");
  await assert.rejects(loadConfig({ env: { RUNWRIGHT_POLL_MS: "3000000000" }, overrides: { dataDir } }), (error: unknown) => {
    assert.ok(isRunwrightError(error));
    assert.equal(error.code, "config_invalid");
    assert.match(error.message, /\$\.runner\.pollMs/);
    return true;
  });
});
