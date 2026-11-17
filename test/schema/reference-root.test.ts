/**
 * Contract C5, one reference-root rule: a local reference is resolved against the schema document it is written
 * in, and following a reference that lands on a named schema makes that named schema the document for the
 * references inside it. The same answer at all five resolvers: run-time validation and the schema self-check,
 * placeholders, static assignment, static shapes and bundling.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Json } from "../../src/core/json.ts";
import { generatePlaceholder } from "../../src/schema/placeholder.ts";
import { checkSchema, resolveSchemaRef, resolveSchemaRefIn, validateSchema, type JsonSchema } from "../../src/schema/validate.ts";
import { bundleSchema } from "../../src/workflow/schemas.ts";
import type { WorkflowDocument } from "../../src/workflow/types.ts";
import { validateWorkflow } from "../../src/workflow/validate.ts";
import { namedShape, walkShape } from "../../src/workflow/walk.ts";

/** A: its own `$defs.X` is a number, and its required `x` is `#/$defs/X`. */
const A: JsonSchema = { type: "object", $defs: { X: { type: "number" } }, required: ["x"], properties: { x: { $ref: "#/$defs/X" } } };

/** The reviewer's document: Input defines `$defs.X` as a string and refers to A. */
function reviewer(inputDefinesX: boolean, output: JsonSchema = {}): WorkflowDocument {
  const input: JsonSchema = inputDefinesX ? { $defs: { X: { type: "string" } }, $ref: "#/schemas/A" } : { $ref: "#/schemas/A" };
  return {
    format: "runwright.workflow/v1", name: "reviewer", schemas: { Input: input, A, Out: output }, input: "Input", output: "Out",
    root: { id: "w", kind: "wait", question: "q" }, result: { $ref: "input.x" },
  };
}

const definitionsOf = (document: WorkflowDocument): Record<string, JsonSchema> => document.schemas as Record<string, JsonSchema>;

test("resolveSchemaRefIn: the target's references resolve in the target when it was found among the definitions", () => {
  const input = reviewer(true).schemas["Input"] as JsonSchema;
  const definitions = definitionsOf(reviewer(true));
  const own = resolveSchemaRefIn("#/$defs/X", input, definitions);
  assert.deepEqual(own, { schema: { type: "string" }, root: input });
  const named = resolveSchemaRefIn("#/schemas/A", input, definitions);
  assert.equal(named?.schema, A);
  assert.equal(named?.root, A);
  const fallback = resolveSchemaRefIn("#/$defs/A", {}, definitions);
  assert.equal(fallback?.root, A, "a $defs reference that falls back to a named schema enters it");
  assert.equal(resolveSchemaRefIn("#/$defs/missing", input, definitions), null);
  assert.equal(resolveSchemaRef("#/schemas/A", input, definitions), A, "resolveSchemaRef is unchanged");
});

for (const inputDefinesX of [true, false]) {
  const label = inputDefinesX ? "Input and A both define X" : "only A defines X";
  test(`${label}: every resolver reads x as A's number`, () => {
    const document = reviewer(inputDefinesX);
    const definitions = definitionsOf(document);
    const input = document.schemas["Input"] as JsonSchema;

    // Run-time validation and the schema self-check.
    assert.ok(validateSchema(input, { x: "hello" }, { definitions }).some((p) => p.path === "$.x" && p.keyword === "type"));
    assert.deepEqual(validateSchema(input, { x: 1 }, { definitions }), []);
    assert.deepEqual(checkSchema(input, { definitions }), []);
    assert.deepEqual(checkSchema(A, { definitions }), []);

    // Bundling: the same two answers without options.
    const bundle = bundleSchema(document, "Input");
    assert.deepEqual(checkSchema(bundle), []);
    assert.ok(validateSchema(bundle, { x: "hello" }).some((p) => p.path === "$.x" && p.keyword === "type"));
    assert.deepEqual(validateSchema(bundle, { x: 1 }), []);

    // Placeholders, from the named schema and from the bundle.
    const placeholder = generatePlaceholder(input, { definitions });
    assert.equal(placeholder.satisfied, true);
    assert.equal(typeof (placeholder.value as { x: Json }).x, "number");
    const bundled = generatePlaceholder(bundle);
    assert.equal(bundled.satisfied, true);
    assert.equal(typeof (bundled.value as { x: Json }).x, "number");

    // Static shapes.
    const shape = walkShape(namedShape(document.schemas, "Input"), ["x"]);
    assert.equal(shape.problem, null);
    assert.ok(shape.shape.t === "schema" && shape.shape.schema["type"] === "number", JSON.stringify(shape.shape));

    // Static assignment: input.x into a number output fits, into a string output never does.
    assert.equal(validateWorkflow(reviewer(inputDefinesX, { type: "number" })).ok, true,
      JSON.stringify(validateWorkflow(reviewer(inputDefinesX, { type: "number" })).problems));
    const mismatch = validateWorkflow(reviewer(inputDefinesX, { type: "string" })).problems.filter((p) => p.code === "schema_mismatch");
    assert.deepEqual(mismatch.map((p) => p.path), ["$.result"]);
  });
}

test("a named schema's definitions do not leak into the entry: Input's own X stays a string for Input's references", () => {
  const document: WorkflowDocument = {
    ...reviewer(true),
    schemas: {
      Input: { $defs: { X: { type: "string" } }, type: "object", required: ["a", "s"], properties: { a: { $ref: "#/schemas/A" }, s: { $ref: "#/$defs/X" } } },
      A, Out: {},
    },
  };
  const definitions = definitionsOf(document);
  const input = document.schemas["Input"] as JsonSchema;
  const bundle = bundleSchema(document, "Input");
  for (const [value, ok] of [[{ a: { x: 1 }, s: "t" }, true], [{ a: { x: "t" }, s: "t" }, false], [{ a: { x: 1 }, s: 1 }, false]] as const) {
    assert.equal(validateSchema(input, value, { definitions }).length === 0, ok, JSON.stringify(value));
    assert.equal(validateSchema(bundle, value).length === 0, ok, JSON.stringify(value));
  }
  const placeholder = generatePlaceholder(input, { definitions });
  assert.deepEqual([placeholder.satisfied, typeof (placeholder.value as { s: Json }).s], [true, "string"]);
});

test("recursion through two named schemas that reference each other terminates at every resolver", () => {
  const document: WorkflowDocument = {
    format: "runwright.workflow/v1", name: "tree", input: "A", output: "A",
    schemas: {
      A: { type: "object", $defs: { Leaf: { type: "string" } }, properties: { b: { $ref: "#/schemas/B" }, leaf: { $ref: "#/$defs/Leaf" } } },
      B: { type: "object", $defs: { Leaf: { type: "integer" } }, properties: { a: { $ref: "#/$defs/A" }, leaf: { $ref: "#/$defs/Leaf" } } },
    },
    root: { id: "w", kind: "wait", question: "q" }, result: { $ref: "input" },
  };
  const definitions = definitionsOf(document);
  const a = document.schemas["A"] as JsonSchema;
  const deep = { leaf: "s", b: { leaf: 1, a: { leaf: "s", b: { leaf: 2, a: {} } } } };
  const wrong = { leaf: "s", b: { leaf: "s" } };
  const bundle = bundleSchema(document, "A");
  assert.deepEqual(checkSchema(bundle), []);
  for (const [value, ok] of [[deep, true], [wrong, false]] as const) {
    assert.equal(validateSchema(a, value, { definitions }).length === 0, ok);
    assert.equal(validateSchema(bundle, value).length === 0, ok);
  }
  assert.equal(generatePlaceholder(a, { definitions }).satisfied, true);
  assert.equal(validateWorkflow(document).ok, true, JSON.stringify(validateWorkflow(document).problems));
  const leaf = walkShape(namedShape(document.schemas, "A"), ["b", "a", "b", "leaf"]);
  assert.ok(leaf.shape.t === "schema" && leaf.shape.schema["type"] === "integer", JSON.stringify(leaf.shape));
});
