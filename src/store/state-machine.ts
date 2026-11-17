import { RunwrightError } from "../core/errors.ts";
import type { RunStatus } from "./types.ts";

export const RUN_STATUSES: readonly RunStatus[] = Object.freeze([
  "queued", "running", "waiting", "paused", "completed", "failed", "cancelled",
] as const);

export const TERMINAL_STATUSES: readonly RunStatus[] = Object.freeze(["completed", "failed", "cancelled"] as const);

/**
 * The run state machine (plan section 3.2):
 *   queued  → running                      a runner claims it
 *   running → running                      lease expired and another runner claimed it (epoch + 1)
 *   running → waiting | paused | queued    lease holder: blocked on a person, paused, released at shutdown
 *   running → completed | failed | cancelled
 *   waiting → queued                       any command arrives, or the run's wake time passes
 *   paused  → queued                       a resume or cancel command arrives
 */
export const TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = Object.freeze({
  queued: Object.freeze(["running"] as RunStatus[]),
  running: Object.freeze(["running", "waiting", "paused", "queued", "completed", "failed", "cancelled"] as RunStatus[]),
  waiting: Object.freeze(["queued"] as RunStatus[]),
  paused: Object.freeze(["queued"] as RunStatus[]),
  completed: Object.freeze([] as RunStatus[]),
  failed: Object.freeze([] as RunStatus[]),
  cancelled: Object.freeze([] as RunStatus[]),
});

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  const allowed = Object.hasOwn(TRANSITIONS, from) ? TRANSITIONS[from] : undefined;
  return allowed !== undefined && allowed.includes(to);
}

export function assertTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransition(from, to)) {
    throw new RunwrightError("illegal_transition", `a run cannot move from ${from} to ${to}`, { details: { from, to } });
  }
}
