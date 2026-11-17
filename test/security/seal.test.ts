import { test } from "node:test";
import assert from "node:assert/strict";
import { RunwrightError } from "../../src/core/errors.ts";
import { generateSealKey, parseSealKey, seal, unseal } from "../../src/security/seal.ts";

function assertSealFailed(fn: () => unknown, mustNotContain: readonly string[]): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof RunwrightError);
    assert.equal(error.code, "seal_failed");
    for (const text of mustNotContain) assert.ok(!error.message.includes(text), `message leaks ${text}`);
    return true;
  });
}

test("seal and unseal round-trip, with a fresh nonce each time", () => {
  const key = generateSealKey();
  assert.equal(key.length, 32);
  const a = seal(key, "API_KEY", "sk-test-value-1234 ✓");
  const b = seal(key, "API_KEY", "sk-test-value-1234 ✓");
  assert.equal(a[0], 0x01);
  assert.notDeepEqual(Buffer.from(a), Buffer.from(b));
  assert.equal(unseal(key, "API_KEY", a), "sk-test-value-1234 ✓");
  assert.equal(unseal(key, "API_KEY", b), "sk-test-value-1234 ✓");
  assert.equal(a.length, 1 + 12 + Buffer.byteLength("sk-test-value-1234 ✓") + 16);
});

test("unseal refuses a wrong key, a wrong name, tampering, truncation and an unknown version", () => {
  const key = generateSealKey();
  const plaintext = "very-secret-plaintext";
  const sealed = seal(key, "TOKEN_A", plaintext);
  const leaks = [plaintext, key.toString("base64"), key.toString("hex")];

  assertSealFailed(() => unseal(generateSealKey(), "TOKEN_A", sealed), leaks);
  assertSealFailed(() => unseal(key, "TOKEN_B", sealed), leaks);
  for (const index of [1, 13, sealed.length - 1]) {
    const tampered = new Uint8Array(sealed);
    tampered[index] = (tampered[index] ?? 0) ^ 0x01;
    assertSealFailed(() => unseal(key, "TOKEN_A", tampered), leaks);
  }
  assertSealFailed(() => unseal(key, "TOKEN_A", sealed.subarray(0, sealed.length - 1)), leaks);
  assertSealFailed(() => unseal(key, "TOKEN_A", sealed.subarray(0, 20)), leaks);
  assertSealFailed(() => unseal(key, "TOKEN_A", new Uint8Array()), leaks);
  const versioned = new Uint8Array(sealed);
  versioned[0] = 0x02;
  assertSealFailed(() => unseal(key, "TOKEN_A", versioned), leaks);
  assertSealFailed(() => unseal(key.subarray(0, 16), "TOKEN_A", sealed), leaks);
});

test("parseSealKey accepts base64 and base64url of exactly 32 bytes", () => {
  const key = generateSealKey();
  assert.deepEqual(parseSealKey(key.toString("base64")), key);
  assert.deepEqual(parseSealKey(`  ${key.toString("base64url")}\n`), key);
  const urlish = Buffer.alloc(32, 0xfb);
  assert.deepEqual(parseSealKey(urlish.toString("base64url")), urlish);
  for (const bad of ["", "not base64!", Buffer.alloc(16).toString("base64"), Buffer.alloc(33).toString("base64")]) {
    assert.throws(() => parseSealKey(bad), (error: unknown) => error instanceof RunwrightError && error.code === "config_invalid");
  }
});
