import { test } from "node:test";
import assert from "node:assert/strict";
import { RunwrightError } from "../../src/core/errors.ts";
import {
  DEFAULT_MAX_RETRY_AFTER_MS, MAX_WAIT_MS, attemptBilling, backoffDelayMs, cooldownLeftMs, errorRetryAfterMs, errorStatus,
  isRetryableStatus, parseRetryAfterMs, retryAfterLimitMs,
} from "../../src/models/retry.ts";
import { ControlSignal } from "../../src/engine/control.ts";

const policy = { maxAttempts: 5, baseMs: 100, maxMs: 1000 };

test("backoff doubles per attempt, is capped at maxMs, and jitter keeps it within [50%, 100%]", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((a) => backoffDelayMs(policy, a, () => 1, null)), [100, 200, 400, 800, 1000, 1000]);
  assert.deepEqual([1, 2, 3].map((a) => backoffDelayMs(policy, a, () => 0, null)), [50, 100, 200]);
  for (let i = 0; i < 50; i++) {
    const value = backoffDelayMs(policy, 3, Math.random, null);
    assert.ok(value >= 200 && value <= 400);
  }
  assert.equal(backoffDelayMs(policy, 1, () => 0, 2500), 2500, "retry-after is honoured as given");
  assert.equal(backoffDelayMs(policy, 1, () => 0, 999_999), 999_999, "a retry-after hint is never shortened");
});

test("attemptBilling is none only for a RunwrightError that says so; everything else may have been billed", () => {
  assert.equal(attemptBilling(new RunwrightError("model_transient", "429", { details: { status: 429, billing: "none" } })), "none");
  assert.equal(attemptBilling(new RunwrightError("model_failed", "400", { details: { status: 400, billing: "none" } })), "none");
  assert.equal(attemptBilling(new RunwrightError("model_transient", "cut", { details: { status: null, billing: "unknown" } })), "unknown");
  assert.equal(attemptBilling(new RunwrightError("model_failed", "no details")), "unknown");
  assert.equal(attemptBilling(new RunwrightError("model_failed", "odd", { details: { billing: "NONE" } })), "unknown");
  assert.equal(attemptBilling(new Error("plain")), "unknown");
  assert.equal(attemptBilling({ details: { billing: "none" } }), "unknown", "a look-alike object is not trusted");
  assert.equal(attemptBilling(new ControlSignal("paused")), "unknown");
  assert.equal(attemptBilling("text"), "unknown");
  assert.equal(attemptBilling(null), "unknown");
});

test("errorStatus and errorRetryAfterMs read the provider's details and nothing else", () => {
  const error = new RunwrightError("model_transient", "slow down", { details: { status: 429, retryAfterMs: 1500, billing: "none" } });
  assert.equal(errorStatus(error), 429);
  assert.equal(errorRetryAfterMs(error), 1500);
  const bare = new RunwrightError("model_transient", "net", { details: { status: null, retryAfterMs: null } });
  assert.equal(errorStatus(bare), null);
  assert.equal(errorRetryAfterMs(bare), null);
  assert.equal(errorRetryAfterMs(new RunwrightError("model_transient", "x", { details: { retryAfterMs: -5 } })), null);
  assert.equal(errorStatus(new Error("plain")), null);
  assert.equal(errorRetryAfterMs(new Error("plain")), null);
});

test("the retry-after hint read from headers drives the backoff", () => {
  const now = Date.UTC(2026, 0, 1);
  const hint = parseRetryAfterMs(new Headers({ "retry-after": "3" }), now);
  assert.equal(backoffDelayMs(policy, 2, () => 0, hint), 3000);
  assert.equal(backoffDelayMs(policy, 2, () => 0, parseRetryAfterMs(new Headers(), now)), 100, "no hint: computed backoff");
});

test("retryable statuses and Retry-After parsing", () => {
  for (const status of [408, 409, 425, 429, 500, 503, 529, 599]) assert.ok(isRetryableStatus(status), String(status));
  for (const status of [400, 401, 403, 404, 413, 422, 600]) assert.ok(!isRetryableStatus(status), String(status));
  const now = Date.UTC(2026, 0, 1, 0, 0, 0);
  assert.equal(parseRetryAfterMs(new Headers({ "retry-after": "2" }), now), 2000);
  assert.equal(parseRetryAfterMs(new Headers({ "retry-after": "1.5" }), now), 1500);
  assert.equal(parseRetryAfterMs(new Headers({ "retry-after": new Date(now + 7000).toUTCString() }), now), 7000);
  assert.equal(parseRetryAfterMs(new Headers({ "retry-after-ms": "250", "retry-after": "9" }), now), 250);
  assert.equal(parseRetryAfterMs(new Headers({ "retry-after": "soon" }), now), null);
  assert.equal(parseRetryAfterMs(new Headers(), now), null);
});

test("retryAfterLimitMs: the policy's maxRetryAfterMs when it is a finite number >= 0, else five minutes", () => {
  assert.equal(DEFAULT_MAX_RETRY_AFTER_MS, 300_000);
  assert.equal(MAX_WAIT_MS, 2 ** 31 - 1);
  assert.equal(retryAfterLimitMs(undefined), 300_000);
  assert.equal(retryAfterLimitMs({}), 300_000);
  assert.equal(retryAfterLimitMs({ maxRetryAfterMs: 1000 }), 1000);
  assert.equal(retryAfterLimitMs({ maxRetryAfterMs: 5e9 }), MAX_WAIT_MS, "never above what one timer holds");
  for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) assert.equal(retryAfterLimitMs({ maxRetryAfterMs: bad }), 300_000, String(bad));
  assert.equal(retryAfterLimitMs({ maxRetryAfterMs: 1500.7 }), 1500);
  assert.equal(retryAfterLimitMs({ maxRetryAfterMs: 0 }), 0);
});

test("cooldownLeftMs: what is left of a wait, never more than the wait itself", () => {
  assert.equal(cooldownLeftMs(1000, 500, 1200), 300);
  assert.equal(cooldownLeftMs(1000, 500, 1500), 0);
  assert.equal(cooldownLeftMs(1000, 500, 9000), 0);
  assert.equal(cooldownLeftMs(1000, 500, 400), 500, "a clock that went back cannot lengthen the wait");
  assert.equal(cooldownLeftMs(1000, 0, 1000), 0);
});

test("a retry-after hint too large to represent is the largest hint, never Infinity and never no hint", () => {
  const now = Date.UTC(2026, 0, 1);
  assert.equal(parseRetryAfterMs(new Headers({ "retry-after": "9".repeat(400) }), now), Number.MAX_SAFE_INTEGER);
  assert.equal(parseRetryAfterMs(new Headers({ "retry-after-ms": "1e400" }), now), Number.MAX_SAFE_INTEGER);
  assert.equal(parseRetryAfterMs(new Headers({ "retry-after-ms": "Infinity" }), now), Number.MAX_SAFE_INTEGER);
  const farDate = parseRetryAfterMs(new Headers({ "retry-after": "Fri, 31 Dec 9999 23:59:59 GMT" }), now);
  assert.ok(typeof farDate === "number" && Number.isFinite(farDate) && farDate > 1e12, String(farDate));
  assert.equal(parseRetryAfterMs(new Headers({ "retry-after-ms": "-1", "retry-after": "2" }), now), 2000);
  assert.equal(parseRetryAfterMs(new Headers({ "retry-after": "soon" }), now), null);

  const withHint = (value: number): RunwrightError => new RunwrightError("model_transient", "x", { details: { retryAfterMs: value } });
  assert.equal(errorRetryAfterMs(withHint(Number.POSITIVE_INFINITY)), Number.MAX_SAFE_INTEGER);
  assert.equal(errorRetryAfterMs(withHint(Number.NaN)), null);
  assert.equal(errorRetryAfterMs(withHint(1500.4)), 1500);
});

test("the computed backoff never exceeds what one timer can hold", () => {
  assert.equal(backoffDelayMs({ maxAttempts: 9, baseMs: 1e12, maxMs: 1e13 }, 3, () => 1, null), MAX_WAIT_MS);
  assert.equal(backoffDelayMs({ maxAttempts: 5, baseMs: 500, maxMs: 30000 }, 1, () => 0, 600_000), 600_000, "a long hint is not shortened");
});
