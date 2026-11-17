import { MAX_TIMER_MS } from "../core/clock.ts";
import { isRunwrightError } from "../core/errors.ts";
import type { AttemptBilling } from "./types.ts";

export interface RetryPolicyOptions {
  maxAttempts: number; baseMs: number; maxMs: number;
  /** The longest provider retry-after hint the engine waits out, in ms. Absent: DEFAULT_MAX_RETRY_AFTER_MS. */
  maxRetryAfterMs?: number;
}

/** The longest delay one timer can hold: 2^31 − 1 ms (about 24.8 days). */
export const MAX_WAIT_MS = MAX_TIMER_MS;

/** The default of `models.retry.maxRetryAfterMs`: five minutes. */
export const DEFAULT_MAX_RETRY_AFTER_MS = 300_000;

/** Statuses a provider call may be retried on: timeouts, conflicts, too-early, rate limits and server errors. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

/** A non-negative number (Infinity included) as an integer in [0, Number.MAX_SAFE_INTEGER]. */
function boundedMs(value: number): number {
  return Math.min(Math.round(value), Number.MAX_SAFE_INTEGER);
}

/**
 * Reads `retry-after-ms` (milliseconds) or `Retry-After` (seconds, or an HTTP date relative to `nowMs`).
 * Returns null when neither is present or parseable, otherwise an integer in [0, Number.MAX_SAFE_INTEGER]: a value
 * too large to represent is the largest one, never Infinity and never "no hint".
 */
export function parseRetryAfterMs(headers: { get(name: string): string | null }, nowMs: number): number | null {
  const ms = headers.get("retry-after-ms");
  if (ms !== null && ms.trim() !== "") {
    const value = Number(ms.trim());
    if (!Number.isNaN(value) && value >= 0) return boundedMs(value);
  }
  const after = headers.get("retry-after");
  if (after === null || after.trim() === "") return null;
  const text = after.trim();
  if (/^\d+(\.\d+)?$/.test(text)) return boundedMs(Number(text) * 1000);
  const date = Date.parse(text);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - nowMs);
}

/** The HTTP status a provider error carries in `details.status`, or null. */
export function errorStatus(error: unknown): number | null {
  if (!isRunwrightError(error)) return null;
  const status = error.details?.["status"];
  return typeof status === "number" ? status : null;
}

/**
 * The provider's retry-after hint (`details.retryAfterMs`) as an integer in [0, Number.MAX_SAFE_INTEGER]
 * (Infinity gives Number.MAX_SAFE_INTEGER), or null when it is absent, not a number, NaN or negative.
 */
export function errorRetryAfterMs(error: unknown): number | null {
  if (!isRunwrightError(error)) return null;
  const value = error.details?.["retryAfterMs"];
  return typeof value === "number" && !Number.isNaN(value) && value >= 0 ? boundedMs(value) : null;
}

/** "none" only for a RunwrightError whose details.billing is "none"; everything else, any other error included, is "unknown". */
export function attemptBilling(error: unknown): AttemptBilling {
  return isRunwrightError(error) && error.details?.["billing"] === "none" ? "none" : "unknown";
}

/**
 * The longest retry-after hint that is waited out under `policy`: `policy.maxRetryAfterMs` when it is a finite
 * number >= 0 (rounded down, at most MAX_WAIT_MS), otherwise DEFAULT_MAX_RETRY_AFTER_MS. `undefined` policy:
 * the default.
 */
export function retryAfterLimitMs(policy: { maxRetryAfterMs?: number } | undefined): number {
  const value = policy?.maxRetryAfterMs;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return DEFAULT_MAX_RETRY_AFTER_MS;
  return Math.min(Math.floor(value), MAX_WAIT_MS);
}

/**
 * What is left, at `nowMs`, of a wait of `retryAfterMs` that began at `recordedAtMs`:
 * max(0, min(retryAfterMs, recordedAtMs + retryAfterMs − nowMs)). Never more than the wait itself, so a clock
 * that jumped backwards cannot lengthen it.
 */
export function cooldownLeftMs(recordedAtMs: number, retryAfterMs: number, nowMs: number): number {
  return Math.max(0, Math.min(retryAfterMs, recordedAtMs + retryAfterMs - nowMs));
}

/**
 * The wait before attempt `attempt + 1`, given the failed attempt number (1-based). With a provider hint it is the
 * hint, unchanged (rounded to an integer): whether a hint is too long to wait out is the caller's decision
 * (retryAfterLimitMs). Without one it is min(maxMs, baseMs × 2^(attempt − 1)), at most MAX_WAIT_MS, scaled by a
 * random factor in [0.5, 1].
 */
export function backoffDelayMs(policy: RetryPolicyOptions, attempt: number, random: () => number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null) return Math.round(retryAfterMs);
  const exponential = Math.min(policy.maxMs, policy.baseMs * 2 ** (attempt - 1), MAX_WAIT_MS);
  return Math.round(exponential * (0.5 + random() / 2));
}
