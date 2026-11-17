import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFile, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { errorOf, startTestServer } from "./support.ts";

test("GET / serves the console with a strict CSP and frame headers", async (t) => {
  const s = await startTestServer(t);
  const response = await fetch(`${s.url}/`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(
    response.headers.get("content-security-policy"),
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; " +
      "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(await response.text(), /<title>Runwright<\/title>/);
});

test("a changed console file is served fresh; a missing one is 503", async (t) => {
  const s = await startTestServer(t);
  await (await fetch(`${s.url}/`)).text();
  await writeFile(s.consolePath, "<!doctype html><p>second version, longer</p>");
  assert.match(await (await fetch(`${s.url}/`)).text(), /second version/);
  await unlink(s.consolePath);
  const missing = await fetch(`${s.url}/`);
  const error = await errorOf(missing);
  assert.equal(error.status, 503);
  assert.equal(error.code, "unavailable");
});

test("server.json is written with mode 0600 while listening and removed on close", async (t) => {
  const s = await startTestServer(t);
  const path = `${s.dir}/server.json`;
  const info = JSON.parse(await readFile(path, "utf8")) as { url: string; pid: number; startedAt: number };
  assert.equal(info.url, s.url);
  assert.equal(info.pid, process.pid);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await s.server.close();
  await assert.rejects(stat(path));
});

test("the served console pages through open pendings and names the cap", async (t) => {
  const s = await startTestServer(t);
  await copyFile(fileURLToPath(new URL("../../src/console/index.html", import.meta.url)), s.consolePath);
  const page = await (await fetch(`${s.url}/`)).text();
  assert.match(page, /const NEEDS_CAP = 2000;/);
  assert.match(page, /"\/v1\/pendings" \+ query\(\{ status: "open", limit: NEEDS_PAGE, cursor \}\)/);
  assert.match(page, /res\.data\.nextCursor/);
  assert.match(page, /"Showing the oldest " \+ NEEDS_CAP \+ "; more are waiting\."/);
});
