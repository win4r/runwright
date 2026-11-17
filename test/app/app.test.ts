import assert from "node:assert/strict";
import { connect, createServer as createNetServer, type Server } from "node:net";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createApp, DEFAULT_CONSOLE_PATH, VERSION, type AppPartWrappers } from "../../src/app/app.ts";
import { createClient } from "../../src/client/index.ts";
import { loadConfig } from "../../src/config/load.ts";
import type { Config } from "../../src/config/types.ts";
import { isRunwrightError } from "../../src/core/errors.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { waitFor } from "../helpers/wait.ts";
import { scriptedAgent } from "../fixtures/runs.ts";

async function configFor(dir: string, overrides?: { runner?: boolean }): Promise<Config> {
  return loadConfig({ env: {}, overrides: { dataDir: join(dir, "data"), port: 0, leaseMs: 400, pollMs: 20, ...overrides } });
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : port);
    });
  });
}

const echoTool: ToolDefinition = {
  name: "host_echo",
  description: "Echoes its text.",
  parameters: { type: "object", required: ["text"], additionalProperties: false, properties: { text: { type: "string" } } },
  effect: "read",
  async handler(args) {
    return { content: `echo: ${String(args["text"])}` };
  },
};

test("createApp starts and stops twice in a row on one data directory", async (t) => {
  const dir = await makeTempDir(t, "runwright-app-");
  const consolePath = join(dir, "console.html");
  await writeFile(consolePath, "<!doctype html><title>Runwright</title>\n");
  const lines: string[] = [];
  const tokens: string[] = [];
  let agentId = "";
  for (let round = 0; round < 2; round++) {
    const app = await createApp({ config: await configFor(dir), env: {}, consolePath, logWrite: (line) => lines.push(line) });
    assert.equal(app.url, "", "no URL before start()");
    await app.start();
    assert.match(app.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(app.runner !== null);
    tokens.push(app.token);
    assert.equal(app.tokenPath, join(dir, "data", "token"));
    await access(join(dir, "data", "server.json"));
    const client = createClient({ baseUrl: app.url, token: app.token });
    assert.equal((await client.health()).version, VERSION);
    const ready = await client.ready();
    assert.equal((ready["runner"] as { id: string }).id, app.runner.id);
    if (round === 0) {
      agentId = (await client.saveAgent(scriptedAgent({ name: "Twice", script: { turns: [{ text: "hello" }] } }), "twice")).agent.id;
    }
    const { run } = await client.startRun({ agentId, message: `round ${round}` });
    await waitFor(async () => (await client.getRun(run.id)).run.status === "completed", { timeoutMs: 5000 });
    const page = await fetch(`${app.url}/`);
    assert.equal(page.status, 200);
    await app.stop();
    await app.stop();
    await assert.rejects(access(join(dir, "data", "server.json")), "server.json is removed on stop");
    await assert.rejects(fetch(`${app.url}/v1/health`), "the server no longer listens");
  }
  assert.equal(tokens[0], tokens[1], "the generated token is kept in the data directory");
  assert.equal(lines.filter((line) => JSON.parse(line).msg === "app.started").length, 2);
  assert.equal(lines.filter((line) => JSON.parse(line).msg === "app.stopped").length, 2);
  for (const line of lines) assert.equal(line.includes(tokens[0]!), false, "the API token never reaches the log");
});

test("stop() before start() closes the store and start() after stop() does nothing", async (t) => {
  const dir = await makeTempDir(t, "runwright-app-");
  const app = await createApp({ config: await configFor(dir), env: {}, logWrite: () => undefined });
  await app.stop();
  await app.start();
  assert.equal(app.url, "");
  await assert.rejects(app.store.listAgents());
});

test("runner-only mode (server: false) claims and completes runs with no HTTP server", async (t) => {
  const dir = await makeTempDir(t, "runwright-app-");
  const app = await createApp({ config: await configFor(dir), env: {}, server: false, logWrite: () => undefined });
  t.after(() => app.stop({ graceMs: 100 }));
  await app.start();
  assert.equal(app.url, "");
  assert.ok(app.runner !== null);
  await assert.rejects(access(join(dir, "data", "server.json")), "no server.json without a server");
  const { agent } = await app.store.saveAgent({ id: "solo", definition: scriptedAgent({ name: "Solo", script: { turns: [{ text: "solo done" }] } }) });
  const { run } = await app.store.createRun({ agentId: agent.id, input: { message: "go", data: null } });
  const done = await waitFor(async () => {
    const current = await app.store.getRun(run.id);
    return current?.status === "completed" ? current : null;
  }, { timeoutMs: 5000 });
  assert.deepEqual(done.output, { text: "solo done" });
});

test("a server with the runner disabled reports no runner and leaves runs queued", async (t) => {
  const dir = await makeTempDir(t, "runwright-app-");
  const app = await createApp({ config: await configFor(dir, { runner: false }), env: {}, logWrite: () => undefined });
  t.after(() => app.stop());
  await app.start();
  assert.equal(app.runner, null);
  const client = createClient({ baseUrl: app.url, token: app.token });
  assert.equal((await client.ready())["runner"], null);
  const { agent } = await client.saveAgent(scriptedAgent({ name: "Idle", script: { turns: [{ text: "x" }] } }), "idle");
  const { run } = await client.startRun({ agentId: agent.id, message: "go" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await client.getRun(run.id)).run.status, "queued");
});

test("host tools are registered beside the built-in ones and usable by agents", async (t) => {
  const dir = await makeTempDir(t, "runwright-app-");
  const app = await createApp({ config: await configFor(dir), env: {}, tools: [echoTool], logWrite: () => undefined });
  t.after(() => app.stop());
  await app.start();
  const names = app.tools.list().map((tool) => tool.name);
  for (const name of ["host_echo", "read_file", "write_file", "ask_person", "web_fetch", "recall", "run_workflow"]) {
    assert.ok(names.includes(name), `${name} is registered`);
  }
  assert.equal(names.includes("shell"), false, "shell is off unless enabled");
  const client = createClient({ baseUrl: app.url, token: app.token });
  const { agent } = await client.saveAgent(scriptedAgent({
    name: "Echoer", tools: [{ name: "host_echo" }],
    script: { turns: [{ toolCalls: [{ name: "host_echo", args: { text: "hi" } }] }, { text: "{{last_result}}" }] },
  }), "echoer");
  const { run } = await client.startRun({ agentId: agent.id, message: "go" });
  const done = await waitFor(async () => {
    const current = (await client.getRun(run.id)).run;
    return current.status === "completed" ? current : null;
  }, { timeoutMs: 5000 });
  assert.deepEqual(done.output, { text: "echo: hi" });
});

test("a host tool clashing with a built-in name is refused and the store is closed", async (t) => {
  const dir = await makeTempDir(t, "runwright-app-");
  const clash: ToolDefinition = { ...echoTool, name: "read_file" };
  await assert.rejects(
    createApp({ config: await configFor(dir), env: {}, tools: [clash], logWrite: () => undefined }),
    (error: unknown) => isRunwrightError(error) && error.code === "bad_request",
  );
  const app = await createApp({ config: await configFor(dir), env: {}, logWrite: () => undefined });
  await app.stop();
});

test("start() on a taken port listens on the next free one", async (t) => {
  const dir = await makeTempDir(t, "runwright-app-");
  const blocker = createNetServer();
  const taken = await listen(blocker, 0);
  t.after(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
  const config = await configFor(dir);
  config.server.port = taken;
  config.server.portSearch = 20;
  const app = await createApp({ config, env: {}, logWrite: () => undefined });
  t.after(() => app.stop());
  await app.start();
  const port = Number(new URL(app.url).port);
  assert.ok(port > taken && port <= taken + 20, `listening on ${port}, ${taken} was taken`);
  assert.equal((await createClient({ baseUrl: app.url, token: app.token }).health()).status, "ok");
});

test("the default console path points at the shipped console page", () => {
  assert.ok(DEFAULT_CONSOLE_PATH.endsWith(join("src", "console", "index.html")));
});

/** A port that was free a moment ago (bound on port 0, then closed). */
async function freePort(): Promise<number> {
  const probe = createNetServer();
  const port = await listen(probe, 0);
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** Resolves true when a TCP connection to the port is refused, false when one is accepted. */
function refused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
  });
}

test("a start that fails after the socket is bound leaves nothing listening and the store closed (C6)", async (t) => {
  const dir = await makeTempDir(t, "runwright-app-");
  const config = await configFor(dir);
  config.server.port = await freePort();
  config.server.portSearch = 0;
  const lines: string[] = [];
  const app = await createApp({ config, env: {}, logWrite: (line) => lines.push(line) });
  t.after(() => app.stop());
  // server.json cannot be written: listen() binds the port, then fails.
  await mkdir(join(dir, "data", "server.json"));
  await assert.rejects(app.start(), /EISDIR|illegal operation on a directory/);
  assert.equal(app.url, "");
  assert.equal(await refused(config.server.port), true, "no socket is left listening");
  await assert.rejects(app.store.listAgents(), /the store is closed/);
  await app.stop();
  await app.start();
  assert.equal(await refused(config.server.port), true, "a later start() does nothing");
  assert.equal(lines.filter((line) => JSON.parse(line).msg === "app.stopped").length, 1);
});

interface Calls { names: string[] }

function recordingParts(calls: Calls, fail: "listen" | "runner" | "scheduler" | null): AppPartWrappers {
  return {
    server: (server) => ({
      listen: async () => {
        calls.names.push("server.listen");
        if (fail === "listen") throw new Error("listen failed");
        return server.listen();
      },
      close: async () => {
        calls.names.push("server.close");
        return server.close();
      },
    }),
    runner: (runner) => ({
      ...runner,
      id: runner.id,
      start: () => {
        calls.names.push("runner.start");
        if (fail === "runner") throw new Error("runner failed");
        runner.start();
      },
      stop: async (options) => {
        calls.names.push("runner.stop");
        return runner.stop(options);
      },
      activeRunIds: () => runner.activeRunIds(),
    }),
    scheduler: (scheduler) => ({
      ...scheduler,
      start: () => {
        calls.names.push("scheduler.start");
        if (fail === "scheduler") throw new Error("scheduler failed");
        scheduler.start();
      },
      stop: async () => {
        calls.names.push("scheduler.stop");
        return scheduler.stop();
      },
    }),
  };
}

for (const fail of ["listen", "runner", "scheduler"] as const) {
  test(`a start that fails in the ${fail} step runs the whole shutdown and rejects with that error`, async (t) => {
    const dir = await makeTempDir(t, "runwright-app-");
    const config = await configFor(dir);
    config.server.port = await freePort();
    config.server.portSearch = 0;
    const calls: Calls = { names: [] };
    const app = await createApp({ config, env: {}, logWrite: () => undefined, wrap: recordingParts(calls, fail) });
    t.after(() => app.stop());
    await assert.rejects(app.start(), new RegExp(`${fail} failed`));
    const started = fail === "listen" ? ["server.listen"] : fail === "runner" ? ["server.listen", "runner.start"]
      : ["server.listen", "runner.start", "scheduler.start"];
    assert.deepEqual(calls.names, [...started, "scheduler.stop", "runner.stop", "server.close"]);
    assert.equal(app.url, "");
    assert.equal(await refused(config.server.port), true);
    await assert.rejects(app.store.listAgents(), /the store is closed/);
    await app.stop();
    assert.equal(calls.names.filter((name) => name === "server.close").length, 1, "stop() is idempotent");
  });
}

// ---- R14D-engine-01 (plan 2.8): a stop() during start() starts nothing more and waits for that start ----

/** Parts that record their calls; the server's listen() waits for `gate` before it binds. */
function gatedParts(calls: Calls, gate: Promise<void>): AppPartWrappers {
  const recorded = recordingParts(calls, null);
  return {
    ...recorded,
    server: (server) => ({
      listen: async () => {
        calls.names.push("server.listen");
        await gate;
        return server.listen();
      },
      close: async () => {
        calls.names.push("server.close");
        return server.close();
      },
    }),
  };
}

test("stop() while listen() is pending: start() rejects conflict, nothing else starts, everything is closed", async (t) => {
  const dir = await makeTempDir(t, "runwright-app-");
  const config = await configFor(dir);
  config.server.port = await freePort();
  config.server.portSearch = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const calls: Calls = { names: [] };
  const lines: string[] = [];
  const app = await createApp({ config, env: {}, logWrite: (line) => lines.push(line), wrap: gatedParts(calls, gate) });
  t.after(() => app.stop());
  const starting = app.start();
  const rejected = assert.rejects(starting, (error: unknown) => isRunwrightError(error) && error.code === "conflict"
    && error.message === "the app was stopped while it was starting");
  await waitFor(() => calls.names.includes("server.listen"));
  let stopped = false;
  const stopping = app.stop().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(stopped, false, "stop() waits for the pending start");
  assert.deepEqual(calls.names, ["server.listen"], "nothing is stopped before the start settled");
  open();
  await rejected;
  await stopping;
  assert.deepEqual(calls.names, ["server.listen", "scheduler.stop", "runner.stop", "server.close"], "the runner and the scheduler never started");
  assert.equal(app.url, "");
  assert.equal(await refused(config.server.port), true, "the socket the late listen() bound is closed");
  await assert.rejects(access(join(dir, "data", "server.json")));
  await assert.rejects(app.store.listAgents(), /the store is closed/);
  await app.stop();
  await app.start();
  assert.deepEqual(calls.names, ["server.listen", "scheduler.stop", "runner.stop", "server.close"], "a later stop() and start() do nothing");
  assert.equal(lines.filter((line) => JSON.parse(line).msg === "app.started").length, 0);
  assert.equal(lines.filter((line) => JSON.parse(line).msg === "app.start_failed").length, 0, "a stopped start is not reported as a failure");
});

test("stop() then start(): nothing starts", async (t) => {
  const dir = await makeTempDir(t, "runwright-app-");
  const calls: Calls = { names: [] };
  const app = await createApp({ config: await configFor(dir), env: {}, logWrite: () => undefined, wrap: recordingParts(calls, null) });
  await app.stop();
  await app.start();
  assert.deepEqual(calls.names, ["scheduler.stop", "runner.stop", "server.close"]);
});

test("start() twice at once starts once", async (t) => {
  const dir = await makeTempDir(t, "runwright-app-");
  const calls: Calls = { names: [] };
  const app = await createApp({ config: await configFor(dir), env: {}, logWrite: () => undefined, wrap: recordingParts(calls, null) });
  t.after(() => app.stop());
  await Promise.all([app.start(), app.start()]);
  await app.start();
  assert.deepEqual(calls.names, ["server.listen", "runner.start", "scheduler.start"]);
});
