/**
 * The replay index: a reducer over a run's journal. Feeding it every record of a run, in seq order, yields the
 * state the session needs to resume the run (plan 3.1): the latest record of each type per step key, the
 * pendings, effective limits, usage totals, counters, the "approve always" set, messages not yet handed to the
 * driver, applied command ids, cancel/pause flags and the driver's output when it was recorded.
 *
 * The reducer does no I/O and reads no clock: the same records always give the same state. Usage totals saturate
 * (plan C9): every counter is an integer from 0 to Number.MAX_SAFE_INTEGER, and an addition that would pass it
 * yields exactly that value, as the store's own counters do.
 */
import type { Json, JsonObject } from "../core/json.ts";
import type { JournalRecord, PendingKind, RunLimits, RunUsage } from "../store/types.ts";
import type { Usage } from "../models/types.ts";
import type { InboxMessage } from "./types.ts";
import { dataOf } from "./journal-types.ts";
import { clampTotal, saturatingAdd } from "./budget.ts";

export interface PendingEntry {
  id: string; kind: PendingKind; stepKey: string; title: string; detail: JsonObject;
  status: "open" | "resolved"; resolution: JsonObject | null;
}

export interface KeyState {
  /** The latest record of each type written under this key. */
  readonly latest: Map<string, JournalRecord>;
  /**
   * The latest model.* record (started, invalid, finished, interrupted, failed, and retry records that carry
   * `billing`; a retry record written by older versions came from inside one call and is ignored).
   */
  lastModel: JournalRecord | null;
  /** The latest tool.* record (started, finished, interrupted). */
  lastTool: JournalRecord | null;
}

export interface ReplayState {
  readonly records: JournalRecord[];
  readonly keys: Map<string, KeyState>;
  readonly pendings: Map<string, PendingEntry>;
  /** `${stepKey}\u0000${kind}` → pending ids, oldest first. */
  readonly pendingsByKeyKind: Map<string, string[]>;
  limits: RunLimits;
  readonly usage: RunUsage;
  readonly approvedAlways: Set<string>;
  /** Applied message commands not yet taken by ctx.inbox, in arrival order. */
  messages: InboxMessage[];
  readonly appliedCommands: Set<string>;
  cancelled: { reason: string | null } | null;
  paused: { commandId: string } | null;
  output: { output: Json } | null;
  /**
   * The highest `seq` of a `tool.finished` record whose step key has a `tool.started` with an `effect` other than
   * "read" (a missing effect counts as write), whatever its outcome; 0 when there is none. A finish with no
   * `tool.started` under its key (denied, unknown tool, invalid arguments) does not count. Rule R reads it: an
   * unfinished idempotent write runs again by itself only when this is lower than its own latest `tool.started`.
   */
  lastWriteFinishedSeq: number;
}

const MODEL_TYPES = new Set(["model.started", "model.invalid", "model.finished", "model.interrupted", "model.failed"]);
const TOOL_TYPES = new Set(["tool.started", "tool.finished", "tool.interrupted"]);

export function createReplayState(limits: RunLimits): ReplayState {
  return {
    records: [],
    keys: new Map(),
    pendings: new Map(),
    pendingsByKeyKind: new Map(),
    limits: { ...limits },
    usage: {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      costMicros: 0, costUnknown: false, toolCalls: 0, turns: 0,
    },
    approvedAlways: new Set(),
    messages: [],
    appliedCommands: new Set(),
    cancelled: null,
    paused: null,
    output: null,
    lastWriteFinishedSeq: 0,
  };
}

function keyState(state: ReplayState, key: string): KeyState {
  let entry = state.keys.get(key);
  if (entry === undefined) {
    entry = { latest: new Map(), lastModel: null, lastTool: null };
    state.keys.set(key, entry);
  }
  return entry;
}

function pendingSlot(stepKey: string, kind: PendingKind): string {
  return `${stepKey}\u0000${kind}`;
}

/** Applies one record (the next in seq order) to the state. */
export function applyRecord(state: ReplayState, record: JournalRecord): void {
  state.records.push(record);
  if (record.key !== null) {
    const entry = keyState(state, record.key);
    entry.latest.set(record.type, record);
    if (MODEL_TYPES.has(record.type) || (record.type === "model.retry" && record.data["billing"] !== undefined)) entry.lastModel = record;
    if (TOOL_TYPES.has(record.type)) entry.lastTool = record;
  }
  const usage = state.usage;
  switch (record.type) {
    case "run.created": {
      const data = dataOf(record, "run.created");
      if (data !== null) state.limits = { ...data.limits };
      return;
    }
    case "limits.changed": {
      const data = dataOf(record, "limits.changed");
      if (data !== null) state.limits = { ...data.limits };
      return;
    }
    case "command.applied": {
      const data = dataOf(record, "command.applied");
      if (data === null) return;
      state.appliedCommands.add(data.commandId);
      const command = data.command;
      if (command.type === "message") {
        state.messages.push({ commandId: data.commandId, text: command.text, at: record.ts });
      } else if (command.type === "cancel") {
        state.cancelled = { reason: command.reason };
      } else if (command.type === "resolve_interrupted" && command.action === "cancel") {
        state.cancelled = { reason: "cancelled while resolving an interrupted tool call" };
      } else if (command.type === "pause") {
        state.paused = { commandId: data.commandId };
      } else if (command.type === "resume") {
        state.paused = null;
      }
      return;
    }
    case "command.rejected": {
      const data = dataOf(record, "command.rejected");
      if (data !== null) state.appliedCommands.add(data.commandId);
      return;
    }
    case "inbox.taken": {
      const data = dataOf(record, "inbox.taken");
      if (data === null) return;
      const taken = new Set(data.messages.map((m) => m.commandId));
      state.messages = state.messages.filter((m) => !taken.has(m.commandId));
      return;
    }
    case "message.undelivered": {
      const data = dataOf(record, "message.undelivered");
      if (data !== null) state.messages = state.messages.filter((m) => m.commandId !== data.commandId);
      return;
    }
    case "pending.opened": {
      const data = dataOf(record, "pending.opened");
      if (data === null) return;
      const p = data.pending;
      state.pendings.set(p.id, {
        id: p.id, kind: p.kind, stepKey: p.stepKey, title: p.title, detail: p.detail, status: "open", resolution: null,
      });
      const slot = pendingSlot(p.stepKey, p.kind);
      const list = state.pendingsByKeyKind.get(slot);
      if (list === undefined) state.pendingsByKeyKind.set(slot, [p.id]);
      else list.push(p.id);
      return;
    }
    case "pending.resolved": {
      const data = dataOf(record, "pending.resolved");
      if (data === null) return;
      const entry = state.pendings.get(data.pendingId);
      if (entry === undefined) return;
      entry.status = "resolved";
      entry.resolution = data.resolution;
      if (entry.kind === "approval" && data.resolution["decision"] === "approve" && data.resolution["always"] === true) {
        const tool = entry.detail["tool"];
        if (typeof tool === "string") state.approvedAlways.add(tool);
      }
      return;
    }
    case "model.invalid": {
      // The invalid first reply of a structured-output step is billed; its turn is counted when the step finishes.
      const data = dataOf(record, "model.invalid");
      if (data !== null) addBilled(usage, data.usage, data.costMicros);
      return;
    }
    case "model.finished": {
      const data = dataOf(record, "model.finished");
      if (data === null) return;
      addBilled(usage, data.usage, data.costMicros);
      const started = record.key === null ? undefined : state.keys.get(record.key)?.latest.get("model.started");
      const startedData = started === undefined ? null : dataOf(started, "model.started");
      if (startedData?.countsAsTurn === true) usage.turns = saturatingAdd(usage.turns, 1);
      return;
    }
    case "model.retry": {
      // A failed attempt whose billing is uncertain is charged its worst case, like an interrupted call.
      const data = dataOf(record, "model.retry");
      if (data !== null && data.billing === "unknown") addAssumed(state, record.key, data.assumedCostMicros ?? null);
      return;
    }
    case "model.failed": {
      // A failed step whose calls were billed (e.g. structured output still invalid after the repair) carries them.
      const billed = record.data["usage"];
      if (billed !== undefined && billed !== null && typeof billed === "object" && !Array.isArray(billed)) {
        const tokens = (name: string): number => {
          const v = (billed as JsonObject)[name];
          return typeof v === "number" ? clampTotal(v) : 0;
        };
        usage.inputTokens = saturatingAdd(usage.inputTokens, tokens("inputTokens"));
        usage.outputTokens = saturatingAdd(usage.outputTokens, tokens("outputTokens"));
        usage.cacheReadTokens = saturatingAdd(usage.cacheReadTokens, tokens("cacheReadTokens"));
        usage.cacheWriteTokens = saturatingAdd(usage.cacheWriteTokens, tokens("cacheWriteTokens"));
        const cost = record.data["costMicros"];
        if (typeof cost === "number") usage.costMicros = saturatingAdd(usage.costMicros, clampTotal(cost));
        else usage.costUnknown = true;
      }
      // The last attempt failed with uncertain billing: its worst case was charged as an assumed cost.
      if (Object.hasOwn(record.data, "assumedCostMicros")) {
        const assumed = record.data["assumedCostMicros"];
        addAssumed(state, record.key, typeof assumed === "number" ? assumed : null);
      }
      return;
    }
    case "model.interrupted": {
      const data = dataOf(record, "model.interrupted");
      if (data !== null) addAssumed(state, record.key, data.assumedCostMicros);
      return;
    }
    case "tool.started": {
      const data = dataOf(record, "tool.started");
      if (data !== null && data.attempt === 1) usage.toolCalls = saturatingAdd(usage.toolCalls, 1);
      return;
    }
    case "tool.finished": {
      const started = record.key === null ? undefined : state.keys.get(record.key)?.latest.get("tool.started");
      if (started !== undefined && started.data["effect"] !== "read" && record.seq > state.lastWriteFinishedSeq) {
        state.lastWriteFinishedSeq = record.seq;
      }
      return;
    }
    case "run.output": {
      const data = dataOf(record, "run.output");
      if (data !== null) state.output = { output: data.output };
      return;
    }
    default:
      return;
  }
}

function addBilled(usage: RunUsage, billed: Usage, costMicros: number | null): void {
  usage.inputTokens = saturatingAdd(usage.inputTokens, clampTotal(billed.inputTokens));
  usage.outputTokens = saturatingAdd(usage.outputTokens, clampTotal(billed.outputTokens));
  usage.cacheReadTokens = saturatingAdd(usage.cacheReadTokens, clampTotal(billed.cacheReadTokens));
  usage.cacheWriteTokens = saturatingAdd(usage.cacheWriteTokens, clampTotal(billed.cacheWriteTokens));
  if (costMicros === null) usage.costUnknown = true;
  else usage.costMicros = saturatingAdd(usage.costMicros, clampTotal(costMicros));
}

/** Adds the assumed charge of the latest model.started under `key`: its token estimates and `costMicros` (null = unknown). */
function addAssumed(state: ReplayState, key: string | null, costMicros: number | null): void {
  const assumed = assumedUsageFor(state, key);
  state.usage.inputTokens = saturatingAdd(state.usage.inputTokens, clampTotal(assumed.inputTokens));
  state.usage.outputTokens = saturatingAdd(state.usage.outputTokens, clampTotal(assumed.outputTokens));
  if (costMicros === null) state.usage.costUnknown = true;
  else state.usage.costMicros = saturatingAdd(state.usage.costMicros, clampTotal(costMicros));
}

/** The token estimates of the latest model.started under `key`, charged when that attempt is interrupted or fails uncertainly. */
function assumedUsageFor(state: ReplayState, key: string | null): { inputTokens: number; outputTokens: number } {
  const started = key === null ? undefined : state.keys.get(key)?.latest.get("model.started");
  const data = started === undefined ? null : dataOf(started, "model.started");
  if (data === null) return { inputTokens: 0, outputTokens: 0 };
  return { inputTokens: data.inputTokensEstimate, outputTokens: data.maxOutputTokens };
}

/** Builds the state from a whole journal. */
export function replayJournal(records: readonly JournalRecord[], initialLimits: RunLimits): ReplayState {
  const state = createReplayState(initialLimits);
  for (const record of records) applyRecord(state, record);
  return state;
}

export function latestRecord(state: ReplayState, key: string, type: string): JournalRecord | null {
  return state.keys.get(key)?.latest.get(type) ?? null;
}

export function lastModelRecord(state: ReplayState, key: string): JournalRecord | null {
  return state.keys.get(key)?.lastModel ?? null;
}

export function lastToolRecord(state: ReplayState, key: string): JournalRecord | null {
  return state.keys.get(key)?.lastTool ?? null;
}

/** The newest pending of `kind` opened at `stepKey`, or null. */
export function latestPending(state: ReplayState, stepKey: string, kind: PendingKind): PendingEntry | null {
  const ids = state.pendingsByKeyKind.get(pendingSlot(stepKey, kind));
  if (ids === undefined || ids.length === 0) return null;
  return state.pendings.get(ids[ids.length - 1] as string) ?? null;
}

/**
 * The instant (ms since epoch) at which a pending expires: `detail.expiresAt` when it is a finite number, else
 * null (no expiry; anything else in that field is ignored).
 */
export function pendingExpiry(pending: { detail: JsonObject }): number | null {
  const at = pending.detail["expiresAt"];
  return typeof at === "number" && Number.isFinite(at) ? at : null;
}

export function openPendings(state: ReplayState): PendingEntry[] {
  return [...state.pendings.values()].filter((p) => p.status === "open");
}
