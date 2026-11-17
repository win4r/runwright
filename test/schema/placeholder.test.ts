import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePlaceholder, placeholderFor } from "../../src/schema/placeholder.ts";
import { canonicalJson, type Json } from "../../src/core/json.ts";
import { validateSchema, type JsonSchema } from "../../src/schema/validate.ts";

const cases: { name: string; schema: JsonSchema; expected: unknown; definitions?: Record<string, JsonSchema> }[] = [
  { name: "const", schema: { const: { a: 1 } }, expected: { a: 1 } },
  { name: "enum", schema: { enum: ["b", "a"] }, expected: "b" },
  { name: "string", schema: { type: "string" }, expected: "" },
  { name: "padded string", schema: { type: "string", minLength: 3 }, expected: "xxx" },
  { name: "integer with minimum", schema: { type: "integer", minimum: 2.5 }, expected: 3 },
  { name: "number", schema: { type: "number" }, expected: 0 },
  { name: "negative maximum", schema: { type: "number", maximum: -4 }, expected: -4 },
  { name: "boolean", schema: { type: "boolean" }, expected: false },
  { name: "null", schema: { type: "null" }, expected: null },
  { name: "type union", schema: { type: ["string", "null"] }, expected: "" },
  { name: "array", schema: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 2 }, expected: [1, 1] },
  {
    name: "object with required",
    schema: { type: "object", required: ["a", "b"], additionalProperties: false,
      properties: { a: { type: "string" }, b: { type: "object", required: ["c"], properties: { c: { enum: [7] } } }, opt: { type: "string" } } },
    expected: { a: "", b: { c: 7 } },
  },
  { name: "anyOf", schema: { anyOf: [{ type: "integer" }, { type: "string" }] }, expected: 0 },
  { name: "oneOf", schema: { oneOf: [{ type: "boolean" }, { type: "string" }] }, expected: false },
  { name: "$defs ref", schema: { $defs: { N: { type: "string", minLength: 1 } }, $ref: "#/$defs/N" }, expected: "x" },
  { name: "#/schemas ref", schema: { $ref: "#/schemas/Out" }, expected: { ok: false },
    definitions: { Out: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } } } },
  {
    name: "decision-like",
    schema: { type: "object", required: ["value", "confidence", "reason"], properties: {
      value: { type: "string", enum: ["red", "green"] }, confidence: { type: "number", minimum: 0, maximum: 1 }, reason: { type: "string" } } },
    expected: { value: "red", confidence: 0, reason: "" },
  },
];

for (const c of cases) {
  test(`placeholder: ${c.name}`, () => {
    const options = c.definitions === undefined ? undefined : { definitions: c.definitions };
    const value = placeholderFor(c.schema, options);
    assert.deepEqual(value, c.expected);
    assert.deepEqual(validateSchema(c.schema, value, options), []);
  });
}

test("placeholder is deterministic and survives recursive schemas", () => {
  const tree: JsonSchema = { $defs: { T: { type: "object", required: ["kids"], properties: { kids: { type: "array", items: { $ref: "#/$defs/T" } } } } }, $ref: "#/$defs/T" };
  assert.deepEqual(placeholderFor(tree), { kids: [] });
  assert.deepEqual(placeholderFor(tree), placeholderFor(tree));
});

test("R05-02 reviewer's probe: a pattern-constrained required property gets a placeholder that validates", () => {
  const schema: JsonSchema = {
    type: "object", required: ["code"],
    properties: { code: { type: "string", pattern: "^[A-Z]{2}$", minLength: 2, maxLength: 2 } },
  };
  const result = generatePlaceholder(schema);
  assert.equal(result.satisfied, true);
  assert.deepEqual(result.value, { code: "AA" });
  assert.deepEqual(validateSchema(schema, result.value), []);
});

interface Row { name: string; schema: JsonSchema; definitions?: Record<string, JsonSchema>; expected?: unknown }

const satisfiable: Row[] = [
  { name: "pattern with minLength", schema: { type: "string", pattern: "^[A-Z]{2}$", minLength: 2 }, expected: "AA" },
  { name: "enum whose first value has the wrong type", schema: { type: "integer", enum: ["a", 3] }, expected: 3 },
  { name: "anyOf branches that add required to the parent's properties",
    schema: { type: "object", anyOf: [{ required: ["a"] }, { required: ["b"] }], properties: { a: { type: "string" }, b: { type: "string" } } },
    expected: { a: "" } },
  { name: "anyOf branch that needs the parent's property schema",
    schema: { type: "object", properties: { n: { type: "integer", minimum: 5 } }, anyOf: [{ required: ["n"] }] }, expected: { n: 5 } },
  { name: "oneOf where integer and number overlap", schema: { oneOf: [{ type: "integer" }, { type: "number" }] }, expected: 0.5 },
  { name: "oneOf where the first branch's value also matches a second branch",
    schema: { oneOf: [{ type: "string" }, { type: "string", maxLength: 3 }, { type: "boolean" }] }, expected: false },
  { name: "$ref with sibling keywords", schema: { $ref: "#/$defs/A", minLength: 3, $defs: { A: { type: "string" } } }, expected: "xxx" },
  { name: "anyOf narrowing a required property",
    schema: { type: "object", properties: { a: { type: "string" } }, required: ["a"], anyOf: [{ properties: { a: { enum: ["q"] } } }] },
    expected: { a: "q" } },
  { name: "date pattern", schema: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, expected: "0000-00-00" },
  { name: "slug pattern with minLength", schema: { type: "string", pattern: "^[a-z0-9-]+$", minLength: 5 }, expected: "aaaaa" },
  { name: "alternation pattern", schema: { type: "string", pattern: "^(bug|idea)-[0-9]+$" }, expected: "bug-0" },
  { name: "unanchored pattern", schema: { type: "string", pattern: "[A-F]" }, expected: "A" },
  { name: "pattern with maxLength", schema: { type: "string", pattern: "^(?:abcdef|z)+$", maxLength: 3 }, expected: "z" },
  { name: "default when the by-type value would not fit", schema: { type: "string", pattern: "^(?=v)v\\d$", default: "v1" }, expected: "v1" },
  { name: "default is skipped when it does not fit", schema: { type: "integer", minimum: 2, default: 0 }, expected: 2 },
  { name: "examples for a look-ahead pattern",
    schema: { type: "string", pattern: "^(?=.*\\d)[a-z0-9]{3}$", examples: ["nope", "ab1", "cd2"] }, expected: "ab1" },
  { name: "$ref to $defs", schema: { $defs: { C: { type: "string", pattern: "^C-\\d$" } }, $ref: "#/$defs/C" }, expected: "C-0" },
  { name: "$ref to definitions", schema: { definitions: { C: { type: "integer", minimum: 7 } }, $ref: "#/definitions/C", maximum: 9 }, expected: 7 },
  { name: "$ref to #/schemas/N with siblings", schema: { $ref: "#/schemas/Out", required: ["id"] },
    definitions: { Out: { type: "object", properties: { id: { type: "string", pattern: "^id_[a-z]+$" } } } }, expected: { id: "id_a" } },
  { name: "type union whose first type cannot satisfy the other keywords",
    schema: { type: ["string", "integer"], minimum: 1, pattern: "(?=x)y" }, expected: 1 },
  { name: "number that must not be an integer", schema: { type: "number", oneOf: [{ type: "integer" }, { minimum: -1 }] }, expected: -0.5 },
  { name: "nested objects and arrays of the above",
    schema: {
      type: "object", required: ["items", "meta"],
      properties: {
        items: { type: "array", minItems: 2, maxItems: 2, items: { type: "object", required: ["code", "kind"],
          properties: { code: { type: "string", pattern: "^[A-Z]{2}$" }, kind: { type: "integer", enum: ["x", 4] } } } },
        meta: { $ref: "#/$defs/Meta", required: ["tag"] },
      },
      $defs: { Meta: { type: "object", properties: { tag: { oneOf: [{ type: "integer" }, { type: "number" }] } } } },
    },
    expected: { items: [{ code: "AA", kind: 4 }, { code: "AA", kind: 4 }], meta: { tag: 0.5 } } },
];

const unsatisfiable: Row[] = [
  { name: "integer between 0.5 and 0.7", schema: { type: "integer", minimum: 0.5, maximum: 0.7 } },
  { name: "minItems above maxItems", schema: { type: "array", minItems: 2, maxItems: 1 } },
  { name: "const of the wrong type", schema: { type: "string", const: 5 } },
  { name: "look-ahead pattern without examples or default", schema: { type: "string", pattern: "^(?=a)b$" } },
  { name: "required property that is not allowed", schema: { type: "object", required: ["a"], additionalProperties: false } },
  { name: "a schema that requires itself forever",
    schema: { $defs: { A: { type: "object", required: ["a"], properties: { a: { $ref: "#/$defs/A" } } } }, $ref: "#/$defs/A" } },
  { name: "examples and default that do not fit", schema: { type: "string", pattern: "^(?=q)z$", default: "a", examples: ["b"] } },
];

function optionsOf(row: Row) {
  return row.definitions === undefined ? undefined : { definitions: row.definitions };
}

for (const row of satisfiable) {
  test(`placeholder satisfies: ${row.name}`, () => {
    const options = optionsOf(row);
    const result = generatePlaceholder(row.schema, options);
    assert.equal(result.satisfied, true, JSON.stringify(result.value));
    assert.deepEqual(validateSchema(row.schema, result.value, options), []);
    if (row.expected !== undefined) assert.deepEqual(result.value, row.expected);
  });
}

for (const row of unsatisfiable) {
  test(`placeholder reports that it could not: ${row.name}`, () => {
    const options = optionsOf(row);
    const result = generatePlaceholder(row.schema, options);
    assert.equal(result.satisfied, false);
    assert.notDeepEqual(validateSchema(row.schema, result.value, options), []);
    assert.deepEqual(JSON.parse(JSON.stringify(result.value)), result.value);
  });
}

test("unsatisfiable placeholders are the first by-type candidate", () => {
  assert.equal(placeholderFor({ type: "integer", minimum: 0.5, maximum: 0.7 }), 0);
  assert.deepEqual(placeholderFor({ type: "array", minItems: 2, maxItems: 1 }), [null, null]);
  assert.equal(placeholderFor({ type: "string", const: 5 }), "");
  assert.deepEqual(placeholderFor({ type: "object", required: ["a"], additionalProperties: false }), { a: null });
  assert.equal(placeholderFor({ type: "null", const: 5 }), null);
  assert.equal(placeholderFor({ enum: [1, 2], minimum: 5 }), null);
  assert.equal(placeholderFor({ type: "foo", enum: [1, 2], minimum: 5 } as JsonSchema), 1);
});

test("invariant G1: satisfied is exactly what validateSchema says, and placeholderFor is the value", () => {
  const rows = [...satisfiable, ...unsatisfiable, ...cases.map((c) => ({ name: c.name, schema: c.schema, definitions: c.definitions }))];
  for (const row of rows) {
    const options = optionsOf(row);
    const result = generatePlaceholder(row.schema, options);
    assert.equal(result.satisfied, validateSchema(row.schema, result.value, options).length === 0, row.name);
    assert.deepEqual(placeholderFor(row.schema, options), result.value, row.name);
  }
});

test("limits: huge minLength and minItems return promptly with a cut value", () => {
  const started = Date.now();
  const text = generatePlaceholder({ type: "string", minLength: 1_000_000_000 });
  assert.equal(text.satisfied, false);
  assert.equal(typeof text.value, "string");
  assert.ok((text.value as string).length <= 4096);
  const list = generatePlaceholder({ type: "array", minItems: 1_000_000_000 });
  assert.equal(list.satisfied, false);
  assert.ok(Array.isArray(list.value) && list.value.length <= 256);
  const patterned = generatePlaceholder({ type: "string", pattern: "^a+$", minLength: 1_000_000_000 });
  assert.equal(patterned.satisfied, false);
  const runaway = generatePlaceholder({ type: "string", pattern: "(a|b)".repeat(40) + "[]" });
  assert.equal(runaway.satisfied, false);
  assert.ok(Date.now() - started < 1000);
});

test("limits: nested large arrays stay within the total array budget", () => {
  const started = Date.now();
  const deep: JsonSchema = { type: "array", minItems: 256, items: { type: "array", minItems: 256,
    items: { type: "array", minItems: 256, items: { type: "string", minLength: 4096 } } } };
  const result = generatePlaceholder(deep);
  assert.equal(result.satisfied, false);
  assert.ok(JSON.stringify(result.value).length < 10_000_000);
  const fits = generatePlaceholder({ type: "array", minItems: 256, items: { type: "array", minItems: 256, items: { type: "integer" } } });
  assert.equal(fits.satisfied, true);
  assert.ok(Date.now() - started < 3000);
});

test("limits: many nested anyOf levels and deep nesting return", () => {
  let nested: JsonSchema = { type: "integer", minimum: 3 };
  for (let i = 0; i < 200; i++) nested = { anyOf: [nested, { type: "string", minLength: 1 }] };
  const started = Date.now();
  const result = generatePlaceholder(nested);
  assert.equal(result.satisfied, validateSchema(nested, result.value).length === 0);
  let wide: JsonSchema = { type: "integer", minimum: 3 };
  for (let i = 0; i < 30; i++) wide = { anyOf: [{ type: "string", pattern: "(?=x)y" }, wide, { type: "boolean", const: true }] };
  const second = generatePlaceholder(wide);
  assert.equal(second.satisfied, true);
  let deep: JsonSchema = { type: "string" };
  for (let i = 0; i < 100; i++) deep = { type: "object", required: ["a"], properties: { a: deep } };
  const third = generatePlaceholder(deep);
  assert.equal(third.satisfied, false);
  assert.ok(Date.now() - started < 5000);
});

test("placeholder is deterministic and does not mutate its schema", () => {
  for (const row of [...satisfiable, ...unsatisfiable]) {
    const before = canonicalJson(row.schema);
    const options = optionsOf(row);
    const first = generatePlaceholder(row.schema, options);
    const second = generatePlaceholder(row.schema, options);
    assert.deepEqual(first, second, row.name);
    assert.equal(canonicalJson(row.schema), before, row.name);
  }
});

test("a placeholder does not share structure with its schema", () => {
  const schema: JsonSchema = { type: "object", default: { list: [1] } };
  const value = placeholderFor(schema) as { list: Json[] };
  value.list.push(2);
  assert.deepEqual(schema["default"], { list: [1] });
});
