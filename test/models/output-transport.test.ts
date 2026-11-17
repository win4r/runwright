import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, type Json } from "../../src/core/json.ts";
import { isRunwrightError } from "../../src/core/errors.ts";
import {
  OUTPUT_VALUE_KEY, WRAPPED_INSTRUCTION_SENTENCE, WRAPPED_TOOL_SENTENCE, isObjectOutputSchema, outputToolSchema,
  readOutputArgs, readOutputText, structuredResult,
} from "../../src/models/output-transport.ts";
import { validateSchema, type JsonSchema } from "../../src/schema/validate.ts";
import { decisionSchema } from "../../src/workflow/decision.ts";

test("isObjectOutputSchema is true only for a top-level type that is exactly the string \"object\"", () => {
  assert.equal(isObjectOutputSchema({ type: "object" }), true);
  assert.equal(isObjectOutputSchema(decisionSchema({ type: "yes_no" })), true);
  const others: JsonSchema[] = [
    { type: ["object"] }, { type: ["object", "null"] }, { properties: {} }, {},
    { anyOf: [{ type: "object" }, { type: "string" }] }, { $ref: "#/$defs/A" }, { type: "array" },
  ];
  for (const schema of others) assert.equal(isObjectOutputSchema(schema), false, JSON.stringify(schema));
});

test("outputToolSchema: an object schema is the same reference; any other schema is wrapped", () => {
  const object = { type: "object", properties: { a: { type: "string" } } };
  assert.equal(outputToolSchema(object), object);
  const array = { type: "array", items: { type: "integer" } };
  const wrapped = outputToolSchema(array);
  assert.equal(OUTPUT_VALUE_KEY, "value");
  assert.deepEqual(wrapped, { type: "object", additionalProperties: false, required: ["value"], properties: { value: array } });
  assert.equal(isObjectOutputSchema(wrapped), true, "the schema sent as a tool's argument schema is always an object schema");
});

test("outputToolSchema moves $defs and definitions to the wrapper without mutating its input", () => {
  const schema = {
    type: "array",
    items: { anyOf: [{ $ref: "#/$defs/Row" }, { $ref: "#/definitions/Tag" }] },
    $defs: { Row: { type: "object", required: ["id"], properties: { id: { type: "integer" } } } },
    definitions: { Tag: { type: "string", enum: ["a", "b"] } },
  };
  const before = structuredClone(schema);
  const wrapped = outputToolSchema(schema);
  assert.deepEqual(schema, before, "the input schema is not mutated");
  assert.deepEqual(wrapped["$defs"], schema.$defs);
  assert.deepEqual(wrapped["definitions"], schema.definitions);
  const inner = (wrapped["properties"] as Record<string, Record<string, unknown>>)["value"];
  assert.deepEqual(inner, { type: "array", items: schema.items });
  assert.equal(Object.hasOwn(inner ?? {}, "$defs"), false);
  assert.equal(Object.hasOwn(inner ?? {}, "definitions"), false);
  assert.notEqual(inner, schema, "the inner schema is a copy");

  const values: Json[] = [[], [{ id: 1 }, "a"], [{ id: "x" }], ["c"], [{}], "nope", null, [{ id: 2 }, "b", { id: 3 }]];
  for (const value of values) {
    const direct = validateSchema(schema, value).length === 0;
    const throughWrapper = validateSchema(wrapped, { value }).length === 0;
    assert.equal(throughWrapper, direct, `${JSON.stringify(value)}: the $ref resolves from inside the wrapper`);
  }
  assert.ok(validateSchema(wrapped, {}).length > 0, "the wrapper requires value");
  assert.ok(validateSchema(wrapped, { value: [], extra: 1 }).length > 0, "the wrapper has no other properties");
});

test("readOutputArgs: every row of its rule", () => {
  const object = { type: "object" };
  const array = { type: "array" };
  assert.deepEqual(readOutputArgs(object, { a: 1 }), { kind: "value", value: { a: 1 } });
  assert.deepEqual(readOutputArgs(object, { value: 1 }), { kind: "value", value: { value: 1 } }, "an object schema is never unwrapped");
  assert.deepEqual(readOutputArgs(object, {}), { kind: "value", value: {} });
  for (const args of [[1, 2], "s", 1, true, null] as Json[]) assert.deepEqual(readOutputArgs(object, args), { kind: "not_object" }, JSON.stringify(args));
  assert.deepEqual(readOutputArgs(array, { value: [1, 2] }), { kind: "value", value: [1, 2] });
  assert.deepEqual(readOutputArgs(array, { value: null }), { kind: "value", value: null });
  assert.deepEqual(readOutputArgs(array, { value: [1], other: 2 }), { kind: "value", value: [1] });
  assert.deepEqual(readOutputArgs(array, {}), { kind: "missing" });
  assert.deepEqual(readOutputArgs(array, { values: [1] }), { kind: "missing" });
  for (const args of [[1, 2], "s", 1.5, false, null] as Json[]) {
    assert.deepEqual(readOutputArgs(array, args), { kind: "value", value: args }, `${JSON.stringify(args)}: a model that left the wrapper out`);
  }
  const parsed = JSON.parse("{\"__proto__\":{\"value\":1}}") as Json;
  assert.deepEqual(readOutputArgs(array, parsed), { kind: "missing" }, "only an own value property counts");
});

test("readOutputText: the trimmed text parsed as JSON is the value; empty or non-JSON text is missing", () => {
  assert.deepEqual(readOutputText(" [1,2] "), { kind: "value", value: [1, 2] });
  assert.deepEqual(readOutputText("null"), { kind: "value", value: null });
  assert.deepEqual(readOutputText("{\"value\":[1,2]}"), { kind: "value", value: { value: [1, 2] } }, "never the wrapper");
  assert.deepEqual(readOutputText("\"x\""), { kind: "value", value: "x" });
  assert.deepEqual(readOutputText("hello"), { kind: "missing" });
  assert.deepEqual(readOutputText(""), { kind: "missing" });
  assert.deepEqual(readOutputText("  \n "), { kind: "missing" });
});

test("structuredResult: the first output call decides; missing is flagged; failures are model_failed", () => {
  const spec = { name: "out", schema: { type: "array" } };
  assert.deepEqual(structuredResult(spec, "p", { text: "[1]" }, "ignored"), { output: [1] });
  assert.deepEqual(structuredResult(spec, "p", { value: { value: [2] } }, ""), { output: [2] });
  assert.deepEqual(structuredResult(spec, "p", { text: "" }, "[3]"), { output: null, outputMissing: true }, "the text is not consulted once the tool was called");
  assert.deepEqual(structuredResult(spec, "p", null, "[3]"), { output: [3] });
  assert.deepEqual(structuredResult(spec, "p", null, "no"), { output: null, outputMissing: true });
  const failed = (pattern: RegExp) => (error: unknown) =>
    isRunwrightError(error) && error.code === "model_failed" && error.details?.["billing"] === "unknown" && pattern.test(error.message);
  assert.throws(() => structuredResult(spec, "p", { text: "[1," }, ""), failed(/^p returned arguments for tool "out" that are not valid JSON$/));
  const objectSpec = { name: "obj", schema: { type: "object" } };
  assert.throws(() => structuredResult(objectSpec, "p", { text: "[1," }, ""), failed(/^p returned arguments for tool "obj" that are not a JSON object$/));
  assert.throws(() => structuredResult(objectSpec, "p", { value: [1] }, ""), failed(/that are not a JSON object$/));
});

test("fixed overhead: the wrapper adds at most 128 bytes and each sentence is under 64 bytes", () => {
  const row = { type: "object", required: ["id"], properties: { id: { type: "integer" }, tags: { type: "array", items: { type: "string" } } } };
  const schemas: JsonSchema[] = [
    { type: "string" },
    { type: "null" },
    { type: ["string", "null"], maxLength: 10 },
    { type: "array", items: { type: "integer" } },
    { type: "array", items: { $ref: "#/$defs/Row" }, $defs: { Row: row } },
    { anyOf: [{ $ref: "#/definitions/Row" }, { type: "null" }], definitions: { Row: row } },
    { type: "array", items: { $ref: "#/$defs/Row" }, $defs: { Row: row }, definitions: { Other: { type: "string" } } },
    { $ref: "#/$defs/Row", $defs: { Row: { ...row, description: "x".repeat(5000) } } },
  ];
  for (const schema of schemas) {
    const overhead = Buffer.byteLength(canonicalJson(outputToolSchema(schema))) - Buffer.byteLength(canonicalJson(schema));
    assert.ok(overhead <= 128, `${overhead} bytes for ${canonicalJson(schema).slice(0, 80)}`);
  }
  assert.equal(WRAPPED_TOOL_SENTENCE, " Put the result in the \"value\" argument.");
  assert.equal(WRAPPED_INSTRUCTION_SENTENCE, " Put the answer in its \"value\" argument.");
  assert.ok(Buffer.byteLength(WRAPPED_TOOL_SENTENCE) < 64);
  assert.ok(Buffer.byteLength(WRAPPED_INSTRUCTION_SENTENCE) < 64);
});
