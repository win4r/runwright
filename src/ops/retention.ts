import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Transform } from "node:stream";
import { createGunzip, createGzip } from "node:zlib";
import type { Clock } from "../core/clock.ts";
import { directoryChain, syncDirectoryOnDisk, syncHolder } from "../core/durable-fs.ts";
import { RunwrightError, errorInfo, isRunwrightError } from "../core/errors.ts";
import { canonicalJson, type Json } from "../core/json.ts";
import { TERMINAL_STATUSES } from "../store/state-machine.ts";
import type { JournalRecord, RunRecord, Store } from "../store/types.ts";

const PAGE = 100;
/**
 * Journal records asked for per `readJournal` call; archiving and verifying hold at most one such page of parsed
 * records. `readJournal` bounds a page by records, not bytes, so the page is a handful of records: what it costs is
 * at most 4 times the largest record of the journal (twice that while the store parses it).
 *
 * No record is larger than what the engine itself held when it journalled it, and the engine holds the whole
 * journal at once when it resumes a run (`src/engine/session.ts`), so a journal the engine could run is one a page
 * of 4 of its records fits beside. What bounds a record, by type:
 * - a model reply record (`model.finished`, `model.invalid`) and the `tool.started` of a call it asked for: its
 *   text, tool calls and output come from one provider body of at most MAX_REPLY_BYTES (`src/models/sse-parse.ts`,
 *   64 MiB), so it serializes to about 64 MiB at most (parsed JSON written out again keeps about its length; only
 *   numbers in exponent form, `1e20` written out as 21 digits, and invalid UTF-8 bytes, each one U+FFFD of three
 *   bytes, grow, so a body made of nothing else can serialize to about five times its size);
 * - a tool result (`tool.finished`): cut to `tools.resultBytes` (16 KiB by default);
 * - a message or command: the request body limit `server.bodyBytes` (1 MiB by default);
 * - a workflow node's value (`node.finished`) and a run's output (`run.output`): no limit of their own (a map node
 *   collects the value of every item), only the memory of the engine that computed them.
 * So for a journal of agent turns a page is at most 4 × 64 MiB = 256 MiB of record text even when it is four
 * maximal replies in a row, and a few KiB for an ordinary journal.
 */
export const JOURNAL_PAGE = 4;
const DEFAULT_LIMIT = 1000;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Bytes a line of an archive may hold beyond six times its record's own line (every character escaped as \uXXXX). */
const LINE_SLACK_BYTES = 65_536;
const NEWLINE = 0x0a;

export interface ArchiveResult {
  archived: { runId: string; path: string; records: number }[];
  /** Runs left untouched this pass, with a plain reason (never a run another archiver finished meanwhile). */
  skipped: { runId: string; reason: string }[];
}

/** The pages of a run's journal in seq order, each of at most JOURNAL_PAGE records, read one at a time. */
async function* journalPages(store: Store, runId: string): AsyncGenerator<JournalRecord[]> {
  let afterSeq = 0;
  for (;;) {
    const page = await store.readJournal(runId, { afterSeq, limit: JOURNAL_PAGE });
    if (page.length > 0) yield page;
    if (page.length < JOURNAL_PAGE) return;
    afterSeq = (page[page.length - 1] as JournalRecord).seq;
  }
}

/** How a journal read for the archive went: `records` readable records; complete = exactly journalSeq, seqs 1..N. */
interface Reading { records: number; complete: boolean }

/** Writes all of `chunk` at the handle's position. */
async function writeAll(handle: FileHandle, chunk: Buffer): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
    if (bytesWritten <= 0) throw new RunwrightError("store_error", "the archive file accepted no bytes");
    offset += bytesWritten;
  }
}

/**
 * Streams the journal of `run` into `handle` through `compress` (gzip), one `JSON.stringify(record) + "\n"` per
 * record, one page at a time and with the file's backpressure. Every record is counted and checked to be the next
 * seq; once one is not (a gap, a record past journalSeq) nothing more is written, the rest is only counted, and the
 * reading is incomplete, as it is when fewer than journalSeq records were read. A store or disk error rejects.
 *
 * Each chunk handed to `compress` is one record's line, serialized when it is needed: the pipeline writes the next
 * one only after the compressor accepted the last (and waits for it to drain when its buffer is full), so the writer
 * holds one serialized record at a time, never a page of them as one string.
 */
async function writeArchive(handle: FileHandle, store: Store, run: RunRecord, compress: () => Transform): Promise<Reading> {
  const reading: Reading = { records: 0, complete: true };
  async function* lines(): AsyncGenerator<Buffer> {
    for await (const page of journalPages(store, run.id)) {
      for (const record of page) {
        reading.records += 1;
        if (record.seq !== reading.records || reading.records > run.journalSeq) reading.complete = false;
        if (reading.complete) yield Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
      }
    }
    if (reading.records !== run.journalSeq) reading.complete = false;
  }
  await pipeline(lines(), compress(), async (compressed: AsyncIterable<Buffer>) => {
    for await (const chunk of compressed) await writeAll(handle, chunk);
  });
  return reading;
}

/** Why line `index` (1-based) of an archive is not `record` of run `runId`, or null when it is. */
function lineProblem(text: string, index: number, runId: string, record: JournalRecord): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return `line ${index} of the file is not JSON`;
  }
  if (typeof parsed !== "object" || parsed === null || (parsed as { runId?: unknown }).runId !== runId) {
    return `line ${index} of the file belongs to another run`;
  }
  if ((parsed as { seq?: unknown }).seq !== record.seq) return `line ${index} of the file has the wrong seq`;
  if (canonicalJson(parsed as Json) !== canonicalJson(record as unknown as Json)) return `line ${index} of the file differs from the journal`;
  return null;
}

/**
 * Whether the file at `path` is a complete archive of the journal of `run` as the store holds it now: it gunzips,
 * holds one JSON record per line (a last line without a newline counts), and line i equals record i (same run,
 * same seq, same content) for exactly `run.journalSeq` records. Returns null when it is, otherwise why not. The
 * reasons keep one order: a file that is not readable gzip; a journal the store no longer holds whole; a wrong
 * number of records; the first line that differs.
 *
 * Streamed: the file passes through gunzip chunk by chunk and the records are read from the store a page at a
 * time, so memory holds, whatever the size of the journal: one page of at most JOURNAL_PAGE parsed records; one
 * gunzipped chunk; the pieces of the line being read, only while it is compared and only up to six times the
 * length of its record's own line plus LINE_SLACK_BYTES (longer, it cannot be that record; every other line is only
 * counted); and, while one line is compared, that line as text, its parsed value and the serialized forms of it
 * and of its record. A store error rejects.
 */
export async function verifyArchive(path: string, store: Store, run: { id: string; journalSeq: number }): Promise<string | null> {
  const expected = run.journalSeq;
  const pages = journalPages(store, run.id);
  let page: JournalRecord[] = [];
  let pageIndex = 0;
  let storeRecords = 0;
  let storeError: unknown = null;
  let storeProblem: string | null = null;
  let firstProblem: string | null = null;
  let lines = 0;
  /** The record of the line being read, while it is compared; null once only counting. */
  let current: { record: JournalRecord; limit: number } | null = null;
  let held: Buffer[] = [];
  let heldBytes = 0;
  let pendingBytes = 0;

  const nextRecord = async (): Promise<JournalRecord | null> => {
    while (pageIndex >= page.length) {
      let step: IteratorResult<JournalRecord[]>;
      try {
        step = await pages.next();
      } catch (error) {
        storeError = error;
        throw error;
      }
      if (step.done === true) return null;
      page = step.value;
      pageIndex = 0;
    }
    const record = page[pageIndex] as JournalRecord;
    pageIndex += 1;
    storeRecords += 1;
    return record.seq === storeRecords ? record : null;
  };

  /** Called when the first byte of line `lines + 1` arrives: decides whether that line is compared or counted. */
  const startLine = async (): Promise<void> => {
    const index = lines + 1;
    if (firstProblem !== null || storeProblem !== null || index > expected) return;
    const record = await nextRecord();
    if (record === null) {
      storeProblem = `the journal changed while the archive was verified (record ${index} of ${expected} is missing)`;
      return;
    }
    current = { record, limit: 6 * Buffer.byteLength(JSON.stringify(record), "utf8") + LINE_SLACK_BYTES };
  };

  const endLine = (): void => {
    lines += 1;
    if (current !== null) {
      const text = heldBytes > current.limit ? null : Buffer.concat(held, heldBytes).toString("utf8");
      firstProblem = text === null ? `line ${lines} of the file differs from the journal` : lineProblem(text, lines, run.id, current.record);
    }
    current = null;
    held = [];
    heldBytes = 0;
    pendingBytes = 0;
  };

  const take = (piece: Buffer): void => {
    pendingBytes += piece.length;
    if (current === null || heldBytes > current.limit) return;
    held.push(piece);
    heldBytes += piece.length;
  };

  const consume = async (chunk: Buffer): Promise<void> => {
    let from = 0;
    while (from < chunk.length) {
      if (pendingBytes === 0) await startLine();
      const newline = chunk.indexOf(NEWLINE, from);
      const end = newline === -1 ? chunk.length : newline;
      // An empty line has no byte before its newline: it is started above and taken here as nothing.
      take(chunk.subarray(from, end));
      if (newline === -1) return;
      endLine();
      from = newline + 1;
    }
  };

  try {
    await pipeline(createReadStream(path), createGunzip(), async (source: AsyncIterable<Buffer>) => {
      for await (const chunk of source) await consume(chunk);
    });
  } catch (error) {
    if (storeError !== null) throw storeError;
    return `the file is not a readable gzip archive (${errorInfo(error).message})`;
  } finally {
    await pages.return(undefined);
  }
  if (pendingBytes > 0) endLine();
  if (storeProblem !== null) return storeProblem;
  if (lines !== expected) return `the file holds ${lines} records, not ${expected}`;
  return firstProblem;
}

function archivePath(dataDir: string, run: RunRecord): string {
  if (!SAFE_ID.test(run.id)) throw new RunwrightError("bad_request", `run id ${JSON.stringify(run.id)} cannot name an archive file`);
  const finished = new Date(run.finishedAt ?? run.updatedAt);
  const month = `${finished.getUTCFullYear()}-${String(finished.getUTCMonth() + 1).padStart(2, "0")}`;
  return join(dataDir, "archive", month, `${run.id}.jsonl.gz`);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

type Outcome = { kind: "archived"; path: string; records: number } | { kind: "skipped"; reason: string } | { kind: "gone" };

/**
 * One archive pass. `durable` holds the directories whose own entry in the directory above them was synced during
 * this pass, on the walk from a month directory up to the file-system root (keyed by the child: the `archive`
 * directory synced for one month says nothing about the next month's entry). It starts empty for every pass and
 * never depends on who created a directory, so a pass after a failed or crashed one, or next to an overlapping one,
 * syncs the whole ancestry again. `writable` answers rule E of `syncHolder` for the directories of that walk.
 */
interface Pass {
  store: Store;
  dataDir: string;
  compress: () => Transform;
  syncDirectory: (dir: string) => Promise<void>;
  syncFile: (path: string) => Promise<void>;
  writable: ((dir: string) => Promise<boolean>) | undefined;
  openTemp: (path: string) => Promise<FileHandle>;
  durable: Set<string>;
}

/** Flushes a published archive file to disk. Opened "r+": flushing a handle opened read-only is refused on Windows. */
async function syncFileOnDisk(path: string): Promise<void> {
  const handle = await open(path, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Makes the published archive at `path` in `dir` durable: the file's bytes, the month directory (its entry for the
 * file), then the entry of every directory from the month directory up to the file-system root, each once per
 * pass, by syncing the directory that holds it (`syncHolder`). Returns why it could not, or null; nothing is added
 * to `durable` for a directory whose holder failed to sync.
 */
async function syncPublished(pass: Pass, path: string, dir: string): Promise<string | null> {
  try {
    await pass.syncFile(path);
  } catch (error) {
    return `the archive file ${path} could not be synced: ${errorInfo(error).message}`;
  }
  try {
    await pass.syncDirectory(dir);
  } catch (error) {
    return `the archive directory ${dir} could not be synced: ${errorInfo(error).message}`;
  }
  const chain = directoryChain(dir);
  for (let i = 1; i < chain.length; i++) {
    const child = chain[i - 1] as string;
    const holder = chain[i] as string;
    if (pass.durable.has(child)) continue;
    try {
      await syncHolder(holder, pass.writable === undefined
        ? { directory: pass.syncDirectory }
        : { directory: pass.syncDirectory, writable: pass.writable });
    } catch (error) {
      return `the archive directory ${holder} could not be synced: ${errorInfo(error).message}`;
    }
    pass.durable.add(child);
  }
  return null;
}

/** True when the run is gone or another archiver marked it archived since this pass read it. */
async function archivedMeanwhile(store: Store, runId: string): Promise<boolean> {
  const again = await store.getRun(runId);
  return again === null || again.journalArchivedAt !== null;
}

/**
 * Archives one run (steps of `archiveFinishedRuns`). "gone": another archiver finished it. The journal is read
 * twice, a page at a time: once to write the archive and once to verify the published file against the store.
 * A finished run's journal does not change; only another archiver can delete it, and every check that fails
 * looks at the run again first, so a journal another pass archived meanwhile is "gone", never "skipped", and its
 * archive is never replaced.
 */
async function archiveOne(pass: Pass, listed: RunRecord): Promise<Outcome> {
  const { store } = pass;
  const run = await store.getRun(listed.id);
  if (run === null || run.journalArchivedAt !== null) return { kind: "gone" };
  const path = archivePath(pass.dataDir, run);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const handle = await pass.openTemp(temp);
    let reading: Reading;
    try {
      reading = await writeArchive(handle, store, run, pass.compress);
      if (reading.complete) await handle.sync();
    } finally {
      await handle.close();
    }
    if (!reading.complete) {
      if (await archivedMeanwhile(store, run.id)) return { kind: "gone" };
      return { kind: "skipped", reason: `the journal is incomplete: ${reading.records} readable records, journal seq ${run.journalSeq}` };
    }
    try {
      await link(temp, path);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      if ((await verifyArchive(path, store, run)) !== null) {
        if (await archivedMeanwhile(store, run.id)) return { kind: "gone" };
        await rename(temp, path);
      }
    }
    const problem = await verifyArchive(path, store, run);
    if (problem !== null) {
      if (await archivedMeanwhile(store, run.id)) return { kind: "gone" };
      return { kind: "skipped", reason: `the published archive did not verify: ${problem}` };
    }
    const notDurable = await syncPublished(pass, path, dir);
    if (notDurable !== null) return { kind: "skipped", reason: notDurable };
    try {
      await store.archiveJournal(run.id, { path, records: run.journalSeq, lastSeq: run.journalSeq });
    } catch (error) {
      if (isRunwrightError(error) && error.code === "conflict" && error.details?.["reason"] === "already_archived") return { kind: "gone" };
      throw error;
    }
    return { kind: "archived", path, records: run.journalSeq };
  } finally {
    // Normally the temporary file was linked or renamed into place and is gone (ENOENT); a leftover is harmless.
    await unlink(temp).catch(() => undefined);
  }
}

/** Opens the temporary archive file: created, never an existing file, readable by its owner only. */
function openTempOnDisk(path: string): Promise<FileHandle> {
  return open(path, "wx", 0o600);
}

/**
 * Moves the journals of finished runs older than `olderThanMs` into
 * `<dataDir>/archive/<yyyy-mm of finishedAt (UTC)>/<runId>.jsonl.gz` (one JSON record per line) and marks the
 * runs archived, deleting their journal rows. Rows are deleted only after a complete archive was published
 * (with `link`, so an existing complete archive is never replaced) and read back; a file at the path that is not
 * a complete archive of the run is replaced. Overlapping passes are safe: a run another pass finishes meanwhile is
 * in neither list; anything else that stops a run is reported in `skipped` and leaves its journal untouched.
 * `limit` bounds the number of runs archived.
 *
 * Order for one run: stream the journal, a page at a time, through gzip into a temporary file and sync it; publish
 * it with `link` (or `rename` over a file that fails verification); stream it back and verify it against the
 * journal, again a page at a time; sync the published file (also when another pass wrote it: this pass
 * never synced those bytes); sync the month directory (every run, each adds an entry); then, walking up from the
 * month directory to the file-system root, sync the directory above every directory whose entry this pass has
 * not synced yet (the `archive` directory, the data directory and every directory above it), whoever created
 * them; and only then delete the rows. A directory above the month directory whose sync fails with EACCES or
 * EROFS is skipped when `deps.writable` (default: `access` with W_OK) says this process may not write to it. Any
 * other failed sync skips the run with the reason and keeps its rows; the next run of the pass, and every later
 * pass, tries it again. `deps.syncFile` replaces the file sync (default: open "r+",
 * fsync, close) and `deps.syncDirectory` the directory sync (default: open, fsync, close, tolerating platforms that
 * cannot sync a directory). `deps.openTemp` replaces opening the temporary file (default: open "wx", mode 0o600).
 * `deps.compress` replaces creating the compressor the lines are written through (default: `createGzip()`).
 * Memory holds one page of at most JOURNAL_PAGE parsed records (see JOURNAL_PAGE for what that is at most), one
 * serialized record and the compressor's and file's stream buffers, whatever the size of a journal; verifying holds
 * what `verifyArchive` says.
 * `olderThanMs` must be a finite number >= 0 and `limit` an integer >= 0 (`bad_request` otherwise).
 */
export async function archiveFinishedRuns(
  deps: {
    store: Store;
    clock: Clock;
    dataDir: string;
    syncDirectory?: (dir: string) => Promise<void>;
    syncFile?: (path: string) => Promise<void>;
    writable?: (dir: string) => Promise<boolean>;
    openTemp?: (path: string) => Promise<FileHandle>;
    compress?: () => Transform;
  },
  options: { olderThanMs: number; limit?: number },
): Promise<ArchiveResult> {
  if (typeof options.olderThanMs !== "number" || !Number.isFinite(options.olderThanMs) || options.olderThanMs < 0) {
    throw new RunwrightError("bad_request", "olderThanMs must be a finite number of milliseconds >= 0");
  }
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 0)) {
    throw new RunwrightError("bad_request", "limit must be an integer >= 0");
  }
  const limit = options.limit ?? DEFAULT_LIMIT;
  const cutoff = deps.clock.now() - options.olderThanMs;
  const pass: Pass = {
    store: deps.store,
    dataDir: deps.dataDir,
    compress: deps.compress ?? createGzip,
    syncDirectory: deps.syncDirectory ?? syncDirectoryOnDisk,
    syncFile: deps.syncFile ?? syncFileOnDisk,
    writable: deps.writable,
    openTemp: deps.openTemp ?? openTempOnDisk,
    durable: new Set(),
  };
  const filter = { statuses: [...TERMINAL_STATUSES], finishedBefore: cutoff, journalArchived: false };
  const result: ArchiveResult = { archived: [], skipped: [] };
  let cursor: string | undefined;
  while (result.archived.length < limit) {
    const page = await deps.store.listRuns(filter, cursor === undefined ? { limit: PAGE } : { limit: PAGE, cursor });
    for (const run of page.items) {
      if (result.archived.length >= limit) break;
      let outcome: Outcome;
      try {
        outcome = await archiveOne(pass, run);
      } catch (error) {
        outcome = { kind: "skipped", reason: errorInfo(error).message };
      }
      if (outcome.kind === "archived") result.archived.push({ runId: run.id, path: outcome.path, records: outcome.records });
      else if (outcome.kind === "skipped") result.skipped.push({ runId: run.id, reason: outcome.reason });
    }
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return result;
}
