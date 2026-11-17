import type { Json, JsonObject } from "../core/json.ts";
import type {
  JournalRecord, ModelPurpose, NewJournalRecord, NewPending, PendingKind, RunCommand, RunError, RunInput, RunLimits,
  RunTrigger,
} from "../store/types.ts";
import type { ObjectSpec } from "../store/record-fields.ts";
import type { AttemptBilling, StopReason, ToolCall, Usage, UsageCount } from "../models/types.ts";
import type { InboxMessage, LearningGiven, ToolOutcome } from "./types.ts";

/** Why a tool call was left unfinished: the process died, a person paused the run, or a forced shutdown. */
export type ToolInterruptReason = "crash" | "pause" | "shutdown";

/** The detail of an "interrupted" pending. */
export interface InterruptedDetail { tool: string; args: JsonObject; attempt: number; reason: ToolInterruptReason }

export interface JournalDataMap {
  "run.created": { agentId: string; revision: number; input: RunInput; limits: RunLimits; trigger: RunTrigger | null };
  "run.claimed": { runnerId: string };
  "command.applied": { commandId: string; command: RunCommand };
  "command.rejected": { commandId: string; command: RunCommand; reason: string };
  "limits.changed": { limits: RunLimits };
  "inbox.taken": { messages: InboxMessage[] };
  "model.started": { model: string; purpose: ModelPurpose; step: string | null; turn: number; countsAsTurn: boolean;
    inputTokensEstimate: number; maxOutputTokens: number; worstCaseMicros: number | null;
    /** true for the repair call of a structured-output step; absent in records written by older versions. */
    repair?: boolean;
    /** 1-based provider attempt of this call. Absent in records written by older versions (attempt 1). */
    attempt?: number };
  /** The first response of a structured-output step did not match its schema. Billed; a repair call follows. */
  "model.invalid": { model: string; purpose: ModelPurpose; text: string; toolCalls: ToolCall[]; output: Json;
    problems: { path: string; message: string }[]; usage: Usage; costMicros: number | null; durationMs: number;
    /** See model.finished. */
    usageAssumed?: UsageCount[] };
  "model.finished": { model: string; purpose: ModelPurpose; text: string; toolCalls: ToolCall[]; output: Json;
    stopReason: StopReason; usage: Usage; costMicros: number | null; durationMs: number;
    /**
     * The counts the provider did not report, charged their reserved bound (rule U): "input" means `usage` holds
     * the attempt's worst-case input tokens, "output" its maxOutputTokens. Present only when non-empty; absent in
     * records written by older versions.
     */
    usageAssumed?: UsageCount[] };
  "model.interrupted": { model: string; reason: "crash" | "pause" | "cancel" | "shutdown" | "deadline";
    assumedCostMicros: number | null;
    /** The attempt that was in flight. Absent in records written by older versions. */
    attempt?: number };
  "model.failed": { model: string; error: RunError; usage?: Usage; costMicros?: number | null;
    /** With `usage` (a repair reply still invalid): the counts charged their reserved bound, as on model.finished. */
    usageAssumed?: UsageCount[];
    /** Provider attempts made by the failed call. Absent in records written by older versions. */
    attempts?: number;
    /** Present exactly when the last attempt's billing was "unknown": what it was charged (null = unpriced model). */
    assumedCostMicros?: number | null;
    /**
     * Present when the call ended while a provider's retry-after wait was outstanding: the part of that wait, in
     * ms, still to pass, counted from this record's `ts`.
     */
    retryAfterMs?: number;
    /** Present (true) exactly when the call was not retried because the hint was over the limit. */
    retryAfterOverLimit?: true };
  /**
   * A provider attempt failed with a transient error and another attempt follows. Written when the attempt fails,
   * in one commit with its usage row. `status`, `billing` and `assumedCostMicros` are absent in records written
   * by older versions; `assumedCostMicros` is present exactly when billing is "unknown" (null = unpriced model).
   */
  "model.retry": { attempt: number; delayMs: number; code: string; message: string;
    status?: number | null; billing?: AttemptBilling; assumedCostMicros?: number | null;
    /** The provider's retry-after hint in ms. Present exactly when it gave one; `delayMs` is then equal to it. */
    retryAfterMs?: number };
  "tool.started": { callId: string; tool: string; args: JsonObject; effect: "read" | "write"; attempt: number };
  "tool.finished": { callId: string; tool: string; outcome: ToolOutcome; content: string; data: Json; isError: boolean;
    untrusted: boolean; truncated: boolean; fullResultPath: string | null; durationMs: number;
    /** Lower-case hex SHA-256 of the bytes of the file at fullResultPath, as written. Present exactly when fullResultPath is not null. Absent in records written by older versions. */
    fullResultSha256?: string;
    /** Byte length of that file. Present exactly when fullResultPath is not null. Absent in records written by older versions. */
    fullResultBytes?: number;
    /** Workspace-relative path of the file holding the canonical JSON of the result's structured data, saved because it was over the result size limit (data is then null). Absent in records written by older versions. */
    fullDataPath?: string;
    /** Lower-case hex SHA-256 of the bytes of that file, as written. */
    fullDataSha256?: string;
    /** Byte length of that file. */
    fullDataBytes?: number; };
  /** reason is absent in records written by older versions (they were all "crash"). */
  "tool.interrupted": { tool: string; args: JsonObject; attempt: number; reason?: ToolInterruptReason };
  "pending.opened": { pending: NewPending };
  "pending.resolved": { pendingId: string; kind: PendingKind; resolution: JsonObject; commandId: string | null };
  /** MemoMeta.info is spread in. */
  "step.started": { name: string } & JsonObject;
  "step.finished": { name: string; value: Json } & JsonObject;
  /** Workflow nodes: name = node id, info = { kind, scope }. */
  "node.started": { name: string } & JsonObject;
  "node.finished": { name: string; value: Json } & JsonObject;
  "node.retry": { nodeId: string; attempt: number; delayMs: number; error: RunError };
  "context.compacted": { throughTurn: number; tokensBefore: number; tokensAfter: number };
  "learning.given": { items: LearningGiven[] };
  "learning.checked": { dropAll: string | null; dropped: { path: string; reason: string }[]; surviving: string[] };
  "learning.graded": { decisions: { path: string; verdict: "keep" | "hold" | "drop"; reason: string; by: "grader" | "provenance" | "rule" }[] };
  "learning.applied": { kept: { itemId: string; path: string; version: number }[];
    held: { itemId: string; path: string; version: number }[];
    /** Items not written because they changed or were retired after this run checked them. Absent in records written by older versions. */
    conflicts?: { path: string; reason: string }[] };
  "learning.skipped": { reason: string };
  "learning.promotion": { itemId: string; outcome: "kept" | "rejected"; workflow: string | null; problems: string[] };
  "run.output": { output: Json };
  /** A message that was applied but that the driver never took before the run recorded its output. */
  "message.undelivered": { commandId: string; reason: string };
  "run.waiting": { pendingIds: string[] };
  "run.paused": { commandId: string | null };
  "run.released": { reason: string };
  "run.completed": { output: Json };
  "run.failed": { error: RunError };
  "run.cancelled": { reason: string | null };
}
export type JournalType = keyof JournalDataMap;

/** The record's data typed by its type, or null when record.type !== type. */
export function dataOf<K extends JournalType>(record: JournalRecord, type: K): JournalDataMap[K] | null {
  if (record.type !== type) return null;
  return record.data as unknown as JournalDataMap[K];
}

/** `fields`: the declared specification the record's data is redacted by (NewJournalRecord.fields); set only when given. */
export function newRecord<K extends JournalType>(type: K, data: JournalDataMap[K], key?: string, fields?: ObjectSpec): NewJournalRecord {
  const record: NewJournalRecord = { type, data: data as unknown as JsonObject };
  if (key !== undefined) record.key = key;
  if (fields !== undefined) record.fields = fields;
  return record;
}
