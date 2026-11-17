import type { Json, JsonObject } from "../core/json.ts";
import { redactJsonWith } from "../core/redact.ts";
import { systemClock, type Clock } from "../core/clock.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";
export interface Logger {
  debug(message: string, fields?: JsonObject): void;
  info(message: string, fields?: JsonObject): void;
  warn(message: string, fields?: JsonObject): void;
  error(message: string, fields?: JsonObject): void;
  /** e.g. child({ runId }) for per-run correlation. */
  child(fields: JsonObject): Logger;
}
export interface LoggerOptions { level?: LogLevel; write?: (line: string) => void; redact?: (text: string) => string; clock?: Clock; fields?: JsonObject }

const RANK: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };
const RESERVED = new Set(["ts", "level", "msg"]);

/**
 * The record as plain JSON data: `bigint` as its decimal text, an `Error` as {name, message}, an object seen
 * before in the record as "[circular]", and everything else as `JSON.stringify` reads it.
 */
function toPlain(record: Record<string, unknown>): Json {
  const seen = new WeakSet<object>();
  return JSON.parse(JSON.stringify(record, (_key, value: unknown) => {
    if (typeof value === "bigint") return value.toString();
    if (value instanceof Error) return { name: value.name, message: value.message };
    if (value !== null && typeof value === "object") {
      if (seen.has(value)) return "[circular]";
      seen.add(value);
    }
    return value;
  })) as Json;
}

/** Text that stands for a message the redactor could not process: the raw message is never written. */
const UNREDACTABLE = "[log message withheld: redaction failed]";

/**
 * One JSON object per line: {"ts": ISO string, "level", "msg", ...fields}. Default sink: process.stderr.
 * The record (its message, every field name and value, and every number whose digits hold a secret) passes
 * through options.redact as a value, before it is serialized, so each line is valid JSON whatever the secrets
 * are. If the fields cannot be turned into JSON or redacted, the line is written with ts, level and the redacted
 * message only; if even the message cannot be redacted, a fixed text stands for it.
 */
export function createLogger(options?: LoggerOptions): Logger {
  const threshold = RANK[options?.level ?? "info"];
  const write = options?.write ?? ((line: string) => {
    process.stderr.write(`${line}\n`);
  });
  const redact = options?.redact ?? ((text: string) => text);
  const clock = options?.clock ?? systemClock;

  /** ts and level are written by the logger itself and are not passed through the redactor. */
  const fallbackLine = (ts: string, level: LogLevel, message: string): string => {
    let msg: string;
    try {
      msg = redact(message);
    } catch {
      msg = UNREDACTABLE;
    }
    return JSON.stringify({ ts, level, msg });
  };

  const make = (bound: JsonObject): Logger => {
    const log = (level: LogLevel, message: string, fields?: JsonObject): void => {
      if (RANK[level] < threshold) return;
      const ts = new Date(clock.now()).toISOString();
      const extra: Record<string, unknown> = {};
      for (const source of [bound, fields ?? {}]) {
        for (const [key, value] of Object.entries(source)) {
          if (value === undefined) continue;
          extra[RESERVED.has(key) ? `field_${key}` : key] = value;
        }
      }
      let line: string;
      try {
        const redacted = redactJsonWith(toPlain(extra), redact, { numbers: true }) as JsonObject;
        const record: JsonObject = { ts, level, msg: redact(message) };
        for (const [key, value] of Object.entries(redacted)) {
          const name = RESERVED.has(key) ? `field_${key}` : key;
          Object.defineProperty(record, name, { value, enumerable: true, writable: true, configurable: true });
        }
        line = JSON.stringify(record);
      } catch {
        line = fallbackLine(ts, level, message);
      }
      try {
        write(line);
      } catch {
        // Logging must never break the caller.
      }
    };
    return {
      debug: (message, fields) => log("debug", message, fields),
      info: (message, fields) => log("info", message, fields),
      warn: (message, fields) => log("warn", message, fields),
      error: (message, fields) => log("error", message, fields),
      child: (fields) => make({ ...bound, ...fields }),
    };
  };
  return make({ ...(options?.fields ?? {}) });
}
