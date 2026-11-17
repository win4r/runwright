// Regression coverage for R11-01 (the archive walk goes to the file-system root, every pass).
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, open, readFile, readdir, stat, writeFile, type FileHandle } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { createFakeClock } from "../../src/core/clock.ts";
import { JOURNAL_PAGE, archiveFinishedRuns, verifyArchive } from "../../src/ops/retention.ts";
import { directoryChain } from "../../src/core/durable-fs.ts";
import { RunwrightError } from "../../src/core/errors.ts";
import type { JournalRecord, RunStatus, Store } from "../../src/store/types.ts";
import { openTestStore, testAgentDefinition } from "../helpers/store.ts";

const DAY = 86_400_000;

async function finishRun(store: Store, agentId: string, status: RunStatus, steps: number): Promise<string> {
  const { run } = await store.createRun({ agentId, input: { message: `job ${status}`, data: null } });
  const claimed = await store.claimRuns({ runnerId: "runner-a", limit: 10, leaseMs: 60_000 });
  const mine = claimed.find((c) => c.run.id === run.id);
  assert.ok(mine !== undefined);
  for (let i = 0; i < steps; i++) {
    await store.commit(mine.lease, { records: [{ type: "note", key: `s${i}`, data: { i } }] });
  }
  const transition = status === "failed"
    ? { to: status, error: { code: "x", message: "boom" } }
    : { to: status, output: "ok" };
  await store.commit(mine.lease, { records: [{ type: "run.finished", data: { status } }], transition });
  return run.id;
}

test("archives only finished runs older than the cutoff, into gzip files holding every record", async (t) => {
  const clock = createFakeClock(Date.parse("2026-03-31T23:00:00Z"));
  const { store, dir } = await openTestStore(t, { clock });
  const { agent } = await store.saveAgent({ definition: testAgentDefinition() });

  const oldCompleted = await finishRun(store, agent.id, "completed", 3);
  const oldFailed = await finishRun(store, agent.id, "failed", 0);
  const { run: stillQueued } = await store.createRun({ agentId: agent.id, input: { message: "waiting", data: null } });
  clock.advance(10 * DAY);
  const recent = await finishRun(store, agent.id, "cancelled", 1);
  clock.advance(DAY);

  const journalBefore = await store.readJournal(oldCompleted);
  const result = await archiveFinishedRuns({ store, clock, dataDir: dir }, { olderThanMs: 5 * DAY });
  assert.deepEqual(result.archived.map((a) => a.runId).sort(), [oldCompleted, oldFailed].sort());
  assert.deepEqual(result.skipped, []);

  const entry = result.archived.find((a) => a.runId === oldCompleted);
  assert.ok(entry !== undefined);
  assert.equal(entry.path, join(dir, "archive", "2026-03", `${oldCompleted}.jsonl.gz`));
  assert.equal(entry.records, journalBefore.length);
  assert.equal(journalBefore.length, 5);
  assert.equal((await stat(entry.path)).mode & 0o777, 0o600);
  const lines = gunzipSync(await readFile(entry.path)).toString("utf8").trimEnd().split("\n");
  assert.deepEqual(lines.map((line) => JSON.parse(line)), journalBefore);

  assert.deepEqual(await store.readJournal(oldCompleted), []);
  assert.deepEqual(await store.readJournal(oldFailed), []);
  assert.ok((await store.getRun(oldCompleted))?.journalArchivedAt !== null);
  assert.equal((await store.getRun(recent))?.journalArchivedAt, null);
  assert.ok((await store.readJournal(recent)).length > 0);
  assert.ok((await store.readJournal(stillQueued.id)).length > 0);
  assert.deepEqual((await readdir(join(dir, "archive", "2026-03"))).sort(), [`${oldCompleted}.jsonl.gz`, `${oldFailed}.jsonl.gz`].sort());

  const second = await archiveFinishedRuns({ store, clock, dataDir: dir }, { olderThanMs: 5 * DAY });
  assert.deepEqual(second, { archived: [], skipped: [] });

  const everything = await archiveFinishedRuns({ store, clock, dataDir: dir }, { olderThanMs: 0 });
  assert.deepEqual(everything.archived.map((a) => a.runId), [recent]);
  assert.equal(everything.archived[0]?.path, join(dir, "archive", "2026-04", `${recent}.jsonl.gz`));
});

test("the limit bounds one pass, and the next pass continues", async (t) => {
  const clock = createFakeClock(Date.parse("2026-01-10T00:00:00Z"));
  const { store, dir } = await openTestStore(t, { clock });
  const { agent } = await store.saveAgent({ definition: testAgentDefinition() });
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) ids.push(await finishRun(store, agent.id, "completed", 1));
  clock.advance(DAY);
  const stale = join(dir, "archive", "2026-01", `${ids[0]}.jsonl.gz`);
  await mkdir(join(dir, "archive", "2026-01"), { recursive: true });
  await writeFile(stale, "left over from an interrupted pass");

  const first = await archiveFinishedRuns({ store, clock, dataDir: dir }, { olderThanMs: 1000, limit: 3 });
  assert.equal(first.archived.length, 3);
  const rest = await archiveFinishedRuns({ store, clock, dataDir: dir }, { olderThanMs: 1000 });
  assert.equal(rest.archived.length, 2);
  assert.deepEqual([...first.archived, ...rest.archived].map((a) => a.runId).sort(), [...ids].sort());
  const replaced = gunzipSync(await readFile(stale)).toString("utf8").trimEnd().split("\n");
  assert.equal(replaced.length, 3);
  assert.equal(JSON.parse(replaced[0] ?? "null").runId, ids[0]);
  assert.ok(!(await readdir(join(dir, "archive", "2026-01"))).some((name) => name.endsWith(".tmp")));
});

/** A promise and the function that resolves it. */
function signal(): { promise: Promise<void>; fire: () => void } {
  let fire = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    fire = resolve;
  });
  return { promise, fire };
}

/** A view of `store` whose listed methods are replaced; everything else is forwarded. */
function wrap(store: Store, overrides: Partial<Pick<Store, "readJournal" | "archiveJournal" | "getRun">>): Store {
  return new Proxy(store, {
    get(target, property, receiver) {
      const override = (overrides as Record<PropertyKey, unknown>)[property];
      if (override !== undefined) return override;
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

async function twoHandles(t: TestContext) {
  const clock = createFakeClock(Date.parse("2026-02-10T00:00:00Z"));
  const { store: a, dir } = await openTestStore(t, { clock });
  const { store: b } = await openTestStore(t, { clock, dir });
  const { agent } = await a.saveAgent({ definition: testAgentDefinition() });
  return { clock, a, b, dir, agentId: agent.id };
}

function archiveLines(bytes: Buffer): JournalRecord[] {
  return gunzipSync(bytes).toString("utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as JournalRecord);
}

async function tempFiles(dir: string): Promise<string[]> {
  return (await readdir(dir, { recursive: true })).filter((name) => name.endsWith(".tmp"));
}

const archiveFile = (dir: string, runId: string): string => join(dir, "archive", "2026-02", `${runId}.jsonl.gz`);

test("overlap: a late reader finds the journal gone and leaves the complete archive alone", async (t) => {
  const { clock, a, b, dir, agentId } = await twoHandles(t);
  const runId = await finishRun(a, agentId, "completed", 3);
  clock.advance(DAY);
  const journal = await a.readJournal(runId);
  const reached = signal();
  const gate = signal();
  const lateReader = wrap(b, {
    readJournal: async (...args) => {
      reached.fire();
      await gate.promise;
      return b.readJournal(...args);
    },
  });
  const passB = archiveFinishedRuns({ store: lateReader, clock, dataDir: dir }, { olderThanMs: 1000 });
  await reached.promise;
  const resultA = await archiveFinishedRuns({ store: a, clock, dataDir: dir }, { olderThanMs: 1000 });
  gate.fire();
  const resultB = await passB;

  assert.deepEqual(resultA.archived.map((x) => [x.runId, x.records]), [[runId, journal.length]]);
  assert.deepEqual(resultA.skipped, []);
  assert.deepEqual(resultB, { archived: [], skipped: [] });
  assert.deepEqual(archiveLines(await readFile(archiveFile(dir, runId))), journal);
  assert.deepEqual(await a.readJournal(runId), []);
  assert.deepEqual(await tempFiles(dir), []);
});

test("overlap: a late publisher holding the whole journal keeps the archive another pass published", async (t) => {
  const { clock, a, b, dir, agentId } = await twoHandles(t);
  const runId = await finishRun(a, agentId, "completed", 2);
  clock.advance(DAY);
  const journal = await a.readJournal(runId);
  const reached = signal();
  const gate = signal();
  let held = false;
  const latePublisher = wrap(b, {
    readJournal: async (...args) => {
      const page = await b.readJournal(...args);
      if (!held) {
        held = true;
        reached.fire();
        await gate.promise;
      }
      return page;
    },
  });
  const passB = archiveFinishedRuns({ store: latePublisher, clock, dataDir: dir }, { olderThanMs: 1000 });
  await reached.promise;
  const resultA = await archiveFinishedRuns({ store: a, clock, dataDir: dir }, { olderThanMs: 1000 });
  const path = archiveFile(dir, runId);
  const published = { bytes: await readFile(path), ino: (await stat(path)).ino };
  const archivedAt = (await a.getRun(runId))?.journalArchivedAt;
  clock.advance(1000);
  gate.fire();
  const resultB = await passB;

  assert.deepEqual(resultA.archived.map((x) => x.runId), [runId]);
  assert.deepEqual(resultB, { archived: [], skipped: [] });
  assert.deepEqual(await readFile(path), published.bytes);
  assert.equal((await stat(path)).ino, published.ino, "the complete archive is not replaced");
  assert.deepEqual(archiveLines(published.bytes), journal);
  assert.equal((await a.getRun(runId))?.journalArchivedAt, archivedAt, "the run is marked archived once");
  assert.deepEqual(await tempFiles(dir), []);
});

test("overlap: a pass that published first and commits last reports nothing; the other pass keeps its file", async (t) => {
  const { clock, a, b, dir, agentId } = await twoHandles(t);
  const runId = await finishRun(a, agentId, "cancelled", 1);
  clock.advance(DAY);
  const journal = await a.readJournal(runId);
  const path = archiveFile(dir, runId);
  const reached = signal();
  const gate = signal();
  const lateCommitter = wrap(b, {
    archiveJournal: async (...args) => {
      reached.fire();
      await gate.promise;
      return b.archiveJournal(...args);
    },
  });
  const passB = archiveFinishedRuns({ store: lateCommitter, clock, dataDir: dir }, { olderThanMs: 1000 });
  await reached.promise;
  const ino = (await stat(path)).ino;
  const resultA = await archiveFinishedRuns({ store: a, clock, dataDir: dir }, { olderThanMs: 1000 });
  gate.fire();
  const resultB = await passB;
  assert.deepEqual(resultA.archived.map((x) => x.runId), [runId]);
  assert.deepEqual(resultB, { archived: [], skipped: [] });
  assert.equal((await stat(path)).ino, ino);
  assert.deepEqual(archiveLines(await readFile(path)), journal);
  assert.deepEqual(await tempFiles(dir), []);
});

test("overlap: a reader whose second journal page comes after the delete does not publish", async (t) => {
  const { clock, a, b, dir, agentId } = await twoHandles(t);
  const { run } = await a.createRun({ agentId, input: { message: "long", data: null } });
  const [claim] = await a.claimRuns({ runnerId: "r", limit: 1, leaseMs: 60_000 });
  assert.equal(claim?.run.id, run.id);
  await a.commit(claim.lease, { records: Array.from({ length: 1100 }, (_, i) => ({ type: "note", key: `s${i}`, data: { i } })) });
  await a.commit(claim.lease, { records: [{ type: "run.finished", data: {} }], transition: { to: "completed", output: null } });
  clock.advance(DAY);
  const journal: JournalRecord[] = [];
  for (let page = await a.readJournal(run.id); page.length > 0; page = await a.readJournal(run.id, { afterSeq: journal.at(-1)?.seq ?? 0 })) {
    journal.push(...page);
  }
  assert.equal(journal.length, 1102);

  const reached = signal();
  const gate = signal();
  let calls = 0;
  const pagedReader = wrap(b, {
    readJournal: async (...args) => {
      calls++;
      if (calls === 2) {
        reached.fire();
        await gate.promise;
      }
      return b.readJournal(...args);
    },
  });
  const passB = archiveFinishedRuns({ store: pagedReader, clock, dataDir: dir }, { olderThanMs: 1000 });
  await reached.promise;
  const resultA = await archiveFinishedRuns({ store: a, clock, dataDir: dir }, { olderThanMs: 1000 });
  gate.fire();
  const resultB = await passB;
  assert.deepEqual(resultA.archived.map((x) => [x.runId, x.records]), [[run.id, 1102]]);
  assert.deepEqual(resultB, { archived: [], skipped: [] });
  assert.deepEqual(archiveLines(await readFile(archiveFile(dir, run.id))), journal);
  assert.deepEqual(await tempFiles(dir), []);
});

test("an existing complete archive is kept byte for byte; an invalid one is replaced", async (t) => {
  const clock = createFakeClock(Date.parse("2026-02-10T00:00:00Z"));
  const { store, dir } = await openTestStore(t, { clock });
  const { agent } = await store.saveAgent({ definition: testAgentDefinition() });
  const complete = await finishRun(store, agent.id, "completed", 2);
  const wrongRun = await finishRun(store, agent.id, "completed", 2);
  const truncated = await finishRun(store, agent.id, "failed", 3);
  clock.advance(DAY);
  const serialize = (records: JournalRecord[]): Buffer =>
    gzipSync(Buffer.from(records.map((r) => JSON.stringify(r)).join("\n") + "\n"), { level: 1 });
  await mkdir(join(dir, "archive", "2026-02"), { recursive: true });
  const kept = serialize(await store.readJournal(complete));
  await writeFile(archiveFile(dir, complete), kept, { mode: 0o600 });
  const keptIno = (await stat(archiveFile(dir, complete))).ino;
  await writeFile(archiveFile(dir, wrongRun), serialize(await store.readJournal(complete)));
  await writeFile(archiveFile(dir, truncated), serialize((await store.readJournal(truncated)).slice(0, 2)));
  const journals = new Map<string, JournalRecord[]>();
  for (const id of [complete, wrongRun, truncated]) journals.set(id, await store.readJournal(id));

  const result = await archiveFinishedRuns({ store, clock, dataDir: dir }, { olderThanMs: 1000 });
  assert.deepEqual(result.archived.map((x) => x.runId).sort(), [complete, wrongRun, truncated].sort());
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(await readFile(archiveFile(dir, complete)), kept);
  assert.equal((await stat(archiveFile(dir, complete))).ino, keptIno);
  for (const id of [complete, wrongRun, truncated]) {
    assert.deepEqual(archiveLines(await readFile(archiveFile(dir, id))), journals.get(id), id);
    assert.equal((await stat(archiveFile(dir, id))).mode & 0o777, 0o600, id);
  }
  assert.deepEqual(await tempFiles(dir), []);
});

test("a run that cannot be archived is skipped with a reason, its journal kept and no temp file left", async (t) => {
  const clock = createFakeClock(Date.parse("2026-02-10T00:00:00Z"));
  const { store, dir } = await openTestStore(t, { clock });
  const { agent } = await store.saveAgent({ definition: testAgentDefinition() });
  const blocked = await finishRun(store, agent.id, "completed", 1);
  const failing = await finishRun(store, agent.id, "completed", 1);
  const gappy = await finishRun(store, agent.id, "completed", 2);
  const fine = await finishRun(store, agent.id, "completed", 1);
  clock.advance(DAY);
  await mkdir(archiveFile(dir, blocked), { recursive: true });
  const journals = new Map<string, JournalRecord[]>();
  for (const id of [blocked, failing, gappy]) journals.set(id, await store.readJournal(id));

  const flaky = wrap(store, {
    archiveJournal: async (runId, archive) => {
      if (runId === failing) throw new RunwrightError("store_error", "the disk is full");
      return store.archiveJournal(runId, archive);
    },
    readJournal: async (runId, options) => {
      const page = await store.readJournal(runId, options);
      return runId === gappy ? page.filter((r) => r.seq !== 2) : page;
    },
  });
  const result = await archiveFinishedRuns({ store: flaky, clock, dataDir: dir }, { olderThanMs: 1000 });
  assert.deepEqual(result.archived.map((x) => x.runId), [fine]);
  const reasons = new Map(result.skipped.map((s) => [s.runId, s.reason]));
  assert.deepEqual([...reasons.keys()].sort(), [blocked, failing, gappy].sort());
  assert.match(reasons.get(failing) ?? "", /disk is full/);
  assert.match(reasons.get(gappy) ?? "", /incomplete/);
  for (const id of [blocked, failing, gappy]) {
    assert.deepEqual(await store.readJournal(id), journals.get(id), id);
    assert.equal((await store.getRun(id))?.journalArchivedAt, null, id);
  }
  assert.deepEqual(archiveLines(await readFile(archiveFile(dir, failing))), journals.get(failing), "the complete archive file stays");
  await assert.rejects(stat(archiveFile(dir, gappy)), { code: "ENOENT" });
  assert.deepEqual(await tempFiles(dir), []);
  assert.deepEqual(await readdir(dirname(archiveFile(dir, blocked))).then((names) => names.sort()),
    [`${blocked}.jsonl.gz`, `${failing}.jsonl.gz`, `${fine}.jsonl.gz`].sort());
});

/** A store view that records `archiveJournal` calls into `events`, next to the syncs the test records. */
function recording(store: Store, events: string[]): Store {
  return wrap(store, {
    archiveJournal: async (runId, archive) => {
      events.push(`archiveJournal ${runId}`);
      return store.archiveJournal(runId, archive);
    },
  });
}

/** File and directory syncs that record into `events` and succeed. */
function recordingSyncs(events: string[]): { syncFile: (path: string) => Promise<void>; syncDirectory: (dir: string) => Promise<void> } {
  return {
    syncFile: async (path) => void events.push(`file ${path}`),
    syncDirectory: async (dir) => void events.push(`sync ${dir}`),
  };
}

const ioError = (message: string): Error => Object.assign(new Error(message), { code: "EIO" });

/** `sync <d>` for `from` and every directory above it, up to the file-system root, deepest first. */
const ancestry = (from: string, suffix = ""): string[] => directoryChain(from).map((d) => `sync ${d}${suffix}`);

test("the first archive of a month syncs the file, the month directory and the whole ancestry before the rows go", async (t) => {
  const clock = createFakeClock(Date.parse("2026-02-10T00:00:00Z"));
  const { store, dir } = await openTestStore(t, { clock });
  const { agent } = await store.saveAgent({ definition: testAgentDefinition() });
  const first = await finishRun(store, agent.id, "completed", 1);
  clock.advance(DAY);
  const events: string[] = [];
  const month = join(dir, "archive", "2026-02");

  const one = await archiveFinishedRuns({ store: recording(store, events), clock, dataDir: dir, ...recordingSyncs(events) }, { olderThanMs: 1000 });
  assert.deepEqual(one.archived.map((a) => a.runId), [first]);
  assert.deepEqual(events, [
    `file ${archiveFile(dir, first)}`, `sync ${month}`, ...ancestry(join(dir, "archive")),
    `archiveJournal ${first}`,
  ]);

  const second = await finishRun(store, agent.id, "completed", 1);
  clock.advance(DAY);
  events.length = 0;
  const two = await archiveFinishedRuns({ store: recording(store, events), clock, dataDir: dir, ...recordingSyncs(events) }, { olderThanMs: 1000 });
  assert.deepEqual(two.archived.map((a) => a.runId), [second]);
  assert.deepEqual(events, [
    `file ${archiveFile(dir, second)}`, `sync ${month}`, ...ancestry(join(dir, "archive")),
    `archiveJournal ${second}`,
  ], "every pass syncs the whole ancestry again, although the directories exist");
});

test("a data directory created by the pass has its own entry synced too, deepest first", async (t) => {
  const clock = createFakeClock(Date.parse("2026-02-10T00:00:00Z"));
  const { store, dir } = await openTestStore(t, { clock });
  const { agent } = await store.saveAgent({ definition: testAgentDefinition() });
  const a = await finishRun(store, agent.id, "completed", 1);
  const b = await finishRun(store, agent.id, "completed", 1);
  clock.advance(DAY);
  const dataDir = join(dir, "fresh");
  const events: string[] = [];
  const result = await archiveFinishedRuns(
    { store: recording(store, events), clock, dataDir, ...recordingSyncs(events) },
    { olderThanMs: 1000 },
  );
  assert.deepEqual(result.archived.map((x) => x.runId).sort(), [a, b].sort());
  const [firstId, secondId] = result.archived.map((x) => x.runId);
  const month = join(dataDir, "archive", "2026-02");
  assert.deepEqual(events, [
    `file ${join(month, `${firstId}.jsonl.gz`)}`,
    `sync ${month}`, ...ancestry(join(dataDir, "archive")), `archiveJournal ${firstId}`,
    `file ${join(month, `${secondId}.jsonl.gz`)}`, `sync ${month}`, `archiveJournal ${secondId}`,
  ]);
});

test("a failed directory sync skips the run with the reason and keeps its rows; a later pass syncs the whole ancestry", async (t) => {
  const clock = createFakeClock(Date.parse("2026-02-10T00:00:00Z"));
  const { store, dir } = await openTestStore(t, { clock });
  const { agent } = await store.saveAgent({ definition: testAgentDefinition() });
  const runId = await finishRun(store, agent.id, "completed", 2);
  clock.advance(DAY);
  const journal = await store.readJournal(runId);
  const events: string[] = [];
  const failing = async (path: string): Promise<void> => {
    events.push(`sync ${path}`);
    if (path === join(dir, "archive")) throw ioError("input/output error");
  };
  const result = await archiveFinishedRuns(
    { store: recording(store, events), clock, dataDir: dir, syncFile: recordingSyncs(events).syncFile, syncDirectory: failing },
    { olderThanMs: 1000 },
  );
  assert.deepEqual(result.archived, []);
  assert.deepEqual(result.skipped, [{ runId, reason: `the archive directory ${join(dir, "archive")} could not be synced: input/output error` }]);
  assert.ok(!events.some((e) => e.startsWith("archiveJournal")), "archiveJournal was not called");
  assert.deepEqual(await store.readJournal(runId), journal);
  assert.equal((await store.getRun(runId))?.journalArchivedAt, null);
  assert.deepEqual(await tempFiles(dir), []);

  events.length = 0;
  const retry = await archiveFinishedRuns({ store: recording(store, events), clock, dataDir: dir, ...recordingSyncs(events) }, { olderThanMs: 1000 });
  assert.deepEqual(retry.archived.map((x) => x.runId), [runId]);
  assert.deepEqual(events, [
    `file ${archiveFile(dir, runId)}`, `sync ${join(dir, "archive", "2026-02")}`, ...ancestry(join(dir, "archive")), `archiveJournal ${runId}`,
  ], "the later pass created no directory, and still syncs every entry up to the file-system root");
  assert.deepEqual(archiveLines(await readFile(archiveFile(dir, runId))), journal);
});

test("a pass that finds the archive directories already present syncs the whole ancestry before the rows go", async (t) => {
  const clock = createFakeClock(Date.parse("2026-02-10T00:00:00Z"));
  const { store, dir } = await openTestStore(t, { clock });
  const { agent } = await store.saveAgent({ definition: testAgentDefinition() });
  const runId = await finishRun(store, agent.id, "completed", 1);
  clock.advance(DAY);
  await mkdir(join(dir, "archive", "2026-02"), { recursive: true, mode: 0o700 });
  const events: string[] = [];
  const result = await archiveFinishedRuns({ store: recording(store, events), clock, dataDir: dir, ...recordingSyncs(events) }, { olderThanMs: 1000 });
  assert.deepEqual(result.archived.map((x) => x.runId), [runId]);
  assert.deepEqual(events, [
    `file ${archiveFile(dir, runId)}`, `sync ${join(dir, "archive", "2026-02")}`, ...ancestry(join(dir, "archive")), `archiveJournal ${runId}`,
  ]);
  assert.equal(events.at(-1), `archiveJournal ${runId}`, "archiveJournal comes after every sync");
});

test("overlapping passes: whichever pass archives a run synced its whole ancestry first, and each run is archived once", async (t) => {
  const { clock, a, b, dir, agentId } = await twoHandles(t);
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) ids.push(await finishRun(a, agentId, "completed", 1));
  clock.advance(DAY);
  const eventsA: string[] = [];
  const eventsB: string[] = [];
  const [resultA, resultB] = await Promise.all([
    archiveFinishedRuns({ store: recording(a, eventsA), clock, dataDir: dir, ...recordingSyncs(eventsA) }, { olderThanMs: 1000 }),
    archiveFinishedRuns({ store: recording(b, eventsB), clock, dataDir: dir, ...recordingSyncs(eventsB) }, { olderThanMs: 1000 }),
  ]);
  assert.deepEqual([...resultA.skipped, ...resultB.skipped], []);
  const archived = [...resultA.archived, ...resultB.archived].map((x) => x.runId);
  assert.deepEqual([...archived].sort(), [...ids].sort(), "every run is archived exactly once");
  const month = join(dir, "archive", "2026-02");
  const expected = [`sync ${month}`, ...ancestry(join(dir, "archive"))];
  for (const [result, events] of [[resultA, eventsA], [resultB, eventsB]] as const) {
    for (const { runId } of result.archived) {
      const at = events.indexOf(`archiveJournal ${runId}`);
      assert.ok(at >= 0, runId);
      const before = events.slice(0, at);
      assert.ok(before.includes(`file ${archiveFile(dir, runId)}`), `${runId}: its file was synced first`);
      for (const entry of expected) assert.ok(before.includes(entry), `${runId}: ${entry} came first`);
      const lastFile = before.lastIndexOf(`file ${archiveFile(dir, runId)}`);
      assert.ok(before.indexOf(`sync ${month}`, lastFile) > lastFile, `${runId}: the month directory was synced after its file`);
    }
  }
  for (const id of ids) assert.deepEqual(await a.readJournal(id), []);
  assert.deepEqual(await tempFiles(dir), []);
});

test("a second month in one pass syncs the archive directory again, but not the data directory or anything above it", async (t) => {
  const clock = createFakeClock(Date.parse("2026-02-27T00:00:00Z"));
  const { store, dir } = await openTestStore(t, { clock });
  const { agent } = await store.saveAgent({ definition: testAgentDefinition() });
  const february = await finishRun(store, agent.id, "completed", 1);
  clock.advance(5 * DAY);
  const march = await finishRun(store, agent.id, "completed", 1);
  clock.advance(DAY);
  const events: string[] = [];
  const result = await archiveFinishedRuns({ store: recording(store, events), clock, dataDir: dir, ...recordingSyncs(events) }, { olderThanMs: 1000 });
  assert.deepEqual(result.archived.map((x) => x.runId).sort(), [february, march].sort());
  const monthOf = new Map([[february, join(dir, "archive", "2026-02")], [march, join(dir, "archive", "2026-03")]]);
  const [firstId, secondId] = result.archived.map((x) => x.runId);
  assert.ok(firstId !== undefined && secondId !== undefined);
  const firstMonth = monthOf.get(firstId) ?? "";
  const secondMonth = monthOf.get(secondId) ?? "";
  assert.notEqual(firstMonth, secondMonth);
  assert.deepEqual(events, [
    `file ${join(firstMonth, `${firstId}.jsonl.gz`)}`, `sync ${firstMonth}`, ...ancestry(join(dir, "archive")), `archiveJournal ${firstId}`,
    `file ${join(secondMonth, `${secondId}.jsonl.gz`)}`, `sync ${secondMonth}`, `sync ${join(dir, "archive")}`,
    `archiveJournal ${secondId}`,
  ]);
});

test("a later run of the same pass and month syncs its file and the month directory only", async (t) => {
  const clock = createFakeClock(Date.parse("2026-02-10T00:00:00Z"));
  const { store, dir } = await openTestStore(t, { clock });
  const { agent } = await store.saveAgent({ definition: testAgentDefinition() });
  await finishRun(store, agent.id, "completed", 1);
  await finishRun(store, agent.id, "completed", 1);
  clock.advance(DAY);
  const events: string[] = [];
  const result = await archiveFinishedRuns({ store: recording(store, events), clock, dataDir: dir, ...recordingSyncs(events) }, { olderThanMs: 1000 });
  const [first, second] = result.archived.map((x) => x.runId);
  assert.ok(first !== undefined && second !== undefined);
  const month = join(dir, "archive", "2026-02");
  assert.deepEqual(events, [
    `file ${archiveFile(dir, first)}`, `sync ${month}`, ...ancestry(join(dir, "archive")),
    `archiveJournal ${first}`,
    `file ${archiveFile(dir, second)}`, `sync ${month}`, `archiveJournal ${second}`,
  ]);
});

test("a later run of the same pass still syncs the parents an earlier failed sync left unsynced", async (t) => {
  const clock = createFakeClock(Date.parse("2026-02-10T00:00:00Z"));
  const { store, dir } = await openTestStore(t, { clock });
  const { agent } = await store.saveAgent({ definition: testAgentDefinition() });
  await finishRun(store, agent.id, "completed", 1);
  await finishRun(store, agent.id, "completed", 1);
  clock.advance(DAY);
  const events: string[] = [];
  let failures = 1;
  const syncDirectory = async (path: string): Promise<void> => {
    events.push(`sync ${path}`);
    if (path === join(dir, "archive") && failures-- > 0) throw ioError("transient");
  };
  const result = await archiveFinishedRuns(
    { store: recording(store, events), clock, dataDir: dir, syncFile: recordingSyncs(events).syncFile, syncDirectory },
    { olderThanMs: 1000 },
  );
  assert.equal(result.archived.length, 1);
  assert.equal(result.skipped.length, 1);
  const archived = result.archived[0]?.runId;
  const skipped = result.skipped[0]?.runId;
  assert.ok(archived !== undefined && skipped !== undefined);
  const month = join(dir, "archive", "2026-02");
  assert.deepEqual(events, [
    `file ${archiveFile(dir, skipped)}`, `sync ${month}`, `sync ${join(dir, "archive")}`,
    `file ${archiveFile(dir, archived)}`, `sync ${month}`, ...ancestry(join(dir, "archive")),
    `archiveJournal ${archived}`,
  ]);
});

test("a failing sync of the data directory's parent skips the run; a later run of the same pass tries it again", async (t) => {
  const clock = createFakeClock(Date.parse("2026-02-10T00:00:00Z"));
  const { store, dir } = await openTestStore(t, { clock });
  const { agent } = await store.saveAgent({ definition: testAgentDefinition() });
  await finishRun(store, agent.id, "completed", 1);
  await finishRun(store, agent.id, "completed", 1);
  clock.advance(DAY);
  const events: string[] = [];
  let failures = 1;
  const syncDirectory = async (path: string): Promise<void> => {
    events.push(`sync ${path}`);
    if (path === dirname(dir) && failures-- > 0) throw ioError("parent unreachable");
  };
  const journals = new Map<string, JournalRecord[]>();
  for (const run of (await store.listRuns({ journalArchived: false }, { limit: 10 })).items) journals.set(run.id, await store.readJournal(run.id));
  const result = await archiveFinishedRuns(
    { store: recording(store, events), clock, dataDir: dir, syncFile: recordingSyncs(events).syncFile, syncDirectory },
    { olderThanMs: 1000 },
  );
  const archived = result.archived[0]?.runId;
  const skipped = result.skipped[0]?.runId;
  assert.ok(archived !== undefined && skipped !== undefined);
  assert.deepEqual(result.skipped, [{ runId: skipped, reason: `the archive directory ${dirname(dir)} could not be synced: parent unreachable` }]);
  assert.deepEqual(await store.readJournal(skipped), journals.get(skipped));
  assert.equal((await store.getRun(skipped))?.journalArchivedAt, null);
  const month = join(dir, "archive", "2026-02");
  assert.deepEqual(events, [
    `file ${archiveFile(dir, skipped)}`, `sync ${month}`, `sync ${join(dir, "archive")}`, `sync ${dir}`, `sync ${dirname(dir)}`,
    `file ${archiveFile(dir, archived)}`, `sync ${month}`, ...ancestry(dirname(dir)), `archiveJournal ${archived}`,
  ]);
});

test("a failing sync of an ancestor above the data directory's parent skips the run; the next run of the pass syncs it", async (t) => {
  const clock = createFakeClock(Date.parse("2026-02-10T00:00:00Z"));
  const { store, dir } = await openTestStore(t, { clock });
  const { agent } = await store.saveAgent({ definition: testAgentDefinition() });
  await finishRun(store, agent.id, "completed", 1);
  await finishRun(store, agent.id, "completed", 1);
  clock.advance(DAY);
  const high = dirname(dirname(dir));
  assert.notEqual(dirname(high), high, "the temp directory is deep enough for this test");
  const events: string[] = [];
  let failures = 1;
  const syncDirectory = async (path: string): Promise<void> => {
    events.push(`sync ${path}`);
    if (path === high && failures-- > 0) throw ioError("ancestor unreachable");
  };
  const journals = new Map<string, JournalRecord[]>();
  for (const run of (await store.listRuns({ journalArchived: false }, { limit: 10 })).items) journals.set(run.id, await store.readJournal(run.id));
  const result = await archiveFinishedRuns(
    { store: recording(store, events), clock, dataDir: dir, syncFile: recordingSyncs(events).syncFile, syncDirectory },
    { olderThanMs: 1000 },
  );
  const archived = result.archived[0]?.runId;
  const skipped = result.skipped[0]?.runId;
  assert.ok(archived !== undefined && skipped !== undefined);
  assert.deepEqual(result.skipped, [{ runId: skipped, reason: `the archive directory ${high} could not be synced: ancestor unreachable` }]);
  assert.deepEqual(await store.readJournal(skipped), journals.get(skipped));
  assert.equal((await store.getRun(skipped))?.journalArchivedAt, null);
  const month = join(dir, "archive", "2026-02");
  assert.deepEqual(events, [
    `file ${archiveFile(dir, skipped)}`, `sync ${month}`, `sync ${join(dir, "archive")}`, `sync ${dir}`, `sync ${dirname(dir)}`,
    `sync ${high}`,
    `file ${archiveFile(dir, archived)}`, `sync ${month}`, ...ancestry(high), `archiveJournal ${archived}`,
  ]);
});

test("a run skipped for an ancestor sync above the data directory's parent is archived by the next pass, which syncs it", async (t) => {
  const clock = createFakeClock(Date.parse("2026-02-10T00:00:00Z"));
  const { store, dir } = await openTestStore(t, { clock });
  const { agent } = await store.saveAgent({ definition: testAgentDefinition() });
  const runId = await finishRun(store, agent.id, "completed", 2);
  clock.advance(DAY);
  const journal = await store.readJournal(runId);
  const high = dirname(dirname(dir));
  const failing = async (path: string): Promise<void> => {
    if (path === high) throw ioError("ancestor unreachable");
  };
  const first = await archiveFinishedRuns({ store, clock, dataDir: dir, syncFile: async () => undefined, syncDirectory: failing }, { olderThanMs: 1000 });
  assert.deepEqual(first, { archived: [], skipped: [{ runId, reason: `the archive directory ${high} could not be synced: ancestor unreachable` }] });
  assert.deepEqual(await store.readJournal(runId), journal);
  const events: string[] = [];
  const second = await archiveFinishedRuns({ store: recording(store, events), clock, dataDir: dir, ...recordingSyncs(events) }, { olderThanMs: 1000 });
  assert.deepEqual(second.archived.map((x) => x.runId), [runId]);
  assert.deepEqual(events, [
    `file ${archiveFile(dir, runId)}`, `sync ${join(dir, "archive", "2026-02")}`, ...ancestry(join(dir, "archive")), `archiveJournal ${runId}`,
  ]);
  assert.ok(events.indexOf(`sync ${high}`) < events.indexOf(`archiveJournal ${runId}`));
  assert.deepEqual(archiveLines(await readFile(archiveFile(dir, runId))), journal);
});

for (const code of ["EACCES", "EROFS"]) {
  test(`rule E in a pass (${code}): an unwritable high ancestor is skipped, a writable one skips the run`, async (t) => {
    const clock = createFakeClock(Date.parse("2026-02-10T00:00:00Z"));
    const { store, dir } = await openTestStore(t, { clock });
    const { agent } = await store.saveAgent({ definition: testAgentDefinition() });
    const blocked = await finishRun(store, agent.id, "completed", 1);
    clock.advance(DAY);
    const journal = await store.readJournal(blocked);
    const high = dirname(dirname(dir));
    const events: string[] = [];
    const syncDirectory = async (path: string): Promise<void> => {
      events.push(`sync ${path}`);
      if (path === high) throw Object.assign(new Error(`cannot open ${path}`), { code });
    };
    const refused = await archiveFinishedRuns(
      { store: recording(store, events), clock, dataDir: dir, syncFile: async () => undefined, syncDirectory, writable: async () => true },
      { olderThanMs: 1000 },
    );
    assert.deepEqual(refused, { archived: [], skipped: [{ runId: blocked, reason: `the archive directory ${high} could not be synced: cannot open ${high}` }] });
    assert.deepEqual(await store.readJournal(blocked), journal);

    events.length = 0;
    const asked: string[] = [];
    const result = await archiveFinishedRuns(
      {
        store: recording(store, events), clock, dataDir: dir, syncFile: async () => undefined, syncDirectory,
        writable: async (path) => { asked.push(path); return false; },
      },
      { olderThanMs: 1000 },
    );
    assert.deepEqual(result.archived.map((x) => x.runId), [blocked]);
    assert.deepEqual(asked, [high]);
    assert.deepEqual(events, [`sync ${join(dir, "archive", "2026-02")}`, ...ancestry(join(dir, "archive")), `archiveJournal ${blocked}`],
      "the directories above the skipped one are still synced before the rows go");
  });
}

test("an existing complete archive at the path (EEXIST) is synced by this pass before the rows go", async (t) => {
  const clock = createFakeClock(Date.parse("2026-02-10T00:00:00Z"));
  const { store, dir } = await openTestStore(t, { clock });
  const { agent } = await store.saveAgent({ definition: testAgentDefinition() });
  const runId = await finishRun(store, agent.id, "completed", 2);
  clock.advance(DAY);
  const journal = await store.readJournal(runId);
  await mkdir(join(dir, "archive", "2026-02"), { recursive: true });
  const written = gzipSync(Buffer.from(journal.map((r) => JSON.stringify(r)).join("\n") + "\n"));
  await writeFile(archiveFile(dir, runId), written, { mode: 0o600 });
  const ino = (await stat(archiveFile(dir, runId))).ino;
  const events: string[] = [];
  const result = await archiveFinishedRuns({ store: recording(store, events), clock, dataDir: dir, ...recordingSyncs(events) }, { olderThanMs: 1000 });
  assert.deepEqual(result.archived.map((x) => x.runId), [runId]);
  assert.equal((await stat(archiveFile(dir, runId))).ino, ino, "the complete archive is kept");
  assert.deepEqual(await readFile(archiveFile(dir, runId)), written);
  const fileAt = events.indexOf(`file ${archiveFile(dir, runId)}`);
  assert.ok(fileAt >= 0 && fileAt < events.indexOf(`archiveJournal ${runId}`), "the file another writer left is synced before the rows go");
  assert.deepEqual(events, [
    `file ${archiveFile(dir, runId)}`, `sync ${join(dir, "archive", "2026-02")}`, ...ancestry(join(dir, "archive")), `archiveJournal ${runId}`,
  ]);
});

test("a failing file sync skips the run with the reason, keeps its rows and leaves no temp file", async (t) => {
  const clock = createFakeClock(Date.parse("2026-02-10T00:00:00Z"));
  const { store, dir } = await openTestStore(t, { clock });
  const { agent } = await store.saveAgent({ definition: testAgentDefinition() });
  const runId = await finishRun(store, agent.id, "completed", 2);
  clock.advance(DAY);
  const journal = await store.readJournal(runId);
  const events: string[] = [];
  const result = await archiveFinishedRuns({
    store: recording(store, events), clock, dataDir: dir,
    syncDirectory: recordingSyncs(events).syncDirectory,
    syncFile: async (path) => {
      events.push(`file ${path}`);
      throw ioError("the disk went away");
    },
  }, { olderThanMs: 1000 });
  assert.deepEqual(result.archived, []);
  assert.deepEqual(result.skipped, [{ runId, reason: `the archive file ${archiveFile(dir, runId)} could not be synced: the disk went away` }]);
  assert.deepEqual(events, [`file ${archiveFile(dir, runId)}`]);
  assert.deepEqual(await store.readJournal(runId), journal);
  assert.equal((await store.getRun(runId))?.journalArchivedAt, null);
  assert.deepEqual(await tempFiles(dir), []);
});

test("the default file sync opens the published archive for writing, and its error skips the run", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root may open a read-only file for writing");
    return;
  }
  const clock = createFakeClock(Date.parse("2026-02-10T00:00:00Z"));
  const { store, dir } = await openTestStore(t, { clock });
  const { agent } = await store.saveAgent({ definition: testAgentDefinition() });
  const locked = await finishRun(store, agent.id, "completed", 1);
  const fresh = await finishRun(store, agent.id, "completed", 1);
  clock.advance(DAY);
  const journal = await store.readJournal(locked);
  await mkdir(join(dir, "archive", "2026-02"), { recursive: true });
  await writeFile(archiveFile(dir, locked), gzipSync(Buffer.from(journal.map((r) => JSON.stringify(r)).join("\n") + "\n")), { mode: 0o400 });
  t.after(() => chmod(archiveFile(dir, locked), 0o600).catch(() => undefined));
  const events: string[] = [];
  const result = await archiveFinishedRuns(
    { store: recording(store, events), clock, dataDir: dir, syncDirectory: recordingSyncs(events).syncDirectory },
    { olderThanMs: 1000 },
  );
  assert.deepEqual(result.archived.map((x) => x.runId), [fresh], "the archive the default sync could open is archived");
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0]?.runId, locked);
  assert.match(result.skipped[0]?.reason ?? "", new RegExp(`^the archive file .*${locked}\\.jsonl\\.gz could not be synced: .*EACCES`));
  assert.ok(!events.includes(`archiveJournal ${locked}`));
  assert.deepEqual(await store.readJournal(locked), journal);
  assert.deepEqual(await tempFiles(dir), []);
});

test("a relative, non-normalised data directory walks the resolved chain up to the file-system root", async (t) => {
  const clock = createFakeClock(Date.parse("2026-02-10T00:00:00Z"));
  const { store, dir } = await openTestStore(t, { clock });
  const { agent } = await store.saveAgent({ definition: testAgentDefinition() });
  const runId = await finishRun(store, agent.id, "completed", 1);
  clock.advance(DAY);
  const dataDir = `${relative(process.cwd(), dir)}/./`;
  const events: string[] = [];
  const result = await archiveFinishedRuns({ store: recording(store, events), clock, dataDir, ...recordingSyncs(events) }, { olderThanMs: 1000 });
  assert.deepEqual(result.archived.map((x) => x.runId), [runId]);
  const month = join(dataDir, "archive", "2026-02");
  assert.deepEqual(events, [
    `file ${join(month, `${runId}.jsonl.gz`)}`, `sync ${month}`, ...ancestry(join(dir, "archive")),
    `archiveJournal ${runId}`,
  ]);
});

test("replacing an invalid archive with rename is followed by the file and directory syncs before the rows go", async (t) => {
  const clock = createFakeClock(Date.parse("2026-02-10T00:00:00Z"));
  const { store, dir } = await openTestStore(t, { clock });
  const { agent } = await store.saveAgent({ definition: testAgentDefinition() });
  const runId = await finishRun(store, agent.id, "completed", 1);
  clock.advance(DAY);
  const journal = await store.readJournal(runId);
  await mkdir(join(dir, "archive", "2026-02"), { recursive: true });
  await writeFile(archiveFile(dir, runId), "not an archive");
  const events: string[] = [];
  const records = async (): Promise<number> => archiveLines(await readFile(archiveFile(dir, runId))).length;
  const syncFile = async (path: string): Promise<void> => void events.push(`file ${path} ${await records()}`);
  const syncDirectory = async (path: string): Promise<void> => void events.push(`sync ${path} ${await records()}`);
  const result = await archiveFinishedRuns({ store: recording(store, events), clock, dataDir: dir, syncFile, syncDirectory }, { olderThanMs: 1000 });
  assert.deepEqual(result.archived.map((x) => x.runId), [runId]);
  const n = journal.length;
  assert.deepEqual(events, [
    `file ${archiveFile(dir, runId)} ${n}`, `sync ${join(dir, "archive", "2026-02")} ${n}`, ...ancestry(join(dir, "archive"), ` ${n}`),
    `archiveJournal ${runId}`,
  ]);
});

test("olderThanMs and limit must be finite, non-negative numbers (limit an integer)", async (t) => {
  const clock = createFakeClock(Date.parse("2026-02-10T00:00:00Z"));
  const { store, dir } = await openTestStore(t, { clock });
  const { agent } = await store.saveAgent({ definition: testAgentDefinition() });
  const runId = await finishRun(store, agent.id, "completed", 1);
  clock.advance(DAY);
  const journal = await store.readJournal(runId);
  const bad: { olderThanMs: number; limit?: number }[] = [
    { olderThanMs: Number.NaN }, { olderThanMs: -1 }, { olderThanMs: Number.POSITIVE_INFINITY },
    { olderThanMs: 0, limit: 1.5 }, { olderThanMs: 0, limit: -1 }, { olderThanMs: 0, limit: Number.NaN },
  ];
  for (const options of bad) {
    await assert.rejects(archiveFinishedRuns({ store, clock, dataDir: dir }, options),
      (error: unknown) => error instanceof RunwrightError && error.code === "bad_request", JSON.stringify(options));
  }
  assert.deepEqual(await store.readJournal(runId), journal);
  await assert.rejects(stat(join(dir, "archive")), { code: "ENOENT" });
  assert.deepEqual(await archiveFinishedRuns({ store, clock, dataDir: dir }, { olderThanMs: 0, limit: 0 }), { archived: [], skipped: [] });
});

// ---- Archiving and verifying a journal hold one page of records, whatever its size (R14D-store-01) ----

/** A finished run whose journal holds `notes` note records of about `bytes` bytes each, written in commits of 1000. */
async function finishLongRun(store: Store, agentId: string, notes: number, bytes = 16): Promise<string> {
  const { run } = await store.createRun({ agentId, input: { message: "long", data: null } });
  const claimed = await store.claimRuns({ runnerId: "runner-a", limit: 10, leaseMs: 60_000 });
  const mine = claimed.find((c) => c.run.id === run.id);
  assert.ok(mine !== undefined);
  const filler = "x".repeat(bytes);
  for (let done = 0; done < notes; done += 1000) {
    const records = Array.from({ length: Math.min(1000, notes - done) }, (_, i) => ({ type: "note", key: `s${done + i}`, data: { i: done + i, filler } }));
    await store.commit(mine.lease, { records });
  }
  await store.commit(mine.lease, { records: [{ type: "run.finished", data: {} }], transition: { to: "completed", output: null } });
  return run.id;
}

async function wholeJournal(store: Store, runId: string): Promise<JournalRecord[]> {
  const all: JournalRecord[] = [];
  for (let page = await store.readJournal(runId, { limit: JOURNAL_PAGE }); page.length > 0; page = await store.readJournal(runId, { afterSeq: all.at(-1)?.seq ?? 0, limit: JOURNAL_PAGE })) {
    all.push(...page);
    if (page.length < JOURNAL_PAGE) break;
  }
  return all;
}

test("(R14D-store-01) the streamed archive gunzips to exactly one JSON.stringify line per record", async (t) => {
  const clock = createFakeClock(Date.parse("2026-02-10T00:00:00Z"));
  const { store, dir } = await openTestStore(t, { clock });
  const { agent } = await store.saveAgent({ definition: testAgentDefinition() });
  const runId = await finishRun(store, agent.id, "completed", 4);
  clock.advance(DAY);
  const journal = await store.readJournal(runId);
  const result = await archiveFinishedRuns({ store, clock, dataDir: dir }, { olderThanMs: 1000 });
  assert.deepEqual(result.archived.map((x) => [x.runId, x.records]), [[runId, journal.length]]);
  assert.equal(gunzipSync(await readFile(archiveFile(dir, runId))).toString("utf8"), journal.map((record) => `${JSON.stringify(record)}\n`).join(""));
});

test("(R14D-store-01) every journal read asks for one page; the write and the verification each page through the journal", async (t) => {
  const clock = createFakeClock(Date.parse("2026-02-10T00:00:00Z"));
  const { store, dir } = await openTestStore(t, { clock });
  const { agent } = await store.saveAgent({ definition: testAgentDefinition() });
  const runId = await finishLongRun(store, agent.id, 5 * JOURNAL_PAGE + 1);
  clock.advance(DAY);
  const total = (await store.getRun(runId))?.journalSeq;
  assert.equal(total, 5 * JOURNAL_PAGE + 3);
  const calls: { afterSeq: number; limit: number | undefined; returned: number }[] = [];
  const paged = wrap(store, {
    readJournal: async (id, options) => {
      const page = await store.readJournal(id, options);
      calls.push({ afterSeq: options?.afterSeq ?? 0, limit: options?.limit, returned: page.length });
      return page;
    },
  });
  const result = await archiveFinishedRuns({ store: paged, clock, dataDir: dir }, { olderThanMs: 1000 });
  assert.deepEqual(result.archived.map((x) => [x.runId, x.records]), [[runId, total]]);
  assert.ok(calls.every((call) => call.limit !== undefined && call.limit <= JOURNAL_PAGE && call.returned <= JOURNAL_PAGE), JSON.stringify(calls));
  const pass = Array.from({ length: 6 }, (_, i) => i * JOURNAL_PAGE);
  assert.deepEqual(calls.map((call) => call.afterSeq), [...pass, ...pass], "one paged read to write, one to verify");
  assert.deepEqual(await store.readJournal(runId), []);
});

test("(R14D-store-01) a journal of 20 000 records of 1 KiB archives, verifies and deletes its rows", { timeout: 120_000 }, async (t) => {
  const clock = createFakeClock(Date.parse("2026-02-10T00:00:00Z"));
  const { store, dir } = await openTestStore(t, { clock });
  const { agent } = await store.saveAgent({ definition: testAgentDefinition() });
  const runId = await finishLongRun(store, agent.id, 20_000, 1024);
  clock.advance(DAY);
  const journalSeq = (await store.getRun(runId))?.journalSeq;
  const result = await archiveFinishedRuns({ store, clock, dataDir: dir }, { olderThanMs: 1000 });
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.archived.map((x) => [x.runId, x.records]), [[runId, journalSeq]]);
  assert.deepEqual(await store.readJournal(runId), []);
  assert.ok((await store.getRun(runId))?.journalArchivedAt !== null);
  const lines = gunzipSync(await readFile(archiveFile(dir, runId))).toString("utf8").split("\n");
  assert.equal(lines.length, (journalSeq ?? 0) + 1);
  assert.equal(lines.at(-1), "");
  assert.deepEqual(await tempFiles(dir), []);
});

test("(R14D-store-01) verification names each defect of an archive file", async (t) => {
  const clock = createFakeClock(Date.parse("2026-02-10T00:00:00Z"));
  const { store, dir } = await openTestStore(t, { clock });
  const { agent } = await store.saveAgent({ definition: testAgentDefinition() });
  const runId = await finishRun(store, agent.id, "completed", 3);
  const otherId = await finishRun(store, agent.id, "completed", 3);
  const run = await store.getRun(runId);
  assert.ok(run !== null);
  const journal = await store.readJournal(runId);
  const other = await store.readJournal(otherId);
  const n = journal.length;
  const linesOf = (records: unknown[]): string => records.map((r) => `${JSON.stringify(r)}\n`).join("");
  const good = gzipSync(Buffer.from(linesOf(journal)));
  const changed = journal.map((r, i) => (i === 1 ? { ...r, data: { changed: true } } : r));
  const reseq = journal.map((r, i) => (i === 1 ? { ...r, seq: 99 } : r));
  const cases: { name: string; bytes: Buffer; reason: string | RegExp | null }[] = [
    { name: "complete", bytes: good, reason: null },
    { name: "complete, last line without a newline", bytes: gzipSync(Buffer.from(linesOf(journal).slice(0, -1))), reason: null },
    { name: "complete, other key order", bytes: gzipSync(Buffer.from(journal.map((r) => JSON.stringify(Object.fromEntries(Object.entries(r).reverse()))).join("\n"))), reason: null },
    { name: "truncated gzip", bytes: good.subarray(0, good.length - 6), reason: /^the file is not a readable gzip archive \(/ },
    { name: "not gzip", bytes: Buffer.from(linesOf(journal)), reason: /^the file is not a readable gzip archive \(/ },
    { name: "a line changed", bytes: gzipSync(Buffer.from(linesOf(changed))), reason: "line 2 of the file differs from the journal" },
    { name: "a line removed", bytes: gzipSync(Buffer.from(linesOf(journal.filter((_, i) => i !== 1)))), reason: `the file holds ${n - 1} records, not ${n}` },
    { name: "a line added", bytes: gzipSync(Buffer.from(linesOf([...journal, journal[0]]))), reason: `the file holds ${n + 1} records, not ${n}` },
    { name: "an empty line added", bytes: gzipSync(Buffer.from(`${linesOf(journal)}\n`)), reason: `the file holds ${n + 1} records, not ${n}` },
    { name: "a record of another run", bytes: gzipSync(Buffer.from(linesOf([other[0], ...journal.slice(1)]))), reason: "line 1 of the file belongs to another run" },
    { name: "a wrong seq", bytes: gzipSync(Buffer.from(linesOf(reseq))), reason: "line 2 of the file has the wrong seq" },
    { name: "a line that is not JSON", bytes: gzipSync(Buffer.from(linesOf(journal).replace(/^.*\n/, "{oops\n"))), reason: "line 1 of the file is not JSON" },
    { name: "a line far longer than its record", bytes: gzipSync(Buffer.from(linesOf(journal).replace(/^\{/, `{${" ".repeat(200_000)}`))), reason: "line 1 of the file differs from the journal" },
    { name: "empty", bytes: gzipSync(Buffer.alloc(0)), reason: `the file holds 0 records, not ${n}` },
  ];
  await mkdir(join(dir, "check"), { recursive: true });
  for (const item of cases) {
    const path = join(dir, "check", "archive.jsonl.gz");
    await writeFile(path, item.bytes);
    const reason = await verifyArchive(path, store, run);
    if (item.reason === null || typeof item.reason === "string") assert.equal(reason, item.reason, item.name);
    else assert.match(reason ?? "", item.reason, item.name);
  }
  assert.match(await verifyArchive(join(dir, "check", "missing.jsonl.gz"), store, run) ?? "", /^the file is not a readable gzip archive \(.*ENOENT/);
});

test("(R14D-store-01) an incomplete journal, a gap or a missing tail, is skipped with its count and leaves no file", async (t) => {
  const clock = createFakeClock(Date.parse("2026-02-10T00:00:00Z"));
  const { store, dir } = await openTestStore(t, { clock });
  const { agent } = await store.saveAgent({ definition: testAgentDefinition() });
  const gap = await finishLongRun(store, agent.id, 2500);
  const tail = await finishRun(store, agent.id, "completed", 3);
  clock.advance(DAY);
  const seqs = new Map<string, number>();
  for (const id of [gap, tail]) seqs.set(id, (await store.getRun(id))?.journalSeq ?? 0);
  const gapSeq = (seqs.get(gap) ?? 0) - 1;
  assert.notEqual(gapSeq % JOURNAL_PAGE, 0, "the gap and the record after it share the last page");
  const holey = wrap(store, {
    readJournal: async (runId, options) => {
      const page = await store.readJournal(runId, options);
      // In the last page, so the short page is the journal's end as the store says it, not an early one.
      if (runId === gap) return page.filter((r) => r.seq !== gapSeq);
      if (runId === tail) return page.filter((r) => r.seq !== seqs.get(tail));
      return page;
    },
  });
  const result = await archiveFinishedRuns({ store: holey, clock, dataDir: dir }, { olderThanMs: 1000 });
  assert.deepEqual(result.archived, []);
  const reasons = new Map(result.skipped.map((s) => [s.runId, s.reason]));
  assert.equal(reasons.get(gap), `the journal is incomplete: ${(seqs.get(gap) ?? 0) - 1} readable records, journal seq ${seqs.get(gap)}`);
  assert.equal(reasons.get(tail), `the journal is incomplete: ${(seqs.get(tail) ?? 0) - 1} readable records, journal seq ${seqs.get(tail)}`);
  for (const id of [gap, tail]) {
    await assert.rejects(stat(archiveFile(dir, id)), { code: "ENOENT" });
    assert.equal((await store.readJournal(id, { limit: 1 })).length, 1, "the rows are kept");
  }
  assert.deepEqual(await tempFiles(dir), []);
});

test("(R14D-store-01) a failure in the middle of the write leaves no temp file, no archive and every row", async (t) => {
  const clock = createFakeClock(Date.parse("2026-02-10T00:00:00Z"));
  const { store, dir } = await openTestStore(t, { clock });
  const { agent } = await store.saveAgent({ definition: testAgentDefinition() });
  const runId = await finishLongRun(store, agent.id, 3500, 256);
  clock.advance(DAY);
  const journal = await wholeJournal(store, runId);

  let reads = 0;
  const failingStore = wrap(store, {
    readJournal: async (id, options) => {
      reads++;
      if (reads === 3) throw new RunwrightError("store_error", "the database went away on page 3");
      return store.readJournal(id, options);
    },
  });
  const storeFailure = await archiveFinishedRuns({ store: failingStore, clock, dataDir: dir }, { olderThanMs: 1000 });
  assert.deepEqual(storeFailure.archived, []);
  assert.deepEqual(storeFailure.skipped, [{ runId, reason: "the database went away on page 3" }]);
  assert.equal(reads, 3);

  let writes = 0;
  const failingDisk = async (path: string): Promise<FileHandle> => {
    const handle = await open(path, "wx", 0o600);
    return new Proxy(handle, {
      get(target, property, receiver) {
        if (property === "write") {
          return async (...args: Parameters<FileHandle["write"]>) => {
            writes++;
            if (writes === 2) throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
            return (target.write as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
  };
  const diskFailure = await archiveFinishedRuns({ store, clock, dataDir: dir, openTemp: failingDisk }, { olderThanMs: 1000 });
  assert.deepEqual(diskFailure.archived, []);
  assert.deepEqual(diskFailure.skipped, [{ runId, reason: "no space left on device" }]);
  assert.ok(writes >= 2);

  for (const _ of [storeFailure, diskFailure]) {
    await assert.rejects(stat(archiveFile(dir, runId)), { code: "ENOENT" });
  }
  assert.deepEqual(await tempFiles(dir), []);
  assert.deepEqual(await wholeJournal(store, runId), journal);
  assert.equal((await store.getRun(runId))?.journalArchivedAt, null);
  const retry = await archiveFinishedRuns({ store, clock, dataDir: dir }, { olderThanMs: 1000 });
  assert.deepEqual(retry.archived.map((x) => x.runId), [runId]);
});
