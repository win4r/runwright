import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "../helpers/tmp.ts";
import { startTestServer } from "../server/support.ts";
import { cli, cliServer, parsed } from "./support.ts";

test("finds the server from server.json and the token file in --data-dir", async (t) => {
  const s = await cliServer(t);
  const elsewhere = await makeTempDir(t);
  const result = await cli(["agents", "list", "--data-dir", s.dir], { dataDir: elsewhere });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(parsed(result), { agents: [] });
});

test("--url and --token, and RUNWRIGHT_URL / RUNWRIGHT_TOKEN, override the data directory", async (t) => {
  const s = await startTestServer(t);
  const empty = await makeTempDir(t);
  const flags = await cli(["agents", "list", "--url", s.url, "--token", s.token], { dataDir: empty });
  assert.equal(flags.code, 0, flags.stdout + flags.stderr);
  const env = await cli(["agents", "list"], { dataDir: empty, env: { RUNWRIGHT_URL: s.url, RUNWRIGHT_TOKEN: s.token } });
  assert.equal(env.code, 0, env.stdout + env.stderr);
  const wrongToken = await cli(["agents", "list", "--url", s.url, "--token", "not-the-token"], { dataDir: empty });
  assert.equal(wrongToken.code, 1);
  assert.equal(parsed<{ error: { code: string } }>(wrongToken).error.code, "unauthorized");
  const flagBeatsEnv = await cli(["agents", "list", "--token", s.token], { dataDir: empty, env: { RUNWRIGHT_URL: s.url, RUNWRIGHT_TOKEN: "stale" } });
  assert.equal(flagBeatsEnv.code, 0);
});

test("waits for a server that starts 300 ms later", async (t) => {
  const s = await startTestServer(t);
  const dir = await makeTempDir(t);
  const started = Date.now();
  const pending = cli(["agents", "list", "--connect-timeout", "5"], { dataDir: dir });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await writeFile(join(dir, "token"), `${s.token}\n`, { mode: 0o600 });
  await writeFile(join(dir, "server.json"), await readFile(join(s.dir, "server.json"), "utf8"));
  const result = await pending;
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.ok(Date.now() - started >= 300);
});
