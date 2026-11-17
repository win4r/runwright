import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createFakeClock, type FakeClock } from "../../src/core/clock.ts";
import type { IdSource } from "../../src/core/ids.ts";
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from "../../src/store/migrations.ts";
import { openSqliteStore } from "../../src/store/sqlite.ts";
import type { Store } from "../../src/store/types.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { testAgentDefinition } from "../helpers/store.ts";

/** Ids that go down: every id this source makes sorts before the one it made last, and before every id of `start + n`. */
function descendingIds(start: number): IdSource {
  let next = start;
  return { next: (prefix) => `${prefix}_${String(next--).padStart(8, "0")}` };
}

/** Two handles on one database file, each with its own descending id source, sharing `clock`. */
async function twoHandles(t: TestContext, clock: FakeClock): Promise<{ a: Store; b: Store; runId: string }> {
  const dir = await makeTempDir(t, "runwright-command-order-");
  const path = join(dir, "runwright.db");
  // B's ids are all smaller than A's: an order by id puts B's command first.
  const a = await openSqliteStore({ path, clock, ids: descendingIds(90_000_000) });
  const b = await openSqliteStore({ path, clock, ids: descendingIds(10_000_000) });
  t.after(async () => {
    await a.close();
    await b.close();
  });
  await a.saveAgent({ id: "agent", definition: testAgentDefinition() });
  const { run } = await a.createRun({ agentId: "agent", input: { message: "go", data: null } });
  return { a, b, runId: run.id };
}

const types = async (store: Store, runId: string, unconsumedOnly = false): Promise<string[]> =>
  (await store.listCommands(runId, { unconsumedOnly })).map((c) => c.command.type);

test("(R15D-store-01) pause through one handle then resume through another in the same millisecond are listed pause, resume", async (t) => {
  const clock = createFakeClock(5_000);
  const { a, b, runId } = await twoHandles(t, clock);
  const pause = await a.enqueueCommand(runId, { type: "pause" });
  const resume = await b.enqueueCommand(runId, { type: "resume" });
  assert.equal(pause.createdAt, resume.createdAt, "one fixed clock");
  assert.ok(resume.id < pause.id, "the later command has the smaller id");
  for (const store of [a, b]) {
    assert.deepEqual(await types(store, runId), ["pause", "resume"]);
    assert.deepEqual(await types(store, runId, true), ["pause", "resume"]);
  }
});

test("(R15D-store-01) a clock that steps back between two enqueues does not reorder them", async (t) => {
  const clock = createFakeClock(5_000);
  const { a, b, runId } = await twoHandles(t, clock);
  await a.enqueueCommand(runId, { type: "pause" });
  clock.set(4_000);
  const resume = await b.enqueueCommand(runId, { type: "resume" });
  assert.equal(resume.createdAt, 4_000);
  clock.set(3_000);
  await a.enqueueCommand(runId, { type: "message", text: "third" });
  for (const store of [a, b]) {
    assert.deepEqual(await types(store, runId), ["pause", "resume", "message"]);
    assert.deepEqual(await types(store, runId, true), ["pause", "resume", "message"]);
  }
  // Consuming the first leaves the rest in arrival order.
  clock.set(10_000);
  const [claim] = await a.claimRuns({ runnerId: "r", limit: 1, leaseMs: 60_000 });
  assert.ok(claim !== undefined);
  const first = (await a.listCommands(runId))[0];
  await a.commit(claim.lease, { records: [], consumeCommands: [first?.id as string] });
  assert.deepEqual(await types(b, runId, true), ["resume", "message"]);
});

test("(R15D-store-01) commands of different runs share one arrival sequence", async (t) => {
  const clock = createFakeClock(5_000);
  const { a, b, runId } = await twoHandles(t, clock);
  const { run: other } = await b.createRun({ agentId: "agent", input: { message: "other", data: null } });
  await a.enqueueCommand(runId, { type: "pause" });
  await b.enqueueCommand(other.id, { type: "pause" });
  await b.enqueueCommand(runId, { type: "resume" });
  await a.enqueueCommand(other.id, { type: "resume" });
  assert.deepEqual(await types(a, runId), ["pause", "resume"]);
  assert.deepEqual(await types(b, other.id), ["pause", "resume"]);
});

/** A database at schema version 7 (every migration up to 7 applied as the store applies them), with one run. */
function schema7Database(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  for (const migration of MIGRATIONS.filter((m) => m.version <= 7)) {
    for (const statement of migration.statements) db.exec(statement);
    migration.rewrite?.(db);
    for (const statement of migration.finish ?? []) db.exec(statement);
  }
  db.prepare("INSERT INTO agents (id, name, current_revision, created_at, updated_at) VALUES ('old', 'Old', 1, 1, 1)").run();
  db.prepare(`INSERT INTO agent_revisions (agent_id, revision, definition, definition_hash, created_at)
    VALUES ('old', 1, '{"name":"Old","instructions":"","model":{"provider":"scripted","name":"scripted-1"},"tools":[],"limits":{},"learning":false}', 'h', 1)`).run();
  db.prepare(`INSERT INTO runs (id, agent_id, revision, status, input, limits, available_at, journal_seq, created_at, updated_at)
    VALUES ('run_old', 'old', 1, 'queued', '{"message":"hi","data":null}', '{"maxCostMicros":null,"maxToolCalls":null,"maxTurns":null,"allowUnpriced":false}', 1, 1, 1, 1)`).run();
  return db;
}

test("(R15D-store-01) a schema-7 database with commands upgrades, keeps their old order, and lists new ones after them", async (t) => {
  const dir = await makeTempDir(t, "runwright-command-order-");
  const path = join(dir, "v7.db");
  const db = schema7Database(path);
  const insert = db.prepare("INSERT INTO commands (id, run_id, type, payload, created_at, consumed_at) VALUES (?, 'run_old', ?, ?, ?, ?)");
  // The old order is (created_at, id): cmd_b (t=10), cmd_c (t=10, consumed), cmd_a (t=20).
  insert.run("cmd_a", "resume", '{"type":"resume"}', 20, null);
  insert.run("cmd_c", "message", '{"type":"message","text":"seen"}', 10, 15);
  insert.run("cmd_b", "pause", '{"type":"pause"}', 10, null);
  db.close();

  // The clock reads earlier than every stored command and the ids sort before them: neither may decide the order.
  const store = await openSqliteStore({ path, clock: createFakeClock(1), ids: descendingIds(100) });
  t.after(() => store.close());
  assert.equal(store.schemaVersion, LATEST_SCHEMA_VERSION);
  assert.deepEqual((await store.listCommands("run_old")).map((c) => c.id), ["cmd_b", "cmd_c", "cmd_a"]);
  assert.deepEqual((await store.listCommands("run_old", { unconsumedOnly: true })).map((c) => c.id), ["cmd_b", "cmd_a"]);
  const added = await store.enqueueCommand("run_old", { type: "cancel", reason: null });
  assert.ok(added.id < "cmd_a" && added.createdAt < 10);
  assert.deepEqual((await store.listCommands("run_old")).map((c) => c.id), ["cmd_b", "cmd_c", "cmd_a", added.id]);
  assert.deepEqual((await store.listCommands("run_old", { unconsumedOnly: true })).map((c) => c.id), ["cmd_b", "cmd_a", added.id]);

  const check = new DatabaseSync(path, { readOnly: true });
  t.after(() => check.close());
  const seqs = check.prepare("SELECT id, seq FROM commands ORDER BY seq").all().map((r) => [r["id"], r["seq"]]);
  assert.deepEqual(seqs, [["cmd_b", 1], ["cmd_c", 2], ["cmd_a", 3], [added.id, 4]]);
  const index = (name: string): string => String(check.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(name)?.["sql"]);
  assert.match(index("commands_seq"), /UNIQUE INDEX commands_seq ON commands\(seq\)/);
  assert.match(index("commands_unconsumed"), /ON commands\(run_id, seq\) WHERE consumed_at IS NULL/);
  assert.throws(() => check.prepare("INSERT INTO commands (id, run_id, type, payload, created_at, seq) VALUES ('x', 'run_old', 'pause', '{}', 1, 1)").run());
});
