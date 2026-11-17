import { writeFile } from "node:fs/promises";
import type { RunLimitsInput, RunwrightClient } from "../../client/index.ts";
import type { Json, JsonObject } from "../../core/json.ts";
import type { JournalRecord, PendingKind, PendingRecord, RunRecord, RunStatus } from "../../store/types.ts";
import { RUN_STATUSES } from "../../store/state-machine.ts";
import { boolFlag, decimalFlag, decodeUtf8, dollarsToMicros, intFlag, MAX_TIMER_SECONDS, readJsonArgument, stringFlag, UsageError } from "../args.ts";
import { arg, type CommandContext, type CommandSpec } from "../context.ts";
import { describeError, pendingLine, runCost, runSummary, table, time, timelineLine } from "../output.ts";

/** Exit code for a run that stopped moving: 0 completed, 1 failed or cancelled, 8 waiting on a person or paused. */
function exitCodeFor(status: RunStatus): number {
  if (status === "completed") return 0;
  if (status === "waiting" || status === "paused") return 8;
  return 1;
}

function waitText(run: RunRecord, pendings: readonly PendingRecord[]): string {
  const lines = [`Run ${run.id} ${run.status}`];
  if (run.status === "failed" && run.error !== null) lines.push(`Error: ${run.error.message} (${run.error.code})`);
  if (run.status === "waiting" || run.status === "paused") {
    if (pendings.length > 0) {
      lines.push("Needs you:");
      for (const p of pendings) lines.push(`  ${pendingLine(p)}`);
    }
    else if (run.status === "paused") lines.push("Resume it with: runwright runs resume " + run.id);
  }
  lines.push(`Cost: ${runCost(run)}`);
  return lines.join("\n");
}

/** Waits for the run to stop moving and prints the result; returns the exit code. */
async function waitAndReport(ctx: CommandContext, runId: string, extra: { created?: boolean; prefix?: string }): Promise<number> {
  const seconds = decimalFlag(ctx.values, "timeout", ctx.name, MAX_TIMER_SECONDS);
  const client = await ctx.client();
  const result = await client.waitForRun(runId, seconds === undefined ? {} : { timeoutMs: Math.round(seconds * 1000) });
  const body = extra.created === undefined ? result : { ...result, created: extra.created };
  ctx.print(body, () => (extra.prefix === undefined ? "" : `${extra.prefix}\n`) + waitText(result.run, result.pendings));
  return exitCodeFor(result.run.status);
}

function limitFlags(ctx: CommandContext): RunLimitsInput {
  const limits: RunLimitsInput = {};
  const cost = stringFlag(ctx.values, "max-cost");
  if (cost !== undefined) limits.maxCostMicros = dollarsToMicros(cost, "--max-cost", ctx.name);
  const toolCalls = intFlag(ctx.values, "max-tool-calls", ctx.name, 0, Number.MAX_SAFE_INTEGER);
  if (toolCalls !== undefined) limits.maxToolCalls = toolCalls;
  const turns = intFlag(ctx.values, "max-turns", ctx.name, 0, Number.MAX_SAFE_INTEGER);
  if (turns !== undefined) limits.maxTurns = turns;
  return limits;
}

/**
 * The pending a verb acts on, always checked against the run that was named: with --pending, that pending, which
 * must belong to the run, be open and be of the verb's kind (a UsageError naming what was found otherwise);
 * without it, the run's only open pending of that kind. An unknown run or pending is the API's not_found. The
 * server checks again that the pending is open and of the kind when the command arrives.
 */
async function pickPending(ctx: CommandContext, kind: PendingKind): Promise<string> {
  const runId = await ctx.runId(arg(ctx, 0));
  const client = await ctx.client();
  const { pendings } = await client.getRun(runId);
  const given = stringFlag(ctx.values, "pending");
  if (given !== undefined) {
    const pending = await client.getPending(given);
    if (pending.runId !== runId) throw new UsageError(`pending ${given} belongs to run ${pending.runId}, not ${runId}`, ctx.name);
    if (pending.status !== "open") throw new UsageError(`pending ${given} is already resolved`, ctx.name);
    if (pending.kind !== kind) throw new UsageError(`pending ${given} is a ${pending.kind}, not a ${kind}`, ctx.name);
    return pending.id;
  }
  const matching = pendings.filter((p) => p.kind === kind && p.status === "open");
  if (matching.length === 1) return (matching[0] as PendingRecord).id;
  if (matching.length === 0) throw new UsageError(`run ${runId} has no open ${kind} pending`, ctx.name);
  throw new UsageError(
    `run ${runId} has ${matching.length} open ${kind} pendings; choose one with --pending:\n${matching.map((p) => `  ${pendingLine(p)}`).join("\n")}`,
    ctx.name,
  );
}

/**
 * The text of a file when its bytes are valid UTF-8, else null. A leading byte order mark is kept, so the text
 * re-encodes to exactly the bytes the document reports.
 */
function utf8Text(bytes: Uint8Array): string | null {
  try {
    return decodeUtf8(bytes, "the file");
  } catch {
    return null;
  }
}

function commandDone(ctx: CommandContext, command: { id: string; runId: string; command: { type: string } }, what: string): number {
  ctx.print({ command }, () => `${what} (command ${command.id})`);
  return 0;
}

/** Journal records per request of `runs timeline` (the API's largest page). */
const TIMELINE_PAGE = 1000;

/**
 * Where `runs timeline` writes, one page at a time, so it never holds more than one page: `records` prints the
 * records it is given at once, `end` finishes the output, and `failed` reports an error after the output started
 * (`started`) in the same format and returns the exit code. An error before anything was printed is left to the
 * usual error output.
 */
interface TimelineOutput {
  records(records: readonly JournalRecord[]): void;
  end(archived: boolean, event?: unknown, human?: string): void;
  started(): boolean;
  failed(error: unknown): number;
}

function errorBody(error: unknown): { code: string; message: string; details?: JsonObject } {
  const { code, message, details } = describeError(error);
  return details === undefined ? { code, message } : { code, message, details };
}

/** Human text: one line per record; `No records.` or the archived notice at the end. */
function textOutput(ctx: CommandContext): TimelineOutput {
  let count = 0;
  return {
    records(records) {
      if (records.length === 0) return;
      let text = "";
      for (const record of records) text += `${timelineLine(record)}\n`;
      count += records.length;
      ctx.raw(text);
    },
    end(archived) {
      if (archived) ctx.raw("The journal of this run was archived.\n");
      else if (count === 0) ctx.raw("No records.\n");
    },
    started: () => count > 0,
    failed(error) {
      throw error;
    },
  };
}

/**
 * One JSON document, `{"records": [...], "archived": bool}`, written as it arrives: the opening with the first
 * page, the records separated by commas, the closing at the end. A failure after the opening closes the document
 * with an `error` member, so the output stays one JSON document.
 */
function documentOutput(ctx: CommandContext): TimelineOutput {
  let opened = false;
  let count = 0;
  const close = (archived: boolean, error?: unknown): void => {
    const tail = error === undefined ? "" : `, "error": ${JSON.stringify(errorBody(error))}`;
    ctx.raw(`${opened ? "" : '{"records": ['}${count === 0 ? "" : "\n"}], "archived": ${archived}${tail}}\n`);
  };
  return {
    records(records) {
      let text = opened ? "" : '{"records": [';
      opened = true;
      for (const record of records) {
        text += `${count === 0 ? "\n" : ",\n"}${JSON.stringify(record)}`;
        count += 1;
      }
      ctx.raw(text);
    },
    end(archived) {
      close(archived);
    },
    started: () => opened,
    failed(error) {
      close(false, error);
      return 1;
    },
  };
}

/** `--follow`: one line per record (a JSON document per line, or text), the end event, and an error as one more line. */
function followOutput(ctx: CommandContext): TimelineOutput {
  let count = 0;
  const line = (value: unknown, human: string): void => ctx.raw(ctx.json ? `${JSON.stringify(value)}\n` : `${human}\n`);
  return {
    records(records) {
      if (records.length === 0) return;
      let text = "";
      for (const record of records) text += ctx.json ? `${JSON.stringify(record)}\n` : `${timelineLine(record)}\n`;
      count += records.length;
      ctx.raw(text);
    },
    end(_archived, event, human) {
      if (event !== undefined) line(event, human ?? "");
    },
    started: () => count > 0,
    failed(error) {
      if (!ctx.json) throw error;
      // The stream is one JSON document per line, so a failure after it started is one more line.
      ctx.raw(`${JSON.stringify({ error: errorBody(error) })}\n`);
      return 1;
    },
  };
}

const STATUSES = new Set<string>(RUN_STATUSES);

export const runCommands: CommandSpec[] = [
  {
    name: "runs start", summary: "Start a run of an agent", args: "<agentId>",
    flags: {
      message: { value: "text", description: "the first message" },
      data: { value: "json|@file", description: "input data as JSON text or @file" },
      "max-cost": { value: "usd", description: "spend cap in US dollars, e.g. 0.50" },
      "max-tool-calls": { value: "n", description: "tool-call budget" },
      "max-turns": { value: "n", description: "turn limit" },
      "idempotency-key": { value: "key", description: "the same key returns the same run" },
      revision: { value: "n", description: "run this revision of the agent (default: the current one)" },
      wait: { description: "wait for the run like `runs wait` and exit the same way" },
      timeout: { value: "sec", description: "with --wait: give up after this many seconds" },
    },
    async handler(ctx) {
      if (stringFlag(ctx.values, "timeout") !== undefined && !boolFlag(ctx.values, "wait")) {
        throw new UsageError("--timeout needs --wait", ctx.name);
      }
      // A bad --timeout is a usage error before the run is started, not after.
      decimalFlag(ctx.values, "timeout", ctx.name, MAX_TIMER_SECONDS);
      const input: Parameters<RunwrightClient["startRun"]>[0] = { agentId: arg(ctx, 0) };
      const message = stringFlag(ctx.values, "message");
      if (message !== undefined) input.message = message;
      const data = stringFlag(ctx.values, "data");
      if (data !== undefined) input.data = await readJsonArgument(data, "--data", ctx.name);
      const limits = limitFlags(ctx);
      if (Object.keys(limits).length > 0) input.limits = limits;
      const key = stringFlag(ctx.values, "idempotency-key");
      if (key !== undefined) input.idempotencyKey = key;
      const revision = intFlag(ctx.values, "revision", ctx.name, 1, Number.MAX_SAFE_INTEGER);
      if (revision !== undefined) input.revision = revision;
      const { run, created } = await (await ctx.client()).startRun(input);
      const line = created ? `Started run ${run.id} (agent ${run.agentId})` : `Run ${run.id} already exists for this idempotency key (${run.status})`;
      if (boolFlag(ctx.values, "wait")) return waitAndReport(ctx, run.id, { created, prefix: line });
      ctx.print({ run, created }, () => line);
      return 0;
    },
  },
  {
    name: "runs get", summary: "Show a run and what it needs", args: "<run>", flags: {},
    async handler(ctx) {
      const result = await (await ctx.client()).getRun(await ctx.runId(arg(ctx, 0)));
      ctx.print(result, () => runSummary(result.run, result.pendings));
      return 0;
    },
  },
  {
    name: "runs list", summary: "List one page of runs, newest first (--cursor for the next page)", args: "",
    flags: {
      agent: { value: "id", description: "only this agent's runs" },
      status: { value: "a,b", description: "only these statuses" },
      trigger: { value: "id", description: "only runs started by this trigger" },
      limit: { value: "n", description: "page size (1-200, default 50)" },
      cursor: { value: "c", description: "the next page, from a previous listing" },
    },
    async handler(ctx) {
      const query: NonNullable<Parameters<RunwrightClient["listRuns"]>[0]> = {};
      const agent = stringFlag(ctx.values, "agent");
      if (agent !== undefined) query.agentId = agent;
      const status = stringFlag(ctx.values, "status");
      if (status !== undefined) {
        const statuses = status.split(",").map((s) => s.trim()).filter((s) => s !== "");
        const bad = statuses.filter((s) => !STATUSES.has(s));
        if (bad.length > 0) throw new UsageError(`unknown status ${bad.join(", ")} (one of ${RUN_STATUSES.join(", ")})`, ctx.name);
        query.status = statuses as RunStatus[];
      }
      const trigger = stringFlag(ctx.values, "trigger");
      if (trigger !== undefined) query.triggerId = trigger;
      const limit = intFlag(ctx.values, "limit", ctx.name, 1, 200);
      if (limit !== undefined) query.limit = limit;
      const cursor = stringFlag(ctx.values, "cursor");
      if (cursor !== undefined) query.cursor = cursor;
      const result = await (await ctx.client()).listRuns(query);
      ctx.print(result, () => {
        if (result.runs.length === 0) return "No runs.";
        const rows = result.runs.map((r) => [r.id, r.agentId, r.status, runCost(r), time(r.createdAt)]);
        const text = table(["RUN", "AGENT", "STATUS", "COST", "CREATED"], rows);
        return result.nextCursor === null ? text : `${text}\nMore: --cursor ${result.nextCursor}`;
      });
      return 0;
    },
  },
  {
    name: "runs wait", summary: "Wait until a run completes, fails or needs a person (exit 0, 1 or 8)", args: "<run>",
    flags: { timeout: { value: "sec", description: "give up after this many seconds (exit 1)" } },
    async handler(ctx) {
      return waitAndReport(ctx, await ctx.runId(arg(ctx, 0)), {});
    },
  },
  {
    name: "runs message", summary: "Send a message to a run", args: "<run> <text>", flags: {},
    async handler(ctx) {
      const runId = await ctx.runId(arg(ctx, 0));
      return commandDone(ctx, await (await ctx.client()).sendMessage(runId, arg(ctx, 1)), `Sent the message to run ${runId}`);
    },
  },
  {
    name: "runs answer", summary: "Answer a run's question", args: "<run> <text>",
    flags: { pending: { value: "id", description: "which question (default: the run's only open one)" } },
    async handler(ctx) {
      const pendingId = await pickPending(ctx, "question");
      return commandDone(ctx, await (await ctx.client()).answer(pendingId, arg(ctx, 1)), `Answered ${pendingId}`);
    },
  },
  {
    name: "runs approve", summary: "Approve a run's tool call", args: "<run>",
    flags: {
      pending: { value: "id", description: "which approval (default: the run's only open one)" },
      always: { description: "also approve this tool's other waiting calls in the run and its later calls" },
    },
    async handler(ctx) {
      const pendingId = await pickPending(ctx, "approval");
      const always = boolFlag(ctx.values, "always");
      const command = await (await ctx.client()).approve(pendingId, always ? { always: true } : {});
      return commandDone(ctx, command, `Approved ${pendingId}${always ? " (always, for this run)" : ""}`);
    },
  },
  {
    name: "runs deny", summary: "Deny a run's tool call", args: "<run>",
    flags: {
      pending: { value: "id", description: "which approval (default: the run's only open one)" },
      reason: { value: "text", description: "told to the model as the tool result" },
    },
    async handler(ctx) {
      const pendingId = await pickPending(ctx, "approval");
      return commandDone(ctx, await (await ctx.client()).deny(pendingId, stringFlag(ctx.values, "reason")), `Denied ${pendingId}`);
    },
  },
  {
    name: "runs raise", summary: "Raise a run's spend cap, tool-call budget or turn limit", args: "<run>",
    flags: {
      "max-cost": { value: "usd", description: "new spend cap in US dollars" },
      "max-tool-calls": { value: "n", description: "new tool-call budget" },
      "max-turns": { value: "n", description: "new turn limit" },
      "allow-unpriced": { description: "let models with no known price run under the cap" },
    },
    async handler(ctx) {
      const limits = limitFlags(ctx);
      if (boolFlag(ctx.values, "allow-unpriced")) limits.allowUnpriced = true;
      if (Object.keys(limits).length === 0) {
        throw new UsageError("give at least one of --max-cost, --max-tool-calls, --max-turns, --allow-unpriced", ctx.name);
      }
      const runId = await ctx.runId(arg(ctx, 0));
      return commandDone(ctx, await (await ctx.client()).setLimits(runId, limits), `Raised the limits of run ${runId}`);
    },
  },
  {
    name: "runs resolve", summary: "Decide about an interrupted tool call: retry, skip or cancel", args: "<run>",
    flags: {
      action: { value: "retry|skip|cancel", description: "what to do (required)" },
      result: { value: "text", description: "with skip: the result the model sees" },
      pending: { value: "id", description: "which interrupted call (default: the run's only open one)" },
    },
    async handler(ctx) {
      const action = stringFlag(ctx.values, "action");
      if (action !== "retry" && action !== "skip" && action !== "cancel") {
        throw new UsageError("--action must be retry, skip or cancel", ctx.name);
      }
      if (action !== "skip" && stringFlag(ctx.values, "result") !== undefined) throw new UsageError("--result goes with --action skip only", ctx.name);
      const pendingId = await pickPending(ctx, "interrupted");
      const command = await (await ctx.client()).resolveInterrupted(pendingId, action, stringFlag(ctx.values, "result"));
      return commandDone(ctx, command, `Resolved ${pendingId}: ${action}`);
    },
  },
  {
    name: "runs cancel", summary: "Cancel a run", args: "<run>",
    flags: { reason: { value: "text", description: "why" } },
    async handler(ctx) {
      const runId = await ctx.runId(arg(ctx, 0));
      return commandDone(ctx, await (await ctx.client()).cancelRun(runId, stringFlag(ctx.values, "reason")), `Asked run ${runId} to cancel`);
    },
  },
  {
    name: "runs pause", summary: "Pause a run at the next step boundary", args: "<run>", flags: {},
    async handler(ctx) {
      const runId = await ctx.runId(arg(ctx, 0));
      return commandDone(ctx, await (await ctx.client()).pauseRun(runId), `Asked run ${runId} to pause`);
    },
  },
  {
    name: "runs resume", summary: "Resume a paused run", args: "<run>", flags: {},
    async handler(ctx) {
      const runId = await ctx.runId(arg(ctx, 0));
      return commandDone(ctx, await (await ctx.client()).resumeRun(runId), `Asked run ${runId} to resume`);
    },
  },
  {
    name: "runs timeline", summary: "Print a run's journal; --follow streams it until the run ends", args: "<run>",
    flags: {
      after: { value: "seq", description: "start after this record" },
      follow: { description: "keep streaming new records until the run ends" },
    },
    async handler(ctx) {
      const runId = await ctx.runId(arg(ctx, 0));
      const client = await ctx.client();
      const follow = boolFlag(ctx.values, "follow");
      let after = intFlag(ctx.values, "after", ctx.name, 0, Number.MAX_SAFE_INTEGER) ?? 0;
      const out = follow ? followOutput(ctx) : ctx.json ? documentOutput(ctx) : textOutput(ctx);
      let archived = false;
      try {
        for (;;) {
          const page = await client.timeline(runId, { after, limit: TIMELINE_PAGE });
          archived = page.archived;
          out.records(page.records);
          const last = page.records[page.records.length - 1];
          if (last !== undefined) after = last.seq;
          // A page that holds no record cannot advance, whatever nextAfter says.
          if (page.nextAfter === null || last === undefined) break;
        }
      } catch (error) {
        if (!out.started()) throw error;
        return out.failed(error);
      }
      if (!follow) {
        out.end(archived);
        return 0;
      }
      try {
        for await (const event of client.followTimeline(runId, { after })) {
          if (event.event === "delta") continue;
          if (event.event === "end") {
            const status = (event.data as { status?: Json } | null)?.status;
            out.end(false, { event: "end", data: event.data }, `-- run ${String(status ?? "ended")}`);
            break;
          }
          const record = event.data as unknown as JournalRecord | null;
          if (typeof record?.seq !== "number" || record.seq <= after) continue;
          after = record.seq;
          out.records([record]);
        }
      } catch (error) {
        if (!ctx.json) throw error;
        return out.failed(error);
      }
      return 0;
    },
  },
  {
    name: "runs files", summary: "List a run's files, or print one (or save it with --out)", args: "<run> [<path>]",
    flags: { out: { value: "file", description: "write the file's exact bytes here" } },
    async handler(ctx) {
      const runId = await ctx.runId(arg(ctx, 0));
      const client = await ctx.client();
      const path = ctx.positionals[1];
      if (path === undefined) {
        if (stringFlag(ctx.values, "out") !== undefined) throw new UsageError("--out needs a <path>", ctx.name);
        const files = await client.listFiles(runId);
        ctx.print({ files }, () => (files.length === 0 ? "No files." : table(["PATH", "SIZE", "MODIFIED"], files.map((f) => [f.path, String(f.size), time(f.modifiedAt)]))));
        return 0;
      }
      const file = await client.readFile(runId, path);
      const bytes = file.body.byteLength;
      const out = stringFlag(ctx.values, "out");
      if (out !== undefined) {
        await writeFile(out, file.body);
        ctx.print({ path, out, bytes, contentType: file.contentType }, () => `Wrote ${bytes} bytes to ${out}`);
        return 0;
      }
      const text = utf8Text(file.body);
      const document = text === null
        ? { path, contentType: file.contentType, bytes, encoding: "base64", content: Buffer.from(file.body).toString("base64") }
        : { path, contentType: file.contentType, bytes, encoding: "utf8", content: text };
      if (!ctx.json && text !== null) ctx.raw(text);
      else ctx.print(document, () => `${path}: ${bytes} bytes of binary data; save it with --out <file>`);
      return 0;
    },
  },
  {
    name: "runs learning", summary: "Show which learned items a run was given and opened", args: "<run>", flags: {},
    async handler(ctx) {
      const uses = await (await ctx.client()).runLearning(await ctx.runId(arg(ctx, 0)));
      ctx.print({ uses }, () => (uses.length === 0 ? "No learned items were given to this run." : table(
        ["ITEM", "VERSION", "MODE", "OPENED"], uses.map((u) => [u.itemId, String(u.version), u.mode, u.opened ? "yes" : "no"]),
      )));
      return 0;
    },
  },
];
