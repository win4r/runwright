/**
 * Finding R01-01 with real processes: two `runwright retention archive` processes start at the same moment over
 * one data directory. Every finished run is archived exactly once across the two reports, every archive holds
 * exactly the journal it replaced, no journal rows and no temp files are left, and neither process reports a run
 * the other one finished as skipped.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { createFakeClock, type FakeClock } from "../../src/core/clock.ts";
import { openSqliteStore } from "../../src/store/sqlite.ts";
import type { JournalRecord, Store } from "../../src/store/types.ts";
import { bin } from "../cli/support.ts";
import { testAgentDefinition } from "../helpers/store.ts";
import { makeTempDir } from "../helpers/tmp.ts";

const RUNS = 60;

interface Report { archived: { runId: string; path: string; records: number }[]; skipped: { runId: string; reason: string }[] }

async function finishRun(store: Store, clock: FakeClock, agentId: string, index: number): Promise<string> {
  clock.advance(1);
  const { run } = await store.createRun({ agentId, input: { message: `job ${index}`, data: null } });
  const claimed = await store.claimRuns({ runnerId: "seeder", limit: 1, leaseMs: 60_000 });
  const mine = claimed.find((c) => c.run.id === run.id);
  assert.ok(mine !== undefined, "the seeder claimed the run it created");
  for (let i = 0; i < 1 + (index % 4); i++) await store.commit(mine.lease, { records: [{ type: "note", key: `s${i}`, data: { i, index } }] });
  await store.commit(mine.lease, { records: [{ type: "run.finished", data: { index } }], transition: { to: "completed", output: "ok" } });
  return run.id;
}

async function filesUnder(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { recursive: true })).map(String);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

test("two retention archive processes at once archive every run exactly once", { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t, "runwright-e2e-retention-");
  // The runs are seeded on a clock an hour in the past, so `--older-than 0` covers every one of them.
  const clock = createFakeClock(Date.now() - 3_600_000);
  const store = await openSqliteStore({ path: join(dir, "runwright.db"), clock });
  const { agent } = await store.saveAgent({ definition: testAgentDefinition() });
  const journals = new Map<string, JournalRecord[]>();
  for (let i = 0; i < RUNS; i++) {
    const id = await finishRun(store, clock, agent.id, i);
    journals.set(id, await store.readJournal(id));
  }
  await store.close();

  const argv = ["retention", "archive", "--older-than", "0", "--data-dir", dir, "--json"];
  const results = await Promise.all([bin(argv, { dataDir: dir }), bin(argv, { dataDir: dir })]);
  const reports: Report[] = results.map((result) => {
    assert.equal(result.code, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout) as Report;
  });

  for (const report of reports) assert.deepEqual(report.skipped, [], "a run the other process finished is not skipped");
  const archived = reports.flatMap((report) => report.archived);
  assert.deepEqual(archived.map((a) => a.runId).sort(), [...journals.keys()].sort(), "every run archived exactly once");

  for (const entry of archived) {
    const expected = journals.get(entry.runId) as JournalRecord[];
    assert.equal(entry.records, expected.length);
    const lines = gunzipSync(await readFile(entry.path)).toString("utf8").trimEnd().split("\n");
    assert.deepEqual(lines.map((line) => JSON.parse(line) as JournalRecord), expected, `archive of ${entry.runId}`);
  }

  const reopened = await openSqliteStore({ path: join(dir, "runwright.db") });
  t.after(() => reopened.close());
  for (const id of journals.keys()) {
    assert.deepEqual(await reopened.readJournal(id), [], `no journal rows left for ${id}`);
    assert.notEqual((await reopened.getRun(id))?.journalArchivedAt, null);
  }
  const files = await filesUnder(join(dir, "archive"));
  assert.deepEqual(files.filter((name) => name.endsWith(".tmp")), [], "no temp file remains");
  assert.equal(files.filter((name) => name.endsWith(".jsonl.gz")).length, RUNS);
});
