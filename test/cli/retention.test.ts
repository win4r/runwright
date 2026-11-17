import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { mkdir, readFile } from "node:fs/promises";
import { openSqliteStore } from "../../src/store/sqlite.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { cli, finish, parsed, seed } from "./support.ts";

test("retention archive moves finished runs' journals straight from the data directory", async (t) => {
  const dir = await makeTempDir(t);
  const store = await openSqliteStore({ path: join(dir, "runwright.db") });
  const done = await seed(store);
  await finish(store, done.id, "completed");
  const failed = await seed(store);
  await finish(store, failed.id, "failed");
  const live = await seed(store);
  await store.close();
  await new Promise((resolve) => setTimeout(resolve, 5));

  const result = await cli(["retention", "archive", "--older-than", "0", "--data-dir", dir], { dataDir: dir });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const { archived, skipped } = parsed<{ archived: { runId: string; path: string; records: number }[]; skipped: unknown[] }>(result);
  assert.deepEqual(archived.map((a) => a.runId).sort(), [done.id, failed.id].sort());
  assert.deepEqual(skipped, []);
  for (const entry of archived) {
    assert.ok(entry.path.startsWith(join(dir, "archive")));
    const lines = gunzipSync(await readFile(entry.path)).toString("utf8").trimEnd().split("\n");
    assert.equal(lines.length, entry.records);
  }

  const reopened = await openSqliteStore({ path: join(dir, "runwright.db") });
  t.after(() => reopened.close());
  assert.notEqual((await reopened.getRun(done.id))?.journalArchivedAt, null);
  assert.equal((await reopened.getRun(live.id))?.journalArchivedAt, null);

  const again = await cli(["retention", "archive", "--older-than", "0"], { dataDir: dir, isTTY: true });
  assert.equal(again.stdout, "Nothing to archive.\n");
});

test("retention archive keeps runs newer than the cut-off, needs --older-than and a database", async (t) => {
  const dir = await makeTempDir(t);
  const store = await openSqliteStore({ path: join(dir, "runwright.db") });
  const done = await seed(store);
  await finish(store, done.id, "completed");
  await store.close();
  const recent = await cli(["retention", "archive", "--older-than", "30"], { dataDir: dir });
  assert.deepEqual(parsed(recent), { archived: [], skipped: [] });
  assert.equal((await cli(["retention", "archive"], { dataDir: dir })).code, 2);
  const empty = await makeTempDir(t);
  const missing = await cli(["retention", "archive", "--older-than", "1"], { dataDir: empty });
  assert.equal(missing.code, 1);
  assert.equal(parsed<{ error: { code: string } }>(missing).error.code, "not_found");
  assert.equal(existsSync(join(empty, "runwright.db")), false, "no database is created");
});

test("retention archive prints the runs it skipped, with the reason, and still exits 0", async (t) => {
  const dir = await makeTempDir(t);
  const store = await openSqliteStore({ path: join(dir, "runwright.db") });
  const blocked = await finish(store, (await seed(store)).id, "completed");
  const done = await finish(store, (await seed(store)).id, "cancelled");
  await store.close();
  const finished = new Date(blocked.finishedAt ?? 0);
  const month = `${finished.getUTCFullYear()}-${String(finished.getUTCMonth() + 1).padStart(2, "0")}`;
  await mkdir(join(dir, "archive", month, `${blocked.id}.jsonl.gz`), { recursive: true });
  await new Promise((resolve) => setTimeout(resolve, 5));

  const result = await cli(["retention", "archive", "--older-than", "0"], { dataDir: dir, isTTY: true });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const lines = result.stdout.trimEnd().split("\n");
  assert.ok(lines.some((line) => line.includes(done.id)), result.stdout);
  assert.ok(lines.includes("Archived 1 run journal(s)."), result.stdout);
  assert.ok(lines.includes("Skipped 1 run(s):"), result.stdout);
  const skippedLine = lines.find((line) => line.startsWith(`${blocked.id}: `));
  assert.ok(skippedLine !== undefined && skippedLine.length > blocked.id.length + 2, result.stdout);

  const json = await cli(["retention", "archive", "--older-than", "0"], { dataDir: dir });
  assert.equal(json.code, 0);
  const report = parsed<{ archived: unknown[]; skipped: { runId: string; reason: string }[] }>(json);
  assert.deepEqual(report.archived, []);
  assert.deepEqual(report.skipped.map((s) => s.runId), [blocked.id]);
  assert.equal(typeof report.skipped[0]?.reason, "string");
});

test("(R15-03) retention archive reclaims a journal of 1 MiB records, one line per record", { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const store = await openSqliteStore({ path: join(dir, "runwright.db") });
  const run = await seed(store);
  const claimed = await store.claimRuns({ runnerId: "big-writer", limit: 10, leaseMs: 60_000 });
  const mine = claimed.find((c) => c.run.id === run.id);
  assert.ok(mine !== undefined);
  for (let i = 0; i < 40; i++) {
    await store.commit(mine.lease, { records: [{ type: "note", key: `big${i}`, data: { i, pad: String.fromCharCode(97 + (i % 26)).repeat(1024 * 1024) } }] });
  }
  await store.commit(mine.lease, { records: [{ type: "run.completed", data: {} }], transition: { to: "completed", output: "ok" } });
  const journal: unknown[] = [];
  for (let page = await store.readJournal(run.id, { limit: 10 }); page.length > 0; page = await store.readJournal(run.id, { afterSeq: journal.length, limit: 10 })) {
    journal.push(...page);
  }
  await store.close();
  await new Promise((resolve) => setTimeout(resolve, 5));

  const result = await cli(["retention", "archive", "--older-than", "0"], { dataDir: dir });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const { archived, skipped } = parsed<{ archived: { runId: string; path: string; records: number }[]; skipped: unknown[] }>(result);
  assert.deepEqual(skipped, []);
  assert.deepEqual(archived.map((a) => [a.runId, a.records]), [[run.id, journal.length]]);
  const lines = gunzipSync(await readFile(archived[0]?.path ?? "")).toString("utf8").trimEnd().split("\n");
  assert.deepEqual(lines, journal.map((record) => JSON.stringify(record)));

  const reopened = await openSqliteStore({ path: join(dir, "runwright.db") });
  t.after(() => reopened.close());
  assert.notEqual((await reopened.getRun(run.id))?.journalArchivedAt, null);
  assert.deepEqual(await reopened.readJournal(run.id), [], "the journal rows are reclaimed");
});
