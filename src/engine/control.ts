export type ControlReason = "waiting" | "paused" | "released" | "cancelled" | "lease_lost";

const STRENGTH: Readonly<Record<ControlReason, number>> = {
  waiting: 1,
  paused: 2,
  released: 3,
  cancelled: 4,
  lease_lost: 5,
};

/** Thrown by durable step primitives when the run must stop executing. Drivers must never swallow it. */
export class ControlSignal extends Error {
  readonly reason: ControlReason;

  constructor(reason: ControlReason) {
    super(`run execution stopped: ${reason}`);
    this.name = "ControlSignal";
    this.reason = reason;
  }
}

export function isControlSignal(error: unknown): error is ControlSignal {
  return error instanceof ControlSignal;
}

function strongestRejection(results: readonly PromiseSettledResult<unknown>[]): { found: boolean; error: unknown } {
  let signal: ControlSignal | null = null;
  let other: { error: unknown } | null = null;
  for (const result of results) {
    if (result.status !== "rejected") continue;
    const error: unknown = result.reason;
    if (isControlSignal(error)) {
      if (signal === null || STRENGTH[error.reason] > STRENGTH[signal.reason]) signal = error;
    } else if (other === null) {
      other = { error };
    }
  }
  if (signal !== null) return { found: true, error: signal };
  if (other !== null) return { found: true, error: other.error };
  return { found: false, error: undefined };
}

/**
 * Waits for every task. If any rejected: rethrows the strongest ControlSignal
 * (lease_lost > cancelled > released > paused > waiting), else the first other error in task order.
 */
export async function settleAll<T>(tasks: readonly Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(tasks);
  const rejection = strongestRejection(results);
  if (rejection.found) throw rejection.error;
  return results.map((r) => (r as PromiseFulfilledResult<T>).value);
}

/**
 * At most `limit` calls in flight; results in input order; after the first rejection no new item starts,
 * in-flight ones are awaited, then it rethrows by the settleAll rule.
 */
export function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const bound = Math.max(1, Math.floor(limit));
  return new Promise<R[]>((resolve, reject) => {
    const settled: PromiseSettledResult<R>[] = new Array<PromiseSettledResult<R>>(items.length);
    let next = 0;
    let inFlight = 0;
    let stopped = false;

    const finish = (): void => {
      const done = settled.filter((r) => r !== undefined);
      const rejection = strongestRejection(done);
      if (rejection.found) reject(rejection.error);
      else resolve(settled.map((r) => (r as PromiseFulfilledResult<R>).value));
    };

    const launch = (): void => {
      while (!stopped && inFlight < bound && next < items.length) {
        const index = next++;
        inFlight++;
        let task: Promise<R>;
        try {
          task = fn(items[index] as T, index);
        } catch (error) {
          task = Promise.reject(error);
        }
        task.then(
          (value) => {
            settled[index] = { status: "fulfilled", value };
          },
          (reason: unknown) => {
            settled[index] = { status: "rejected", reason };
            stopped = true;
          },
        ).finally(() => {
          inFlight--;
          launch();
          if (inFlight === 0 && (stopped || next >= items.length)) finish();
        });
      }
    };

    if (items.length === 0) {
      resolve([]);
      return;
    }
    launch();
  });
}
