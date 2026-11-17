/**
 * Finding R10-04 (the class test): a numeric secret handed to a run is stored nowhere as a number when it sits in
 * a caller, model, tool or driver value. The secret PIN = 12345678 goes in through the run's input data, comes
 * back from a host tool's handler as structured data and content, and is the run's cost cap. After the run, the
 * SQLite file (every text column of every table, enumerated from the schema), the archive file and every file in
 * the run's workspace hold the digits only where the engine owns the number (the cap), each hit named by path.
 * The cap still works as a number, and a second run that waits across an app restart replays over the redacted
 * values and completes.
 */
import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { gunzipSync } from "node:zlib";
import { createApp, type App } from "../../src/app/app.ts";
import { createClient, type RunwrightClient } from "../../src/client/index.ts";
import { loadConfig } from "../../src/config/load.ts";
import { systemClock } from "../../src/core/clock.ts";
import { archiveFinishedRuns } from "../../src/ops/retention.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import { callTurn, scriptedAgent, waitForStatus } from "../fixtures/runs.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { waitFor } from "../helpers/wait.ts";

const DIGITS = "12345678";
const PIN = 12345678;

/** The number comes from the handler, never from the agent definition (definitions are stored as given). */
const echoNumber: ToolDefinition = {
  name: "echo_number", description: "Returns a number it holds.", parameters: { type: "object", properties: {} }, effect: "read",
  handler: async () => ({ content: `echo ${PIN}`, data: { echo: PIN, list: [PIN, 7] } }),
};
/** A result whose structured data is over the result limit, so the full data is saved in the workspace. */
const bulkNumber: ToolDefinition = {
  name: "bulk_number", description: "Returns a large value holding a number.", parameters: { type: "object", properties: {} }, effect: "read",
  handler: async () => ({ content: "bulk", data: { pad: "x".repeat(400), pin: PIN } }),
};

async function makeApp(t: TestContext, dir: string): Promise<{ app: App; client: RunwrightClient }> {
  const config = await loadConfig({ env: {}, overrides: { dataDir: join(dir, "data"), port: 0, leaseMs: 400, pollMs: 20 } });
  config.tools.resultBytes = 256;
  const consolePath = join(dir, "console.html");
  await writeFile(consolePath, "<!doctype html><title>Runwright</title>\n");
  const app = await createApp({ config, env: {}, consolePath, tools: [echoNumber, bulkNumber], logWrite: () => undefined });
  t.after(() => app.stop({ graceMs: 200 }));
  await app.start();
  return { app, client: createClient({ baseUrl: app.url, token: app.token }) };
}

/** Every place inside a JSON value whose text holds the digits: `$.a.b[0]` for a value, `$.a{key}` for a key. */
function digitPaths(value: unknown, path: string, out: string[]): void {
  if (typeof value === "string") {
    if (value.includes(DIGITS)) out.push(path);
  } else if (typeof value === "number") {
    if (JSON.stringify(value).includes(DIGITS)) out.push(`${path}=number`);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => digitPaths(item, `${path}[${index}]`, out));
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key.includes(DIGITS)) out.push(`${path}{${key}}`);
      digitPaths(item, `${path}.${key}`, out);
    }
  }
}

function textHits(label: string, text: string): string[] {
  if (!text.includes(DIGITS)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [`${label} (not JSON)`];
  }
  const paths: string[] = [];
  digitPaths(parsed, "$", paths);
  return paths.length === 0 ? [`${label} (in the JSON text)`] : paths.map((path) => `${label} ${path}`);
}

/** Every hit in every text-like column of every table, labelled `table.column[type] path`, sorted. */
function scanDatabase(path: string): string[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const hits: string[] = [];
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
    assert.ok(tables.length > 5, "the schema was enumerated");
    for (const { name: table } of tables) {
      const quoted = `"${table.replaceAll('"', '""')}"`;
      const columns = (db.prepare(`PRAGMA table_info(${quoted})`).all() as { name: string; type: string }[])
        .filter((column) => /TEXT|BLOB|CHAR|CLOB/i.test(column.type) || column.type === "").map((column) => column.name);
      for (const row of db.prepare(`SELECT * FROM ${quoted}`).all() as Record<string, unknown>[]) {
        const type = typeof row["type"] === "string" ? `[${row["type"]}]` : "";
        for (const column of columns) {
          const cell = row[column];
          const text = typeof cell === "string" ? cell : cell instanceof Uint8Array ? Buffer.from(cell).toString("utf8") : null;
          if (text !== null) hits.push(...textHits(`${table}.${column}${type}`, text));
        }
      }
    }
    return hits.sort();
  } finally {
    db.close();
  }
}

async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

test("a numeric secret in caller, model, tool and driver values is stored as the placeholder; the engine's numbers stay numbers", { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t, "runwright-numbers-");
  const first = await makeApp(t, dir);
  await first.client.setSecret("PIN", DIGITS);

  const { agent } = await first.client.saveAgent(scriptedAgent({
    name: "Echo", secrets: ["PIN"], tools: [{ name: "echo_number" }, { name: "bulk_number" }],
    script: { turns: [callTurn("echo_number", {}), callTurn("bulk_number", {}), { text: "saw {{last_result}}" }] },
  }), "echo");
  const { agent: asker } = await first.client.saveAgent(scriptedAgent({
    name: "Asker", secrets: ["PIN"], tools: [{ name: "echo_number" }, { name: "ask_person" }],
    script: { turns: [callTurn("echo_number", {}), callTurn("ask_person", { question: "Go on?" }), { text: "after {{last_result}}" }] },
  }), "asker");

  const { run: started } = await first.client.startRun({
    agentId: agent.id, message: "go", data: { credential: PIN, nested: [PIN] }, limits: { maxCostMicros: PIN },
  });
  const { run: done } = await waitForStatus(first.client, started.id, ["completed", "failed", "cancelled"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));

  // The cap is an engine number and still works as one (read from the store: the API boundary redacts it).
  const stored = await first.app.store.getRun(started.id);
  assert.ok(stored !== null);
  assert.equal(stored.limits.maxCostMicros, PIN);
  assert.equal(typeof stored.journalSeq, "number");
  assert.equal(typeof stored.usage.inputTokens, "number");
  assert.equal(typeof stored.usage.costMicros, "number");
  assert.ok(stored.journalSeq > 4);
  const finished = (await first.app.store.readJournal(started.id)).find((record) => record.type === "tool.finished" && record.data["tool"] === "echo_number");
  assert.equal(typeof finished?.data["durationMs"], "number");
  assert.deepEqual(finished?.data["data"], { echo: "[redacted:PIN]", list: ["[redacted:PIN]", 7] }, "the tool's data is in the journal, redacted");

  // The second run waits on its question across an app restart; its replay runs over the redacted values.
  const { run: waiting } = await first.client.startRun({ agentId: asker.id, message: "ask", data: { credential: PIN } });
  const question = await waitFor(async () => (await first.client.getRun(waiting.id)).pendings.find((p) => p.kind === "question") ?? null, {
    timeoutMs: 10_000, intervalMs: 20, message: "the second run never asked",
  });
  await first.app.stop({ graceMs: 200 });
  const second = await makeApp(t, dir);
  await second.client.answer(question.id, "yes");
  const { run: resumed } = await waitForStatus(second.client, waiting.id, ["completed", "failed", "cancelled"]);
  assert.equal(resumed.status, "completed", JSON.stringify(resumed.error));
  const echoes = (await second.app.store.readJournal(waiting.id)).filter((record) => record.type === "tool.finished" && record.data["tool"] === "echo_number");
  assert.equal(echoes.length, 1, "the tool ran once: the resume replayed its stored result");

  // 1. Every text column of every table: only the cap of the first run, in its row and in its run.created record.
  const allowed = [
    "journal.data[run.created] $.limits.maxCostMicros=number",
    "runs.limits $.maxCostMicros=number",
  ];
  const database = join(second.app.config.dataDir, "runwright.db");
  assert.deepEqual(scanDatabase(database), allowed);

  // 2. The archive files: only the cap in run.created.
  const archive = await archiveFinishedRuns({ store: second.app.store, clock: systemClock, dataDir: second.app.config.dataDir }, { olderThanMs: 0 });
  assert.deepEqual(archive.archived.map((a) => a.runId).sort(), [started.id, waiting.id].sort(), JSON.stringify(archive.skipped));
  const archiveFiles = (await filesUnder(join(second.app.config.dataDir, "archive"))).filter((file) => file.endsWith(".jsonl.gz"));
  assert.equal(archiveFiles.length, 2);
  const archiveHits: string[] = [];
  let placeholders = 0;
  for (const file of archiveFiles) {
    const lines = gunzipSync(await readFile(file)).toString("utf8").split("\n").filter((line) => line !== "");
    for (const line of lines) {
      placeholders += line.includes("[redacted") ? 1 : 0;
      const record = JSON.parse(line) as { type: string };
      archiveHits.push(...textHits(`archive[${record.type}]`, line));
    }
  }
  assert.deepEqual(archiveHits, ["archive[run.created] $.data.limits.maxCostMicros=number"]);
  assert.ok(placeholders > 0, "the placeholder is what the archive holds");
  assert.deepEqual(scanDatabase(database), ["runs.limits $.maxCostMicros=number"], "after archiving only the run row's cap is left");

  // 3. The workspaces: the saved full results (small result limit) hold the placeholder, never the digits.
  const workspaceFiles = await filesUnder(join(second.app.config.dataDir, "workspaces"));
  const saved = workspaceFiles.filter((file) => file.endsWith(".data.json"));
  assert.equal(saved.length, 1, `the full data of bulk_number was saved: ${workspaceFiles.join(", ")}`);
  for (const file of workspaceFiles) {
    const text = await readFile(file, "utf8");
    assert.equal(text.includes(DIGITS), false, `workspace file ${file}`);
  }
  for (const file of saved) assert.match(await readFile(file, "utf8"), /\[redacted/);
});
