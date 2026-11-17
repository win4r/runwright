import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from "../../src/store/migrations.ts";
import { openSqliteStore } from "../../src/store/sqlite.ts";
import { isRunwrightError } from "../../src/core/errors.ts";
import { sha256Hex } from "../../src/core/json.ts";
import { idempotencyDigest, requestFingerprint } from "../../src/store/idempotency.ts";
import type { RunInput } from "../../src/store/types.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { openTestStore } from "../helpers/store.ts";

test("a fresh database is at the latest version, in WAL mode", async (t) => {
  const { store, path } = await openTestStore(t);
  assert.equal(store.schemaVersion, LATEST_SCHEMA_VERSION);
  assert.equal(LATEST_SCHEMA_VERSION, 8);
  const db = new DatabaseSync(path, { readOnly: true });
  t.after(() => db.close());
  const versions = db.prepare("SELECT version, name FROM schema_version ORDER BY version").all().map((r) => ({ ...r }));
  assert.deepEqual(versions, MIGRATIONS.map((m) => ({ version: m.version, name: m.name })));
  assert.deepEqual(versions.map((v) => v["name"]), ["core", "workflows-and-archive", "promotion-pointer", "idempotency-digest", "wake-at", "usage-saturation", "secret-history", "command-seq"]);
  const index = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'runs_idempotency'").get();
  assert.match(String(index?.["sql"]), /UNIQUE INDEX runs_idempotency/);
  assert.equal(db.prepare("PRAGMA journal_mode").get()?.["journal_mode"], "wal");
});

test("a version-1 database with data upgrades and keeps the data", async (t) => {
  const dir = await makeTempDir(t);
  const path = join(dir, "old.db");
  const db = new DatabaseSync(path);
  for (const statement of MIGRATIONS[0]!.statements) db.exec(statement);
  db.prepare("INSERT INTO agents (id, name, current_revision, created_at, updated_at) VALUES ('old', 'Old', 1, 1, 1)").run();
  db.prepare(`INSERT INTO agent_revisions (agent_id, revision, definition, definition_hash, created_at)
    VALUES ('old', 1, '{"name":"Old","instructions":"","model":{"provider":"scripted","name":"scripted-1"},"tools":[],"limits":{},"learning":false}', 'h', 1)`).run();
  db.prepare(`INSERT INTO runs (id, agent_id, revision, status, input, limits, available_at, journal_seq, created_at, updated_at)
    VALUES ('run_old', 'old', 1, 'completed', '{"message":"hi","data":null}', '{"maxCostMicros":null,"maxToolCalls":null,"maxTurns":null,"allowUnpriced":false}', 1, 0, 1, 1)`).run();
  db.close();

  const store = await openSqliteStore({ path });
  t.after(() => store.close());
  assert.equal(store.schemaVersion, LATEST_SCHEMA_VERSION);
  const run = await store.getRun("run_old");
  assert.equal(run?.status, "completed");
  assert.equal(run?.input.message, "hi");
  assert.equal(run?.journalArchivedAt, null);
  assert.equal((await store.getAgent("old"))?.name, "Old");
  const { created } = await store.saveWorkflow({ name: "w", document: { name: "w" } as never, source: "api" });
  assert.equal(created, true);
});

test("a version-2 database whose same-named skills collided on one workflow name gets each skill's own version", async (t) => {
  const dir = await makeTempDir(t);
  const path = join(dir, "v2.db");
  const db = new DatabaseSync(path);
  for (const migration of MIGRATIONS.filter((m) => m.version <= 2)) for (const statement of migration.statements) db.exec(statement);
  const agent = db.prepare("INSERT INTO agents (id, name, current_revision, created_at, updated_at) VALUES (?, ?, 1, 1, 1)");
  agent.run("alpha", "Alpha");
  agent.run("beta", "Beta");
  agent.run("gamma", "Gamma");
  agent.run("delta", "Delta");
  const skill = db.prepare(`INSERT INTO learning_items (id, agent_id, kind, name, title, description, body, status, version, etag,
    source_run_id, promoted_workflow, promotion_attempts, created_at, updated_at)
    VALUES (?, ?, 'skill', 'report', 'Report', 'How to report', 'Steps.', 'active', 2, '2-0', NULL, ?, 1, 1, 1)`);
  skill.run("li_alpha", "alpha", "skill-report");
  skill.run("li_beta", "beta", "skill-report");
  skill.run("li_gamma", "gamma", "skill-missing");
  skill.run("li_plain", "delta", null);
  const workflow = db.prepare(`INSERT INTO workflows (name, version, document, document_hash, source, skill_item_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1)`);
  workflow.run("skill-report", 1, '{"name":"skill-report","description":"alpha"}', "h1", "promotion", "li_alpha");
  workflow.run("skill-report", 2, '{"name":"skill-report","description":"beta"}', "h2", "promotion", "li_beta");
  workflow.run("skill-missing", 1, '{"name":"skill-missing"}', "h3", "api", null);
  db.close();

  const store = await openSqliteStore({ path });
  t.after(() => store.close());
  assert.equal(store.schemaVersion, LATEST_SCHEMA_VERSION);
  const pointer = async (id: string) => {
    const item = await store.getLearningItem(id);
    return [item?.promotedWorkflow, item?.promotedWorkflowVersion];
  };
  assert.deepEqual(await pointer("li_alpha"), ["skill-report", 1]);
  assert.deepEqual(await pointer("li_beta"), ["skill-report", 2]);
  assert.deepEqual(await pointer("li_gamma"), ["skill-missing", null], "no workflow row owned by the skill → null");
  assert.deepEqual(await pointer("li_plain"), [null, null]);
  assert.equal((await store.getWorkflow("skill-report", 1))?.document.description, "alpha");
});

const LIMITS = '{"maxCostMicros":null,"maxToolCalls":null,"maxTurns":null,"allowUnpriced":false}';

interface V3Run { id: string; key: string | null; input: RunInput; hash: string | null; createdAt: number }

/** A schema-3 database file as round 3 left it: migrations 1 to 3 applied by hand, then rows written directly. */
async function schema3Database(t: import("node:test").TestContext, runs: readonly V3Run[]): Promise<string> {
  const dir = await makeTempDir(t);
  const path = join(dir, "v3.db");
  const db = new DatabaseSync(path);
  for (const migration of MIGRATIONS.filter((m) => m.version <= 3)) for (const statement of migration.statements) db.exec(statement);
  db.prepare("INSERT INTO agents (id, name, current_revision, created_at, updated_at) VALUES ('old', 'Old', 1, 1, 1)").run();
  db.prepare(`INSERT INTO agent_revisions (agent_id, revision, definition, definition_hash, created_at)
    VALUES ('old', 1, '{"name":"Old","instructions":"","model":{"provider":"scripted","name":"scripted-1"},"tools":[],"limits":{},"learning":false}', 'h', 1)`).run();
  const insert = db.prepare(`INSERT INTO runs (id, agent_id, revision, status, input, limits, idempotency_key, request_hash,
    available_at, journal_seq, created_at, updated_at) VALUES (?, 'old', 1, 'completed', ?, ?, ?, ?, ?, 1, ?, ?)`);
  for (const run of runs) insert.run(run.id, JSON.stringify(run.input), LIMITS, run.key, run.hash, run.createdAt, run.createdAt, run.createdAt);
  db.close();
  return path;
}

/** Every run row and the schema_version rows, read straight from the file. */
function snapshot(path: string): { runs: Record<string, unknown>[]; versions: Record<string, unknown>[] } {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      runs: db.prepare("SELECT * FROM runs ORDER BY id").all().map((r) => ({ ...r })),
      versions: db.prepare("SELECT * FROM schema_version ORDER BY version").all().map((r) => ({ ...r })),
    };
  } finally {
    db.close();
  }
}

/** The request hash round 3 stored for a POST /v1/runs of agent "old" without revision and limits. */
const hashOf = (input: RunInput): string => requestFingerprint({ agentId: "old", input });

test("migration 4 turns every stored key into its digest and resolves the duplicates round 3 produced", async (t) => {
  const secretKey = "k-secret-0123456789-value";
  const plainInput = { message: "plain", data: null };
  const pairInput = { message: "pair", data: { n: 1 } };
  const redactedInput = { message: "deploy with [redacted]", data: { token: "[redacted]" } };
  const hashedInput = { message: "hashed", data: null };
  const runs: V3Run[] = [
    { id: "run_plain", key: "k-plain", input: plainInput, hash: hashOf(plainInput), createdAt: 10 },
    { id: "run_secret", key: `redacted-sha256:${sha256Hex(secretKey)}`, input: redactedInput, hash: hashOf(redactedInput), createdAt: 20 },
    // The pair the bug produced: one key stored once as text and, after a secret appeared, once as a digest.
    { id: "run_pair_b", key: `redacted-sha256:${sha256Hex("k-pair")}`, input: pairInput, hash: hashOf(pairInput), createdAt: 40 },
    { id: "run_pair_a", key: "k-pair", input: pairInput, hash: hashOf(pairInput), createdAt: 30 },
    { id: "run_hashed", key: "k-hashed", input: hashedInput, hash: hashOf(hashedInput), createdAt: 50 },
    { id: "run_nokey", key: null, input: { message: "no key [redacted]", data: null }, hash: "f".repeat(64), createdAt: 60 },
    { id: "run_lookalike", key: "sha256:not-a-digest", input: plainInput, hash: hashOf(plainInput), createdAt: 70 },
  ];
  const path = await schema3Database(t, runs);
  const before = snapshot(path);

  const store = await openSqliteStore({ path });
  t.after(() => store.close());
  assert.equal(store.schemaVersion, LATEST_SCHEMA_VERSION);
  const after = snapshot(path);
  const row = (id: string) => after.runs.find((r) => r["id"] === id) as Record<string, unknown>;
  const old = (id: string) => before.runs.find((r) => r["id"] === id) as Record<string, unknown>;

  assert.equal(row("run_plain")["idempotency_key"], idempotencyDigest("k-plain"));
  assert.equal(row("run_secret")["idempotency_key"], `sha256:${sha256Hex(secretKey)}`);
  assert.equal(row("run_secret")["idempotency_key"], idempotencyDigest(secretKey));
  assert.equal(row("run_pair_a")["idempotency_key"], idempotencyDigest("k-pair"), "the older run keeps the digest");
  assert.equal(row("run_pair_b")["idempotency_key"], null, "the younger duplicate loses it");
  assert.equal(row("run_lookalike")["idempotency_key"], idempotencyDigest("sha256:not-a-digest"), "only the round-3 form is read as a digest");
  assert.equal(row("run_nokey")["idempotency_key"], null);

  assert.equal(row("run_secret")["request_hash"], null, "a hash over redacted input is dropped");
  assert.equal(row("run_nokey")["request_hash"], null);
  for (const id of ["run_plain", "run_pair_a", "run_pair_b", "run_hashed", "run_lookalike"]) {
    assert.equal(row(id)["request_hash"], old(id)["request_hash"], `${id} keeps its hash`);
  }
  assert.equal(after.runs.length, runs.length, "no run is removed");
  for (const id of runs.map((r) => r.id)) {
    const { idempotency_key: _k1, request_hash: _h1, wake_at: wakeAt, ...rest } = row(id);
    assert.equal(wakeAt, null, `${id} has no wake time`);
    const { idempotency_key: _k2, request_hash: _h2, ...was } = old(id);
    assert.deepEqual(rest, was, `nothing else of ${id} changes`);
  }
  assert.deepEqual(after.versions.map((v) => [v["version"], v["name"]]).slice(-5), [[4, "idempotency-digest"], [5, "wake-at"], [6, "usage-saturation"], [7, "secret-history"], [8, "command-seq"]]);

  const same = (key: string, input: RunInput) => store.createRun({ agentId: "old", input, idempotencyKey: key });
  assert.deepEqual(await same("k-plain", plainInput).then((r) => [r.created, r.run.id]), [false, "run_plain"]);
  assert.deepEqual(await same(secretKey, redactedInput).then((r) => [r.created, r.run.id]), [false, "run_secret"]);
  assert.deepEqual(await same(secretKey, { message: "deploy with the real value", data: null }).then((r) => [r.created, r.run.id]),
    [false, "run_secret"], "no hash to compare: the key alone returns the run, no 409");
  assert.deepEqual(await same("k-pair", pairInput).then((r) => [r.created, r.run.id]), [false, "run_pair_a"]);
  assert.deepEqual(await same("k-hashed", hashedInput).then((r) => [r.created, r.run.id]), [false, "run_hashed"]);
  await assert.rejects(same("k-hashed", { message: "different", data: null }), (e: unknown) => isRunwrightError(e) && e.code === "idempotency_mismatch");
  assert.deepEqual(await same("sha256:not-a-digest", plainInput).then((r) => [r.created, r.run.id]), [false, "run_lookalike"]);

  const db = new DatabaseSync(path);
  t.after(() => db.close());
  assert.throws(() => db.prepare(`INSERT INTO runs (id, agent_id, revision, status, input, limits, idempotency_key, available_at,
    created_at, updated_at) VALUES ('run_dup', 'old', 1, 'queued', '{}', '{}', ?, 1, 1, 1)`).run(idempotencyDigest("k-plain")),
  /UNIQUE/, "the unique index is in place");
});

test("opening a migrated schema-3 database a second time changes nothing", async (t) => {
  const input = { message: "m", data: null };
  const path = await schema3Database(t, [
    { id: "run_1", key: "k-one", input, hash: hashOf(input), createdAt: 1 },
    { id: "run_2", key: `redacted-sha256:${sha256Hex("k-one")}`, input, hash: hashOf(input), createdAt: 2 },
    { id: "run_3", key: `redacted-sha256:${sha256Hex("k-two")}`, input: { message: "[redacted]", data: null }, hash: "e".repeat(64), createdAt: 3 },
  ]);
  const first = await openSqliteStore({ path });
  await first.close();
  const migrated = snapshot(path);
  const second = await openSqliteStore({ path });
  t.after(() => second.close());
  assert.equal(second.schemaVersion, LATEST_SCHEMA_VERSION);
  assert.deepEqual(snapshot(path), migrated);
  assert.deepEqual(migrated.runs.map((r) => r["idempotency_key"]), [idempotencyDigest("k-one"), null, idempotencyDigest("k-two")]);
  assert.equal((await second.createRun({ agentId: "old", input: { message: "x", data: null }, idempotencyKey: "k-two" })).run.id, "run_3");
});

test("migration 5 on a version-4 database adds wake_at (NULL on existing rows) and the partial wake index", async (t) => {
  const dir = await makeTempDir(t);
  const path = join(dir, "v4.db");
  const db = new DatabaseSync(path);
  for (const migration of MIGRATIONS.filter((m) => m.version <= 4)) {
    for (const statement of [...migration.statements, ...(migration.finish ?? [])]) db.exec(statement);
  }
  db.prepare("INSERT INTO agents (id, name, current_revision, created_at, updated_at) VALUES ('old', 'Old', 1, 1, 1)").run();
  const insert = db.prepare(`INSERT INTO runs (id, agent_id, revision, status, input, limits, available_at, journal_seq, created_at, updated_at)
    VALUES (?, 'old', 1, ?, '{"message":"m","data":null}', ?, 1, 0, 1, 1)`);
  insert.run("run_waiting", "waiting", LIMITS);
  insert.run("run_done", "completed", LIMITS);
  db.close();

  const store = await openSqliteStore({ path });
  t.after(() => store.close());
  assert.equal(store.schemaVersion, LATEST_SCHEMA_VERSION);
  const check = new DatabaseSync(path, { readOnly: true });
  t.after(() => check.close());
  const columns = check.prepare("PRAGMA table_info(runs)").all().map((r) => [r["name"], r["type"]]);
  assert.ok(columns.some(([name, type]) => name === "wake_at" && type === "INTEGER"), JSON.stringify(columns));
  const index = check.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'runs_wake'").get();
  assert.match(String(index?.["sql"]), /ON runs\(wake_at\) WHERE status = 'waiting' AND wake_at IS NOT NULL/);
  assert.deepEqual(check.prepare("SELECT id, wake_at FROM runs ORDER BY id").all().map((r) => ({ ...r })), [
    { id: "run_done", wake_at: null }, { id: "run_waiting", wake_at: null },
  ]);
  assert.deepEqual(await store.claimRuns({ runnerId: "r", limit: 5, leaseMs: 1000 }), [], "a migrated waiting run is not woken by time");
  assert.equal((await store.getRun("run_waiting"))?.status, "waiting");
});

test("reopening a current database applies nothing and keeps data", async (t) => {
  const dir = await makeTempDir(t);
  const path = join(dir, "db.sqlite");
  const first = await openSqliteStore({ path });
  await first.putSecret("KEY", new Uint8Array([1, 2, 3]));
  await first.close();
  const second = await openSqliteStore({ path });
  t.after(() => second.close());
  assert.deepEqual((await second.getSecret("KEY"))?.sealed, new Uint8Array([1, 2, 3]));
});

test("a database newer than this build is refused with schema_too_new", async (t) => {
  const dir = await makeTempDir(t);
  const path = join(dir, "new.db");
  const store = await openSqliteStore({ path });
  await store.close();
  const db = new DatabaseSync(path);
  db.prepare("INSERT INTO schema_version (version, name, applied_at) VALUES (99, 'future', 0)").run();
  db.close();
  await assert.rejects(openSqliteStore({ path }), (e: unknown) => isRunwrightError(e) && e.code === "schema_too_new");
});

test("the parent directory is created when missing", async (t) => {
  const dir = await makeTempDir(t);
  const store = await openSqliteStore({ path: join(dir, "a", "b", "runwright.db") });
  await store.close();
});

test("migration 6 clamps out-of-range usage counters written by an older build, so the database opens and reads", async (t) => {
  const dir = await makeTempDir(t);
  const path = join(dir, "v5.db");
  const db = new DatabaseSync(path);
  for (const migration of MIGRATIONS.filter((m) => m.version <= 5)) {
    for (const statement of [...migration.statements, ...(migration.finish ?? [])]) db.exec(statement);
  }
  db.prepare("INSERT INTO agents (id, name, current_revision, created_at, updated_at) VALUES ('old', 'Old', 1, 1, 1)").run();
  db.exec(`INSERT INTO runs (id, agent_id, revision, status, input, limits, available_at, journal_seq, created_at, updated_at,
      input_tokens, output_tokens, cost_micros, tool_calls, turns)
    VALUES ('run_big', 'old', 1, 'completed', '{"message":"m","data":null}', '${LIMITS}', 1, 0, 1, 1,
      9007199254740992, 1e300, 9223372036854775807, -3, 12)`);
  db.exec(`INSERT INTO usage (run_id, agent_id, model, purpose, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      cost_micros, assumed, day, at) VALUES
      ('run_big', 'old', 'm', 'run', 9007199254740991, 1, 0, 0, 9007199254740991, 0, '2026-01-01', 1),
      ('run_big', 'old', 'm', 'run', 9007199254740991, 2.5e300, 0, 0, NULL, 0, '2026-01-01', 1)`);
  db.close();

  const store = await openSqliteStore({ path });
  t.after(() => store.close());
  assert.equal(store.schemaVersion, LATEST_SCHEMA_VERSION);
  const run = await store.getRun("run_big");
  assert.deepEqual(
    [run?.usage.inputTokens, run?.usage.outputTokens, run?.usage.costMicros, run?.usage.toolCalls, run?.usage.turns],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 0, 12],
  );
  const [summary] = await store.usageSummary({ groupBy: "model" });
  assert.deepEqual([summary?.inputTokens, summary?.outputTokens, summary?.costMicros, summary?.unknownCostCalls],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 1]);
  const check = new DatabaseSync(path, { readOnly: true });
  t.after(() => check.close());
  assert.deepEqual(check.prepare("SELECT typeof(output_tokens) AS t FROM usage ORDER BY id").all().map((r) => r["t"]), ["integer", "integer"]);
});

test("migration 7: a version-6 database gets secret_history and keeps its secrets as they were", async (t) => {
  const dir = await makeTempDir(t);
  const path = join(dir, "v6.db");
  const db = new DatabaseSync(path);
  for (const migration of MIGRATIONS.filter((m) => m.version <= 6)) {
    for (const statement of [...migration.statements, ...(migration.finish ?? [])]) db.exec(statement);
  }
  db.prepare("INSERT INTO secrets (name, sealed, created_at, updated_at) VALUES (?, ?, 5, 6)").run("OLD_KEY", new Uint8Array([9, 8, 7]));
  db.close();

  const store = await openSqliteStore({ path });
  t.after(() => store.close());
  assert.equal(store.schemaVersion, LATEST_SCHEMA_VERSION);
  assert.deepEqual(await store.listSecrets(), [{ name: "OLD_KEY", updatedAt: 6 }]);
  assert.deepEqual((await store.getSecret("OLD_KEY"))?.sealed, new Uint8Array([9, 8, 7]));
  assert.deepEqual(await store.listRetiredSecrets(), [], "the upgrade retires nothing");
  const check = new DatabaseSync(path, { readOnly: true });
  t.after(() => check.close());
  const columns = check.prepare("PRAGMA table_info(secret_history)").all().map((r) => [r["name"], r["type"], r["notnull"], r["pk"]]);
  assert.deepEqual(columns, [["id", "INTEGER", 0, 1], ["name", "TEXT", 1, 0], ["sealed", "BLOB", 1, 0], ["retired_at", "INTEGER", 1, 0]]);
  const index = check.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'secret_history_by_name'").get();
  assert.match(String(index?.["sql"]), /ON secret_history\(name\)/);
  await store.putSecret("OLD_KEY", new Uint8Array([1]));
  assert.deepEqual((await store.listRetiredSecrets("OLD_KEY")).map((r) => [...r.sealed]), [[9, 8, 7]]);
});
