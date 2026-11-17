/**
 * Rule P at every destination of the validator (R11-03): a workflow `result`, a tool argument, a `call` node's
 * input, `map.over` against `maxItems`, and a decision's `lowConfidence.value`. Each certain mismatch is the
 * validator's `schema_mismatch`; the same documents with values that fit validate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { JsonSchema } from "../../src/schema/validate.ts";
import { checkDecisionValue } from "../../src/workflow/decision.ts";
import { dryRunWorkflow } from "../../src/workflow/dryrun.ts";
import type { DecisionSpec, Expr, WorkflowDocument, WorkflowNode } from "../../src/workflow/types.ts";
import { validateWorkflow, type ValidateOptions } from "../../src/workflow/validate.ts";

const wait = (id: string): WorkflowNode => ({ id, kind: "wait", question: "q" });

function document(input: JsonSchema, steps: WorkflowNode[], result: Expr = {}, extra?: Partial<WorkflowDocument>, output: JsonSchema = { type: "object" }): WorkflowDocument {
  return {
    format: "runwright.workflow/v1",
    name: "sites",
    schemas: { In: input, Out: output },
    input: "In",
    output: "Out",
    root: { id: "main", kind: "sequence", steps },
    result,
    ...extra,
  };
}

function mismatches(doc: WorkflowDocument, options?: ValidateOptions): [string, string][] {
  return validateWorkflow(doc, options).problems.filter((p) => p.code === "schema_mismatch").map((p) => [p.path, p.message]);
}

function assertValid(doc: WorkflowDocument, options?: ValidateOptions): void {
  const report = validateWorkflow(doc, options);
  assert.deepEqual(report.problems.filter((p) => p.severity === "error"), []);
  assert.equal(report.ok, true);
}

test("the finding: a number input written into an array result of at least two numbers is rejected, and the dry run calls nothing", () => {
  const finding: WorkflowDocument = {
    format: "runwright.workflow/v1",
    name: "finding",
    schemas: { In: { type: "number" }, Out: { type: "array", items: { type: "number" }, minItems: 2 } },
    input: "In",
    output: "Out",
    root: { id: "t", kind: "tool", tool: "read_file", args: { path: "a.txt" } },
    result: [{ $ref: "input" }],
  };
  const report = validateWorkflow(finding);
  assert.equal(report.ok, false);
  assert.deepEqual(report.problems.filter((p) => p.code === "schema_mismatch").map((p) => [p.path, p.message, p.severity]),
    [["$.result", `does not fit schema "Out": must have at least 2 items, got 1`, "error"]]);
  const dry = dryRunWorkflow(finding, { input: 3 });
  assert.equal(dry.ok, false);
  assert.deepEqual([dry.steps, dry.wouldCall], [[], []]);
  assert.ok(dry.problems.some((p) => p.code === "schema_mismatch" && p.path === "$.result"), JSON.stringify(dry.problems));
  assertValid({ ...finding, result: [{ $ref: "input" }, { $ref: "input" }] });
});

const TAGS_TOOL: ValidateOptions["tools"] = [
  { name: "tag", parameters: { type: "object", required: ["tags"], properties: { tags: { type: "array", minItems: 2, items: { type: "string" } } } }, retrySafe: false },
];
const STRING_INPUT: JsonSchema = { type: "object", required: ["s", "n"], properties: { s: { type: "string" }, n: { type: "number", minimum: 20 } } };

test("a tool argument: a written array shorter than the parameter's minItems", () => {
  const tagged = (tags: Expr) => document(STRING_INPUT, [{ id: "t", kind: "tool", tool: "tag", args: { tags } }]);
  assert.deepEqual(mismatches(tagged(["{{input.s}}"]), { tools: TAGS_TOOL }),
    [["$.root.steps[0].args.tags", `argument does not fit tool "tag": must have at least 2 items, got 1`]]);
  assertValid(tagged(["{{input.s}}", "x"]), { tools: TAGS_TOOL });
});

test("a call node's input: a written array shorter than the called workflow's input schema allows", () => {
  const sub = document({ type: "object", required: ["list"], properties: { list: { type: "array", minItems: 2 } } }, [wait("w")]);
  const call = (list: Expr) => document(STRING_INPUT, [{ id: "c", kind: "call", workflow: "sub", input: { list } }], {}, { workflows: { sub } });
  assert.deepEqual(mismatches(call([{ $ref: "input.n" }])),
    [["$.root.steps[0].input.list", `does not fit schema "In": must have at least 2 items, got 1`]]);
  assertValid(call([{ $ref: "input.n" }, { $ref: "input.s" }]));
});

test("map.over against maxItems: written literally, written with references, and a reference that is always longer", () => {
  const input: JsonSchema = { type: "object", required: ["n", "long", "pair"], properties: {
    n: { type: "number" }, long: { type: "array", minItems: 3 }, pair: { type: "array", minItems: 2, maxItems: 2 },
  } };
  const map = (over: Expr): WorkflowDocument => document(input, [{ id: "m", kind: "map", over, as: "item", concurrency: 1, maxItems: 2, run: wait("w") }]);
  const at = "$.root.steps[0].over";
  assert.deepEqual(mismatches(map([1, 2, 3])), [[at, `"over" is longer than "maxItems": must have at most 2 items, got 3`]]);
  assert.deepEqual(mismatches(map([{ $ref: "input.n" }, { $ref: "input.n" }, 3])), [[at, `"over" is longer than "maxItems": must have at most 2 items, got 3`]]);
  assert.deepEqual(mismatches(map({ $ref: "input.long" })), [[at, `"over" is longer than "maxItems": has at least 3 items, but must have at most 2`]]);
  assertValid(map([1, 2]));
  assertValid(map([{ $ref: "input.n" }, 3]));
  assertValid(map({ $ref: "input.pair" }));
  const badBound = document(input, [{ id: "m", kind: "map", over: [1, 2, 3], as: "item", concurrency: 1, maxItems: -1, run: wait("w") }]);
  assert.deepEqual(validateWorkflow(badBound).problems.filter((p) => p.path === "$.root.steps[0].over"), [], "an invalid bound is only the missing_bound error");
});

test("lowConfidence.value: a template that never renders an option, a number always outside the score range", () => {
  const decide = (decision: DecisionSpec, value: Expr): WorkflowDocument =>
    document(STRING_INPUT, [{ id: "d", kind: "decide", question: "q", decision, lowConfidence: { below: 0.5, run: wait("w"), value } }]);
  const pick: DecisionSpec = { type: "pick_one", options: ["a", "b"] };
  const at = "$.root.steps[0].lowConfidence.value";
  assert.deepEqual(mismatches(decide(pick, "{{input.s}}-x")),
    [[at, `the fallback value does not fit the pick_one decision: can never be one of "a", "b"`]]);
  assert.equal(checkDecisionValue(pick, "a-x"), false, "what the template renders is refused at run time");
  assert.equal(checkDecisionValue(pick, "-x"), false);
  assertValid(decide({ type: "pick_one", options: ["a", "b-x"] }, "{{input.s}}-x"));
  assert.equal(checkDecisionValue({ type: "pick_one", options: ["a", "b-x"] }, "b-x"), true);

  const score: DecisionSpec = { type: "score", min: 0, max: 10 };
  assert.deepEqual(mismatches(decide(score, { $ref: "input.n" })),
    [[at, "the fallback value does not fit the score decision: is at least 20, but must be <= 10"]]);
  assert.equal(checkDecisionValue(score, 20), false, "a value of the input's range is refused at run time");
  assertValid(decide({ type: "score", min: 0, max: 20 }, { $ref: "input.n" }));
  assert.equal(checkDecisionValue({ type: "score", min: 0, max: 20 }, 20), true);
});

/**
 * One document per expression field of every node kind (the validator / dry run / executor table of plan 2.6); the
 * execution side of the table is `exec/field-agreement.test.ts`. `build(expr, template)` places `expr` (or, in a
 * template field, `template`) in the field; `at` is where a reference in it is reported.
 */
interface FieldSite { field: string; at: string; build(expr: Expr, template: string): WorkflowDocument }

/** The inline sub-workflow the `call.input` site calls: it returns its input. */
const ECHO: WorkflowDocument = {
  format: "runwright.workflow/v1", name: "echo", schemas: { In: {}, Out: {} }, input: "In", output: "Out", root: wait("ew"), result: { $ref: "input" },
};

function siteDocument(steps: WorkflowNode[], result: Expr): WorkflowDocument {
  return {
    format: "runwright.workflow/v1", name: "sites", schemas: { In: { type: "object" }, Out: {} }, input: "In", output: "Out",
    root: { id: "main", kind: "sequence", steps }, result, workflows: { echo: ECHO },
  };
}

const site = (field: string, at: string, steps: (expr: Expr, template: string) => WorkflowNode[], result?: (expr: Expr) => Expr): FieldSite => ({
  field, at, build: (expr, template) => siteDocument(steps(expr, template), result === undefined ? {} : result(expr)),
});

const FIELD_SITES: FieldSite[] = [
  site("result", "$.result.v", () => [wait("w")], (expr) => ({ v: expr })),
  site("tool.args", "$.root.steps[0].args.v", (expr) => [{ id: "t", kind: "tool", tool: "probe", args: { label: "x", v: expr } }]),
  site("model.prompt", "$.root.steps[0].prompt", (_e, tpl) => [{ id: "m", kind: "model", prompt: tpl, output: "Out" }]),
  site("model.system", "$.root.steps[0].system", (_e, tpl) => [{ id: "m", kind: "model", prompt: "p", system: tpl, output: "Out" }]),
  site("decide.question", "$.root.steps[0].question", (_e, tpl) => [{ id: "d", kind: "decide", question: tpl, decision: { type: "yes_no" } }]),
  site("decide.lowConfidence.value", "$.root.steps[0].lowConfidence.value", (_e, tpl) => [{
    id: "d", kind: "decide", question: "q", decision: { type: "pick_one", options: ["a", "b"] },
    lowConfidence: { below: 0.5, run: wait("lw"), value: tpl },
  }]),
  site("branch.on", "$.root.steps[0].on.v", (expr) => [{ id: "b", kind: "branch", on: { v: expr }, cases: [] }]),
  site("map.over", "$.root.steps[0].over[0]", (expr) => [{ id: "e", kind: "map", over: [expr], as: "it", concurrency: 1, maxItems: 5, run: wait("mw") }]),
  site("loop.until", "$.root.steps[0].until.eq[0]", (expr) => [{ id: "l", kind: "loop", maxIterations: 2, until: { eq: [expr, 1] }, run: wait("lw") }]),
  site("call.input", "$.root.steps[0].input.v", (expr) => [{ id: "c", kind: "call", workflow: "echo", input: { v: expr } }]),
  site("agent.message", "$.root.steps[0].message", (_e, tpl) => [{ id: "a", kind: "agent", message: tpl, maxTurns: 1 }]),
  site("agent.instructions", "$.root.steps[0].instructions", (_e, tpl) => [{ id: "a", kind: "agent", message: "m", instructions: tpl, maxTurns: 1 }]),
  site("wait.question", "$.root.steps[0].question", (_e, tpl) => [{ id: "w", kind: "wait", question: tpl }]),
  site("fail.message", "$.root.steps[0].message", (_e, tpl) => [{ id: "f", kind: "fail", message: tpl }]),
];

test("every expression field: a missing reference is reported at the field's path, and a visible one validates", () => {
  for (const entry of FIELD_SITES) {
    const missing = validateWorkflow(entry.build({ $ref: "steps.missing" }, "{{steps.missing}}"));
    assert.deepEqual(missing.problems.filter((p) => p.severity === "error").map((p) => [p.path, p.code]), [[entry.at, "unknown_reference"]], entry.field);
    const visible = validateWorkflow(entry.build({ $ref: "input" }, "{{input}}"));
    assert.deepEqual(visible.problems.filter((p) => p.severity === "error"), [], entry.field);
  }
});
