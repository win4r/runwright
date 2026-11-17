/**
 * Finding R02-03 through real child processes: a secret set over the API and named by an agent is pushed in
 * through the run's message and data, a message command and the answer to the agent's question. After the host
 * stops, the database file holds no form of it (`secretForms`) in `runs.input`, `journal.data` or
 * `commands.payload`, nor in any other text column. Then the secret is deleted through the API and the host
 * restarted twice, so no process knows the value any more: the run, its timeline and the files written by
 * `runwright retention archive` (a real CLI process) still do not contain it.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import type { RunwrightClient } from "../../src/client/index.ts";
import type { PendingRecord } from "../../src/store/types.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { waitFor } from "../helpers/wait.ts";
import { clientOf, startHost, type HostProcess } from "../fixtures/process.ts";
import { callTurn, fullTimeline, scriptedAgent, waitForStatus } from "../fixtures/runs.ts";
import { BIN, ROOT } from "../cli/support.ts";
import { formsIn, scanDatabase } from "../security/at-rest.ts";

const run = promisify(execFile);
/** A quote, a backslash, a space, "/" and "?>" so the JSON-escaped, percent and base64url forms all differ. */
const SECRET = 'e2e "intake" key \\ 7/abc?>';
const NAME = "INTAKE_KEY";
/** Sealed values, and definitions / workflow documents (stored as given, documented as not covered). */
const EXCLUDED_TABLES = ["secrets", "agent_revisions", "workflows"];

async function stop(host: HostProcess): Promise<void> {
  host.kill("SIGTERM");
  const { code } = await host.stopped;
  assert.equal(code, 0, host.stderr());
}

function columnTexts(dbPath: string, sql: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare(sql).all() as { text: string }[]).map((row) => row.text);
  } finally {
    db.close();
  }
}

async function openQuestion(client: RunwrightClient, runId: string): Promise<PendingRecord> {
  return waitFor(async () => (await client.getRun(runId)).pendings.find((p) => p.kind === "question") ?? null, {
    timeoutMs: 15_000, intervalMs: 20, message: "the run never asked its question",
  });
}

async function startServer(t: TestContext, dataDir: string): Promise<{ host: HostProcess; client: RunwrightClient }> {
  const host = await startHost(t, { RUNWRIGHT_DATA_DIR: dataDir, HOST_POLL_MS: "20" });
  return { host, client: clientOf(host) };
}

test("a secret handed in through every intake is not at rest, also after it is deleted and nobody knows it", { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t, "runwright-e2e-intake-");
  const dataDir = join(dir, "data");
  const dbPath = join(dataDir, "runwright.db");

  const first = await startServer(t, dataDir);
  await first.client.setSecret(NAME, SECRET);
  const { agent } = await first.client.saveAgent(scriptedAgent({
    name: "Asker", secrets: [NAME], tools: [{ name: "ask_person" }],
    script: { turns: [callTurn("ask_person", { question: "Which value?" }), { text: "noted: {{last_result}}" }] },
  }), "asker");
  const { run: created } = await first.client.startRun({
    agentId: agent.id, message: `use ${SECRET} please`, data: { value: SECRET, [SECRET]: [`x${SECRET}y`] },
  });
  assert.deepEqual(formsIn(JSON.stringify(created), SECRET), [], "the created run comes back redacted");
  const question = await openQuestion(first.client, created.id);
  await first.client.sendMessage(created.id, `and also ${SECRET}`);
  await first.client.answer(question.id, `the value is ${SECRET}`);
  const { run: done } = await waitForStatus(first.client, created.id, ["completed", "failed", "cancelled"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  await stop(first.host);

  for (const [label, sql] of [
    ["runs.input", "SELECT input AS text FROM runs"],
    ["journal.data", "SELECT data AS text FROM journal"],
    ["commands.payload", "SELECT payload AS text FROM commands"],
  ] as const) {
    const texts = columnTexts(dbPath, sql);
    assert.ok(texts.length > 0, `${label} has rows`);
    assert.deepEqual(texts.flatMap((text) => formsIn(text, SECRET)), [], `no form of the secret in ${label}`);
  }
  assert.ok(columnTexts(dbPath, "SELECT input AS text FROM runs")[0]?.includes("[redacted]"), "the placeholder was stored");
  assert.ok(columnTexts(dbPath, "SELECT payload AS text FROM commands").some((text) => text.includes("[redacted]")));
  assert.deepEqual(scanDatabase(dbPath, SECRET, EXCLUDED_TABLES), [], "no form of the secret in any text column");

  const second = await startServer(t, dataDir);
  await second.client.deleteSecret(NAME);
  assert.equal((await second.client.secretStatus(NAME)).set, false);
  await stop(second.host);

  const third = await startServer(t, dataDir);
  assert.deepEqual(formsIn(JSON.stringify(await third.client.getRun(created.id)), SECRET), [], "GET /v1/runs/:id");
  const records = await fullTimeline(third.client, created.id);
  assert.ok(records.length > 0);
  assert.deepEqual(formsIn(JSON.stringify(records), SECRET), [], "the timeline");
  await stop(third.host);

  await new Promise((resolve) => setTimeout(resolve, 5));
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("RUNWRIGHT_")) env[key] = value;
  const archived = await run(process.execPath, [BIN, "retention", "archive", "--older-than", "0", "--data-dir", dataDir, "--json"], { cwd: ROOT, env });
  const result = JSON.parse(archived.stdout) as { archived: { runId: string; path: string }[] };
  assert.deepEqual(result.archived.map((a) => a.runId), [created.id]);
  const archiveRoot = join(dataDir, "archive");
  const files = (await readdir(archiveRoot, { recursive: true })).filter((name) => name.endsWith(".jsonl.gz"));
  assert.equal(files.length, 1);
  const archiveText = gunzipSync(await readFile(join(archiveRoot, files[0] as string))).toString("utf8");
  assert.ok(archiveText.includes("[redacted]"));
  assert.deepEqual(formsIn(archiveText, SECRET), [], "the archive file");
  assert.deepEqual(scanDatabase(dbPath, SECRET, EXCLUDED_TABLES), [], "the database after archiving");
});
