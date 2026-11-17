import { createHmac, timingSafeEqual } from "node:crypto";
import { RunwrightError } from "../core/errors.ts";
import type { DigestCompare } from "../security/token.ts";

/**
 * Webhook signatures: `X-Runwright-Timestamp: <unix seconds>` and
 * `X-Runwright-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>." + raw body)>`.
 * The delivery id is not a header: it is the `delivery` string of the signed JSON body, so the signature covers
 * it (the route `POST /v1/hooks/:id` reads it only after `verifyWebhook` accepted the body; an
 * `X-Runwright-Delivery` header is optional and must equal it).
 */
const SIGNATURE = /^sha256=([0-9a-fA-F]{64})$/;
const TIMESTAMP = /^\d{1,12}$/;

function digest(secret: string, timestamp: string, body: Uint8Array): Buffer {
  return createHmac("sha256", secret).update(`${timestamp}.`, "utf8").update(body).digest();
}

export function signWebhook(secret: string, timestampSec: number, body: Uint8Array): string {
  return `sha256=${digest(secret, String(Math.floor(timestampSec)), body).toString("hex")}`;
}

/**
 * Throws `webhook_signature` for a missing or ill-formed timestamp or signature, or a signature that does not
 * match; `webhook_replay` when the timestamp is more than `windowSec` from now. Every header check and the window
 * check come first; then the presented and expected 32-byte digests are compared exactly once with `compare`
 * (default `timingSafeEqual`, constant time), and that comparison alone decides the match.
 */
export function verifyWebhook(input: {
  secret: string; timestamp: string | undefined; signature: string | undefined;
  body: Uint8Array; nowMs: number; windowSec: number; compare?: DigestCompare;
}): void {
  const compare = input.compare ?? timingSafeEqual;
  const timestamp = input.timestamp?.trim();
  if (timestamp === undefined || !TIMESTAMP.test(timestamp)) {
    throw new RunwrightError("webhook_signature", "missing or malformed webhook timestamp header");
  }
  const match = SIGNATURE.exec(input.signature?.trim() ?? "");
  if (match === null) {
    throw new RunwrightError("webhook_signature", 'missing or malformed webhook signature header (expected "sha256=<hex>")');
  }
  const skewSec = Math.abs(input.nowMs / 1000 - Number(timestamp));
  if (skewSec > input.windowSec) {
    throw new RunwrightError("webhook_replay", `the webhook timestamp is outside the ${input.windowSec} s window`, {
      details: { windowSec: input.windowSec },
    });
  }
  const presented = Buffer.from(match[1] ?? "", "hex");
  const expected = digest(input.secret, timestamp, input.body);
  if (presented.length !== expected.length || !compare(presented, expected)) {
    throw new RunwrightError("webhook_signature", "the webhook signature does not match");
  }
}
