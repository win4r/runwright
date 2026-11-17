import { RunwrightError } from "./errors.ts";

export interface Clock { now(): number }

export const systemClock: Clock = Object.freeze({ now: () => Date.now() });

export interface FakeClock extends Clock { advance(ms: number): void; set(ms: number): void }

export function createFakeClock(startMs?: number): FakeClock {
  let current = startMs ?? Date.UTC(2026, 0, 1);
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
    set(ms: number) {
      current = ms;
    },
  };
}

function abortedError(signal: AbortSignal): RunwrightError {
  return new RunwrightError("aborted", "the operation was aborted", { cause: signal.reason });
}

/** The longest delay one Node timer can hold: 2^31 − 1 ms (about 24.8 days). A longer one given to setTimeout fires after 1 ms. */
export const MAX_TIMER_MS = 2_147_483_647;

export interface TimerHandle {
  /** Cancels the timer. Idempotent; a no-op after it fired. */
  clear(): void;
  /** Lets the process exit while the timer waits. Returns the handle. */
  unref(): TimerHandle;
}

/**
 * Calls `fn` once, `ms` milliseconds from now, whatever the size of `ms`: a delay longer than `chunkMs` is
 * waited in several timers one after another and is never shortened. `ms` that is NaN, zero or negative fires
 * on the next timer turn; `Infinity` never fires (until cleared). `chunkMs` (default and maximum MAX_TIMER_MS,
 * minimum 1) is the longest single timer; it exists so tests can exercise the chaining without waiting 24 days.
 */
export function startTimer(fn: () => void, ms: number, chunkMs: number = MAX_TIMER_MS): TimerHandle {
  let remaining = ms > 0 ? ms : 0;
  const longest = Number.isNaN(chunkMs) ? MAX_TIMER_MS : Math.min(MAX_TIMER_MS, Math.max(1, chunkMs));
  let armed: ReturnType<typeof setTimeout> | null = null;
  let unrefed = false;
  const arm = (): void => {
    const chunk = Math.min(remaining, longest);
    armed = setTimeout(() => {
      armed = null;
      remaining -= chunk;
      if (remaining > 0) {
        arm();
        return;
      }
      fn();
    }, chunk);
    if (unrefed) armed.unref();
  };
  arm();
  const handle: TimerHandle = {
    clear() {
      if (armed !== null) clearTimeout(armed);
      armed = null;
    },
    unref() {
      unrefed = true;
      if (armed !== null) armed.unref();
      return handle;
    },
  };
  return handle;
}

/**
 * A period that setInterval can hold: `ms` rounded down and clamped to [floor, MAX_TIMER_MS]; NaN gives `floor`.
 * `floor` defaults to 1.
 */
export function intervalMs(ms: number, floor: number = 1): number {
  if (Number.isNaN(ms)) return floor;
  return Math.min(MAX_TIMER_MS, Math.max(floor, Math.floor(ms)));
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortedError(signal));
      return;
    }
    const onAbort = (): void => {
      timer.clear();
      if (signal !== undefined) reject(abortedError(signal));
    };
    const timer = startTimer(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
