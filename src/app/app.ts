/**
 * The composition root: one function that wires the store, secrets, logger, models, tools, agent loop,
 * workflow runtime, learning, runner, trigger scheduler and HTTP server into one process.
 *
 * Nothing here is global: every piece is created per `createApp` call and closed by `stop()`, so a test can run
 * several apps side by side. `createApp` installs no signal handlers; the CLI and the test host do that.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { systemClock, type Clock } from "../core/clock.ts";
import { RunwrightError, errorInfo, isRunwrightError } from "../core/errors.ts";
import { packageVersion } from "../core/package-info.ts";
import { createEphemeralEvents } from "../core/events.ts";
import { createIdSource } from "../core/ids.ts";
import { ensureDataDir } from "../config/datadir.ts";
import type { Config } from "../config/types.ts";
import { createAgentLoop } from "../agent/loop.ts";
import { createRunner } from "../engine/runner.ts";
import type { EngineConfig, Runner } from "../engine/types.ts";
import { createLearning } from "../learning/index.ts";
import { createLogger, type Logger } from "../log/logger.ts";
import { createPricing } from "../models/prices.ts";
import { createModelRegistry } from "../models/registry.ts";
import { createSecretsService } from "../security/secrets.ts";
import { createWriteRedaction, redactingStore } from "../security/write-redaction.ts";
import { createServer, type RunwrightServer } from "../server/index.ts";
import { openSqliteStore } from "../store/sqlite.ts";
import type { Store } from "../store/types.ts";
import { createBuiltinTools } from "../tools/builtin.ts";
import { createToolRegistry, type ToolRegistry } from "../tools/registry.ts";
import type { ToolDefinition } from "../tools/types.ts";
import { createTriggerScheduler, type TriggerScheduler } from "../triggers/scheduler.ts";
import { createWorkflowRuntime } from "../workflow/exec/index.ts";

export interface AppOptions {
  config: Config;
  /** Default process.env; read for RUNWRIGHT_TOKEN and RUNWRIGHT_SEAL_KEY. */
  env?: NodeJS.ProcessEnv;
  /** Host tools, registered after the built-in ones. */
  tools?: readonly ToolDefinition[];
  /** Default true; false = runner only (used by `runwright runner`). */
  server?: boolean;
  /** Used by the model providers. */
  fetch?: typeof fetch;
  /** Log sink, one JSON line per call; default stderr. */
  logWrite?: (line: string) => void;
  /** Default systemClock. */
  clock?: Clock;
  /** Default: src/console/index.html next to the sources. */
  consolePath?: string;
  /**
   * Wrappers around the parts the app builds, applied once each part exists: what a wrapper returns is the part
   * the app starts and stops. For hosts and tests that observe or decorate a part's start and stop.
   */
  wrap?: AppPartWrappers;
}

/** See AppOptions.wrap. */
export interface AppPartWrappers {
  server?: (server: RunwrightServer) => RunwrightServer;
  runner?: (runner: Runner) => Runner;
  scheduler?: (scheduler: TriggerScheduler) => TriggerScheduler;
}

export interface App {
  readonly config: Config;
  readonly store: Store;
  readonly tools: ToolRegistry;
  readonly runner: Runner | null;
  /** "" until start() when a server is hosted, and always "" without one. */
  readonly url: string;
  readonly token: string;
  readonly tokenPath: string;
  /**
   * Server listen, runner start, trigger scheduler start. When any step fails, the same shutdown as `stop()` runs
   * (scheduler, runner, server, store) and `start()` rejects with the step's error: nothing is left listening,
   * no timer runs and the store is closed. When `stop()` is called while `start()` is pending, nothing more is
   * started and `start()` rejects with `conflict` ("the app was stopped while it was starting"). Concurrent calls
   * share one start; a call after the app started, or after `stop()` was called, starts nothing and resolves.
   */
  start(): Promise<void>;
  /**
   * Stop claiming, finish or release in-flight steps, close the server and the store. Idempotent. Called while
   * `start()` is pending, it first waits for that start to settle; it resolves only when the scheduler, the
   * runner, the server and the store are all stopped.
   */
  stop(options?: { graceMs?: number }): Promise<void>;
}

/** The package version, read once from package.json ("0.0.0" when it cannot be read). */
export const VERSION: string = readVersion();

function readVersion(): string {
  try {
    return packageVersion();
  } catch {
    return "0.0.0";
  }
}

/** The console page next to this module (the build copies it next to the compiled modules). */
export const DEFAULT_CONSOLE_PATH: string = fileURLToPath(new URL("../console/index.html", import.meta.url));

function engineConfig(config: Config): EngineConfig {
  return {
    concurrency: config.runner.concurrency,
    leaseMs: config.runner.leaseMs,
    heartbeatMs: config.runner.heartbeatMs,
    pollMs: config.runner.pollMs,
    workspacesDir: join(config.dataDir, "workspaces"),
    denyTools: config.tools.deny,
    allowUnpricedModels: config.models.allowUnpricedModels,
    toolResultBytes: config.tools.resultBytes,
    defaultMaxOutputTokens: config.models.defaultMaxOutputTokens,
  };
}

function builtinRegistry(config: Config): ToolRegistry {
  const { files, shell, webFetch } = config.tools;
  return createToolRegistry([
    ...createBuiltinTools({
      files: { maxReadBytes: files.maxReadBytes, maxWriteBytes: files.maxWriteBytes },
      shell: { enabled: shell.enabled, timeoutMs: shell.timeoutMs, outputBytes: shell.outputBytes },
      webFetch: { timeoutMs: webFetch.timeoutMs, maxBytes: webFetch.maxBytes, maxRedirects: webFetch.maxRedirects },
    }),
  ]);
}

/** Builds every part of a Runwright process. Nothing listens or claims until `start()`. */
export async function createApp(options: AppOptions): Promise<App> {
  const config = options.config;
  const env = options.env ?? process.env;
  const clock = options.clock ?? systemClock;
  const ids = createIdSource({ clock });
  const { token, tokenPath, sealKey } = await ensureDataDir(config, env);
  const raw = await openSqliteStore({ path: join(config.dataDir, "runwright.db"), synchronous: config.store.synchronous, clock, ids });

  let store: Store;
  let logger: Logger;
  let tools: ToolRegistry;
  let runner: Runner | null = null;
  let scheduler: TriggerScheduler | null = null;
  let server: RunwrightServer | null = null;
  try {
    const secrets = await createSecretsService({ store: raw, sealKey, alsoRedact: [token] });
    // Only the wrapped store is handed on: every caller's text is redacted before it is stored.
    store = redactingStore(raw, createWriteRedaction(secrets));
    logger = createLogger({
      level: config.log.level, clock, fields: { pid: process.pid }, redact: (text) => secrets.redactText(text),
      ...(options.logWrite === undefined ? {} : { write: options.logWrite }),
    });
    const pricing = createPricing(config.models.prices);
    const models = createModelRegistry({
      secrets, retry: config.models.retry, ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    tools = builtinRegistry(config);
    const agentLoop = createAgentLoop({
      compactAtFraction: config.agent.compactAtFraction,
      keepRecentTurns: config.agent.keepRecentTurns,
      defaultContextTokens: config.models.defaultContextTokens,
    });
    const workflows = createWorkflowRuntime({ agentLoop: agentLoop.loop, store, tools });
    const learning = createLearning({ store, tools, config: config.learning, logger, ids });
    tools.register(learning.recallTool);
    tools.register(workflows.runWorkflowTool);
    for (const tool of options.tools ?? []) tools.register(tool);
    const events = createEphemeralEvents();

    const wrap = options.wrap ?? {};
    if (config.runner.enabled) {
      const built = createRunner({
        store, clock, ids, logger, tools, models, pricing,
        drivers: { agent: agentLoop.driver, workflow: workflows.driver },
        learning: learning.hooks, secrets, events, config: engineConfig(config),
      });
      runner = wrap.runner === undefined ? built : wrap.runner(built);
    }
    if (options.server !== false) {
      const builtScheduler = createTriggerScheduler({ store, clock, logger, tickMs: config.triggers.tickMs });
      scheduler = wrap.scheduler === undefined ? builtScheduler : wrap.scheduler(builtScheduler);
      const hosted = runner;
      const builtServer = createServer({
        config, store, clock, ids, logger, token, tools, secrets, events,
        consolePath: options.consolePath ?? DEFAULT_CONSOLE_PATH,
        version: VERSION,
        runnerInfo: () => (hosted === null ? null : { id: hosted.id, active: hosted.activeRunIds().length }),
      });
      server = wrap.server === undefined ? builtServer : wrap.server(builtServer);
    }
  } catch (error) {
    // The construction error is rethrown below; a failed close of the half-built store must not hide it.
    await raw.close().catch(() => undefined);
    throw error;
  }

  let url = "";
  let stopRequested = false;
  let stopping: Promise<void> | null = null;
  /** The whole start, shared by concurrent calls (it includes the cleanup of a failed start). */
  let starting: Promise<void> | null = null;
  /** The part of a start that `stop()` waits for: listen, then the synchronous starts (never the cleanup). */
  let launching: Promise<void> | null = null;
  const log = logger;
  const appStore = store;
  const parts = { scheduler, runner, server };

  const shutdown = async (graceMs: number): Promise<void> => {
    const failures: unknown[] = [];
    const step = async (name: string, fn: () => Promise<void>): Promise<void> => {
      try {
        await fn();
      } catch (error) {
        failures.push(error);
        log.error("app.stop_failed", { step: name, message: errorInfo(error).message });
      }
    };
    const { scheduler: hostedScheduler, runner: hostedRunner, server: hostedServer } = parts;
    if (hostedScheduler !== null) await step("scheduler", () => hostedScheduler.stop());
    if (hostedRunner !== null) await step("runner", () => hostedRunner.stop({ graceMs }));
    // Closed whenever it was created: a listen() that failed after binding, or one never called, still ends here
    // with no listening socket.
    if (hostedServer !== null) await step("server", () => hostedServer.close());
    log.info("app.stopped", {});
    await step("store", () => appStore.close());
    if (failures.length > 0) throw failures[0];
  };

  const stop = (stopOptions?: { graceMs?: number }): Promise<void> => {
    stopRequested = true;
    stopping ??= (async () => {
      // A start in progress settles first (it starts nothing more once the stop was requested), so the shutdown
      // below stops everything that start created.
      if (launching !== null) await launching.catch(() => undefined);
      await shutdown(stopOptions?.graceMs ?? config.runner.shutdownGraceMs);
    })();
    return stopping;
  };

  /** Checked after every await of a start: once a stop was requested, nothing more is started. */
  const stillStarting = (): void => {
    if (stopRequested) throw new RunwrightError("conflict", "the app was stopped while it was starting");
  };

  const launch = async (): Promise<void> => {
    if (server !== null) {
      const listened = await server.listen();
      stillStarting();
      url = listened.url;
    }
    runner?.start();
    scheduler?.start();
  };

  const startOnce = async (): Promise<void> => {
    launching = launch();
    try {
      await launching;
    } catch (error) {
      url = "";
      if (isRunwrightError(error) && error.code === "conflict" && stopRequested) log.info("app.start_stopped", {});
      else log.error("app.start_failed", { message: errorInfo(error).message });
      await stop().catch(() => undefined);
      throw error;
    }
    log.info("app.started", {
      url: url === "" ? null : url, runner: runner === null ? null : runner.id, dataDir: config.dataDir,
    });
  };

  return {
    config,
    store: appStore,
    tools,
    runner,
    get url(): string {
      return url;
    },
    token,
    tokenPath,
    start(): Promise<void> {
      if (stopRequested) return Promise.resolve();
      if (starting !== null) return starting;
      starting = startOnce();
      return starting;
    },
    stop,
  };
}
