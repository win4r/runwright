import { startTimer, type Clock, type TimerHandle } from "../core/clock.ts";
import { errorInfo } from "../core/errors.ts";
import type { Logger } from "../log/logger.ts";
import type { Store, TriggerRecord } from "../store/types.ts";
import { countFires, nextFire, parseCron } from "./cron.ts";
import { fireTriggerOnce } from "./service.ts";

export interface TriggerScheduler {
  start(): void;
  stop(): Promise<void>;
  /** Returns the number of runs started. */
  tick(): Promise<number>;
}

/**
 * How many due fire times are counted at most. Counting is a loop over fire times on the event loop, so it stays
 * bounded; when it stops here the reported `missedFires` (999) is a lower bound and `missedFiresCapped` is true.
 */
const MAX_COUNTED_MISSES = 1000;

/**
 * Fires due cron triggers. However many fire times were missed (downtime), a due trigger starts exactly one run,
 * with idempotency key `cron:<id>:<scheduled time>` and `data = {scheduledFor, missedFires, missedFiresCapped}`
 * (`missedFiresCapped`: the count stopped at its bound, so `missedFires` is at least that many). Each due trigger is
 * one store call (`fireTrigger`) that names the slot it consumes (the nextFireAt read) and the next fire time
 * after now: the store creates the run and moves the cursor in one transaction, and only while the stored trigger
 * still has that definition, is enabled and its cursor still equals the slot. So a person's edit, disable or
 * delete in the meantime wins (the trigger is skipped until the next tick reads it again), and a late scheduler on
 * another process finds the slot consumed and writes nothing: the cursor only moves forward. A trigger whose agent
 * no longer exists starts nothing and still consumes its slot. `start` ticks at once and then `tickMs` after
 * each tick ends; the wait is a `startTimer`, so a `tickMs` longer than one Node timer can hold is waited in full.
 * Once `stop` was called the scheduler stays stopped: a later `start` schedules nothing.
 *
 * A stored `nextFireAt` of null means the schedule never fires (`nextFire` searches a whole 400-year calendar
 * cycle, so a schedule with any fire time always has one), or the trigger is disabled; such a trigger is skipped.
 */
export function createTriggerScheduler(deps: { store: Store; clock: Clock; logger: Logger; tickMs: number }): TriggerScheduler {
  const { store, clock, logger } = deps;
  let timer: TimerHandle | null = null;
  let running = false;
  let stopped = false;
  let current: Promise<number> | null = null;

  const fireOne = async (
    trigger: TriggerRecord, cron: { expression: string; timeZone: string }, dueAt: number, now: number,
  ): Promise<boolean> => {
    const schedule = parseCron(cron.expression);
    const zone = cron.timeZone;
    const missed = countFires(schedule, dueAt - 1, now, zone, MAX_COUNTED_MISSES);
    const missedFires = Math.max(0, missed - 1);
    const missedFiresCapped = missed >= MAX_COUNTED_MISSES;
    const result = await fireTriggerOnce({ store, clock }, trigger, {
      dedupeKey: `cron:${trigger.id}:${dueAt}`,
      kind: "cron",
      data: { scheduledFor: new Date(dueAt).toISOString(), missedFires, missedFiresCapped },
      cron: { slot: dueAt, nextFireAt: nextFire(schedule, now, zone) },
    });
    switch (result.outcome) {
      case "started":
        logger.info("trigger fired", { triggerId: trigger.id, scheduledFor: dueAt, missedFires, missedFiresCapped });
        return true;
      case "agent_missing":
        logger.warn("trigger skipped: its agent no longer exists", { triggerId: trigger.id, agentId: trigger.agentId });
        return false;
      default:
        logger.debug("trigger fire skipped", { triggerId: trigger.id, scheduledFor: dueAt, outcome: result.outcome });
        return false;
    }
  };

  const tick = async (): Promise<number> => {
    const now = clock.now();
    let started = 0;
    for (const trigger of await store.listTriggers()) {
      if (trigger.kind !== "cron" || !trigger.enabled || trigger.cron === null) continue;
      if (trigger.nextFireAt === null || trigger.nextFireAt > now) continue;
      try {
        if (await fireOne(trigger, trigger.cron, trigger.nextFireAt, now)) started++;
      } catch (error) {
        logger.error("trigger failed to fire", { triggerId: trigger.id, error: errorInfo(error) });
      }
    }
    return started;
  };

  const runTick = (): Promise<number> => {
    if (current === null) {
      current = tick().finally(() => {
        current = null;
      });
    }
    return current;
  };

  const schedule = (delayMs: number): void => {
    timer = startTimer(() => {
      timer = null;
      runTick()
        .catch((error: unknown) => logger.error("trigger scheduler tick failed", { error: errorInfo(error) }))
        .finally(() => {
          if (running) schedule(deps.tickMs);
        });
    }, delayMs).unref();
  };

  return {
    start(): void {
      if (running || stopped) return;
      running = true;
      schedule(0);
    },
    async stop(): Promise<void> {
      stopped = true;
      running = false;
      timer?.clear();
      timer = null;
      if (current !== null) await current.catch(() => 0);
    },
    tick: runTick,
  };
}
