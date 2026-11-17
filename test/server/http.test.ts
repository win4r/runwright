import { test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { RunwrightError } from "../../src/core/errors.ts";
import { startTestApp } from "../fixtures/app.ts";
import { scriptedAgent, waitForStatus } from "../fixtures/runs.ts";
import { authed, errorOf, rawRequest, startHandlerServer, startTestServer, testAgentDefinition, testRoute } from "./support.ts";

test("a declared Content-Length over the limit is refused with 413 before the body is read", async (t) => {
  const s = await startTestServer(t, { configure: (c) => { c.server.bodyBytes = 1024; } });
  const response = await rawRequest(s.url, {
    method: "POST", path: "/v1/agents",
    headers: { Authorization: `Bearer ${s.token}`, "Content-Type": "application/json", "Content-Length": "5000" },
    body: "x".repeat(5000),
  });
  assert.equal(response.status, 413);
  assert.equal(JSON.parse(response.body).error.code, "body_too_large");
  assert.equal(response.headers["connection"], "close");
});

test("a streamed body that grows past the limit is refused with 413", async (t) => {
  const s = await startTestServer(t, { configure: (c) => { c.server.bodyBytes = 1024; } });
  const chunks = Array.from({ length: 8 }, () => Buffer.from(`"${"a".repeat(300)}",`));
  const response = await rawRequest(s.url, {
    method: "POST", path: "/v1/agents",
    headers: { Authorization: `Bearer ${s.token}`, "Content-Type": "application/json", "Transfer-Encoding": "chunked" },
    chunks: [Buffer.from("["), ...chunks],
  });
  assert.equal(response.status, 413);
  assert.equal(JSON.parse(response.body).error.code, "body_too_large");
});

test("a client that keeps writing after its streamed body passed the limit still reads the 413", async (t) => {
  const s = await startTestServer(t, { configure: (c) => { c.server.bodyBytes = 1024; } });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const chunks = Array.from({ length: 40 }, () => Buffer.from(`"${"b".repeat(500)}",`));
    const response = await rawRequest(s.url, {
      method: "POST", path: "/v1/agents",
      headers: { Authorization: `Bearer ${s.token}`, "Content-Type": "application/json", "Transfer-Encoding": "chunked" },
      chunks: [Buffer.from("["), ...chunks, Buffer.from('""]')],
    });
    assert.equal(response.status, 413, `attempt ${attempt}`);
    assert.equal(JSON.parse(response.body).error.code, "body_too_large");
    assert.equal(response.headers["connection"], "close");
  }
});

test("a streamed body that passes the limit and then stalls is answered 413 without waiting for its end", async (t) => {
  const s = await startTestServer(t, { configure: (c) => { c.server.bodyBytes = 1024; } });
  const target = new URL(s.url);
  const socket = connect(Number(target.port), target.hostname);
  t.after(() => socket.destroy());
  const head = [
    "POST /v1/agents HTTP/1.1", `Host: ${target.host}`, `Authorization: Bearer ${s.token}`,
    "Content-Type: application/json", "Transfer-Encoding: chunked", "", "",
  ].join("\r\n");
  const chunk = `"${"c".repeat(3000)}"`;
  socket.write(`${head}${Buffer.byteLength(chunk).toString(16)}\r\n${chunk}\r\n`);
  const reply = await new Promise<string>((resolve, reject) => {
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", (part: string) => { text += part; });
    socket.on("close", () => resolve(text));
    socket.on("error", reject);
  });
  assert.match(reply, /^HTTP\/1\.1 413 /);
  assert.match(reply, /"code":"body_too_large"/);
});

test("a body under the limit is accepted", async (t) => {
  const s = await startTestServer(t, { configure: (c) => { c.server.bodyBytes = 4096; } });
  const response = await authed(s, "/v1/workflows/validate", { method: "POST", json: { document: { padding: "x".repeat(1000) } } });
  assert.equal(response.status, 200);
});

test("malformed JSON, duplicate keys, __proto__ and trailing text are invalid_json", async (t) => {
  const s = await startTestServer(t);
  for (const text of ['{"definition": ', '{"a": 1, "a": 2}', '{"__proto__": {}}', '{"a": 1} x', "{'a': 1}"]) {
    const response = await authed(s, "/v1/agents", { method: "POST", body: text, headers: { "Content-Type": "application/json" } });
    const error = await errorOf(response);
    assert.equal(error.status, 400, text);
    assert.equal(error.code, "invalid_json", text);
  }
});

test("a top level that is not an object is bad_request", async (t) => {
  const s = await startTestServer(t);
  for (const text of ["[]", "1", '"x"', "null"]) {
    const response = await authed(s, "/v1/agents", { method: "POST", body: text, headers: { "Content-Type": "application/json" } });
    const error = await errorOf(response);
    assert.equal(error.status, 400, text);
    assert.equal(error.code, "bad_request", text);
  }
});

test("a body without the JSON content type is refused with 415", async (t) => {
  const s = await startTestServer(t);
  const response = await authed(s, "/v1/agents", { method: "POST", body: "{}", headers: { "Content-Type": "text/plain" } });
  const error = await errorOf(response);
  assert.equal(error.status, 415);
  assert.equal(error.code, "bad_request");
});

test("schema violations are validation_failed with the problem paths", async (t) => {
  const s = await startTestServer(t);
  const response = await authed(s, "/v1/runs", { method: "POST", json: { agentId: 7, limits: { maxTurns: -1 }, extra: true } });
  const error = await errorOf(response);
  assert.equal(error.status, 400);
  assert.equal(error.code, "validation_failed");
  const paths = (error.details?.["problems"] as { path: string }[]).map((p) => p.path);
  assert.ok(paths.includes("$.agentId"), paths.join(","));
  assert.ok(paths.includes("$.limits.maxTurns"), paths.join(","));
  assert.ok(paths.some((p) => p.includes("extra")), paths.join(","));
});

test("unknown routes are 404 and wrong methods 405 with Allow", async (t) => {
  const s = await startTestServer(t);
  const missing = await authed(s, "/v1/nothing-here");
  assert.equal((await errorOf(missing)).code, "not_found");
  assert.equal(missing.status, 404);
  const trailing = await authed(s, "/v1/agents/");
  assert.equal(trailing.status, 404);
  await trailing.body?.cancel();
  const wrong = await authed(s, "/v1/agents", { method: "DELETE" });
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.get("allow"), "GET, POST");
  assert.equal((await errorOf(wrong)).code, "method_not_allowed");
});

test("every response has the standard headers and one error shape", async (t) => {
  const s = await startTestServer(t);
  const responses = [
    await fetch(`${s.url}/v1/health`),
    await authed(s, "/v1/runs/run_missing"),
    await fetch(`${s.url}/v1/agents`),
    await authed(s, "/v1/runs", { method: "PATCH" }),
  ];
  const ids = new Set<string>();
  for (const response of responses) {
    const id = response.headers.get("x-request-id");
    assert.ok(id !== null && id.startsWith("req_"));
    ids.add(id);
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    const body = (await response.json()) as Record<string, unknown>;
    if (response.status >= 400) {
      assert.deepEqual(Object.keys(body), ["error"]);
      const error = body["error"] as Record<string, unknown>;
      assert.equal(typeof error["code"], "string");
      assert.equal(typeof error["message"], "string");
    }
  }
  assert.equal(ids.size, responses.length);
});

test("the access log has one line per request, with no query, body or authorization", async (t) => {
  const s = await startTestServer(t);
  await authed(s, "/v1/runs?agentId=secretive-filter", { method: "GET" }).then((r) => r.text());
  await authed(s, "/v1/workflows/validate", { method: "POST", json: { document: { marker: "BODY-MARKER-123" } } }).then((r) => r.text());
  const access = s.logLines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((l) => l["msg"] === "http request");
  assert.equal(access.length, 2);
  assert.deepEqual(access.map((l) => l["path"]), ["/v1/runs", "/v1/workflows/validate"]);
  for (const line of access) {
    assert.equal(line["level"], "debug");
    assert.equal(typeof line["ms"], "number");
    assert.equal(typeof line["requestId"], "string");
  }
  const all = s.logLines.join("\n");
  assert.ok(!all.includes("secretive-filter"));
  assert.ok(!all.includes("BODY-MARKER-123"));
  assert.ok(!all.includes(s.token));
});

test("an unexpected error is a generic 500 internal and is logged", async (t) => {
  const s = await startTestServer(t);
  s.deps.store.listAgents = async () => {
    throw new Error("disk on fire");
  };
  const response = await authed(s, "/v1/agents");
  const error = await errorOf(response);
  assert.equal(error.status, 500);
  assert.equal(error.code, "internal");
  assert.ok(!error.message.includes("disk on fire"));
  assert.ok(s.logLines.some((l) => l.includes("disk on fire") && l.includes('"level":"error"')));
});

// Responses are redacted as values, then serialized: a numeric secret in a numeric field is replaced by the
// placeholder text and the body is still JSON.

const PIN = "12345678";

test("a run whose cap holds a stored numeric secret is answered as valid JSON without it", async (t) => {
  const s = await startTestServer(t);
  await s.secrets.set("PIN", PIN);
  await s.store.saveAgent({ id: "capped", definition: testAgentDefinition() });
  const { run } = await s.store.createRun({ agentId: "capped", input: { message: "go", data: null }, limits: { maxCostMicros: 12345678, maxTurns: 7 } });
  const response = await authed(s, `/v1/runs/${run.id}`);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(text.includes(PIN), false);
  const body = JSON.parse(text) as { run: { id: string; status: string; limits: Record<string, unknown>; agentId: string } };
  assert.equal(body.run.id, run.id);
  assert.equal(body.run.agentId, "capped");
  assert.equal(body.run.status, "queued");
  assert.equal(body.run.limits["maxCostMicros"], "[redacted]");
  assert.equal(body.run.limits["maxTurns"], 7);
  assert.equal(body.run.limits["allowUnpriced"], false);
  const stored = await s.store.getRun(run.id);
  assert.equal(stored?.limits.maxCostMicros, 12345678, "the stored cap is still the number");
});

test("an error body with a secret in its message and its details is redacted and parses", async (t) => {
  const s = await startTestServer(t);
  await s.secrets.set("PIN", PIN);
  await s.secrets.set("WORD", '"code":"x');
  const handler = await startHandlerServer(t, [
    testRoute("/v1/fails", () => {
      throw new RunwrightError("conflict", `pin ${PIN} and "code":"x clash`, { details: { pin: 12345678, [`k${PIN}`]: '"code":"x', ok: 3 } });
    }),
  ], { redact: (text) => s.secrets.redactText(text) });
  const response = await fetch(`${handler.url}/v1/fails`, { headers: { Authorization: `Bearer ${handler.token}` } });
  assert.equal(response.status, 409);
  const text = await response.text();
  assert.equal(text.includes(PIN), false);
  const body = JSON.parse(text) as { error: { code: string; message: string; details: Record<string, unknown> } };
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.equal(body.error.code, "conflict");
  assert.equal(body.error.message, "pin [redacted] and [redacted] clash");
  assert.deepEqual(body.error.details, { pin: "[redacted]", "k[redacted]": "[redacted]", ok: 3 });
});

test("a response body is serialized exactly as before when it holds no secret", async (t) => {
  const when = new Date(Date.UTC(2026, 0, 2));
  const value = { n: 1.5, list: [1, "a", null, true], none: undefined, nested: { when } };
  const handler = await startHandlerServer(t, [testRoute("/v1/plain", () => value)], { redact: (text) => text });
  const response = await fetch(`${handler.url}/v1/plain`, { headers: { Authorization: `Bearer ${handler.token}` } });
  assert.equal(await response.text(), JSON.stringify(value));
});

test("a redactor that throws while the body is redacted cuts the connection and the server keeps serving", async (t) => {
  let broken = true;
  const handler = await startHandlerServer(t, [testRoute("/v1/x", () => ({ a: "b" }))], {
    redact: (text) => {
      if (broken) throw new Error("redactor broke");
      return text;
    },
  });
  const failed = await fetch(`${handler.url}/v1/x`, { headers: { Authorization: `Bearer ${handler.token}` } }).then(() => "answered", () => "cut");
  assert.equal(failed, "cut");
  broken = false;
  const response = await fetch(`${handler.url}/v1/x`, { headers: { Authorization: `Bearer ${handler.token}` } });
  assert.deepEqual(await response.json(), { a: "b" });
});

test("the engine keeps its numeric cap when the cap is a stored secret, while the API shows the placeholder", { timeout: 30_000 }, async (t) => {
  const { client, app } = await startTestApp(t);
  await client.setSecret("PIN", PIN);
  // Worst case of the first call: 3 000 000 output tokens at 5 micro-dollars each, over 12 345 678 and under 22 345 678.
  const { agent } = await client.saveAgent(scriptedAgent({
    name: "Numeric cap", model: { maxOutputTokens: 3_000_000 }, script: { turns: [{ text: "done", usage: { inputTokens: 10, outputTokens: 2 } }] },
  }), "numeric-cap");
  const started = await client.startRun({ agentId: agent.id, message: "go", limits: { maxCostMicros: 12345678 } });
  assert.equal((started.run.limits as unknown as Record<string, unknown>)["maxCostMicros"], "[redacted]");
  const paused = await waitForStatus(client, started.run.id, ["waiting", "completed", "failed"]);
  assert.equal(paused.run.status, "waiting", "the run paused under its numeric cap");
  const pending = paused.pendings[0];
  assert.equal(pending?.kind, "spend_cap");
  assert.equal(pending?.detail["reason"], "cap");
  const raw = await fetch(`${app.url}/v1/runs/${started.run.id}`, { headers: { Authorization: `Bearer ${app.token}` } }).then((r) => r.text());
  assert.equal(raw.includes(PIN), false);
  assert.equal((JSON.parse(raw) as { run: { limits: Record<string, unknown> } }).run.limits["maxCostMicros"], "[redacted]");
  await client.setLimits(started.run.id, { maxCostMicros: 22345678 });
  const done = await waitForStatus(client, started.run.id, ["completed", "failed"]);
  assert.equal(done.run.status, "completed", "raising the cap by the numbers resumed the run");
  assert.equal(done.run.limits.maxCostMicros, 22345678);
  assert.equal(typeof done.run.usage.costMicros, "number");
});
