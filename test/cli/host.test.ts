import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { connect, createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { createApp } from "../../src/app/app.ts";
import { loadConfig } from "../../src/config/load.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import { hostApp, type HostedApp, type SignalSource } from "../../src/cli/commands/host.ts";
import { createContext, readGlobals, type CliIo, type CommandContext } from "../../src/cli/context.ts";
import { COMMANDS, defaultIo, processIo } from "../../src/cli/main.ts";
import { makeTempDir } from "../helpers/tmp.ts";

interface Fake { app: HostedApp; calls: string[]; finishStop: () => void }

function fakeApp(withRunner: boolean): Fake {
  const config = defaultConfig("/data/rw");
  config.runner.concurrency = 3;
  const calls: string[] = [];
  let finishStop: () => void = () => undefined;
  const app: HostedApp = {
    config, url: "http://127.0.0.1:7411", tokenPath: "/data/rw/token",
    runner: withRunner ? { id: "rnr_1", abandon: async () => void calls.push("abandon") } : null,
    start: async () => void calls.push("start"),
    stop: () => {
      calls.push("stop");
      return new Promise<void>((resolve) => {
        finishStop = resolve;
      });
    },
  };
  return { app, calls, get finishStop() { return finishStop; } };
}

function context(name: string, isTTY: boolean, exits?: number[]): { ctx: CommandContext; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const spec = COMMANDS.find((c) => c.name === name);
  assert.ok(spec !== undefined);
  const io: CliIo = { stdout: (text: string) => void out.push(text), stderr: (text: string) => void err.push(text), stdin: async () => "", env: {}, isTTY };
  if (exits !== undefined) io.exit = (code) => void exits.push(code);
  return { ctx: createContext({ io, spec, values: {}, positionals: [], globals: readGlobals({}, { RUNWRIGHT_DATA_DIR: "/data/rw" }, name) }), out, err };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("serve prints where the server is (never the token) and stops gracefully on the first signal", async () => {
  const fake = fakeApp(true);
  const signals = new EventEmitter();
  const { ctx, out } = context("serve", true);
  const exit = hostApp(ctx, fake.app, "server", signals as SignalSource);
  await tick();
  assert.equal(out.join(""), [
    "Runwright is running at http://127.0.0.1:7411",
    "Console: http://127.0.0.1:7411/",
    "API token file: /data/rw/token",
    "Data directory: /data/rw",
    "Runner: in-process, concurrency 3",
    "",
  ].join("\n"));
  signals.emit("SIGTERM");
  await tick();
  assert.deepEqual(fake.calls, ["start", "stop"]);
  fake.finishStop();
  assert.equal(await exit, 0);
  assert.equal(signals.listenerCount("SIGINT") + signals.listenerCount("SIGTERM"), 0, "listeners are removed");
});

test("a second signal while stopping abandons the runner and exits 1", async () => {
  const fake = fakeApp(true);
  const signals = new EventEmitter();
  const { ctx, err } = context("serve", true);
  const exit = hostApp(ctx, fake.app, "server", signals as SignalSource);
  await tick();
  signals.emit("SIGINT");
  signals.emit("SIGINT");
  assert.equal(await exit, 1);
  assert.deepEqual(fake.calls, ["start", "stop", "abandon"]);
  assert.match(err.join(""), /Stopping at once/);
});

test("serve without a runner says how to start one; JSON mode prints one object", async () => {
  const fake = fakeApp(false);
  const signals = new EventEmitter();
  const { ctx, out } = context("serve", false);
  const exit = hostApp(ctx, fake.app, "server", signals as SignalSource);
  await tick();
  assert.deepEqual(JSON.parse(out.join("")), { url: "http://127.0.0.1:7411", tokenPath: "/data/rw/token", dataDir: "/data/rw", runner: null });
  signals.emit("SIGINT");
  fake.finishStop();
  assert.equal(await exit, 0);

  const human = fakeApp(false);
  const second = context("serve", true);
  const exit2 = hostApp(second.ctx, human.app, "server", signals as SignalSource);
  await tick();
  assert.match(second.out.join(""), /^Runner: none \(start one with: runwright runner\)$/m);
  signals.emit("SIGINT");
  human.finishStop();
  assert.equal(await exit2, 0);
});

test("runner mode prints its id and data directory", async () => {
  const fake = fakeApp(true);
  const signals = new EventEmitter();
  const { ctx, out } = context("runner", true);
  const exit = hostApp(ctx, fake.app, "runner", signals as SignalSource);
  await tick();
  assert.equal(out.join(""), "Runner rnr_1 started on /data/rw\n");
  signals.emit("SIGTERM");
  fake.finishStop();
  assert.equal(await exit, 0);
});

test("serve flags are checked before anything starts", async () => {
  const { main } = await import("../../src/cli/main.ts");
  const err: string[] = [];
  const io = { stdout: () => undefined, stderr: (text: string) => void err.push(text), stdin: async () => "", env: { RUNWRIGHT_DATA_DIR: "/nonexistent-rw" }, isTTY: true };
  assert.equal(await main(["serve", "--port", "70000"], io), 2);
  assert.equal(await main(["--port", "abc"], io), 2);
  assert.equal(await main(["serve", "--concurrency", "0"], io), 2);
  assert.match(err.join(""), /Usage: runwright serve/);
});

// ---- A second signal ends the process (R13D-cli-01, C7); a failed start is cleaned up (C6) ----

test("first signal stops; a second abandons the runner, then calls exit(1) exactly once and resolves 1", async () => {
  const fake = fakeApp(true);
  const signals = new EventEmitter();
  const exits: number[] = [];
  const { ctx, err } = context("serve", true, exits);
  const order: string[] = [];
  const abandon = fake.app.runner?.abandon;
  (fake.app as { runner: HostedApp["runner"] }).runner = {
    id: "rnr_1",
    abandon: async () => {
      await abandon?.();
      order.push("abandoned");
    },
  };
  const exit = hostApp(ctx, fake.app, "server", signals as SignalSource);
  await tick();
  signals.emit("SIGTERM");
  await tick();
  assert.deepEqual(fake.calls, ["start", "stop"]);
  assert.deepEqual(exits, [], "the first signal never exits");
  signals.emit("SIGTERM");
  signals.emit("SIGTERM");
  const code = await exit;
  await tick();
  assert.equal(code, 1);
  assert.deepEqual(fake.calls, ["start", "stop", "abandon"]);
  assert.deepEqual(order, ["abandoned"]);
  assert.deepEqual(exits, [1]);
  fake.finishStop();
  await tick();
  assert.deepEqual(exits, [1], "a graceful stop that finishes later changes nothing");
  assert.match(err.join(""), /Stopping at once/);
});

test("exit is called only after abandon has settled", async () => {
  const fake = fakeApp(true);
  const signals = new EventEmitter();
  const exits: number[] = [];
  let release: () => void = () => undefined;
  (fake.app as { runner: HostedApp["runner"] }).runner = { id: "rnr_1", abandon: () => new Promise<void>((resolve) => { release = resolve; }) };
  const { ctx } = context("serve", true, exits);
  const exit = hostApp(ctx, fake.app, "server", signals as SignalSource);
  await tick();
  signals.emit("SIGINT");
  signals.emit("SIGINT");
  await tick();
  assert.deepEqual(exits, [], "still fencing");
  release();
  assert.equal(await exit, 1);
  assert.deepEqual(exits, [1]);
});

test("a second signal without a runner still exits 1; a single signal never calls exit", async () => {
  const lone = fakeApp(false);
  const signals = new EventEmitter();
  const exits: number[] = [];
  const { ctx } = context("serve", true, exits);
  const exit = hostApp(ctx, lone.app, "server", signals as SignalSource);
  await tick();
  signals.emit("SIGINT");
  signals.emit("SIGINT");
  assert.equal(await exit, 1);
  assert.deepEqual(exits, [1]);

  const graceful = fakeApp(true);
  const calm: number[] = [];
  const second = context("serve", true, calm);
  const done = hostApp(second.ctx, graceful.app, "server", signals as SignalSource);
  await tick();
  signals.emit("SIGTERM");
  graceful.finishStop();
  assert.equal(await done, 0);
  assert.deepEqual(calm, []);
});

test("a start that fails is stopped once and its error propagates; a failing stop does not hide it", async () => {
  for (const stopFails of [false, true]) {
    const calls: string[] = [];
    const startError = new Error("port in use");
    const app: HostedApp = {
      config: defaultConfig("/data/rw"), url: "", tokenPath: "/data/rw/token", runner: null,
      start: async () => {
        calls.push("start");
        throw startError;
      },
      stop: async () => {
        calls.push("stop");
        if (stopFails) throw new Error("stop failed too");
      },
    };
    const signals = new EventEmitter();
    const exits: number[] = [];
    const { ctx, out } = context("serve", true, exits);
    await assert.rejects(hostApp(ctx, app, "server", signals as SignalSource), (error) => error === startError);
    assert.deepEqual(calls, ["start", "stop"]);
    assert.deepEqual(out, [], "nothing is announced");
    assert.deepEqual(exits, []);
    assert.equal(signals.listenerCount("SIGINT") + signals.listenerCount("SIGTERM"), 0);
  }
});

test("the io built for the real process ends it with process.exit; a test's own io never does", () => {
  assert.equal(processIo().exit, process.exit);
  assert.equal(defaultIo(undefined).exit, process.exit);
  assert.equal(defaultIo({ stdout: () => undefined }).exit, undefined);
  const exit = (_code: number): void => undefined;
  assert.equal(defaultIo({ exit }).exit, exit);
});

test("bin/runwright.ts hands main the real process io", async () => {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(new URL("../../bin/runwright.ts", import.meta.url), "utf8");
  assert.match(text, /main\(process\.argv\.slice\(2\), processIo\(\)\)/);
});

// ---- R14D-engine-01: a signal while app.start() is pending stops the app through the normal stop path ----

test("a signal during a pending start stops the app: no banner, exit 0, listeners removed, the real app closed", async (t) => {
  const dir = await makeTempDir(t, "runwright-host-");
  const config = await loadConfig({ env: {}, overrides: { dataDir: join(dir, "data"), port: 0, leaseMs: 400, pollMs: 20 } });
  const probe = createNetServer();
  const port = await new Promise<number>((resolve) => probe.listen(0, "127.0.0.1", () => resolve((probe.address() as { port: number }).port)));
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  config.server.port = port;
  config.server.portSearch = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let listening = false;
  const started: string[] = [];
  const app = await createApp({
    config, env: {}, logWrite: () => undefined,
    wrap: {
      server: (server) => ({
        listen: async () => {
          listening = true;
          await gate;
          return server.listen();
        },
        close: () => server.close(),
      }),
      runner: (runner) => ({ ...runner, id: runner.id, start: () => void started.push("runner"), activeRunIds: () => runner.activeRunIds() }),
      scheduler: (scheduler) => ({ ...scheduler, start: () => void started.push("scheduler") }),
    },
  });
  t.after(() => app.stop());
  const signals = new EventEmitter();
  const exits: number[] = [];
  const { ctx, out, err } = context("serve", true, exits);
  const exit = hostApp(ctx, app, "server", signals as SignalSource);
  await new Promise<void>((resolve) => {
    const poll = (): void => (listening ? resolve() : void setTimeout(poll, 2));
    poll();
  });
  signals.emit("SIGTERM");
  open();
  assert.equal(await exit, 0);
  assert.deepEqual(out, [], "nothing is announced");
  assert.deepEqual(exits, []);
  assert.deepEqual(started, [], "neither the runner nor the scheduler started");
  assert.match(err.join(""), /Stopping/);
  assert.doesNotMatch(err.join(""), /error/);
  assert.equal(signals.listenerCount("SIGINT") + signals.listenerCount("SIGTERM"), 0);
  const refused = await new Promise<boolean>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
  });
  assert.equal(refused, true, "nothing is listening");
  await assert.rejects(app.store.listAgents(), /the store is closed/);
});

test("a signal during a start that then resolves anyway: no banner, the stop's exit code", async () => {
  const calls: string[] = [];
  let finishStart: () => void = () => undefined;
  const app: HostedApp = {
    config: defaultConfig("/data/rw"), url: "http://127.0.0.1:7411", tokenPath: "/data/rw/token", runner: null,
    start: () => {
      calls.push("start");
      return new Promise<void>((resolve) => {
        finishStart = resolve;
      });
    },
    stop: async () => void calls.push("stop"),
  };
  const signals = new EventEmitter();
  const { ctx, out } = context("serve", true);
  const exit = hostApp(ctx, app, "server", signals as SignalSource);
  await tick();
  signals.emit("SIGINT");
  finishStart();
  assert.equal(await exit, 0);
  assert.deepEqual(calls, ["start", "stop"]);
  assert.deepEqual(out, []);
  assert.equal(signals.listenerCount("SIGINT") + signals.listenerCount("SIGTERM"), 0);
});
