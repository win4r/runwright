import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSchema, validateSchema, validateSubschema, type JsonSchema } from "../../src/schema/validate.ts";

function problemsOf(schema: JsonSchema, value: unknown, definitions?: Record<string, JsonSchema>) {
  return validateSchema(schema, value, definitions === undefined ? undefined : { definitions });
}

function one(schema: JsonSchema, value: unknown): { path: string; keyword: string; message: string } {
  const problems = problemsOf(schema, value);
  assert.equal(problems.length, 1, JSON.stringify(problems));
  return problems[0]!;
}

test("type: single, union, integer vs number", () => {
  assert.deepEqual(problemsOf({ type: "string" }, "x"), []);
  assert.equal(one({ type: "string" }, 1).keyword, "type");
  assert.match(one({ type: "string" }, 1).message, /expected string, got integer/);
  assert.deepEqual(problemsOf({ type: ["string", "null"] }, null), []);
  assert.deepEqual(problemsOf({ type: "integer" }, 3), []);
  assert.deepEqual(problemsOf({ type: "integer" }, 3.0), []);
  assert.equal(one({ type: "integer" }, 3.5).keyword, "type");
  assert.deepEqual(problemsOf({ type: "number" }, 3), []);
  assert.deepEqual(problemsOf({ type: "array" }, []), []);
  assert.equal(one({ type: "object" }, []).keyword, "type");
  assert.equal(one({ type: "null" }, undefined).keyword, "type");
  assert.deepEqual(problemsOf({ type: "boolean" }, false), []);
});

test("properties, required and additionalProperties with paths", () => {
  const schema: JsonSchema = {
    type: "object",
    required: ["name", "tags"],
    additionalProperties: false,
    properties: { name: { type: "string" }, tags: { type: "array", items: { type: "string" } }, "odd key": { type: "number" } },
  };
  assert.deepEqual(problemsOf(schema, { name: "a", tags: ["x"], "odd key": 1 }), []);
  const problems = problemsOf(schema, { tags: ["x", 2], extra: true, "odd key": "no" });
  assert.deepEqual(problems.map((p) => [p.path, p.keyword]).sort(), [
    ["$.extra", "additionalProperties"],
    ["$.name", "required"],
    ["$.tags[1]", "type"],
    ['$["odd key"]', "type"],
  ].sort());
  assert.match(problems.find((p) => p.keyword === "required")!.message, /"name"/);
  const typed = problemsOf({ type: "object", additionalProperties: { type: "integer" } }, { a: 1, b: "x" });
  assert.deepEqual(typed.map((p) => p.path), ["$.b"]);
});

test("nested paths", () => {
  const schema: JsonSchema = { type: "object", properties: { items: { type: "array", items: { type: "object",
    properties: { name: { type: "string", minLength: 2 } } } } } };
  const p = one(schema, { items: [{ name: "ok" }, { name: "ok" }, { name: "x" }] });
  assert.equal(p.path, "$.items[2].name");
  assert.equal(p.keyword, "minLength");
});

test("enum and const use deep equality", () => {
  assert.deepEqual(problemsOf({ enum: ["a", { b: [1] }] }, { b: [1] }), []);
  assert.equal(one({ enum: ["a", "b"] }, "c").keyword, "enum");
  assert.deepEqual(problemsOf({ const: { x: [1, 2] } }, { x: [1, 2] }), []);
  assert.equal(one({ const: { x: [1, 2] } }, { x: [2, 1] }).keyword, "const");
  assert.equal(one({ const: null }, 0).keyword, "const");
});

test("numeric, string and array bounds", () => {
  assert.equal(one({ minimum: 2 }, 1).keyword, "minimum");
  assert.equal(one({ maximum: 2 }, 3).keyword, "maximum");
  assert.deepEqual(problemsOf({ minimum: 2, maximum: 2 }, 2), []);
  assert.equal(one({ minLength: 3 }, "ab").keyword, "minLength");
  assert.equal(one({ maxLength: 1 }, "ab").keyword, "maxLength");
  assert.deepEqual(problemsOf({ maxLength: 1 }, "😀"), [], "lengths count code points");
  assert.equal(one({ minItems: 1 }, []).keyword, "minItems");
  assert.equal(one({ maxItems: 1 }, [1, 2]).keyword, "maxItems");
  assert.deepEqual(problemsOf({ minLength: 5, minimum: 3 }, true), [], "keywords for other types do not apply");
});

test("pattern uses unicode regular expressions", () => {
  assert.deepEqual(problemsOf({ pattern: "^[a-z]+$" }, "abc"), []);
  assert.equal(one({ pattern: "^[a-z]+$" }, "aBc").keyword, "pattern");
  assert.deepEqual(problemsOf({ pattern: "^\\p{L}+$" }, "héllo"), []);
  assert.match(one({ pattern: "(" }, "x").message, /not a valid regular expression/);
});

test("anyOf and oneOf name how many matched", () => {
  const anyOf: JsonSchema = { anyOf: [{ type: "string" }, { type: "integer" }] };
  assert.deepEqual(problemsOf(anyOf, 1), []);
  const anyProblem = one(anyOf, true);
  assert.equal(anyProblem.keyword, "anyOf");
  assert.match(anyProblem.message, /matched 0/);
  const oneOf: JsonSchema = { oneOf: [{ type: "number" }, { type: "integer" }] };
  assert.deepEqual(problemsOf(oneOf, 1.5), []);
  const two = one(oneOf, 2);
  assert.equal(two.keyword, "oneOf");
  assert.equal(two.message, "must match exactly one of 2 schemas (oneOf), matched more than one");
  assert.deepEqual(problemsOf({ oneOf: [{ type: "integer" }, { type: "string" }] }, 2), []);
  assert.match(one(oneOf, "x").message, /matched 0/);
});

test("$ref forms: $defs, definitions, options.definitions, #/schemas", () => {
  const root: JsonSchema = {
    $defs: { Name: { type: "string" } },
    definitions: { Age: { type: "integer", minimum: 0 } },
    type: "object",
    properties: { name: { $ref: "#/$defs/Name" }, age: { $ref: "#/definitions/Age" }, item: { $ref: "#/schemas/Item" },
      ext: { $ref: "#/$defs/External" } },
  };
  const definitions = { Item: { type: "boolean" }, External: { const: 1 } };
  assert.deepEqual(problemsOf(root, { name: "a", age: 3, item: true, ext: 1 }, definitions), []);
  const problems = problemsOf(root, { name: 1, age: -1, item: "x", ext: 2 }, definitions);
  assert.deepEqual(problems.map((p) => `${p.path}:${p.keyword}`).sort(), ["$.age:minimum", "$.ext:const", "$.item:type", "$.name:type"]);
  const unresolved = problemsOf({ $ref: "#/schemas/Missing" }, 1);
  assert.equal(unresolved[0]?.keyword, "$ref");
  assert.equal(problemsOf({ $defs: { X: { type: "string" } }, $ref: "#/schemas/X" }, "x")[0]?.keyword, "$ref",
    "#/schemas refs only look in options.definitions");
});

test("recursive $ref follows lazily and caps depth", () => {
  const tree: JsonSchema = {
    $defs: { Node: { type: "object", required: ["v"], properties: { v: { type: "integer" }, kids: { type: "array", items: { $ref: "#/$defs/Node" } } } } },
    $ref: "#/$defs/Node",
  };
  assert.deepEqual(problemsOf(tree, { v: 1, kids: [{ v: 2, kids: [{ v: 3 }] }] }), []);
  assert.deepEqual(problemsOf(tree, { v: 1, kids: [{ v: "x" }] }).map((p) => p.path), ["$.kids[0].v"]);
  const loop: JsonSchema = { $defs: { A: { $ref: "#/$defs/B" }, B: { $ref: "#/$defs/A" } }, $ref: "#/$defs/A" };
  const problems = problemsOf(loop, 1);
  assert.equal(problems.length, 1);
  assert.equal(problems[0]!.keyword, "$ref");
  assert.match(problems[0]!.message, /reference cycle without progress/);
  const chain: Record<string, JsonSchema> = { D70: { type: "integer" } };
  for (let i = 0; i < 70; i++) chain[`D${i}`] = { $ref: `#/$defs/D${i + 1}` };
  const deep = problemsOf({ $defs: chain, $ref: "#/$defs/D0" }, 1);
  assert.equal(deep.length, 1);
  assert.match(deep[0]!.message, /depth/);
});

test("maxProblems limits output; annotations are ignored", () => {
  const schema: JsonSchema = { type: "array", items: { type: "string" } };
  const values = Array.from({ length: 100 }, (_, i) => i);
  assert.equal(validateSchema(schema, values).length, 50);
  assert.equal(validateSchema(schema, values, { maxProblems: 3 }).length, 3);
  assert.deepEqual(problemsOf({ title: "T", description: "D", default: 1, examples: [1], $schema: "x", $id: "y", type: "integer" }, 1), []);
});

test("checkSchema reports problems in the schema itself with paths", () => {
  assert.deepEqual(checkSchema({ type: "object", properties: { a: { type: "string", pattern: "^a" } }, required: ["a"] }), []);
  assert.equal(checkSchema("nope")[0]?.path, "$");
  const problems = checkSchema({
    type: "object",
    properties: { a: { type: "strng" }, b: { format: "email" }, c: { minLength: -1 }, d: { pattern: "(" } },
    items: { $ref: "#/$defs/Nope" },
    anyOf: [],
    $defs: { X: { maxItems: "3" } },
    required: [1],
    additionalProperties: { type: 5 },
  });
  const byPath = Object.fromEntries(problems.map((p) => [p.path, p.keyword]));
  assert.deepEqual(byPath, {
    "$.properties.a.type": "type",
    "$.properties.b.format": "format",
    "$.properties.c.minLength": "minLength",
    "$.properties.d.pattern": "pattern",
    "$.items.$ref": "$ref",
    "$.anyOf": "anyOf",
    "$.$defs.X.maxItems": "maxItems",
    "$.required": "required",
    "$.additionalProperties.type": "type",
  });
  assert.match(problems.find((p) => p.keyword === "format")!.message, /unsupported keyword/);
  assert.deepEqual(checkSchema({ $ref: "#/schemas/S" }, { definitions: { S: { type: "string" } } }), []);
  assert.deepEqual(checkSchema({ oneOf: [{ type: "string" }, { $ref: "#/definitions/D" }], definitions: { D: { type: "null" } } }), []);
  assert.equal(checkSchema({ items: "x" })[0]?.path, "$.items");
});

test("validateSubschema resolves references of the root from a subschema", () => {
  const root: JsonSchema = {
    $defs: { Code: { type: "string", minLength: 2 } },
    definitions: { Flag: { type: "boolean" } },
    type: "object",
    properties: { code: { $ref: "#/$defs/Code" }, flag: { $ref: "#/definitions/Flag" } },
  };
  const sub = (root["properties"] as Record<string, JsonSchema>)["code"]!;
  assert.deepEqual(validateSchema(sub, "ab"), [{ path: "$", keyword: "$ref", message: 'cannot resolve reference "#/$defs/Code"' }]);
  assert.deepEqual(validateSubschema(root, sub, "ab"), []);
  assert.deepEqual(validateSubschema(root, sub, "a"), [{ path: "$", keyword: "minLength", message: "must be at least 2 characters, got 1" }]);
  const flag = (root["properties"] as Record<string, JsonSchema>)["flag"]!;
  assert.deepEqual(validateSubschema(root, flag, true), []);
  assert.equal(validateSubschema(root, flag, 1)[0]?.keyword, "type");
  const definitions = { Out: { type: "integer" } as JsonSchema, Code: { type: "null" } as JsonSchema };
  assert.deepEqual(validateSubschema(root, { $ref: "#/schemas/Out" }, 3, { definitions }), []);
  assert.deepEqual(validateSubschema(root, sub, "ab", { definitions }), [], "the root's $defs come before options.definitions");
});

test("validateSubschema on the root gives what validateSchema gives", () => {
  const root: JsonSchema = {
    $defs: { N: { type: "integer", minimum: 1 } },
    type: "object", required: ["a", "b"], additionalProperties: false,
    properties: { a: { $ref: "#/$defs/N" }, b: { type: "array", items: { $ref: "#/$defs/N" }, maxItems: 1 } },
  };
  for (const value of [{ a: 1, b: [] }, { a: 0, b: [0, 2], c: 1 }, null, { a: "x" }]) {
    assert.deepEqual(validateSubschema(root, root, value), validateSchema(root, value));
    assert.deepEqual(validateSubschema(root, root, value, { maxProblems: 1 }), validateSchema(root, value, { maxProblems: 1 }));
  }
});
