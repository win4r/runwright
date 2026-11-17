import type { ModelPrice, ModelRef } from "../models/types.ts";
import type { LogLevel } from "../log/logger.ts";

export interface Config {
  dataDir: string;
  server: { host: string; port: number; portSearch: number; bodyBytes: number; ssePingMs: number };
  runner: { enabled: boolean; concurrency: number; leaseMs: number; heartbeatMs: number; pollMs: number; shutdownGraceMs: number };
  store: { synchronous: "normal" | "full" };
  tools: { deny: string[]; resultBytes: number;
    shell: { enabled: boolean; timeoutMs: number; outputBytes: number };
    webFetch: { timeoutMs: number; maxBytes: number; maxRedirects: number };
    files: { maxReadBytes: number; maxWriteBytes: number } };
  models: { prices: { [modelKey: string]: ModelPrice }; allowUnpricedModels: boolean; defaultMaxOutputTokens: number;
    defaultContextTokens: number; retry: { maxAttempts: number; baseMs: number; maxMs: number; maxRetryAfterMs: number } };
  agent: { compactAtFraction: number; keepRecentTurns: number };
  learning: { budgetTokens: number; promoteAfterRuns: number; maxNotes: number; maxSkills: number; graderModel: ModelRef | null;
    /** What a learning, grader or promotion call does when it does not fit a limit: pause the run, or skip the call. */
    onLimit: "pause" | "skip" };
  triggers: { tickMs: number; webhookWindowSec: number };
  log: { level: LogLevel };
}
