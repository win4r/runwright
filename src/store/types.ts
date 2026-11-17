import type { Json, JsonObject } from "../core/json.ts";
import type { AgentDefinition } from "../agents/definition.ts";
import type { WorkflowDocument } from "../workflow/types.ts";
import type { ObjectSpec } from "./record-fields.ts";

export type RunStatus = "queued" | "running" | "waiting" | "paused" | "completed" | "failed" | "cancelled";
export interface AgentRecord { id: string; name: string; currentRevision: number; createdAt: number; updatedAt: number }
export interface AgentRevision { agentId: string; revision: number; definition: AgentDefinition; definitionHash: string; createdAt: number }
/** Called inside the save's transaction, before anything is written. `resolve(name)` is the latest stored
 *  document of that name as of this transaction (the candidate is not in it). A throw aborts the save. */
export type WorkflowSaveCheck = (resolve: (name: string) => WorkflowDocument | null) => void;

export interface SavedWorkflow { name: string; version: number; document: WorkflowDocument; documentHash: string;
  source: "api" | "promotion"; skillItemId: string | null; createdAt: number }

export interface RunLimits { maxCostMicros: number | null; maxToolCalls: number | null; maxTurns: number | null; allowUnpriced: boolean }
export interface RunInput { message: string; data: Json }
export interface RunError { code: string; message: string }
/** The run's totals. Every total is an integer from 0 to 2^53 − 1: totals saturate at 2^53 − 1 instead of passing it. */
export interface RunUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
  costMicros: number; costUnknown: boolean; toolCalls: number; turns: number }
export interface RunTrigger { id: string; kind: "cron" | "webhook" | "manual" }
export interface RunRecord {
  id: string; agentId: string; revision: number; status: RunStatus;
  input: RunInput; output: Json; error: RunError | null; limits: RunLimits;
  /** idempotencyDigest() of the key the run was created with ("sha256:<64 hex>"), never the key's text; null without a key. */
  idempotencyKey: string | null;
  trigger: RunTrigger | null;
  epoch: number; leaseOwner: string | null; leaseExpiresAt: number | null;
  journalSeq: number; openPendings: number; usage: RunUsage;
  createdAt: number; startedAt: number | null; finishedAt: number | null; updatedAt: number;
  journalArchivedAt: number | null;
}
export interface Lease { runId: string; runnerId: string; epoch: number }
export interface ClaimedRun { run: RunRecord; lease: Lease }
export interface JournalRecord { runId: string; seq: number; epoch: number; ts: number; type: string; key: string | null; data: JsonObject }
export interface NewJournalRecord {
  type: string; key?: string; data: JsonObject;
  /**
   * How `data` is redacted before it is stored, in place of RECORD_FIELDS[type]. The engine sets it for a
   * record that carries a value whose writer declared a field specification. Used by every redaction pass
   * (`redactCommitBatch`); never stored and never part of a JournalRecord.
   */
  fields?: ObjectSpec;
}

export type RunCommand =
  | { type: "message"; text: string }
  | { type: "answer"; pendingId: string; answer: string }
  | { type: "approve"; pendingId: string; always: boolean }
  | { type: "deny"; pendingId: string; reason: string | null }
  | { type: "limits"; limits: Partial<RunLimits> }
  | { type: "resolve_interrupted"; pendingId: string; action: "retry" | "skip" | "cancel"; result: string | null }
  | { type: "cancel"; reason: string | null }
  | { type: "pause" }
  | { type: "resume" };
export interface CommandRecord { id: string; runId: string; command: RunCommand; createdAt: number; consumedAt: number | null }

export type PendingKind = "question" | "approval" | "spend_cap" | "tool_budget" | "turn_limit" | "interrupted";
/**
 * detail by kind:
 *   question     { question: string, choices: string[] }
 *   approval     { tool: string, args: JsonObject }
 *   spend_cap    { capMicros, spentMicros, neededMicros, nextCallWorstCaseMicros, reason: "cap" | "unknown_price", model: string }
 *   tool_budget  { limit, used, needed }        turn_limit { limit, used, needed }   (needed = max(1, used + 1 − limit))
 *   interrupted  { tool: string, args: JsonObject, attempt: number }
 * resolution by kind:
 *   question {answer} · approval {decision: "approve" | "deny", always: boolean, reason: string | null}
 *   spend_cap / tool_budget / turn_limit {limits: RunLimits} · interrupted {action, result: string | null}
 * Any kind's detail may also carry `expiresAt` (a number, ms since epoch): the pending was opened inside a node
 * deadline and is closed at that instant if nobody resolved it before. Such a pending is resolved
 * `{expired: true, expiresAt}`; a run that finishes closes what is still open with `{closed: <how it ended>}`.
 */
export interface PendingRecord {
  id: string; runId: string; agentId: string; kind: PendingKind; stepKey: string;
  /** One line for a person, e.g. "Approve shell: npm test". */
  title: string;
  detail: JsonObject;
  status: "open" | "resolved"; resolution: JsonObject | null; createdAt: number; resolvedAt: number | null;
}
export interface NewPending { id: string; kind: PendingKind; stepKey: string; title: string; detail: JsonObject }

export type ModelPurpose = "run" | "step" | "decision" | "compaction" | "learning" | "grader" | "promotion";
export interface NewUsage { model: string; purpose: ModelPurpose; inputTokens: number; outputTokens: number;
  cacheReadTokens: number; cacheWriteTokens: number; costMicros: number | null; assumed: boolean }
export interface CommitBatch {
  records: NewJournalRecord[];
  /**
   * A transition to any status other than "queued" is refused with "commands_pending" while the run has a
   * command that is neither consumed nor listed in this batch's `consumeCommands`.
   */
  transition?: {
    to: RunStatus; output?: Json; error?: RunError;
    /** Only with `to: "waiting"`: the instant (ms since epoch, a finite number) from which the run is claimable
     *  again although no command arrived. Absent: the run waits for a command. */
    wakeAt?: number;
  };
  openPendings?: NewPending[];
  resolvePendings?: { id: string; resolution: JsonObject }[];
  /** Also added to the run row totals; null cost sets costUnknown. */
  usage?: NewUsage[];
  /** Increments. */
  counters?: { toolCalls?: number; turns?: number };
  setLimits?: RunLimits;
  consumeCommands?: string[];
  learning?: LearningEffects;
}
export interface CommitResult { run: RunRecord; records: JournalRecord[] }

/**
 * limits = agent revision limits overridden by input.limits. The idempotencyKey is looked up and stored only as
 * idempotencyDigest(key) (src/store/idempotency.ts); its text is never stored, and a key that is not well-formed
 * Unicode (an unpaired surrogate) is refused with bad_request before anything is read or written (by createRun,
 * findIdempotentRun and fireTrigger alike). When a run with that digest exists
 * it is returned with created:false; if strictIdempotency (default true) and the request's fingerprint differs
 * from the stored one → RunwrightError("idempotency_mismatch"). A run stored without a fingerprint (schema
 * migration 4) is never a mismatch. findIdempotentRun answers the same question (same lookup, same mismatch rule)
 * without creating anything and without reading the agent or its revision.
 *
 * A trigger fire does not call createRun: Store.fireTrigger begins its transaction with the same lookup (never
 * strict) and then creates the run with the same code (limit merge, runs row, run.created, run.queued), but only
 * from the trigger as it is stored at that moment (see TriggerFireInput).
 */
export interface CreateRunInput { agentId: string; revision?: number; input: RunInput; limits?: Partial<RunLimits>;
  idempotencyKey?: string; strictIdempotency?: boolean; trigger?: RunTrigger; availableAt?: number;
  /** requestFingerprint() of the caller's original request. When absent the store computes it from this input. */
  requestFingerprint?: string }
/** A lookup of the run an idempotency key already started. */
export interface IdempotentRunQuery {
  idempotencyKey: string;
  /** requestFingerprint() of the request as sent. When given, and strictIdempotency is not false, it is compared with the stored one. */
  requestFingerprint?: string;
  /** Default true. false: a different request under the same key is not an error (trigger fires). */
  strictIdempotency?: boolean;
}
export interface RunFilter { agentId?: string; statuses?: RunStatus[]; triggerId?: string; finishedBefore?: number; journalArchived?: boolean }
/** cursor is opaque (base64url of created_at + id). `limit`: a positive integer (bad_request otherwise), at most 200 rows are returned. */
export interface PageRequest { limit: number; cursor?: string }
/** Newest first (runs) / oldest first (pendings). */
export interface Page<T> { items: T[]; nextCursor: string | null }
export interface PendingFilter { status?: "open" | "resolved"; runId?: string; agentId?: string; kind?: PendingKind }
export interface UsageQuery { groupBy: "day" | "agent" | "model"; from?: number; to?: number; agentId?: string }
/** One group of a usage summary. Token and cost totals saturate at 2^53 − 1 (an integer, never more). */
export interface UsageRow { key: string; runs: number; calls: number; inputTokens: number; outputTokens: number;
  cacheReadTokens: number; cacheWriteTokens: number; costMicros: number; unknownCostCalls: number }

export type LearningKind = "note" | "skill";
export type LearningStatus = "active" | "held" | "retired";
export interface LearningItem { id: string; agentId: string; kind: LearningKind; name: string; title: string;
  description: string; body: string; status: LearningStatus; version: number; etag: string;
  sourceRunId: string | null; promotedWorkflow: string | null;
  /** The version of `promotedWorkflow` this skill was promoted to. null when the skill is not promoted. */
  promotedWorkflowVersion: number | null;
  promotionAttempts: number; createdAt: number; updatedAt: number }
export type LearningAction = "created" | "updated" | "held" | "approved" | "retired" | "restored" | "edited" | "promoted";
export interface LearningHistoryEntry { itemId: string; version: number; action: LearningAction; title: string;
  description: string; body: string; status: LearningStatus; actor: string; note: string | null; at: number }
/**
 * retire: active|held → retired · restore: retired → active · approve: held → active · edit: any status, content only.
 * Wrong status → "conflict"; wrong etag → "etag_mismatch"; unknown id → "not_found".
 */
export interface LearningChange { expectedEtag: string; action: "retire" | "restore" | "approve" | "edit";
  patch?: { title?: string; description?: string; body?: string }; actor: string; note?: string }
/** One conditional write of a learning item by the committing run. agentId and sourceRunId are the run's. */
export interface LearningPut {
  /** Row id used when the item is created (expectedVersion null); ignored on an update. Format "li_...". */
  id: string;
  kind: LearningKind; name: string; title: string; description: string; body: string;
  status: "active" | "held";
  note?: string;
  /** null: no item (agent, kind, name) may exist yet. n: it must exist at exactly version n and not be retired. */
  expectedVersion: number | null;
}
/**
 * One promotion outcome for a skill. A kept promotion saves the workflow (source "promotion", owned by the skill)
 * and links the skill to its name and the version saved. The name must not have a version owned by anything
 * else (an API save, or another skill); otherwise the whole commit is refused with learning_conflict,
 * details.reason "workflow_name_taken".
 */
export interface LearningPromotion {
  itemId: string;
  /** With a workflow: the skill must be active, unpromoted and at exactly this version. Ignored when workflow is null. */
  expectedVersion: number;
  /** null = a rejected attempt: only promotion_attempts + 1. Otherwise the workflow is saved and linked. */
  workflow: { name: string; document: WorkflowDocument } | null;
  note: string;
}
/** Learning writes of a run. Applied by commit() in the same transaction and under the same lease check as the batch. */
export interface LearningEffects {
  puts?: LearningPut[];
  /** Upserts run_learning rows of the committing run (version and mode replaced, opened kept). */
  given?: { itemId: string; version: number; mode: "full" | "line" }[];
  /** Item ids the committing run opened: sets opened = 1, inserting a 'line' row at the item's current version if absent. */
  opened?: string[];
  promotions?: LearningPromotion[];
}
export interface LearningUse { runId: string; itemId: string; version: number; mode: "full" | "line"; opened: boolean }
export interface MetricsGroup { runs: number; avgCostMicros: number | null; avgInputTokens: number | null;
  avgOutputTokens: number | null; avgDurationMs: number | null }
export interface LearningMetrics { agentId: string; before: MetricsGroup; after: MetricsGroup }

export interface TriggerRecord { id: string; name: string; kind: "cron" | "webhook"; agentId: string; enabled: boolean;
  cron: { expression: string; timeZone: string } | null; webhook: { secretName: string } | null;
  message: string; limits: RunLimits; lastFiredAt: number | null; nextFireAt: number | null; createdAt: number; updatedAt: number }

/** One fire of a trigger. */
export interface TriggerFireInput {
  /** The trigger as the caller read it. A run is created only while the stored definition still equals this one's. */
  trigger: TriggerRecord;
  kind: "cron" | "webhook" | "manual";
  /** The fire's key: `cron:<id>:<slot>`, `webhook:<id>:<delivery>`, `manual:<id>:<request id>`. Stored as its digest. */
  idempotencyKey: string;
  /** Stored as the trigger's lastFiredAt when a run is created (never moved backwards). */
  firedAt: number;
  /**
   * The run to create, built from `trigger`: `input` is `{message: trigger.message, data}`, `limits` the limits
   * the trigger sets. `requestFingerprint`, when given, is stored as the run's request hash; otherwise the store
   * computes it from agent id, input and limits as `createRun` does. `revision` is the revision the run pins
   * (the one its input was redacted against: the write-redaction wrapper passes the revision it read); absent:
   * the agent's current revision at insert. A revision the agent does not have is the "agent_missing" outcome
   * (step 7). Absent `run`: the call only answers for a key that already has a run (and settles a scheduled
   * fire's cursor); nothing is created.
   */
  run?: { input: RunInput; limits: Partial<RunLimits>; requestFingerprint?: string; revision?: number };
  /**
   * A scheduled fire: `slot` is the nextFireAt the scheduler read, `nextFireAt` the cursor to store in its place
   * (null: the schedule has no later fire time). The fire happens only while the stored cursor still equals `slot`.
   */
  cron?: { slot: number; nextFireAt: number | null };
}

export type TriggerFireResult =
  | { outcome: "started"; run: RunRecord }
  | { outcome: "duplicate"; run: RunRecord }
  | { outcome: "no_run" | "missing" | "disabled" | "changed" | "stale" | "agent_missing" };

export interface RunnerInfo { id: string; pid: number; hostname: string; concurrency: number; startedAt: number; lastSeenAt: number }

export type StoreEvent =
  | { type: "run.queued"; runId: string }
  | { type: "command"; runId: string }
  | { type: "journal"; runId: string; status: RunStatus; records: JournalRecord[] };

export interface Store {
  readonly schemaVersion: number;
  /** Events of THIS handle, emitted after the transaction commits. */
  subscribe(listener: (event: StoreEvent) => void): () => void;
  close(): Promise<void>;
  // agents and workflows
  saveAgent(input: { id?: string; definition: AgentDefinition }): Promise<{ agent: AgentRecord; revision: AgentRevision; created: boolean }>;
  getAgent(id: string): Promise<AgentRecord | null>;
  listAgents(): Promise<AgentRecord[]>;
  /** Default: current. */
  getRevision(agentId: string, revision?: number): Promise<AgentRevision | null>;
  /** Newest first. */
  listRevisions(agentId: string): Promise<AgentRevision[]>;
  /**
   * A new version unless the document equals the latest version's (created: false). A name belongs to its first
   * owner: an API save onto a name that has a promoted version throws "conflict" (details.reason
   * "promoted_workflow", name, skillItemId); a promotion (needs skillItemId) onto a name that has an API version
   * or another skill's version throws "learning_conflict" (details.reason "workflow_name_taken"). Nothing is
   * written when it throws. `check`, when given, runs inside the save's transaction before anything else (see
   * WorkflowSaveCheck); what it throws aborts the save and is rethrown unchanged.
   */
  saveWorkflow(input: { name: string; document: WorkflowDocument; source: "api" | "promotion"; skillItemId?: string; check?: WorkflowSaveCheck }): Promise<{ workflow: SavedWorkflow; created: boolean }>;
  /** Default: latest. */
  getWorkflow(name: string, version?: number): Promise<SavedWorkflow | null>;
  /** Latest version of each. */
  listWorkflows(): Promise<SavedWorkflow[]>;
  // runs, leases, journal
  /** Writes run.created (seq 1); emits run.queued. */
  createRun(input: CreateRunInput): Promise<{ run: RunRecord; created: boolean }>;
  /**
   * The run `idempotencyKey` already started, or null when the key is unused. Reads the `runs` row with
   * idempotencyDigest(key) and nothing else: no agent, revision, workflow or secret. Throws idempotency_mismatch
   * exactly when createRun would for the same key and fingerprint (strict, a fingerprint was given, the stored
   * request hash is not null and differs; same message and details), validation_failed for a fingerprint that
   * is not 64 lower-case hex characters, and bad_request for a key that is not well-formed Unicode.
   */
  findIdempotentRun(query: IdempotentRunQuery): Promise<RunRecord | null>;
  getRun(id: string): Promise<RunRecord | null>;
  listRuns(filter: RunFilter, page: PageRequest): Promise<Page<RunRecord>>;
  /**
   * In one transaction: first requeues waiting runs whose wake time (`transition.wakeAt` of the commit that left
   * them waiting) has passed, at most 100 per call, earliest first, each emitting `run.queued` and writing no
   * journal record; then claims up to `limit` runs: orphaned `running` runs whose lease expired, then queued runs
   * that are available. A requeued run that does not fit in `limit` stays queued like any other.
   */
  claimRuns(input: { runnerId: string; limit: number; leaseMs: number }): Promise<ClaimedRun[]>;
  /** Returns LOST run ids. */
  heartbeat(input: { runnerId: string; runIds: string[]; leaseMs: number }): Promise<string[]>;
  /**
   * Throws lease_lost | illegal_transition | commands_pending | learning_conflict | not_found (unknown learning item).
   * Everything in the batch, learning effects included, commits in one transaction or not at all.
   */
  commit(lease: Lease, batch: CommitBatch): Promise<CommitResult>;
  /** Records after `afterSeq` (an integer >= 0, default 0), at most `limit` (a positive integer, default 1000); bad_request otherwise. */
  readJournal(runId: string, options?: { afterSeq?: number; limit?: number }): Promise<JournalRecord[]>;
  /**
   * Terminal runs only. Deletes the journal rows and marks the run archived, but only if the run is not archived
   * yet and its journal still holds exactly `records` rows whose highest seq is `lastSeq` and equals the run's
   * journalSeq. Otherwise throws "conflict" with details.reason "not_terminal" | "already_archived" |
   * "journal_changed" and changes nothing. Returns the number of rows deleted.
   */
  archiveJournal(runId: string, archive: { path: string; records: number; lastSeq: number }): Promise<number>;
  // commands and pendings
  /** Throws not_found | run_terminal; re-queues per 3.2. */
  enqueueCommand(runId: string, command: RunCommand): Promise<CommandRecord>;
  /** In arrival order: the order in which their inserts committed (a sequence assigned inside the enqueue's write transaction), never by clock or id. */
  listCommands(runId: string, options?: { unconsumedOnly?: boolean }): Promise<CommandRecord[]>;
  getPending(id: string): Promise<PendingRecord | null>;
  /** Oldest first. */
  listPendings(filter: PendingFilter, page: PageRequest): Promise<Page<PendingRecord>>;
  // usage
  usageSummary(query: UsageQuery): Promise<UsageRow[]>;
  // learning
  changeLearningItem(id: string, change: LearningChange): Promise<LearningItem>;
  getLearningItem(id: string): Promise<LearningItem | null>;
  listLearningItems(filter: { agentId?: string; status?: LearningStatus; kind?: LearningKind }): Promise<LearningItem[]>;
  /** Oldest first. */
  learningHistory(id: string): Promise<LearningHistoryEntry[]>;
  learningUses(runId: string): Promise<LearningUse[]>;
  /** itemId → completed runs served. */
  skillServeCounts(agentId: string): Promise<Record<string, number>>;
  learningMetrics(agentId: string): Promise<LearningMetrics>;
  // triggers
  /**
   * Inserts the trigger, or replaces an existing one's definition and its cursor (nextFireAt, createdAt,
   * updatedAt as given); an existing row keeps its last_fired_at. The API uses it only for a new id; changes to
   * an existing trigger go through updateTrigger.
   */
  saveTrigger(trigger: TriggerRecord): Promise<void>;
  /**
   * Compare-and-set of a trigger's definition: writes the definition columns of `trigger` (keeping lastFiredAt)
   * only if the stored definition (name, kind, agent, enabled, cron, webhook, message, limits) still equals
   * `expected`'s. Never inserts. "missing": no such trigger (a deleted one is not recreated); "changed": another
   * writer changed the definition since `expected` was read; nothing is written.
   *
   * The cursor: when the stored trigger and `trigger` are both enabled, both have a cron with the same expression
   * and time zone, and the stored nextFireAt is not null, the stored nextFireAt is kept (so an edit that leaves
   * the schedule alone never skips a fire time that is due, nor undoes a cursor a fire moved meanwhile). In every
   * other case `trigger.nextFireAt` is written.
   */
  updateTrigger(trigger: TriggerRecord, expected: TriggerRecord): Promise<"updated" | "changed" | "missing">;
  /**
   * One fire of a trigger, in one transaction, decided on the stored row. In this order:
   * 0. (before the transaction) with `cron`, `cron.nextFireAt` must be null or later than `cron.slot`, else
   *    "internal"; a given `run.requestFingerprint` must be 64 lower-case hex characters, else validation_failed.
   * 1. The key is looked up first (never strict).
   * 2. The trigger row is read. It is "the same" when it exists, is enabled and its definition (name, kind,
   *    agent, enabled, cron, webhook, message, limits) equals `input.trigger`'s; the slot is open when `cron` is
   *    given, the row is the same and its nextFireAt equals `cron.slot`.
   * 3. A key that has a run: "duplicate" with that run, whatever the trigger's state (missing, disabled,
   *    changed). The only write: when the slot is open, nextFireAt becomes `cron.nextFireAt` (a run for the
   *    slot exists but the cursor was never moved).
   * 4. No `run`: "no_run".
   * 5. No row: "missing"; row disabled: "disabled" (also when other fields differ too); not the same: "changed".
   * 6. `cron` given and the slot not open: "stale" (another fire consumed it, or the cursor moved).
   * 7. The agent, or the revision to pin (`run.revision`, else its current one), is gone: "agent_missing"; with `cron` the slot is still consumed
   *    (nextFireAt = `cron.nextFireAt`), lastFiredAt is not touched.
   * 8. Otherwise the run is created as createRun creates it (limits merged with the agent revision's, the
   *    trigger as {id, kind}, run.created, run.queued), and the trigger's lastFiredAt becomes
   *    max(stored, firedAt), its updatedAt the store's clock, and with `cron` its nextFireAt `cron.nextFireAt`:
   *    "started".
   * Nothing is written in 4, 5 and 6. It never inserts a trigger and never changes a definition column.
   */
  fireTrigger(input: TriggerFireInput): Promise<TriggerFireResult>;
  getTrigger(id: string): Promise<TriggerRecord | null>;
  listTriggers(): Promise<TriggerRecord[]>;
  deleteTrigger(id: string): Promise<boolean>;
  // secrets (sealed bytes only; the store never sees plaintext)
  /** Replaces the value; a different earlier value is kept as a retired value in the same transaction. */
  putSecret(name: string, sealed: Uint8Array): Promise<{ updatedAt: number }>;
  getSecret(name: string): Promise<{ sealed: Uint8Array; updatedAt: number } | null>;
  /** Deletes the value; it is kept as a retired value in the same transaction. */
  deleteSecret(name: string): Promise<boolean>;
  listSecrets(): Promise<{ name: string; updatedAt: number }[]>;
  /** Retired values (sealed under their name), oldest first; of one name when given. */
  listRetiredSecrets(name?: string): Promise<{ name: string; sealed: Uint8Array; retiredAt: number }[]>;
  /** Deletes every retired value no unfinished run can have been handed: those with no run in a non-terminal
   *  status created at or before `retiredAt`. Returns how many were deleted. */
  pruneRetiredSecrets(): Promise<number>;
  // runners
  upsertRunner(info: RunnerInfo): Promise<void>;
  removeRunner(id: string): Promise<void>;
  listRunners(): Promise<RunnerInfo[]>;
}
