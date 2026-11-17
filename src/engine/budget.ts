/**
 * Spend cap, tool-call budget and turn limit checks (plan 3.6, 4.1, 4.2). Pure functions over numbers so the rules
 * are easy to test and to document.
 *
 * Worst case of one provider request: W = price(max(input, cacheWrite)) x (UTF-8 bytes of the serialized request +
 * 1024 framing tokens) + price(output) x maxOutputTokens. A model call is a sequence of provider attempts, and every
 * attempt is admitted on its own: it is sent only when `spent + reserved + W <= cap`, where `reserved` is the sum of
 * W of every other call of the run in flight (parallel branches); a call keeps its own reservation from its first
 * admission to its last record, also while it waits between attempts. The check and the reservation happen with no
 * await in between. The check that admits an attempt is made inside the commit that writes its `model.started`
 * (and a first tool attempt's inside the commit of its `tool.started`), against the limits and usage in force then:
 * a `limits` command applied during a backoff or a provider wait is seen before anything is sent. The checks made
 * earlier only pause sooner, without journalling an attempt.
 *
 * What an attempt is charged: a reply, its reported usage; a count the provider did not report, the bound it was
 * reserved with (worst-case input tokens priced at the highest input-side rate, or maxOutputTokens), recorded as
 * assumed (`usageAssumed`, an assumed usage row); a failure with an HTTP error status, or one where no connection
 * was made, nothing; any other failure (a broken or truncated stream, a malformed reply), and an attempt
 * interrupted by a crash, pause, cancel, shutdown or deadline, W as an assumed cost.
 *
 * Bound: as long as a provider bills no more than W for one request (at most one input token per byte of the
 * request plus 1024 framing tokens, and at most maxOutputTokens output tokens) and bills nothing for a request it
 * refused with an HTTP error status, a run's spend never exceeds its cap, sequentially or in parallel, retries
 * included, whether or not the provider reports its usage. If a provider reports more than W, the real cost is
 * recorded, the run can end above the cap by that excess, and it pauses before its next request.
 *
 * Totals saturate (plan C9): spend, reservations and worst cases are integers up to 2^53 − 1, and a check whose
 * sum passes that value reports "over" (never "fits" because of lost precision).
 *
 * Unknown prices (invariant B1): a cost is unknown when the next call's model has no price, or when the run already
 * made such a call (`costUnknown` is sticky: a price configured later does not make a past unknown cost known). An
 * unknown cost counts as over any cap that is set, so the run pauses with reason "unknown_price", unless unpriced
 * models are allowed (per run, or for the server). Allowing them makes the unknown part of the cost count as zero
 * and nothing more: the known part (known spend + reservations + the next call's known worst case) is still
 * compared with the cap before every provider attempt, and a run whose known total does not fit pauses with reason
 * "cap", also before an unpriced call when the known spend alone is already over the cap.
 */
import type { JsonObject } from "../core/json.ts";
import type { RunLimits } from "../store/types.ts";

/** The largest total of tokens, cost micros, tool calls or turns (plan C9): 2^53 − 1. */
export const MAX_TOTAL = Number.MAX_SAFE_INTEGER;

/** `value` as a total: an integer from 0 to MAX_TOTAL (rounded down; NaN and negatives are 0). */
export function clampTotal(value: number): number {
  if (!(value > 0)) return 0;
  return value >= MAX_TOTAL ? MAX_TOTAL : Math.floor(value);
}

/** `a + b` for totals, saturating: a sum that would pass MAX_TOTAL is exactly MAX_TOTAL. */
export function saturatingAdd(a: number, b: number): number {
  return Math.min(MAX_TOTAL, a + b);
}

export interface SpendCheckInput {
  capMicros: number | null;
  spentMicros: number;
  /** Worst cases of model calls already in flight in parallel branches. */
  reservedMicros: number;
  /** null = the model has no known price. */
  worstCaseMicros: number | null;
  /** The run already spent an unknown amount (sticky for the rest of the run). */
  costUnknown: boolean;
  /**
   * Unpriced models are allowed: the unknown part of the cost counts as zero. The known part is still compared with
   * the cap.
   */
  allowUnpriced: boolean;
  model: string;
}

export type SpendCheck = { ok: true } | { ok: false; detail: JsonObject };

export function checkSpend(input: SpendCheckInput): SpendCheck {
  const cap = input.capMicros;
  if (cap === null) return { ok: true };
  const unknown = input.worstCaseMicros === null || input.costUnknown;
  if (unknown && !input.allowUnpriced) {
    return {
      ok: false,
      detail: {
        capMicros: cap, spentMicros: input.spentMicros, neededMicros: null,
        nextCallWorstCaseMicros: input.worstCaseMicros, reason: "unknown_price", model: input.model,
      },
    };
  }
  // Compared before any clamping: a sum that passes MAX_TOTAL is over every cap (a cap is at most MAX_TOTAL), and
  // so is a spent total that saturated (it stands for "at least MAX_TOTAL").
  const known = input.spentMicros + input.reservedMicros + (input.worstCaseMicros ?? 0);
  if (known <= cap && input.spentMicros < MAX_TOTAL) return { ok: true };
  return {
    ok: false,
    detail: {
      capMicros: cap, spentMicros: input.spentMicros, neededMicros: Math.max(1, clampTotal(known - cap)),
      nextCallWorstCaseMicros: input.worstCaseMicros, reason: "cap", model: input.model,
    },
  };
}

/**
 * Tool-call budget / turn limit: one more is allowed while `used < limit`, where `used` is what the caller counts
 * (usage plus the other reservations). When it is not, `needed = max(1, used + 1 − limit)` (saturating at
 * MAX_TOTAL): raising the limit by exactly `needed` admits the step, and by less does not.
 */
export function checkCount(limit: number | null, used: number): { ok: true } | { ok: false; detail: JsonObject } {
  if (limit === null || used < limit) return { ok: true };
  return { ok: false, detail: { limit, used, needed: Math.max(1, clampTotal(used + 1 - limit)) } };
}

function validLimit(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

/** Merges a `limits` command into the effective limits; returns an error message for an invalid patch. */
export function mergeLimits(current: RunLimits, patch: Partial<RunLimits>): { limits: RunLimits } | { error: string } {
  const next: RunLimits = { ...current };
  let changed = false;
  for (const name of ["maxCostMicros", "maxToolCalls", "maxTurns"] as const) {
    if (!Object.hasOwn(patch, name)) continue;
    const value: unknown = patch[name];
    if (value === undefined) continue;
    if (!validLimit(value)) return { error: `${name} must be null or a non-negative integer` };
    next[name] = value;
    changed = true;
  }
  if (Object.hasOwn(patch, "allowUnpriced") && patch.allowUnpriced !== undefined) {
    if (typeof patch.allowUnpriced !== "boolean") return { error: "allowUnpriced must be a boolean" };
    next.allowUnpriced = patch.allowUnpriced;
    changed = true;
  }
  if (!changed) return { error: "the limits command changes nothing" };
  return { limits: next };
}
