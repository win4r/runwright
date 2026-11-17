/**
 * Bench worker: a runner in its own process on an existing bench data directory. The recovery benchmark spawns
 * it, waits until it holds the runs, and kills it with SIGKILL.
 *
 *   node --disable-warning=ExperimentalWarning src/bench/worker.ts --data-dir <dir> --runner-id <id>
 *        [--lease-ms 1000] [--concurrency 8] [--poll-ms 20]
 *
 * It prints one line `{"ready":true,"runnerId":"..."}` on stdout once its runner has started, and exits when its
 * stdin closes (so it never outlives the bench process) or on SIGTERM / SIGINT (graceful stop).
 */
import { parseArgs } from "node:util";
import { openBenchEnv } from "./compose.ts";

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`--${name} must be a positive integer, got ${value}`);
  return parsed;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "data-dir": { type: "string" },
      "runner-id": { type: "string" },
      "lease-ms": { type: "string" },
      concurrency: { type: "string" },
      "poll-ms": { type: "string" },
    },
    strict: true,
  });
  const dataDir = values["data-dir"];
  const runnerId = values["runner-id"];
  if (dataDir === undefined || runnerId === undefined) throw new Error("--data-dir and --runner-id are required");
  const env = await openBenchEnv(dataDir);
  const runner = env.makeRunner({
    runnerId,
    concurrency: positiveInt(values.concurrency, 8, "concurrency"),
    leaseMs: positiveInt(values["lease-ms"], 1000, "lease-ms"),
    pollMs: positiveInt(values["poll-ms"], 20, "poll-ms"),
  });
  runner.start();

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    env.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.stdin.on("end", stop);
  process.stdin.on("error", stop);
  process.stdin.resume();
  process.stdout.write(`${JSON.stringify({ ready: true, runnerId: runner.id })}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`bench worker: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
