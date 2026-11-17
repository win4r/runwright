import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { idempotencyDigest } from "../../src/store/idempotency.ts";
import type { Store, TriggerRecord } from "../../src/store/types.ts";
import { signWebhook } from "../../src/triggers/webhook.ts";
import { openTestStore } from "../helpers/store.ts";
import { scanDatabase } from "../security/at-rest.ts";
import { authed, errorOf, rawRequest, startTestServer, testAgentDefinition, type TestServer } from "./support.ts";

const SECRET = "whsec-0123456789abcdef";

async function setup(t: import("node:test").TestContext, bodyBytes?: number): Promise<{ s: TestServer; triggerId: string }> {
  const s = await startTestServer(t, bodyBytes === undefined ? undefined : { configure: (c) => { c.server.bodyBytes = bodyBytes; } });
  await s.client.saveAgent(testAgentDefinition({ name: "A" }));
  await s.client.setSecret("HOOK_SECRET", SECRET);
  const trigger = await s.client.createTrigger({
    name: "Hook", kind: "webhook", agentId: "a", webhook: { secretName: "HOOK_SECRET" }, message: "handle the event",
    limits: { maxCostMicros: 25_000 },
  });
  return { s, triggerId: trigger.id };
}

interface DeliverOptions {
  /** The `X-Runwright-Delivery` header; none is sent when it is left out. */
  header?: string; secret?: string; timestampSec?: number; signature?: string;
}

/** A signed delivery body: a JSON object whose `delivery` member is the delivery id, then the payload. */
function hookBody(delivery: string, payload: Record<string, unknown> = {}): string {
  return JSON.stringify({ delivery, ...payload });
}

function deliver(s: TestServer, triggerId: string, body: string, options?: DeliverOptions): Promise<Response> {
  const timestamp = options?.timestampSec ?? Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Runwright-Timestamp": String(timestamp),
    "X-Runwright-Signature": options?.signature ?? signWebhook(options?.secret ?? SECRET, timestamp, Buffer.from(body)),
  };
  if (options?.header !== undefined) headers["X-Runwright-Delivery"] = options.header;
  return fetch(`${s.url}/v1/hooks/${triggerId}`, { method: "POST", body, headers });
}

async function accepted(response: Response): Promise<{ runId: string; duplicate: boolean }> {
  assert.equal(response.status, 202);
  return (await response.json()) as { runId: string; duplicate: boolean };
}

const BODY_MESSAGE = 'the signed body must be a JSON object with a "delivery" string of 1 to 128 visible ASCII characters';
const HEADER_MESSAGE = 'X-Runwright-Delivery does not match the "delivery" of the signed body';

test("a valid delivery starts one capped run whose data is the delivery id and the whole signed body", async (t) => {
  const { s, triggerId } = await setup(t);
  const body = (await accepted(await deliver(s, triggerId, hookBody("dlv-1", { event: "push", nested: { delivery: "inner" } }))));
  assert.equal(body.duplicate, false);
  const { run } = await s.client.getRun(body.runId);
  assert.equal(run.limits.maxCostMicros, 25_000);
  assert.deepEqual(run.trigger, { id: triggerId, kind: "webhook" });
  assert.deepEqual(run.input, {
    message: "handle the event",
    data: { delivery: "dlv-1", body: { delivery: "dlv-1", event: "push", nested: { delivery: "inner" } } },
  });
  assert.equal(run.idempotencyKey, idempotencyDigest(`webhook:${triggerId}:dlv-1`));
});

test("a bad signature or a stale timestamp is 401", async (t) => {
  const { s, triggerId } = await setup(t);
  const wrongSecret = await errorOf(await deliver(s, triggerId, hookBody("d"), { secret: "another-secret-value" }));
  assert.equal(wrongSecret.status, 401);
  assert.equal(wrongSecret.code, "webhook_signature");
  const garbage = await errorOf(await deliver(s, triggerId, hookBody("d"), { signature: "sha256=zz" }));
  assert.equal(garbage.code, "webhook_signature");
  const now = Math.floor(Date.now() / 1000);
  const tampered = await fetch(`${s.url}/v1/hooks/${triggerId}`, {
    method: "POST", body: hookBody("d", { a: 2 }),
    headers: { "X-Runwright-Timestamp": String(now), "X-Runwright-Signature": signWebhook(SECRET, now, Buffer.from(hookBody("d", { a: 1 }))) },
  });
  assert.equal(tampered.status, 401);
  await tampered.body?.cancel();
  const otherDelivery = await errorOf(await deliver(s, triggerId, hookBody("d-2"), { signature: signWebhook(SECRET, now, Buffer.from(hookBody("d-1"))), timestampSec: now }));
  assert.deepEqual([otherDelivery.status, otherDelivery.code], [401, "webhook_signature"], "the delivery id is signed: changing it breaks the signature");
  const stale = await errorOf(await deliver(s, triggerId, hookBody("d"), { timestampSec: Math.floor(Date.now() / 1000) - 3600 }));
  assert.equal(stale.status, 401);
  assert.equal(stale.code, "webhook_replay");
  assert.equal((await s.client.listRuns()).runs.length, 0);
});

test("the same delivery id twice returns the same run with duplicate: true; another delivery id is another run", async (t) => {
  const { s, triggerId } = await setup(t);
  const first = await accepted(await deliver(s, triggerId, hookBody("same-id", { n: 1 })));
  const second = await accepted(await deliver(s, triggerId, hookBody("same-id", { n: 1 })));
  assert.equal(second.runId, first.runId);
  assert.equal(second.duplicate, true);
  assert.equal((await s.client.listRuns()).runs.length, 1);
  const other = await accepted(await deliver(s, triggerId, hookBody("other-id", { n: 1 })));
  assert.notEqual(other.runId, first.runId);
  assert.equal(other.duplicate, false);
  assert.equal((await s.client.listRuns()).runs.length, 2);
});

test("(R14D-server-01) a captured delivery replayed with other X-Runwright-Delivery headers is refused and starts no run", async (t) => {
  const { s, triggerId } = await setup(t);
  const timestampSec = Math.floor(Date.now() / 1000);
  const body = hookBody("captured-1", { event: "deploy" });
  const signature = signWebhook(SECRET, timestampSec, Buffer.from(body));
  const first = await accepted(await deliver(s, triggerId, body, { timestampSec, signature, header: "captured-1" }));
  assert.equal(first.duplicate, false);
  for (let i = 0; i < 10; i++) {
    const replay = await errorOf(await deliver(s, triggerId, body, { timestampSec, signature, header: `forged-${i}` }));
    assert.deepEqual([replay.status, replay.code, replay.message], [400, "bad_request", HEADER_MESSAGE], `replay ${i}`);
  }
  assert.equal((await s.client.listRuns()).runs.length, 1, "ten replays with fresh headers started nothing");
  for (const header of [undefined, "captured-1", "  captured-1  ", "   "]) {
    const unchanged = await accepted(await deliver(s, triggerId, body, { timestampSec, signature, ...(header === undefined ? {} : { header }) }));
    assert.deepEqual(unchanged, { runId: first.runId, duplicate: true }, `header ${JSON.stringify(header)}`);
  }
  assert.deepEqual((await s.client.listRuns()).runs.map((r) => r.id), [first.runId]);
});

test("a redelivery by the sender (same delivery, new timestamp, new signature) is the same run", async (t) => {
  const { s, triggerId } = await setup(t);
  const now = Math.floor(Date.now() / 1000);
  const body = hookBody("sender-redelivery", { attempt: 1 });
  const first = await accepted(await deliver(s, triggerId, body, { timestampSec: now - 20 }));
  const again = await accepted(await deliver(s, triggerId, body, { timestampSec: now }));
  assert.deepEqual(again, { runId: first.runId, duplicate: true });
  const changedPayload = await accepted(await deliver(s, triggerId, hookBody("sender-redelivery", { attempt: 2 }), { timestampSec: now + 1 }));
  assert.deepEqual(changedPayload, { runId: first.runId, duplicate: true }, "the delivery id alone decides");
  assert.equal((await s.client.listRuns()).runs.length, 1);
});

/** Signed bodies that parse but carry no usable delivery id. */
const BAD_BODIES: ReadonlyArray<[string, string]> = [
  ["an array", '[{"delivery":"d"}]'],
  ["a string", '"d"'],
  ["a number", "42"],
  ["null", "null"],
  ["an object without delivery", '{"event":"push"}'],
  ["delivery only nested", '{"payload":{"delivery":"d"}}'],
  ["delivery a number", '{"delivery":7}'],
  ["delivery null", '{"delivery":null}'],
  ["delivery an array", '{"delivery":["d"]}'],
  ["delivery empty", '{"delivery":""}'],
  ["delivery of 129 characters", JSON.stringify({ delivery: "x".repeat(129) })],
  ["delivery with a space", '{"delivery":"has space"}'],
  ["delivery with a non-ASCII character", JSON.stringify({ delivery: "caf\u00e9" })],
  ["delivery with a control character", JSON.stringify({ delivery: "a\tb" })],
];

test("a signed body that is not an object with a valid delivery string is 400 bad_request and starts no run", async (t) => {
  const { s, triggerId } = await setup(t);
  for (const [label, body] of BAD_BODIES) {
    const refused = await errorOf(await deliver(s, triggerId, body));
    assert.deepEqual([refused.status, refused.code, refused.message], [400, "bad_request", BODY_MESSAGE], label);
  }
  const edge = await accepted(await deliver(s, triggerId, JSON.stringify({ delivery: "~".repeat(128) })));
  assert.equal(edge.duplicate, false, "128 visible ASCII characters are accepted");
  assert.equal((await s.client.listRuns()).runs.length, 1);
});

test("a __proto__ delivery has no own delivery member and is refused", async (t) => {
  const { s, triggerId } = await setup(t);
  const refused = await errorOf(await deliver(s, triggerId, '{"__proto__":{"delivery":"x"}}'));
  assert.equal(refused.status, 400);
  assert.equal(refused.code, "invalid_json", "the strict parser refuses a __proto__ key before the delivery is read");
  const unsigned = await errorOf(await deliver(s, triggerId, '{"__proto__":{"delivery":"x"}}', { signature: "sha256=" + "0".repeat(64) }));
  assert.equal(unsigned.code, "webhook_signature");
  assert.equal((await s.client.listRuns()).runs.length, 0);
});

test("an unsigned or wrongly signed request gets the signature error first, whatever its body and header", async (t) => {
  const { s, triggerId } = await setup(t);
  const bodies = [...BAD_BODIES.map(([, body]) => body), '{"a":1,"a":2}', "not json", hookBody("valid-id")];
  for (const body of bodies) {
    for (const header of [undefined, "valid-id", "mismatch"]) {
      const extra = header === undefined ? {} : { header };
      const wrong = await errorOf(await deliver(s, triggerId, body, { secret: "another-secret-value", ...extra }));
      assert.deepEqual([wrong.status, wrong.code], [401, "webhook_signature"], `wrong secret: ${body}`);
      const unsigned = await fetch(`${s.url}/v1/hooks/${triggerId}`, {
        method: "POST", body, headers: { "Content-Type": "application/json", ...(header === undefined ? {} : { "X-Runwright-Delivery": header }) },
      });
      const failure = await errorOf(unsigned);
      assert.deepEqual([failure.status, failure.code], [401, "webhook_signature"], `unsigned: ${body}`);
      const stale = await errorOf(await deliver(s, triggerId, body, { timestampSec: Math.floor(Date.now() / 1000) - 3600, ...extra }));
      assert.deepEqual([stale.status, stale.code], [401, "webhook_replay"], `stale: ${body}`);
    }
  }
  assert.equal((await s.client.listRuns()).runs.length, 0);
});

test("a body that is not strict JSON is invalid_json; unknown and non-webhook triggers are 404", async (t) => {
  const { s, triggerId } = await setup(t);
  const badJson = await errorOf(await deliver(s, triggerId, '{"delivery":"d","a":1,"a":2}'));
  assert.equal(badJson.status, 400);
  assert.equal(badJson.code, "invalid_json");
  assert.equal((await errorOf(await deliver(s, triggerId, "{\"delivery\":"))).code, "invalid_json");
  assert.equal((await errorOf(await deliver(s, "trg_nope", hookBody("d")))).status, 404);
  const cron = await s.client.createTrigger({
    name: "C", kind: "cron", agentId: "a", cron: { expression: "* * * * *" }, message: "m", limits: { maxCostMicros: 1 },
  });
  assert.equal((await errorOf(await deliver(s, cron.id, hookBody("d")))).status, 404);
  assert.equal((await s.client.listRuns()).runs.length, 0);
});

test("the API description says the delivery id is the body's delivery and the header is optional", async (t) => {
  const { s } = await setup(t);
  const operation = (await s.client.describeApi()).operations.find((op) => op.id === "hooks.receive");
  assert.ok(operation !== undefined);
  assert.equal(operation.auth, "signature");
  assert.match(operation.summary, /"delivery" string is the delivery id/);
  assert.match(operation.summary, /X-Runwright-Delivery is optional and must match it/);
});

test("a disabled trigger is 409, a missing secret 503, an oversize body 413", async (t) => {
  const { s, triggerId } = await setup(t, 2048);
  await s.client.updateTrigger(triggerId, { enabled: false });
  const disabled = await errorOf(await deliver(s, triggerId, hookBody("d-disabled")));
  assert.equal(disabled.status, 409);
  assert.equal(disabled.code, "trigger_disabled");
  await s.client.updateTrigger(triggerId, { enabled: true });

  const big = hookBody("big", { pad: "x".repeat(4000) });
  const timestamp = Math.floor(Date.now() / 1000);
  const oversize = await rawRequest(s.url, {
    method: "POST", path: `/v1/hooks/${triggerId}`, body: big,
    headers: {
      "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(big)), "X-Runwright-Timestamp": String(timestamp),
      "X-Runwright-Signature": signWebhook(SECRET, timestamp, Buffer.from(big)),
    },
  });
  assert.equal(oversize.status, 413);

  await s.client.deleteSecret("HOOK_SECRET");
  const missing = await errorOf(await deliver(s, triggerId, hookBody("d-missing")));
  assert.equal(missing.status, 503);
  assert.equal(missing.code, "unavailable");
  assert.ok(s.logLines.some((l) => l.includes("webhook secret is missing")));
  assert.equal((await s.client.listRuns()).runs.length, 0);
});

test("a delivery whose payload or delivery id carries a named secret is stored redacted and still deduplicated", async (t) => {
  const { s, triggerId } = await setup(t);
  const named = "named-tool-secret-0042";
  await s.client.setSecret("TOOL_KEY", named);
  await s.client.saveAgent(testAgentDefinition({ name: "A", secrets: ["TOOL_KEY"] }));
  const body = JSON.stringify({ delivery: `dlv-${named}`, token: named, [named]: [named] });
  const first = await accepted(await deliver(s, triggerId, body));
  const { run } = await s.client.getRun(first.runId);
  assert.deepEqual(run.input.data, {
    delivery: "dlv-[redacted]", body: { delivery: "dlv-[redacted]", token: "[redacted]", "[redacted]": ["[redacted]"] },
  });
  assert.ok(!JSON.stringify(run).includes(named), "the run row, its idempotency key included, holds no secret");
  const again = await accepted(await deliver(s, triggerId, body));
  assert.deepEqual(again, { runId: first.runId, duplicate: true });
  assert.ok(!JSON.stringify(await s.client.timeline(first.runId)).includes(named));
});

const DELIVERY_VALUE = "hook-delivery-value-0099";

test("a delivery id holding a value that becomes a secret afterwards: the redelivery is the same run", async (t) => {
  const { s, triggerId } = await setup(t);
  const delivery = `dlv-${DELIVERY_VALUE}`;
  const first = await accepted(await deliver(s, triggerId, hookBody(delivery, { n: 1 })));
  assert.equal(first.duplicate, false);
  await s.client.setSecret("DELIVERY_KEY", DELIVERY_VALUE);
  const again = await accepted(await deliver(s, triggerId, hookBody(delivery, { n: 1 })));
  assert.deepEqual(again, { runId: first.runId, duplicate: true });
  const runs = (await s.client.listRuns()).runs;
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.idempotencyKey, idempotencyDigest(`webhook:${triggerId}:${delivery}`));
});

test("a delivery id holding a secret that is deleted before a redelivery to a restarted process: the same run", async (t) => {
  const { store: raw, dir } = await openTestStore(t);
  const before = await startTestServer(t, { store: raw, dir });
  await before.client.saveAgent(testAgentDefinition({ name: "A" }));
  await before.client.setSecret("HOOK_SECRET", SECRET);
  await before.client.setSecret("DELIVERY_KEY", DELIVERY_VALUE);
  const trigger = await before.client.createTrigger({
    name: "Hook", kind: "webhook", agentId: "a", webhook: { secretName: "HOOK_SECRET" }, message: "handle the event",
    limits: { maxCostMicros: 25_000 },
  });
  const delivery = `dlv-${DELIVERY_VALUE}`;
  const first = await accepted(await deliver(before, trigger.id, hookBody(delivery, { n: 1 })));
  assert.equal(first.duplicate, false);
  assert.deepEqual(scanDatabase(join(dir, "runwright.db"), DELIVERY_VALUE, ["secrets"]), [], "the delivery id is stored redacted and digested");

  // Another process over the same database with another seal key: it cannot read the old values, so it knows none.
  const after = await startTestServer(t, { store: raw, dir });
  await after.client.setSecret("HOOK_SECRET", SECRET);
  assert.equal(after.secrets.redactText(DELIVERY_VALUE), DELIVERY_VALUE);
  await after.client.deleteSecret("DELIVERY_KEY");
  const again = await accepted(await deliver(after, trigger.id, hookBody(delivery, { n: 1 })));
  assert.deepEqual(again, { runId: first.runId, duplicate: true });
  assert.equal((await after.client.listRuns()).runs.length, 1);
});

test("a delivery that started a run is answered with that run after the trigger is turned off; a new delivery is 409", async (t) => {
  const { s, triggerId } = await setup(t);
  const started = await accepted(await deliver(s, triggerId, hookBody("before-off", { n: 1 })));
  assert.equal(started.duplicate, false);
  const firedAt = (await s.client.getTrigger(triggerId)).lastFiredAt;
  assert.ok(firedAt !== null);

  const patched = await authed(s, `/v1/triggers/${triggerId}`, { method: "PATCH", json: { enabled: false } });
  assert.equal(patched.status, 200);
  await patched.body?.cancel();
  const redelivered = await deliver(s, triggerId, hookBody("before-off", { n: 1 }), { timestampSec: Math.floor(Date.now() / 1000) + 1 });
  assert.equal(redelivered.status, 202);
  assert.deepEqual(await redelivered.json(), { runId: started.runId, duplicate: true });
  assert.equal((await s.client.getTrigger(triggerId)).lastFiredAt, firedAt, "a duplicate does not touch lastFiredAt");

  const fresh = await errorOf(await deliver(s, triggerId, hookBody("after-off", { n: 1 })));
  assert.equal(fresh.status, 409);
  assert.equal(fresh.code, "trigger_disabled");
  const manual = await errorOf(await authed(s, `/v1/triggers/${triggerId}/fire`, { method: "POST", json: {} }));
  assert.equal(manual.status, 409);
  assert.equal(manual.code, "trigger_disabled");
  assert.deepEqual((await s.client.listRuns()).runs.map((r) => r.id), [started.runId]);
});

type Change = (inner: Store, current: TriggerRecord) => Promise<void>;

/** (R08-01) A raw store whose getTrigger answers with the row and then, when armed, changes the trigger once. */
function changingAfterRead(inner: Store): { store: Store; arm(change: Change): void } {
  let pending: Change | null = null;
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "getTrigger") {
        return async (id: string) => {
          const row = await target.getTrigger(id);
          const change = pending;
          pending = null;
          if (change !== null && row !== null) await change(target, row);
          return row;
        };
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Store;
  return { store, arm: (change) => { pending = change; } };
}

async function changingSetup(t: import("node:test").TestContext) {
  const { store: inner, dir } = await openTestStore(t);
  const { store, arm } = changingAfterRead(inner);
  const s = await startTestServer(t, { store, dir });
  await s.client.saveAgent(testAgentDefinition({ name: "A" }));
  await s.client.setSecret("HOOK_SECRET", SECRET);
  await s.client.setSecret("NEW_HOOK_SECRET", "a-different-signing-secret");
  const trigger = await s.client.createTrigger({
    name: "Hook", kind: "webhook", agentId: "a", webhook: { secretName: "HOOK_SECRET" }, message: "handle the event",
    limits: { maxCostMicros: 25_000 },
  });
  return { s, inner, arm, triggerId: trigger.id };
}

const update = (patch: Partial<TriggerRecord>): Change => async (inner, current) => {
  assert.equal(await inner.updateTrigger({ ...current, ...patch }, current), "updated");
};

test("(R08-01) a delivery whose trigger is disabled, deleted or re-keyed right after the read starts nothing", async (t) => {
  const { s, inner, arm, triggerId } = await changingSetup(t);
  arm(update({ enabled: false }));
  const disabled = await errorOf(await deliver(s, triggerId, hookBody("d-off")));
  assert.deepEqual([disabled.status, disabled.code], [409, "trigger_disabled"]);
  await s.client.updateTrigger(triggerId, { enabled: true });

  arm(update({ webhook: { secretName: "NEW_HOOK_SECRET" } }));
  const rekeyed = await errorOf(await deliver(s, triggerId, hookBody("d-rekeyed")));
  assert.deepEqual([rekeyed.status, rekeyed.code], [401, "webhook_signature"], "verified again against the secret the trigger names now");
  assert.equal((await inner.getTrigger(triggerId))?.webhook?.secretName, "NEW_HOOK_SECRET");
  assert.equal((await s.client.listRuns()).runs.length, 0);

  arm(async (target, current) => {
    assert.equal(await target.deleteTrigger(current.id), true);
  });
  const gone = await errorOf(await deliver(s, triggerId, hookBody("d-gone"), { secret: "a-different-signing-secret" }));
  assert.deepEqual([gone.status, gone.code], [404, "not_found"]);
  assert.equal((await s.client.listRuns()).runs.length, 0);
  assert.equal(await inner.getTrigger(triggerId), null);
});

test("(R08-01) a delivery whose trigger is edited once after the read starts its run under the new definition", async (t) => {
  const { s, arm, triggerId } = await changingSetup(t);
  arm(update({ limits: { maxCostMicros: 5, maxToolCalls: null, maxTurns: null, allowUnpriced: false } }));
  const response = await deliver(s, triggerId, hookBody("d-edit", { n: 1 }));
  assert.equal(response.status, 202);
  const body = (await response.json()) as { runId: string; duplicate: boolean };
  assert.equal(body.duplicate, false);
  assert.equal((await s.client.getRun(body.runId)).run.limits.maxCostMicros, 5);

  for (const change of [update({ name: "Renamed", limits: { maxCostMicros: 4, maxToolCalls: null, maxTurns: null, allowUnpriced: false } }), update({ enabled: false })]) {
    arm(change);
    const again = await deliver(s, triggerId, hookBody("d-edit", { n: 1 }), { timestampSec: Math.floor(Date.now() / 1000) + 1 });
    assert.equal(again.status, 202);
    assert.deepEqual(await again.json(), { runId: body.runId, duplicate: true });
  }
  assert.equal((await s.client.listRuns()).runs.length, 1);
});
