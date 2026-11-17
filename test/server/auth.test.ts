import { test } from "node:test";
import assert from "node:assert/strict";
import type { ApiOperation } from "../../src/server/index.ts";
import { timingSafeEqual } from "node:crypto";
import type { DigestCompare } from "../../src/security/token.ts";
import { errorOf, startHandlerServer, startTestServer, testRoute } from "./support.ts";

const PUBLIC = new Set(["GET /", "GET /v1/health", "GET /v1/ready", "POST /v1/hooks/:id"]);

function concrete(path: string): string {
  return path.replace(/:[a-zA-Z]+/g, "x1").replace(/\*[a-zA-Z]+/, "notes.txt");
}

test("every bearer route answers 401 without a token, with a wrong one, a short one and one in the query", async (t) => {
  const s = await startTestServer(t);
  const operations: ApiOperation[] = (await s.client.describeApi()).operations;
  const bearer = operations.filter((op) => op.auth === "bearer");
  assert.deepEqual(
    operations.filter((op) => op.auth !== "bearer").map((op) => `${op.method} ${op.path}`).sort(),
    [...PUBLIC].sort(),
  );
  assert.ok(bearer.length > 50, `only ${bearer.length} bearer routes`);
  const wrongSameLength = s.token.replace(/^./, (c) => (c === "A" ? "B" : "A"));
  const variants: { name: string; headers: Record<string, string>; query: string }[] = [
    { name: "none", headers: {}, query: "" },
    { name: "wrong", headers: { Authorization: `Bearer ${wrongSameLength}` }, query: "" },
    { name: "short", headers: { Authorization: `Bearer ${s.token.slice(0, 10)}` }, query: "" },
    { name: "long", headers: { Authorization: `Bearer ${s.token}x` }, query: "" },
    { name: "basic", headers: { Authorization: `Basic ${s.token}` }, query: "" },
    { name: "query", headers: {}, query: `?token=${s.token}&access_token=${s.token}` },
    { name: "cookie", headers: { Cookie: `token=${s.token}` }, query: "" },
  ];
  for (const op of bearer) {
    for (const variant of variants) {
      const init: RequestInit = { method: op.method, headers: { ...variant.headers } };
      if (op.method === "POST" || op.method === "PUT" || op.method === "PATCH") {
        (init.headers as Record<string, string>)["Content-Type"] = "application/json";
        init.body = "{}";
      }
      const response = await fetch(`${s.url}${concrete(op.path)}${variant.query}`, init);
      const label = `${op.method} ${op.path} (${variant.name})`;
      assert.equal(response.status, 401, label);
      assert.equal(response.headers.get("www-authenticate"), "Bearer", label);
      assert.equal((await errorOf(response)).code, "unauthorized", label);
    }
  }
});

test("health, ready and the console work without a token", async (t) => {
  const s = await startTestServer(t);
  const health = await fetch(`${s.url}/v1/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok", version: "0.1.0-test" });
  const ready = await fetch(`${s.url}/v1/ready`);
  assert.equal(ready.status, 200);
  const body = (await ready.json()) as Record<string, unknown>;
  assert.equal(body["status"], "ready");
  assert.equal(body["schemaVersion"], s.store.schemaVersion);
  assert.equal(body["runner"], null);
  const page = await fetch(`${s.url}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /console/);
});

test("the right token is accepted", async (t) => {
  const s = await startTestServer(t);
  const response = await fetch(`${s.url}/v1/agents`, { headers: { Authorization: `Bearer ${s.token}` } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { agents: [] });
});

test("ready answers 503 when the store cannot be read", async (t) => {
  const s = await startTestServer(t);
  s.deps.store.getAgent = async () => {
    throw new Error("store gone");
  };
  const response = await fetch(`${s.url}/v1/ready`);
  assert.equal(response.status, 503);
  assert.equal((await errorOf(response)).code, "unavailable");
});

test("the request handler checks the bearer token with exactly one comparison of two 32-byte digests", async (t) => {
  const calls: { a: Buffer; b: Buffer }[] = [];
  const compareDigests: DigestCompare = (a, b) => {
    calls.push({ a, b });
    return timingSafeEqual(a, b);
  };
  const s = await startHandlerServer(t, [testRoute("/v1/probe", () => ({ ok: true }))], { compareDigests });
  const sameLength = s.token.slice(0, -1) + (s.token.endsWith("A") ? "B" : "A");
  const cases: { name: string; token: string; status: number }[] = [
    { name: "right", token: s.token, status: 200 },
    { name: "same length, wrong", token: sameLength, status: 401 },
    { name: "different length, wrong", token: `${s.token}xyz`, status: 401 },
  ];
  for (const { name, token, status } of cases) {
    calls.length = 0;
    const response = await fetch(`${s.url}/v1/probe`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, status, name);
    await response.body?.cancel();
    assert.equal(calls.length, 1, `${name}: one comparison per request`);
    assert.ok(Buffer.isBuffer(calls[0]!.a) && Buffer.isBuffer(calls[0]!.b), name);
    assert.equal(calls[0]!.a.length, 32, name);
    assert.equal(calls[0]!.b.length, 32, name);
  }
  const none = await fetch(`${s.url}/v1/probe`);
  assert.equal(none.status, 401);
  assert.equal((await errorOf(none)).code, "unauthorized");
});

test("the request handler's decision is the comparison's: a primitive that says equal lets a wrong token in", async (t) => {
  const s = await startHandlerServer(t, [testRoute("/v1/probe", () => ({ ok: true }))], { compareDigests: () => true });
  const response = await fetch(`${s.url}/v1/probe`, { headers: { Authorization: "Bearer not-the-token" } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  const refusing = await startHandlerServer(t, [testRoute("/v1/probe", () => ({ ok: true }))], { compareDigests: () => false });
  const refused = await fetch(`${refusing.url}/v1/probe`, { headers: { Authorization: `Bearer ${refusing.token}` } });
  assert.equal(refused.status, 401);
  await refused.body?.cancel();
});
