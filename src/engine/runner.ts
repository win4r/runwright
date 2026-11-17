/**
 * The runner: claims queued and orphaned runs under a lease, runs up to `concurrency` sessions at once,
 * heartbeats every lease it holds, and shuts down gracefully (release at the next step boundary) or hard
 * (`abandon`, the "process died" path).
 *
 * Wake-ups: a `run.queued` event of this store handle and a session ending schedule a claim with no sleep; a
 * session that left its run waiting with a wake time (a node deadline) arms the runner's one wake timer for the
 * earliest such instant it knows, which claims when it fires (`claimRuns` requeues waiting runs whose wake time
 * passed); a poll timer every `pollMs` covers every other case: runs created by other processes, wake times this
 * runner does not know of and leases that expired. A run is therefore woken within one poll interval of the
 * instant when this runner has a free slot; a runner whose slots are all busy does not look for work (claimLoop
 * returns before claiming), so the wake-up then waits until a slot is free.
 *
 * `start()` does nothing unless the runner is new: after `stop()` or `abandon()` it claims nothing and arms no
 * timer.
 */
import { hostname } from "node:os";
import { intervalMs, startTimer, type TimerHandle } from "../core/clock.ts";
import { errorInfo } from "../core/errors.ts";
import type { ClaimedRun } from "../store/types.ts";
import type { EngineDeps, Runner } from "./types.ts";
import { startSession, type Session } from "./session.ts";

type Phase = "new" | "running" | "stopping" | "stopped" | "dead";

export function createRunner(deps: EngineDeps): Runner {
  const { store, config } = deps;
  const id = config.runnerId ?? deps.ids.next("runner");
  const logger = deps.logger.child({ runnerId: id });
  const sessions = new Map<string, Session>();
  let phase: Phase = "new";
  let startedAt = 0;
  let unsubscribe: (() => void) | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let claimScheduled = false;
  let claimAgain = false;
  let claiming: Promise<void> | null = null;
  let heartbeating = false;
  let forcing = false;
  /** The one wake timer: the earliest wake time a session of this runner stored. */
  let wake: { at: number; timer: TimerHandle } | null = null;

  /** Read through a function so checks after an await are not narrowed away by the compiler. */
  const gone = (): boolean => phase === "dead" || phase === "stopped";

  const runnerInfo = () => ({
    id, pid: process.pid, hostname: hostname(), concurrency: config.concurrency, startedAt, lastSeenAt: deps.clock.now(),
  });

  const launch = (claimed: ClaimedRun): void => {
    const runId = claimed.run.id;
    // This runner's own lease on the run expired and its claim picked the run up again: the old session must stop now.
    const previous = sessions.get(runId);
    if (previous !== undefined && !previous.ended()) previous.fence("lease_lost");
    const session = startSession(deps, claimed, id, () => {
      if (sessions.get(runId) === session) sessions.delete(runId);
      const at = session.wakeAt();
      if (at !== null) armWake(at);
      scheduleClaim();
    });
    sessions.set(runId, session);
    if (phase === "dead") session.fence("abandoned");
    else if (phase === "stopping") {
      if (forcing) session.forceStop();
      else session.requestStop();
    }
  };

  const claimLoop = async (): Promise<void> => {
    try {
      do {
        claimAgain = false;
        if (phase !== "running") return;
        const free = config.concurrency - sessions.size;
        if (free <= 0) return;
        const claimed = await store.claimRuns({ runnerId: id, limit: free, leaseMs: config.leaseMs });
        for (const run of claimed) launch(run);
      } while (claimAgain);
    } catch (error) {
      if (phase === "running") logger.warn("runner.claim_failed", { message: errorInfo(error).message });
    }
  };

  const claim = (): void => {
    if (claiming !== null) {
      claimAgain = true;
      return;
    }
    claiming = claimLoop().finally(() => {
      claiming = null;
    });
  };

  /** Arms the wake timer for `at` unless it is already armed for an earlier (or the same) instant. */
  function armWake(at: number): void {
    if (phase !== "running") return;
    if (wake !== null && wake.at <= at) return;
    wake?.timer.clear();
    const fire = (): void => {
      // A timer may fire a little before the clock reaches the instant: wait out the rest, then claim.
      const left = at - deps.clock.now();
      if (left > 0) {
        wake = { at, timer: startTimer(fire, left).unref() };
        return;
      }
      wake = null;
      if (phase === "running") claim();
    };
    wake = { at, timer: startTimer(fire, Math.max(0, at - deps.clock.now())).unref() };
  }

  function scheduleClaim(): void {
    if (phase !== "running" || claimScheduled) return;
    claimScheduled = true;
    setImmediate(() => {
      claimScheduled = false;
      claim();
    });
  }

  const heartbeat = async (): Promise<void> => {
    if (heartbeating || gone()) return;
    heartbeating = true;
    try {
      const runIds = [...sessions.values()].filter((s) => !s.ended()).map((s) => s.runId);
      const lost = runIds.length === 0 ? [] : await store.heartbeat({ runnerId: id, runIds, leaseMs: config.leaseMs });
      if (gone()) return;
      for (const runId of lost) {
        const session = sessions.get(runId);
        if (session !== undefined && !session.ended()) session.fence("lease_lost");
      }
      await store.upsertRunner(runnerInfo());
    } catch (error) {
      if (!gone()) logger.warn("runner.heartbeat_failed", { message: errorInfo(error).message });
    } finally {
      heartbeating = false;
    }
  };

  const clearTimers = (): void => {
    if (pollTimer !== null) clearInterval(pollTimer);
    if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
    wake?.timer.clear();
    pollTimer = null;
    heartbeatTimer = null;
    wake = null;
  };

  const waitForSessions = async (): Promise<void> => {
    while (sessions.size > 0 || claiming !== null) {
      await Promise.all([...sessions.values()].map((s) => s.done).concat(claiming === null ? [] : [claiming]));
    }
  };

  return {
    id,
    start(): void {
      if (phase !== "new") return;
      phase = "running";
      startedAt = deps.clock.now();
      store.upsertRunner(runnerInfo()).catch((error: unknown) => {
        logger.warn("runner.register_failed", { message: errorInfo(error).message });
      });
      unsubscribe = store.subscribe((event) => {
        if (event.type === "run.queued") scheduleClaim();
        else if (event.type === "command") sessions.get(event.runId)?.onCommand();
      });
      pollTimer = setInterval(() => claim(), intervalMs(config.pollMs));
      pollTimer.unref();
      heartbeatTimer = setInterval(() => {
        void heartbeat();
      }, intervalMs(config.heartbeatMs));
      heartbeatTimer.unref();
      logger.info("runner.started", { concurrency: config.concurrency, leaseMs: config.leaseMs });
      scheduleClaim();
    },
    async stop(options?: { graceMs?: number }): Promise<void> {
      if (phase === "dead" || phase === "stopped") return;
      const wasStarted = phase !== "new";
      phase = "stopping";
      if (pollTimer !== null) clearInterval(pollTimer);
      pollTimer = null;
      wake?.timer.clear();
      wake = null;
      for (const session of sessions.values()) session.requestStop();
      const grace = startTimer(() => {
        forcing = true;
        for (const session of sessions.values()) session.forceStop();
      }, options?.graceMs ?? 10_000);
      try {
        await waitForSessions();
      } finally {
        grace.clear();
      }
      clearTimers();
      unsubscribe?.();
      unsubscribe = null;
      phase = "stopped";
      if (wasStarted) {
        try {
          await store.removeRunner(id);
        } catch (error) {
          logger.warn("runner.unregister_failed", { message: errorInfo(error).message });
        }
      }
      logger.info("runner.stopped", {});
    },
    async abandon(): Promise<void> {
      if (phase === "dead") return;
      phase = "dead";
      clearTimers();
      unsubscribe?.();
      unsubscribe = null;
      for (const session of sessions.values()) session.fence("abandoned");
    },
    activeRunIds(): string[] {
      return [...sessions.keys()];
    },
  };
}
