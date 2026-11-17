/**
 * Turns the commands people sent to a run into one commit batch (plan 3.5): command.applied / command.rejected
 * records in arrival order, pending resolutions, limit changes, and the commands marked consumed.
 */
import type { JsonObject } from "../core/json.ts";
import type { CommandRecord, CommitBatch, NewJournalRecord, PendingKind, RunCommand, RunLimits } from "../store/types.ts";
import { newRecord } from "./journal-types.ts";
import { mergeLimits } from "./budget.ts";
import { pendingExpiry, type PendingEntry, type ReplayState } from "./state.ts";

/** Reason of the command.rejected record of a message that arrives after the run recorded its output. */
export const MESSAGE_TOO_LATE = "the run had already finished its work; the message was not delivered";

/** Reason of the message.undelivered record of a message that was applied but never taken by the driver. */
export const MESSAGE_UNDELIVERED = "the run finished before the message could be delivered";

const LIMIT_KINDS: readonly PendingKind[] = ["spend_cap", "tool_budget", "turn_limit"];

export interface CommandPlan {
  batch: CommitBatch;
  /** Commands applied (not rejected), in order. */
  applied: RunCommand[];
}

function expectedKind(command: RunCommand): PendingKind | null {
  switch (command.type) {
    case "answer":
      return "question";
    case "approve":
    case "deny":
      return "approval";
    case "resolve_interrupted":
      return "interrupted";
    default:
      return null;
  }
}

function resolutionFor(command: RunCommand): JsonObject {
  switch (command.type) {
    case "answer":
      return { answer: command.answer };
    case "approve":
      return { decision: "approve", always: command.always === true, reason: null };
    case "deny":
      return { decision: "deny", always: false, reason: command.reason ?? null };
    case "resolve_interrupted":
      return { action: command.action, result: command.result ?? null };
    default:
      return {};
  }
}

/**
 * Commands not yet applied (by id), planned against the current state. Returns null when there is nothing to do.
 * An `approve` with `always: true` also resolves, with the same resolution and command id, every other open
 * approval pending of the same tool (`detail.tool`) that had not expired when the command was created; a `deny`
 * for one of them that comes later is then rejected as already resolved, and one that came earlier wins.
 * A message planned after the run recorded its output is rejected with MESSAGE_TOO_LATE: no driver will read it.
 * A command that names a pending with a finite `detail.expiresAt` and was created at or after that instant is
 * rejected (`pending <id> expired at <ISO time>`); one created before it is applied however late it is planned.
 */
export function planCommands(state: ReplayState, commands: readonly CommandRecord[]): CommandPlan | null {
  const todo = commands.filter((c) => !state.appliedCommands.has(c.id));
  if (todo.length === 0) return null;
  const records: NewJournalRecord[] = [];
  const resolvePendings: { id: string; resolution: JsonObject }[] = [];
  const resolvedHere = new Set<string>();
  const applied: RunCommand[] = [];
  let limits: RunLimits | null = null;

  const isOpen = (pending: PendingEntry): boolean => pending.status === "open" && !resolvedHere.has(pending.id);
  const resolve = (pending: PendingEntry, resolution: JsonObject, commandId: string): void => {
    resolvedHere.add(pending.id);
    resolvePendings.push({ id: pending.id, resolution });
    records.push(newRecord("pending.resolved", { pendingId: pending.id, kind: pending.kind, resolution, commandId }, pending.stepKey));
  };
  const reject = (record: CommandRecord, reason: string): void => {
    records.push(newRecord("command.rejected", { commandId: record.id, command: record.command, reason }));
  };

  for (const record of todo) {
    const command = record.command;
    const kind = expectedKind(command);
    if (kind !== null && "pendingId" in command) {
      const pending = state.pendings.get(command.pendingId);
      if (pending === undefined) {
        reject(record, `pending ${command.pendingId} does not belong to this run`);
        continue;
      }
      if (!isOpen(pending)) {
        reject(record, `pending ${command.pendingId} is already resolved`);
        continue;
      }
      // An expired pending stays open here: the engine closes it (expirePendings) as expired, never as answered.
      const expiresAt = pendingExpiry(pending);
      if (expiresAt !== null && record.createdAt >= expiresAt) {
        reject(record, `pending ${command.pendingId} expired at ${new Date(expiresAt).toISOString()}`);
        continue;
      }
      if (pending.kind !== kind) {
        reject(record, `pending ${command.pendingId} has kind ${pending.kind}; this command resolves ${kind} pendings`);
        continue;
      }
      records.push(newRecord("command.applied", { commandId: record.id, command }));
      const resolution = resolutionFor(command);
      resolve(pending, resolution, record.id);
      // Approve always: every other approval of the same tool still open, and not expired when the command was
      // created, is approved by the same command in the same commit, so none of them is left open while its call
      // runs. One a deny planned earlier resolved stays denied.
      const tool = pending.detail["tool"];
      if (command.type === "approve" && command.always === true && typeof tool === "string") {
        for (const other of state.pendings.values()) {
          if (other.kind !== "approval" || other.detail["tool"] !== tool || !isOpen(other)) continue;
          const at = pendingExpiry(other);
          if (at !== null && record.createdAt >= at) continue;
          resolve(other, resolution, record.id);
        }
      }
      applied.push(command);
      continue;
    }
    if (command.type === "limits") {
      const merged = mergeLimits(limits ?? state.limits, command.limits ?? {});
      if ("error" in merged) {
        reject(record, merged.error);
        continue;
      }
      limits = merged.limits;
      records.push(newRecord("command.applied", { commandId: record.id, command }));
      records.push(newRecord("limits.changed", { limits: merged.limits }));
      for (const pending of state.pendings.values()) {
        if (LIMIT_KINDS.includes(pending.kind) && isOpen(pending)) {
          resolve(pending, { limits: merged.limits as unknown as JsonObject }, record.id);
        }
      }
      applied.push(command);
      continue;
    }
    if (command.type === "message" && state.output !== null) {
      reject(record, MESSAGE_TOO_LATE);
      continue;
    }
    if (command.type === "message" || command.type === "cancel" || command.type === "pause" || command.type === "resume") {
      records.push(newRecord("command.applied", { commandId: record.id, command }));
      applied.push(command);
      continue;
    }
    reject(record, `unknown command type ${JSON.stringify((command as { type: unknown }).type)}`);
  }

  const batch: CommitBatch = { records, consumeCommands: todo.map((c) => c.id) };
  if (resolvePendings.length > 0) batch.resolvePendings = resolvePendings;
  if (limits !== null) batch.setLimits = limits;
  return { batch, applied };
}
