import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, isJsonObject, parseStrictJson, sha256Hex } from "../../src/core/json.ts";
import { isRunwrightError } from "../../src/core/errors.ts";

function rejects(text: string, pattern: RegExp, options?: { maxDepth?: number }): void {
  assert.throws(() => parseStrictJson(text, options), (error: unknown) => {
    assert.ok(isRunwrightError(error));
    assert.equal(error.code, "invalid_json");
    assert.match(error.message, pattern);
    return true;
  });
}

test("parses every JSON value kind like JSON.parse", () => {
  const samples = [
    "null", "true", "false", "0", "-0.5", "1e3", "12.5E-2", '""', '"a\\"b\\\\c\\/d\\b\\f\\n\\r\\t"', '"\\u00e9\\ud83d\\ude00"',
    "[]", "{}", ' { "a" : [1, 2, {"b": null}], "c": "x" } ', '["é", "😀"]',
  ];
  for (const sample of samples) assert.deepEqual(parseStrictJson(sample), JSON.parse(sample), sample);
});

test("rejects duplicate keys, __proto__ keys and trailing text", () => {
  rejects('{"a": 1, "a": 2}', /duplicate key "a"/);
  rejects('{"x": {"b": 1, "b": 1}}', /duplicate key/);
  rejects('{"__proto__": {"polluted": true}}', /__proto__/);
  rejects('{"a": 1} x', /trailing/);
  rejects("[1] [2]", /trailing/);
  assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
});

test("rejects syntax errors", () => {
  for (const bad of ["", "{", "[1,]", '{"a":1,}', "01", "1.", ".5", "+1", "NaN", "'a'", '"a', '"\\x"', '"\\u12"', "tru", '{"a" 1}', '"a\nb"', "[1 2]"]) {
    assert.throws(() => parseStrictJson(bad), (e: unknown) => isRunwrightError(e) && e.code === "invalid_json", bad);
  }
});

test("enforces the nesting depth limit", () => {
  const deep = (n: number): string => "[".repeat(n) + "]".repeat(n);
  assert.doesNotThrow(() => parseStrictJson(deep(64)));
  rejects(deep(65), /deeper than 64/);
  assert.doesNotThrow(() => parseStrictJson(deep(3), { maxDepth: 3 }));
  rejects('{"a":{"b":{"c":{}}}}', /deeper than 3/, { maxDepth: 3 });
});

test("canonicalJson sorts keys, keeps array order, omits undefined members", () => {
  const value = { b: 1, a: [3, 1, { z: true, y: null }], c: undefined } as unknown as Parameters<typeof canonicalJson>[0];
  assert.equal(canonicalJson(value), '{"a":[3,1,{"y":null,"z":true}],"b":1}');
  assert.equal(canonicalJson({ "é": 1, e: 2, E: 3 }), '{"E":3,"e":2,"é":1}');
  assert.equal(canonicalJson("x\"y"), '"x\\"y"');
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
});

test("isJsonObject and sha256Hex", () => {
  assert.equal(isJsonObject({}), true);
  assert.equal(isJsonObject(Object.create(null)), true);
  assert.equal(isJsonObject([]), false);
  assert.equal(isJsonObject(null), false);
  assert.equal(isJsonObject(new Date()), false);
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
