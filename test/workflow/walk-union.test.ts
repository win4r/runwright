import { test } from "node:test";
import assert from "node:assert/strict";
import type { Json } from "../../src/core/json.ts";
import { generatePlaceholder } from "../../src/schema/placeholder.ts";
import { validateSchema, validateSubschema, type JsonSchema } from "../../src/schema/validate.ts";
import { parseRefPath, resolveRef, type RefScope } from "../../src/workflow/refs.ts";
import { validateWorkflow } from "../../src/workflow/validate.ts";
import { namedShape, walkShape } from "../../src/workflow/walk.ts";
import type { Expr, WorkflowDocument } from "../../src/workflow/types.ts";

/** The reviewer's schema: an array of numbers, or an object whose property "0" is a string. */
const UNION: JsonSchema = { type: ["array", "object"], items: { type: "number" }, properties: { "0": { type: "string" } } };

function doc(input: JsonSchema, output: JsonSchema, result: Expr): WorkflowDocument {
  return {
    format: "runwright.workflow/v1", name: "union", input: "In", output: "Out", schemas: { In: input, Out: output },
    root: { id: "w", kind: "wait", question: "go?" }, result,
  };
}

const scope = (input: Json): RefScope => ({ input, steps: {}, vars: {}, loop: {}, run: { id: "r", agentId: "a" } });
const shapeOf = (input: JsonSchema, path: string) => walkShape(namedShape({ In: input }, "In"), parseRefPath(path).slice(1));
const problems = (d: WorkflowDocument): string[] => validateWorkflow(d).problems.map((p) => `${p.severity} ${p.code} ${p.path}: ${p.message}`);

test("(R15D-workflow-02) a numeric segment into an array-or-object schema is not typed: string and number outputs both validate", () => {
  for (const output of [{ type: "string" }, { type: "number" }]) {
    const report = validateWorkflow(doc(UNION, output, { $ref: "input.0" }));
    assert.equal(report.ok, true, JSON.stringify(report.problems));
    assert.deepEqual(report.problems, []);
  }
  assert.deepEqual(shapeOf(UNION, "input.0"), { shape: { t: "unknown" }, problem: null });
  assert.equal(resolveRef("input.0", scope({ "0": "valid" })), "valid");
  assert.equal(resolveRef("input.0", scope([1])), 1);
  assert.deepEqual(validateSchema(UNION, { "0": "valid" }), []);
  assert.deepEqual(validateSchema(UNION, [1]), []);
});

test("(R15D-workflow-02) both readings agree: the shape is that schema and a mismatch is still reported", () => {
  const same: JsonSchema = { type: ["array", "object"], items: { type: "number" }, properties: { "0": { type: "number" } } };
  const step = shapeOf(same, "input.0");
  assert.equal(step.problem, null);
  assert.equal(step.shape.t === "schema" ? step.shape.schema["type"] : null, "number");
  assert.equal(validateWorkflow(doc(same, { type: "number" }, { $ref: "input.0" })).ok, true);
  const mismatch = problems(doc(same, { type: "string" }, { $ref: "input.0" }));
  assert.ok(mismatch.some((p) => p.startsWith("error schema_mismatch $.result") && p.includes("is number, but expected string")), JSON.stringify(mismatch));
});

test("(R15D-workflow-02) an object reading that is impossible leaves the array reading, with no error", () => {
  const closed: JsonSchema = { type: ["array", "object"], items: { type: "number" }, properties: { name: { type: "string" } }, additionalProperties: false };
  const step = shapeOf(closed, "input.0");
  assert.equal(step.problem, null);
  assert.equal(step.shape.t === "schema" ? step.shape.schema["type"] : null, "number");
  assert.deepEqual(problems(doc(closed, { type: "number" }, { $ref: "input.0" })), []);
  assert.ok(problems(doc(closed, { type: "string" }, { $ref: "input.0" })).some((p) => p.includes("is number, but expected string")));
  // An object reading through a declared `additionalProperties` schema that differs from `items` is unknown.
  const open: JsonSchema = { type: ["array", "object"], items: { type: "number" }, additionalProperties: { type: "string" } };
  assert.deepEqual(shapeOf(open, "input.0"), { shape: { t: "unknown" }, problem: null });
  // An object reading that is only undeclared (no warning of its own once the array reading succeeds) is unknown too.
  assert.deepEqual(shapeOf({ type: ["array", "object"], items: { type: "number" } }, "input.0"), { shape: { t: "unknown" }, problem: null });
});

test("(R15D-workflow-02) a non-numeric segment into the same union has only the object reading", () => {
  const named: JsonSchema = { ...UNION, properties: { "0": { type: "string" }, name: { type: "boolean" } } };
  const step = shapeOf(named, "input.name");
  assert.equal(step.problem, null);
  assert.equal(step.shape.t === "schema" ? step.shape.schema["type"] : null, "boolean");
  const found = problems(doc(named, { type: "string" }, { $ref: "input.name" }));
  assert.ok(found.some((p) => p.includes("is boolean, but expected string")), JSON.stringify(found));
  assert.ok(!found.some((p) => p.includes("is an array") || p.includes("not an index")), JSON.stringify(found));
  // Undeclared on an open object: the object reading's warning, never the array's error.
  const undeclared = shapeOf(UNION, "input.other");
  assert.equal(undeclared.problem?.severity, "warning", JSON.stringify(undeclared));
  // A schema that only describes properties accepts arrays too: a numeric segment has both readings.
  assert.deepEqual(shapeOf({ properties: { "0": { type: "string" } } }, "input.0"), { shape: { t: "unknown" }, problem: null });
  assert.equal(validateWorkflow(doc({ properties: { "0": { type: "string" } } }, { type: "number" }, { $ref: "input.0" })).ok, true);
  // When every reading is an error, the error is reported.
  const closed: JsonSchema = { type: ["array", "object"], items: { type: "number" }, properties: {}, additionalProperties: false };
  assert.equal(shapeOf(closed, "input.other").problem?.severity, "error");
  assert.equal(shapeOf({ type: ["array", "string"], items: { type: "number" } }, "input.other").problem?.severity, "error");
});

interface Case { schema: JsonSchema; refs: string[]; inputs: Json[] }

const CASES: Case[] = [
  { schema: UNION, refs: ["input.0", "input.1"], inputs: [{ "0": "valid" }, [1, 2.5]] },
  { schema: { type: ["object", "array"], items: { type: "string" }, additionalProperties: { type: "integer" } }, refs: ["input.0", "input.k"], inputs: [{ "0": 3, k: 4 }, ["a", "b"]] },
  { schema: { type: "array", items: { type: "boolean" } }, refs: ["input.0"], inputs: [[true], [false, true]] },
  { schema: { type: "object", properties: { "0": { type: "string" } } }, refs: ["input.0"], inputs: [{ "0": "x" }, { "0": "" }] },
  { schema: { type: ["array", "null"], items: { type: "integer" } }, refs: ["input.0"], inputs: [[7], null] },
  { schema: { type: ["object", "string"], properties: { a: { type: "number" } } }, refs: ["input.a"], inputs: ["text", { a: 1.5 }] },
  { schema: { type: "object", required: ["x"], properties: { x: UNION } }, refs: ["input.x.0"], inputs: [{ x: { "0": "s" } }, { x: [9] }] },
  { schema: { type: ["array", "object"], items: { type: "number" }, properties: { "0": { type: "number" } } }, refs: ["input.0"], inputs: [{ "0": 1 }, [2]] },
  { schema: { type: ["array", "object"], items: { type: "number" }, minItems: 1, properties: { "0": { type: "string" } } }, refs: ["input.0"], inputs: [[0], {}] },
  { schema: { properties: { "0": { type: "string" }, a: { type: "integer" } } }, refs: ["input.0", "input.a"], inputs: [[1], { "0": "x", a: 2 }] },
];

test("(R15D-workflow-02) agreement as a property: every value a reference resolves to at run time fits its static shape", () => {
  for (const { schema, refs, inputs } of CASES) {
    const placeholder = generatePlaceholder(schema);
    assert.equal(placeholder.satisfied, true, `the placeholder of ${JSON.stringify(schema)} validates`);
    for (const input of [placeholder.value, ...inputs]) {
      assert.deepEqual(validateSchema(schema, input), [], `${JSON.stringify(input)} is valid for ${JSON.stringify(schema)}`);
      for (const path of refs) {
        const step = shapeOf(schema, path);
        let value: Json;
        try {
          value = resolveRef(path, scope(input));
        } catch {
          continue;
        }
        assert.notEqual(step.problem?.severity, "error", `${path} resolves (${JSON.stringify(value)}) in ${JSON.stringify(input)}, so it is no static error`);
        if (step.shape.t !== "schema") continue;
        assert.deepEqual(validateSubschema(step.shape.root, step.shape.schema, value, { definitions: step.shape.defs }), [],
          `${path} = ${JSON.stringify(value)} in ${JSON.stringify(input)} fits ${JSON.stringify(step.shape.schema)}`);
      }
    }
  }
});

test("(R15D-workflow-02) the placeholder of a schema with several types validates", () => {
  for (const schema of [UNION, { type: ["object", "array"], minItems: 2, items: { type: "string" } }, { type: ["string", "integer"], minimum: 3 },
    { type: ["null", "object"], required: ["a"], properties: { a: { type: "boolean" } } }] as JsonSchema[]) {
    assert.equal(generatePlaceholder(schema).satisfied, true, JSON.stringify(schema));
  }
});
