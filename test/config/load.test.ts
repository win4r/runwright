import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RunwrightError } from "../../src/core/errors.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import { loadConfig } from "../../src/config/load.ts";
import { makeTempDir } from "../helpers/tmp.ts";

function isConfigInvalid(pattern?: RegExp) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof RunwrightError, String(error));
    assert.equal(error.code, "config_invalid");
    if (pattern !== undefined) assert.match(error.message, pattern);
    return true;
  };
}

test("with no file and no environment the defaults are used, and nothing is created on disk", async (t) => {
  const root = await makeTempDir(t);
  const dataDir = join(root, "data");
  const config = await loadConfig({ env: { RUNWRIGHT_DATA_DIR: dataDir } });
  assert.deepEqual(config, defaultConfig(dataDir));
  assert.deepEqual(await readdir(root), []);

  const viaOverride = await loadConfig({ env: {}, overrides: { dataDir } });
  assert.equal(viaOverride.dataDir, dataDir);
  assert.deepEqual(await readdir(root), []);
});

test("precedence is defaults < config.json < environment < overrides", async (t) => {
  const dataDir = await makeTempDir(t);
  await writeFile(join(dataDir, "config.json"), JSON.stringify({
    server: { host: "0.0.0.0", bodyBytes: 2048 },
    runner: { concurrency: 2, pollMs: 50 },
    tools: { deny: ["shell"], webFetch: { maxRedirects: 2 } },
    models: { prices: { "anthropic/claude-x": { inputPerMTok: 1, outputPerMTok: 2 } } },
    learning: { graderModel: { provider: "scripted", name: "grader" } },
    log: { level: "warn" },
  }));

  const fileOnly = await loadConfig({ env: {}, overrides: { dataDir } });
  assert.equal(fileOnly.server.host, "0.0.0.0");
  assert.equal(fileOnly.server.bodyBytes, 2048);
  assert.equal(fileOnly.server.port, 7411);
  assert.equal(fileOnly.server.portSearch, 20);
  assert.equal(fileOnly.runner.concurrency, 2);
  assert.equal(fileOnly.runner.leaseMs, 30_000);
  assert.equal(fileOnly.tools.webFetch.maxRedirects, 2);
  assert.equal(fileOnly.tools.webFetch.timeoutMs, 15_000);
  assert.deepEqual(fileOnly.models.prices, { "anthropic/claude-x": { inputPerMTok: 1, outputPerMTok: 2 } });
  assert.deepEqual(fileOnly.learning.graderModel, { provider: "scripted", name: "grader" });
  assert.equal(fileOnly.log.level, "warn");

  const env = {
    RUNWRIGHT_HOST: "127.0.0.2", RUNWRIGHT_CONCURRENCY: "4", RUNWRIGHT_LOG_LEVEL: "debug", RUNWRIGHT_POLL_MS: "25",
    RUNWRIGHT_NO_RUNNER: "1", RUNWRIGHT_SHELL: "1", RUNWRIGHT_DENY_TOOLS: " web_fetch, ,delete_file ",
    RUNWRIGHT_ALLOW_UNPRICED: "1",
  };
  const withEnv = await loadConfig({ env, overrides: { dataDir } });
  assert.equal(withEnv.server.host, "127.0.0.2");
  assert.equal(withEnv.runner.concurrency, 4);
  assert.equal(withEnv.runner.pollMs, 25);
  assert.equal(withEnv.runner.enabled, false);
  assert.equal(withEnv.tools.shell.enabled, true);
  assert.deepEqual(withEnv.tools.deny, ["shell", "web_fetch", "delete_file"]);
  assert.equal(withEnv.models.allowUnpricedModels, true);
  assert.equal(withEnv.log.level, "debug");
  assert.equal(withEnv.server.portSearch, 20);

  const withOverrides = await loadConfig({
    env,
    overrides: { dataDir, host: "::1", concurrency: 16, runner: true, logLevel: "error", pollMs: 5 },
  });
  assert.equal(withOverrides.server.host, "::1");
  assert.equal(withOverrides.runner.concurrency, 16);
  assert.equal(withOverrides.runner.enabled, true);
  assert.equal(withOverrides.runner.pollMs, 5);
  assert.equal(withOverrides.log.level, "error");
});

test("an explicitly chosen port turns off the free-port search", async (t) => {
  const dataDir = await makeTempDir(t);
  const fromEnv = await loadConfig({ env: { RUNWRIGHT_PORT: "0" }, overrides: { dataDir } });
  assert.equal(fromEnv.server.port, 0);
  assert.equal(fromEnv.server.portSearch, 0);
  const fromOverride = await loadConfig({ env: {}, overrides: { dataDir, port: 8123 } });
  assert.equal(fromOverride.server.port, 8123);
  assert.equal(fromOverride.server.portSearch, 0);
});

test("a lease from the environment or overrides sets the heartbeat to a third unless config.json set it", async (t) => {
  const dataDir = await makeTempDir(t);
  const env = await loadConfig({ env: { RUNWRIGHT_LEASE_MS: "300" }, overrides: { dataDir } });
  assert.equal(env.runner.leaseMs, 300);
  assert.equal(env.runner.heartbeatMs, 100);
  const override = await loadConfig({ env: {}, overrides: { dataDir, leaseMs: 900 } });
  assert.equal(override.runner.heartbeatMs, 300);

  await writeFile(join(dataDir, "config.json"), JSON.stringify({ runner: { heartbeatMs: 50 } }));
  const fileHeartbeat = await loadConfig({ env: { RUNWRIGHT_LEASE_MS: "300" }, overrides: { dataDir } });
  assert.equal(fileHeartbeat.runner.heartbeatMs, 50);
});

test("unknown keys in config.json are rejected with their path", async (t) => {
  const dataDir = await makeTempDir(t);
  const cases: [unknown, RegExp][] = [
    [{ sever: {} }, /\$\.sever/],
    [{ server: { prot: 1 } }, /\$\.server\.prot/],
    [{ tools: { shell: { enabeld: true } } }, /\$\.tools\.shell\.enabeld/],
    [{ models: { prices: { m: { inputPerMTok: 1, outputPerMTok: 1, extra: 1 } } } }, /\$\.models\.prices\.m\.extra/],
    [{ dataDir: "/elsewhere" }, /dataDir/],
  ];
  for (const [content, pattern] of cases) {
    await writeFile(join(dataDir, "config.json"), JSON.stringify(content));
    await assert.rejects(loadConfig({ env: {}, overrides: { dataDir } }), isConfigInvalid(pattern));
  }
});

test("wrong types, bad ranges and malformed files are config_invalid", async (t) => {
  const dataDir = await makeTempDir(t);
  const fileCases: string[] = [
    JSON.stringify({ server: { port: "7411" } }),
    JSON.stringify({ server: { port: 70000 } }),
    JSON.stringify({ runner: { concurrency: 0 } }),
    JSON.stringify({ runner: { concurrency: 2000 } }),
    JSON.stringify({ runner: { leaseMs: -5 } }),
    JSON.stringify({ runner: { heartbeatMs: 30000 } }),
    JSON.stringify({ log: { level: "loud" } }),
    JSON.stringify({ tools: { deny: "shell" } }),
    JSON.stringify({ store: { synchronous: "off" } }),
    JSON.stringify([1, 2]),
    "{ not json",
    '{"server": {"host": "a", "host": "b"}}',
  ];
  for (const content of fileCases) {
    await writeFile(join(dataDir, "config.json"), content);
    await assert.rejects(loadConfig({ env: {}, overrides: { dataDir } }), isConfigInvalid(), content);
  }

  const empty = await makeTempDir(t);
  const envCases: NodeJS.ProcessEnv[] = [
    { RUNWRIGHT_PORT: "abc" }, { RUNWRIGHT_PORT: "65536" }, { RUNWRIGHT_CONCURRENCY: "0" }, { RUNWRIGHT_LEASE_MS: "-1" },
    { RUNWRIGHT_LOG_LEVEL: "verbose" }, { RUNWRIGHT_SHELL: "maybe" }, { RUNWRIGHT_POLL_MS: "1.5" },
  ];
  for (const env of envCases) {
    await assert.rejects(loadConfig({ env, overrides: { dataDir: empty } }), isConfigInvalid(), JSON.stringify(env));
  }
  await assert.rejects(loadConfig({ env: {}, overrides: { dataDir: empty, concurrency: 1025 } }), isConfigInvalid(/concurrency/));
  await assert.rejects(loadConfig({ env: {}, overrides: { dataDir: empty, port: -1 } }), isConfigInvalid(/port/));
});

test("models.retry.maxRetryAfterMs: default 300000, a file may set it, and every retry wait is bounded by the timer limit", async (t) => {
  const dataDir = await makeTempDir(t);
  const defaults = defaultConfig(dataDir).models.retry;
  assert.equal(defaults.maxRetryAfterMs, 300_000);
  const write = (retry: unknown): Promise<void> => writeFile(join(dataDir, "config.json"), JSON.stringify({ models: { retry } }));

  await write({ maxRetryAfterMs: 600000 });
  const raised = await loadConfig({ env: {}, overrides: { dataDir } });
  assert.deepEqual(raised.models.retry, { maxAttempts: defaults.maxAttempts, baseMs: defaults.baseMs, maxMs: defaults.maxMs, maxRetryAfterMs: 600000 });

  for (const bad of [0, -1, 1.5, 2147483648, "5m"]) {
    await write({ maxRetryAfterMs: bad });
    await assert.rejects(loadConfig({ env: {}, overrides: { dataDir } }), isConfigInvalid(/\$\.models\.retry\.maxRetryAfterMs/), String(bad));
  }
  await write({ maxRetryAfterMs: 2147483647 });
  assert.equal((await loadConfig({ env: {}, overrides: { dataDir } })).models.retry.maxRetryAfterMs, 2147483647);
  for (const key of ["maxMs", "baseMs"]) {
    await write({ [key]: 2147483648 });
    await assert.rejects(loadConfig({ env: {}, overrides: { dataDir } }), isConfigInvalid(new RegExp(`\\$\\.models\\.retry\\.${key}`)), key);
  }
  await write({ maxRetryAfterMs: 600000, maxRetryAfter: 1 });
  await assert.rejects(loadConfig({ env: {}, overrides: { dataDir } }), isConfigInvalid(/\$\.models\.retry\.maxRetryAfter\b/));
});

// Every duration key is bounded by the longest wait one Node timer holds; a larger value would become a 1 ms timer.
function problemPaths(error: unknown): string[] {
  assert.ok(error instanceof RunwrightError, String(error));
  assert.equal(error.code, "config_invalid");
  const problems = error.details?.["problems"];
  assert.ok(Array.isArray(problems), JSON.stringify(error.details));
  return problems.map((p) => (p as { path: string }).path);
}

async function rejectionPaths(promise: Promise<unknown>): Promise<string[]> {
  try {
    await promise;
  } catch (error) {
    return problemPaths(error);
  }
  assert.fail("loadConfig resolved");
}

const durationKeys: { path: string; file: (value: number) => object }[] = [
  { path: "$.server.ssePingMs", file: (v) => ({ server: { ssePingMs: v } }) },
  { path: "$.runner.leaseMs", file: (v) => ({ runner: { leaseMs: v, heartbeatMs: 1000 } }) },
  { path: "$.runner.heartbeatMs", file: (v) => ({ runner: { leaseMs: 2147483647, heartbeatMs: v } }) },
  { path: "$.runner.pollMs", file: (v) => ({ runner: { pollMs: v } }) },
  { path: "$.runner.shutdownGraceMs", file: (v) => ({ runner: { shutdownGraceMs: v } }) },
  { path: "$.tools.shell.timeoutMs", file: (v) => ({ tools: { shell: { timeoutMs: v } } }) },
  { path: "$.tools.webFetch.timeoutMs", file: (v) => ({ tools: { webFetch: { timeoutMs: v } } }) },
  { path: "$.triggers.tickMs", file: (v) => ({ triggers: { tickMs: v } }) },
];

for (const key of durationKeys) {
  test(`${key.path} loads at 2147483647 and is refused at 2147483648`, async (t) => {
    const dataDir = await makeTempDir(t);
    const atLimit = key.path === "$.runner.heartbeatMs" ? 2147483646 : 2147483647;
    await writeFile(join(dataDir, "config.json"), JSON.stringify(key.file(atLimit)));
    await loadConfig({ env: {}, overrides: { dataDir } });
    await writeFile(join(dataDir, "config.json"), JSON.stringify(key.file(2147483648)));
    assert.ok((await rejectionPaths(loadConfig({ env: {}, overrides: { dataDir } }))).includes(key.path));
  });
}

test("runner.shutdownGraceMs may be 0 but not negative", async (t) => {
  const dataDir = await makeTempDir(t);
  await writeFile(join(dataDir, "config.json"), JSON.stringify({ runner: { shutdownGraceMs: 0 } }));
  assert.equal((await loadConfig({ env: {}, overrides: { dataDir } })).runner.shutdownGraceMs, 0);
  await writeFile(join(dataDir, "config.json"), JSON.stringify({ runner: { shutdownGraceMs: -1 } }));
  assert.ok((await rejectionPaths(loadConfig({ env: {}, overrides: { dataDir } }))).includes("$.runner.shutdownGraceMs"));
});

test("a lease or poll period above the timer limit is refused from the environment and from overrides", async (t) => {
  const dataDir = await makeTempDir(t);
  assert.ok((await rejectionPaths(loadConfig({ env: { RUNWRIGHT_LEASE_MS: "3000000000" }, overrides: { dataDir } }))).includes("$.runner.leaseMs"));
  assert.ok((await rejectionPaths(loadConfig({ env: { RUNWRIGHT_POLL_MS: "3000000000" }, overrides: { dataDir } }))).includes("$.runner.pollMs"));
  assert.ok((await rejectionPaths(loadConfig({ env: {}, overrides: { dataDir, leaseMs: 3000000000 } }))).includes("$.runner.leaseMs"));
  assert.ok((await rejectionPaths(loadConfig({ env: {}, overrides: { dataDir, pollMs: 3000000000 } }))).includes("$.runner.pollMs"));
});

test("a file with three over-limit durations is refused and names all three paths", async (t) => {
  const dataDir = await makeTempDir(t);
  await writeFile(join(dataDir, "config.json"), JSON.stringify({
    tools: { shell: { timeoutMs: 3000000000 } }, runner: { pollMs: 3000000000 }, triggers: { tickMs: 3000000000 },
  }));
  const paths = await rejectionPaths(loadConfig({ env: {}, overrides: { dataDir } }));
  for (const path of ["$.tools.shell.timeoutMs", "$.runner.pollMs", "$.triggers.tickMs"]) assert.ok(paths.includes(path), `${path} in ${paths.join(", ")}`);
  const clean = await makeTempDir(t);
  assert.deepEqual(await loadConfig({ env: {}, overrides: { dataDir: clean } }), defaultConfig(clean));
});

const FLAGS = [
  { env: "RUNWRIGHT_NO_RUNNER", file: (on: boolean) => ({ runner: { enabled: !on } }), read: (c: Awaited<ReturnType<typeof loadConfig>>) => !c.runner.enabled },
  { env: "RUNWRIGHT_SHELL", file: (on: boolean) => ({ tools: { shell: { enabled: on } } }), read: (c: Awaited<ReturnType<typeof loadConfig>>) => c.tools.shell.enabled },
  { env: "RUNWRIGHT_ALLOW_UNPRICED", file: (on: boolean) => ({ models: { allowUnpricedModels: on } }), read: (c: Awaited<ReturnType<typeof loadConfig>>) => c.models.allowUnpricedModels },
] as const;

for (const flag of FLAGS) {
  test(`${flag.env} overrides config.json in both directions`, async (t) => {
    const dataDir = await makeTempDir(t);
    const load = (env: NodeJS.ProcessEnv) => loadConfig({ env, overrides: { dataDir } });

    await writeFile(join(dataDir, "config.json"), JSON.stringify(flag.file(true)));
    assert.equal(flag.read(await load({ [flag.env]: "0" })), false, "file on, environment 0");
    assert.equal(flag.read(await load({})), true, "file on, environment unset");
    assert.equal(flag.read(await load({ [flag.env]: "  " })), true, "file on, environment blank");
    for (const off of ["false", "no", "NO", "False"]) assert.equal(flag.read(await load({ [flag.env]: off })), false, off);

    await writeFile(join(dataDir, "config.json"), JSON.stringify(flag.file(false)));
    assert.equal(flag.read(await load({ [flag.env]: "1" })), true, "file off, environment 1");
    assert.equal(flag.read(await load({})), false, "file off, environment unset");
    for (const on of ["true", "yes", "YES", "True"]) assert.equal(flag.read(await load({ [flag.env]: on })), true, on);

    for (const bad of ["2", "on", "off", "maybe", "y"]) {
      await assert.rejects(load({ [flag.env]: bad }), isConfigInvalid(new RegExp(flag.env)), bad);
    }
  });
}

test("--no-runner (an override) still wins over RUNWRIGHT_NO_RUNNER=0", async (t) => {
  const dataDir = await makeTempDir(t);
  const config = await loadConfig({ env: { RUNWRIGHT_NO_RUNNER: "0" }, overrides: { dataDir, runner: false } });
  assert.equal(config.runner.enabled, false);
});

test("learning.onLimit accepts pause and skip and rejects anything else with its path", async (t) => {
  const dataDir = await makeTempDir(t);
  assert.equal((await loadConfig({ env: {}, overrides: { dataDir } })).learning.onLimit, "pause");
  for (const value of ["pause", "skip"]) {
    await writeFile(join(dataDir, "config.json"), JSON.stringify({ learning: { onLimit: value } }));
    const config = await loadConfig({ env: {}, overrides: { dataDir } });
    assert.equal(config.learning.onLimit, value);
    assert.equal(config.learning.budgetTokens, 2000, "the other learning keys keep their defaults");
  }
  for (const value of ["fail", "", "PAUSE", true, null, 1]) {
    await writeFile(join(dataDir, "config.json"), JSON.stringify({ learning: { onLimit: value } }));
    await assert.rejects(loadConfig({ env: {}, overrides: { dataDir } }), isConfigInvalid(/\$\.learning\.onLimit/), JSON.stringify(value));
  }
});

test("integers are at most Number.MAX_SAFE_INTEGER and prices at most 1e9 USD per million tokens", async (t) => {
  const dataDir = await makeTempDir(t);
  const write = (value: unknown) => writeFile(join(dataDir, "config.json"), JSON.stringify(value));
  const load = () => loadConfig({ env: {}, overrides: { dataDir } });

  await write({ server: { bodyBytes: Number.MAX_SAFE_INTEGER }, learning: { budgetTokens: Number.MAX_SAFE_INTEGER } });
  const atMax = await load();
  assert.equal(atMax.server.bodyBytes, Number.MAX_SAFE_INTEGER);
  assert.equal(atMax.learning.budgetTokens, Number.MAX_SAFE_INTEGER);

  const over = Number.MAX_SAFE_INTEGER + 2;
  const integerCases: [unknown, RegExp][] = [
    [{ server: { bodyBytes: over } }, /\$\.server\.bodyBytes/],
    [{ tools: { resultBytes: 1e300 } }, /\$\.tools\.resultBytes/],
    [{ tools: { webFetch: { maxRedirects: over } } }, /\$\.tools\.webFetch\.maxRedirects/],
    [{ learning: { budgetTokens: over } }, /\$\.learning\.budgetTokens/],
    [{ learning: { maxNotes: over } }, /\$\.learning\.maxNotes/],
    [{ agent: { keepRecentTurns: over } }, /\$\.agent\.keepRecentTurns/],
    [{ triggers: { webhookWindowSec: over } }, /\$\.triggers\.webhookWindowSec/],
  ];
  for (const [value, path] of integerCases) {
    await write(value);
    await assert.rejects(load(), isConfigInvalid(path), JSON.stringify(value));
  }

  await write({ models: { prices: { "x/y": { inputPerMTok: 1e9, outputPerMTok: 0, cacheReadPerMTok: 1e9, cacheWritePerMTok: 0.5 } } } });
  assert.equal((await load()).models.prices["x/y"]?.inputPerMTok, 1e9);
  for (const field of ["inputPerMTok", "outputPerMTok", "cacheReadPerMTok", "cacheWritePerMTok"]) {
    await write({ models: { prices: { "x/y": { inputPerMTok: 1, outputPerMTok: 1, [field]: 1e9 + 1 } } } });
    await assert.rejects(load(), isConfigInvalid(new RegExp(`\\$\\.models\\.prices\\["x/y"\\]\\.${field}: must be <= 1000000000`)), field);
  }
});

test("learning.graderModel is the closed model reference: unknown keys and incomplete scripts are config_invalid", async (t) => {
  const root = await makeTempDir(t);
  await writeFile(join(root, "config.json"), JSON.stringify({ learning: { graderModel: { provider: "scripted", name: "grader", maxOutputToken: 10 } } }));
  await assert.rejects(loadConfig({ env: {}, overrides: { dataDir: root } }), (error: unknown) => {
    assert.ok(error instanceof RunwrightError);
    assert.equal(error.code, "config_invalid");
    assert.match(error.message, /\$\.learning\.graderModel\.maxOutputToken/);
    return true;
  });
  await writeFile(join(root, "config.json"), JSON.stringify({ learning: { graderModel: { provider: "scripted", name: "grader", script: { variants: [{}] } } } }));
  await assert.rejects(loadConfig({ env: {}, overrides: { dataDir: root } }), isConfigInvalid(/graderModel/));
  await writeFile(join(root, "config.json"), JSON.stringify({ learning: { graderModel: { provider: "scripted", name: "grader", script: { turns: [{ output: { decisions: [] } }] } } } }));
  const config = await loadConfig({ env: {}, overrides: { dataDir: root } });
  assert.deepEqual(config.learning.graderModel, { provider: "scripted", name: "grader", script: { turns: [{ output: { decisions: [] } }] } });
});
