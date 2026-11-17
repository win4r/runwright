/**
 * bundleSchema walks schemas, not objects: names under `properties`, `$defs` and `definitions` are never taken for
 * keywords, and data under `const`, `enum`, `default` and `examples` is never rewritten (workflow-01).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Json } from "../../src/core/json.ts";
import { generatePlaceholder } from "../../src/schema/placeholder.ts";
import { checkSchema, validateSchema, type JsonSchema } from "../../src/schema/validate.ts";
import { bundleSchema } from "../../src/workflow/schemas.ts";
import type { WorkflowDocument } from "../../src/workflow/types.ts";

function document(schemas: { [name: string]: JsonSchema }): WorkflowDocument {
  return {
    format: "runwright.workflow/v1", name: "bundle", schemas, input: "Out", output: "Out",
    root: { id: "w", kind: "wait", question: "q" }, result: null,
  };
}

const TEXT: JsonSchema = { type: "string", minLength: 1 };
const KEYWORD_NAMES = ["const", "enum", "default", "examples", "properties", "items", "$ref", "anyOf", "additionalProperties"];

test("a property named like a keyword is a schema: its reference is rewritten", () => {
  const properties: { [name: string]: Json } = {};
  for (const name of KEYWORD_NAMES) properties[name] = { $ref: "#/schemas/Text" };
  const out: JsonSchema = { type: "object", required: KEYWORD_NAMES, additionalProperties: false, properties };
  const bundle = bundleSchema(document({ Text: TEXT, Out: out }), "Out");
  assert.deepEqual(checkSchema(bundle), []);
  const good: { [name: string]: Json } = {};
  for (const name of KEYWORD_NAMES) good[name] = "x";
  assert.deepEqual(validateSchema(bundle, good), []);
  for (const name of KEYWORD_NAMES) {
    const wrong = { ...good, [name]: "" };
    assert.deepEqual(validateSchema(bundle, wrong).map((p) => [p.path, p.keyword]), [[`$.${name}`, "minLength"]], name);
  }
});

test("a named schema called const, and a $defs entry called enum", () => {
  const named = bundleSchema(document({ const: TEXT, Out: { type: "object", properties: { a: { $ref: "#/schemas/const" } } } }), "Out");
  assert.deepEqual(checkSchema(named), []);
  assert.deepEqual(validateSchema(named, { a: "x" }), []);
  assert.deepEqual(validateSchema(named, { a: "" }).map((p) => p.keyword), ["minLength"]);

  const local: JsonSchema = { type: "object", $defs: { enum: { type: "object", properties: { t: { $ref: "#/schemas/Text" } } } },
    properties: { e: { $ref: "#/$defs/enum" } } };
  const bundle = bundleSchema(document({ Text: TEXT, Out: local }), "Out");
  assert.deepEqual(checkSchema(bundle), []);
  assert.deepEqual(validateSchema(bundle, { e: { t: "x" } }), []);
  assert.deepEqual(validateSchema(bundle, { e: { t: "" } }).map((p) => [p.path, p.keyword]), [["$.e.t", "minLength"]]);
  const definitions = bundleSchema(document({ Text: TEXT, Out: { definitions: { default: { $ref: "#/schemas/Text" } }, $ref: "#/definitions/default" } }), "Out");
  assert.deepEqual(validateSchema(definitions, "x"), []);
  assert.deepEqual(validateSchema(definitions, "").map((p) => p.keyword), ["minLength"]);
});

test("references inside items, additionalProperties, anyOf and oneOf are rewritten", () => {
  const out: JsonSchema = { type: "object", properties: {
    list: { type: "array", items: { $ref: "#/schemas/Text" } },
    map: { type: "object", additionalProperties: { $ref: "#/schemas/Text" } },
    either: { anyOf: [{ $ref: "#/schemas/Text" }, { type: "integer" }] },
    one: { oneOf: [{ $ref: "#/schemas/Text" }, { type: "integer" }] },
  } };
  const bundle = bundleSchema(document({ Text: TEXT, Out: out }), "Out");
  assert.deepEqual(checkSchema(bundle), []);
  assert.deepEqual(validateSchema(bundle, { list: ["a"], map: { k: "v" }, either: "a", one: 2 }), []);
  assert.deepEqual(validateSchema(bundle, { list: [""], map: { k: "" }, either: "", one: "" }).map((p) => p.path), ["$.list[0]", "$.map.k", "$.either", "$.one"]);
});

test("data that looks like a reference is left exactly as written", () => {
  const data: Json = { $ref: "#/schemas/Text" };
  const out: JsonSchema = { type: "object", properties: {
    c: { const: data }, e: { enum: [data, { nested: data }] }, d: { type: "object", default: data, examples: [data] },
  }, required: ["c"] };
  const bundle = bundleSchema(document({ Text: TEXT, Out: out }), "Out");
  const properties = bundle["properties"] as { [name: string]: { [keyword: string]: Json } };
  assert.deepEqual(properties["c"]?.["const"], data);
  assert.deepEqual(properties["e"]?.["enum"], [data, { nested: data }]);
  assert.deepEqual(properties["d"]?.["default"], data);
  assert.deepEqual(properties["d"]?.["examples"], [data]);
  assert.equal(Object.hasOwn(bundle, "$defs"), false, "no named schema was pulled in");
  assert.deepEqual(validateSchema(bundle, { c: data }), []);
  assert.deepEqual(validateSchema(bundle, { c: "x" }).map((p) => p.keyword), ["const"]);
});

test("a boolean schema stays as it is, and a property named __proto__ is kept as a name", () => {
  const out = JSON.parse(`{"type": "object", "additionalProperties": false, "properties": {"__proto__": {"$ref": "#/schemas/Text"}}}`) as JsonSchema;
  const bundle = bundleSchema(document({ Text: TEXT, Out: out }), "Out");
  assert.equal(bundle["additionalProperties"], false);
  const properties = bundle["properties"] as JsonSchema;
  assert.ok(Object.hasOwn(properties, "__proto__"));
  const value = JSON.parse(`{"__proto__": ""}`) as Json;
  assert.deepEqual(validateSchema(bundle, value).map((p) => p.keyword), ["minLength"]);
});

/** A small deterministic generator (mulberry32). */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LEAVES: JsonSchema[] = [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "string", minLength: 2 }, { enum: [1, "a", null] }];
const NAMES = ["S0", "S1", "S2", "S3", "X", "Y"];
const DEF_NAMES = ["X", "Y", "S1", "S2"];

/**
 * A document whose named schemas have their own `$defs` / `definitions` (with names that collide across schemas and
 * with schema names), and properties that refer with `#/$defs/N`, `#/definitions/N` and `#/schemas/N`.
 */
function generatedDocument(seed: number): WorkflowDocument {
  const next = random(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
  const schemas: { [name: string]: JsonSchema } = {};
  for (const name of NAMES) {
    const defs: { [name: string]: Json } = {};
    const definitions: { [name: string]: Json } = {};
    for (const def of DEF_NAMES) {
      if (next() < 0.4) defs[def] = pick(LEAVES);
      if (next() < 0.2) definitions[def] = pick(LEAVES);
    }
    const properties: { [name: string]: Json } = {};
    for (const property of ["p0", "p1", "p2"]) {
      const roll = next();
      if (roll < 0.3) properties[property] = { $ref: `#/$defs/${pick(DEF_NAMES)}` };
      else if (roll < 0.45) properties[property] = { $ref: `#/definitions/${pick(DEF_NAMES)}` };
      else if (roll < 0.75) properties[property] = { $ref: `#/schemas/${pick(NAMES)}` };
      else properties[property] = pick(LEAVES);
    }
    const schema: JsonSchema = { type: "object", properties };
    if (Object.keys(defs).length > 0) schema["$defs"] = defs;
    if (Object.keys(definitions).length > 0) schema["definitions"] = definitions;
    if (next() < 0.3) schema["required"] = ["p0"];
    schemas[name] = schema;
  }
  return document(schemas);
}

function sampleValue(next: () => number, depth: number): Json {
  const roll = next();
  if (depth >= 3 || (depth > 0 && roll < 0.55)) return [1, 2.5, "a", "ab", "", true, false, null][Math.floor(next() * 8)] as Json;
  const out: { [name: string]: Json } = {};
  for (const property of ["p0", "p1", "p2"]) if (next() < 0.7) out[property] = sampleValue(next, depth + 1);
  return out;
}

test("property: a bundle gives the same verdict as its named schema with the document's definitions", () => {
  let compared = 0;
  let valid = 0;
  for (let seed = 1; seed <= 24; seed++) {
    const doc = generatedDocument(seed);
    const definitions = doc.schemas as Record<string, JsonSchema>;
    const next = random(seed * 7919);
    for (const name of NAMES) {
      const bundle = bundleSchema(doc, name);
      const named = definitions[name] as JsonSchema;
      const resolves = checkSchema(named, { definitions }).length === 0;
      if (resolves) assert.deepEqual(checkSchema(bundle), [], `seed ${seed} ${name}: every reference of the bundle resolves`);
      const samples: Json[] = [generatePlaceholder(named, { definitions }).value];
      for (let i = 1; i < 30; i++) samples.push(sampleValue(next, 0));
      for (const value of samples) {
        const direct = validateSchema(named, value, { definitions }).length === 0;
        const viaBundle = validateSchema(bundle, value).length === 0;
        assert.equal(viaBundle, direct, `seed ${seed} ${name} ${JSON.stringify(value)}`);
        compared++;
        if (direct) valid++;
      }
    }
  }
  assert.ok(compared === 24 * NAMES.length * 30 && valid > 200 && valid < compared - 200, `a mix of verdicts: ${valid} of ${compared}`);
});
