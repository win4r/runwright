import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DEFAULT_PORT, defaultConfig, defaultDataDir } from "../../src/config/defaults.ts";

test("defaultDataDir prefers RUNWRIGHT_DATA_DIR, else ~/.runwright", () => {
  assert.equal(defaultDataDir({ RUNWRIGHT_DATA_DIR: "/data/rw", HOME: "/home/x" }), "/data/rw");
  assert.equal(defaultDataDir({ HOME: "/home/x" }), join("/home/x", ".runwright"));
  assert.equal(defaultDataDir({ RUNWRIGHT_DATA_DIR: "  ", HOME: "/home/y" }), join("/home/y", ".runwright"));
});

test("defaultConfig has the documented values", () => {
  const config = defaultConfig("/tmp/rw");
  assert.equal(DEFAULT_PORT, 7411);
  assert.deepEqual(config, {
    dataDir: "/tmp/rw",
    server: { host: "127.0.0.1", port: 7411, portSearch: 20, bodyBytes: 1048576, ssePingMs: 15000 },
    runner: { enabled: true, concurrency: 8, leaseMs: 30000, heartbeatMs: 10000, pollMs: 500, shutdownGraceMs: 10000 },
    store: { synchronous: "normal" },
    tools: {
      deny: [], resultBytes: 16384,
      shell: { enabled: false, timeoutMs: 60000, outputBytes: 65536 },
      webFetch: { timeoutMs: 15000, maxBytes: 1048576, maxRedirects: 5 },
      files: { maxReadBytes: 1048576, maxWriteBytes: 1048576 },
    },
    models: { prices: {}, allowUnpricedModels: false, defaultMaxOutputTokens: 4096, defaultContextTokens: 128000,
      retry: { maxAttempts: 5, baseMs: 500, maxMs: 30000, maxRetryAfterMs: 300000 } },
    agent: { compactAtFraction: 0.8, keepRecentTurns: 4 },
    learning: { budgetTokens: 2000, promoteAfterRuns: 3, maxNotes: 5, maxSkills: 2, graderModel: null, onLimit: "pause" },
    triggers: { tickMs: 1000, webhookWindowSec: 300 },
    log: { level: "info" },
  });
});

test("defaultConfig returns independent objects", () => {
  const a = defaultConfig("/a");
  a.tools.deny.push("shell");
  assert.deepEqual(defaultConfig("/a").tools.deny, []);
});
