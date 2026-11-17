/**
 * The start/stop race of plan 2.8 on the real app and the real HTTP server, in its own process (not a test file):
 * `node --disable-warning=ExperimentalWarning test/fixtures/start-stop.ts <data dir> <iterations>`.
 *
 * Each iteration creates the app on the data directory (port 0, an in-process runner, the trigger scheduler),
 * calls `start()` and, without awaiting it, `stop()` after a delay that varies from iteration to iteration (none,
 * a microtask, a macrotask, a few milliseconds), so `stop()` lands in different phases of the start. Once both
 * settled it checks that the port a `listen()` bound (seen through the server wrapper) accepts no connection and
 * that `server.json` is gone.
 *
 * Prints one JSON line `{iterations, started, refused, failures}` on stdout and then returns without calling
 * `process.exit`: the process ends by itself only if nothing (a socket, a timer, the scheduler) is left running.
 */
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { createApp } from "../../src/app/app.ts";
import { loadConfig } from "../../src/config/load.ts";
import { isRunwrightError } from "../../src/core/errors.ts";

function refusesConnections(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
  });
}

async function pause(kind: number): Promise<void> {
  if (kind === 0) return;
  if (kind === 1) return await Promise.resolve();
  if (kind === 2) return await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setTimeout(resolve, kind - 2));
}

async function main(): Promise<void> {
  const [dataDir, countText] = process.argv.slice(2);
  if (dataDir === undefined || countText === undefined || !/^\d+$/.test(countText)) {
    throw new Error("usage: start-stop.ts <data dir> <iterations>");
  }
  const iterations = Number(countText);
  const failures: string[] = [];
  let started = 0;
  let refused = 0;
  for (let i = 0; i < iterations; i++) {
    const config = await loadConfig({ env: {}, overrides: { dataDir, port: 0, leaseMs: 400, pollMs: 20 } });
    const ports: number[] = [];
    const app = await createApp({
      config, env: {}, logWrite: () => undefined,
      wrap: {
        server: (server) => ({
          listen: async () => {
            const bound = await server.listen();
            ports.push(bound.port);
            return bound;
          },
          close: () => server.close(),
        }),
      },
    });
    const start = app.start();
    await pause(i % 6);
    const stop = app.stop({ graceMs: 100 });
    const [startResult, stopResult] = await Promise.allSettled([start, stop]);
    if (stopResult.status === "rejected") failures.push(`iteration ${i}: stop() rejected: ${String(stopResult.reason)}`);
    if (startResult.status === "fulfilled") {
      started += 1;
      if (i % 6 === 0) failures.push(`iteration ${i}: start() resolved although stop() was called before it could finish`);
    } else if (isRunwrightError(startResult.reason) && startResult.reason.code === "conflict") {
      refused += 1;
    } else {
      failures.push(`iteration ${i}: start() rejected with something other than conflict: ${String(startResult.reason)}`);
    }
    for (const port of ports) {
      if (!(await refusesConnections(port))) failures.push(`iteration ${i}: port ${port} still accepts connections after stop()`);
    }
    if (existsSync(join(dataDir, "server.json"))) failures.push(`iteration ${i}: server.json exists after stop()`);
    await app.stop();
  }
  process.stdout.write(`${JSON.stringify({ iterations, started, refused, failures })}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
