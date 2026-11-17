// R15-03: the archive writer holds one record, not one page, as a string. Proven structurally: the store hands the
// archiver pages of large records, and every chunk the writer hands the compressor is one record's line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Transform } from "node:stream";
import { createGzip, gunzipSync } from "node:zlib";
import { createFakeClock } from "../../src/core/clock.ts";
import { JOURNAL_PAGE, archiveFinishedRuns, verifyArchive } from "../../src/ops/retention.ts";
import type { JournalRecord, Store } from "../../src/store/types.ts";
import { openTestStore, testAgentDefinition } from "../helpers/store.ts";

const DAY = 86_400_000;
const MIB = 1024 * 1024;

/** A finished run whose journal holds `notes` small note records (plus its start and finish records). */
async function finishRun(store: Store, notes: number): Promise<string> {
  const { agent } = await store.saveAgent({ definition: testAgentDefinition() });
  const { run } = await store.createRun({ agentId: agent.id, input: { message: "big", data: null } });
  const claimed = await store.claimRuns({ runnerId: "runner-a", limit: 10, leaseMs: 60_000 });
  const mine = claimed.find((c) => c.run.id === run.id);
  assert.ok(mine !== undefined);
  await store.commit(mine.lease, { records: Array.from({ length: notes }, (_, i) => ({ type: "note", key: `s${i}`, data: { i } })) });
  await store.commit(mine.lease, { records: [{ type: "run.finished", data: {} }], transition: { to: "completed", output: null } });
  return run.id;
}

/** Record `record` grown to about `bytes` serialized bytes, the same every time it is asked for. */
function inflate(record: JournalRecord, bytes: number): JournalRecord {
  return { ...record, data: { original: record.data, pad: String.fromCharCode(97 + (record.seq % 26)).repeat(bytes) } };
}

/**
 * The store as the archiver sees it: every record about `bytes` long, and every read answered with the whole rest of
 * the journal as one page, whatever page size was asked for (so one page holds every large record at once).
 */
function largeRecordStore(store: Store, bytes: number, reads: number[]): Store {
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === "readJournal") {
        return async (runId: string, options?: { afterSeq?: number; limit?: number }): Promise<JournalRecord[]> => {
          const page = (await target.readJournal(runId, { afterSeq: options?.afterSeq ?? 0, limit: 1000 })).map((r) => inflate(r, bytes));
          reads.push(page.length);
          return page;
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** A gzip compressor that records the byte length of every chunk written into it. */
function observedGzip(sizes: number[]): () => Transform {
  return () => {
    const gzip = createGzip();
    const write = gzip.write.bind(gzip) as (chunk: unknown, ...rest: unknown[]) => boolean;
    gzip.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
      sizes.push(Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk)));
      return write(chunk, ...rest);
    }) as typeof gzip.write;
    return gzip;
  };
}

test("(R15-03) a page of 40 records of 1 MiB reaches the compressor as 40 chunks, each exactly one record's line", { timeout: 60_000 }, async (t) => {
  const clock = createFakeClock(Date.parse("2026-02-10T00:00:00Z"));
  const { store, dir } = await openTestStore(t, { clock });
  const runId = await finishRun(store, 38);
  clock.advance(DAY);
  const journalSeq = (await store.getRun(runId))?.journalSeq ?? 0;
  assert.equal(journalSeq, 40);
  const reads: number[] = [];
  const big = largeRecordStore(store, MIB, reads);
  const journal = await big.readJournal(runId);
  const lineBytes = journal.map((record) => Buffer.byteLength(`${JSON.stringify(record)}\n`, "utf8"));
  reads.length = 0;

  const sizes: number[] = [];
  const result = await archiveFinishedRuns({ store: big, clock, dataDir: dir, compress: observedGzip(sizes) }, { olderThanMs: 1000 });
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.archived.map((x) => [x.runId, x.records]), [[runId, journalSeq]]);
  assert.equal(reads[0], journalSeq, "the store handed the writer the whole journal as one page");
  assert.deepEqual(sizes, lineBytes, "one chunk per record, each exactly that record's line");
  const page = lineBytes.reduce((sum, n) => sum + n, 0);
  assert.ok(Math.max(...sizes) <= Math.max(...lineBytes) && Math.max(...sizes) * 30 < page, "no chunk is near a page's size");

  const archived = result.archived[0];
  assert.ok(archived !== undefined);
  const text = gunzipSync(await readFile(archived.path)).toString("utf8");
  assert.equal(text, journal.map((record) => `${JSON.stringify(record)}\n`).join(""));
  assert.deepEqual(await store.readJournal(runId), [], "the rows are reclaimed");

  const snapshot = new Proxy(store, {
    get(target, property, receiver) {
      if (property === "readJournal") {
        return async (_id: string, options?: { afterSeq?: number; limit?: number }): Promise<JournalRecord[]> =>
          journal.filter((r) => r.seq > (options?.afterSeq ?? 0)).slice(0, options?.limit ?? 1000);
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  assert.equal(await verifyArchive(archived.path, snapshot, { id: runId, journalSeq }), null, "the archive verifies against the journal it replaced");
  const changed = new Proxy(snapshot, {
    get(target, property, receiver) {
      if (property === "readJournal") {
        return async (id: string, options?: { afterSeq?: number; limit?: number }): Promise<JournalRecord[]> =>
          (await target.readJournal(id, options)).map((r) => (r.seq === 17 ? inflate(r, MIB + 1) : r));
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  assert.equal(await verifyArchive(archived.path, changed, { id: runId, journalSeq }), "line 17 of the file differs from the journal");
});

test("(R15-03) archiving and verifying ask the store for pages of at most JOURNAL_PAGE records", async (t) => {
  const clock = createFakeClock(Date.parse("2026-02-10T00:00:00Z"));
  const { store, dir } = await openTestStore(t, { clock });
  const runId = await finishRun(store, 3 * JOURNAL_PAGE);
  clock.advance(DAY);
  const limits: (number | undefined)[] = [];
  const counted = new Proxy(store, {
    get(target, property, receiver) {
      if (property === "readJournal") {
        return async (id: string, options?: { afterSeq?: number; limit?: number }): Promise<JournalRecord[]> => {
          limits.push(options?.limit);
          return target.readJournal(id, options);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  const result = await archiveFinishedRuns({ store: counted, clock, dataDir: dir }, { olderThanMs: 1000 });
  assert.deepEqual(result.archived.map((x) => x.runId), [runId]);
  assert.ok(JOURNAL_PAGE <= 16, `a page is a handful of records, not ${JOURNAL_PAGE}`);
  assert.ok(limits.length > 0 && limits.every((limit) => limit === JOURNAL_PAGE), JSON.stringify(limits));
});
