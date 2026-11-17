import { existsSync } from "node:fs";
import { join } from "node:path";
import { MAX_TIMER_MS, systemClock } from "../../core/clock.ts";
import { RunwrightError } from "../../core/errors.ts";
import { packageVersion } from "../../core/package-info.ts";
import type { Config } from "../../config/types.ts";
import { loadConfig, type ConfigOverrides } from "../../config/load.ts";
import { archiveFinishedRuns } from "../../ops/retention.ts";
import { openSqliteStore } from "../../store/sqlite.ts";
import { boolFlag, decimalFlag, intFlag, stringFlag, UsageError, type FlagTable } from "../args.ts";
import type { CommandContext, CommandSpec } from "../context.ts";
import { table } from "../output.ts";

const DAY_MS = 86_400_000;

/** The part of the app (src/app/app.ts `App`) that hosting it from the CLI uses. */
export interface HostedApp {
  readonly config: Config;
  readonly runner: { readonly id: string; abandon(): Promise<void> } | null;
  readonly url: string;
  readonly tokenPath: string;
  start(): Promise<void>;
  stop(options?: { graceMs?: number }): Promise<void>;
}

/** Where shutdown signals come from (the process, or a fake in tests). */
export interface SignalSource {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

function runnerLine(app: HostedApp): string {
  return app.runner === null ? "none (start one with: runwright runner)" : `in-process, concurrency ${app.config.runner.concurrency}`;
}

/** How often the idle keep-alive timer fires; it only holds the process open while it waits for a signal. */
const KEEP_ALIVE_MS = 60_000;

/**
 * Starts the app, prints where it is, then waits: the first SIGINT/SIGTERM stops it gracefully (exit 0, or 1 if
 * stopping fails); a second signal while stopping abandons the runner's work at once and ends the process: the
 * runner is fenced first (`abandon()`: nothing more is written under its leases, another runner takes its runs
 * over once they expire), then the promise resolves 1 and `ctx.io.exit?.(1)` is called, without waiting for open
 * requests or for a call that ignores cancellation.
 *
 * The signal handlers are installed before `app.start()` is called, so a signal that arrives while the app is
 * still starting stops it the same way: `app.stop()` waits for the pending start (which then starts nothing more
 * and rejects with `conflict`), nothing is announced, and the exit code is the one of the stop (0, or 1 if
 * stopping fails or a second signal arrives).
 *
 * When `app.start()` fails with no signal received, whatever it had started is stopped (`app.stop()`, a second
 * failure ignored), the handlers are removed and the start error is thrown, so nothing is left listening.
 *
 * The runner's own timers do not hold the event loop open (a library must not keep its host alive), and a
 * runner-only process has no listening socket, so the wait holds one referenced timer until it finishes.
 */
export async function hostApp(ctx: CommandContext, app: HostedApp, mode: "server" | "runner", signals: SignalSource): Promise<number> {
  let stopping = false;
  let forced = false;
  let settled = false;
  let resolveExit!: (code: number) => void;
  const exit = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const keepAlive = setInterval(() => undefined, KEEP_ALIVE_MS);
  const detach = (): void => {
    clearInterval(keepAlive);
    signals.off("SIGINT", onSignal);
    signals.off("SIGTERM", onSignal);
  };
  const finish = (code: number): void => {
    if (settled) return;
    settled = true;
    detach();
    resolveExit(code);
  };
  function onSignal(): void {
    if (!stopping) {
      stopping = true;
      ctx.io.stderr("Stopping (press Ctrl-C again to stop at once)…\n");
      app.stop().then(() => {
        if (!forced) finish(0);
      }, (error: unknown) => {
        if (forced) return;
        ctx.io.stderr(`error: stopping failed: ${(error as Error).message}\n`);
        finish(1);
      });
      return;
    }
    if (forced) return;
    forced = true;
    ctx.io.stderr("Stopping at once.\n");
    const abandon = app.runner === null ? Promise.resolve() : app.runner.abandon();
    const end = (): void => {
      if (settled) return;
      finish(1);
      ctx.io.exit?.(1);
    };
    abandon.then(end, end);
  }
  signals.on("SIGINT", onSignal);
  signals.on("SIGTERM", onSignal);

  try {
    await app.start();
  } catch (error) {
    // A signal during the start: the stop it began ends the process; the start's own rejection is not a failure.
    if (stopping) return exit;
    detach();
    await app.stop().catch(() => undefined);
    throw error;
  }
  if (stopping) return exit;
  if (mode === "server") {
    const runner = app.runner === null ? null : { id: app.runner.id, concurrency: app.config.runner.concurrency };
    ctx.print({ url: app.url, tokenPath: app.tokenPath, dataDir: app.config.dataDir, runner }, () => [
      `Runwright is running at ${app.url}`,
      `Console: ${app.url}/`,
      `API token file: ${app.tokenPath}`,
      `Data directory: ${app.config.dataDir}`,
      `Runner: ${runnerLine(app)}`,
    ].join("\n"));
  } else {
    const id = app.runner?.id ?? "-";
    ctx.print({ runnerId: id, dataDir: app.config.dataDir, concurrency: app.config.runner.concurrency }, () => `Runner ${id} started on ${app.config.dataDir}`);
  }
  return exit;
}

/** The largest runner concurrency the configuration accepts. */
const MAX_CONCURRENCY = 1024;
/** The largest `--older-than` whose milliseconds are still an exact integer. */
const MAX_AGE_DAYS = Math.floor(Number.MAX_SAFE_INTEGER / DAY_MS);
/** The most runs one `retention archive` pass takes on. */
const MAX_ARCHIVE_LIMIT = 1_000_000;

const RUNNER_FLAGS: FlagTable = {
  concurrency: { value: "n", description: `runs at once (1-${MAX_CONCURRENCY}, default 8)` },
  "lease-ms": { value: "ms", description: "lease length (default 30000)" },
};

function overrides(ctx: CommandContext): ConfigOverrides {
  const result: ConfigOverrides = { dataDir: ctx.globals.dataDir };
  const concurrency = intFlag(ctx.values, "concurrency", ctx.name, 1, MAX_CONCURRENCY);
  if (concurrency !== undefined) result.concurrency = concurrency;
  const leaseMs = intFlag(ctx.values, "lease-ms", ctx.name, 1, MAX_TIMER_MS);
  if (leaseMs !== undefined) result.leaseMs = leaseMs;
  return result;
}

export const hostCommands: CommandSpec[] = [
  {
    name: "serve", summary: "Start the server with an in-process runner (also what `runwright` alone does)", args: "",
    flags: {
      port: { value: "n", description: "port (default 7411, or the next free one; 0 = any)" },
      host: { value: "host", description: "address to bind (default 127.0.0.1)" },
      "no-runner": { description: "host no runner (start one with: runwright runner)" },
      ...RUNNER_FLAGS,
    },
    async handler(ctx) {
      const options = overrides(ctx);
      const port = intFlag(ctx.values, "port", ctx.name, 0, 65535);
      if (port !== undefined) options.port = port;
      const host = stringFlag(ctx.values, "host");
      if (host !== undefined) options.host = host;
      if (boolFlag(ctx.values, "no-runner")) options.runner = false;
      const config = await loadConfig({ env: ctx.io.env, overrides: options });
      const { createApp } = await import("../../app/app.ts");
      const app: HostedApp = await createApp({ config, env: ctx.io.env });
      return hostApp(ctx, app, "server", process);
    },
  },
  {
    name: "runner", summary: "Start a runner process on the same data directory (no server)", args: "", flags: RUNNER_FLAGS,
    async handler(ctx) {
      const config = await loadConfig({ env: ctx.io.env, overrides: { ...overrides(ctx), runner: true } });
      const { createApp } = await import("../../app/app.ts");
      const app: HostedApp = await createApp({ config, env: ctx.io.env, server: false });
      return hostApp(ctx, app, "runner", process);
    },
  },
  {
    name: "retention archive", summary: "Move finished runs' journals into gzip files (works on the data directory, no server)", args: "",
    flags: {
      "older-than": { value: "days", description: "runs that finished at least this many days ago (required)" },
      limit: { value: "n", description: "at most this many runs (default 1000)" },
    },
    async handler(ctx) {
      const days = decimalFlag(ctx.values, "older-than", ctx.name, MAX_AGE_DAYS);
      if (days === undefined) throw new UsageError("--older-than <days> is required", ctx.name);
      const limit = intFlag(ctx.values, "limit", ctx.name, 1, MAX_ARCHIVE_LIMIT);
      const dataDir = ctx.globals.dataDir;
      const path = join(dataDir, "runwright.db");
      if (!existsSync(path)) throw new RunwrightError("not_found", `no Runwright database in ${dataDir}`);
      const store = await openSqliteStore({ path });
      try {
        const result = await archiveFinishedRuns(
          { store, clock: systemClock, dataDir },
          limit === undefined ? { olderThanMs: Math.round(days * DAY_MS) } : { olderThanMs: Math.round(days * DAY_MS), limit },
        );
        ctx.print(result, () => {
          if (result.archived.length === 0 && result.skipped.length === 0) return "Nothing to archive.";
          const parts: string[] = [];
          if (result.archived.length > 0) {
            parts.push(table(["RUN", "RECORDS", "ARCHIVE"], result.archived.map((a) => [a.runId, String(a.records), a.path])));
            parts.push(`Archived ${result.archived.length} run journal(s).`);
          }
          if (result.skipped.length > 0) parts.push(`Skipped ${result.skipped.length} run(s):`);
          for (const skipped of result.skipped) parts.push(`${skipped.runId}: ${skipped.reason}`);
          return parts.join("\n");
        });
      } finally {
        await store.close();
      }
      return 0;
    },
  },
  {
    name: "bench", summary: "Run the benchmark and print its JSON report", args: "",
    flags: { quick: { description: "small sizes, a few seconds" } },
    async handler(ctx) {
      const { runBench } = await import("../../bench/bench.ts");
      const report = await runBench({ quick: boolFlag(ctx.values, "quick") });
      // The report is JSON for people too: one document in both modes.
      ctx.print(report, () => JSON.stringify(report, null, 2));
      return 0;
    },
  },
  {
    name: "api", summary: "Print the machine-readable API description", args: "", flags: {},
    async handler(ctx) {
      const api = await (await ctx.client()).describeApi();
      ctx.print(api, () => table(["METHOD", "PATH", "AUTH", "SUMMARY"], api.operations.map((o) => [o.method, o.path, o.auth, o.summary])));
      return 0;
    },
  },
  {
    name: "version", summary: "Print the version", args: "", flags: {},
    async handler(ctx) {
      const version = packageVersion();
      ctx.print({ name: "runwright", version }, () => `runwright ${version}`);
      return 0;
    },
  },
];
