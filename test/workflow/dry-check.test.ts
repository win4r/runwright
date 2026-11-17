import { test } from "node:test";
import assert from "node:assert/strict";
import type { Json } from "../../src/core/json.ts";
import { pathIndex, pathProperty, validateSchema, type JsonSchema } from "../../src/schema/validate.ts";
import {
  classifyProblem, conditionIsLiteral, conditionVerdict, emptySources, isConditionFabricated, isExprFabricated, parseProblemPath,
  type ConditionVerdict, type FabricatedSources, type ShapeOf,
} from "../../src/workflow/dry-check.ts";
import { evalCondition, refForm, type RefScope } from "../../src/workflow/refs.ts";
import type { Condition, Expr, WorkflowDocument, WorkflowNode } from "../../src/workflow/types.ts";
import { UNKNOWN_SHAPE, plainShape } from "../../src/workflow/walk.ts";

function doc(root: WorkflowNode, schemas: { [name: string]: JsonSchema } = {}): WorkflowDocument {
  return {
    format: "runwright.workflow/v1", name: "probe", input: "In", output: "Out",
    schemas: { In: { type: "object" }, Out: { type: "object" }, ...schemas }, root, result: {},
  };
}

function sources(patch: Partial<{ input: boolean; steps: string[]; vars: string[]; loops: string[]; fallback: boolean }>): FabricatedSources {
  const out = emptySources(patch.input ?? false);
  for (const id of patch.steps ?? []) out.steps.add(id);
  for (const name of patch.vars ?? []) out.vars.add(name);
  for (const id of patch.loops ?? []) out.loops.add(id);
  out.fallback = patch.fallback ?? false;
  return out;
}

/** Validates `value` against `schema`, takes the one problem with `keyword` and classifies it. */
function classify(document: WorkflowDocument, schema: JsonSchema, value: Json, expression: Expr, fabricated: FabricatedSources, keyword: string): string {
  const problems = validateSchema(schema, value).filter((p) => p.keyword === keyword);
  assert.equal(problems.length, 1, `one ${keyword} problem in ${JSON.stringify(validateSchema(schema, value))}`);
  return classifyProblem(problems[0] as NonNullable<(typeof problems)[0]>, value, expression, fabricated, document);
}

const WAIT: WorkflowNode = { id: "w", kind: "wait", question: "q" };
const TOOL: WorkflowNode = { id: "t", kind: "tool", tool: "t", args: {} };
const MODEL: WorkflowNode = { id: "m", kind: "model", prompt: "p", output: "M" };

test("parseProblemPath inverts pathProperty and pathIndex", () => {
  const cases: (string | number)[][] = [
    [],
    ["a", "b_c", "$d"],
    ["with space", "quo\"te", "dot.ted", "back\\slash", "]["],
    ["0", "12", 0, 12],
    ["a", 3, "b c", 0, "x"],
    ["", "ünï", "a-b"],
  ];
  for (const segments of cases) {
    let path = "$";
    for (const segment of segments) path = typeof segment === "number" ? pathIndex(path, segment) : pathProperty(path, segment);
    assert.deepEqual(parseProblemPath(path), segments, path);
  }
  assert.deepEqual(parseProblemPath('$["0"][0]'), ["0", 0]);
  assert.throws(() => parseProblemPath("output.a"));
  assert.throws(() => parseProblemPath('$["open'));
});

test("which references, expressions and conditions are fabricated", () => {
  const s = sources({ input: true, steps: ["m"], vars: ["item"], loops: ["lp"], fallback: true });
  assert.equal(isExprFabricated({ $ref: "input.a" }, s), true);
  assert.equal(isExprFabricated({ $ref: "steps.m.x", default: 1 }, s), true);
  assert.equal(isExprFabricated({ $ref: "steps.other" }, s), false);
  assert.equal(isExprFabricated("v={{vars.item}}", s), true);
  assert.equal(isExprFabricated("v={{vars.item_index}}", s), false);
  assert.equal(isExprFabricated({ $ref: "loop.lp.last.done" }, s), true);
  assert.equal(isExprFabricated({ $ref: "loop.lp.index" }, s), false);
  assert.equal(isExprFabricated({ $ref: "fallback.data" }, s), true);
  assert.equal(isExprFabricated({ $ref: "run.id" }, s), false);
  assert.equal(isExprFabricated({ $literal: { $ref: "input.a" } }, s), false);
  assert.equal(isConditionFabricated({ exists: "steps.m.note" }, s), true);
  assert.equal(isConditionFabricated({ exists: "steps.other" }, s), false);
  assert.equal(isConditionFabricated({ and: [{ truthy: true }, { not: { eq: [{ $ref: "input.a" }, 1] } }] }, s), true);
  assert.equal(isConditionFabricated({ gte: [{ $ref: "loop.lp.index" }, 1] }, s), false);
});

test("classifyProblem: values that are not made up, and $literal, are certain", () => {
  const d = doc(WAIT);
  const enumOut: JsonSchema = { type: "object", properties: { code: { enum: ["a", "b"] } } };
  assert.equal(classify(d, enumOut, { code: "zz" }, { code: { $ref: "input.code" } }, sources({ input: false }), "enum"), "certain");
  assert.equal(classify(d, enumOut, { code: "zz" }, { code: { $literal: "zz" } }, sources({ input: true, steps: ["w"] }), "enum"), "certain");
  assert.equal(classify(d, enumOut, { code: "zz" }, { code: "zz" }, sources({ input: true }), "enum"), "certain");
});

test("classifyProblem: a made-up template is certain for type only", () => {
  const d = doc(WAIT);
  const expression = { url: "https://{{input.id}}" };
  const s = sources({ input: true });
  assert.equal(classify(d, { properties: { url: { type: "boolean" } } }, { url: "https://" }, expression, s, "type"), "certain");
  assert.equal(classify(d, { properties: { url: { type: "string", minLength: 12 } } }, { url: "https://" }, expression, s, "minLength"), "dependent");
  assert.equal(classify(d, { properties: { url: { type: "string", pattern: "^https://[a-z]+$" } } }, { url: "https://" }, expression, s, "pattern"), "dependent");
});

test("classifyProblem: a made-up plain object is certain for type, required and additionalProperties", () => {
  const d = doc(WAIT);
  const expression = { a: { $ref: "input.x" } };
  const s = sources({ input: true });
  assert.equal(classify(d, { type: "object", required: ["b"] }, { a: 1 }, expression, s, "required"), "certain");
  assert.equal(classify(d, { type: "object", additionalProperties: false, properties: { b: {} } }, { a: 1 }, expression, s, "additionalProperties"), "certain");
  assert.equal(classify(d, { type: "array" }, { a: 1 }, expression, s, "type"), "certain");
  assert.equal(classify(d, { anyOf: [{ required: ["b"] }, { required: ["c"] }] }, { a: 1 }, expression, s, "anyOf"), "dependent");
  assert.equal(classify(d, { type: "object" }, [1], [{ $ref: "input.x" }], s, "type"), "certain");
});

test("classifyProblem: a made-up $ref is certain for type when the shape pins it and the value has it", () => {
  const out = (schema: JsonSchema): JsonSchema => ({ type: "object", properties: { n: schema } });
  const wait = doc(WAIT);
  const s = sources({ steps: ["w", "m", "t", "mp"] });
  assert.equal(classify(wait, out({ type: "integer" }), { n: "" }, { n: { $ref: "steps.w.answer" } }, s, "type"), "certain");
  assert.equal(classify(wait, out({ type: "integer" }), { n: null }, { n: { $ref: "steps.w.answer" } }, s, "type"), "dependent");

  const model = doc(MODEL, { M: { type: "object", properties: { s: { type: "string" }, list: { type: "array" } } } });
  assert.equal(classify(model, out({ type: "integer" }), { n: "" }, { n: { $ref: "steps.m.s" } }, s, "type"), "certain");
  assert.equal(classify(model, out({ type: "integer" }), { n: null }, { n: { $ref: "steps.m.s" } }, s, "type"), "dependent");
  assert.equal(classify(model, { type: "object", properties: { s: { type: "integer" } } }, { s: "" }, { $ref: "steps.m" }, s, "type"), "certain");

  const map = doc({ id: "main", kind: "sequence", steps: [{ id: "mp", kind: "map", over: [1], as: "x", concurrency: 1, maxItems: 3, run: { ...WAIT } }] });
  assert.equal(classify(map, out({ type: "string" }), { n: [] }, { n: { $ref: "steps.mp" } }, s, "type"), "certain");

  const tool = doc(TOOL);
  assert.equal(classify(tool, { type: "string" }, { ok: true, content: "", data: null }, { $ref: "steps.t" }, s, "type"), "certain");
});

test("classifyProblem: a made-up $ref whose shape does not pin one type is dependent", () => {
  const out = (schema: JsonSchema): JsonSchema => ({ type: "object", properties: { n: schema } });
  const s = sources({ steps: ["m", "t", "c"], vars: ["item"], loops: ["lp"] });
  const model = doc(MODEL, { M: { type: "object", properties: {
    num: { type: "number" }, union: { type: ["string", "null"] }, untyped: { minLength: 1 }, any: { anyOf: [{ type: "string" }, { type: "integer" }] },
  } } });
  assert.equal(classify(model, out({ type: "string" }), { n: 0 }, { n: { $ref: "steps.m.num" } }, s, "type"), "dependent");
  assert.equal(classify(model, out({ type: "integer" }), { n: "" }, { n: { $ref: "steps.m.union" } }, s, "type"), "dependent");
  assert.equal(classify(model, out({ type: "integer" }), { n: "" }, { n: { $ref: "steps.m.untyped" } }, s, "type"), "dependent");
  assert.equal(classify(model, out({ type: "boolean" }), { n: "" }, { n: { $ref: "steps.m.any" } }, s, "type"), "dependent");
  const tool = doc(TOOL);
  assert.equal(classify(tool, out({ type: "integer" }), { n: "" }, { n: { $ref: "steps.t.data.count" } }, s, "type"), "dependent");
  assert.equal(classify(tool, out({ type: "integer" }), { n: "" }, { n: { $ref: "vars.item" } }, s, "type"), "dependent");
  assert.equal(classify(tool, out({ type: "integer" }), { n: "" }, { n: { $ref: "loop.lp.last" } }, s, "type"), "dependent");
  const call = doc({ id: "c", kind: "call", workflow: "sub", input: {} });
  assert.equal(classify(call, out({ type: "integer" }), { n: "" }, { n: { $ref: "steps.c.x" } }, s, "type"), "dependent");
  assert.equal(classify(model, out({ type: "number", minimum: 3 }), { n: 0 }, { n: { $ref: "steps.m.num" } }, s, "minimum"), "dependent");
  assert.equal(classify(tool, out({ type: "string", minLength: 1 }), { n: "" }, { n: { $ref: "steps.t.content" } }, s, "minLength"), "dependent");
  assert.equal(classify(tool, out({ type: "integer" }), { n: "" }, { n: { $ref: "steps.t.content", default: 1 } }, s, "type"), "dependent");
});

test("classifyProblem: required and additionalProperties on a made-up $ref", () => {
  const s = sources({ steps: ["w", "m"] });
  const wait = doc(WAIT);
  const urgent: JsonSchema = { type: "object", required: ["urgent"], properties: { urgent: { type: "boolean" } } };
  assert.equal(classify(wait, urgent, { answer: "" }, { $ref: "steps.w" }, s, "required"), "certain");
  assert.equal(classify(wait, { type: "object", additionalProperties: false, properties: {} }, { answer: "" }, { $ref: "steps.w" }, s, "additionalProperties"), "certain");
  const nested: JsonSchema = { type: "object", properties: { r: urgent } };
  assert.equal(classify(wait, nested, { r: { answer: "" } }, { r: { $ref: "steps.w" } }, s, "required"), "certain");
  const model = doc(MODEL, { M: { type: "object", required: ["a"], properties: { a: { type: "string" } } } });
  assert.equal(classify(model, urgent, { a: "" }, { $ref: "steps.m" }, s, "required"), "dependent");
  assert.equal(classify(model, { type: "object", additionalProperties: false, properties: {} }, { a: "" }, { $ref: "steps.m" }, s, "additionalProperties"), "dependent");
});

test("classifyProblem: a made-up written array is certain for minItems and maxItems on the array itself (R11-03)", () => {
  const d = doc(WAIT);
  const s = sources({ input: true });
  const expression = [{ $ref: "input.x" }];
  assert.equal(classify(d, { type: "array", minItems: 2 }, [1], expression, s, "minItems"), "certain");
  assert.equal(classify(d, { type: "array", maxItems: 0 }, [1], expression, s, "maxItems"), "certain");
  const nested = { list: [{ $ref: "input.x" }, { $ref: "input.y" }] };
  assert.equal(classify(d, { type: "object", properties: { list: { maxItems: 1 } } }, { list: [1, 2] }, nested, s, "maxItems"), "certain",
    "an array written inside a written object");
  assert.equal(classify(d, { type: "array", items: { type: "array", minItems: 2 } }, [[1]], [{ $ref: "input.x" }], s, "minItems"), "dependent",
    "the length of a made-up reference's value is not fixed by the document");
  assert.equal(classify(d, { type: "array", minItems: 2 }, [1], [{ $ref: "input.x", default: 1 }], s, "minItems"), "certain",
    "a default inside does not change the written length");
  assert.equal(classify(d, { type: "object", properties: { a: { minItems: 2 } } }, { a: [1] }, { a: { $ref: "input.a" } }, s, "minItems"), "dependent",
    "a made-up reference inside a written object");
  assert.equal(classify(d, { type: "array", items: { minItems: 2 } }, [[1]], [[{ $ref: "input.x" }]], s, "minItems"), "certain",
    "a nested written array");
});

// ---- conditionVerdict (rule V): a part without references has exactly its run-time value ----

const EMPTY: RefScope = { input: null, steps: {}, vars: {}, loop: {}, run: { id: "", agentId: "" } };
const noShapes: ShapeOf = () => UNKNOWN_SHAPE;

/** The shapes of `input.<key>` for the verdict tests (a reference with a default, or to anything else, is unknown). */
const INPUT_SCHEMAS: { [key: string]: JsonSchema } = {
  flag: { type: "boolean" },
  zero: { const: 0 },
  one: { const: 1 },
  pick: { enum: ["x", "y"] },
  falsy: { enum: [0, "", null, false] },
  truthy: { enum: [1, "a", true] },
  mixed: { enum: [1, "1", null] },
  nothing: { type: "null" },
  small: { type: "integer", minimum: 0, maximum: 3 },
  text: { type: "string" },
};

const inputShapes: ShapeOf = (expr) => {
  const form = expr !== null && typeof expr === "object" && !Array.isArray(expr) ? refForm(expr) : null;
  if (form?.kind !== "ref" || form.fallback !== undefined || !form.path.startsWith("input.")) return UNKNOWN_SHAPE;
  const schema = INPUT_SCHEMAS[form.path.slice("input.".length)];
  return schema === undefined ? UNKNOWN_SHAPE : plainShape(schema);
};

const verdictOf = (condition: unknown, shapeOf: ShapeOf = inputShapes): ConditionVerdict => conditionVerdict(condition as Condition, shapeOf);
const runtime = (condition: unknown, scope: RefScope = EMPTY): ConditionVerdict => (evalCondition(condition as Condition, scope) ? "always" : "never");

/** Literal operands: numbers, strings (one that looks like an unclosed template), objects with keys in two orders, arrays, null, booleans. */
const OPERANDS: Json[] = [
  1, 2, 1.5, -1, 0, "a", "b", "", "1", "{{ not closed", { a: 1, b: [2, 3] }, { b: [2, 3], a: 1 }, [1, 2], [2, 1], null, true, false,
  { $literal: { $ref: "steps.x" } }, { $literal: 2 },
];

function literalConditions(): unknown[] {
  const out: unknown[] = [];
  const pairs: [Json, Json][] = [];
  OPERANDS.forEach((a, i) => OPERANDS.forEach((b, j) => {
    if ((i * 7 + j * 3) % 4 === 0 || i === j) pairs.push([a, b]);
  }));
  for (const operator of ["eq", "ne", "gt", "gte", "lt", "lte"]) {
    for (const pair of pairs) out.push({ [operator]: pair });
  }
  for (const value of OPERANDS) out.push({ truthy: value });
  const base = out.slice(0, 40);
  for (const c of base) out.push({ not: c });
  for (let i = 0; i + 2 < base.length; i += 3) {
    out.push({ and: [base[i], base[i + 1]] }, { or: [base[i], base[i + 2]] });
    out.push({ and: [{ or: [base[i], base[i + 1]] }, { not: base[i + 2] }] }, { or: [{ and: [base[i + 1], base[i + 2]] }, { not: { not: base[i] } }] });
  }
  out.push({ and: [] }, { or: [] }, { not: { and: [] } }, { not: { or: [] } });
  return out;
}

test("conditionVerdict: every condition without references has exactly the value evalCondition gives it", () => {
  const conditions = literalConditions();
  assert.ok(conditions.length >= 60, `${conditions.length} cases`);
  const seen = new Set<ConditionVerdict>();
  for (const condition of conditions) {
    assert.equal(conditionIsLiteral(condition), true, JSON.stringify(condition));
    const expected = runtime(condition);
    seen.add(expected);
    assert.equal(verdictOf(condition, noShapes), expected, JSON.stringify(condition));
  }
  assert.deepEqual([...seen].sort(), ["always", "never"], "the table holds conditions of both values");
});

test("conditionVerdict: the round-14 optimism cases are decided", () => {
  assert.equal(verdictOf({ ne: [1, 1] }), "never");
  assert.equal(verdictOf({ truthy: false }), "never");
  assert.equal(verdictOf({ gt: [1, 2] }), "never");
  assert.equal(verdictOf({ lte: ["b", "a"] }), "never");
  assert.equal(verdictOf({ gt: [1, "0"] }), "never", "a number and a string are never ordered");
  assert.equal(verdictOf({ eq: [{ a: 1, b: 2 }, { b: 2, a: 1 }] }), "always", "canonical JSON ignores key order");
  assert.equal(verdictOf({ not: { eq: [1, 1] } }), "never");
  assert.equal(verdictOf({ not: { ne: [1, 1] } }), "always");
  assert.equal(verdictOf({ not: { truthy: { $ref: "input.text" } } }), "unknown", "not of an unknown part is unknown");
  assert.equal(verdictOf({ exists: "input.flag" }), "unknown", "exists reads the scope");
  assert.equal(verdictOf({ not: { exists: "input.flag" } }), "unknown");
  assert.equal(verdictOf({ eq: [{ $ref: 7 }, 1] }), "unknown", "a malformed operand: evaluating it fails");
  assert.equal(verdictOf({ ne: [1] }), "unknown", "a malformed condition: evaluating it fails");
  assert.equal(verdictOf({ nope: [1, 1] }), "unknown");
});

test("conditionVerdict: and / or mixing a literal part with a made-up reference, in both orders", () => {
  const madeUp = { truthy: { $ref: "steps.m.done" } };
  for (const [a, b] of [[{ ne: [1, 1] }, madeUp], [madeUp, { ne: [1, 1] }]]) {
    assert.equal(verdictOf({ and: [a, b] }), "never", JSON.stringify([a, b]));
    assert.equal(verdictOf({ or: [a, b] }), "unknown", JSON.stringify([a, b]));
  }
  for (const [a, b] of [[{ eq: [1, 1] }, madeUp], [madeUp, { eq: [1, 1] }]]) {
    assert.equal(verdictOf({ or: [a, b] }), "always", JSON.stringify([a, b]));
    assert.equal(verdictOf({ and: [a, b] }), "unknown", JSON.stringify([a, b]));
  }
  assert.equal(verdictOf({ or: [{ ne: [1, 1] }, { truthy: { $ref: "input.zero" } }] }), "never", "every part never holds");
  assert.equal(verdictOf({ and: [{ eq: [1, 1] }, { eq: [{ $ref: "input.one" }, 1] }] }), "always", "every part always holds");
});

test("conditionVerdict: finite domains and the same reference on both sides", () => {
  const zero = { $ref: "input.zero" };
  assert.equal(verdictOf({ ne: [zero, 0] }), "never", "ne against a const equal to the literal");
  assert.equal(verdictOf({ ne: [0, zero] }), "never", "the literal on the left");
  assert.equal(verdictOf({ eq: [zero, 0] }), "always");
  assert.equal(verdictOf({ eq: [zero, 1] }), "never");
  assert.equal(verdictOf({ ne: [zero, 1] }), "always");
  assert.equal(verdictOf({ truthy: zero }), "never", "truthy of {const: 0}");
  assert.equal(verdictOf({ truthy: { $ref: "input.falsy" } }), "never");
  assert.equal(verdictOf({ truthy: { $ref: "input.truthy" } }), "always");
  assert.equal(verdictOf({ truthy: { $ref: "input.flag" } }), "unknown");
  assert.equal(verdictOf({ eq: [{ $ref: "input.pick" }, "z"] }), "never", "a literal the shape rules out");
  assert.equal(verdictOf({ ne: [{ $ref: "input.pick" }, "z"] }), "always");
  assert.equal(verdictOf({ eq: [{ $ref: "input.pick" }, "x"] }), "unknown");
  assert.equal(verdictOf({ eq: [{ $ref: "input.text" }, 3] }), "never", "a number is never a string");
  assert.equal(verdictOf({ eq: [{ $ref: "input.text" }, "3"] }), "unknown");
  assert.equal(verdictOf({ eq: [{ $ref: "input.nothing" }, null] }), "always");
  assert.equal(verdictOf({ eq: [{ $ref: "input.mixed" }, 1] }), "unknown", "1 and \"1\" are different values");
  assert.equal(verdictOf({ eq: [{ $ref: "input.zero", default: 5 }, 5] }), "unknown", "a reference with a default may read the default");
  assert.equal(verdictOf({ eq: [{ $ref: "input.text" }, { $ref: "input.text" }] }), "always", "the same reference on both sides");
  assert.equal(verdictOf({ ne: [{ $ref: "steps.m" }, { $ref: "steps.m" }] }), "never");
  assert.equal(verdictOf({ eq: [{ $ref: "input.text" }, { $ref: "input.pick" }] }), "unknown");
  assert.equal(verdictOf({ eq: [{ $ref: "input.text", default: 1 }, { $ref: "input.text" }] }), "unknown", "a default on one side");
  assert.equal(verdictOf({ gt: [{ $ref: "input.small" }, 9] }), "unknown", "comparisons of a reference are not decided");
  const empty: ShapeOf = () => plainShape({ enum: [] });
  assert.equal(verdictOf({ eq: [{ $ref: "input.none" }, 1] }, empty), "never", "an empty domain: the literal is not valid for the shape");
  assert.equal(verdictOf({ truthy: { $ref: "input.none" } }, empty), "unknown", "an empty domain decides no truthiness");
});

/** A seeded generator (mulberry32), so the property test is the same in every run. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Values valid for each input schema (every value of the finite ones, a sample of the others). */
const SAMPLES: { [key: string]: Json[] } = {
  flag: [true, false], zero: [0], one: [1], pick: ["x", "y"], falsy: [0, "", null, false], truthy: [1, "a", true],
  mixed: [1, "1", null], nothing: [null], small: [0, 1, 2, 3], text: ["", "x", "1", "y"],
};

test("conditionVerdict is sound: \"never\" is false and \"always\" is true for every sampled run", () => {
  const random = prng(1515);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
  const keys = Object.keys(INPUT_SCHEMAS);
  const literals: Json[] = [0, 1, 2, "x", "y", "", "1", null, true, false, [1], { a: 1 }];
  const operand = (): Json => {
    const roll = random();
    if (roll < 0.45) return { $ref: `input.${pick(keys)}` };
    if (roll < 0.55) return { $ref: pick(["input.missing", `input.${pick(keys)}`]), default: pick(literals) };
    if (roll < 0.6) return `v{{input.${pick(keys)}}}`;
    return pick(literals);
  };
  const condition = (depth: number): Json => {
    const roll = random();
    if (depth > 0 && roll < 0.3) {
      const parts = Array.from({ length: 1 + Math.floor(random() * 3) }, () => condition(depth - 1));
      return { [pick(["and", "or"])]: parts };
    }
    if (depth > 0 && roll < 0.4) return { not: condition(depth - 1) };
    if (roll < 0.45) return { exists: pick(["input.missing", `input.${pick(keys)}`]) };
    if (roll < 0.6) return { truthy: operand() };
    const same = random() < 0.1 ? operand() : null;
    return { [pick(["eq", "ne", "eq", "ne", "gt", "lte"])]: same === null ? [operand(), operand()] : [same, same] };
  };
  const scopes: RefScope[] = Array.from({ length: 40 }, () => {
    const input: { [key: string]: Json } = {};
    for (const key of keys) input[key] = pick(SAMPLES[key] as Json[]);
    return { ...EMPTY, input };
  });
  const decided = { always: 0, never: 0, unknown: 0 };
  for (let i = 0; i < 1500; i++) {
    const c = condition(3);
    const verdict = verdictOf(c);
    decided[verdict]++;
    if (verdict === "unknown") continue;
    for (const scope of scopes) assert.equal(runtime(c, scope), verdict, `${JSON.stringify(c)} with ${JSON.stringify(scope.input)}`);
  }
  assert.ok(decided.always > 50 && decided.never > 50, JSON.stringify(decided));
});
