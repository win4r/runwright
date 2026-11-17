import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RunwrightError } from "../../src/core/errors.ts";
import { discoverServer } from "../../src/client/discover.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { startTestServer } from "../server/support.ts";

/** A loopback port that nothing listens on. */
async function deadPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("server.json and the token file in the data directory are found", async (t) => {
  const s = await startTestServer(t);
  await writeFile(join(s.dir, "token"), `${s.token}\n`, { mode: 0o600 });
  const found = await discoverServer({ dataDir: s.dir, env: {} });
  assert.deepEqual(found, { baseUrl: s.url, token: s.token });
  const viaEnv = await discoverServer({ env: { RUNWRIGHT_DATA_DIR: s.dir } });
  assert.equal(viaEnv.baseUrl, s.url);
});

test("RUNWRIGHT_URL and RUNWRIGHT_TOKEN override the files; options override the environment", async (t) => {
  const s = await startTestServer(t);
  const empty = await makeTempDir(t);
  const fromEnv = await discoverServer({ dataDir: empty, env: { RUNWRIGHT_URL: `${s.url}/`, RUNWRIGHT_TOKEN: "env-token" } });
  assert.deepEqual(fromEnv, { baseUrl: s.url, token: "env-token" });
  const fromOptions = await discoverServer({ dataDir: empty, url: s.url, token: "opt-token", env: { RUNWRIGHT_URL: "http://127.0.0.1:1", RUNWRIGHT_TOKEN: "env-token" } });
  assert.deepEqual(fromOptions, { baseUrl: s.url, token: "opt-token" });
});

test("no server answering within the timeout is unavailable", async (t) => {
  const empty = await makeTempDir(t);
  const started = Date.now();
  const error = await discoverServer({ dataDir: empty, env: {}, timeoutMs: 250 }).catch((e: unknown) => e);
  assert.ok(error instanceof RunwrightError);
  assert.equal(error.code, "unavailable");
  assert.ok(Date.now() - started >= 200);
  const port = await deadPort();
  const dead = await discoverServer({ dataDir: empty, env: {}, url: `http://127.0.0.1:${port}`, token: "t", timeoutMs: 200 }).catch((e: unknown) => e);
  assert.ok(dead instanceof RunwrightError);
  assert.equal(dead.code, "unavailable");
});

test("a stale server.json (dead process or dead port) is treated as not running", async (t) => {
  const dir = await makeTempDir(t);
  const port = await deadPort();
  await writeFile(join(dir, "token"), "tok\n");
  await writeFile(join(dir, "server.json"), JSON.stringify({ url: `http://127.0.0.1:${port}`, pid: process.pid, startedAt: 0 }));
  const deadPortError = await discoverServer({ dataDir: dir, env: {}, timeoutMs: 200 }).catch((e: unknown) => e);
  assert.ok(deadPortError instanceof RunwrightError && deadPortError.code === "unavailable");

  const s = await startTestServer(t);
  await writeFile(join(dir, "server.json"), JSON.stringify({ url: s.url, pid: 2 ** 22 + 12345, startedAt: 0 }));
  const deadPid = await discoverServer({ dataDir: dir, env: {}, timeoutMs: 200 }).catch((e: unknown) => e);
  assert.ok(deadPid instanceof RunwrightError && deadPid.code === "unavailable", "a server.json whose process is gone is ignored");
});

test("a server that starts while discovery is waiting is found", async (t) => {
  const s = await startTestServer(t);
  const dir = await makeTempDir(t);
  await writeFile(join(dir, "token"), "tok\n");
  const pending = discoverServer({ dataDir: dir, env: {}, timeoutMs: 3000 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  await writeFile(join(dir, "server.json"), JSON.stringify({ url: s.url, pid: process.pid, startedAt: Date.now() }));
  assert.deepEqual(await pending, { baseUrl: s.url, token: "tok" });
});

test("a server without a token anywhere is reported clearly", async (t) => {
  const s = await startTestServer(t);
  const dir = await makeTempDir(t);
  const error = await discoverServer({ dataDir: dir, env: {}, url: s.url, timeoutMs: 500 }).catch((e: unknown) => e);
  assert.ok(error instanceof RunwrightError);
  assert.equal(error.code, "unavailable");
  assert.match(error.message, /token/);
});

test("an invalid timeoutMs is bad_request before anything is probed", async (t) => {
  const dir = await makeTempDir(t, "runwright-discover-");
  for (const timeoutMs of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    const error = await discoverServer({ dataDir: dir, env: {}, timeoutMs }).then(() => null, (e: unknown) => e);
    assert.ok(error instanceof RunwrightError, String(timeoutMs));
    assert.equal(error.code, "bad_request", String(timeoutMs));
  }
});

test("a health probe that stalls is cut at the time left, so discovery ends near its deadline", { timeout: 5000 }, async (t) => {
  const stalled = createServer(() => undefined);
  const sockets = new Set<import("node:net").Socket>();
  stalled.on("connection", (socket) => sockets.add(socket));
  await new Promise<void>((resolve) => stalled.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => stalled.close(resolve));
  });
  const address = stalled.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const started = Date.now();
  const error = await discoverServer({ url: `http://127.0.0.1:${port}`, token: "t", env: {}, timeoutMs: 200 }).then(() => null, (e: unknown) => e);
  assert.ok(error instanceof RunwrightError);
  assert.equal(error.code, "unavailable");
  assert.ok(Date.now() - started < 800, `took ${Date.now() - started} ms; a full 1 s probe would overrun the deadline`);
});
