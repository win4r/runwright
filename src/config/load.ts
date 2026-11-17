import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MAX_TIMER_MS } from "../core/clock.ts";
import { RunwrightError } from "../core/errors.ts";
import { isJsonObject, parseStrictJson, type Json, type JsonObject } from "../core/json.ts";
import { modelRefSchema } from "../agents/definition.ts";
import type { LogLevel } from "../log/logger.ts";
import { validateSchema, type JsonSchema } from "../schema/validate.ts";
import { defaultConfig, defaultDataDir } from "./defaults.ts";
import type { Config } from "./types.ts";

export interface ConfigOverrides {
  dataDir?: string; host?: string; port?: number; runner?: boolean; concurrency?: number;
  leaseMs?: number; pollMs?: number; logLevel?: LogLevel;
}

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/** The largest price accepted, in USD per million tokens. */
export const MAX_PRICE_PER_MTOK = 1e9;
const positiveInt: JsonSchema = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const nonNegativeInt: JsonSchema = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const price: JsonSchema = { type: "number", minimum: 0, maximum: MAX_PRICE_PER_MTOK };
/** A wait one timer can hold: 1 to 2^31 − 1 ms. */
const waitMs: JsonSchema = { type: "integer", minimum: 1, maximum: MAX_TIMER_MS };
/** A grace period one timer can hold, where zero means "at once": 0 to 2^31 − 1 ms. */
const graceMs: JsonSchema = { type: "integer", minimum: 0, maximum: MAX_TIMER_MS };

function section(properties: { [key: string]: JsonSchema }): JsonSchema {
  return { type: "object", additionalProperties: false, properties };
}

/**
 * The shape of `config.json` and of the merged configuration. Nothing is required in the file; every object is
 * closed (`additionalProperties: false`) or a map whose values have a schema, so an unknown key at any depth is
 * reported with its path. `learning.graderModel` is the agent definition's closed model reference.
 */
export const configSchema: JsonSchema = section({
  dataDir: { type: "string", minLength: 1 },
  server: section({
    host: { type: "string", minLength: 1 },
    port: { type: "integer", minimum: 0, maximum: 65535 },
    portSearch: { type: "integer", minimum: 0, maximum: 1000 },
    bodyBytes: positiveInt,
    ssePingMs: waitMs,
  }),
  runner: section({
    enabled: { type: "boolean" },
    concurrency: { type: "integer", minimum: 1, maximum: 1024 },
    leaseMs: waitMs,
    heartbeatMs: waitMs,
    pollMs: waitMs,
    shutdownGraceMs: graceMs,
  }),
  store: section({ synchronous: { enum: ["normal", "full"] } }),
  tools: section({
    deny: { type: "array", items: { type: "string", minLength: 1 } },
    resultBytes: positiveInt,
    shell: section({ enabled: { type: "boolean" }, timeoutMs: waitMs, outputBytes: positiveInt }),
    webFetch: section({ timeoutMs: waitMs, maxBytes: positiveInt, maxRedirects: nonNegativeInt }),
    files: section({ maxReadBytes: positiveInt, maxWriteBytes: positiveInt }),
  }),
  models: section({
    prices: {
      type: "object",
      additionalProperties: {
        type: "object",
        required: ["inputPerMTok", "outputPerMTok"],
        additionalProperties: false,
        properties: {
          inputPerMTok: price,
          outputPerMTok: price,
          cacheReadPerMTok: price,
          cacheWritePerMTok: price,
        },
      },
    },
    allowUnpricedModels: { type: "boolean" },
    defaultMaxOutputTokens: positiveInt,
    defaultContextTokens: positiveInt,
    retry: section({ maxAttempts: positiveInt, baseMs: waitMs, maxMs: waitMs, maxRetryAfterMs: waitMs }),
  }),
  agent: section({
    compactAtFraction: { type: "number", minimum: 0.05, maximum: 1 },
    keepRecentTurns: nonNegativeInt,
  }),
  learning: section({
    budgetTokens: nonNegativeInt,
    promoteAfterRuns: positiveInt,
    maxNotes: nonNegativeInt,
    maxSkills: nonNegativeInt,
    // null or the model reference, as one schema (object keywords apply only to an object) so that a problem inside
    // the reference is reported at its own path.
    graderModel: { ...modelRefSchema, type: ["object", "null"] },
    onLimit: { enum: ["pause", "skip"] },
  }),
  triggers: section({ tickMs: waitMs, webhookWindowSec: positiveInt }),
  log: section({ level: { enum: [...LOG_LEVELS] } }),
});

function invalid(message: string, details?: JsonObject): RunwrightError {
  return new RunwrightError("config_invalid", message, details === undefined ? undefined : { details });
}

function check(value: unknown, source: string): void {
  const problems = validateSchema(configSchema, value);
  if (problems.length === 0) return;
  const list = problems.map((p) => ({ path: p.path, message: p.message }));
  throw invalid(`${source}: ${list.map((p) => `${p.path}: ${p.message}`).join("; ")}`, { source, problems: list });
}

/** Objects merge key by key; arrays, scalars and the price map's entries are replaced. */
function deepMerge(target: JsonObject, patch: JsonObject): void {
  for (const [key, value] of Object.entries(patch)) {
    const current = target[key];
    if (isJsonObject(value) && isJsonObject(current) && key !== "graderModel") deepMerge(current, value);
    else target[key] = value;
  }
}

async function readConfigFile(path: string): Promise<JsonObject | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw invalid(`cannot read ${path}: ${(error as Error).message}`);
  }
  let parsed: Json;
  try {
    parsed = parseStrictJson(text);
  } catch (error) {
    throw invalid(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  if (!isJsonObject(parsed)) throw invalid(`${path} must hold a JSON object`);
  if (Object.hasOwn(parsed, "dataDir")) {
    throw invalid(`${path}: $.dataDir cannot be set in config.json (use RUNWRIGHT_DATA_DIR)`, { source: path });
  }
  check(parsed, path);
  return parsed;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function envInteger(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const value = envValue(env, name);
  if (value === undefined) return undefined;
  if (!/^\d{1,15}$/.test(value)) throw invalid(`${name} must be a whole number (got ${JSON.stringify(value)})`);
  return Number(value);
}

function envFlag(env: NodeJS.ProcessEnv, name: string): boolean | undefined {
  const value = envValue(env, name);
  if (value === undefined) return undefined;
  const lower = value.toLowerCase();
  if (lower === "1" || lower === "true" || lower === "yes") return true;
  if (lower === "0" || lower === "false" || lower === "no") return false;
  throw invalid(`${name} must be one of 1, true, yes, 0, false, no (got ${JSON.stringify(value)})`);
}

/**
 * Builds the configuration: defaults < `<dataDir>/config.json` < `RUNWRIGHT_*` environment < overrides.
 * Reads only; nothing is created on disk.
 */
export async function loadConfig(input: { env: NodeJS.ProcessEnv; overrides?: ConfigOverrides }): Promise<Config> {
  const { env } = input;
  const overrides = input.overrides ?? {};
  const dataDir = overrides.dataDir ?? defaultDataDir(env);
  const config = defaultConfig(dataDir);

  const file = await readConfigFile(join(dataDir, "config.json"));
  if (file !== null) deepMerge(config as unknown as JsonObject, file);
  const fileSetHeartbeat = file !== null && isJsonObject(file["runner"]) && Object.hasOwn(file["runner"], "heartbeatMs");

  let explicitPort = false;
  let leaseChanged = false;

  const host = envValue(env, "RUNWRIGHT_HOST");
  if (host !== undefined) config.server.host = host;
  const port = envInteger(env, "RUNWRIGHT_PORT");
  if (port !== undefined) {
    config.server.port = port;
    explicitPort = true;
  }
  const concurrency = envInteger(env, "RUNWRIGHT_CONCURRENCY");
  if (concurrency !== undefined) config.runner.concurrency = concurrency;
  const leaseMs = envInteger(env, "RUNWRIGHT_LEASE_MS");
  if (leaseMs !== undefined) {
    config.runner.leaseMs = leaseMs;
    leaseChanged = true;
  }
  const pollMs = envInteger(env, "RUNWRIGHT_POLL_MS");
  if (pollMs !== undefined) config.runner.pollMs = pollMs;
  const level = envValue(env, "RUNWRIGHT_LOG_LEVEL");
  if (level !== undefined) {
    if (!(LOG_LEVELS as readonly string[]).includes(level)) {
      throw invalid(`RUNWRIGHT_LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")} (got ${JSON.stringify(level)})`);
    }
    config.log.level = level as LogLevel;
  }
  const noRunner = envFlag(env, "RUNWRIGHT_NO_RUNNER");
  if (noRunner !== undefined) config.runner.enabled = !noRunner;
  const shell = envFlag(env, "RUNWRIGHT_SHELL");
  if (shell !== undefined) config.tools.shell.enabled = shell;
  const allowUnpriced = envFlag(env, "RUNWRIGHT_ALLOW_UNPRICED");
  if (allowUnpriced !== undefined) config.models.allowUnpricedModels = allowUnpriced;
  const deny = envValue(env, "RUNWRIGHT_DENY_TOOLS");
  if (deny !== undefined) {
    const names = deny.split(",").map((name) => name.trim()).filter((name) => name !== "");
    config.tools.deny = [...new Set([...config.tools.deny, ...names])];
  }

  if (overrides.host !== undefined) config.server.host = overrides.host;
  if (overrides.port !== undefined) {
    config.server.port = overrides.port;
    explicitPort = true;
  }
  if (overrides.runner !== undefined) config.runner.enabled = overrides.runner;
  if (overrides.concurrency !== undefined) config.runner.concurrency = overrides.concurrency;
  if (overrides.leaseMs !== undefined) {
    config.runner.leaseMs = overrides.leaseMs;
    leaseChanged = true;
  }
  if (overrides.pollMs !== undefined) config.runner.pollMs = overrides.pollMs;
  if (overrides.logLevel !== undefined) config.log.level = overrides.logLevel;

  if (leaseChanged && !fileSetHeartbeat) config.runner.heartbeatMs = Math.max(1, Math.floor(config.runner.leaseMs / 3));
  if (explicitPort) config.server.portSearch = 0;

  check(config, "configuration");
  if (config.runner.heartbeatMs >= config.runner.leaseMs) {
    throw invalid(
      `configuration: runner.heartbeatMs (${config.runner.heartbeatMs}) must be less than runner.leaseMs (${config.runner.leaseMs})`,
      { source: "configuration" },
    );
  }
  return config;
}
