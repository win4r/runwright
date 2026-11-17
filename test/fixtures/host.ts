/**
 * A Runwright process for the crash tests: `node --disable-warning=ExperimentalWarning test/fixtures/host.ts`.
 *
 * Environment:
 *   RUNWRIGHT_DATA_DIR (required)   the data directory (shared by every host of one test)
 *   HOST_ROLE=server|runner         server (default): HTTP API + in-process runner (unless RUNWRIGHT_NO_RUNNER=1);
 *                                   runner: a runner only, no server
 *   HOST_LEASE_MS, HOST_POLL_MS     runner lease and poll intervals
 *   HOST_GRACE_MS                   graceful-shutdown grace period
 *   HOST_SHELL=1                    enable the shell tool
 *   HOST_EFFECTS_FILE               where the host tools append their effects
 *
 * Host tools (registered through AppOptions.tools, the "hosts can add tools" path):
 *   record_effect {label}           write: appends "<label>\n"
 *   slow_effect {label, ms}         write: appends "start:<label>", waits ms, appends "end:<label>"
 *   slow_read {label, ms}           read:  the same, declared read-only (so it is retried after a crash)
 *
 * Prints one JSON line {"ready": true, "url", "pid", "runnerId"} on stdout once started; logs go to stderr.
 * SIGTERM stops the app gracefully and exits 0.
 */
import { createApp } from "../../src/app/app.ts";
import { loadConfig } from "../../src/config/load.ts";
import { createHostTools } from "./host-tools.ts";

function intEnv(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined || value === "") return undefined;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a whole number`);
  return Number(value);
}

async function main(): Promise<void> {
  if ((process.env["RUNWRIGHT_DATA_DIR"] ?? "") === "") throw new Error("RUNWRIGHT_DATA_DIR is required");
  const role = process.env["HOST_ROLE"] ?? "server";
  if (role !== "server" && role !== "runner") throw new Error(`HOST_ROLE must be server or runner (got ${role})`);
  const leaseMs = intEnv("HOST_LEASE_MS");
  const pollMs = intEnv("HOST_POLL_MS");
  const config = await loadConfig({
    env: process.env,
    overrides: {
      port: 0,
      ...(leaseMs === undefined ? {} : { leaseMs }),
      ...(pollMs === undefined ? {} : { pollMs }),
      ...(role === "runner" ? { runner: true } : {}),
    },
  });
  if (process.env["HOST_SHELL"] === "1") config.tools.shell.enabled = true;
  const graceMs = intEnv("HOST_GRACE_MS");
  if (graceMs !== undefined) config.runner.shutdownGraceMs = graceMs;

  const app = await createApp({ config, tools: createHostTools(process.env["HOST_EFFECTS_FILE"] ?? null), server: role === "server" });
  // The runner's timers do not hold the event loop open; without a server nothing else would.
  const keepAlive = setInterval(() => undefined, 60_000);
  let stopping = false;
  process.on("SIGTERM", () => {
    if (stopping) return;
    stopping = true;
    clearInterval(keepAlive);
    app.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        process.stderr.write(`host stop failed: ${(error as Error).message}\n`);
        process.exit(1);
      },
    );
  });
  await app.start();
  process.stdout.write(`${JSON.stringify({ ready: true, url: app.url, pid: process.pid, runnerId: app.runner?.id ?? null })}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`host failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
