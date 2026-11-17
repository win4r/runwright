/**
 * A provider's retry-after wait, end to end through `createApp`, the HTTP API (the client), the real agent loop,
 * the real workflow runtime and the scripted provider.
 *
 * Finding R07-01: a `Retry-After` longer than ten times `models.retry.maxMs` was shortened. Pinned here: a hint
 * is waited in full (the old clamp would have cut 400 ms to 100 ms); a hint over `models.retry.maxRetryAfterMs`
 * stops the run with `model_failed` and says why, and the config key is that limit; a restart during the wait
 * does not bring the next request forward; a workflow node's `retry` waits out the provider's wait and does not
 * undo an explicit stop.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentDefinition } from "../../src/agents/definition.ts";
import type { RunwrightClient } from "../../src/client/index.ts";
import type { Config } from "../../src/config/types.ts";
import type { ScriptedTurn } from "../../src/models/types.ts";
import type { JournalRecord } from "../../src/store/types.ts";
import { WORKFLOW_FORMAT, type WorkflowNode } from "../../src/workflow/types.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { waitFor } from "../helpers/wait.ts";
import { startTestApp } from "../fixtures/app.ts";
import { fullTimeline, scriptedAgent, waitForStatus } from "../fixtures/runs.ts";

const STOP_PREFIX = "model call not retried after 1 attempt (last error: status 429): the provider asked for a wait of 600000 ms, " +
  "more than models.retry.maxRetryAfterMs (300000 ms)";

/** A turn whose first provider attempt fails with HTTP 429 and a retry-after hint of `hintMs`. */
function hinted(hintMs: number, reply: Partial<ScriptedTurn> = { text: "ok" }): ScriptedTurn {
  return { ...reply, fail: { attempts: 1, status: 429, retryAfterMs: hintMs } };
}

/** A scripted agent with one turn that fails once with `hintMs`, then answers "ok". */
function hintedAgent(name: string, hintMs: number): AgentDefinition {
  return scriptedAgent({ name, script: { turns: [hinted(hintMs)] } });
}

/** A workflow agent whose root is the model node `ask`, retried by the node; every first provider attempt fails. */
function hintedWorkflowAgent(name: string, hintMs: number): AgentDefinition {
  const definition = scriptedAgent({ name, script: { steps: { ask: hinted(hintMs, { output: { text: "ok" } }) } } });
  const root: WorkflowNode = {
    id: "ask", kind: "model", prompt: "Say ok", output: "Summary", retry: { maxAttempts: 2, backoffMs: 1 },
  };
  definition.workflow = {
    format: WORKFLOW_FORMAT, name: "ask_flow",
    schemas: {
      Input: { type: "object" }, Output: {},
      Summary: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
    },
    input: "Input", output: "Output", root, result: { $ref: "steps.ask.text" },
  };
  return definition;
}

const ofType = (records: readonly JournalRecord[], type: string, key?: string): JournalRecord[] =>
  records.filter((r) => r.type === type && (key === undefined || r.key === key));

function only(records: readonly JournalRecord[], type: string, key?: string): JournalRecord {
  const found = ofType(records, type, key);
  assert.equal(found.length, 1, `exactly one ${type}${key === undefined ? "" : ` at ${key}`}`);
  return found[0] as JournalRecord;
}

async function runToEnd(client: RunwrightClient, agent: AgentDefinition, start: { message?: string; data?: Record<string, never> }) {
  const { agent: saved } = await client.saveAgent(agent, agent.name.toLowerCase());
  const { run } = await client.startRun({ agentId: saved.id, ...start });
  const { run: done } = await waitForStatus(client, run.id, ["completed", "failed", "cancelled", "waiting"]);
  return { run: done, records: await fullTimeline(client, run.id) };
}

const shortBackoff = (limitMs: number) => (config: Config): void => {
  config.models.retry.baseMs = 5;
  config.models.retry.maxMs = 10;
  config.models.retry.maxRetryAfterMs = limitMs;
};

test("R07-01: a hint longer than ten times maxMs is waited in full before the next attempt", { timeout: 20_000 }, async (t) => {
  const { client } = await startTestApp(t, { configure: shortBackoff(5000) });
  const { run, records } = await runToEnd(client, hintedAgent("Patient", 400), { message: "go" });
  assert.equal(run.status, "completed", JSON.stringify(run.error));

  const retry = only(records, "model.retry");
  assert.equal(retry.data["delayMs"], 400, "the hint is not shortened to 10 x maxMs = 100");
  assert.equal(retry.data["retryAfterMs"], 400);
  const started = ofType(records, "model.started");
  assert.equal(started.length, 2);
  const second = started[1] as JournalRecord;
  assert.ok(second.ts - retry.ts >= 380, `attempt 2 was sent ${second.ts - retry.ts} ms after model.retry`);
});

test("R07-01: a hint over the default limit stops the run with model_failed and says why", { timeout: 20_000 }, async (t) => {
  const { client } = await startTestApp(t);
  const startedAt = Date.now();
  const { run, records } = await runToEnd(client, hintedAgent("Stopped", 600_000), { message: "go" });
  assert.equal(run.status, "failed");
  assert.ok(Date.now() - startedAt < 10_000, "the run failed without waiting");
  assert.equal(run.error?.code, "model_failed");
  assert.ok(run.error?.message.startsWith(STOP_PREFIX), run.error?.message);

  assert.equal(ofType(records, "model.started").length, 1, "one request only");
  assert.equal(ofType(records, "model.retry").length, 0, "no retry");
  const failed = only(records, "model.failed");
  assert.equal(failed.data["retryAfterMs"], 600_000);
  assert.equal(failed.data["retryAfterOverLimit"], true);
});

test("R07-01: models.retry.maxRetryAfterMs is the limit", { timeout: 20_000 }, async (t) => {
  const { client } = await startTestApp(t, { configure: shortBackoff(200) });
  const { run, records } = await runToEnd(client, hintedAgent("Limited", 400), { message: "go" });
  assert.equal(run.status, "failed");
  assert.equal(run.error?.code, "model_failed");
  assert.match(run.error?.message ?? "", /the provider asked for a wait of 400 ms, more than models\.retry\.maxRetryAfterMs \(200 ms\)/);
  assert.equal(ofType(records, "model.started").length, 1);
  assert.equal(ofType(records, "model.retry").length, 0);
});

test("R07-01: a restart during the provider's wait does not bring the next request forward", { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t, "runwright-e2e-retry-after-restart-");
  const first = await startTestApp(t, { dir, configure: shortBackoff(5000) });
  const { agent } = await first.client.saveAgent(hintedAgent("Restarted", 2000), "restarted");
  const { run } = await first.client.startRun({ agentId: agent.id, message: "go" });
  await waitFor(async () => ofType(await fullTimeline(first.client, run.id), "model.retry").length === 1, {
    timeoutMs: 10_000, intervalMs: 10, message: "model.retry was never journalled",
  });
  await first.app.stop({ graceMs: 200 });

  const second = await startTestApp(t, { dir, configure: shortBackoff(5000) });
  const { run: done } = await waitForStatus(second.client, run.id, ["completed", "failed", "cancelled", "waiting"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));

  const records = await fullTimeline(second.client, run.id);
  assert.deepEqual(ofType(records, "run.claimed").map((r) => r.epoch), [1, 2], "the second app took the run over");
  const retry = only(records, "model.retry");
  assert.equal(retry.data["retryAfterMs"], 2000);
  const started = ofType(records, "model.started");
  assert.equal(started.length, 2, "two requests: the failed one and the one after the wait");
  const resumedStart = started[1] as JournalRecord;
  assert.equal(resumedStart.epoch, 2, "attempt 2 was sent by the second app");
  assert.ok(resumedStart.ts - retry.ts >= 1950, `attempt 2 was sent ${resumedStart.ts - retry.ts} ms after model.retry`);
});

test("R07-01: a workflow node's retry waits out the provider's wait", { timeout: 20_000 }, async (t) => {
  const { client } = await startTestApp(t, { configure: (config) => { config.models.retry.maxAttempts = 1; } });
  const { run, records } = await runToEnd(client, hintedWorkflowAgent("NodeRetry", 500), { data: {} });
  assert.equal(run.status, "failed", "every first provider attempt of the step fails, so both node attempts fail");

  only(records, "model.started", "wf/ask#1");
  const secondStart = only(records, "model.started", "wf/ask#2");
  const firstFailed = only(records, "model.failed", "wf/ask#1");
  assert.equal(firstFailed.data["retryAfterMs"], 500, "the exhausted call names the outstanding wait");
  const nodeRetry = only(records, "node.retry");
  assert.equal(nodeRetry.data["delayMs"], 500, "the node's 1 ms backoff is raised to the provider's wait");
  assert.ok(secondStart.ts - firstFailed.ts >= 480, `the node's attempt 2 was sent ${secondStart.ts - firstFailed.ts} ms after the failure`);
});

test("R07-01: a workflow node's retry does not undo an explicit stop", { timeout: 20_000 }, async (t) => {
  const { client } = await startTestApp(t);
  const { run, records } = await runToEnd(client, hintedWorkflowAgent("NodeStop", 600_000), { data: {} });
  assert.equal(run.status, "failed");
  assert.match(run.error?.message ?? "", /model call not retried after 1 attempt/);
  assert.equal(ofType(records, "model.started").length, 1, "one request only");
  assert.equal(ofType(records, "node.retry").length, 0, "the node did not retry");
  assert.equal(only(records, "model.failed").data["retryAfterOverLimit"], true);
});
