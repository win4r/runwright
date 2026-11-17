/**
 * Brief, section 4, "Security", checked against wrong implementations the existing tests would let through
 * (finding class R09D-tests-01). The webhook route is tested over HTTP:
 * - a replay window applied in the route with the wrong unit or the wrong bound passes a test that only sends a
 *   timestamp an hour old; here deliveries a few seconds inside and outside the configured window are sent, in
 *   the past and in the future;
 * - a body limit that only looks at `Content-Length` passes the existing oversize test (which declares it); here
 *   the oversize hook body is sent chunked, with no `Content-Length`, and must start no run;
 * - a dedupe key taken from anything the signature does not cover lets a captured delivery start more runs
 *   (R14D-server-01); here a captured request is replayed with fresh `X-Runwright-Delivery` headers.
 * Every delivery carries its delivery id as the `delivery` member of the signed JSON body.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { signWebhook } from "../../src/triggers/webhook.ts";
import { errorOf, rawRequest, startTestServer, testAgentDefinition, type TestServer } from "../server/support.ts";

const SECRET = "whsec-audit-0123456789";
const WINDOW_SEC = 60;
const MARGIN_SEC = 5;

async function hookServer(t: TestContext, bodyBytes?: number): Promise<{ s: TestServer; triggerId: string }> {
  const s = await startTestServer(t, {
    configure: (config) => {
      config.triggers.webhookWindowSec = WINDOW_SEC;
      if (bodyBytes !== undefined) config.server.bodyBytes = bodyBytes;
    },
  });
  await s.client.saveAgent(testAgentDefinition({ name: "A" }));
  await s.client.setSecret("AUDIT_HOOK", SECRET);
  const trigger = await s.client.createTrigger({
    name: "Audit hook", kind: "webhook", agentId: "a", webhook: { secretName: "AUDIT_HOOK" }, message: "handle it",
    limits: { maxCostMicros: 10_000 },
  });
  return { s, triggerId: trigger.id };
}

function hookBody(delivery: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ delivery, ...payload });
}

function deliver(s: TestServer, triggerId: string, body: string, timestampSec: number, options?: { header?: string; signature?: string }): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Runwright-Timestamp": String(timestampSec),
    "X-Runwright-Signature": options?.signature ?? signWebhook(SECRET, timestampSec, Buffer.from(body)),
  };
  if (options?.header !== undefined) headers["X-Runwright-Delivery"] = options.header;
  return fetch(`${s.url}/v1/hooks/${triggerId}`, { method: "POST", body, headers });
}

test("over HTTP, a delivery signed with another secret, or whose body was changed after signing, is 401 and starts nothing", async (t) => {
  const { s, triggerId } = await hookServer(t);
  const now = Math.floor(Date.now() / 1000);
  const body = hookBody("signed-1", { n: 1 });
  const otherSecret = await errorOf(await deliver(s, triggerId, body, now, { signature: signWebhook("not-the-audit-secret", now, Buffer.from(body)) }));
  assert.deepEqual([otherSecret.status, otherSecret.code], [401, "webhook_signature"]);
  const signature = signWebhook(SECRET, now, Buffer.from(body));
  for (const changed of [hookBody("signed-1", { n: 2 }), hookBody("signed-2", { n: 1 })]) {
    const refused = await errorOf(await deliver(s, triggerId, changed, now, { signature }));
    assert.deepEqual([refused.status, refused.code], [401, "webhook_signature"], changed);
  }
  assert.equal((await s.client.listRuns()).runs.length, 0);
  const genuine = await deliver(s, triggerId, body, now, { signature });
  assert.equal(genuine.status, 202, "the same signature over the original body is accepted");
  await genuine.body?.cancel();
});

test("over HTTP, a delivery a few seconds inside the replay window is accepted, past or future", async (t) => {
  const { s, triggerId } = await hookServer(t);
  const now = Math.floor(Date.now() / 1000);
  const inside = WINDOW_SEC - MARGIN_SEC;
  const runIds: string[] = [];
  for (const [label, ts] of [["past", now - inside], ["future", now + inside]] as const) {
    const response = await deliver(s, triggerId, hookBody(`inside-${label}`, { edge: label }), ts);
    assert.equal(response.status, 202, label);
    const body = (await response.json()) as { runId: string; duplicate: boolean };
    assert.equal(body.duplicate, false);
    runIds.push(body.runId);
  }
  assert.equal(new Set(runIds).size, 2);
  assert.equal((await s.client.listRuns()).runs.length, 2);
});

test("over HTTP, a correctly signed delivery a few seconds outside the replay window is refused and starts nothing", async (t) => {
  const { s, triggerId } = await hookServer(t);
  const now = Math.floor(Date.now() / 1000);
  const outside = WINDOW_SEC + MARGIN_SEC;
  for (const [label, ts] of [["past", now - outside], ["future", now + outside]] as const) {
    const refused = await errorOf(await deliver(s, triggerId, hookBody(`outside-${label}`, { edge: label }), ts));
    assert.equal(refused.status, 401, label);
    assert.equal(refused.code, "webhook_replay", label);
  }
  assert.equal((await s.client.listRuns()).runs.length, 0);
  // The same deliveries become acceptable when re-signed with a fresh timestamp, so only the window refused them.
  const fresh = await deliver(s, triggerId, hookBody("outside-past", { edge: "past" }), Math.floor(Date.now() / 1000));
  assert.equal(fresh.status, 202);
  await fresh.body?.cancel();
});

test("a redelivery with the same delivery id but another body and timestamp returns the first run and creates none", async (t) => {
  const { s, triggerId } = await hookServer(t);
  const now = Math.floor(Date.now() / 1000);
  const first = (await (await deliver(s, triggerId, hookBody("same", { n: 1 }), now)).json()) as { runId: string; duplicate: boolean };
  const again = (await (await deliver(s, triggerId, hookBody("same", { n: 2 }), now - 10)).json()) as { runId: string; duplicate: boolean };
  assert.equal(first.duplicate, false);
  assert.deepEqual(again, { runId: first.runId, duplicate: true });
  const runs = (await s.client.listRuns()).runs;
  assert.deepEqual(runs.map((r) => r.id), [first.runId]);
  assert.deepEqual(runs[0]?.input.data, { delivery: "same", body: { delivery: "same", n: 1 } }, "the first delivery's run is unchanged");
});

test("(R14D-server-01) a captured delivery replayed with fresh X-Runwright-Delivery headers is 400 and starts no second run", async (t) => {
  const { s, triggerId } = await hookServer(t);
  const now = Math.floor(Date.now() / 1000);
  const body = hookBody("captured", { action: "deploy" });
  const signature = signWebhook(SECRET, now, Buffer.from(body));
  const first = (await (await deliver(s, triggerId, body, now, { signature })).json()) as { runId: string; duplicate: boolean };
  assert.equal(first.duplicate, false);
  for (const header of ["replay-1", "replay-2", "replay-3"]) {
    const replay = await errorOf(await deliver(s, triggerId, body, now, { signature, header }));
    assert.deepEqual([replay.status, replay.code], [400, "bad_request"], header);
  }
  const unchanged = (await (await deliver(s, triggerId, body, now, { signature, header: "captured" })).json()) as { runId: string; duplicate: boolean };
  assert.deepEqual(unchanged, { runId: first.runId, duplicate: true }, "replayed unchanged it is the same delivery");
  assert.deepEqual((await s.client.listRuns()).runs.map((r) => r.id), [first.runId]);
});

test("an oversize webhook body sent chunked, without Content-Length, is 413 and starts no run", async (t) => {
  const { s, triggerId } = await hookServer(t, 2048);
  const chunks = Array.from({ length: 16 }, (_, i) => Buffer.from(`${i === 0 ? '{"delivery":"chunked-big","pad":[' : ","}"${"p".repeat(500)}"`));
  chunks.push(Buffer.from("]}"));
  const whole = Buffer.concat(chunks);
  const ts = Math.floor(Date.now() / 1000);
  const response = await rawRequest(s.url, {
    method: "POST", path: `/v1/hooks/${triggerId}`, chunks,
    headers: {
      "Content-Type": "application/json", "Transfer-Encoding": "chunked", "X-Runwright-Timestamp": String(ts),
      "X-Runwright-Signature": signWebhook(SECRET, ts, whole),
    },
  });
  assert.equal(response.status, 413);
  assert.equal(JSON.parse(response.body).error.code, "body_too_large");
  assert.equal((await s.client.listRuns()).runs.length, 0);

  const small = Buffer.from('{"delivery":"chunked-small","ok":true}');
  const accepted = await rawRequest(s.url, {
    method: "POST", path: `/v1/hooks/${triggerId}`, chunks: [small.subarray(0, 4), small.subarray(4)],
    headers: {
      "Content-Type": "application/json", "Transfer-Encoding": "chunked", "X-Runwright-Timestamp": String(ts),
      "X-Runwright-Signature": signWebhook(SECRET, ts, small), "X-Runwright-Delivery": "chunked-small",
    },
  });
  assert.equal(accepted.status, 202, "a chunked body under the limit is read whole and verified");
  assert.equal((await s.client.listRuns()).runs.length, 1);
});
