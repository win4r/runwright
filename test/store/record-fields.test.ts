/**
 * The field specification of journal records and the one walk that redacts by it (rule F, F1-F6), the
 * completeness of RECORD_FIELDS against the engine's record types (finding R11-02), and the building blocks of
 * declared specifications (rule H, finding R12-02): fieldObject, fieldList, fieldMap, isFieldSpec,
 * sameFieldSpec, recordFieldsWith and listedNames.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Json, JsonObject } from "../../src/core/json.ts";
import { isRunwrightError } from "../../src/core/errors.ts";
import { createRedactor } from "../../src/core/redact.ts";
import type { JournalType } from "../../src/engine/journal-types.ts";
import {
  MAX_FIELD_SPEC_DEPTH, PENDING_DETAIL_FIELDS, PENDING_RESOLUTION_FIELDS, RECORD_FIELDS, fieldList, fieldMap, fieldObject,
  isEngineRecordType, isFieldSpec, listedNames, recordFieldsWith, redactBySpec, sameFieldSpec, unlistedPaths,
  type FieldRedactor, type FieldSpec, type ObjectSpec,
} from "../../src/store/record-fields.ts";
import { wordSecrets } from "../helpers/two-layer.ts";

/** Marks what each mode did: text gets "T(...)", payload wraps the whole value. */
const calls: { kind: "text" | "payload"; value: Json }[] = [];
const marking: FieldRedactor = {
  text: (value) => {
    calls.push({ kind: "text", value });
    return `T(${value})`;
  },
  payload: (value) => {
    calls.push({ kind: "payload", value });
    return { P: value };
  },
};

/** Replaces "S3CRET-01" in every string and object key, and the digits 12345678 in a number (a real-shaped redactor). */
const S = "S3CRET-01";
const real: FieldRedactor = {
  text: (value) => value.replaceAll(S, "[x]").replaceAll("12345678", "[x]"),
  payload: (value) => {
    const walk = (v: Json): Json => {
      if (typeof v === "string") return real.text(v);
      if (typeof v === "number") return String(v).includes("12345678") ? real.text(String(v)) : v;
      if (Array.isArray(v)) return v.map(walk);
      if (v !== null && typeof v === "object") {
        const out: Record<string, Json> = {};
        for (const [k, item] of Object.entries(v)) Object.defineProperty(out, real.text(k), { value: walk(item), enumerable: true, writable: true, configurable: true });
        return out;
      }
      return v;
    };
    return walk(value);
  },
};

function run(value: Json, spec: FieldSpec): { out: Json; calls: { kind: string; value: Json }[] } {
  calls.length = 0;
  const out = redactBySpec(value, spec, marking);
  return { out, calls: [...calls] };
}

test("F1 payload: the whole value goes to payload, whatever it is", () => {
  for (const value of [null, true, 3, "s", [1, "a"], { a: 1 }] as Json[]) {
    assert.deepEqual(run(value, "payload"), { out: { P: value }, calls: [{ kind: "payload", value }] });
  }
});

test("F2 text: a string is text; null and booleans stay; a number, an array or an object falls to payload", () => {
  assert.deepEqual(run("hello", "text"), { out: "T(hello)", calls: [{ kind: "text", value: "hello" }] });
  assert.deepEqual(run(null, "text"), { out: null, calls: [] });
  assert.deepEqual(run(false, "text"), { out: false, calls: [] });
  assert.deepEqual(run(12345678, "text").out, { P: 12345678 });
  assert.deepEqual(run(["a"], "text").out, { P: ["a"] });
  assert.deepEqual(run({ a: "b" }, "text").out, { P: { a: "b" } });
});

test("F3 keep: a string, number, boolean or null is returned as it is; an array or an object falls to payload", () => {
  for (const value of ["S3CRET-01", 12345678, true, null] as Json[]) assert.deepEqual(run(value, "keep"), { out: value, calls: [] });
  assert.deepEqual(run([1], "keep").out, { P: [1] });
  assert.deepEqual(run({ n: 12345678 }, "keep").out, { P: { n: 12345678 } });
});

test("F4 object: listed keys are written as they are, in the input's order; unlisted keys are redacted with their value", () => {
  const spec: FieldSpec = { fields: { a: "keep", b: "text", c: "payload" } };
  const { out } = run({ z: 1, a: "x", b: "y", c: { d: 2 } }, spec);
  assert.deepEqual(out, { "T(z)": { P: 1 }, a: "x", b: "T(y)", c: { P: { d: 2 } } });
  assert.deepEqual(Object.keys(out as object), ["T(z)", "a", "b", "c"]);
  assert.deepEqual(run(null, spec).out, null);
  assert.deepEqual(run("str", spec).out, { P: "str" });
  assert.deepEqual(run([1], spec).out, { P: [1] });
  assert.deepEqual(run(7, spec).out, { P: 7 });
  // null in every position of a listed field.
  assert.deepEqual(run({ a: null, b: null, c: null }, spec).out, { a: null, b: null, c: { P: null } });
});

test("F4 object: rest decides the unlisted keys; with rest keep the key is kept", () => {
  assert.deepEqual(run({ q: "v" }, { fields: {}, rest: "text" }).out, { "T(q)": "T(v)" });
  assert.deepEqual(run({ q: "v" }, { fields: {}, rest: "keep" }).out, { q: "v" });
});

test("F4 object: the field lookup is by own field name only; an inherited name such as toString is unlisted", () => {
  const spec: FieldSpec = { fields: { a: "keep" } };
  assert.deepEqual(run({ toString: 5, constructor: "c" }, spec).out, { "T(toString)": { P: 5 }, "T(constructor)": { P: "c" } });
});

test("F4 object: a listed key wins a collision with a redacted unlisted key, before or after it", () => {
  const spec: FieldSpec = { fields: { toolCalls: "keep" } };
  const renaming: FieldRedactor = { text: (v) => (v === "secret-name" ? "toolCalls" : v), payload: (v) => ({ P: v }) };
  assert.deepEqual(redactBySpec({ "secret-name": 1, toolCalls: 2 }, spec, renaming), { toolCalls: 2 });
  assert.deepEqual(redactBySpec({ toolCalls: 2, "secret-name": 1 }, spec, renaming), { toolCalls: 2 });
  assert.deepEqual(redactBySpec({ "secret-name": 1 }, spec, renaming), { toolCalls: { P: 1 } }, "no listed key present: nothing to win");
});

test("F4 object: a __proto__ key stays an own property, listed or not, and undefined values are left out", () => {
  const listed = JSON.parse('{"__proto__": {"x": 1}, "a": "b"}') as Json;
  const fields = JSON.parse('{"__proto__": "payload", "a": "keep"}') as Record<string, FieldSpec>;
  const out = redactBySpec(listed, { fields }, marking) as Record<string, Json>;
  assert.ok(Object.hasOwn(out, "__proto__"));
  assert.deepEqual(Object.getOwnPropertyDescriptor(out, "__proto__")?.value, { P: { x: 1 } }, "listed: the key as it is, the value by its spec");
  const unlistedProto = redactBySpec(listed, { fields: { a: "keep" } }, marking) as Record<string, Json>;
  assert.ok(Object.hasOwn(unlistedProto, "T(__proto__)"), "unlisted: the key is redacted with its value");
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  const unlisted = redactBySpec(JSON.parse('{"__proto__": 1}') as Json, { fields: {}, rest: "keep" }, marking) as Record<string, Json>;
  assert.ok(Object.hasOwn(unlisted, "__proto__"));
  assert.deepEqual(Object.getOwnPropertyDescriptor(unlisted, "__proto__")?.value, 1);
  const withUndefined = { a: "x", gone: undefined } as unknown as Json;
  assert.deepEqual(redactBySpec(withUndefined, { fields: { a: "keep" } }, marking), { a: "x" });
});

test("F5 array: each element by items; null stays; anything else falls to payload", () => {
  assert.deepEqual(run(["a", null, 3], { items: "text" }).out, ["T(a)", null, { P: 3 }]);
  assert.deepEqual(run(null, { items: "text" }).out, null);
  assert.deepEqual(run({ 0: "a" }, { items: "text" }).out, { P: { 0: "a" } });
  assert.deepEqual(run("a", { items: "text" }).out, { P: "a" });
  assert.deepEqual(run([{ id: "i", n: 1 }], { items: { fields: { id: "keep" } } }).out, [{ id: "i", "T(n)": { P: 1 } }]);
});

test("the input is not changed and the result shares no object with it", () => {
  const value = { pending: { id: "p", kind: "question", title: `t ${S}`, detail: { question: S, choices: [S], args: { [S]: 12345678 } } }, extra: { n: 12345678 } };
  const copy = structuredClone(value);
  const out = redactBySpec(value, RECORD_FIELDS["pending.opened"] as FieldSpec, real) as typeof value;
  assert.deepEqual(value, copy);
  assert.deepEqual(out, {
    pending: { id: "p", kind: "question", title: "t [x]", detail: { question: "[x]", choices: ["[x]"], args: { "[x]": "[x]" } } },
    extra: { n: "[x]" },
  });
  assert.notEqual(out.pending, value.pending);
  assert.notEqual(out.pending.detail, value.pending.detail);
  assert.notEqual(out.pending.detail.choices, value.pending.detail.choices);
});

test("RECORD_FIELDS, PENDING_DETAIL_FIELDS and PENDING_RESOLUTION_FIELDS are deeply frozen", () => {
  const unfrozen: string[] = [];
  const check = (value: unknown, path: string): void => {
    if (value === null || typeof value !== "object") return;
    if (!Object.isFrozen(value)) unfrozen.push(path);
    for (const [key, item] of Object.entries(value)) check(item, `${path}.${key}`);
  };
  check(RECORD_FIELDS, "RECORD_FIELDS");
  check(PENDING_DETAIL_FIELDS, "PENDING_DETAIL_FIELDS");
  check(PENDING_RESOLUTION_FIELDS, "PENDING_RESOLUTION_FIELDS");
  assert.deepEqual(unfrozen, []);
  assert.throws(() => {
    (RECORD_FIELDS["run.output"]?.fields as Record<string, FieldSpec>)["output"] = "keep";
  }, TypeError);
});

test("every JournalType has an entry in RECORD_FIELDS, and there is no stale entry", () => {
  // A new key in JournalDataMap fails to compile here until it is listed, and then fails below until the
  // specification has an entry for it.
  const types: Record<JournalType, true> = {
    "run.created": true, "run.claimed": true, "command.applied": true, "command.rejected": true, "limits.changed": true,
    "inbox.taken": true, "model.started": true, "model.invalid": true, "model.finished": true, "model.interrupted": true,
    "model.failed": true, "model.retry": true, "tool.started": true, "tool.finished": true, "tool.interrupted": true,
    "pending.opened": true, "pending.resolved": true, "step.started": true, "step.finished": true, "node.started": true,
    "node.finished": true, "node.retry": true, "context.compacted": true, "learning.given": true, "learning.checked": true,
    "learning.graded": true, "learning.applied": true, "learning.skipped": true, "learning.promotion": true,
    "run.output": true, "message.undelivered": true, "run.waiting": true, "run.paused": true, "run.released": true,
    "run.completed": true, "run.failed": true, "run.cancelled": true,
  };
  assert.deepEqual(Object.keys(types).filter((type) => !isEngineRecordType(type)), []);
  assert.deepEqual(Object.keys(RECORD_FIELDS).filter((type) => !Object.hasOwn(types, type)), [], "no stale entry");
  assert.equal(isEngineRecordType("host.note"), false);
  assert.equal(isEngineRecordType("toString"), false, "an inherited name is not a record type");
});

test("the pending detail and resolution specs are the ones the pending records use", () => {
  const opened = RECORD_FIELDS["pending.opened"]?.fields["pending"] as { fields: Record<string, FieldSpec> };
  assert.equal(opened.fields["detail"], PENDING_DETAIL_FIELDS);
  assert.equal(RECORD_FIELDS["pending.resolved"]?.fields["resolution"], PENDING_RESOLUTION_FIELDS);
});

test("unlistedPaths: a key that fell to rest and a value of an unexpected JSON type; nothing for a well-formed record", () => {
  const spec = RECORD_FIELDS["model.finished"] as FieldSpec;
  const good: Json = {
    model: "scripted/m", purpose: "run", text: "hi", toolCalls: [{ id: "c1", name: "x", args: { a: [1, { b: 2 }] } }], output: null,
    stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }, costMicros: null, durationMs: 3,
  };
  assert.deepEqual(unlistedPaths(good, spec), []);
  const bad: Json = {
    model: { odd: true }, text: 5, toolCalls: [{ id: "c1", name: "x", args: {}, extra: 1 }, "not an object"], stopReason: "end",
    usage: { inputTokens: 1, surprise: 2 }, "odd key": 1,
  };
  assert.deepEqual(unlistedPaths(bad, spec), [
    "$.model", "$.text", "$.toolCalls[0].extra", "$.toolCalls[1]", "$.usage.surprise", '$["odd key"]',
  ]);
  assert.deepEqual(unlistedPaths("x", spec), ["$"]);
  assert.deepEqual(unlistedPaths(null, spec), []);
  assert.deepEqual(unlistedPaths({ pendingIds: "p" }, RECORD_FIELDS["run.waiting"] as FieldSpec), ["$.pendingIds"]);
});

// ---------------------------------------------------------------- declared specifications (rule H)

test("fieldObject, fieldList and fieldMap are frozen copies; a __proto__ key is an own listed key; rest only when given", () => {
  const input: Record<string, FieldSpec> = { a: "keep", b: "text" };
  const spec = fieldObject(input);
  input["a"] = "payload";
  input["c"] = "keep";
  assert.deepEqual(spec, { fields: { a: "keep", b: "text" } });
  assert.equal(Object.hasOwn(spec, "rest"), false, "rest is absent unless given");
  assert.ok(Object.isFrozen(spec) && Object.isFrozen(spec.fields));
  assert.throws(() => {
    (spec.fields as Record<string, FieldSpec>)["a"] = "payload";
  }, TypeError);
  assert.deepEqual(fieldObject({ a: "keep" }, "text"), { fields: { a: "keep" }, rest: "text" });
  const proto = JSON.parse('{"__proto__": "keep", "x": "text"}') as Record<string, FieldSpec>;
  const withProto = fieldObject(proto);
  assert.ok(Object.hasOwn(withProto.fields, "__proto__"), "__proto__ is an own key");
  assert.equal(Object.getPrototypeOf(withProto.fields), Object.prototype, "the prototype was not replaced");
  assert.deepEqual(listedNames(withProto), ["__proto__", "x"]);
  const inherited = Object.create({ inherited: "keep" }) as Record<string, FieldSpec>;
  inherited["own"] = "text";
  assert.deepEqual(Object.keys(fieldObject(inherited).fields), ["own"], "inherited keys are not copied");
  const items = fieldList("text");
  const values = fieldMap("keep");
  assert.deepEqual([items, values], [{ items: "text" }, { values: "keep" }]);
  assert.ok(Object.isFrozen(items) && Object.isFrozen(values));
});

function nested(levels: number): unknown {
  let spec: unknown = "text";
  for (let i = 0; i < levels; i++) spec = { items: spec };
  return spec;
}

test("isFieldSpec accepts the three words and each kind, nested; refuses everything else and never throws", () => {
  const valid: unknown[] = [
    "keep", "text", "payload", fieldObject({}), fieldObject({ a: "keep" }, "text"), fieldList("payload"), fieldMap("keep"),
    { fields: { a: { items: { values: { fields: { b: "text" } } } } } }, { fields: Object.create(null) }, { items: "text" },
    nested(MAX_FIELD_SPEC_DEPTH), fieldObject({ a: fieldMap(fieldList(fieldObject({ b: "keep" }, "payload"))) }),
  ];
  for (const value of valid) assert.equal(isFieldSpec(value), true, JSON.stringify(value));
  const cyclic: { fields: Record<string, unknown> } = { fields: {} };
  cyclic.fields["self"] = cyclic;
  const getter = { get fields() {
    throw new Error("boom");
  } };
  const innerGetter = { fields: { get a() {
    throw new Error("boom");
  } } };
  const hidden = Object.defineProperty({ fields: {} }, "extra", { value: 1, enumerable: false });
  const symbol = { items: "text", [Symbol("s")]: 1 };
  class Spec { fields = {}; }
  const invalid: unknown[] = [
    null, undefined, 3, "Keep", "", ["text"], {}, { fields: {}, items: "text" }, { fields: { a: "nope" } },
    { items: "text", extra: 1 }, { values: "text", rest: "keep" }, { fields: {}, rest: "nope" }, { fields: [] },
    { fields: null }, { items: undefined }, cyclic, nested(MAX_FIELD_SPEC_DEPTH + 1), getter, innerGetter, hidden, symbol,
    new Spec(), { fields: new Map() },
  ];
  invalid.forEach((value, index) => assert.equal(isFieldSpec(value), false, `invalid value ${index}`));
  let wide: unknown = "keep";
  for (let i = 0; i < MAX_FIELD_SPEC_DEPTH; i++) wide = { fields: { a: wide, b: wide, c: wide } };
  assert.equal(isFieldSpec(wide), true, "a part shared at every level is checked once per depth");
  const shared = nested(40);
  const deep = { fields: { a: shared, b: nested(0) } };
  let wrapped: unknown = shared;
  for (let i = 0; i < 30; i++) wrapped = { items: wrapped };
  deep.fields.b = wrapped;
  assert.equal(isFieldSpec(deep), false, "a part shared at a shallow and a deep place is refused where it is too deep");
  assert.equal(isFieldSpec({ fields: { a: wrapped, b: shared } }), false, "in either order");
  assert.equal(sameFieldSpec(deep as FieldSpec, deep as FieldSpec), false);
});

test("sameFieldSpec is structural: field order does not matter, an absent rest equals payload, kinds must match", () => {
  const equal: [FieldSpec, FieldSpec][] = [
    ["keep", "keep"],
    [fieldObject({ a: "keep", b: "text" }), fieldObject({ b: "text", a: "keep" })],
    [fieldObject({ a: "keep" }), fieldObject({ a: "keep" }, "payload")],
    [fieldList(fieldMap("text")), { items: { values: "text" } }],
    [fieldObject({ a: fieldList(fieldObject({ b: "keep" })) }), fieldObject({ a: fieldList(fieldObject({ b: "keep" })) })],
  ];
  for (const [a, b] of equal) assert.equal(sameFieldSpec(a, b), true, `${JSON.stringify(a)} = ${JSON.stringify(b)}`);
  const unequal: [FieldSpec, FieldSpec][] = [
    ["keep", "text"], ["payload", fieldObject({})], [fieldList("text"), fieldMap("text")], [fieldList("text"), fieldList("keep")],
    [fieldObject({ a: "keep" }), fieldObject({ a: "keep", b: "keep" })], [fieldObject({ a: "keep" }), fieldObject({ b: "keep" })],
    [fieldObject({ a: "keep" }), fieldObject({ a: "keep" }, "text")], [fieldMap("keep"), fieldObject({})],
    [fieldObject({ a: "keep" }), fieldObject({ a: "text" })],
  ];
  for (const [a, b] of unequal) assert.equal(sameFieldSpec(a, b), false, `${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  assert.equal(sameFieldSpec(nested(MAX_FIELD_SPEC_DEPTH) as FieldSpec, nested(MAX_FIELD_SPEC_DEPTH) as FieldSpec), true);
  assert.equal(sameFieldSpec(nested(MAX_FIELD_SPEC_DEPTH + 1) as FieldSpec, nested(MAX_FIELD_SPEC_DEPTH + 1) as FieldSpec), false);
});

test("recordFieldsWith replaces one field, leaves RECORD_FIELDS as it was, is frozen, and throws internal otherwise", () => {
  const before = JSON.stringify(RECORD_FIELDS);
  const declared = { fields: { promptSection: "text" } } as { fields: Record<string, FieldSpec> };
  const spec = recordFieldsWith("step.finished", "value", declared);
  assert.deepEqual(spec, { fields: { name: "text", nodeId: "text", scope: "text", kind: "keep", workflow: "text", value: { fields: { promptSection: "text" } } } });
  assert.ok(Object.isFrozen(spec) && Object.isFrozen(spec.fields) && Object.isFrozen(spec.fields["value"]));
  assert.equal(Object.isFrozen(declared), false, "the caller's object is not frozen");
  declared.fields["promptSection"] = "keep";
  assert.deepEqual((spec.fields["value"] as ObjectSpec).fields, { promptSection: "text" }, "a later change of the caller's object does not reach it");
  assert.equal(JSON.stringify(RECORD_FIELDS), before);
  assert.equal(RECORD_FIELDS["step.finished"]?.fields["value"], "payload");
  assert.deepEqual(recordFieldsWith("model.finished", "output", "keep").fields["output"], "keep");
  const internal = (fn: () => unknown): void => {
    assert.throws(fn, (error) => isRunwrightError(error) && error.code === "internal");
  };
  internal(() => recordFieldsWith("host.note", "value", "keep"));
  internal(() => recordFieldsWith("toString", "value", "keep"));
  internal(() => recordFieldsWith("step.finished", "output", "keep"));
  internal(() => recordFieldsWith("step.finished", "toString", "keep"));
  internal(() => recordFieldsWith("step.finished", "value", "nope" as FieldSpec));
});

test("listedNames: every name of every ObjectSpec through fields, rest, items and values, once, first seen first", () => {
  const shared = fieldObject({ itemId: "keep" });
  const spec = fieldObject({
    promptSection: "text",
    given: fieldList(fieldObject({ itemId: "keep", version: "keep" })),
    byPath: fieldMap(shared),
    other: fieldList(shared),
  }, fieldObject({ fromRest: "text", promptSection: "keep" }));
  assert.deepEqual(listedNames(spec), ["promptSection", "given", "itemId", "version", "byPath", "other", "fromRest"]);
  assert.deepEqual(listedNames("text"), []);
  assert.deepEqual(listedNames(fieldMap("keep")), []);
});

test("F6 map: keys are redacted as text, values by values; collisions, __proto__, null, a non-object", () => {
  const r = createRedactor({ PIN: "12345678", WORD: "secret-word" });
  assert.deepEqual(redactBySpec({ "a secret-word b": 12345678, plain: 2 }, fieldMap("keep"), r), { "a [redacted:WORD] b": 12345678, plain: 2 });
  assert.deepEqual(redactBySpec({ k: 12345678 }, fieldMap("payload"), r), { k: "[redacted:PIN]" });
  assert.deepEqual(redactBySpec({ k: "x secret-word" }, fieldMap("text"), r), { k: "x [redacted:WORD]" });
  assert.deepEqual(redactBySpec({ "k secret-word": { itemId: "secret-word", "secret-word": 1 } }, fieldMap(fieldObject({ itemId: "keep" })), r),
    { "k [redacted:WORD]": { itemId: "secret-word", "[redacted:WORD]": 1 } }, "each value is walked by values");
  const collision = redactBySpec({ "secret-word": 1, "[redacted:WORD]": 2 }, fieldMap("keep"), r) as JsonObject;
  assert.deepEqual(collision, { "[redacted:WORD]": 2 }, "the later key wins");
  const reverse = redactBySpec({ "[redacted:WORD]": 2, "secret-word": 1 }, fieldMap("keep"), r) as JsonObject;
  assert.deepEqual(reverse, { "[redacted:WORD]": 1 }, "the later key wins");
  const proto = redactBySpec(JSON.parse('{"__proto__": 5, "u": 1}') as Json, fieldMap("keep"), r) as JsonObject;
  assert.ok(Object.hasOwn(proto, "__proto__"), "__proto__ stays an own property");
  assert.equal(Object.getPrototypeOf(proto), Object.prototype);
  assert.equal(proto["__proto__"], 5);
  assert.deepEqual(redactBySpec({ a: undefined, b: 1 } as unknown as Json, fieldMap("keep"), r), { b: 1 }, "undefined is left out");
  assert.equal(redactBySpec(null, fieldMap("keep"), r), null);
  assert.deepEqual(run([1, 2], fieldMap("keep")), { out: { P: [1, 2] }, calls: [{ kind: "payload", value: [1, 2] }] });
  assert.deepEqual(run("s", fieldMap("keep")), { out: { P: "s" }, calls: [{ kind: "payload", value: "s" }] });
  assert.deepEqual(run({ k: "v" }, fieldMap("text")).out, { "T(k)": "T(v)" });
});

test("unlistedPaths over a MapSpec reports no key, walks every value, and reports a value of the wrong type", () => {
  const spec = fieldObject({ versions: fieldMap("keep"), items: fieldMap(fieldObject({ id: "keep" })) });
  assert.deepEqual(unlistedPaths({ versions: { "skills/a.md": 1, "odd key": 2 }, items: { x: { id: "i" } } }, spec), []);
  assert.deepEqual(unlistedPaths({ versions: [1], items: { x: { id: "i", extra: 1 }, y: "s" } }, spec), [
    "$.versions", "$.items.x.extra", "$.items.y",
  ]);
  assert.deepEqual(unlistedPaths({ versions: { a: { deep: 1 } } }, spec), ["$.versions.a"]);
  assert.deepEqual(unlistedPaths("x", fieldMap("keep")), ["$"]);
  assert.deepEqual(unlistedPaths(null, fieldMap("keep")), []);
});

/** A value of the class: a structure Runwright built, with names of 8 or more bytes at three depths. */
const BUILT = fieldObject({
  promptSection: "text",
  given: fieldList(fieldObject({ itemId: "keep", versionNumber: "keep" })),
  versionsByPath: fieldMap("keep"),
  detail: "payload",
});

function builtValue(): Json {
  return {
    promptSection: "Notes: promptSection, versionNumber and versionsByPath are words here.",
    given: [{ itemId: "item_1", versionNumber: 7 }, { itemId: "promptSection", versionNumber: 2 }],
    versionsByPath: { "skills/promptSection.md": 3, "notes/plain.md": 1 },
    detail: { versionsByPath: "versionNumber", n: 1 },
  };
}

function secretsOf(values: readonly string[], prefix: string): Record<string, string> {
  return Object.fromEntries(values.map((value, index) => [`${prefix}${index}`, value]));
}

/** The structure the engine reads back: listed keys and kept values, whatever the secrets. */
function assertStructure(out: Json, secrets: readonly string[], label: string): void {
  const value = out as JsonObject;
  assert.deepEqual(Object.keys(value), ["promptSection", "given", "versionsByPath", "detail"], label);
  assert.deepEqual(value["given"], [{ itemId: "item_1", versionNumber: 7 }, { itemId: "promptSection", versionNumber: 2 }], label);
  const byPath = value["versionsByPath"] as JsonObject;
  assert.deepEqual(Object.values(byPath), [3, 1], label);
  for (const secret of secrets) {
    assert.ok(!(value["promptSection"] as string).includes(secret), `${label}: text holds ${secret}`);
    for (const key of Object.keys(byPath)) assert.ok(!key.includes(secret), `${label}: a map key holds ${secret}`);
    assert.ok(!JSON.stringify(value["detail"]).includes(secret), `${label}: the payload holds ${secret}`);
  }
}

test("the class, generated: a secret equal to or inside a listed name changes neither the names nor the kept values, through two passes", () => {
  const all = wordSecrets(BUILT);
  assert.deepEqual(all, ["promptSection", "promptSe", "tSection", "versionNumber", "versionN", "onNumber", "versionsByPath", "versions", "nsByPath"]);
  const sets: string[][] = [...all.map((secret) => [secret]), all];
  for (const set of sets) {
    const first = redactBySpec(builtValue(), BUILT, createRedactor(secretsOf(set, "A")));
    assertStructure(first, set, `first pass ${set.join(",")}`);
    const others = all.filter((secret) => !set.includes(secret));
    const second = redactBySpec(first, BUILT, createRedactor(secretsOf(others.length > 0 ? others : all, "B")));
    assertStructure(second, all, `second pass ${set.join(",")}`);
    assert.deepEqual(Object.keys(second as JsonObject), Object.keys(first as JsonObject));
  }
  const undeclared = redactBySpec(builtValue(), RECORD_FIELDS["step.finished"]?.fields["value"] as FieldSpec, createRedactor(secretsOf(all, "A")));
  assert.ok(!Object.hasOwn(undeclared as JsonObject, "promptSection"), "without a declaration the key is redacted with the value");
});
