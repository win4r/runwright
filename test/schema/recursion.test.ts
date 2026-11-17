/**
 * The schema validator does bounded work (R09D-models-01): reference cycles that consume no input are rejected
 * by checkSchema and stopped by the validator, and one validation does at most MAX_SCHEMA_EVALUATIONS
 * evaluations. Placeholder generation and pattern sampling return on the same schemas.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePlaceholder } from "../../src/schema/placeholder.ts";
import { samplePattern } from "../../src/schema/pattern-sample.ts";
import {
  MAX_SCHEMA_EVALUATIONS, checkSchema, validateSchema, validateSubschema, type JsonSchema, type SchemaProblem,
} from "../../src/schema/validate.ts";

const CYCLE_MESSAGE = "reference cycle without progress";
const LIMIT_PROBLEM: SchemaProblem = {
  path: "$",
  keyword: "limit",
  message: "validation stopped: the schema needed more than 100000 evaluations",
};

const selfCycle: JsonSchema = { $defs: { A: { anyOf: [{ $ref: "#/$defs/A" }, { $ref: "#/$defs/A" }] } }, $ref: "#/$defs/A" };
const twoDefinitionCycle: JsonSchema = {
  $defs: { A: { anyOf: [{ $ref: "#/$defs/B" }, { $ref: "#/$defs/B" }] }, B: { oneOf: [{ $ref: "#/$defs/A" }, { $ref: "#/$defs/A" }] } },
  $ref: "#/$defs/A",
};
const oneOfCycle: JsonSchema = { $defs: { O: { oneOf: [{ type: "string" }, { $ref: "#/$defs/O" }] } }, $ref: "#/$defs/O" };
const treeSchema: JsonSchema = {
  $defs: {
    T: {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string" }, kids: { type: "array", items: { $ref: "#/$defs/T" } } },
    },
  },
  $ref: "#/$defs/T",
};

/** anyOf of two members, each an anyOf of two, `depth` levels deep; every leaf fails for a number. */
function exponential(depth: number): JsonSchema {
  let node: JsonSchema = { type: "string" };
  for (let i = 0; i < depth; i++) node = { anyOf: [node, { anyOf: [node, { type: "boolean" }] }] };
  return node;
}

/** A oneOf of `width` alternatives, nested `depth` deep (every alternative holds the next level). */
function wideOneOf(width: number, depth: number): JsonSchema {
  let node: JsonSchema = { type: "string", pattern: "^(a|b)(c|d)+$" };
  for (let i = 0; i < depth; i++) {
    const members: JsonSchema[] = [];
    for (let j = 0; j < width; j++) members.push({ ...node, minLength: j });
    node = { oneOf: members };
  }
  return node;
}

function elapsed<T>(run: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = run();
  return { value, ms: performance.now() - started };
}

test("checkSchema reports a self-referencing anyOf cycle at the closing $ref", () => {
  const problems = checkSchema(selfCycle);
  assert.deepEqual(problems, [{
    path: "$.$defs.A.anyOf[0].$ref",
    keyword: "$ref",
    message: `${CYCLE_MESSAGE}: #/$defs/A -> #/$defs/A`,
  }]);
});

test("validateSchema returns on the self cycle, invalid with the cycle problem", () => {
  for (const value of [1, "x", {}, []]) {
    const { value: problems, ms } = elapsed(() => validateSchema(selfCycle, value));
    assert.ok(ms < 1000, `took ${ms} ms`);
    assert.ok(problems.length > 0);
    assert.ok(problems.some((p) => p.keyword === "$ref" && p.message === CYCLE_MESSAGE && p.path === "$"), JSON.stringify(problems));
  }
});

test("a cycle through two definitions (anyOf then oneOf) is rejected and stopped", () => {
  assert.deepEqual(checkSchema(twoDefinitionCycle), [{
    path: "$.$defs.B.oneOf[0].$ref",
    keyword: "$ref",
    message: `${CYCLE_MESSAGE}: #/$defs/A -> #/$defs/B -> #/$defs/A`,
  }]);
  const { value: problems, ms } = elapsed(() => validateSchema(twoDefinitionCycle, { a: 1 }));
  assert.ok(ms < 1000, `took ${ms} ms`);
  assert.ok(problems.some((p) => p.keyword === "$ref" && p.message === CYCLE_MESSAGE), JSON.stringify(problems));
});

test("a cycle through oneOf only is rejected, and the validator reports it", () => {
  assert.deepEqual(checkSchema(oneOfCycle), [{
    path: "$.$defs.O.oneOf[1].$ref",
    keyword: "$ref",
    message: `${CYCLE_MESSAGE}: #/$defs/O -> #/$defs/O`,
  }]);
  const problems = validateSchema(oneOfCycle, 5);
  assert.ok(problems.some((p) => p.keyword === "$ref" && p.message === CYCLE_MESSAGE), JSON.stringify(problems));
});

test("a cycle in options.definitions is stopped by the validator even without checkSchema", () => {
  const definitions: Record<string, JsonSchema> = { Loop: { anyOf: [{ $ref: "#/schemas/Loop" }, { type: "null" }] } };
  const problems = validateSchema({ $ref: "#/schemas/Loop" }, 3, { definitions });
  assert.ok(problems.some((p) => p.keyword === "$ref" && p.message === CYCLE_MESSAGE), JSON.stringify(problems));
  assert.deepEqual(validateSchema({ $ref: "#/schemas/Loop" }, null, { definitions }).filter((p) => p.keyword !== "$ref"), []);
});

test("an exponential (non-cyclic) schema stops at the evaluation budget and is invalid", () => {
  const schema = exponential(30);
  assert.deepEqual(checkSchema(schema), []);
  const { value: problems, ms } = elapsed(() => validateSchema(schema, 7));
  assert.ok(ms < 2000, `took ${ms} ms`);
  assert.equal(MAX_SCHEMA_EVALUATIONS, 100000);
  assert.deepEqual(problems.filter((p) => p.keyword === "limit"), [LIMIT_PROBLEM]);
  const sub = validateSubschema({}, schema, 7, { maxProblems: 1 });
  assert.deepEqual(sub.filter((p) => p.keyword === "limit"), [LIMIT_PROBLEM]);
});

test("a recursive tree schema stays valid and checks a tree 40 levels deep", () => {
  assert.deepEqual(checkSchema(treeSchema), []);
  const build = (depth: number, leafName: unknown): unknown => {
    let node: unknown = { name: leafName };
    for (let i = 0; i < depth; i++) node = { name: `n${i}`, kids: [{ name: "side" }, node] };
    return node;
  };
  assert.deepEqual(validateSchema(treeSchema, build(40, "leaf")), []);
  const problems = validateSchema(treeSchema, build(40, 42));
  assert.equal(problems.length, 1, JSON.stringify(problems));
  assert.equal(problems[0]?.keyword, "type");
  assert.equal(problems[0]?.path, `$${".kids[1]".repeat(40)}.name`);
});

test("two references to one definition, nested deep, are not a cycle", () => {
  const defs: Record<string, JsonSchema> = { D0: { type: "string" } };
  for (let i = 1; i <= 30; i++) defs[`D${i}`] = { anyOf: [{ $ref: `#/$defs/D${i - 1}` }, { $ref: `#/$defs/D${i - 1}` }] };
  const schema: JsonSchema = { $defs: defs, $ref: "#/$defs/D30" };
  const { value: problems, ms } = elapsed(() => checkSchema(schema));
  assert.deepEqual(problems, []);
  assert.ok(ms < 1000, `took ${ms} ms`);
  assert.deepEqual(validateSchema(schema, "ok"), []);
  assert.deepEqual(validateSchema(schema, 1).filter((p) => p.keyword === "limit"), [LIMIT_PROBLEM]);
});

test("checkSchema walks a chain of 20000 references without recursing per hop", () => {
  const defs: Record<string, JsonSchema> = { D20000: { type: "string" } };
  for (let i = 0; i < 20000; i++) defs[`D${i}`] = { $ref: `#/$defs/D${i + 1}` };
  assert.deepEqual(checkSchema({ $defs: defs, $ref: "#/$defs/D0" }), []);
  defs["D20000"] = { anyOf: [{ $ref: "#/$defs/D0" }] };
  const problems = checkSchema({ $defs: defs, $ref: "#/$defs/D0" });
  assert.equal(problems.length, 1);
  assert.equal(problems[0]?.keyword, "$ref");
  assert.match(problems[0]?.message ?? "", /^reference cycle without progress: #\/\$defs\/D0 -> #\/\$defs\/D1 -> /);
});

test("anyOf stops at the first matching branch", () => {
  const schema: JsonSchema = { anyOf: [{ type: "integer" }, { $ref: "#/$defs/Missing" }, exponential(30)] };
  const { value: problems, ms } = elapsed(() => validateSchema(schema, 3));
  assert.deepEqual(problems, []);
  assert.ok(ms < 1000, `took ${ms} ms`);
});

test("oneOf reports two matches without evaluating a third", () => {
  const schema: JsonSchema = { oneOf: [{ type: "integer" }, { type: "number" }, exponential(30)] };
  const { value: problems, ms } = elapsed(() => validateSchema(schema, 3));
  assert.ok(ms < 1000, `took ${ms} ms`);
  assert.deepEqual(problems, [{ path: "$", keyword: "oneOf", message: "must match exactly one of 3 schemas (oneOf), matched more than one" }]);
});

test("placeholder generation returns on cyclic, mutually recursive and wide nested schemas", () => {
  const schemas: [string, JsonSchema][] = [
    ["self cycle", selfCycle],
    ["two-definition cycle", twoDefinitionCycle],
    ["oneOf cycle", oneOfCycle],
    ["mutually recursive anyOf / oneOf", {
      $defs: {
        P: { anyOf: [{ $ref: "#/$defs/Q" }, { oneOf: [{ $ref: "#/$defs/Q" }, { $ref: "#/$defs/P" }] }] },
        Q: { oneOf: [{ $ref: "#/$defs/P" }, { anyOf: [{ $ref: "#/$defs/P" }, { $ref: "#/$defs/Q" }] }] },
      },
      $ref: "#/$defs/P",
    }],
    ["exponential anyOf", exponential(30)],
    ["oneOf of 12 nested 12 deep", wideOneOf(12, 12)],
    ["tree", treeSchema],
  ];
  for (const [name, schema] of schemas) {
    const { value: result, ms } = elapsed(() => generatePlaceholder(schema));
    assert.ok(ms < 3000, `took ${ms} ms for ${name}`);
    assert.equal(result.satisfied, validateSchema(schema, result.value).length === 0);
  }
});

test("pattern sampling returns on deeply nested and wide alternations", () => {
  const nested = `^${"(?:a|b|".repeat(12)}c${")+".repeat(12)}$`;
  const wide = `^(?:${Array.from({ length: 12 }, (_, i) => `x${i}(?:y|z)*`).join("|")}){12}$`;
  for (const pattern of [nested, wide, "^(a|b)(c|d)+$"]) {
    const { value: sample, ms } = elapsed(() => samplePattern(pattern, { min: 30, max: 200 }));
    assert.ok(ms < 1000, `took ${ms} ms for ${pattern}`);
    if (sample !== null) assert.ok(new RegExp(pattern, "u").test(sample));
  }
});
