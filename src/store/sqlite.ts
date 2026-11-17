import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue, type StatementSync } from "node:sqlite";
import { RunwrightError, isRunwrightError } from "../core/errors.ts";
import { canonicalJson, sha256Hex, type Json, type JsonObject } from "../core/json.ts";
import { systemClock, type Clock } from "../core/clock.ts";
import { createIdSource, type IdSource } from "../core/ids.ts";
import type { AgentDefinition } from "../agents/definition.ts";
import type { WorkflowDocument } from "../workflow/types.ts";
import { idempotencyDigest, isRequestFingerprint, isWellFormedText, requestFingerprint } from "./idempotency.ts";
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from "./migrations.ts";
import { RUN_STATUSES, TERMINAL_STATUSES, assertTransition, isTerminal } from "./state-machine.ts";
import type {
  AgentRecord, AgentRevision, ClaimedRun, CommandRecord, CommitBatch, CommitResult, CreateRunInput, IdempotentRunQuery, JournalRecord,
  LearningChange, LearningEffects, LearningHistoryEntry, LearningItem, LearningKind, LearningMetrics, LearningPromotion,
  LearningPut, LearningStatus, LearningUse, Lease,
  MetricsGroup, Page, PageRequest, PendingFilter, PendingKind, PendingRecord, RunCommand, RunFilter,
  RunInput, RunLimits, RunRecord, RunStatus, RunTrigger, RunnerInfo, SavedWorkflow, Store, StoreEvent, TriggerFireInput,
  TriggerFireResult, TriggerRecord, UsageQuery, UsageRow, WorkflowSaveCheck,
} from "./types.ts";

export interface SqliteStoreOptions { path: string; clock?: Clock; ids?: IdSource; synchronous?: "normal" | "full" }

type Row = Record<string, SQLOutputValue>;

const JOB_PURPOSE_EXCLUSIONS = "('learning', 'grader', 'promotion')";
const DEFAULT_JOURNAL_LIMIT = 1000;
/** Waiting runs whose wake time passed that one claimRuns call requeues, at most. */
const WAKE_BATCH = 100;

function str(row: Row, column: string): string {
  const value = row[column];
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

function strOrNull(row: Row, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : String(value);
}

function num(row: Row, column: string): number {
  const value = row[column];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Number(value);
  return 0;
}

/** A BLOB column as a fresh Uint8Array (empty when it is not a BLOB). */
function blob(row: Row, column: string): Uint8Array {
  const value = row[column];
  return value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array();
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}

/** Every status that is not terminal, as SQL text (a status added to RUN_STATUSES later counts as unfinished). */
const UNFINISHED_STATUSES_SQL = RUN_STATUSES.filter((status) => !TERMINAL_STATUSES.includes(status)).map((status) => `'${status}'`).join(", ");

/**
 * Deletes every retired secret value that no unfinished run can have been handed: a run can have been handed a
 * value only if it was created at or before the instant the value was retired, so a row is kept while such a run
 * is in a status that is not terminal. The subquery reads the `runs_by_status` index.
 */
const PRUNE_RETIRED_SECRETS = `DELETE FROM secret_history WHERE NOT EXISTS (
  SELECT 1 FROM runs WHERE runs.status IN (${UNFINISHED_STATUSES_SQL}) AND runs.created_at <= secret_history.retired_at)`;

/** The largest stored or reported usage total (C9): 2^53 − 1. Totals saturate here instead of passing it. */
const MAX_TOTAL = Number.MAX_SAFE_INTEGER;
/** MAX_TOTAL as SQL text, for the saturating updates and aggregates. */
const MAX_TOTAL_SQL = String(MAX_TOTAL);

/**
 * A usage count as the store keeps it: an integer from 0 to MAX_TOTAL. A larger (or infinite) count is MAX_TOTAL,
 * a fraction is rounded up, and anything negative or not a number is 0. The store is the last line of defence
 * against a provider that reports 1e300.
 */
function storedCount(value: number): number {
  if (Number.isNaN(value) || value <= 0) return 0;
  return Math.min(Math.ceil(value), MAX_TOTAL);
}

/** a + b for two stored counts, saturating at MAX_TOTAL (an inexact float sum above it still clamps to it). */
function saturatingAdd(a: number, b: number): number {
  return Math.min(a + b, MAX_TOTAL);
}

/** `SUM(column)` over usage rows that never passes MAX_TOTAL: `TOTAL` cannot overflow and ignores NULL. */
function saturatingSum(column: string): string {
  return `CAST(MIN(TOTAL(${column}), ${MAX_TOTAL_SQL}) AS INTEGER)`;
}

function numOrNull(row: Row, column: string): number | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  return num(row, column);
}

function parseJsonColumn<T>(row: Row, column: string, fallback: T): T {
  const value = row[column];
  if (typeof value !== "string") return fallback;
  return JSON.parse(value) as T;
}

function toJsonText(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value);
}

function contentEtag(version: number, title: string, description: string, body: string, status: string): string {
  return `${version}-${sha256Hex(`${title}\n${description}\n${body}\n${status}`).slice(0, 8)}`;
}

/**
 * bad_request unless every given text is well-formed Unicode. For caller text the store keeps in a TEXT column as
 * it is (not inside JSON text): SQLite stores UTF-8, which turns an unpaired surrogate into U+FFFD, so the stored
 * text would differ from the text sent and from its JSON copy (a definition, a trigger compared on fire).
 */
function requireWellFormed(fields: Readonly<Record<string, string | undefined>>): void {
  for (const [field, text] of Object.entries(fields)) {
    if (text !== undefined && !isWellFormedText(text)) {
      throw new RunwrightError("bad_request", `${field} must be well-formed Unicode (no unpaired surrogate)`, { details: { field } });
    }
  }
}

function encodeCursor(createdAt: number, id: string): string {
  return Buffer.from(`${createdAt}:${id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: number; id: string } {
  const text = /^[A-Za-z0-9_-]+$/.test(cursor) ? Buffer.from(cursor, "base64url").toString("utf8") : "";
  const match = /^(\d{1,16}):(.+)$/s.exec(text);
  if (match === null) throw new RunwrightError("bad_request", "malformed pagination cursor");
  return { createdAt: Number(match[1]), id: match[2] ?? "" };
}

/** A page size given by a caller: a positive integer, or bad_request. */
function pageSize(limit: unknown, what: string): number {
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1) {
    throw new RunwrightError("bad_request", `the ${what} limit must be a positive integer, not ${String(limit)}`);
  }
  return limit;
}

/** A list page: a positive integer, at most 200 rows. */
function listPageSize(limit: unknown): number {
  return Math.min(200, pageSize(limit, "page"));
}

/** The most runs one claim takes: far above any runner's concurrency (at most 1024). */
const MAX_CLAIM_BATCH = 10_000;

/** A lease length: an integer from 1 ms to Number.MAX_SAFE_INTEGER, or bad_request (it is added to a timestamp). */
function leaseLength(leaseMs: unknown): number {
  if (typeof leaseMs !== "number" || !Number.isSafeInteger(leaseMs) || leaseMs < 1) {
    throw new RunwrightError("bad_request", `leaseMs must be a positive integer, not ${String(leaseMs)}`);
  }
  return leaseMs;
}

/** An instant bound of a usage query: an integer number of ms since the epoch, or bad_request. */
function instantBound(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new RunwrightError("bad_request", `${name} must be an integer number of milliseconds, not ${String(value)}`);
  }
  return value;
}

/** A journal position to read after: an integer >= 0, or bad_request. */
function seqCursor(afterSeq: unknown): number {
  if (typeof afterSeq !== "number" || !Number.isSafeInteger(afterSeq) || afterSeq < 0) {
    throw new RunwrightError("bad_request", `afterSeq must be an integer >= 0, not ${String(afterSeq)}`);
  }
  return afterSeq;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Lower-case slug of a name: runs of other characters become "-", trimmed, at most 64 characters. */
export function slugifyAgentName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}

class SqliteStore implements Store {
  readonly schemaVersion: number;
  private readonly db: DatabaseSync;
  private readonly clock: Clock;
  private readonly ids: IdSource;
  private readonly statements = new Map<string, StatementSync>();
  private readonly listeners: ((event: StoreEvent) => void)[] = [];
  private closed = false;

  constructor(db: DatabaseSync, clock: Clock, ids: IdSource, schemaVersion: number) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
    this.schemaVersion = schemaVersion;
  }

  // ---------------------------------------------------------------- plumbing

  private stmt(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (statement === undefined) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  private get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.stmt(sql).get(...params);
  }

  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.stmt(sql).all(...params);
  }

  private run(sql: string, ...params: SQLInputValue[]): number {
    return Number(this.stmt(sql).run(...params).changes);
  }

  private ensureOpen(): void {
    if (this.closed) throw new RunwrightError("store_error", "the store is closed");
  }

  private wrap(error: unknown): unknown {
    if (isRunwrightError(error)) return error;
    const message = error instanceof Error ? error.message : String(error);
    return new RunwrightError("store_error", `store operation failed: ${message}`, { cause: error });
  }

  private read<T>(fn: () => T): T {
    this.ensureOpen();
    try {
      return fn();
    } catch (error) {
      throw this.wrap(error);
    }
  }

  private tx<T>(fn: (events: StoreEvent[]) => T): T {
    this.ensureOpen();
    const events: StoreEvent[] = [];
    let result: T;
    try {
      this.db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      throw this.wrap(error);
    }
    try {
      result = fn(events);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        if (this.db.isTransaction) this.db.exec("ROLLBACK");
      } catch {
        // The original error is the one worth reporting.
      }
      throw this.wrap(error);
    }
    this.emit(events);
    return result;
  }

  private emit(events: readonly StoreEvent[]): void {
    for (const event of events) {
      for (const listener of [...this.listeners]) {
        try {
          listener(event);
        } catch {
          // A throwing listener is ignored by contract.
        }
      }
    }
  }

  subscribe(listener: (event: StoreEvent) => void): () => void {
    const wrapped = (event: StoreEvent): void => listener(event);
    this.listeners.push(wrapped);
    return () => {
      const index = this.listeners.indexOf(wrapped);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    this.listeners.length = 0;
    try {
      this.db.close();
    } catch (error) {
      throw this.wrap(error);
    }
  }

  // ---------------------------------------------------------------- mapping

  private toAgent(row: Row): AgentRecord {
    return {
      id: str(row, "id"),
      name: str(row, "name"),
      currentRevision: num(row, "current_revision"),
      createdAt: num(row, "created_at"),
      updatedAt: num(row, "updated_at"),
    };
  }

  private toRevision(row: Row): AgentRevision {
    return {
      agentId: str(row, "agent_id"),
      revision: num(row, "revision"),
      definition: parseJsonColumn<AgentDefinition>(row, "definition", {} as AgentDefinition),
      definitionHash: str(row, "definition_hash"),
      createdAt: num(row, "created_at"),
    };
  }

  private toWorkflow(row: Row): SavedWorkflow {
    return {
      name: str(row, "name"),
      version: num(row, "version"),
      document: parseJsonColumn<WorkflowDocument>(row, "document", {} as WorkflowDocument),
      documentHash: str(row, "document_hash"),
      source: str(row, "source") === "promotion" ? "promotion" : "api",
      skillItemId: strOrNull(row, "skill_item_id"),
      createdAt: num(row, "created_at"),
    };
  }

  private toRun(row: Row): RunRecord {
    const triggerId = strOrNull(row, "trigger_id");
    const triggerKind = strOrNull(row, "trigger_kind");
    return {
      id: str(row, "id"),
      agentId: str(row, "agent_id"),
      revision: num(row, "revision"),
      status: str(row, "status") as RunStatus,
      input: parseJsonColumn(row, "input", { message: "", data: null }),
      output: parseJsonColumn<Json>(row, "output", null),
      error: parseJsonColumn(row, "error", null),
      limits: parseJsonColumn<RunLimits>(row, "limits", { maxCostMicros: null, maxToolCalls: null, maxTurns: null, allowUnpriced: false }),
      idempotencyKey: strOrNull(row, "idempotency_key"),
      trigger: triggerId !== null && triggerKind !== null ? { id: triggerId, kind: triggerKind as "cron" | "webhook" | "manual" } : null,
      epoch: num(row, "lease_epoch"),
      leaseOwner: strOrNull(row, "lease_owner"),
      leaseExpiresAt: numOrNull(row, "lease_expires_at"),
      journalSeq: num(row, "journal_seq"),
      openPendings: num(row, "open_pendings"),
      usage: {
        inputTokens: num(row, "input_tokens"),
        outputTokens: num(row, "output_tokens"),
        cacheReadTokens: num(row, "cache_read_tokens"),
        cacheWriteTokens: num(row, "cache_write_tokens"),
        costMicros: num(row, "cost_micros"),
        costUnknown: num(row, "cost_unknown") !== 0,
        toolCalls: num(row, "tool_calls"),
        turns: num(row, "turns"),
      },
      createdAt: num(row, "created_at"),
      startedAt: numOrNull(row, "started_at"),
      finishedAt: numOrNull(row, "finished_at"),
      updatedAt: num(row, "updated_at"),
      journalArchivedAt: numOrNull(row, "journal_archived_at"),
    };
  }

  private toJournal(row: Row): JournalRecord {
    return {
      runId: str(row, "run_id"),
      seq: num(row, "seq"),
      epoch: num(row, "epoch"),
      ts: num(row, "ts"),
      type: str(row, "type"),
      key: strOrNull(row, "step_key"),
      data: parseJsonColumn<JsonObject>(row, "data", {}),
    };
  }

  private toCommand(row: Row): CommandRecord {
    return {
      id: str(row, "id"),
      runId: str(row, "run_id"),
      command: parseJsonColumn<RunCommand>(row, "payload", { type: "resume" }),
      createdAt: num(row, "created_at"),
      consumedAt: numOrNull(row, "consumed_at"),
    };
  }

  private toPending(row: Row): PendingRecord {
    return {
      id: str(row, "id"),
      runId: str(row, "run_id"),
      agentId: str(row, "agent_id"),
      kind: str(row, "kind") as PendingKind,
      stepKey: str(row, "step_key"),
      title: str(row, "title"),
      detail: parseJsonColumn<JsonObject>(row, "detail", {}),
      status: str(row, "status") === "resolved" ? "resolved" : "open",
      resolution: parseJsonColumn<JsonObject | null>(row, "resolution", null),
      createdAt: num(row, "created_at"),
      resolvedAt: numOrNull(row, "resolved_at"),
    };
  }

  private toLearningItem(row: Row): LearningItem {
    return {
      id: str(row, "id"),
      agentId: str(row, "agent_id"),
      kind: str(row, "kind") as LearningKind,
      name: str(row, "name"),
      title: str(row, "title"),
      description: str(row, "description"),
      body: str(row, "body"),
      status: str(row, "status") as LearningStatus,
      version: num(row, "version"),
      etag: str(row, "etag"),
      sourceRunId: strOrNull(row, "source_run_id"),
      promotedWorkflow: strOrNull(row, "promoted_workflow"),
      promotedWorkflowVersion: numOrNull(row, "promoted_workflow_version"),
      promotionAttempts: num(row, "promotion_attempts"),
      createdAt: num(row, "created_at"),
      updatedAt: num(row, "updated_at"),
    };
  }

  private toHistory(row: Row): LearningHistoryEntry {
    return {
      itemId: str(row, "item_id"),
      version: num(row, "version"),
      action: str(row, "action") as LearningHistoryEntry["action"],
      title: str(row, "title"),
      description: str(row, "description"),
      body: str(row, "body"),
      status: str(row, "status") as LearningStatus,
      actor: str(row, "actor"),
      note: strOrNull(row, "note"),
      at: num(row, "at"),
    };
  }

  private toTrigger(row: Row): TriggerRecord {
    const config = parseJsonColumn<{ cron?: TriggerRecord["cron"]; webhook?: TriggerRecord["webhook"] }>(row, "config", {});
    return {
      id: str(row, "id"),
      name: str(row, "name"),
      kind: str(row, "kind") === "webhook" ? "webhook" : "cron",
      agentId: str(row, "agent_id"),
      enabled: num(row, "enabled") !== 0,
      cron: config.cron ?? null,
      webhook: config.webhook ?? null,
      message: str(row, "message"),
      limits: parseJsonColumn<RunLimits>(row, "limits", { maxCostMicros: null, maxToolCalls: null, maxTurns: null, allowUnpriced: false }),
      lastFiredAt: numOrNull(row, "last_fired_at"),
      nextFireAt: numOrNull(row, "next_fire_at"),
      createdAt: num(row, "created_at"),
      updatedAt: num(row, "updated_at"),
    };
  }

  private toRunner(row: Row): RunnerInfo {
    return {
      id: str(row, "id"),
      pid: num(row, "pid"),
      hostname: str(row, "hostname"),
      concurrency: num(row, "concurrency"),
      startedAt: num(row, "started_at"),
      lastSeenAt: num(row, "last_seen_at"),
    };
  }

  private runRow(id: string): Row | undefined {
    return this.get("SELECT * FROM runs WHERE id = ?", id);
  }

  private requireRun(id: string): Row {
    const row = this.runRow(id);
    if (row === undefined) throw new RunwrightError("not_found", `run ${id} not found`, { details: { runId: id } });
    return row;
  }

  // ---------------------------------------------------------------- agents

  async saveAgent(input: { id?: string; definition: AgentDefinition }): Promise<{ agent: AgentRecord; revision: AgentRevision; created: boolean }> {
    requireWellFormed({ id: input.id, name: typeof input.definition.name === "string" ? input.definition.name : undefined });
    return this.tx(() => {
      let id = input.id;
      if (id === undefined) {
        id = slugifyAgentName(typeof input.definition.name === "string" ? input.definition.name : "");
        if (id === "") id = this.ids.next("agent").toLowerCase();
      }
      const definitionJson = input.definition as unknown as Json;
      const hash = sha256Hex(canonicalJson(definitionJson));
      const now = this.clock.now();
      const agentRow = this.get("SELECT * FROM agents WHERE id = ?", id);
      if (agentRow !== undefined) {
        const current = num(agentRow, "current_revision");
        const revisionRow = this.get("SELECT * FROM agent_revisions WHERE agent_id = ? AND revision = ?", id, current);
        if (revisionRow !== undefined && str(revisionRow, "definition_hash") === hash) {
          return { agent: this.toAgent(agentRow), revision: this.toRevision(revisionRow), created: false };
        }
        const next = current + 1;
        this.run(
          "INSERT INTO agent_revisions (agent_id, revision, definition, definition_hash, created_at) VALUES (?, ?, ?, ?, ?)",
          id, next, canonicalJson(definitionJson), hash, now,
        );
        this.run("UPDATE agents SET name = ?, current_revision = ?, updated_at = ? WHERE id = ?", input.definition.name, next, now, id);
      } else {
        this.run(
          "INSERT INTO agents (id, name, current_revision, created_at, updated_at) VALUES (?, ?, 1, ?, ?)",
          id, input.definition.name, now, now,
        );
        this.run(
          "INSERT INTO agent_revisions (agent_id, revision, definition, definition_hash, created_at) VALUES (?, 1, ?, ?, ?)",
          id, canonicalJson(definitionJson), hash, now,
        );
      }
      const agent = this.toAgent(this.get("SELECT * FROM agents WHERE id = ?", id) as Row);
      const revision = this.toRevision(
        this.get("SELECT * FROM agent_revisions WHERE agent_id = ? AND revision = ?", id, agent.currentRevision) as Row,
      );
      return { agent, revision, created: true };
    });
  }

  async getAgent(id: string): Promise<AgentRecord | null> {
    return this.read(() => {
      const row = this.get("SELECT * FROM agents WHERE id = ?", id);
      return row === undefined ? null : this.toAgent(row);
    });
  }

  async listAgents(): Promise<AgentRecord[]> {
    return this.read(() => this.all("SELECT * FROM agents ORDER BY created_at, id").map((r) => this.toAgent(r)));
  }

  async getRevision(agentId: string, revision?: number): Promise<AgentRevision | null> {
    return this.read(() => {
      const row = revision === undefined
        ? this.get(
          "SELECT r.* FROM agent_revisions r JOIN agents a ON a.id = r.agent_id AND a.current_revision = r.revision WHERE r.agent_id = ?",
          agentId,
        )
        : this.get("SELECT * FROM agent_revisions WHERE agent_id = ? AND revision = ?", agentId, revision);
      return row === undefined ? null : this.toRevision(row);
    });
  }

  async listRevisions(agentId: string): Promise<AgentRevision[]> {
    return this.read(() =>
      this.all("SELECT * FROM agent_revisions WHERE agent_id = ? ORDER BY revision DESC", agentId).map((r) => this.toRevision(r)));
  }

  // ---------------------------------------------------------------- workflows

  async saveWorkflow(input: { name: string; document: WorkflowDocument; source: "api" | "promotion"; skillItemId?: string; check?: WorkflowSaveCheck }): Promise<{ workflow: SavedWorkflow; created: boolean }> {
    requireWellFormed({ name: input.name });
    const { check, ...save } = input;
    const failed: { error?: unknown; thrown: boolean } = { thrown: false };
    try {
      return this.tx(() => {
        if (check !== undefined) {
          try {
            check((name) => this.latestWorkflowDocument(name));
          } catch (error) {
            failed.thrown = true;
            failed.error = error;
            throw error;
          }
        }
        return this.writeWorkflow(save);
      });
    } catch (error) {
      if (failed.thrown) throw failed.error;
      throw error;
    }
  }

  /** The latest stored document of `name`, read inside the caller's transaction; null for an unknown name. */
  private latestWorkflowDocument(name: string): WorkflowDocument | null {
    const row = this.get("SELECT * FROM workflows WHERE name = ? ORDER BY version DESC LIMIT 1", name);
    return row === undefined ? null : this.toWorkflow(row).document;
  }

  /** Who wrote the versions of a saved-workflow name: whether any API version exists, and every skill id that did. */
  private workflowOwnership(name: string): { api: boolean; skills: string[] } {
    const rows = this.all("SELECT DISTINCT source, skill_item_id FROM workflows WHERE name = ? ORDER BY source, skill_item_id", name);
    const skills: string[] = [];
    let api = false;
    for (const row of rows) {
      if (str(row, "source") === "promotion") skills.push(str(row, "skill_item_id"));
      else api = true;
    }
    return { api, skills };
  }

  /**
   * The ownership rule of saved-workflow names (see Store.saveWorkflow). Throws before anything is written, also
   * for a document identical to the latest version's.
   */
  private checkWorkflowOwner(input: { name: string; source: "api" | "promotion"; skillItemId?: string }): void {
    const owners = this.workflowOwnership(input.name);
    if (input.source === "api") {
      const skillItemId = owners.skills[0];
      if (skillItemId !== undefined) {
        throw new RunwrightError("conflict", `the workflow ${input.name} belongs to a learned skill; it cannot be saved through the API`, {
          details: { reason: "promoted_workflow", name: input.name, skillItemId },
        });
      }
      return;
    }
    if (input.skillItemId === undefined) {
      throw new RunwrightError("bad_request", "a promoted workflow needs the id of the skill that owns it");
    }
    if (owners.api || owners.skills.some((id) => id !== input.skillItemId)) {
      throw new RunwrightError("learning_conflict", `the workflow name ${input.name} is already used by a workflow this skill does not own`, {
        details: { reason: "workflow_name_taken", name: input.name, skillItemId: input.skillItemId },
      });
    }
  }

  /**
   * A new version unless the document hash equals the latest version's, after the ownership rule. Runs inside the
   * caller's transaction.
   */
  private writeWorkflow(input: { name: string; document: WorkflowDocument; source: "api" | "promotion"; skillItemId?: string }): { workflow: SavedWorkflow; created: boolean } {
    this.checkWorkflowOwner(input);
    const documentJson = input.document as unknown as Json;
    const hash = sha256Hex(canonicalJson(documentJson));
    const latest = this.get("SELECT * FROM workflows WHERE name = ? ORDER BY version DESC LIMIT 1", input.name);
    if (latest !== undefined && str(latest, "document_hash") === hash) {
      return { workflow: this.toWorkflow(latest), created: false };
    }
    const version = latest === undefined ? 1 : num(latest, "version") + 1;
    this.run(
      "INSERT INTO workflows (name, version, document, document_hash, source, skill_item_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      input.name, version, canonicalJson(documentJson), hash, input.source, input.skillItemId ?? null, this.clock.now(),
    );
    const row = this.get("SELECT * FROM workflows WHERE name = ? AND version = ?", input.name, version) as Row;
    return { workflow: this.toWorkflow(row), created: true };
  }

  async getWorkflow(name: string, version?: number): Promise<SavedWorkflow | null> {
    return this.read(() => {
      const row = version === undefined
        ? this.get("SELECT * FROM workflows WHERE name = ? ORDER BY version DESC LIMIT 1", name)
        : this.get("SELECT * FROM workflows WHERE name = ? AND version = ?", name, version);
      return row === undefined ? null : this.toWorkflow(row);
    });
  }

  async listWorkflows(): Promise<SavedWorkflow[]> {
    return this.read(() =>
      this.all(
        `SELECT w.* FROM workflows w
          JOIN (SELECT name, MAX(version) AS version FROM workflows GROUP BY name) latest
            ON latest.name = w.name AND latest.version = w.version
          ORDER BY w.name`,
      ).map((r) => this.toWorkflow(r)));
  }

  // ---------------------------------------------------------------- runs

  /** validation_failed unless `fingerprint` is undefined or 64 lower-case hex characters. */
  private checkFingerprint(fingerprint: string | undefined): void {
    if (fingerprint !== undefined && !isRequestFingerprint(fingerprint)) {
      throw new RunwrightError("validation_failed", "requestFingerprint must be 64 lower-case hex characters", {
        details: { field: "requestFingerprint" },
      });
    }
  }

  /**
   * The run stored under `keyDigest`, or null. The one idempotency rule, shared by createRun and
   * findIdempotentRun: when `strict`, a fingerprint is given and the stored request hash is not NULL and differs,
   * idempotency_mismatch. Reads the runs row and nothing else.
   */
  private idempotentRun(keyDigest: string, fingerprint: string | null, strict: boolean): RunRecord | null {
    const existing = this.get("SELECT * FROM runs WHERE idempotency_key = ?", keyDigest);
    if (existing === undefined) return null;
    const storedHash = strOrNull(existing, "request_hash");
    if (strict && fingerprint !== null && storedHash !== null && storedHash !== fingerprint) {
      throw new RunwrightError("idempotency_mismatch", "the idempotency key was used for a different request", {
        details: { runId: str(existing, "id"), idempotencyKey: keyDigest },
      });
    }
    return this.toRun(existing);
  }

  async findIdempotentRun(query: IdempotentRunQuery): Promise<RunRecord | null> {
    return this.read(() => {
      this.checkFingerprint(query.requestFingerprint);
      const keyDigest = idempotencyDigest(query.idempotencyKey);
      return this.idempotentRun(keyDigest, query.requestFingerprint ?? null, query.strictIdempotency ?? true);
    });
  }

  /**
   * The key is digested (an ill-formed key is bad_request) before the transaction. The fingerprint compared and
   * stored is the one given (the caller's original request: the write-redaction wrapper passes the revision it
   * read as `revision` but the fingerprint of the request as sent), computed from this input only when absent.
   */
  async createRun(input: CreateRunInput): Promise<{ run: RunRecord; created: boolean }> {
    this.checkFingerprint(input.requestFingerprint);
    const keyDigest = input.idempotencyKey === undefined ? null : idempotencyDigest(input.idempotencyKey);
    const requestHash = input.requestFingerprint ?? requestFingerprint(input);
    return this.tx((events) => {
      if (keyDigest !== null) {
        const existing = this.idempotentRun(keyDigest, requestHash, input.strictIdempotency ?? true);
        if (existing !== null) return { run: existing, created: false };
      }
      const made = this.insertRun(events, { ...input, keyDigest, requestHash });
      if (made.outcome === "created") return { run: made.run, created: true };
      if (made.outcome === "no_agent") {
        throw new RunwrightError("not_found", `agent ${input.agentId} not found`, { details: { agentId: input.agentId } });
      }
      throw new RunwrightError("not_found", `agent ${input.agentId} has no revision ${made.revision}`, {
        details: { agentId: input.agentId, revision: made.revision },
      });
    });
  }

  /**
   * The part of run creation after the key lookup, shared by createRun and fireTrigger (inside the caller's
   * transaction): reads the agent and the revision, merges the limits, inserts the runs row and its run.created
   * record and queues the run.queued event. Writes nothing when the agent or the revision does not exist.
   */
  private insertRun(events: StoreEvent[], input: {
    agentId: string; revision?: number; input: RunInput; limits?: Partial<RunLimits>; trigger?: RunTrigger;
    availableAt?: number; keyDigest: string | null; requestHash: string;
  }): { outcome: "created"; run: RunRecord } | { outcome: "no_agent" } | { outcome: "no_revision"; revision: number } {
    const agentRow = this.get("SELECT * FROM agents WHERE id = ?", input.agentId);
    if (agentRow === undefined) return { outcome: "no_agent" };
    const revision = input.revision ?? num(agentRow, "current_revision");
    const revisionRow = this.get("SELECT * FROM agent_revisions WHERE agent_id = ? AND revision = ?", input.agentId, revision);
    if (revisionRow === undefined) return { outcome: "no_revision", revision };
    const definition = this.toRevision(revisionRow).definition;
    const agentLimits = definition.limits ?? {};
    const limits: RunLimits = {
      maxCostMicros: agentLimits.maxCostMicros ?? null,
      maxToolCalls: agentLimits.maxToolCalls ?? null,
      maxTurns: agentLimits.maxTurns ?? null,
      allowUnpriced: false,
    };
    if (input.limits !== undefined) {
      if (input.limits.maxCostMicros !== undefined) limits.maxCostMicros = input.limits.maxCostMicros;
      if (input.limits.maxToolCalls !== undefined) limits.maxToolCalls = input.limits.maxToolCalls;
      if (input.limits.maxTurns !== undefined) limits.maxTurns = input.limits.maxTurns;
      if (input.limits.allowUnpriced !== undefined) limits.allowUnpriced = input.limits.allowUnpriced;
    }
    const id = this.ids.next("run");
    const now = this.clock.now();
    const trigger = input.trigger ?? null;
    this.run(
      `INSERT INTO runs (id, agent_id, revision, status, input, limits, idempotency_key, request_hash, trigger_id,
         trigger_kind, available_at, journal_seq, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      id, input.agentId, revision, toJsonText(input.input), toJsonText(limits), input.keyDigest, input.requestHash,
      trigger?.id ?? null, trigger?.kind ?? null, input.availableAt ?? now, now, now,
    );
    const data = { agentId: input.agentId, revision, input: input.input, limits, trigger };
    this.run(
      "INSERT INTO journal (run_id, seq, epoch, ts, type, step_key, data) VALUES (?, 1, 0, ?, 'run.created', NULL, ?)",
      id, now, toJsonText(data),
    );
    events.push({ type: "run.queued", runId: id });
    return { outcome: "created", run: this.toRun(this.requireRun(id)) };
  }

  async getRun(id: string): Promise<RunRecord | null> {
    return this.read(() => {
      const row = this.runRow(id);
      return row === undefined ? null : this.toRun(row);
    });
  }

  async listRuns(filter: RunFilter, page: PageRequest): Promise<Page<RunRecord>> {
    return this.read(() => {
      const where: string[] = [];
      const params: SQLInputValue[] = [];
      if (filter.agentId !== undefined) {
        where.push("agent_id = ?");
        params.push(filter.agentId);
      }
      if (filter.statuses !== undefined && filter.statuses.length > 0) {
        for (const status of filter.statuses) {
          if (!RUN_STATUSES.includes(status)) throw new RunwrightError("bad_request", `unknown run status ${JSON.stringify(status)}`);
        }
        const statuses = [...new Set(filter.statuses)];
        where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
        for (const status of statuses) params.push(status);
      }
      if (filter.triggerId !== undefined) {
        where.push("trigger_id = ?");
        params.push(filter.triggerId);
      }
      if (filter.finishedBefore !== undefined) {
        where.push("finished_at IS NOT NULL AND finished_at < ?");
        params.push(filter.finishedBefore);
      }
      if (filter.journalArchived !== undefined) {
        where.push(filter.journalArchived ? "journal_archived_at IS NOT NULL" : "journal_archived_at IS NULL");
      }
      if (page.cursor !== undefined && page.cursor !== "") {
        const cursor = decodeCursor(page.cursor);
        where.push("(created_at < ? OR (created_at = ? AND id < ?))");
        params.push(cursor.createdAt, cursor.createdAt, cursor.id);
      }
      const limit = listPageSize(page.limit);
      const sql = `SELECT * FROM runs ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY created_at DESC, id DESC LIMIT ?`;
      const rows = this.all(sql, ...params, limit + 1);
      const items = rows.slice(0, limit).map((r) => this.toRun(r));
      const last = items[items.length - 1];
      const nextCursor = rows.length > limit && last !== undefined ? encodeCursor(last.createdAt, last.id) : null;
      return { items, nextCursor };
    });
  }

  async claimRuns(input: { runnerId: string; limit: number; leaseMs: number }): Promise<ClaimedRun[]> {
    const limit = Math.min(Math.floor(input.limit), MAX_CLAIM_BATCH);
    if (!(limit > 0)) return [];
    const leaseMs = leaseLength(input.leaseMs);
    return this.tx((events) => {
      const now = this.clock.now();
      for (const row of this.all(
        `SELECT id, wake_at FROM runs WHERE status = 'waiting' AND wake_at IS NOT NULL AND wake_at <= ?
         ORDER BY wake_at, id LIMIT ${WAKE_BATCH}`,
        now,
      )) {
        const runId = str(row, "id");
        assertTransition("waiting", "queued");
        this.run(
          "UPDATE runs SET status = 'queued', available_at = wake_at, wake_at = NULL, updated_at = ? WHERE id = ? AND status = 'waiting'",
          now, runId,
        );
        events.push({ type: "run.queued", runId });
      }
      const ids: string[] = this.all(
        "SELECT id FROM runs WHERE status = 'running' AND lease_expires_at <= ? ORDER BY lease_expires_at, id LIMIT ?",
        now, limit,
      ).map((r) => str(r, "id"));
      if (ids.length < limit) {
        for (const row of this.all(
          "SELECT id FROM runs WHERE status = 'queued' AND available_at <= ? ORDER BY available_at, created_at, id LIMIT ?",
          now, limit - ids.length,
        )) ids.push(str(row, "id"));
      }
      const claimed: ClaimedRun[] = [];
      for (const id of ids) {
        this.run(
          `UPDATE runs SET status = 'running', lease_owner = ?, lease_epoch = lease_epoch + 1, lease_expires_at = ?,
             started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?`,
          input.runnerId, now + leaseMs, now, now, id,
        );
        const run = this.toRun(this.requireRun(id));
        claimed.push({ run, lease: { runId: id, runnerId: input.runnerId, epoch: run.epoch } });
      }
      return claimed;
    });
  }

  async heartbeat(input: { runnerId: string; runIds: string[]; leaseMs: number }): Promise<string[]> {
    if (input.runIds.length === 0) return [];
    const leaseMs = leaseLength(input.leaseMs);
    return this.tx(() => {
      const now = this.clock.now();
      const lost: string[] = [];
      for (const id of input.runIds) {
        const changed = this.run(
          "UPDATE runs SET lease_expires_at = ? WHERE id = ? AND lease_owner = ? AND status = 'running'",
          now + leaseMs, id, input.runnerId,
        );
        if (changed === 0) lost.push(id);
      }
      return lost;
    });
  }

  async commit(lease: Lease, batch: CommitBatch): Promise<CommitResult> {
    return this.tx((events) => {
      const row = this.runRow(lease.runId);
      if (
        row === undefined
        || num(row, "lease_epoch") !== lease.epoch
        || strOrNull(row, "lease_owner") !== lease.runnerId
        || str(row, "status") !== "running"
      ) {
        throw new RunwrightError("lease_lost", `the lease on run ${lease.runId} at epoch ${lease.epoch} is no longer held`, {
          details: { runId: lease.runId, epoch: lease.epoch },
        });
      }
      const runId = lease.runId;
      const agentId = str(row, "agent_id");
      const now = this.clock.now();
      const transition = batch.transition;
      if (transition?.wakeAt !== undefined) {
        if (transition.to !== "waiting") {
          throw new RunwrightError("bad_request", `a wake time is only valid on a transition to waiting, not to ${transition.to}`);
        }
        if (typeof transition.wakeAt !== "number" || !Number.isFinite(transition.wakeAt)) {
          throw new RunwrightError("bad_request", "a wake time must be a finite number of milliseconds since the epoch");
        }
      }

      // Invariant (plan 4.2): a run leaves `running` for anything but `queued` only with every command consumed.
      if (transition !== undefined && transition.to !== "queued") {
        const consuming = new Set(batch.consumeCommands ?? []);
        const unconsumed = this.all("SELECT id FROM commands WHERE run_id = ? AND consumed_at IS NULL", runId)
          .map((r) => str(r, "id"))
          .filter((id) => !consuming.has(id));
        if (unconsumed.length > 0) {
          throw new RunwrightError("commands_pending", `run ${runId} has ${unconsumed.length} unconsumed command(s)`, {
            details: { runId, commandIds: unconsumed },
          });
        }
      }
      if (transition !== undefined) assertTransition("running", transition.to);
      if (batch.learning !== undefined) this.applyLearning(runId, agentId, batch.learning, now);

      let seq = num(row, "journal_seq");
      const stored: JournalRecord[] = [];
      for (const record of batch.records) {
        seq++;
        const data = record.data;
        this.run(
          "INSERT INTO journal (run_id, seq, epoch, ts, type, step_key, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
          runId, seq, lease.epoch, now, record.type, record.key ?? null, toJsonText(data),
        );
        stored.push({ runId, seq, epoch: lease.epoch, ts: now, type: record.type, key: record.key ?? null, data });
      }

      for (const pending of batch.openPendings ?? []) {
        this.run(
          `INSERT INTO pendings (id, run_id, agent_id, kind, step_key, title, detail, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
          pending.id, runId, agentId, pending.kind, pending.stepKey, pending.title, toJsonText(pending.detail), now,
        );
      }
      for (const resolve of batch.resolvePendings ?? []) {
        const changed = this.run(
          "UPDATE pendings SET status = 'resolved', resolution = ?, resolved_at = ? WHERE id = ? AND run_id = ? AND status = 'open'",
          toJsonText(resolve.resolution), now, resolve.id, runId,
        );
        if (changed === 0) {
          throw new RunwrightError("conflict", `pending ${resolve.id} is not open on run ${runId}`, { details: { pendingId: resolve.id } });
        }
      }
      const pendingsChanged = (batch.openPendings?.length ?? 0) + (batch.resolvePendings?.length ?? 0) > 0;
      const openPendings = pendingsChanged
        ? num(this.get("SELECT COUNT(*) AS n FROM pendings WHERE run_id = ? AND status = 'open'", runId) as Row, "n")
        : num(row, "open_pendings");

      const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unknown: false };
      const day = utcDay(now);
      for (const usage of batch.usage ?? []) {
        const input = storedCount(usage.inputTokens);
        const output = storedCount(usage.outputTokens);
        const cacheRead = storedCount(usage.cacheReadTokens);
        const cacheWrite = storedCount(usage.cacheWriteTokens);
        const cost = usage.costMicros === null ? null : storedCount(usage.costMicros);
        this.run(
          `INSERT INTO usage (run_id, agent_id, model, purpose, input_tokens, output_tokens, cache_read_tokens,
             cache_write_tokens, cost_micros, assumed, day, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          runId, agentId, usage.model, usage.purpose, input, output, cacheRead, cacheWrite, cost, usage.assumed ? 1 : 0, day, now,
        );
        totals.input = saturatingAdd(totals.input, input);
        totals.output = saturatingAdd(totals.output, output);
        totals.cacheRead = saturatingAdd(totals.cacheRead, cacheRead);
        totals.cacheWrite = saturatingAdd(totals.cacheWrite, cacheWrite);
        if (cost === null) totals.unknown = true;
        else totals.cost = saturatingAdd(totals.cost, cost);
      }

      const saturating = (column: string): string => `${column} = MIN(${column} + ?, ${MAX_TOTAL_SQL})`;
      const sets: string[] = [
        "journal_seq = ?", "open_pendings = ?", "updated_at = ?",
        saturating("input_tokens"), saturating("output_tokens"), saturating("cache_read_tokens"), saturating("cache_write_tokens"),
        saturating("cost_micros"), "cost_unknown = MAX(cost_unknown, ?)", saturating("tool_calls"), saturating("turns"),
      ];
      const params: SQLInputValue[] = [
        seq, openPendings, now, totals.input, totals.output, totals.cacheRead, totals.cacheWrite, totals.cost,
        totals.unknown ? 1 : 0, storedCount(batch.counters?.toolCalls ?? 0), storedCount(batch.counters?.turns ?? 0),
      ];
      if (batch.setLimits !== undefined) {
        sets.push("limits = ?");
        params.push(toJsonText(batch.setLimits));
      }
      for (const commandId of batch.consumeCommands ?? []) {
        this.run("UPDATE commands SET consumed_at = ? WHERE id = ? AND run_id = ? AND consumed_at IS NULL", now, commandId, runId);
      }
      if (transition !== undefined) {
        sets.push("status = ?");
        params.push(transition.to);
        if (transition.output !== undefined) {
          sets.push("output = ?");
          params.push(toJsonText(transition.output));
        }
        if (transition.error !== undefined) {
          sets.push("error = ?");
          params.push(toJsonText(transition.error));
        }
        if (isTerminal(transition.to)) {
          sets.push("finished_at = ?");
          params.push(now);
        }
        if (transition.to !== "running") sets.push("lease_owner = NULL", "lease_expires_at = NULL");
        sets.push("wake_at = ?");
        params.push(transition.to === "waiting" ? transition.wakeAt ?? null : null);
        if (transition.to === "queued") {
          sets.push("available_at = ?");
          params.push(now);
        }
      }
      this.run(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`, ...params, runId);
      const run = this.toRun(this.requireRun(runId));
      events.push({ type: "journal", runId, status: run.status, records: stored });
      if (transition?.to === "queued") events.push({ type: "run.queued", runId });
      return { run, records: stored };
    });
  }

  async readJournal(runId: string, options?: { afterSeq?: number; limit?: number }): Promise<JournalRecord[]> {
    const limit = pageSize(options?.limit ?? DEFAULT_JOURNAL_LIMIT, "journal");
    const afterSeq = seqCursor(options?.afterSeq ?? 0);
    return this.read(() => {
      return this.all(
        "SELECT * FROM journal WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?",
        runId, afterSeq, limit,
      ).map((r) => this.toJournal(r));
    });
  }

  async archiveJournal(runId: string, archive: { path: string; records: number; lastSeq: number }): Promise<number> {
    return this.tx(() => {
      const row = this.requireRun(runId);
      const status = str(row, "status") as RunStatus;
      if (!isTerminal(status)) {
        throw new RunwrightError("conflict", `run ${runId} is ${status}; only finished runs can be archived`, {
          details: { runId, status, reason: "not_terminal" },
        });
      }
      if (numOrNull(row, "journal_archived_at") !== null) {
        throw new RunwrightError("conflict", `the journal of run ${runId} is already archived`, {
          details: { runId, reason: "already_archived", path: strOrNull(row, "journal_archive_path") },
        });
      }
      const stats = this.get("SELECT COUNT(*) AS n, MAX(seq) AS last FROM journal WHERE run_id = ?", runId) as Row;
      const records = num(stats, "n");
      const lastSeq = numOrNull(stats, "last");
      const journalSeq = num(row, "journal_seq");
      if (records !== archive.records || lastSeq !== archive.lastSeq || archive.lastSeq !== journalSeq) {
        throw new RunwrightError("conflict", `the journal of run ${runId} no longer matches the archive (${records} records, last seq ${lastSeq ?? "none"}, journal seq ${journalSeq})`, {
          details: { runId, reason: "journal_changed", records, lastSeq, journalSeq, expectedRecords: archive.records, expectedLastSeq: archive.lastSeq },
        });
      }
      const deleted = this.run("DELETE FROM journal WHERE run_id = ?", runId);
      const now = this.clock.now();
      this.run(
        "UPDATE runs SET journal_archived_at = ?, journal_archive_path = ?, updated_at = ? WHERE id = ?",
        now, archive.path, now, runId,
      );
      return deleted;
    });
  }

  // ---------------------------------------------------------------- commands and pendings

  async enqueueCommand(runId: string, command: RunCommand): Promise<CommandRecord> {
    return this.tx((events) => {
      const row = this.requireRun(runId);
      const status = str(row, "status") as RunStatus;
      if (isTerminal(status)) {
        throw new RunwrightError("run_terminal", `run ${runId} is already ${status}`, { details: { runId, status } });
      }
      const id = this.ids.next("cmd");
      const now = this.clock.now();
      // Arrival order: seq is one more than the largest seq, read and written in this one statement inside the
      // write transaction (BEGIN IMMEDIATE holds the write lock before the read), so it is the commit order.
      this.run(
        `INSERT INTO commands (id, run_id, type, payload, created_at, seq)
         SELECT ?, ?, ?, ?, ?, COALESCE(MAX(seq), 0) + 1 FROM commands`,
        id, runId, command.type, toJsonText(command), now,
      );
      events.push({ type: "command", runId });
      const requeue = status === "waiting" || (status === "paused" && (command.type === "resume" || command.type === "cancel"));
      if (requeue) {
        assertTransition(status, "queued");
        this.run("UPDATE runs SET status = 'queued', available_at = ?, wake_at = NULL, updated_at = ? WHERE id = ?", now, now, runId);
        events.push({ type: "run.queued", runId });
      }
      return this.toCommand(this.get("SELECT * FROM commands WHERE id = ?", id) as Row);
    });
  }

  /** In arrival order (`seq`, the order the inserts committed), never by clock or id. */
  async listCommands(runId: string, options?: { unconsumedOnly?: boolean }): Promise<CommandRecord[]> {
    return this.read(() => {
      const sql = options?.unconsumedOnly === true
        ? "SELECT * FROM commands WHERE run_id = ? AND consumed_at IS NULL ORDER BY seq"
        : "SELECT * FROM commands WHERE run_id = ? ORDER BY seq";
      return this.all(sql, runId).map((r) => this.toCommand(r));
    });
  }

  async getPending(id: string): Promise<PendingRecord | null> {
    return this.read(() => {
      const row = this.get("SELECT * FROM pendings WHERE id = ?", id);
      return row === undefined ? null : this.toPending(row);
    });
  }

  async listPendings(filter: PendingFilter, page: PageRequest): Promise<Page<PendingRecord>> {
    return this.read(() => {
      const where: string[] = [];
      const params: SQLInputValue[] = [];
      if (filter.status !== undefined) {
        where.push("status = ?");
        params.push(filter.status);
      }
      if (filter.runId !== undefined) {
        where.push("run_id = ?");
        params.push(filter.runId);
      }
      if (filter.agentId !== undefined) {
        where.push("agent_id = ?");
        params.push(filter.agentId);
      }
      if (filter.kind !== undefined) {
        where.push("kind = ?");
        params.push(filter.kind);
      }
      if (page.cursor !== undefined && page.cursor !== "") {
        const cursor = decodeCursor(page.cursor);
        where.push("(created_at > ? OR (created_at = ? AND id > ?))");
        params.push(cursor.createdAt, cursor.createdAt, cursor.id);
      }
      const limit = listPageSize(page.limit);
      const sql = `SELECT * FROM pendings ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY created_at, id LIMIT ?`;
      const rows = this.all(sql, ...params, limit + 1);
      const items = rows.slice(0, limit).map((r) => this.toPending(r));
      const last = items[items.length - 1];
      const nextCursor = rows.length > limit && last !== undefined ? encodeCursor(last.createdAt, last.id) : null;
      return { items, nextCursor };
    });
  }

  // ---------------------------------------------------------------- usage

  async usageSummary(query: UsageQuery): Promise<UsageRow[]> {
    return this.read(() => {
      const column = query.groupBy === "day" ? "day" : query.groupBy === "agent" ? "agent_id" : query.groupBy === "model" ? "model" : null;
      if (column === null) throw new RunwrightError("bad_request", `unknown groupBy ${JSON.stringify(query.groupBy)}`);
      const where: string[] = [];
      const params: SQLInputValue[] = [];
      if (query.from !== undefined) {
        where.push("at >= ?");
        params.push(instantBound(query.from, "from"));
      }
      if (query.to !== undefined) {
        where.push("at < ?");
        params.push(instantBound(query.to, "to"));
      }
      if (query.agentId !== undefined) {
        where.push("agent_id = ?");
        params.push(query.agentId);
      }
      const sql = `SELECT ${column} AS key, COUNT(DISTINCT run_id) AS runs, COUNT(*) AS calls,
          ${saturatingSum("input_tokens")} AS input_tokens, ${saturatingSum("output_tokens")} AS output_tokens,
          ${saturatingSum("cache_read_tokens")} AS cache_read_tokens, ${saturatingSum("cache_write_tokens")} AS cache_write_tokens,
          ${saturatingSum("cost_micros")} AS cost_micros,
          COUNT(*) - COUNT(cost_micros) AS unknown_cost_calls
        FROM usage ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
        GROUP BY ${column} ORDER BY ${column}`;
      return this.all(sql, ...params).map((r) => ({
        key: str(r, "key"),
        runs: num(r, "runs"),
        calls: num(r, "calls"),
        inputTokens: num(r, "input_tokens"),
        outputTokens: num(r, "output_tokens"),
        cacheReadTokens: num(r, "cache_read_tokens"),
        cacheWriteTokens: num(r, "cache_write_tokens"),
        costMicros: num(r, "cost_micros"),
        unknownCostCalls: num(r, "unknown_cost_calls"),
      }));
    });
  }

  // ---------------------------------------------------------------- learning

  private learningRow(id: string): Row | undefined {
    return this.get("SELECT * FROM learning_items WHERE id = ?", id);
  }

  private writeHistory(item: LearningItem, action: LearningHistoryEntry["action"], actor: string, note: string | null): void {
    this.run(
      `INSERT INTO learning_history (item_id, version, action, title, description, body, status, actor, note, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      item.id, item.version, action, item.title, item.description, item.body, item.status, actor, note, item.updatedAt,
    );
  }

  /** Writes a new version of an existing item and its history row at `now`; returns the stored item. */
  private writeVersion(
    current: LearningItem,
    next: { title: string; description: string; body: string; status: LearningStatus; sourceRunId?: string | null;
      promoted?: { workflow: string; version: number } },
    action: LearningHistoryEntry["action"],
    actor: string,
    note: string | null,
    now: number,
  ): LearningItem {
    const version = current.version + 1;
    const etag = contentEtag(version, next.title, next.description, next.body, next.status);
    this.run(
      `UPDATE learning_items SET title = ?, description = ?, body = ?, status = ?, version = ?, etag = ?,
         source_run_id = ?, promoted_workflow = ?, promoted_workflow_version = ?, updated_at = ? WHERE id = ?`,
      next.title, next.description, next.body, next.status, version, etag,
      next.sourceRunId === undefined ? current.sourceRunId : next.sourceRunId,
      next.promoted === undefined ? current.promotedWorkflow : next.promoted.workflow,
      next.promoted === undefined ? current.promotedWorkflowVersion : next.promoted.version,
      now, current.id,
    );
    const item = this.toLearningItem(this.learningRow(current.id) as Row);
    this.writeHistory(item, action, actor, note);
    return item;
  }

  /** Inserts version 1 of an item and its history row (actor "learning") at `now`; returns the stored item. */
  private insertLearningItem(
    id: string,
    input: { agentId: string; kind: LearningKind; name: string; title: string; description: string; body: string;
      status: "active" | "held"; sourceRunId: string },
    note: string | null,
    now: number,
  ): LearningItem {
    const etag = contentEtag(1, input.title, input.description, input.body, input.status);
    this.run(
      `INSERT INTO learning_items (id, agent_id, kind, name, title, description, body, status, version, etag,
         source_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      id, input.agentId, input.kind, input.name, input.title, input.description, input.body, input.status, etag,
      input.sourceRunId, now, now,
    );
    const item = this.toLearningItem(this.learningRow(id) as Row);
    this.writeHistory(item, input.status === "held" ? "held" : "created", "learning", note);
    return item;
  }

  private learningItemByName(agentId: string, kind: LearningKind, name: string): Row | undefined {
    return this.get("SELECT * FROM learning_items WHERE agent_id = ? AND kind = ? AND name = ?", agentId, kind, name);
  }

  private learningConflict(
    message: string,
    put: { kind: LearningKind; name: string; expectedVersion: number | null },
    current: LearningItem | null,
    extra?: JsonObject,
  ): RunwrightError {
    return new RunwrightError("learning_conflict", message, {
      details: {
        kind: put.kind, name: put.name, expectedVersion: put.expectedVersion,
        currentVersion: current?.version ?? null, currentStatus: current?.status ?? null, ...extra,
      },
    });
  }

  /**
   * Applies a run's learning effects inside commit's transaction; any failed precondition throws and rolls back.
   * Every item the commit writes gets the commit's one instant `now`, so items kept together are equally new.
   */
  private applyLearning(runId: string, agentId: string, effects: LearningEffects, now: number): void {
    for (const put of effects.puts ?? []) this.applyLearningPut(runId, agentId, put, now);
    if (effects.given !== undefined) this.upsertLearningGiven(runId, effects.given);
    for (const itemId of effects.opened ?? []) this.setLearningOpened(runId, itemId);
    for (const promotion of effects.promotions ?? []) this.applyPromotion(agentId, promotion, now);
  }

  private applyLearningPut(runId: string, agentId: string, put: LearningPut, now: number): void {
    requireWellFormed({ name: put.name, title: put.title, description: put.description, body: put.body });
    const row = this.learningItemByName(agentId, put.kind, put.name);
    const current = row === undefined ? null : this.toLearningItem(row);
    const note = put.note ?? null;
    const content = { title: put.title, description: put.description, body: put.body, status: put.status };
    if (put.expectedVersion === null) {
      if (current !== null) {
        throw this.learningConflict(`learning ${put.kind} ${put.name} already exists at version ${current.version}`, put, current);
      }
      this.insertLearningItem(put.id, { agentId, kind: put.kind, name: put.name, ...content, sourceRunId: runId }, note, now);
      return;
    }
    if (current === null) {
      throw this.learningConflict(`learning ${put.kind} ${put.name} does not exist (expected version ${put.expectedVersion})`, put, current);
    }
    if (current.status === "retired") {
      throw this.learningConflict(`learning ${put.kind} ${put.name} is retired; a run cannot reactivate it`, put, current);
    }
    if (current.version !== put.expectedVersion) {
      throw this.learningConflict(
        `learning ${put.kind} ${put.name} is at version ${current.version}, not ${put.expectedVersion}`, put, current,
      );
    }
    this.writeVersion(current, { ...content, sourceRunId: runId }, put.status === "held" ? "held" : "updated", "learning", note, now);
  }

  private applyPromotion(agentId: string, promotion: LearningPromotion, now: number): void {
    const row = this.learningRow(promotion.itemId);
    if (row === undefined || str(row, "agent_id") !== agentId) {
      throw new RunwrightError("not_found", `learning item ${promotion.itemId} not found`, { details: { itemId: promotion.itemId } });
    }
    const current = this.toLearningItem(row);
    const target = { kind: current.kind, name: current.name, expectedVersion: promotion.expectedVersion };
    if (current.kind !== "skill") throw this.learningConflict(`learning item ${current.id} is not a skill`, target, current);
    if (current.status !== "active") {
      throw this.learningConflict(`skill ${current.name} is ${current.status}; only an active skill is promoted`, target, current);
    }
    if (current.promotedWorkflow !== null) {
      throw this.learningConflict(`skill ${current.name} is already promoted to ${current.promotedWorkflow}`, target, current);
    }
    if (current.version !== promotion.expectedVersion) {
      throw this.learningConflict(
        `skill ${current.name} is at version ${current.version}, not ${promotion.expectedVersion}`, target, current,
      );
    }
    this.run("UPDATE learning_items SET promotion_attempts = promotion_attempts + 1 WHERE id = ?", current.id);
    if (promotion.workflow === null) return;
    const name = promotion.workflow.name;
    const owners = this.workflowOwnership(name);
    if (owners.api || owners.skills.some((id) => id !== current.id)) {
      throw this.learningConflict(
        `the workflow name ${name} is already used by a workflow this skill does not own`, target, current,
        { reason: "workflow_name_taken", workflow: name },
      );
    }
    const saved = this.writeWorkflow({ name, document: promotion.workflow.document, source: "promotion", skillItemId: current.id });
    this.writeVersion(
      current,
      {
        title: current.title, description: current.description, body: current.body, status: current.status,
        promoted: { workflow: name, version: saved.workflow.version },
      },
      "promoted",
      "learning",
      promotion.note,
      now,
    );
  }

  private upsertLearningGiven(runId: string, uses: readonly { itemId: string; version: number; mode: "full" | "line" }[]): void {
    for (const use of uses) {
      this.run(
        `INSERT INTO run_learning (run_id, item_id, version, mode, opened) VALUES (?, ?, ?, ?, 0)
         ON CONFLICT (run_id, item_id) DO UPDATE SET version = excluded.version, mode = excluded.mode`,
        runId, use.itemId, use.version, use.mode,
      );
    }
  }

  private setLearningOpened(runId: string, itemId: string): void {
    const changed = this.run("UPDATE run_learning SET opened = 1 WHERE run_id = ? AND item_id = ?", runId, itemId);
    if (changed > 0) return;
    const item = this.learningRow(itemId);
    if (item === undefined) throw new RunwrightError("not_found", `learning item ${itemId} not found`, { details: { itemId } });
    this.run(
      "INSERT INTO run_learning (run_id, item_id, version, mode, opened) VALUES (?, ?, ?, 'line', 1)",
      runId, itemId, num(item, "version"),
    );
  }

  async changeLearningItem(id: string, change: LearningChange): Promise<LearningItem> {
    requireWellFormed({ title: change.patch?.title, description: change.patch?.description, body: change.patch?.body });
    return this.tx(() => {
      const row = this.learningRow(id);
      if (row === undefined) throw new RunwrightError("not_found", `learning item ${id} not found`, { details: { itemId: id } });
      const current = this.toLearningItem(row);
      if (change.expectedEtag !== current.etag) {
        throw new RunwrightError("etag_mismatch", `learning item ${id} has changed (etag ${current.etag})`, {
          details: { itemId: id, etag: current.etag },
        });
      }
      const note = change.note ?? null;
      const now = this.clock.now();
      const content = { title: current.title, description: current.description, body: current.body };
      const wrongStatus = (allowed: string): RunwrightError =>
        new RunwrightError("conflict", `cannot ${change.action} a ${current.status} item (needs ${allowed})`, {
          details: { itemId: id, status: current.status },
        });
      switch (change.action) {
        case "retire":
          if (current.status !== "active" && current.status !== "held") throw wrongStatus("active or held");
          return this.writeVersion(current, { ...content, status: "retired" }, "retired", change.actor, note, now);
        case "restore":
          if (current.status !== "retired") throw wrongStatus("retired");
          return this.writeVersion(current, { ...content, status: "active" }, "restored", change.actor, note, now);
        case "approve":
          if (current.status !== "held") throw wrongStatus("held");
          return this.writeVersion(current, { ...content, status: "active" }, "approved", change.actor, note, now);
        case "edit": {
          const patch = change.patch ?? {};
          const next = {
            title: patch.title ?? current.title,
            description: patch.description ?? current.description,
            body: patch.body ?? current.body,
          };
          if (next.title === current.title && next.description === current.description && next.body === current.body) return current;
          return this.writeVersion(current, { ...next, status: current.status }, "edited", change.actor, note, now);
        }
        default:
          throw new RunwrightError("bad_request", `unknown learning action ${JSON.stringify((change as { action: unknown }).action)}`);
      }
    });
  }

  async getLearningItem(id: string): Promise<LearningItem | null> {
    return this.read(() => {
      const row = this.learningRow(id);
      return row === undefined ? null : this.toLearningItem(row);
    });
  }

  async listLearningItems(filter: { agentId?: string; status?: LearningStatus; kind?: LearningKind }): Promise<LearningItem[]> {
    return this.read(() => {
      const where: string[] = [];
      const params: SQLInputValue[] = [];
      if (filter.agentId !== undefined) {
        where.push("agent_id = ?");
        params.push(filter.agentId);
      }
      if (filter.status !== undefined) {
        where.push("status = ?");
        params.push(filter.status);
      }
      if (filter.kind !== undefined) {
        where.push("kind = ?");
        params.push(filter.kind);
      }
      const sql = `SELECT * FROM learning_items ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, id`;
      return this.all(sql, ...params).map((r) => this.toLearningItem(r));
    });
  }

  async learningHistory(id: string): Promise<LearningHistoryEntry[]> {
    return this.read(() =>
      this.all("SELECT * FROM learning_history WHERE item_id = ? ORDER BY version", id).map((r) => this.toHistory(r)));
  }

  async learningUses(runId: string): Promise<LearningUse[]> {
    return this.read(() =>
      this.all("SELECT * FROM run_learning WHERE run_id = ? ORDER BY item_id", runId).map((r) => ({
        runId: str(r, "run_id"),
        itemId: str(r, "item_id"),
        version: num(r, "version"),
        mode: str(r, "mode") === "full" ? "full" : "line",
        opened: num(r, "opened") !== 0,
      })));
  }

  async skillServeCounts(agentId: string): Promise<Record<string, number>> {
    return this.read(() => {
      const rows = this.all(
        `SELECT li.id AS id, COUNT(DISTINCT r.id) AS served
           FROM learning_items li
           LEFT JOIN run_learning rl ON rl.item_id = li.id AND (rl.mode = 'full' OR rl.opened = 1)
           LEFT JOIN runs r ON r.id = rl.run_id AND r.status = 'completed'
          WHERE li.agent_id = ? AND li.kind = 'skill'
          GROUP BY li.id ORDER BY li.id`,
        agentId,
      );
      const counts: Record<string, number> = {};
      for (const row of rows) counts[str(row, "id")] = num(row, "served");
      return counts;
    });
  }

  async learningMetrics(agentId: string): Promise<LearningMetrics> {
    return this.read(() => {
      const rows = this.all(
        `SELECT r.id AS id, r.started_at AS started_at, r.finished_at AS finished_at,
            EXISTS (SELECT 1 FROM run_learning rl WHERE rl.run_id = r.id) AS after_learning,
            (SELECT ${saturatingSum("u.cost_micros")} FROM usage u WHERE u.run_id = r.id AND u.purpose NOT IN ${JOB_PURPOSE_EXCLUSIONS}) AS cost,
            (SELECT COUNT(*) FROM usage u WHERE u.run_id = r.id AND u.purpose NOT IN ${JOB_PURPOSE_EXCLUSIONS} AND u.cost_micros IS NULL) AS unknown_cost,
            (SELECT ${saturatingSum("u.input_tokens")} FROM usage u WHERE u.run_id = r.id AND u.purpose NOT IN ${JOB_PURPOSE_EXCLUSIONS}) AS input_tokens,
            (SELECT ${saturatingSum("u.output_tokens")} FROM usage u WHERE u.run_id = r.id AND u.purpose NOT IN ${JOB_PURPOSE_EXCLUSIONS}) AS output_tokens
          FROM runs r WHERE r.agent_id = ? AND r.status = 'completed'`,
        agentId,
      );
      const group = (selected: Row[]): MetricsGroup => {
        // Each value is at most MAX_TOTAL, so the float sum stays finite and the mean is clamped back into range.
        const average = (values: number[]): number | null =>
          values.length === 0 ? null : Math.min(values.reduce((a, b) => a + b, 0) / values.length, MAX_TOTAL);
        const priced = selected.filter((r) => num(r, "unknown_cost") === 0);
        const durations = selected
          .filter((r) => numOrNull(r, "started_at") !== null && numOrNull(r, "finished_at") !== null)
          .map((r) => num(r, "finished_at") - num(r, "started_at"));
        return {
          runs: selected.length,
          avgCostMicros: average(priced.map((r) => num(r, "cost"))),
          avgInputTokens: average(selected.map((r) => num(r, "input_tokens"))),
          avgOutputTokens: average(selected.map((r) => num(r, "output_tokens"))),
          avgDurationMs: average(durations),
        };
      };
      return {
        agentId,
        before: group(rows.filter((r) => num(r, "after_learning") === 0)),
        after: group(rows.filter((r) => num(r, "after_learning") !== 0)),
      };
    });
  }

  // ---------------------------------------------------------------- triggers

  async saveTrigger(trigger: TriggerRecord): Promise<void> {
    requireWellFormed({ id: trigger.id, name: trigger.name, message: trigger.message });
    this.tx(() => {
      this.run(
        `INSERT INTO triggers (id, name, kind, agent_id, enabled, config, message, limits, last_fired_at,
           next_fire_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, kind = excluded.kind, agent_id = excluded.agent_id,
           enabled = excluded.enabled, config = excluded.config, message = excluded.message, limits = excluded.limits,
           next_fire_at = excluded.next_fire_at, created_at = excluded.created_at, updated_at = excluded.updated_at`,
        trigger.id, trigger.name, trigger.kind, trigger.agentId, trigger.enabled ? 1 : 0,
        toJsonText({ cron: trigger.cron, webhook: trigger.webhook }), trigger.message, toJsonText(trigger.limits),
        trigger.lastFiredAt, trigger.nextFireAt, trigger.createdAt, trigger.updatedAt,
      );
    });
  }

  async updateTrigger(trigger: TriggerRecord, expected: TriggerRecord): Promise<"updated" | "changed" | "missing"> {
    requireWellFormed({ name: trigger.name, message: trigger.message });
    return this.tx(() => {
      const row = this.get("SELECT * FROM triggers WHERE id = ?", trigger.id);
      if (row === undefined) return "missing";
      const current = this.toTrigger(row);
      if (canonicalJson(triggerDefinition(current)) !== canonicalJson(triggerDefinition(expected))) return "changed";
      const keepCursor = current.enabled && trigger.enabled && current.cron !== null && trigger.cron !== null
        && current.cron.expression === trigger.cron.expression && current.cron.timeZone === trigger.cron.timeZone
        && current.nextFireAt !== null;
      this.run(
        `UPDATE triggers SET name = ?, kind = ?, agent_id = ?, enabled = ?, config = ?, message = ?, limits = ?,
           next_fire_at = ?, updated_at = ? WHERE id = ?`,
        trigger.name, trigger.kind, trigger.agentId, trigger.enabled ? 1 : 0,
        toJsonText({ cron: trigger.cron, webhook: trigger.webhook }), trigger.message, toJsonText(trigger.limits),
        keepCursor ? current.nextFireAt : trigger.nextFireAt, trigger.updatedAt, trigger.id,
      );
      return "updated";
    });
  }

  async fireTrigger(input: TriggerFireInput): Promise<TriggerFireResult> {
    const cron = input.cron;
    if (cron !== undefined && cron.nextFireAt !== null && !(cron.nextFireAt > cron.slot)) {
      throw new RunwrightError("internal", "a trigger's next fire time must be later than the slot it replaces");
    }
    this.checkFingerprint(input.run?.requestFingerprint);
    const keyDigest = idempotencyDigest(input.idempotencyKey);
    return this.tx((events): TriggerFireResult => {
      const existing = this.idempotentRun(keyDigest, null, false);
      const id = input.trigger.id;
      const row = this.get("SELECT * FROM triggers WHERE id = ?", id);
      const current = row === undefined ? null : this.toTrigger(row);
      const same = current !== null && current.enabled
        && canonicalJson(triggerDefinition(current)) === canonicalJson(triggerDefinition(input.trigger));
      const slotOpen = cron !== undefined && same && current.nextFireAt === cron.slot;
      const now = this.clock.now();
      const consumeSlot = (): void => {
        if (cron !== undefined) this.run("UPDATE triggers SET next_fire_at = ?, updated_at = ? WHERE id = ?", cron.nextFireAt, now, id);
      };

      if (existing !== null) {
        if (slotOpen) consumeSlot();
        return { outcome: "duplicate", run: existing };
      }
      const run = input.run;
      if (run === undefined) return { outcome: "no_run" };
      if (current === null) return { outcome: "missing" };
      if (!current.enabled) return { outcome: "disabled" };
      if (!same) return { outcome: "changed" };
      if (cron !== undefined && !slotOpen) return { outcome: "stale" };

      const agentId = current.agentId;
      const made = this.insertRun(events, {
        agentId, input: run.input, limits: run.limits, trigger: { id, kind: input.kind }, keyDigest,
        ...(run.revision === undefined ? {} : { revision: run.revision }),
        requestHash: run.requestFingerprint ?? requestFingerprint({ agentId, input: run.input, limits: run.limits }),
      });
      if (made.outcome !== "created") {
        consumeSlot();
        return { outcome: "agent_missing" };
      }
      const lastFiredAt = Math.max(current.lastFiredAt ?? 0, input.firedAt);
      if (cron === undefined) {
        this.run("UPDATE triggers SET last_fired_at = ?, updated_at = ? WHERE id = ?", lastFiredAt, now, id);
      } else {
        this.run("UPDATE triggers SET last_fired_at = ?, next_fire_at = ?, updated_at = ? WHERE id = ?",
          lastFiredAt, cron.nextFireAt, now, id);
      }
      return { outcome: "started", run: made.run };
    });
  }

  async getTrigger(id: string): Promise<TriggerRecord | null> {
    return this.read(() => {
      const row = this.get("SELECT * FROM triggers WHERE id = ?", id);
      return row === undefined ? null : this.toTrigger(row);
    });
  }

  async listTriggers(): Promise<TriggerRecord[]> {
    return this.read(() => this.all("SELECT * FROM triggers ORDER BY created_at, id").map((r) => this.toTrigger(r)));
  }

  async deleteTrigger(id: string): Promise<boolean> {
    return this.tx(() => this.run("DELETE FROM triggers WHERE id = ?", id) > 0);
  }

  // ---------------------------------------------------------------- secrets

  async putSecret(name: string, sealed: Uint8Array): Promise<{ updatedAt: number }> {
    requireWellFormed({ name });
    return this.tx(() => {
      const now = this.clock.now();
      const current = this.get("SELECT sealed FROM secrets WHERE name = ?", name);
      if (current !== undefined && !sameBytes(blob(current, "sealed"), sealed)) this.retireSecret(name, blob(current, "sealed"), now);
      this.run(
        `INSERT INTO secrets (name, sealed, created_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET sealed = excluded.sealed, updated_at = excluded.updated_at`,
        name, sealed, now, now,
      );
      return { updatedAt: now };
    });
  }

  async getSecret(name: string): Promise<{ sealed: Uint8Array; updatedAt: number } | null> {
    return this.read(() => {
      const row = this.get("SELECT sealed, updated_at FROM secrets WHERE name = ?", name);
      if (row === undefined) return null;
      return { sealed: blob(row, "sealed"), updatedAt: num(row, "updated_at") };
    });
  }

  async deleteSecret(name: string): Promise<boolean> {
    return this.tx(() => {
      const current = this.get("SELECT sealed FROM secrets WHERE name = ?", name);
      if (current === undefined) return false;
      this.retireSecret(name, blob(current, "sealed"), this.clock.now());
      return this.run("DELETE FROM secrets WHERE name = ?", name) > 0;
    });
  }

  async listSecrets(): Promise<{ name: string; updatedAt: number }[]> {
    return this.read(() =>
      this.all("SELECT name, updated_at FROM secrets ORDER BY name").map((r) => ({ name: str(r, "name"), updatedAt: num(r, "updated_at") })));
  }

  async listRetiredSecrets(name?: string): Promise<{ name: string; sealed: Uint8Array; retiredAt: number }[]> {
    return this.read(() => {
      const rows = name === undefined
        ? this.all("SELECT name, sealed, retired_at FROM secret_history ORDER BY id")
        : this.all("SELECT name, sealed, retired_at FROM secret_history WHERE name = ? ORDER BY id", name);
      return rows.map((r) => ({ name: str(r, "name"), sealed: blob(r, "sealed"), retiredAt: num(r, "retired_at") }));
    });
  }

  async pruneRetiredSecrets(): Promise<number> {
    return this.tx(() => this.run(PRUNE_RETIRED_SECRETS));
  }

  /** Keeps a value that is being replaced or deleted as a retired value (inside the caller's transaction). */
  private retireSecret(name: string, sealed: Uint8Array, at: number): void {
    this.run("INSERT INTO secret_history (name, sealed, retired_at) VALUES (?, ?, ?)", name, sealed, at);
  }

  // ---------------------------------------------------------------- runners

  async upsertRunner(info: RunnerInfo): Promise<void> {
    this.tx(() => {
      this.run(
        `INSERT INTO runners (id, pid, hostname, concurrency, started_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET pid = excluded.pid, hostname = excluded.hostname, concurrency = excluded.concurrency,
           started_at = excluded.started_at, last_seen_at = excluded.last_seen_at`,
        info.id, info.pid, info.hostname, info.concurrency, info.startedAt, info.lastSeenAt,
      );
    });
  }

  async removeRunner(id: string): Promise<void> {
    this.tx(() => {
      this.run("DELETE FROM runners WHERE id = ?", id);
    });
  }

  async listRunners(): Promise<RunnerInfo[]> {
    return this.read(() => this.all("SELECT * FROM runners ORDER BY id").map((r) => this.toRunner(r)));
  }
}

function currentVersion(db: DatabaseSync): number {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'").get();
  if (table === undefined) return 0;
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get();
  return row === undefined ? 0 : num(row, "v");
}

function migrate(db: DatabaseSync): number {
  const found = currentVersion(db);
  if (found > LATEST_SCHEMA_VERSION) {
    throw new RunwrightError("schema_too_new", `the database schema is version ${found}; this build supports up to ${LATEST_SCHEMA_VERSION}`, {
      details: { found, latest: LATEST_SCHEMA_VERSION },
    });
  }
  for (const migration of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (migration.version <= found) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      if (currentVersion(db) < migration.version) {
        for (const statement of migration.statements) db.exec(statement);
        migration.rewrite?.(db);
        for (const statement of migration.finish ?? []) db.exec(statement);
      }
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }
  return currentVersion(db);
}

/** The columns of a trigger a person defines (not its firing bookkeeping), for compare-and-set updates and fires. */
function triggerDefinition(trigger: TriggerRecord): Json {
  return {
    name: trigger.name, kind: trigger.kind, agentId: trigger.agentId, enabled: trigger.enabled, cron: trigger.cron,
    webhook: trigger.webhook, message: trigger.message, limits: trigger.limits as unknown as Json,
  };
}

/** Opens (creating and migrating as needed) a SQLite store. Throws schema_too_new for a newer database. */
export async function openSqliteStore(options: SqliteStoreOptions): Promise<Store> {
  let db: DatabaseSync | null = null;
  try {
    if (options.path !== ":memory:") mkdirSync(dirname(options.path), { recursive: true });
    db = new DatabaseSync(options.path);
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`PRAGMA synchronous = ${options.synchronous === "full" ? "FULL" : "NORMAL"}`);
    db.exec("PRAGMA foreign_keys = ON");
    const version = migrate(db);
    const clock = options.clock ?? systemClock;
    return new SqliteStore(db, clock, options.ids ?? createIdSource({ clock }), version);
  } catch (error) {
    try {
      db?.close();
    } catch {
      // Closing a half-opened database can fail; the open error is what matters.
    }
    if (isRunwrightError(error)) throw error;
    throw new RunwrightError("store_error", `cannot open the store at ${options.path}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}
