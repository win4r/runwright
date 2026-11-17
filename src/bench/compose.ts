/**
 * The small composition the benchmark needs, built directly from the stage 1–3 modules: a store on
 * `<dataDir>/runwright.db`, the built-in tools, the scripted-capable model registry, the price table, the agent
 * loop and workflow drivers, and runners on that store. The bench process and the bench worker child both use it,
 * so both sides see the same data directory layout.
 */
import { join } from "node:path";
import { systemClock } from "../core/clock.ts";
import { createEphemeralEvents } from "../core/events.ts";
import { createIdSource, type IdSource } from "../core/ids.ts";
import type { JsonObject } from "../core/json.ts";
import { defaultConfig } from "../config/defaults.ts";
import type { Config } from "../config/types.ts";
import { createLogger, type Logger } from "../log/logger.ts";
import { createAgentLoop } from "../agent/loop.ts";
import type { AgentDefinition } from "../agents/definition.ts";
import { createRunner } from "../engine/runner.ts";
import type { EngineConfig, Runner, SecretsReader } from "../engine/types.ts";
import { createModelRegistry } from "../models/registry.ts";
import { createPricing } from "../models/prices.ts";
import type { ScriptedTurn } from "../models/types.ts";
import { openSqliteStore } from "../store/sqlite.ts";
import type { Store } from "../store/types.ts";
import { createBuiltinTools } from "../tools/builtin.ts";
import { createToolRegistry, type ToolRegistry } from "../tools/registry.ts";
import { createWorkflowRuntime } from "../workflow/exec/index.ts";

export interface BenchRunnerOptions { concurrency: number; leaseMs: number; pollMs: number; runnerId?: string; heartbeatMs?: number }

export interface BenchEnv {
  readonly dataDir: string;
  readonly config: Config;
  readonly store: Store;
  readonly tools: ToolRegistry;
  readonly ids: IdSource;
  readonly logger: Logger;
  /** A runner on this store; not started. Runners made here are stopped by `close()` unless abandoned. */
  makeRunner(options: BenchRunnerOptions): Runner;
  /** Stops every runner gracefully, then closes the store. */
  close(): Promise<void>;
}

const BENCH_DB_FILE = "runwright.db";

const noSecrets: SecretsReader = { reveal: async () => ({}) };

/** Logs only warnings and errors, to stderr (stdout carries the report). */
function benchLogger(): Logger {
  return createLogger({ level: "warn", write: (line) => process.stderr.write(`${line}\n`) });
}

export async function openBenchEnv(dataDir: string): Promise<BenchEnv> {
  const config = defaultConfig(dataDir);
  config.server.port = 0;
  const logger = benchLogger();
  const ids = createIdSource();
  const store = await openSqliteStore({ path: join(dataDir, BENCH_DB_FILE), ids, synchronous: config.store.synchronous });
  const tools = createToolRegistry(createBuiltinTools({
    files: config.tools.files,
    shell: { ...config.tools.shell, enabled: false },
    webFetch: config.tools.webFetch,
  }));
  const models = createModelRegistry({ secrets: noSecrets, retry: config.models.retry });
  const pricing = createPricing(config.models.prices);
  const agentLoop = createAgentLoop({
    compactAtFraction: config.agent.compactAtFraction,
    keepRecentTurns: config.agent.keepRecentTurns,
    defaultContextTokens: config.models.defaultContextTokens,
  });
  const workflows = createWorkflowRuntime({ agentLoop: agentLoop.loop, store, tools });
  const events = createEphemeralEvents();
  const runners = new Set<Runner>();

  return {
    dataDir, config, store, tools, ids, logger,
    makeRunner(options) {
      const engine: EngineConfig = {
        concurrency: options.concurrency,
        leaseMs: options.leaseMs,
        heartbeatMs: options.heartbeatMs ?? Math.max(1, Math.floor(options.leaseMs / 3)),
        pollMs: options.pollMs,
        workspacesDir: join(dataDir, "workspaces"),
        denyTools: config.tools.deny,
        allowUnpricedModels: config.models.allowUnpricedModels,
        toolResultBytes: config.tools.resultBytes,
        defaultMaxOutputTokens: config.models.defaultMaxOutputTokens,
        ...(options.runnerId === undefined ? {} : { runnerId: options.runnerId }),
      };
      const runner = createRunner({
        store, clock: systemClock, ids, logger, tools, models, pricing,
        drivers: { agent: agentLoop.driver, workflow: workflows.driver },
        learning: null, secrets: noSecrets, events, config: engine,
      });
      runners.add(runner);
      return runner;
    },
    async close() {
      for (const runner of runners) await runner.stop({ graceMs: 500 });
      runners.clear();
      await store.close();
    },
  };
}

/** A scripted agent on the priced `scripted/scripted-1` model. */
export function scriptedAgent(name: string, turns: ScriptedTurn[], toolNames: readonly string[]): AgentDefinition {
  return {
    name,
    instructions: "Benchmark agent. Follow the script.",
    model: { provider: "scripted", name: "scripted-1", script: { turns } },
    tools: toolNames.map((tool) => ({ name: tool })),
    limits: {},
    learning: false,
  };
}

/** Two model turns: the first writes one file with write_file, the second ends the run. */
export function writeFileAgent(firstTurnDelayMs?: number): AgentDefinition {
  const args: JsonObject = { path: "out.txt", content: "{{first_message}}" };
  const first: ScriptedTurn = { toolCalls: [{ name: "write_file", args, id: "call_write" }] };
  if (firstTurnDelayMs !== undefined) first.delayMs = firstTurnDelayMs;
  return scriptedAgent("bench-writer", [first, { text: "done" }], ["write_file"]);
}

/** One model turn that ends at once. */
export function oneTurnAgent(): AgentDefinition {
  return scriptedAgent("bench-one-turn", [{ text: "done" }], []);
}
