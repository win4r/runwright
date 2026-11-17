/**
 * checkAssignable (Rule P): what can be proved wrong about an expression flowing into a schema, and nothing more
 * (spec-01, workflow-02). The default clause (R10-02): a default no longer switches the reference's shape check off.
 * Unions, array lengths, never-empty arrays and template lengths are compared (R11-03); static-matrix.test.ts
 * covers the whole table.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Json } from "../../src/core/json.ts";
import type { JsonSchema } from "../../src/schema/validate.ts";
import { checkAssignable, type AssignProblem, type RefInfo } from "../../src/workflow/assign.ts";
import { UNKNOWN_SHAPE, plainShape, type Shape } from "../../src/workflow/walk.ts";

type Presence = RefInfo["presence"];

/** Checks `expr` at `$.x`; a reference has the shape in `shapes` (else unknown) and the presence in `presence` (else "maybe"). */
function check(expr: Json, schema: JsonSchema, shapes: { [path: string]: Shape } = {}, definitions?: Record<string, JsonSchema>,
  presence: { [path: string]: Presence } = {}): AssignProblem[] {
  return checkAssignable({
    expr, path: "$.x", schema, root: schema, ...(definitions === undefined ? {} : { definitions }),
    refOf: (path) => ({
      shape: Object.hasOwn(shapes, path) ? shapes[path] as Shape : UNKNOWN_SHAPE,
      presence: Object.hasOwn(presence, path) ? presence[path] as Presence : "maybe",
    }),
  });
}

const ref = (path: string): Json => ({ $ref: path });
const record = (fields: { [name: string]: Shape }): Shape => ({ t: "record", fields });

test("literals are validated in full, $literal included", () => {
  assert.deepEqual(check({ a: 1 }, { type: "object", properties: { a: { type: "string" } } }), [{ path: "$.x.a", message: "expected string, got integer" }]);
  assert.deepEqual(check({ $literal: { $ref: "not.a.ref" } }, { type: "string" }), [{ path: "$.x", message: "expected string, got object" }]);
  assert.deepEqual(check("plain {{ text", { type: "string", minLength: 50 }), [{ path: "$.x", message: "must be at least 50 characters, got 13" }]);
  assert.deepEqual(check(5, { anyOf: [{ type: "string" }, { type: "boolean" }] }).map((p) => p.path), ["$.x"], "a union still checks a literal");
});

test("types: no admitted type is a problem; some admitted, or number into integer, is not", () => {
  const shapes = { n: plainShape({ type: "number" }), i: plainShape({ type: "integer" }), sn: plainShape({ type: ["string", "null"] }), b: plainShape({ type: "boolean" }) };
  assert.deepEqual(check(ref("b"), { type: "string" }, shapes), [{ path: "$.x", message: "is boolean, but expected string" }]);
  assert.deepEqual(check(ref("n"), { type: "integer" }, shapes), []);
  assert.deepEqual(check(ref("i"), { type: "number" }, shapes), []);
  assert.deepEqual(check(ref("sn"), { type: "string" }, shapes), []);
  assert.deepEqual(check(ref("sn"), { type: "boolean" }, shapes), [{ path: "$.x", message: "is string or null, but expected boolean" }]);
  assert.deepEqual(check(ref("gone"), { type: "string" }, shapes), [], "an unknown shape");
  assert.deepEqual(check(ref("b"), { anyOf: [{ type: "string" }] }, shapes), [{ path: "$.x", message: "never matches any of the 1 schemas (anyOf)" }]);
  assert.deepEqual(check(ref("b"), { oneOf: [{ type: "string" }] }, shapes), [{ path: "$.x", message: "never matches any of the 1 schemas (oneOf)" }]);
  assert.deepEqual(check(ref("b"), { anyOf: [{ type: "string" }, { type: "boolean" }] }, shapes), [], "one alternative may fit");
  assert.deepEqual(check(ref("b"), { minLength: 3 }, shapes), [], "no type is known for the destination");
  assert.deepEqual(check(ref("b"), { $ref: "#/$defs/S", $defs: { S: { type: "string" } } }, shapes), [{ path: "$.x", message: "is boolean, but expected string" }]);
  assert.deepEqual(check(ref("b"), { $ref: "#/$defs/Missing" }, shapes), [], "a destination that does not resolve");
  assert.deepEqual(check(ref("b"), { $ref: "#/schemas/S" }, shapes, { S: { type: "string" } }), [{ path: "$.x", message: "is boolean, but expected string" }]);
  const sibling: JsonSchema = { $ref: "#/$defs/Any", type: "string", $defs: { Any: {} } };
  assert.deepEqual(check(ref("b"), sibling, shapes), [{ path: "$.x", message: "is boolean, but expected string" }], "keywords next to a $ref apply too");
  assert.deepEqual(check(ref("b"), { $ref: "#/$defs/U", $defs: { U: { anyOf: [{ type: "string" }] } } }, shapes),
    [{ path: "$.x", message: "never matches any of the 1 schemas (anyOf)" }], "a union behind a $ref");
  assert.deepEqual(check(ref("p"), { type: "string" }, { p: plainShape({ properties: { a: {} } }) }), [], "a source with only properties may be anything");
  assert.deepEqual(check(ref("u"), { type: "string" }, { u: plainShape({ anyOf: [{ type: "boolean" }] }) }),
    [{ path: "$.x", message: "none of its 1 alternatives fits: is boolean, but expected string" }], "a union source");
  assert.deepEqual(check(ref("u"), { type: "string" }, { u: plainShape({ anyOf: [{ type: "boolean" }, { type: "string" }] }) }), [], "a union source that may fit");
});

test("templates render a string", () => {
  assert.deepEqual(check("n = {{n}}", { type: "integer" }), [{ path: "$.x", message: "is string, but expected integer" }]);
  assert.deepEqual(check("n = {{n}}", { type: "string", maxLength: 2 }), [{ path: "$.x", message: "always has at least 4 characters, but must be at most 2" }]);
  assert.deepEqual(check("n = {{n}}", { type: "string", maxLength: 4 }), [], "the references may render the empty string");
});

test("objects: required, properties always present, strict sources", () => {
  const w = record({ answer: plainShape({ type: "string" }) });
  const dest: JsonSchema = { type: "object", required: ["urgent"], properties: { answer: { type: "boolean" }, urgent: {} } };
  assert.deepEqual(check(ref("w"), dest, { w }), [
    { path: "$.x.urgent", message: `never has the required property "urgent"` },
    { path: "$.x.answer", message: "is string, but expected boolean" },
  ]);
  const strict = plainShape({ type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "integer" }, b: { type: "string" } } });
  assert.deepEqual(check(ref("s"), { type: "object", required: ["c"] }, { s: strict }), [{ path: "$.x.c", message: `never has the required property "c"` }]);
  assert.deepEqual(check(ref("s"), { type: "object", required: ["b"] }, { s: strict }), [], "b is declared, so it may be there");
  assert.deepEqual(check(ref("s"), { type: "object", properties: { b: { type: "boolean" } } }, { s: strict }), [], "b may be absent");
  assert.deepEqual(check(ref("s"), { type: "object", properties: { a: { type: "string" } } }, { s: strict }), [{ path: "$.x.a", message: "is integer, but expected string" }]);
  const open = plainShape({ type: "object", required: ["c"] });
  assert.deepEqual(check(ref("o"), { type: "object", required: ["c", "d"], properties: { c: { type: "string" } } }, { o: open }), [], "an open source may have anything");
  assert.deepEqual(check(ref("w"), { required: ["urgent"] }, { w }), [{ path: "$.x.urgent", message: `never has the required property "urgent"` }],
    "object keywords apply to an object whatever the destination's type");
});

test("objects: a property the source always has must be allowed by the destination's additionalProperties", () => {
  const w = record({ answer: plainShape({ type: "string" }) });
  assert.deepEqual(check(ref("w"), { type: "object", additionalProperties: false, properties: { x: {} } }, { w }),
    [{ path: "$.x.answer", message: `always has the property "answer", which is not allowed` }]);
  assert.deepEqual(check(ref("w"), { type: "object", additionalProperties: { type: "integer" } }, { w }),
    [{ path: "$.x.answer", message: "is string, but expected integer" }]);
  assert.deepEqual(check(ref("w"), { type: "object", additionalProperties: { type: "string" } }, { w }), []);
  assert.deepEqual(check(ref("w"), { type: "object", additionalProperties: false, properties: { answer: { type: "string" } } }, { w }), [], "declared, so allowed");
  const required = plainShape({ type: "object", required: ["a"], properties: { a: { type: "integer" } } });
  assert.deepEqual(check(ref("r"), { type: "object", additionalProperties: false }, { r: required }),
    [{ path: "$.x.a", message: `always has the property "a", which is not allowed` }]);
  const optional = plainShape({ type: "object", properties: { a: { type: "integer" } } });
  assert.deepEqual(check(ref("o"), { type: "object", additionalProperties: false }, { o: optional }), [], "a property that may be absent");
  assert.deepEqual(check(ref("o"), { type: "object", additionalProperties: { type: "string" } }, { o: optional }), [], "a property that may be absent");
});

test("arrays: the type and a never-empty array's items are compared, a list's items and length are not", () => {
  const list: Shape = { t: "list", items: plainShape({ type: "string" }) };
  assert.deepEqual(check(ref("l"), { type: "string" }, { l: list }), [{ path: "$.x", message: "is array, but expected string" }]);
  assert.deepEqual(check(ref("l"), { type: "array", items: { type: "integer" } }, { l: list }), [], "an empty array always fits");
  assert.deepEqual(check([ref("l"), 5], { type: "array", items: { type: "string" } }, { l: list }), [
    { path: "$.x[0]", message: "is array, but expected string" },
    { path: "$.x[1]", message: "expected string, got integer" },
  ]);
  assert.deepEqual(check(ref("l"), { type: "array", minItems: 3 }, { l: list }), [], "a list's length is not known");
  const never = plainShape({ type: "array", minItems: 1, items: { type: "string" } });
  assert.deepEqual(check(ref("a"), { type: "array", items: { type: "integer" } }, { a: never }), [{ path: "$.x[0]", message: "is string, but expected integer" }]);
  assert.deepEqual(check(ref("a"), { type: "array", items: { type: "integer" } }, { a: plainShape({ type: "array", items: { type: "string" } }) }), [], "may be empty");
  assert.deepEqual(check([ref("l")], { type: "array", minItems: 2 }, { l: list }), [{ path: "$.x", message: "must have at least 2 items, got 1" }]);
});

test("value lists: every listed value fails the destination", () => {
  const e = plainShape({ enum: ["p", "q"] });
  assert.deepEqual(check(ref("e"), { enum: ["a", "b"] }, { e }), [{ path: "$.x", message: `can only be "p", "q", none of which fits` }]);
  assert.deepEqual(check(ref("e"), { enum: ["a", "q"] }, { e }), []);
  assert.deepEqual(check(ref("c"), { type: "string", minLength: 3 }, { c: plainShape({ const: "ab" }) }), [{ path: "$.x", message: `can only be "ab", none of which fits` }]);
  assert.deepEqual(check(ref("e"), { type: "string", pattern: "^[pq]$" }, { e }), []);
  assert.deepEqual(check(ref("t"), { enum: ["b"] }, { t: plainShape({ type: "string", enum: ["a", 1] }) }), [{ path: "$.x", message: `can only be "a", none of which fits` }],
    "values the source's own schema refuses are never seen");
});

test("objects written in the document: allowed keys, required keys, literal values next to references", () => {
  const s = plainShape({ type: "string" });
  const dest: JsonSchema = { type: "object", required: ["a", "c"], additionalProperties: false, properties: { a: { type: "string" }, b: { type: "string" }, c: {} } };
  assert.deepEqual(check({ a: ref("s"), b: 5, z: ref("s") }, dest, { s }), [
    { path: "$.x.b", message: "expected string, got integer" },
    { path: "$.x.z", message: `property "z" is not allowed` },
    { path: "$.x.c", message: `missing required property "c"` },
  ]);
  assert.deepEqual(check({ a: ref("s") }, { type: "string" }, { s }), [{ path: "$.x", message: "is an object, but expected string" }]);
  assert.deepEqual(check({ a: ref("s") }, { type: "object", additionalProperties: { type: "integer" } }, { s }), [{ path: "$.x.a", message: "is string, but expected integer" }]);
  assert.deepEqual(check({ a: ref("s") }, { anyOf: [{ type: "object", required: ["b"] }] }, { s }), [{ path: "$.x", message: "never matches any of the 1 schemas (anyOf)" }], "a union");
  assert.deepEqual(check({ a: ref("s") }, { anyOf: [{ type: "object", required: ["b"] }, { type: "object", required: ["a"] }] }, { s }), [], "a union one of whose alternatives may fit");
  assert.deepEqual(check({ a: { $ref: 5 } as unknown as Json }, { type: "object", properties: { a: { type: "integer" } } }, { s }), [], "a malformed part");
});

test("a reference with a default that always resolves: its shape is compared, its default is never read", () => {
  const n = plainShape({ type: "number" });
  const s = plainShape({ type: "string" });
  assert.deepEqual(check({ $ref: "n", default: "x" }, { type: "string" }, { n }, undefined, { n: "always" }),
    [{ path: "$.x", message: "is number, but expected string" }], "the reference is compared although the default fits");
  assert.deepEqual(check({ $ref: "s", default: 5 }, { type: "string" }, { s }, undefined, { s: "always" }), [], "the default is never read, so it is not checked");
  assert.deepEqual(check({ $ref: "n", default: 5 }, { type: "string" }, { n }, undefined, { n: "always" }),
    [{ path: "$.x", message: "is number, but expected string" }], "only the reference is reported");
});

test("a reference with a default that may be missing: its shape is compared and its default is checked in full", () => {
  const n = plainShape({ type: "number" });
  const s = plainShape({ type: "string" });
  assert.deepEqual(check({ $ref: "n", default: "x" }, { type: "string" }, { n }, undefined, { n: "maybe" }),
    [{ path: "$.x", message: "is number, but expected string" }], "whenever it resolves it is a number; the default fits");
  assert.deepEqual(check({ $ref: "s", default: 5 }, { type: "string" }, { s }, undefined, { s: "maybe" }),
    [{ path: "$.x.default", message: "expected string, got integer" }]);
  assert.deepEqual(check({ $ref: "n", default: 5 }, { type: "string" }, { n }, undefined, { n: "maybe" }), [
    { path: "$.x", message: "is number, but expected string" },
    { path: "$.x.default", message: "expected string, got integer" },
  ], "both parts are wrong, so both are reported");
  assert.deepEqual(check({ $ref: "s", default: "x" }, { type: "string" }, { s }, undefined, { s: "maybe" }), [], "both parts fit");
  assert.deepEqual(check({ $ref: "n", default: "{{n}}" }, { type: "string", maxLength: 3 }, {}, undefined, { n: "maybe" }),
    [{ path: "$.x.default", message: "must be at most 3 characters, got 5" }], "the default is used as written, never resolved");
});

test("a reference with a default into a union: its shape is compared with every alternative, its default with the whole union", () => {
  const union: JsonSchema = { anyOf: [{ type: "string" }, { type: "boolean" }] };
  assert.deepEqual(check({ $ref: "u", default: 5 }, union, {}, undefined, { u: "maybe" }), [{ path: "$.x.default", message: "must match at least one of 2 schemas (anyOf), matched 0" }]);
  assert.deepEqual(check({ $ref: "u", default: "a" }, union, {}, undefined, { u: "maybe" }), []);
  const n = plainShape({ type: "number" });
  assert.deepEqual(check({ $ref: "n", default: "a" }, union, { n }, undefined, { n: "always" }), [{ path: "$.x", message: "never matches any of the 2 schemas (anyOf)" }],
    "the shape is wrong for both alternatives");
  assert.deepEqual(check({ $ref: "n", default: 5 }, union, { n }, undefined, { n: "maybe" }), [
    { path: "$.x", message: "never matches any of the 2 schemas (anyOf)" },
    { path: "$.x.default", message: "must match at least one of 2 schemas (anyOf), matched 0" },
  ]);
  assert.deepEqual(check({ $ref: "s", default: 5 }, union, { s: plainShape({ type: "string" }) }, undefined, { s: "always" }), [], "the shape fits one alternative");
  assert.deepEqual(check({ $ref: "n", default: 5 }, { $ref: "#/$defs/Missing" }, { n }, undefined, { n: "maybe" }), [], "a destination that does not resolve");
});

test("deep and cyclic shapes stop without a throw", () => {
  let deep: Shape = plainShape({ type: "boolean" });
  let dest: JsonSchema = { type: "string" };
  for (let i = 0; i < 100; i++) {
    deep = record({ a: deep });
    dest = { type: "object", properties: { a: dest } };
  }
  assert.deepEqual(check(ref("d"), dest, { d: deep }), [], "below the depth limit nothing is claimed");
  const cyclic: JsonSchema = { $ref: "#/$defs/A", $defs: { A: { $ref: "#/$defs/A" } } };
  assert.deepEqual(check(ref("b"), cyclic, { b: plainShape({ type: "boolean" }) }), []);
  const shallow = record({ a: record({ a: plainShape({ type: "boolean" }) }) });
  assert.deepEqual(check(ref("d"), { type: "object", properties: { a: { type: "object", properties: { a: { type: "string" } } } } }, { d: shallow }),
    [{ path: "$.x.a.a", message: "is boolean, but expected string" }]);
});

test("C5: a destination reference that lands on a named schema checks the parts inside it by that schema's own definitions", () => {
  const A: JsonSchema = { type: "object", $defs: { X: { type: "number" } }, required: ["x"], properties: { x: { $ref: "#/$defs/X" } } };
  const destination: JsonSchema = { $defs: { X: { type: "string" } }, $ref: "#/schemas/A" };
  const definitions = { A };
  const string = check({ x: ref("steps.s.v") }, destination, { "steps.s.v": plainShape({ type: "string" }) }, definitions);
  assert.deepEqual(string, [{ path: "$.x.x", message: "is string, but expected number" }]);
  assert.deepEqual(check({ x: ref("steps.s.v") }, destination, { "steps.s.v": plainShape({ type: "number" }) }, definitions), []);
  // A written literal goes through the same rule.
  assert.deepEqual(check({ x: "hello", y: ref("steps.s.v") }, destination, {}, definitions).map((p) => p.path), ["$.x.x"]);
  // A reference whose shape is A: its x is A's number, whatever the destination's own X says.
  const shapeOfA: Shape = { t: "schema", schema: { $ref: "#/schemas/A" }, root: destination, defs: definitions };
  assert.deepEqual(check(ref("steps.a"), { type: "object", properties: { x: { type: "string" } } }, { "steps.a": shapeOfA }),
    [{ path: "$.x.x", message: "is number, but expected string" }]);
});
