import { errorInfo, isRunwrightError } from "../core/errors.ts";
import type { JsonObject } from "../core/json.ts";
import { formatCost } from "../models/prices.ts";
import type { JournalRecord, PendingRecord, RunRecord } from "../store/types.ts";

/** Columns padded to the widest cell; the last column is not padded. */
export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header) => header.length);
  for (const row of rows) {
    for (let i = 0; i < widths.length; i += 1) widths[i] = Math.max(widths[i] as number, (row[i] ?? "").length);
  }
  const line = (cells: readonly string[]): string =>
    cells.map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join("  ").trimEnd();
  const lines = [line(headers)];
  for (const row of rows) lines.push(line(row));
  return lines.join("\n");
}

/** "label: value" lines with the values aligned; undefined values are left out. */
export function labelled(pairs: readonly (readonly [string, string | undefined])[]): string {
  const present = pairs.filter((pair): pair is readonly [string, string] => pair[1] !== undefined);
  let width = 0;
  for (const [label] of present) width = Math.max(width, label.length + 1);
  return present.map(([label, value]) => `${`${label}:`.padEnd(width)}  ${value}`).join("\n");
}

export function time(ms: number | null | undefined): string {
  return ms === null || ms === undefined ? "-" : new Date(ms).toISOString();
}

/** One line, at most `max` characters, with an ellipsis when cut. */
export function short(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function runCost(run: RunRecord): string {
  return formatCost(run.usage.costMicros, run.usage.costUnknown);
}

export function pendingLine(pending: PendingRecord): string {
  return `${pending.kind}  ${pending.id}  ${pending.title}`;
}

export function runSummary(run: RunRecord, pendings: readonly PendingRecord[]): string {
  const u = run.usage;
  const lines = [labelled([
    ["Run", run.id],
    ["Agent", `${run.agentId} (revision ${run.revision})`],
    ["Status", run.status],
    ["Message", run.input.message === "" ? undefined : short(run.input.message)],
    ["Cost", runCost(run)],
    ["Tokens", `${u.inputTokens} in, ${u.outputTokens} out`],
    ["Tool calls", String(u.toolCalls)],
    ["Turns", String(u.turns)],
    ["Created", time(run.createdAt)],
    ["Finished", run.finishedAt === null ? undefined : time(run.finishedAt)],
    ["Error", run.error === null ? undefined : `${run.error.message} (${run.error.code})`],
    ["Output", run.output === null ? undefined : short(typeof run.output === "string" ? run.output : JSON.stringify(run.output), 200)],
  ])];
  if (pendings.length > 0) {
    lines.push("Needs you:");
    for (const p of pendings) lines.push(`  ${pendingLine(p)}`);
  }
  return lines.join("\n");
}

function field(data: JsonObject, ...path: string[]): unknown {
  let current: unknown = data;
  for (const key of path) {
    if (current === null || typeof current !== "object" || Array.isArray(current) || !Object.hasOwn(current, key)) return undefined;
    current = (current as JsonObject)[key];
  }
  return current;
}

function text(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

/** A short human summary of a journal record's data: the most telling field, else compact JSON. */
function recordSummary(record: JournalRecord): string {
  const d = record.data;
  const picked =
    text(field(d, "pending", "title")) ??
    text(field(d, "error", "message")) ??
    (text(field(d, "tool")) !== undefined ? `${text(field(d, "tool"))}${text(field(d, "outcome")) === undefined ? "" : ` ${text(field(d, "outcome"))}`}` : undefined) ??
    text(field(d, "text")) ??
    text(field(d, "command", "type")) ??
    text(field(d, "reason"));
  return short(picked ?? JSON.stringify(d));
}

export function timelineLine(record: JournalRecord): string {
  return `${record.seq}  ${record.type}  ${record.key ?? "-"}  ${recordSummary(record)}`;
}

/** The error for people (`error: message (code)`) and for programs (`{"error": {code, message}}`). */
export function describeError(error: unknown): { code: string; message: string; details: JsonObject | undefined } {
  const { code, message } = errorInfo(error);
  return { code, message, details: isRunwrightError(error) ? error.details : undefined };
}

/** Extra lines for an error's details that people need, such as workflow problems. */
export function errorDetailLines(details: JsonObject | undefined): string[] {
  const problems = details?.["problems"];
  if (!Array.isArray(problems)) return [];
  return problems.map((problem) => {
    const p = (problem ?? {}) as { severity?: unknown; path?: unknown; code?: unknown; message?: unknown };
    return `  ${text(p.severity) ?? "error"} ${text(p.path) ?? "$"} ${text(p.code) === undefined ? "" : `${text(p.code)}: `}${text(p.message) ?? ""}`;
  });
}
