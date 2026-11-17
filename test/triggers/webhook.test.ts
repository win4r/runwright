import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { RunwrightError } from "../../src/core/errors.ts";
import { signWebhook, verifyWebhook } from "../../src/triggers/webhook.ts";

const SECRET = "whsec-test-signing-secret";
/** A delivery body as the route expects it: the delivery id is its `delivery` member, inside the signed bytes. */
const BODY = new TextEncoder().encode('{"delivery":"dlv-1","event":"push","n":1}');
const NOW_MS = Date.UTC(2026, 0, 1, 12, 0, 0);
const TS = Math.floor(NOW_MS / 1000);

function verify(overrides: Partial<Parameters<typeof verifyWebhook>[0]>): void {
  verifyWebhook({
    secret: SECRET, timestamp: String(TS), signature: signWebhook(SECRET, TS, BODY), body: BODY,
    nowMs: NOW_MS, windowSec: 300, ...overrides,
  });
}

function rejectsWith(code: "webhook_signature" | "webhook_replay", fn: () => void): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof RunwrightError);
    assert.equal(error.code, code);
    assert.ok(!error.message.includes(SECRET));
    return true;
  });
}

test("signWebhook is sha256=<hex HMAC over timestamp.body>", () => {
  const expected = createHmac("sha256", SECRET).update(`${TS}.`).update(BODY).digest("hex");
  assert.equal(signWebhook(SECRET, TS, BODY), `sha256=${expected}`);
});

test("a correctly signed, fresh delivery verifies", () => {
  assert.doesNotThrow(() => verify({}));
  assert.doesNotThrow(() => verify({ signature: signWebhook(SECRET, TS, BODY).toUpperCase().replace("SHA256=", "sha256=") }));
  assert.doesNotThrow(() => verify({ body: new Uint8Array(), signature: signWebhook(SECRET, TS, new Uint8Array()) }));
});

test("a wrong secret, an altered body or an altered timestamp is refused", () => {
  rejectsWith("webhook_signature", () => verify({ signature: signWebhook("another-secret", TS, BODY) }));
  rejectsWith("webhook_signature", () => verify({ body: new TextEncoder().encode('{"delivery":"dlv-1","event":"push","n":2}') }));
  rejectsWith("webhook_signature", () => verify({ timestamp: String(TS + 1) }));
  rejectsWith("webhook_signature", () => verify({ signature: signWebhook(SECRET, TS + 1, BODY) }));
});

test("the delivery id is covered by the signature: a body with another delivery does not verify", () => {
  for (const other of ['{"delivery":"dlv-2","event":"push","n":1}', '{"delivery":"dlv-1 ","event":"push","n":1}', '{"event":"push","n":1}']) {
    rejectsWith("webhook_signature", () => verify({ body: new TextEncoder().encode(other) }));
  }
  const redelivered = TS + 60;
  assert.doesNotThrow(
    () => verify({ timestamp: String(redelivered), signature: signWebhook(SECRET, redelivered, BODY), nowMs: NOW_MS + 60_000 }),
    "the sender's redelivery signs the same body again with a new timestamp",
  );
});

test("timestamps are accepted up to the window edge and refused beyond it, past or future", () => {
  for (const offset of [-300, 300, -299, 0]) {
    const ts = TS + offset;
    assert.doesNotThrow(() => verify({ timestamp: String(ts), signature: signWebhook(SECRET, ts, BODY) }), String(offset));
  }
  for (const offset of [-301, 301, -86_400]) {
    const ts = TS + offset;
    rejectsWith("webhook_replay", () => verify({ timestamp: String(ts), signature: signWebhook(SECRET, ts, BODY) }));
  }
  rejectsWith("webhook_replay", () => verify({ nowMs: NOW_MS + 300_001 }));
  assert.doesNotThrow(() => verify({ nowMs: NOW_MS + 300_000 }));
});

test("missing or malformed headers are webhook_signature, never a RangeError", () => {
  const good = signWebhook(SECRET, TS, BODY);
  rejectsWith("webhook_signature", () => verify({ timestamp: undefined }));
  rejectsWith("webhook_signature", () => verify({ signature: undefined }));
  for (const timestamp of ["", "abc", "12.5", "-5", "1e9", "9".repeat(20)]) {
    rejectsWith("webhook_signature", () => verify({ timestamp }));
  }
  for (const signature of ["", good.slice("sha256=".length), "sha1=" + good.slice(7), `${good}00`, good.slice(0, -2),
    "sha256=" + "z".repeat(64), "sha256="]) {
    rejectsWith("webhook_signature", () => verify({ signature }));
  }
});

type Call = { a: Buffer; b: Buffer };

function recording(result?: boolean): { calls: Call[]; compare: (a: Buffer, b: Buffer) => boolean } {
  const calls: Call[] = [];
  return {
    calls,
    compare: (a, b) => {
      calls.push({ a: Buffer.from(a), b: Buffer.from(b) });
      return result ?? (a.length === b.length && a.equals(b));
    },
  };
}

function wrongSignature(): string {
  const good = signWebhook(SECRET, TS, BODY);
  const last = good.at(-1) === "0" ? "1" : "0";
  return good.slice(0, -1) + last;
}

test("a correct, a wrong and an other-body signature each compare exactly once, two 32-byte digests", () => {
  const otherBody = new TextEncoder().encode('{"delivery":"dlv-1","event":"push","n":3}');
  const cases: Array<{ name: string; signature: string; accepted: boolean }> = [
    { name: "correct", signature: signWebhook(SECRET, TS, BODY), accepted: true },
    { name: "wrong", signature: wrongSignature(), accepted: false },
    { name: "other body", signature: signWebhook(SECRET, TS, otherBody), accepted: false },
  ];
  for (const c of cases) {
    const rec = recording();
    if (c.accepted) {
      assert.doesNotThrow(() => verify({ signature: c.signature, compare: rec.compare }), c.name);
    } else {
      rejectsWith("webhook_signature", () => verify({ signature: c.signature, compare: rec.compare }));
    }
    assert.equal(rec.calls.length, 1, c.name);
    const call = rec.calls[0];
    assert.ok(call !== undefined);
    assert.equal(call.a.length, 32, c.name);
    assert.equal(call.b.length, 32, c.name);
    const presentedHex = c.signature.slice("sha256=".length).toLowerCase();
    const expectedHex = signWebhook(SECRET, TS, BODY).slice("sha256=".length);
    const sides = [call.a.toString("hex"), call.b.toString("hex")].sort();
    assert.deepEqual(sides, [presentedHex, expectedHex].sort(), c.name);
  }
});

test("malformed signature, missing timestamp and out-of-window timestamp are refused before any comparison", () => {
  const rec = recording(true);
  rejectsWith("webhook_signature", () => verify({ signature: "sha256=" + "z".repeat(64), compare: rec.compare }));
  rejectsWith("webhook_signature", () => verify({ signature: "sha256=abcd", compare: rec.compare }));
  rejectsWith("webhook_signature", () => verify({ signature: undefined, compare: rec.compare }));
  rejectsWith("webhook_signature", () => verify({ timestamp: undefined, compare: rec.compare }));
  rejectsWith("webhook_signature", () => verify({ timestamp: "12.5", compare: rec.compare }));
  const late = TS - 301;
  rejectsWith("webhook_replay", () => verify({ timestamp: String(late), signature: signWebhook(SECRET, late, BODY), compare: rec.compare }));
  const early = TS + 301;
  rejectsWith("webhook_replay", () => verify({ timestamp: String(early), signature: "sha256=" + "0".repeat(64), compare: rec.compare }));
  assert.equal(rec.calls.length, 0);
});

test("the comparison primitive alone decides: an always-true compare accepts a wrong well-formed signature", () => {
  const yes = recording(true);
  assert.doesNotThrow(() => verify({ signature: wrongSignature(), compare: yes.compare }));
  assert.doesNotThrow(() => verify({ signature: "sha256=" + "0".repeat(64), compare: yes.compare }));
  assert.equal(yes.calls.length, 2);
  const no = recording(false);
  rejectsWith("webhook_signature", () => verify({ compare: no.compare }));
  assert.equal(no.calls.length, 1);
});
