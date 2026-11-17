import type { Clock } from "../core/clock.ts";
import { RunwrightError } from "../core/errors.ts";
import type { IdSource } from "../core/ids.ts";
import { isJsonObject, type Json, type JsonObject } from "../core/json.ts";
import { SECRET_NAME_PATTERN } from "../security/secrets.ts";
import { isWellFormedText } from "../store/idempotency.ts";
import type { RunLimits, RunRecord, Store, TriggerFireInput, TriggerFireResult, TriggerRecord } from "../store/types.ts";
import { checkTimeZone, nextFire, parseCron } from "./cron.ts";

export interface TriggerInput {
  name: string; kind: "cron" | "webhook"; agentId: string; enabled?: boolean;
  cron?: { expression: string; timeZone?: string }; webhook?: { secretName: string }; message: string;
  limits: { maxCostMicros: number; maxToolCalls?: number; maxTurns?: number };
}

const TOP_KEYS = new Set(["name", "kind", "agentId", "enabled", "cron", "webhook", "message", "limits"]);
const LIMIT_KEYS = new Set(["maxCostMicros", "maxToolCalls", "maxTurns"]);
const MAX_MESSAGE_CHARS = 65_536;

interface Problem { path: string; message: string }

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function unknownKeys(value: JsonObject, allowed: ReadonlySet<string>, path: string, problems: Problem[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) problems.push({ path: `${path}.${key}`, message: `unknown property ${JSON.stringify(key)}` });
  }
}

function checkLimits(value: unknown, problems: Problem[]): RunLimits | null {
  if (!isJsonObject(value)) {
    problems.push({ path: "$.limits", message: "limits is required: an object with a positive integer maxCostMicros" });
    return null;
  }
  unknownKeys(value, LIMIT_KEYS, "$.limits", problems);
  const limits: RunLimits = { maxCostMicros: null, maxToolCalls: null, maxTurns: null, allowUnpriced: false };
  if (!isPositiveInteger(value["maxCostMicros"])) {
    problems.push({ path: "$.limits.maxCostMicros", message: "every trigger needs a cap: a positive integer of micro-dollars" });
  } else {
    limits.maxCostMicros = value["maxCostMicros"];
  }
  for (const key of ["maxToolCalls", "maxTurns"] as const) {
    const item = value[key];
    if (item === undefined) continue;
    if (!isPositiveInteger(item)) problems.push({ path: `$.limits.${key}`, message: "must be a positive integer" });
    else limits[key] = item;
  }
  return limits;
}

/**
 * Validates a trigger definition (all problems in one `validation_failed` with `details.problems`) and builds the
 * record. For an update, `existing` supplies id, createdAt and lastFiredAt. `nextFireAt` is the next cron fire
 * time after now for an enabled cron trigger, else null; except that an update which leaves an enabled cron
 * trigger enabled with the same expression and time zone keeps `existing.nextFireAt` (when it is not null), so a
 * change that does not touch the schedule never skips a fire time that is due.
 */
export function buildTrigger(input: unknown, deps: { ids: IdSource; clock: Clock; existing?: TriggerRecord }): TriggerRecord {
  const problems: Problem[] = [];
  if (!isJsonObject(input)) {
    throw new RunwrightError("validation_failed", "a trigger must be a JSON object", {
      details: { problems: [{ path: "$", message: "must be an object" }] },
    });
  }
  unknownKeys(input, TOP_KEYS, "$", problems);

  const name = input["name"];
  if (typeof name !== "string" || name.trim().length === 0 || name.length > 120) {
    problems.push({ path: "$.name", message: "name must be a string of 1 to 120 characters" });
  } else if (!isWellFormedText(name)) {
    problems.push({ path: "$.name", message: "name must be well-formed Unicode (no unpaired surrogate)" });
  }
  const kind = input["kind"];
  if (kind !== "cron" && kind !== "webhook") problems.push({ path: "$.kind", message: 'kind must be "cron" or "webhook"' });
  const agentId = input["agentId"];
  if (typeof agentId !== "string" || agentId === "") problems.push({ path: "$.agentId", message: "agentId must be a non-empty string" });
  const message = input["message"];
  if (typeof message !== "string" || message.length > MAX_MESSAGE_CHARS) {
    problems.push({ path: "$.message", message: `message must be a string of at most ${MAX_MESSAGE_CHARS} characters` });
  } else if (!isWellFormedText(message)) {
    problems.push({ path: "$.message", message: "message must be well-formed Unicode (no unpaired surrogate)" });
  }
  const enabledInput = input["enabled"];
  if (enabledInput !== undefined && typeof enabledInput !== "boolean") {
    problems.push({ path: "$.enabled", message: "enabled must be a boolean" });
  }
  const limits = checkLimits(input["limits"], problems);

  let cron: TriggerRecord["cron"] = null;
  const cronInput = input["cron"];
  if (kind === "cron") {
    if (!isJsonObject(cronInput)) {
      problems.push({ path: "$.cron", message: "a cron trigger needs cron: {expression, timeZone?}" });
    } else {
      unknownKeys(cronInput, new Set(["expression", "timeZone"]), "$.cron", problems);
      const expression = cronInput["expression"];
      const timeZone = cronInput["timeZone"] ?? "UTC";
      let ok = true;
      if (typeof expression !== "string") {
        problems.push({ path: "$.cron.expression", message: "expression must be a five-field cron string" });
        ok = false;
      } else {
        try {
          parseCron(expression);
        } catch (error) {
          problems.push({ path: "$.cron.expression", message: (error as Error).message });
          ok = false;
        }
      }
      if (typeof timeZone !== "string") {
        problems.push({ path: "$.cron.timeZone", message: "timeZone must be an IANA time zone name" });
        ok = false;
      } else {
        try {
          checkTimeZone(timeZone);
        } catch (error) {
          problems.push({ path: "$.cron.timeZone", message: (error as Error).message });
          ok = false;
        }
      }
      if (ok) cron = { expression: (expression as string).trim(), timeZone: timeZone as string };
    }
  } else if (cronInput !== undefined && cronInput !== null) {
    problems.push({ path: "$.cron", message: "only a cron trigger has cron settings" });
  }

  let webhook: TriggerRecord["webhook"] = null;
  const webhookInput = input["webhook"];
  if (kind === "webhook") {
    if (!isJsonObject(webhookInput)) {
      problems.push({ path: "$.webhook", message: "a webhook trigger needs webhook: {secretName}" });
    } else {
      unknownKeys(webhookInput, new Set(["secretName"]), "$.webhook", problems);
      const secretName = webhookInput["secretName"];
      if (typeof secretName !== "string" || !SECRET_NAME_PATTERN.test(secretName)) {
        problems.push({ path: "$.webhook.secretName", message: "secretName must name a secret (A-Z, 0-9, _; starting with a letter)" });
      } else {
        webhook = { secretName };
      }
    }
  } else if (webhookInput !== undefined && webhookInput !== null) {
    problems.push({ path: "$.webhook", message: "only a webhook trigger has webhook settings" });
  }

  if (problems.length > 0 || limits === null) {
    throw new RunwrightError("validation_failed", problems.map((p) => `${p.path}: ${p.message}`).join("; "), {
      details: { problems: problems as unknown as Json },
    });
  }

  const now = deps.clock.now();
  const enabled = (enabledInput as boolean | undefined) ?? deps.existing?.enabled ?? true;
  const existing = deps.existing;
  const sameSchedule = existing !== undefined && existing.enabled && enabled && existing.cron !== null && cron !== null
    && existing.cron.expression === cron.expression && existing.cron.timeZone === cron.timeZone && existing.nextFireAt !== null;
  const nextFireAt = sameSchedule
    ? existing.nextFireAt
    : enabled && cron !== null ? nextFire(parseCron(cron.expression), now, cron.timeZone) : null;
  return {
    id: deps.existing?.id ?? deps.ids.next("trg"),
    name: (name as string).trim(),
    kind: kind as "cron" | "webhook",
    agentId: agentId as string,
    enabled,
    cron,
    webhook,
    message: message as string,
    limits,
    lastFiredAt: deps.existing?.lastFiredAt ?? null,
    nextFireAt,
    createdAt: deps.existing?.createdAt ?? now,
    updatedAt: now,
  };
}

/** Only the limits the trigger sets, so the agent's own tool-call and turn limits still apply when it sets none. */
function runLimitsOf(limits: RunLimits): Partial<RunLimits> {
  const out: Partial<RunLimits> = {};
  if (limits.maxCostMicros !== null) out.maxCostMicros = limits.maxCostMicros;
  if (limits.maxToolCalls !== null) out.maxToolCalls = limits.maxToolCalls;
  if (limits.maxTurns !== null) out.maxTurns = limits.maxTurns;
  return out;
}

/** One fire of a trigger, as the service hands it to the store. */
export interface TriggerFire {
  dedupeKey: string; kind: "cron" | "webhook" | "manual"; data: Json;
  /** Scheduled fires only: see TriggerFireInput.cron. */
  cron?: { slot: number; nextFireAt: number | null };
}

/**
 * One attempt: the store's outcome, nothing thrown for an outcome. The run is `{message: trigger.message, data}`
 * with the limits the trigger sets and `fire.dedupeKey` as its key; `firedAt` is `deps.clock.now()`. The
 * trigger's state is not checked here: the store decides on the stored row, inside the transaction that would
 * create the run, so `trigger` must be the record as the caller read it from the store.
 */
export function fireTriggerOnce(
  deps: { store: Store; clock: Clock }, trigger: TriggerRecord, fire: TriggerFire,
): Promise<TriggerFireResult> {
  const input: TriggerFireInput = {
    trigger,
    kind: fire.kind,
    idempotencyKey: fire.dedupeKey,
    firedAt: deps.clock.now(),
    run: { input: { message: trigger.message, data: fire.data }, limits: runLimitsOf(trigger.limits) },
    ...(fire.cron === undefined ? {} : { cron: fire.cron }),
  };
  return deps.store.fireTrigger(input);
}

/** The run of a fire (`created` false for a key that already had one), or the error of its outcome. */
export function fireResult(trigger: TriggerRecord, result: TriggerFireResult): { run: RunRecord; created: boolean } {
  switch (result.outcome) {
    case "started":
      return { run: result.run, created: true };
    case "duplicate":
      return { run: result.run, created: false };
    case "disabled":
      throw new RunwrightError("trigger_disabled", `trigger ${trigger.id} is turned off`, { details: { triggerId: trigger.id } });
    case "missing":
      throw new RunwrightError("not_found", `trigger ${trigger.id} not found`, { details: { triggerId: trigger.id } });
    case "agent_missing":
      throw new RunwrightError("not_found", `agent ${trigger.agentId} not found`, { details: { agentId: trigger.agentId } });
    case "changed":
    case "stale":
    case "no_run":
      throw new RunwrightError("conflict", `trigger ${trigger.id} changed while it was firing; try again`, {
        details: { triggerId: trigger.id, outcome: result.outcome },
      });
  }
}

/**
 * Fires a trigger once and returns the run or throws the error of the outcome: `fireResult(trigger, await
 * fireTriggerOnce(deps, trigger, fire))`. `dedupeKey` is the run's idempotency key, so the same fire (a cron
 * slot, a webhook delivery) returns the run it started the first time (created: false), also when the trigger
 * has been turned off, edited or deleted since. A new run is created only from the trigger as it is stored at
 * that moment: a trigger turned off since `trigger` was read throws `trigger_disabled`, a deleted one
 * `not_found`, an edited one `conflict` (read it again and retry). The scheduler and the routes call
 * fireTriggerOnce and fireResult themselves, because they act on the outcome; this one-call form is kept as the
 * service's "fire and get the run or the error", and the tests that pin a fire's behaviour use it.
 */
export async function fireTrigger(
  deps: { store: Store; clock: Clock },
  trigger: TriggerRecord,
  fire: TriggerFire,
): Promise<{ run: RunRecord; created: boolean }> {
  return fireResult(trigger, await fireTriggerOnce(deps, trigger, fire));
}
