import type { DatabaseSync } from "node:sqlite";
import { idempotencyDigest } from "./idempotency.ts";

/**
 * One schema step, applied in one transaction: `statements` (SQL), then `rewrite` (a JavaScript pass over rows,
 * for what SQL cannot compute, such as a SHA-256), then `finish` (SQL).
 */
export interface Migration {
  version: number;
  name: string;
  statements: readonly string[];
  rewrite?: (db: DatabaseSync) => void;
  finish?: readonly string[];
}

function recordVersion(version: number, name: string): string {
  return `INSERT INTO schema_version (version, name, applied_at) VALUES (${version}, '${name}', CAST(unixepoch('subsec') * 1000 AS INTEGER))`;
}

export const MIGRATIONS: readonly Migration[] = Object.freeze([
  {
    version: 1,
    name: "core",
    statements: Object.freeze([
      `CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`,
      `CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, current_revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
      `CREATE TABLE agent_revisions (agent_id TEXT NOT NULL, revision INTEGER NOT NULL, definition TEXT NOT NULL,
        definition_hash TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (agent_id, revision)) WITHOUT ROWID`,
      `CREATE TABLE runs (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL,
        input TEXT NOT NULL, output TEXT, error TEXT, limits TEXT NOT NULL,
        idempotency_key TEXT, request_hash TEXT, trigger_id TEXT, trigger_kind TEXT,
        lease_owner TEXT, lease_epoch INTEGER NOT NULL DEFAULT 0, lease_expires_at INTEGER,
        available_at INTEGER NOT NULL, journal_seq INTEGER NOT NULL DEFAULT 0, open_pendings INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cost_micros INTEGER NOT NULL DEFAULT 0, cost_unknown INTEGER NOT NULL DEFAULT 0,
        tool_calls INTEGER NOT NULL DEFAULT 0, turns INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, updated_at INTEGER NOT NULL)`,
      `CREATE UNIQUE INDEX runs_idempotency ON runs(idempotency_key) WHERE idempotency_key IS NOT NULL`,
      `CREATE INDEX runs_claim_queued ON runs(available_at, created_at) WHERE status = 'queued'`,
      `CREATE INDEX runs_claim_orphaned ON runs(lease_expires_at) WHERE status = 'running'`,
      `CREATE INDEX runs_list ON runs(created_at DESC, id DESC)`,
      `CREATE INDEX runs_by_agent ON runs(agent_id, created_at DESC, id DESC)`,
      `CREATE INDEX runs_by_status ON runs(status, created_at DESC, id DESC)`,
      `CREATE TABLE journal (run_id TEXT NOT NULL, seq INTEGER NOT NULL, epoch INTEGER NOT NULL, ts INTEGER NOT NULL,
        type TEXT NOT NULL, step_key TEXT, data TEXT NOT NULL, PRIMARY KEY (run_id, seq)) WITHOUT ROWID`,
      `CREATE TABLE commands (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL,
        created_at INTEGER NOT NULL, consumed_at INTEGER)`,
      `CREATE INDEX commands_unconsumed ON commands(run_id, created_at, id) WHERE consumed_at IS NULL`,
      `CREATE TABLE pendings (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, agent_id TEXT NOT NULL, kind TEXT NOT NULL,
        step_key TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL, status TEXT NOT NULL, resolution TEXT,
        created_at INTEGER NOT NULL, resolved_at INTEGER)`,
      `CREATE INDEX pendings_open ON pendings(created_at, id) WHERE status = 'open'`,
      `CREATE INDEX pendings_by_run ON pendings(run_id, created_at)`,
      `CREATE TABLE usage (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, agent_id TEXT NOT NULL,
        model TEXT NOT NULL, purpose TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL, cost_micros INTEGER,
        assumed INTEGER NOT NULL DEFAULT 0, day TEXT NOT NULL, at INTEGER NOT NULL)`,
      `CREATE INDEX usage_by_day ON usage(day)`,
      `CREATE INDEX usage_by_run ON usage(run_id)`,
      `CREATE TABLE learning_items (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
        title TEXT NOT NULL, description TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL,
        version INTEGER NOT NULL, etag TEXT NOT NULL, source_run_id TEXT, promoted_workflow TEXT,
        promotion_attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE (agent_id, kind, name))`,
      `CREATE TABLE learning_history (item_id TEXT NOT NULL, version INTEGER NOT NULL, action TEXT NOT NULL,
        title TEXT NOT NULL, description TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, actor TEXT NOT NULL,
        note TEXT, at INTEGER NOT NULL, PRIMARY KEY (item_id, version)) WITHOUT ROWID`,
      `CREATE TABLE run_learning (run_id TEXT NOT NULL, item_id TEXT NOT NULL, version INTEGER NOT NULL,
        mode TEXT NOT NULL, opened INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (run_id, item_id)) WITHOUT ROWID`,
      `CREATE INDEX run_learning_by_item ON run_learning(item_id)`,
      `CREATE TABLE triggers (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, agent_id TEXT NOT NULL,
        enabled INTEGER NOT NULL, config TEXT NOT NULL, message TEXT NOT NULL, limits TEXT NOT NULL,
        last_fired_at INTEGER, next_fire_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
      `CREATE TABLE secrets (name TEXT PRIMARY KEY, sealed BLOB NOT NULL, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL)`,
      `CREATE TABLE runners (id TEXT PRIMARY KEY, pid INTEGER NOT NULL, hostname TEXT NOT NULL,
        concurrency INTEGER NOT NULL, started_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL)`,
      recordVersion(1, "core"),
    ]),
  },
  {
    version: 2,
    name: "workflows-and-archive",
    statements: Object.freeze([
      `CREATE TABLE workflows (name TEXT NOT NULL, version INTEGER NOT NULL, document TEXT NOT NULL,
        document_hash TEXT NOT NULL, source TEXT NOT NULL, skill_item_id TEXT, created_at INTEGER NOT NULL,
        PRIMARY KEY (name, version)) WITHOUT ROWID`,
      `ALTER TABLE runs ADD COLUMN journal_archived_at INTEGER`,
      `ALTER TABLE runs ADD COLUMN journal_archive_path TEXT`,
      recordVersion(2, "workflows-and-archive"),
    ]),
  },
  {
    version: 3,
    name: "promotion-pointer",
    statements: Object.freeze([
      `ALTER TABLE learning_items ADD COLUMN promoted_workflow_version INTEGER`,
      `UPDATE learning_items SET promoted_workflow_version = (
        SELECT MAX(w.version) FROM workflows w WHERE w.name = learning_items.promoted_workflow AND w.skill_item_id = learning_items.id)
        WHERE promoted_workflow IS NOT NULL`,
      recordVersion(3, "promotion-pointer"),
    ]),
  },
  {
    version: 4,
    name: "idempotency-digest",
    statements: Object.freeze([
      `DROP INDEX IF EXISTS runs_idempotency`,
      // A hash taken over redacted input cannot be reproduced from a request: it is no longer compared.
      `UPDATE runs SET request_hash = NULL WHERE instr(input, '[redacted]') > 0`,
    ]),
    rewrite: digestIdempotencyKeys,
    finish: Object.freeze([
      `CREATE UNIQUE INDEX runs_idempotency ON runs(idempotency_key) WHERE idempotency_key IS NOT NULL`,
      recordVersion(4, "idempotency-digest"),
    ]),
  },
  {
    version: 5,
    name: "wake-at",
    statements: Object.freeze([
      // The instant from which a waiting run is claimable again although no command arrived (a node deadline).
      `ALTER TABLE runs ADD COLUMN wake_at INTEGER`,
      `CREATE INDEX runs_wake ON runs(wake_at) WHERE status = 'waiting' AND wake_at IS NOT NULL`,
      recordVersion(5, "wake-at"),
    ]),
  },
  {
    version: 6,
    name: "usage-saturation",
    // Usage totals saturate at 2^53 − 1 (C9). Counters an older build let pass it (or stored as a huge REAL) are
    // clamped, so every read of the run row and every aggregate works again.
    statements: Object.freeze([
      ...["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "cost_micros", "tool_calls", "turns"]
        .map((column) => clampColumn("runs", column)),
      ...["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "cost_micros"]
        .map((column) => clampColumn("usage", column)),
      recordVersion(6, "usage-saturation"),
    ]),
  },
  {
    version: 7,
    name: "secret-history",
    // A replaced or deleted secret value, kept sealed while a run that may have been handed it is unfinished, so
    // every process can still redact it (pruned by pruneRetiredSecrets).
    statements: Object.freeze([
      `CREATE TABLE secret_history (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, sealed BLOB NOT NULL,
        retired_at INTEGER NOT NULL)`,
      `CREATE INDEX secret_history_by_name ON secret_history(name)`,
      recordVersion(7, "secret-history"),
    ]),
  },
  {
    // Commands are applied in the order their inserts committed: `seq`, assigned as MAX(seq) + 1 inside the
    // enqueue's write transaction. Existing rows keep the order they were listed in (created_at, id).
    version: 8,
    name: "command-seq",
    statements: Object.freeze([
      `ALTER TABLE commands ADD COLUMN seq INTEGER`,
      `UPDATE commands SET seq = numbered.n
         FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS n FROM commands) AS numbered
        WHERE commands.id = numbered.id`,
      `CREATE UNIQUE INDEX commands_seq ON commands(seq)`,
      `DROP INDEX commands_unconsumed`,
      `CREATE INDEX commands_unconsumed ON commands(run_id, seq) WHERE consumed_at IS NULL`,
      recordVersion(8, "command-seq"),
    ]),
  },
]);

/** Clamps a counter column to an integer from 0 to 2^53 − 1, touching only rows outside that range (NULL stays NULL). */
function clampColumn(table: string, column: string): string {
  const max = String(Number.MAX_SAFE_INTEGER);
  return `UPDATE ${table} SET ${column} = CAST(MIN(MAX(${column}, 0), ${max}) AS INTEGER)
    WHERE ${column} IS NOT NULL AND (${column} > ${max} OR ${column} < 0 OR typeof(${column}) <> 'integer')`;
}

/** The form in which schema version 3 stored a key that held a known secret; its hex is the SHA-256 of the key. */
const V3_DIGEST = /^redacted-sha256:([0-9a-f]{64})$/;

/**
 * Migration 4: every stored key becomes idempotencyDigest(key). A schema-version-3 digest keeps its hex; any other text is
 * the key itself and is digested. When two runs end with one digest (the same key stored once as text and once as
 * a schema-version-3 digest), the run created first keeps it and the others get NULL.
 */
function digestIdempotencyKeys(db: DatabaseSync): void {
  const rows = db.prepare(
    "SELECT id, idempotency_key FROM runs WHERE idempotency_key IS NOT NULL ORDER BY created_at, id",
  ).all();
  const update = db.prepare("UPDATE runs SET idempotency_key = ? WHERE id = ?");
  const claimed = new Set<string>();
  for (const row of rows) {
    const id = String(row["id"]);
    const stored = String(row["idempotency_key"]);
    const v3 = V3_DIGEST.exec(stored);
    const digest = v3 === null ? idempotencyDigest(stored) : `sha256:${v3[1]}`;
    if (claimed.has(digest)) {
      update.run(null, id);
    } else {
      claimed.add(digest);
      update.run(digest, id);
    }
  }
}

export const LATEST_SCHEMA_VERSION: number = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
