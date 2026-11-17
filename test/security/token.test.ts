import { test } from "node:test";
import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import { generateToken, tokensEqual, type DigestCompare } from "../../src/security/token.ts";

/** A compare that records every call and delegates to timingSafeEqual (or to `decide`). */
function recording(decide: DigestCompare = timingSafeEqual): { compare: DigestCompare; calls: { a: Buffer; b: Buffer; result: boolean }[] } {
  const calls: { a: Buffer; b: Buffer; result: boolean }[] = [];
  return {
    calls,
    compare: (a, b) => {
      const result = decide(a, b);
      calls.push({ a, b, result });
      return result;
    },
  };
}

test("generateToken gives rw_ and 32 random bytes as base64url, so it never starts with a dash", () => {
  const a = generateToken();
  const b = generateToken();
  assert.match(a, /^rw_[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(a.slice(3), "base64url").length, 32);
  assert.notEqual(a, b);
  for (let i = 0; i < 200; i++) assert.equal(generateToken().startsWith("-"), false);
});

test("tokensEqual matches only the identical token", () => {
  const token = generateToken();
  assert.equal(tokensEqual(token, token), true);
  assert.equal(tokensEqual(token, generateToken()), false);
  const flipped = (token[0] === "A" ? "B" : "A") + token.slice(1);
  assert.equal(tokensEqual(token, flipped), false);
});

test("tokensEqual never throws on different lengths and refuses empty tokens", () => {
  const token = generateToken();
  assert.doesNotThrow(() => tokensEqual(token, "x"));
  assert.equal(tokensEqual(token, "x"), false);
  assert.equal(tokensEqual(token, token.slice(0, -1)), false);
  assert.equal(tokensEqual(token, `${token}extra`), false);
  assert.equal(tokensEqual(token, "a".repeat(10_000)), false);
  assert.equal(tokensEqual(token, ""), false);
  assert.equal(tokensEqual("", ""), false);
  assert.equal(tokensEqual("", token), false);
  assert.equal(tokensEqual("ünïcödé-tøken", "ünïcödé-tøken"), true);
});

test("tokensEqual decides through one comparison of two 32-byte digests", () => {
  const token = generateToken();
  const cases: { name: string; presented: string; expected: boolean }[] = [
    { name: "matching", presented: token, expected: true },
    { name: "same length, wrong", presented: token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"), expected: false },
    { name: "shorter", presented: token.slice(0, 10), expected: false },
    { name: "much longer", presented: token.repeat(50), expected: false },
    { name: "empty", presented: "", expected: false },
  ];
  assert.equal(cases[1]!.presented.length, token.length);
  assert.notEqual(cases[1]!.presented, token);
  for (const { name, presented, expected } of cases) {
    const { compare, calls } = recording();
    const result = tokensEqual(token, presented, compare);
    assert.equal(calls.length, 1, `${name}: exactly one comparison`);
    const call = calls[0]!;
    assert.ok(Buffer.isBuffer(call.a) && Buffer.isBuffer(call.b), `${name}: buffers`);
    assert.equal(call.a.length, 32, `${name}: expected side is a 32-byte digest`);
    assert.equal(call.b.length, 32, `${name}: presented side is a 32-byte digest`);
    assert.equal(result, call.result && token.length > 0 && presented.length > 0, `${name}: the recorded result decides`);
    assert.equal(result, expected, name);
  }
});

test("tokensEqual accepts what the primitive accepts and refuses what it refuses, so nothing else decides", () => {
  const token = generateToken();
  const yes = recording(() => true);
  assert.equal(tokensEqual(token, "a-wrong-token", yes.compare), true, "a primitive that says equal is obeyed");
  assert.equal(yes.calls.length, 1);
  assert.equal(tokensEqual(token, "", yes.compare), false, "the non-empty rule still applies");
  const no = recording(() => false);
  assert.equal(tokensEqual(token, token, no.compare), false, "a primitive that says different is obeyed");
  assert.equal(no.calls.length, 1);
});
