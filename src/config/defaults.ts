import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "./types.ts";

export const DEFAULT_PORT = 7411;

/** RUNWRIGHT_DATA_DIR, else <home>/.runwright. */
export function defaultDataDir(env: NodeJS.ProcessEnv): string {
  const fromEnv = env["RUNWRIGHT_DATA_DIR"];
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv;
  const home = env["HOME"] !== undefined && env["HOME"] !== "" ? env["HOME"] : homedir();
  return join(home, ".runwright");
}

/** A fresh, fully populated configuration (no shared objects between calls). */
export function defaultConfig(dataDir: string): Config {
  return {
    dataDir,
    server: { host: "127.0.0.1", port: DEFAULT_PORT, portSearch: 20, bodyBytes: 1_048_576, ssePingMs: 15_000 },
    runner: { enabled: true, concurrency: 8, leaseMs: 30_000, heartbeatMs: 10_000, pollMs: 500, shutdownGraceMs: 10_000 },
    store: { synchronous: "normal" },
    tools: {
      deny: [],
      resultBytes: 16_384,
      shell: { enabled: false, timeoutMs: 60_000, outputBytes: 65_536 },
      webFetch: { timeoutMs: 15_000, maxBytes: 1_048_576, maxRedirects: 5 },
      files: { maxReadBytes: 1_048_576, maxWriteBytes: 1_048_576 },
    },
    models: {
      prices: {},
      allowUnpricedModels: false,
      defaultMaxOutputTokens: 4096,
      defaultContextTokens: 128_000,
      retry: { maxAttempts: 5, baseMs: 500, maxMs: 30_000, maxRetryAfterMs: 300_000 },
    },
    agent: { compactAtFraction: 0.8, keepRecentTurns: 4 },
    learning: { budgetTokens: 2000, promoteAfterRuns: 3, maxNotes: 5, maxSkills: 2, graderModel: null, onLimit: "pause" },
    triggers: { tickMs: 1000, webhookWindowSec: 300 },
    log: { level: "info" },
  };
}
