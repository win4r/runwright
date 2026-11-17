import { RunwrightError } from "../core/errors.ts";

/**
 * Nearest-rank percentile: the smallest sample such that at least `p` percent of the samples are less than or
 * equal to it. `p` is in [0, 100]; p = 0 gives the minimum, p = 100 the maximum. The input need not be sorted.
 */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) throw new RunwrightError("bad_request", "percentile of an empty sample set");
  if (!Number.isFinite(p) || p < 0 || p > 100) throw new RunwrightError("bad_request", `percentile must be in [0, 100], got ${p}`);
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] as number;
}

/** Rounds to three decimals (micro-precision for milliseconds), keeping small positive values above zero. */
export function round3(value: number): number {
  const rounded = Math.round(value * 1000) / 1000;
  return rounded === 0 && value > 0 ? 0.001 : rounded;
}

export interface LatencySummary { samples: number; p50: number; p99: number }

export function summarize(samples: readonly number[]): LatencySummary {
  return { samples: samples.length, p50: round3(percentile(samples, 50)), p99: round3(percentile(samples, 99)) };
}

/** Elapsed milliseconds between two `process.hrtime.bigint()` stamps, as a fractional number. */
export function nsToMs(from: bigint, to: bigint): number {
  return Number(to - from) / 1e6;
}
