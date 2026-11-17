import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { connect, createServer as createNetServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import type { Config } from "../../src/config/types.ts";
import { RunwrightError } from "../../src/core/errors.ts";
import { createServer, listenOn, type RunwrightServer, type ServerSeams } from "../../src/server/index.ts";
import type { Store } from "../../src/store/types.ts";
import { openTestStore } from "../helpers/store.ts";
import { seedRun, startTestServer, type TestServer } from "./support.ts";

/** A port that was free a moment ago: bound on port 0 by a probe socket, which is then closed. */
async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** Resolves "refused" when nothing accepts a TCP connection on the port, "accepted" otherwise. */
function tryConnect(port: number): Promise<"refused" | "accepted"> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve("accepted");
    });
    socket.once("error", () => resolve("refused"));
  });
}

test("a listen() whose server.json cannot be written rejects and leaves nothing listening; close() then resolves", async (t) => {
  const base = await startTestServer(t);
  const dataDir = join(base.dir, "second");
  await mkdir(join(dataDir, "server.json"), { recursive: true });
  const port = await freePort();
  const config = { ...base.config, dataDir, server: { ...base.config.server, host: "127.0.0.1", port, portSearch: 0 } };
  const server = createServer({ ...base.deps, config });
  await assert.rejects(server.listen(), (error: NodeJS.ErrnoException) => error.code === "EISDIR" || error.code === "EPERM" || error.code === "EEXIST");
  assert.equal(await tryConnect(port), "refused", "the socket was closed");
  await server.close();
  await server.close();
});

test("close() before any listen() resolves, and twice", async (t) => {
  const base = await startTestServer(t);
  const server = createServer(base.deps);
  await server.close();
  await server.close();
});

test("close() after a successful listen() frees the port; a closed server does not listen again", async (t) => {
  const base = await startTestServer(t);
  const port = await freePort();
  const server = createServer({ ...base.deps, config: { ...base.config, dataDir: join(base.dir, "third"), server: { ...base.config.server, host: "127.0.0.1", port, portSearch: 0 } } });
  await server.listen();
  assert.equal(await tryConnect(port), "accepted");
  await server.close();
  assert.equal(await tryConnect(port), "refused");
  await assert.rejects(server.listen(), { code: "conflict" });
});

// ------------------------------------------------------------- R14D-server-02: close() while listen() is pending

const ITERATIONS = 50;

interface Deferred { promise: Promise<void>; resolve: () => void }

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

function configFor(base: TestServer, dataDir: string, port: number, portSearch: number): Config {
  return { ...base.config, dataDir, server: { ...base.config.server, host: "127.0.0.1", port, portSearch } };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The outcome of a listen() whose result is taken at once, so a rejection is never unhandled. */
function outcomeOf(listening: Promise<{ url: string; port: number }>): Promise<"resolved" | unknown> {
  return listening.then(() => "resolved" as const, (error: unknown) => error);
}

/** After close() resolved: nothing accepts on the port, no server.json is left, listen() rejected conflict or resolved. */
async function assertClosed(server: RunwrightServer, port: number, dataDir: string, outcome: unknown, label: string): Promise<void> {
  assert.equal(await tryConnect(port), "refused", `${label}: nothing listens after close() resolved`);
  assert.equal(await exists(join(dataDir, "server.json")), false, `${label}: server.json is gone`);
  if (outcome !== "resolved") {
    assert.ok(outcome instanceof RunwrightError, `${label}: ${String(outcome)}`);
    assert.equal(outcome.code, "conflict", label);
    assert.equal(outcome.message, "the server was closed", label);
  }
  await server.close();
  await assert.rejects(server.listen(), { code: "conflict" }, `${label}: a closed server does not listen again`);
}

test("(R14D-server-02) close() called right after listen(), without awaiting it, leaves nothing listening and no server.json", async (t) => {
  const base = await startTestServer(t);
  for (let i = 0; i < ITERATIONS; i++) {
    const port = await freePort();
    const dataDir = join(base.dir, `sync-${i}`);
    const server = createServer({ ...base.deps, config: configFor(base, dataDir, port, 0) });
    const outcome = outcomeOf(server.listen());
    await server.close();
    await assertClosed(server, port, dataDir, await outcome, `iteration ${i}`);
  }
});

test("(R14D-server-02) close() during the bind, before or after the socket is bound, leaves nothing listening", async (t) => {
  const base = await startTestServer(t);
  for (const when of ["before", "after"] as const) {
    for (let i = 0; i < ITERATIONS; i++) {
      const port = await freePort();
      const dataDir = join(base.dir, `bind-${when}-${i}`);
      const reached = deferred();
      const release = deferred();
      const server = createServer({ ...base.deps, config: configFor(base, dataDir, port, 0) }, {
        async listenOn(srv, host, candidate) {
          if (when === "before") {
            reached.resolve();
            await release.promise;
            return listenOn(srv, host, candidate);
          }
          const bound = await listenOn(srv, host, candidate);
          reached.resolve();
          await release.promise;
          return bound;
        },
      });
      const outcome = outcomeOf(server.listen());
      await reached.promise;
      const closed = server.close();
      release.resolve();
      await closed;
      const result = await outcome;
      assert.notEqual(result, "resolved", `${when} ${i}: a listen() that close() overtook does not resolve`);
      await assertClosed(server, port, dataDir, result, `${when} ${i}`);
    }
  }
});

test("(R14D-server-02) close() between two candidate ports stops the port search", async (t) => {
  const base = await startTestServer(t);
  for (let i = 0; i < ITERATIONS; i++) {
    const blocker = createNetServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const taken = (blocker.address() as AddressInfo).port;
    const dataDir = join(base.dir, `search-${i}`);
    const reached = deferred();
    const release = deferred();
    const attempts: number[] = [];
    const server = createServer({ ...base.deps, config: configFor(base, dataDir, taken, 1) }, {
      async listenOn(srv, host, candidate) {
        attempts.push(candidate);
        try {
          return await listenOn(srv, host, candidate);
        } catch (error) {
          reached.resolve();
          await release.promise;
          throw error;
        }
      },
    });
    const outcome = outcomeOf(server.listen());
    await reached.promise;
    const closed = server.close();
    release.resolve();
    await closed;
    const result = await outcome;
    assert.deepEqual(attempts, [taken], `iteration ${i}: no second candidate was tried`);
    assert.ok(result instanceof RunwrightError && result.code === "conflict", `iteration ${i}: ${String(result)}`);
    await new Promise((resolve) => blocker.close(resolve));
    await assertClosed(server, taken, dataDir, result, `iteration ${i}`);
  }
});

type Step = "mkdir" | "before writeFile" | "after writeFile" | "chmod";

/** File seams that hold `listen()` at `step` (the real operation still runs) until `release` resolves. */
function heldAt(step: Step, reached: Deferred, release: Deferred): Partial<ServerSeams> {
  const hold = async (): Promise<void> => {
    reached.resolve();
    await release.promise;
  };
  return {
    async mkdir(path, options) {
      if (step === "mkdir") await hold();
      return mkdir(path, options);
    },
    async writeFile(path, data, options) {
      if (step === "before writeFile") await hold();
      await writeFile(path, data, options);
      if (step === "after writeFile") await hold();
    },
    async chmod(path, mode) {
      if (step === "chmod") await hold();
      await chmod(path, mode);
    },
  };
}

test("(R14D-server-02) close() while server.json is being published removes it and leaves nothing listening", async (t) => {
  const base = await startTestServer(t);
  for (const step of ["mkdir", "before writeFile", "after writeFile", "chmod"] as const) {
    for (let i = 0; i < ITERATIONS; i++) {
      const port = await freePort();
      const dataDir = join(base.dir, `publish-${step.replace(" ", "-")}-${i}`);
      const reached = deferred();
      const release = deferred();
      const server = createServer({ ...base.deps, config: configFor(base, dataDir, port, 0) }, heldAt(step, reached, release));
      const outcome = outcomeOf(server.listen());
      await reached.promise;
      assert.equal(await tryConnect(port), "accepted", `${step} ${i}: the socket is bound while the file is published`);
      const closed = server.close();
      release.resolve();
      await closed;
      const result = await outcome;
      assert.notEqual(result, "resolved", `${step} ${i}`);
      await assertClosed(server, port, dataDir, result, `${step} ${i}`);
    }
  }
});

test("a listen() whose publication fails while close() is pending rejects with conflict and close() still resolves", async (t) => {
  const base = await startTestServer(t);
  const port = await freePort();
  const dataDir = join(base.dir, "fail-while-closing");
  const reached = deferred();
  const release = deferred();
  const server = createServer({ ...base.deps, config: configFor(base, dataDir, port, 0) }, {
    async writeFile() {
      reached.resolve();
      await release.promise;
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    },
  });
  const outcome = outcomeOf(server.listen());
  await reached.promise;
  const closed = server.close();
  release.resolve();
  await closed;
  const result = await outcome;
  assert.ok(result instanceof RunwrightError && result.code === "conflict", String(result));
  assert.equal((result.cause as NodeJS.ErrnoException | undefined)?.code, "ENOSPC", "the failure is kept as the cause");
  assert.equal(await tryConnect(port), "refused");
  assert.equal(await exists(join(dataDir, "server.json")), false);
  await server.close();
});

test("an SSE stream opened after close() began ends at once and does not hold close() up", async (t) => {
  const { store: raw, dir } = await openTestStore(t);
  const reached = deferred();
  const release = deferred();
  let armed = false;
  const store = new Proxy(raw, {
    get(target, prop, receiver) {
      if (prop === "getRun") {
        return async (id: string) => {
          if (armed) {
            armed = false;
            reached.resolve();
            await release.promise;
          }
          return target.getRun(id);
        };
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Store;
  const s = await startTestServer(t, { store, dir });
  const run = await seedRun(s.store);
  armed = true;
  const response = fetch(`${s.url}/v1/runs/${run.id}/events`, { headers: { Authorization: `Bearer ${s.token}` } })
    .then(async (r) => ({ status: r.status, text: await r.text() }));
  await reached.promise;
  const started = performance.now();
  const closed = s.server.close();
  release.resolve();
  await closed;
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1000, `close() did not wait for the stream (${Math.round(elapsed)} ms)`);
  const { status, text } = await response;
  assert.equal(status, 200);
  assert.equal(text, "", "the stream ended at once, with nothing sent");
  assert.equal(await tryConnect(Number(new URL(s.url).port)), "refused");
});
