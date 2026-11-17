import type { RunwrightClient } from "../../client/index.ts";
import { isRunwrightError } from "../../core/errors.ts";
import { isJsonObject, type JsonObject } from "../../core/json.ts";
import type { PendingKind, PendingRecord, TriggerRecord } from "../../store/types.ts";
import type { TriggerInput } from "../../triggers/service.ts";
import { formatCost } from "../../models/prices.ts";
import { intFlag, readJsonArgument, readJsonFile, stringFlag, UsageError } from "../args.ts";
import { arg, type CommandContext, type CommandSpec } from "../context.ts";
import { labelled, table, time } from "../output.ts";

const PENDING_KINDS: readonly PendingKind[] = ["question", "approval", "spend_cap", "tool_budget", "turn_limit", "interrupted"];

function triggerText(trigger: TriggerRecord): string {
  return labelled([
    ["Trigger", trigger.id],
    ["Name", trigger.name],
    ["Kind", trigger.kind],
    ["Agent", trigger.agentId],
    ["Enabled", trigger.enabled ? "yes" : "no"],
    ["Schedule", trigger.cron === null ? undefined : `${trigger.cron.expression} (${trigger.cron.timeZone})`],
    ["Webhook secret", trigger.webhook === null ? undefined : trigger.webhook.secretName],
    ["Cap", trigger.limits.maxCostMicros === null ? "none" : formatCost(trigger.limits.maxCostMicros, false)],
    ["Last fired", time(trigger.lastFiredAt)],
    ["Next fire", trigger.nextFireAt === null ? undefined : time(trigger.nextFireAt)],
  ]);
}

function setEnabled(enabled: boolean): CommandSpec {
  return {
    name: `triggers ${enabled ? "enable" : "disable"}`, summary: enabled ? "Turn a trigger on" : "Turn a trigger off", args: "<id>", flags: {},
    async handler(ctx) {
      const trigger = await (await ctx.client()).updateTrigger(arg(ctx, 0), { enabled });
      ctx.print({ trigger }, () => `Trigger ${trigger.id} is ${trigger.enabled ? "enabled" : "disabled"}`);
      return 0;
    },
  };
}

/** The largest page of `pendings list` (the API's). */
const PENDING_PAGE_MAX = 200;

function pendingText(pending: PendingRecord): string {
  return `${labelled([
    ["Pending", pending.id],
    ["Kind", pending.kind],
    ["Status", pending.status],
    ["Run", pending.runId],
    ["Agent", pending.agentId],
    ["Step", pending.stepKey],
    ["Title", pending.title],
    ["Created", time(pending.createdAt)],
    ["Resolved", pending.resolvedAt === null ? undefined : time(pending.resolvedAt)],
  ])}\n${JSON.stringify(pending.detail, null, 2)}`;
}

/** A `--from` / `--to` value: `YYYY-MM-DD` (the start of that UTC day) or epoch milliseconds. */
function instantFlag(text: string | undefined, flag: string, command: string): number | undefined {
  if (text === undefined) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const ms = Date.parse(`${text}T00:00:00Z`);
    if (Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === text) return ms;
  } else if (/^\d{1,16}$/.test(text) && Number(text) <= Number.MAX_SAFE_INTEGER) {
    return Number(text);
  }
  throw new UsageError(`${flag} must be a date (YYYY-MM-DD, UTC) or epoch milliseconds (got ${JSON.stringify(text)})`, command);
}

/** The secret value: --value, else all of stdin with one trailing newline removed. */
async function secretValue(ctx: CommandContext): Promise<string> {
  const given = stringFlag(ctx.values, "value");
  if (given !== undefined) return given;
  const text = await ctx.io.stdin();
  return text.endsWith("\r\n") ? text.slice(0, -2) : text.endsWith("\n") ? text.slice(0, -1) : text;
}

export const pendingCommands: CommandSpec[] = [
  {
    name: "pendings list", summary: "List one page of what needs a person, oldest first (--cursor for the next page)", args: "",
    flags: {
      agent: { value: "id", description: "only this agent's runs" },
      kind: { value: "kind", description: `only this kind (${PENDING_KINDS.join(", ")})` },
      run: { value: "run", description: "only this run" },
      status: { value: "open|resolved", description: "default open" },
      limit: { value: "n", description: "page size (1-200, default 50)" },
      cursor: { value: "c", description: "the next page, from a previous listing" },
    },
    async handler(ctx) {
      const query: NonNullable<Parameters<RunwrightClient["listPendings"]>[0]> = {};
      const agent = stringFlag(ctx.values, "agent");
      if (agent !== undefined) query.agentId = agent;
      const kind = stringFlag(ctx.values, "kind");
      if (kind !== undefined) {
        if (!(PENDING_KINDS as readonly string[]).includes(kind)) throw new UsageError(`--kind must be one of ${PENDING_KINDS.join(", ")}`, ctx.name);
        query.kind = kind as PendingKind;
      }
      const status = stringFlag(ctx.values, "status");
      if (status !== undefined) {
        if (status !== "open" && status !== "resolved") throw new UsageError("--status must be open or resolved", ctx.name);
        query.status = status;
      }
      const limit = intFlag(ctx.values, "limit", ctx.name, 1, PENDING_PAGE_MAX);
      if (limit !== undefined) query.limit = limit;
      const cursor = stringFlag(ctx.values, "cursor");
      if (cursor !== undefined) query.cursor = cursor;
      const run = stringFlag(ctx.values, "run");
      if (run !== undefined) query.runId = await ctx.runId(run);
      const { pendings, nextCursor } = await (await ctx.client()).listPendings(query);
      ctx.print({ pendings, nextCursor }, () => {
        const text = pendings.length === 0 ? "Nothing needs you." : table(
          ["PENDING", "KIND", "RUN", "AGENT", "TITLE"],
          pendings.map((p) => [p.id, p.kind, p.runId, p.agentId, p.title]),
        );
        return nextCursor === null ? text : `${text}\nMore: --cursor ${nextCursor}`;
      });
      return 0;
    },
  },
  {
    name: "pendings get", summary: "Show one pending and its detail", args: "<id>", flags: {},
    async handler(ctx) {
      const pending = await (await ctx.client()).getPending(arg(ctx, 0));
      ctx.print({ pending }, () => pendingText(pending));
      return 0;
    },
  },
];

export const triggerCommands: CommandSpec[] = [
  {
    name: "triggers list", summary: "List triggers", args: "", flags: {},
    async handler(ctx) {
      const triggers = await (await ctx.client()).listTriggers();
      ctx.print({ triggers }, () => (triggers.length === 0 ? "No triggers." : table(
        ["TRIGGER", "NAME", "KIND", "AGENT", "ENABLED", "NEXT FIRE"],
        triggers.map((t) => [t.id, t.name, t.kind, t.agentId, t.enabled ? "yes" : "no", t.nextFireAt === null ? "-" : time(t.nextFireAt)]),
      )));
      return 0;
    },
  },
  {
    name: "triggers create", summary: "Create a cron or webhook trigger from a JSON file", args: "<file>", flags: {},
    async handler(ctx) {
      const input = (await readJsonFile(arg(ctx, 0), ctx.name)) as unknown as TriggerInput;
      const trigger = await (await ctx.client()).createTrigger(input);
      ctx.print({ trigger }, () => `Created trigger ${trigger.id}\n${triggerText(trigger)}`);
      return 0;
    },
  },
  {
    name: "triggers get", summary: "Show a trigger", args: "<id>", flags: {},
    async handler(ctx) {
      const trigger = await (await ctx.client()).getTrigger(arg(ctx, 0));
      ctx.print({ trigger }, () => triggerText(trigger));
      return 0;
    },
  },
  {
    name: "triggers update", summary: "Change a trigger from a JSON file holding the fields to change", args: "<id> <file.json>", flags: {},
    async handler(ctx) {
      const patch = await readJsonFile(arg(ctx, 1), ctx.name);
      if (!isJsonObject(patch)) throw new UsageError(`${arg(ctx, 1)} must hold a JSON object`, ctx.name);
      const trigger = await (await ctx.client()).updateTrigger(arg(ctx, 0), patch as unknown as Partial<TriggerInput>);
      ctx.print({ trigger }, () => `Updated trigger ${trigger.id}\n${triggerText(trigger)}`);
      return 0;
    },
  },
  setEnabled(true),
  setEnabled(false),
  {
    name: "triggers delete", summary: "Delete a trigger", args: "<id>", flags: {},
    async handler(ctx) {
      const id = arg(ctx, 0);
      await (await ctx.client()).deleteTrigger(id);
      ctx.print({ deleted: id }, () => `Deleted trigger ${id}`);
      return 0;
    },
  },
  {
    name: "triggers fire", summary: "Start a run from a trigger now", args: "<id>",
    flags: { data: { value: "json|@file", description: "input data for the run" } },
    async handler(ctx) {
      const data = stringFlag(ctx.values, "data");
      const result = await (await ctx.client()).fireTrigger(arg(ctx, 0), data === undefined ? undefined : await readJsonArgument(data, "--data", ctx.name));
      ctx.print(result, () => `Started run ${result.run.id} from trigger ${arg(ctx, 0)}`);
      return 0;
    },
  },
];

export const secretCommands: CommandSpec[] = [
  {
    name: "secrets set", summary: "Set a secret (the value is read from stdin unless --value is given, and never shown)", args: "<name>",
    flags: { value: { value: "v", description: "the value (prefer stdin: it stays out of shell history)" } },
    async handler(ctx) {
      const secret = await (await ctx.client()).setSecret(arg(ctx, 0), await secretValue(ctx));
      ctx.print({ secret }, () => `Secret ${secret.name} is set`);
      return 0;
    },
  },
  {
    name: "secrets delete", summary: "Delete a secret", args: "<name>", flags: {},
    async handler(ctx) {
      const name = arg(ctx, 0);
      await (await ctx.client()).deleteSecret(name);
      ctx.print({ deleted: name }, () => `Deleted secret ${name}`);
      return 0;
    },
  },
  {
    name: "secrets status", summary: "Show whether secrets are set (never their values)", args: "[<name>]", flags: {},
    async handler(ctx) {
      const client = await ctx.client();
      const name = ctx.positionals[0];
      if (name !== undefined) {
        const secret = await client.secretStatus(name);
        ctx.print({ secret }, () => `${secret.name}: ${secret.set ? `set (updated ${time(secret.updatedAt)})` : "missing"}`);
        return 0;
      }
      const secrets = await client.listSecrets();
      ctx.print({ secrets }, () => (secrets.length === 0 ? "No secrets." : table(
        ["SECRET", "SET", "UPDATED"], secrets.map((s) => [s.name, s.set ? "yes" : "no", time(s.updatedAt)]),
      )));
      return 0;
    },
  },
];

export const usageCommands: CommandSpec[] = [
  {
    name: "usage", summary: "Tokens and cost by day, agent or model", args: "",
    flags: {
      by: { value: "day|agent|model", description: "how to group (default day)" },
      agent: { value: "id", description: "only this agent" },
      from: { value: "date|ms", description: "from this UTC day (YYYY-MM-DD) or epoch ms, inclusive" },
      to: { value: "date|ms", description: "up to this UTC day (YYYY-MM-DD) or epoch ms, exclusive" },
    },
    async handler(ctx) {
      const by = stringFlag(ctx.values, "by");
      if (by !== undefined && by !== "day" && by !== "agent" && by !== "model") throw new UsageError("--by must be day, agent or model", ctx.name);
      const query: NonNullable<Parameters<RunwrightClient["usage"]>[0]> = {};
      if (by !== undefined) query.groupBy = by;
      const agent = stringFlag(ctx.values, "agent");
      if (agent !== undefined) query.agentId = agent;
      const from = instantFlag(stringFlag(ctx.values, "from"), "--from", ctx.name);
      if (from !== undefined) query.from = from;
      const to = instantFlag(stringFlag(ctx.values, "to"), "--to", ctx.name);
      if (to !== undefined) query.to = to;
      if (from !== undefined && to !== undefined && from >= to) throw new UsageError("--from must be before --to", ctx.name);
      const result = await (await ctx.client()).usage(query);
      ctx.print(result, () => (result.rows.length === 0 ? "No usage yet." : table(
        [result.groupBy.toUpperCase(), "RUNS", "CALLS", "INPUT", "OUTPUT", "COST"],
        result.rows.map((r) => [r.key, String(r.runs), String(r.calls), String(r.inputTokens), String(r.outputTokens), formatCost(r.costMicros, r.unknownCostCalls > 0)]),
      )));
      return 0;
    },
  },
];

export const statusCommands: CommandSpec[] = [
  {
    name: "status", summary: "Show the server's health and readiness (exit 0 when ready, 1 when not)", args: "", flags: {},
    async handler(ctx) {
      const client = await ctx.client();
      const health = await client.health();
      let ready: JsonObject;
      try {
        ready = await client.ready();
      } catch (error) {
        // A server that answers but is not ready replies 503 (unavailable); that is the answer, not a failure.
        if (!isRunwrightError(error) || error.code !== "unavailable") throw error;
        ready = { status: "unavailable", message: error.message };
      }
      const isReady = ready["status"] === "ready";
      const runner = ready["runner"];
      ctx.print({ health, ready }, () => labelled([
        ["Server", `${health.status} (version ${health.version})`],
        ["Ready", isReady ? "yes" : `no: ${String(ready["message"] ?? ready["status"])}`],
        ["Runner", !isReady ? undefined : isJsonObject(runner) ? `${String(runner["id"])} (${String(runner["active"])} active)` : "none in the server"],
      ]));
      return isReady ? 0 : 1;
    },
  },
];
