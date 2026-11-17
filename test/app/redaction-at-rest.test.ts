/**
 * The audit of redaction at intake (plan 4.3, finding R02-03): one secret is pushed through every way a caller
 * or a person hands text to an app, then everything at rest is scanned for every form of it: every TEXT and BLOB
 * column of every table of the database file, the archive files and the log lines; and again through the API
 * after the secret was deleted and the app restarted (so no redactor knows the value any more).
 */
import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { gunzipSync } from "node:zlib";
import { createApp, type App } from "../../src/app/app.ts";
import { createClient, type RunwrightClient } from "../../src/client/index.ts";
import { loadConfig } from "../../src/config/load.ts";
import { systemClock } from "../../src/core/clock.ts";
import { secretForms } from "../../src/core/redact.ts";
import { archiveFinishedRuns } from "../../src/ops/retention.ts";
import { isTerminal } from "../../src/store/state-machine.ts";
import type { PendingRecord, RunRecord } from "../../src/store/types.ts";
import { signWebhook } from "../../src/triggers/webhook.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import type { WorkflowDocument } from "../../src/workflow/types.ts";
import { createHostTools } from "../fixtures/host-tools.ts";
import { callTurn, fullTimeline, scriptedAgent, waitForStatus } from "../fixtures/runs.ts";
import { seedLearningItems } from "../helpers/learning.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { waitFor } from "../helpers/wait.ts";
import { formsIn, scanDatabase } from "../security/at-rest.ts";

/** Six distinct forms: a quote and a backslash (JSON-escaped), a space and "/" (percent), "?>" (base64url), padding. */
const SECRET = 'audit "tool" key \\ 42/xyz?>';
const HOOK_SECRET = "webhook-signing-secret-audit-1";

/**
 * Tables left out of the scan, by name:
 * - secrets: sealed values (the store never holds plaintext; a sealed blob is not a form of the value).
 * - agent_revisions and workflows: definitions and workflow documents are stored as given (documented in plan
 *   4.3: name a secret in a definition, never paste its value). The agents here hold no secret value anyway.
 */
const EXCLUDED_TABLES = ["secrets", "agent_revisions", "workflows"];

interface Started { app: App; client: RunwrightClient; logLines: string[] }

async function makeApp(t: TestContext, dir: string, logLines: string[]): Promise<App> {
  const config = await loadConfig({ env: {}, overrides: { dataDir: join(dir, "data"), port: 0, leaseMs: 400, pollMs: 20 } });
  config.log.level = "debug";
  config.triggers.tickMs = 20;
  const consolePath = join(dir, "console.html");
  await writeFile(consolePath, "<!doctype html><title>Runwright</title>\n");
  const app = await createApp({
    config, env: {}, consolePath, tools: createHostTools(join(dir, "effects.txt")), logWrite: (line) => logLines.push(line),
  });
  t.after(() => app.stop({ graceMs: 200 }));
  return app;
}

async function start(app: App, logLines: string[]): Promise<Started> {
  await app.start();
  return { app, client: createClient({ baseUrl: app.url, token: app.token }), logLines };
}

function hits(text: string): string[] {
  return formsIn(text, SECRET);
}

async function openPendingOf(client: RunwrightClient, runId: string, kind: PendingRecord["kind"]): Promise<PendingRecord> {
  return waitFor(async () => {
    const { run, pendings } = await client.getRun(runId);
    if (isTerminal(run.status)) throw new Error(`run ${runId} ended ${run.status} before its ${kind} pending`);
    return pendings.find((pending) => pending.kind === kind) ?? null;
  }, { timeoutMs: 15_000, intervalMs: 25 });
}

async function allRuns(client: RunwrightClient): Promise<RunRecord[]> {
  const out: RunRecord[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await client.listRuns({ limit: 200, ...(cursor === undefined ? {} : { cursor }) });
    out.push(...page.runs);
    if (page.nextCursor === null) return out;
    cursor = page.nextCursor;
  }
}

test("a secret pushed through every intake is nowhere at rest, before and after deleting it and restarting", { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t, "runwright-audit-");
  const logLines: string[] = [];
  const app = await makeApp(t, dir, logLines);

  // A learning item to edit, seeded before the runner starts claiming.
  await app.store.saveAgent({ id: "learner", definition: scriptedAgent({ name: "Learner", script: { turns: [{ text: "ok" }] } }) });
  const [item] = await seedLearningItems(app.store, "learner", [
    { kind: "note", name: "build", title: "Build", description: "How to build", body: "npm run build", status: "active" },
  ]);
  assert.ok(item !== undefined);

  const { client } = await start(app, logLines);
  await client.setSecret("TOOL_KEY", SECRET);
  await client.setSecret("HOOK_SECRET", HOOK_SECRET);
  const b64 = secretForms(SECRET)[1] as string;

  const { agent: asker } = await client.saveAgent(scriptedAgent({
    name: "Asker", secrets: ["TOOL_KEY"], tools: [{ name: "ask_person" }],
    script: { turns: [callTurn("ask_person", { question: "Which value?" }), { text: "got {{last_result}}" }] },
  }), "asker");
  const { agent: approver } = await client.saveAgent(scriptedAgent({
    name: "Approver", secrets: ["TOOL_KEY"], tools: [{ name: "write_file", policy: "ask" }],
    script: { turns: [callTurn("write_file", { path: "out.txt", content: "x" }), { text: "done" }] },
  }), "approver");
  const { agent: echo } = await client.saveAgent(scriptedAgent({
    name: "Echo", secrets: ["TOOL_KEY"], script: { turns: [{ text: "handled" }] },
  }), "echo");
  const workflow = {
    format: "runwright.workflow/v1", name: "audit",
    schemas: { in: { type: "object", required: ["label"], properties: { label: { type: "string" } } }, out: {} },
    input: "in", output: "out",
    root: { id: "rec", kind: "tool", tool: "record_effect", args: { label: { $ref: "input.label" } } },
    result: { $ref: "steps.rec" },
  } as unknown as WorkflowDocument;
  const { agent: flow } = await client.saveAgent({
    ...scriptedAgent({ name: "Flow", secrets: ["TOOL_KEY"], tools: [{ name: "record_effect" }], script: { turns: [{ text: "unused" }] } }),
    workflow,
  }, "flow");

  // Run message and data (as a value and as a key), a message command and the answer to the question.
  const asked = (await client.startRun({
    agentId: asker.id, message: `remember ${SECRET}`, data: { value: SECRET, [SECRET]: [b64], nested: { list: [`x${SECRET}y`] } },
  })).run;
  assert.equal(hits(JSON.stringify(asked)).length, 0, "the created run comes back redacted");
  const question = await openPendingOf(client, asked.id, "question");
  await client.sendMessage(asked.id, `also ${SECRET}`);
  await client.answer(question.id, `the answer is ${SECRET}`);

  // A cancel reason on a second run (waiting on its question).
  const cancelled = (await client.startRun({ agentId: asker.id, message: "ask" })).run;
  await openPendingOf(client, cancelled.id, "question");
  await client.cancelRun(cancelled.id, `stop: ${b64}`);

  // A deny reason on an approval.
  const denied = (await client.startRun({ agentId: approver.id, message: "write" })).run;
  const approval = await openPendingOf(client, denied.id, "approval");
  await client.deny(approval.id, `not with ${encodeURIComponent(SECRET)}`);

  // A workflow run whose input data carries the secret.
  const flowed = (await client.startRun({ agentId: flow.id, data: { label: SECRET } })).run;

  // Triggers: the message at creation and in an update, a manual fire and a signed webhook delivery.
  const cron = await client.createTrigger({
    name: `nightly ${SECRET}`, kind: "cron", agentId: echo.id, cron: { expression: "0 0 1 1 *", timeZone: "UTC" },
    message: `cron says ${SECRET}`, limits: { maxCostMicros: 50_000 },
  });
  await client.updateTrigger(cron.id, { message: `cron now says ${SECRET}` });
  const fired = await client.fireTrigger(cron.id, { from: SECRET, [SECRET]: 1 });
  const hook = await client.createTrigger({
    name: "deploys", kind: "webhook", agentId: echo.id, webhook: { secretName: "HOOK_SECRET" },
    message: `hook says ${SECRET}`, limits: { maxCostMicros: 50_000 },
  });
  const body = Buffer.from(JSON.stringify({ delivery: "delivery-1", token: SECRET, [SECRET]: true }));
  const timestamp = Math.floor(Date.now() / 1000);
  const delivered = await fetch(`${app.url}/v1/hooks/${hook.id}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json", "X-Runwright-Timestamp": String(timestamp),
      "X-Runwright-Signature": signWebhook(HOOK_SECRET, timestamp, body), "X-Runwright-Delivery": "delivery-1",
    },
    body,
  });
  assert.equal(delivered.status, 202);
  const { runId: hookRunId } = (await delivered.json()) as { runId: string };

  // A person's learning edit carrying the secret is refused.
  const edit = await fetch(`${app.url}/v1/learning/${item.id}`, {
    method: "PATCH", body: JSON.stringify({ body: `use ${SECRET}` }),
    headers: { Authorization: `Bearer ${app.token}`, "Content-Type": "application/json", "If-Match": `"${item.etag}"` },
  });
  assert.equal(edit.status, 400);
  assert.equal(hits(await edit.text()).length, 0);

  // Every run finishes.
  const expected = [asked.id, cancelled.id, denied.id, flowed.id, fired.run.id, hookRunId];
  for (const runId of expected) await waitForStatus(client, runId, ["completed", "failed", "cancelled"]);
  assert.equal((await client.getRun(asked.id)).run.status, "completed");
  assert.equal((await client.getRun(cancelled.id)).run.status, "cancelled");
  assert.equal((await client.getRun(denied.id)).run.status, "completed");
  const runs = await allRuns(client);
  assert.ok(runs.every((run) => isTerminal(run.status)), runs.map((run) => `${run.id} ${run.status}`).join(", "));
  assert.equal((await client.getTrigger(cron.id)).message, "cron now says [redacted]");

  // Every TEXT and BLOB column of every table (but the excluded ones).
  const database = join(app.config.dataDir, "runwright.db");
  assert.deepEqual(scanDatabase(database, SECRET, EXCLUDED_TABLES), [], "no form of the secret in the database");
  assert.ok(scanDatabase(database, "[redacted]").length > 0, "the placeholder is what was stored");

  // The archives of some finished runs (the others keep their journal for the restart check below).
  const archive = await archiveFinishedRuns({ store: app.store, clock: systemClock, dataDir: app.config.dataDir }, { olderThanMs: 0, limit: 3 });
  assert.equal(archive.archived.length, 3, JSON.stringify(archive.skipped));
  const archiveRoot = join(app.config.dataDir, "archive");
  const files = (await readdir(archiveRoot, { recursive: true })).filter((name) => name.endsWith(".jsonl.gz"));
  assert.equal(files.length, 3);
  for (const file of files) {
    const text = gunzipSync(await readFile(join(archiveRoot, file))).toString("utf8");
    assert.ok(text.length > 0);
    assert.deepEqual(hits(text), [], `archive ${file}`);
  }
  assert.deepEqual(scanDatabase(database, SECRET, EXCLUDED_TABLES), []);

  // The log lines.
  assert.ok(logLines.length > 0);
  assert.deepEqual(logLines.filter((line) => hits(line).length > 0), [], "no log line holds the secret");

  // Delete the secret, restart on the same data directory, read everything back through the API.
  await client.deleteSecret("TOOL_KEY");
  await app.stop({ graceMs: 200 });
  const afterLines: string[] = [];
  const second = await start(await makeApp(t, dir, afterLines), afterLines);
  const reread = await allRuns(second.client);
  assert.equal(reread.length, runs.length);
  let journalled = 0;
  for (const run of reread) {
    const detail = await second.client.getRun(run.id);
    assert.deepEqual(hits(JSON.stringify(detail)), [], `run ${run.id}`);
    const records = await fullTimeline(second.client, run.id);
    journalled += records.length;
    assert.deepEqual(hits(JSON.stringify(records)), [], `timeline of ${run.id}`);
  }
  assert.ok(journalled > 0, "some timelines were still in the database");
  assert.deepEqual(hits(JSON.stringify(await second.client.listTriggers())), [], "the triggers");
  assert.deepEqual(hits(JSON.stringify(await second.client.listPendings({ status: "resolved" }))), [], "the resolved pendings");
  assert.deepEqual(hits(JSON.stringify(await second.client.listLearning())), [], "the learning items");
  assert.deepEqual(afterLines.filter((line) => hits(line).length > 0), []);
});

test("a secret the process knows but the run's agent does not name, echoed by a host tool, is stored as [redacted]", { timeout: 30_000 }, async (t) => {
  const value = `unnamed-${Date.now().toString(36)}-value/+=`;
  const dir = await makeTempDir(t, "runwright-audit-");
  const config = await loadConfig({ env: {}, overrides: { dataDir: join(dir, "data"), port: 0, leaseMs: 400, pollMs: 20 } });
  const consolePath = join(dir, "console.html");
  await writeFile(consolePath, "<!doctype html><title>Runwright</title>\n");
  const leak: ToolDefinition = {
    name: "leak_value", description: "Returns a value this process holds.", parameters: { type: "object", properties: {} }, effect: "read",
    handler: async () => ({ content: `the other run's key is ${value}`, data: { key: value } }),
  };
  const logLines: string[] = [];
  const app = await createApp({ config, env: {}, consolePath, tools: [leak], logWrite: (line) => logLines.push(line) });
  t.after(() => app.stop({ graceMs: 200 }));
  const { client } = await start(app, logLines);
  await client.setSecret("OTHER_RUN_KEY", value);
  const { agent } = await client.saveAgent(scriptedAgent({
    name: "Unnamed", tools: [{ name: "leak_value" }], script: { turns: [callTurn("leak_value", {}), { text: "saw {{last_result}}" }] },
  }), "unnamed");
  const { run } = await client.startRun({ agentId: agent.id, message: "go" });
  const { run: done } = await waitForStatus(client, run.id, ["completed", "failed"]);
  assert.equal(done.status, "completed");

  const records = await fullTimeline(client, run.id);
  const result = records.find((record) => record.type === "tool.finished" && record.data["tool"] === "leak_value");
  assert.equal(result?.data["content"], "the other run's key is [redacted]", "the store wrapper's process-wide layer replaced it");
  const text = records.find((record) => record.type === "model.finished" && String(record.data["text"]).startsWith("saw "));
  assert.equal(text?.data["text"], "saw the other run's key is [redacted]");
  assert.deepEqual(scanDatabase(join(app.config.dataDir, "runwright.db"), value, ["secrets"]), []);
  assert.deepEqual(logLines.filter((line) => formsIn(line, value).length > 0), []);
});
