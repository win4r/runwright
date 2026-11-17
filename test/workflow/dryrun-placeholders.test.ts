import { test } from "node:test";
import assert from "node:assert/strict";
import type { Json } from "../../src/core/json.ts";
import type { JsonSchema } from "../../src/schema/validate.ts";
import { dryRunWorkflow, PLACEHOLDER_DEPENDENT, type DryRunOptions } from "../../src/workflow/dryrun.ts";
import { checkDraft } from "../../src/learning/promotion.ts";
import { validateWorkflow } from "../../src/workflow/validate.ts";
import type { DryRunReport, Expr, WorkflowDocument, WorkflowNode, WorkflowProblem } from "../../src/workflow/types.ts";

const CODE: JsonSchema = { type: "string", pattern: "^[A-Z]{2}$", minLength: 2, maxLength: 2 };
const LOOKAHEAD = "^(?=[A-Z]{2}$)[A-Z]+$";
const CALL_KINDS = new Set(["tool", "model", "decision", "agent", "person", "workflow"]);

function wf(root: WorkflowNode, result: Expr, schemas: { [name: string]: JsonSchema }, extra?: Partial<WorkflowDocument>): WorkflowDocument {
  return {
    format: "runwright.workflow/v1", name: "probe", input: "In", output: "Out",
    schemas: { In: { type: "object" }, Out: { type: "object" }, ...schemas }, root, result, ...extra,
  };
}

/** Asserts the document is valid, dry-runs it and checks the report is a pure description (calls only). */
function dry(document: WorkflowDocument, options?: DryRunOptions): DryRunReport {
  const validation = validateWorkflow(document, options?.resolveWorkflow === undefined ? {} : { resolveWorkflow: options.resolveWorkflow });
  assert.equal(validation.ok, true, `the document is valid: ${JSON.stringify(validation.problems)}`);
  const report = dryRunWorkflow(document, options);
  assert.ok(!(report instanceof Promise));
  for (const call of report.wouldCall) assert.ok(CALL_KINDS.has(call.type), JSON.stringify(call));
  assert.ok(report.steps.length > 0, "the walk started");
  return report;
}

const errors = (r: DryRunReport): WorkflowProblem[] => r.problems.filter((p) => p.severity === "error");
const dependent = (r: DryRunReport): WorkflowProblem[] => r.problems.filter((p) => p.code === PLACEHOLDER_DEPENDENT);
const show = (r: DryRunReport): string => JSON.stringify({ problems: r.problems, steps: r.steps.map((s) => [s.nodeId, s.note]) });

function assertWarningAt(r: DryRunReport, path: string, message?: RegExp): WorkflowProblem {
  const found = dependent(r).find((p) => p.path === path && (message === undefined || message.test(p.message)));
  assert.ok(found !== undefined, `a ${PLACEHOLDER_DEPENDENT} warning at ${path}: ${show(r)}`);
  assert.equal(found.severity, "warning");
  return found;
}

function assertOkNoError(r: DryRunReport): void {
  assert.equal(r.ok, true, show(r));
  assert.deepEqual(errors(r), [], show(r));
}

/** The validator proves the mismatch (Rule P): the dry run reports it with the validator's path and walks nothing. */
function assertStatic(document: WorkflowDocument, path: string, message: RegExp): void {
  const validation = validateWorkflow(document);
  assert.ok(validation.problems.some((p) => p.path === path && p.code === "schema_mismatch" && p.severity === "error" && message.test(p.message)),
    `a static schema_mismatch at ${path}: ${JSON.stringify(validation.problems)}`);
  const report = dryRunWorkflow(document);
  assert.equal(report.ok, false);
  assert.deepEqual(report.steps, []);
  assert.ok(report.problems.some((p) => p.path === path && p.code === "schema_mismatch" && p.severity === "error"), show(report));
}

function assertCertain(r: DryRunReport, path: string, code = "schema_mismatch"): void {
  assert.equal(r.ok, false, show(r));
  assert.ok(errors(r).some((p) => p.path === path && p.code === code), `an error ${code} at ${path}: ${show(r)}`);
}

function reviewer(code: JsonSchema = CODE): WorkflowDocument {
  const out: JsonSchema = { type: "object", required: ["code"], properties: { code } };
  return wf({ id: "m", kind: "model", prompt: "Give a country code", output: "Out" }, { $ref: "steps.m" }, { Out: out });
}

const model = (id: string, output = "M", prompt = "p"): WorkflowNode => ({ id, kind: "model", prompt, output });
const tool = (id: string, args: { [name: string]: Expr } = {}): WorkflowNode => ({ id, kind: "tool", tool: "t", args });
const seq = (steps: WorkflowNode[]): WorkflowNode => ({ id: "main", kind: "sequence", steps });
const fail = (id: string): WorkflowNode => ({ id, kind: "fail", message: `stopped at ${id}` });
const obj = (properties: { [name: string]: JsonSchema }, required: string[] = []): JsonSchema => ({ type: "object", required, properties });

test("the reviewer's probe: a pattern-constrained output built from a model step is ok", () => {
  const r = dry(reviewer());
  assertOkNoError(r);
  const output = r.output as { code: string };
  assert.match(output.code, /^[A-Z]{2}$/);
  assert.deepEqual(dependent(r), []);
});

test("a pattern no placeholder can be generated for is a warning; an examples entry makes it checked", () => {
  const r = dry(reviewer({ type: "string", pattern: LOOKAHEAD }));
  assertOkNoError(r);
  assert.ok(r.problems.length >= 1);
  assert.ok(r.problems.every((p) => p.code === PLACEHOLDER_DEPENDENT && p.severity === "warning"), show(r));
  assertWarningAt(r, "$.root", /^no placeholder that satisfies schema "Out" could be generated; values that depend on it are not checked$/);
  assertWarningAt(r, "output.code", /^not checked against a real value: /);
  const withExample = dry(reviewer({ type: "string", pattern: LOOKAHEAD, examples: ["AB"] }));
  assertOkNoError(withExample);
  assert.deepEqual(withExample.problems, []);
  assert.deepEqual(withExample.output, { code: "AB" });
});

test("row (a): a model schema looser than an enum output is a warning; from a given input it is an error", () => {
  const schemas = { M: obj({ code: { type: "string" } }, ["code"]), Out: obj({ code: { type: "string", enum: ["a", "b"] } }) };
  const r = dry(wf(model("m"), { code: { $ref: "steps.m.code" } }, schemas));
  assertOkNoError(r);
  assertWarningAt(r, "output.code", /^not checked against a real value: must be one of "a", "b"$/);
  const given = dry(wf(tool("t"), { code: { $ref: "input.code" } }, { ...schemas, In: obj({ code: { type: "string" } }) }), { input: { code: "zz" } });
  assertCertain(given, "output.code");
});

test("row (b): a template into a length-constrained output is a warning; with a given input it is an error", () => {
  const document = wf(tool("t"), { url: "https://{{input.id}}" }, {
    In: obj({ id: { type: "string" } }, ["id"]), Out: obj({ url: { type: "string", minLength: 12 } }),
  });
  const r = dry(document);
  assertOkNoError(r);
  assertWarningAt(r, "output.url", /must be at least 12 characters/);
  assertCertain(dry(document, { input: { id: "x" } }), "output.url");
});

test("row (c): a call input with a pattern is satisfied; a look-ahead pattern is a warning and the call is still entered", () => {
  const make = (pattern: string): WorkflowDocument => {
    const input = obj({ code: { type: "string", pattern } }, ["code"]);
    const sub = wf({ id: "inner", kind: "wait", question: "code {{input.code}}?" }, {}, { In: input });
    return wf({ id: "c", kind: "call", workflow: "sub", input: { code: { $ref: "input.code" } } }, {}, { In: input }, { workflows: { sub: { ...sub, name: "sub" } } });
  };
  const r = dry(make("^[A-Z]{2}$"));
  assertOkNoError(r);
  assert.deepEqual(r.problems, []);
  assert.ok(r.steps.some((s) => s.nodeId === "inner" && s.scope === "c>/"), show(r));
  const look = dry(make(LOOKAHEAD));
  assertOkNoError(look);
  assertWarningAt(look, "$.root.input.code", /^not checked against a real value: must match pattern/);
  assertWarningAt(look, "input", /no placeholder that satisfies schema "In"/);
  assert.ok(look.steps.some((s) => s.nodeId === "inner"), show(look));
});

test("rows (d) and (e): references into placeholder values read as null with a warning", () => {
  const d = dry(wf(seq([tool("t"), tool("u", { n: { $ref: "steps.t.data.count" }, s: "n={{steps.t.data.count}}" })]),
    { n: { $ref: "steps.t.data.count" } }, { Out: obj({ n: { type: "integer" } }, ["n"]) }));
  assertOkNoError(d);
  assertWarningAt(d, "$.root.steps[1].args", /^reference "steps\.t\.data\.count" cannot be resolved in a placeholder value; it reads as null here$/);
  assertWarningAt(d, "$.result", /reads as null here/);
  assert.deepEqual(d.wouldCall[1]?.detail, { args: { n: null, s: "n=null" } });
  assert.equal(dependent(d).find((p) => p.path === "$.root.steps[1].args")?.nodeId, "u");
  assertWarningAt(d, "output.n", /^not checked against a real value: expected integer, got null$/);

  const M = obj({ a: { type: "string" }, note: { type: "string" } }, ["a"]);
  const e = dry(wf(seq([model("m"), model("later", "M", "Note: {{steps.m.note}}")]), {}, { M }));
  assertOkNoError(e);
  assertWarningAt(e, "$.root.steps[1].prompt", /reference "steps\.m\.note" cannot be resolved in a placeholder value/);
  assert.equal(e.wouldCall[1]?.detail["prompt"], "Note: null");
});

test("unresolvable references outside a made-up value stay errors", () => {
  const given = dryRunWorkflow(wf(tool("t", { v: { $ref: "input.missing" } }), {}, {}), { input: {} });
  assert.equal(given.ok, false);
  assert.ok(errors(given).some((p) => p.code === "reference_unresolved" && p.path === "$.root"), show(given));
  const notRun = dryRunWorkflow(wf(seq([tool("t", { v: { $ref: "steps.nowhere" } })]), {}, {}));
  assert.equal(notRun.ok, false);
});

test("row (f): a branch on a model's answer takes the first reachable branch that can succeed", () => {
  const schemas = { M: obj({ kind: { type: "string" } }, ["kind"]) };
  const branch = (cases: { when: Json; run: WorkflowNode }[], fallback: WorkflowNode): WorkflowNode =>
    ({ id: "route", kind: "branch", on: { $ref: "steps.m.kind" }, cases, default: fallback });
  const r = dry(wf(seq([model("m"), branch([{ when: "bug", run: tool("file_bug") }], fail("stop"))]), {}, schemas));
  assertOkNoError(r);
  assert.deepEqual(r.steps.map((s) => s.nodeId), ["main", "m", "route", "file_bug"]);
  assert.equal(r.steps[2]?.note, 'case 0 ("", placeholder)');

  const decided = dry(wf(seq([
    { id: "kind", kind: "decide", question: "q", decision: { type: "pick_one", options: ["bug", "idea", "other"] } },
    { id: "route", kind: "branch", on: { $ref: "steps.kind.value" }, cases: [{ when: "bug", run: tool("file_bug") }, { when: "idea", run: tool("keep") }], default: fail("stop") },
  ]), {}, {}), { decisions: { kind: { value: "other", confidence: 1 } } });
  assert.equal(decided.ok, false);
  assert.equal(decided.steps.at(-1)?.note, "would fail: stopped at stop");
  assert.deepEqual(dependent(decided), []);

  // Every reachable branch fails: every run fails, so the walk takes the placeholder's branch and the failure is certain.
  const allFail = dry(wf(seq([model("m"), branch([{ when: "bug", run: fail("f1") }], fail("f2"))]), {}, schemas));
  assert.equal(allFail.ok, false, show(allFail));
  assert.equal(allFail.output, null);
  assert.equal(allFail.steps.at(-1)?.nodeId, "f2");
  assert.equal(allFail.steps.at(-1)?.note, "would fail: stopped at f2");
  assert.equal(allFail.steps[2]?.note, 'default ("", placeholder)');
  assert.deepEqual(dependent(allFail), [], show(allFail));
});

test("row (g): a loop whose until reads a model's answer is assumed to end after one iteration", () => {
  const document = wf({ id: "lp", kind: "loop", maxIterations: 3, onLimit: "fail", until: { truthy: { $ref: "steps.m.done" } }, run: model("m") },
    { $ref: "steps.lp" }, { M: obj({ done: { type: "boolean" } }, ["done"]) });
  const r = dry(document);
  assertOkNoError(r);
  assert.equal(r.wouldCall.length, 1);
  assert.equal(r.steps[0]?.note, "until depends on placeholder values; assumed to hold after iteration 1");
  assert.deepEqual(r.output, { iterations: 1, completed: true, last: { done: false } });
});

test("row (h): minLength and minItems on values read from tools, people, agents and models are warnings", () => {
  const out = obj({ n: { type: "string", minLength: 1 }, r: { type: "array", minItems: 1 } });
  const schemas = { Out: out, M: obj({ list: { type: "array", items: { type: "string" } } }, ["list"]) };
  const sources: [WorkflowNode, string][] = [
    [tool("t"), "steps.t.content"],
    [{ id: "w", kind: "wait", question: "q" }, "steps.w.answer"],
    [{ id: "a", kind: "agent", message: "go", maxTurns: 2 }, "steps.a.text"],
  ];
  for (const [node, ref] of sources) {
    const r = dry(wf(seq([node, model("m")]), { n: { $ref: ref }, r: { $ref: "steps.m.list" } }, schemas));
    assertOkNoError(r);
    assertWarningAt(r, "output.n", /must be at least 1 characters/);
    assertWarningAt(r, "output.r", /must have at least 1 items/);
  }
});

test("map over made-up lists: null is empty, long lists are cut, fail in the body is assumed", () => {
  const body = tool("put", { v: { $ref: "vars.it" } });
  const map = (over: Expr, run: WorkflowNode = body, maxItems = 5): WorkflowNode => ({ id: "each", kind: "map", over, as: "it", concurrency: 1, maxItems, run });
  const data = dry(wf(seq([tool("t"), map({ $ref: "steps.t.data.items" })]), {}, {}));
  assertOkNoError(data);
  assert.equal(data.wouldCall.filter((c) => c.nodeId === "put").length, 1);
  assert.equal(data.steps.find((s) => s.nodeId === "each")?.note, "over is an empty placeholder list; the body runs once with a placeholder item");

  // A list that always has at least 5 items never fits maxItems 2: the validator proves it before the walk.
  const fixedLong = { M: obj({ list: { type: "array", minItems: 5, items: { type: "string" } } }, ["list"]) };
  assertStatic(wf(seq([model("m"), map({ $ref: "steps.m.list" }, body, 2)]), {}, fixedLong),
    "$.root.steps[1].over", /^"over" is longer than "maxItems": has at least 5 items, but must have at most 2$/);
  // The list schema does not fix a length, so "over" may fit maxItems 2; its example makes the placeholder long.
  const schemas = { M: obj({ list: { type: "array", items: { type: "string" }, examples: [["a", "b", "c", "d", "e"]] } }, ["list"]) };
  const cut = dry(wf(seq([model("m"), map({ $ref: "steps.m.list" }, body, 2)]), {}, schemas));
  assertOkNoError(cut);
  assert.equal(cut.wouldCall.filter((c) => c.nodeId === "put").length, 2);
  assert.equal(cut.steps.find((s) => s.nodeId === "each")?.note, "placeholder list cut to maxItems 2");

  const assumed = dry(wf(seq([model("m"), map({ $ref: "steps.m.list" }, fail("boom"))]), {}, schemas));
  assertOkNoError(assumed);
  assert.equal(assumed.output, null);
  assertWarningAt(assumed, "$.root.steps[1].run", /^a run that takes this path fails here/);
  const literal = dry(wf(seq([map(["a"], fail("boom"))]), {}, {}));
  assert.equal(literal.ok, false);
  assert.equal(literal.steps.at(-1)?.note, "would fail: stopped at boom");
});

test("assumed paths: nodes inside a branch taken on a placeholder are made up; after the branch they are not", () => {
  const pick: WorkflowNode = { id: "dd", kind: "decide", question: "q", decision: { type: "pick_one", options: ["p", "q"] } };
  const route = (run: WorkflowNode): WorkflowNode => ({ id: "route", kind: "branch", on: { $ref: "steps.m.kind" }, cases: [{ when: "x", run }] });
  const schemas = { M: obj({ kind: { type: "string" } }, ["kind"]), Out: obj({ v: { enum: ["a", "p"] } }) };
  const options = { decisions: { dd: { value: "q", confidence: 1 } } };
  // A default never rescues a reference whose shape cannot fit: the options "p" and "q" never fit ["a", "b"].
  assertStatic(wf(seq([model("m"), route(pick)]), { v: { $ref: "steps.dd.value", default: "a" } }, { ...schemas, Out: obj({ v: { enum: ["a", "b"] } }) }),
    "$.result.v", /can only be "p", "q", none of which fits/);
  const r = dry(wf(seq([model("m"), route(pick)]), { v: { $ref: "steps.dd.value", default: "a" } }, schemas), options);
  assertOkNoError(r);
  assertWarningAt(r, "output.v", /must be one of "a", "p"/);

  const inCase = seq([model("m"), route({ id: "inside", kind: "sequence", steps: [pick, { id: "c", kind: "call", workflow: "sub", input: { v: { $ref: "steps.dd.value" } } }] })]);
  // The options "p" and "q" never fit the enum ["a", "b"]: the validator proves it wherever the call sits.
  const enumSub = { ...wf(tool("inner"), {}, { In: obj({ v: { enum: ["a", "b"] } }, ["v"]) }), name: "sub" };
  assertStatic(wf(inCase, {}, schemas, { workflows: { sub: enumSub } }), "$.root.steps[1].cases[0].run.steps[1].input.v", /can only be "p", "q", none of which fits/);
  // A union one of the options fits ("p") is left to the run: with the decision "q", on an assumed path its problem
  // depends on the placeholder, off it the problem is certain.
  const neverIn = obj({ v: { anyOf: [{ enum: ["a"] }, { enum: ["b"] }] } }, ["v"]);
  assertStatic(wf(inCase, {}, schemas, { workflows: { sub: { ...wf(tool("inner"), {}, { In: neverIn }), name: "sub" } } }),
    "$.root.steps[1].cases[0].run.steps[1].input.v", /never matches any of the 2 schemas \(anyOf\)/);
  const subIn = obj({ v: { anyOf: [{ enum: ["a", "p"] }, { enum: ["b"] }] } }, ["v"]);
  const sub = { ...wf(tool("inner"), {}, { In: subIn }), name: "sub" };
  const call = dry(wf(inCase, {}, schemas, { workflows: { sub } }), options);
  assertOkNoError(call);
  assertWarningAt(call, "$.root.steps[1].cases[0].run.steps[1].input.v", /must match at least one of 2 schemas/);
  const outside = dry(wf(seq([pick, { id: "c", kind: "call", workflow: "sub", input: { v: { $ref: "steps.dd.value" } } }]), {}, schemas, { workflows: { sub } }), options);
  assertCertain(outside, "$.root.steps[1].input.v");

  const after = dry(wf(seq([model("m"), route(tool("x")), fail("end")]), {}, schemas));
  assert.equal(after.ok, false);
  assert.equal(after.steps.at(-1)?.note, "would fail: stopped at end");
  assert.deepEqual(dependent(after), []);
});

test("certain mismatches through made-up values are errors, proved before the walk", () => {
  assertStatic(wf(seq([{ id: "w", kind: "wait", question: "q" }]), { n: { $ref: "steps.w.answer" } }, { Out: obj({ n: { type: "integer" } }) }),
    "$.result.n", /is string, but expected integer/);
  assertStatic(wf(seq([tool("t")]), { $ref: "steps.t" }, { Out: obj({ urgent: { type: "boolean" } }, ["urgent"]) }),
    "$.result.urgent", /never has the required property "urgent"/);
  assertStatic(wf(seq([tool("t")]), { b: "is {{input.id}}" }, { In: obj({ id: { type: "string" } }, ["id"]), Out: obj({ b: { type: "boolean" } }) }),
    "$.result.b", /is string, but expected boolean/);
  assertStatic(wf(seq([tool("t")]), { n: { $ref: "input.n" } }, { In: obj({ n: { type: "string" } }, ["n"]), Out: obj({ n: { type: "integer" } }) }),
    "$.result.n", /is string, but expected integer/);
});

test("a made-up null is never a certain type mismatch", () => {
  const optional = wf(seq([tool("t")]), { topic: { $ref: "input.topic" } }, { In: obj({ topic: { type: "string" } }), Out: obj({ topic: { type: "string" } }) });
  const r = dry(optional);
  assertOkNoError(r);
  assertWarningAt(r, "output.topic", /^not checked against a real value: expected string, got null$/);
  const given = dryRunWorkflow(optional, { input: {} });
  assert.equal(given.ok, false);
  assert.ok(errors(given).some((p) => p.path === "$.result" && p.code === "reference_unresolved"), show(given));

  const viaModelDoc = (required: string[], out: JsonSchema): WorkflowDocument =>
    wf(seq([model("m")]), { note: { $ref: "steps.m.note" } }, { M: obj({ a: { type: "string" }, note: { type: "string" } }, required), Out: obj({ note: out }) });
  const viaModel = (required: string[], out: JsonSchema): DryRunReport => dry(viaModelDoc(required, out));
  const optionalNote = viaModel(["a"], { type: "string" });
  assertOkNoError(optionalNote);
  assertWarningAt(optionalNote, "$.result", /reference "steps\.m\.note" cannot be resolved in a placeholder value; it reads as null here/);
  assertWarningAt(optionalNote, "output.note", /^not checked against a real value: expected string, got null$/);
  const requiredNote = viaModel(["a", "note"], { type: "string" });
  assertOkNoError(requiredNote);
  assert.deepEqual(requiredNote.problems, []);
  assertStatic(viaModelDoc(["a", "note"], { type: "integer" }), "$.result.note", /is string, but expected integer/);

  const callWithDoc = (callerIn: JsonSchema, topic: JsonSchema): WorkflowDocument => {
    const sub = { ...wf(tool("inner"), {}, { In: obj({ topic }, ["topic"]) }), name: "sub" };
    return wf({ id: "c", kind: "call", workflow: "sub", input: { topic: { $ref: "input.topic" } } }, {}, { In: callerIn }, { workflows: { sub } });
  };
  const callWith = (callerIn: JsonSchema, topic: JsonSchema): DryRunReport => dry(callWithDoc(callerIn, topic));
  const callNull = callWith(obj({ topic: { type: "string" } }), { type: "string" });
  assertOkNoError(callNull);
  assertWarningAt(callNull, "$.root.input.topic", /expected string, got null/);
  assert.ok(callNull.steps.some((s) => s.nodeId === "inner"));
  assertStatic(callWithDoc(obj({ topic: { type: "string" } }, ["topic"]), { type: "integer" }), "$.root.input.topic", /is string, but expected integer/);

  const unsatisfiable = dry(wf(seq([model("m")]), { v: { $ref: "steps.m.v" } }, {
    M: obj({ v: { type: "string", const: 5 } }, ["v"]), Out: obj({ v: { type: "string" } }),
  }));
  assertOkNoError(unsatisfiable);
  assertWarningAt(unsatisfiable, "$.root.steps[0]", /no placeholder that satisfies schema "M" could be generated/);
});

test("decide: a made-up fallback value that does not fit is a warning; a literal one is rejected by the validator", () => {
  const decide = (value: Expr): WorkflowNode => ({ id: "dd", kind: "decide", question: "q", decision: { type: "pick_one", options: ["p", "q"] },
    lowConfidence: { below: 0.5, run: { id: "ag", kind: "agent", message: "decide", maxTurns: 2, output: "Ag" }, value } });
  const schemas = { Ag: obj({ flag: { type: "string" } }, ["flag"]), Out: obj({ v: { type: "string" } }) };
  const r = dry(wf(seq([decide({ $ref: "fallback.data.flag" })]), { v: { $ref: "steps.dd.value" } }, schemas), { decisions: { dd: { value: "q", confidence: 0.1 } } });
  assertOkNoError(r);
  assertWarningAt(r, "$.root.steps[0].lowConfidence.value", /^the fallback value depends on a placeholder and was not checked$/);
  assert.deepEqual(r.output, { v: "q" });
  const literal = validateWorkflow(wf(seq([decide("nope")]), {}, schemas));
  assert.equal(literal.ok, false);
  assert.ok(literal.problems.some((p) => p.severity === "error" && p.path.startsWith("$.root.steps[0].lowConfidence.value")), JSON.stringify(literal.problems));
});

test("a warning repeated in every iteration of a literal map is reported once", () => {
  const r = dry(wf(seq([{ id: "each", kind: "map", over: ["a", "b", "c"], as: "it", concurrency: 1, maxItems: 5, run: model("m", "Odd") }]), {},
    { Odd: obj({ code: { type: "string", pattern: LOOKAHEAD } }, ["code"]) }));
  assertOkNoError(r);
  assert.equal(r.wouldCall.length, 3);
  assert.equal(dependent(r).length, 1, show(r));
  assertWarningAt(r, "$.root.steps[0].run", /no placeholder that satisfies schema "Odd"/);
});

// Rule D: a dry-run branch on a made-up value considers only the outcomes a real value of the declared schema of `on`
// can select, and prefers one that can succeed.

const wait = (id: string): WorkflowNode => ({ id, kind: "wait", question: "q" });
const onInput = (cases: { when: Json; run: WorkflowNode }[], fallback?: WorkflowNode): WorkflowNode =>
  ({ id: "route", kind: "branch", on: { $ref: "input" }, cases, ...(fallback === undefined ? {} : { default: fallback }) });
const onModel = (cases: { when: Json; run: WorkflowNode }[], fallback?: WorkflowNode): WorkflowNode =>
  seq([model("m"), { id: "route", kind: "branch", on: { $ref: "steps.m.k" }, cases, ...(fallback === undefined ? {} : { default: fallback }) }]);
const keyed = (k: JsonSchema): { [name: string]: JsonSchema } => ({ M: obj({ k }, ["k"]) });
const routeNote = (r: DryRunReport): string | null => r.steps.find((s) => s.nodeId === "route")?.note ?? null;
const walked = (r: DryRunReport): string[] => r.steps.map((s) => s.nodeId);
const CATALOGUE = [{ name: "t", description: "a test tool", parameters: { type: "object" }, retrySafe: true }];

function assertCertainFail(r: DryRunReport, nodeId: string): void {
  assert.equal(r.ok, false, show(r));
  assert.equal(r.steps.at(-1)?.nodeId, nodeId, show(r));
  assert.equal(r.steps.at(-1)?.note, `would fail: stopped at ${nodeId}`);
  assert.deepEqual(dependent(r), [], show(r));
}

test("rule D: the reviewer's document (const true, case true fails, default waits) is not ok, and checkDraft rejects it", () => {
  const document = wf(onInput([{ when: true, run: fail("f") }], wait("w")), {}, { In: { type: "boolean", const: true } });
  const r = dry(document);
  assertCertainFail(r, "f");
  assert.equal(routeNote(r), "case 0 (true, placeholder), unreachable branches skipped");
  const draft = checkDraft({ document: document as unknown as Json }, { name: "probe", tools: CATALOGUE, resolveWorkflow: () => null });
  assert.equal(draft.ok, false);
  assert.ok(!draft.ok && draft.problems.some((p) => /would fail: stopped at f/.test(p)), JSON.stringify(draft));

  // The fail wrapped in a sequence: one reachable outcome, so the path is certain and the nested fail too.
  const wrapped = dry(wf(onInput([{ when: true, run: { id: "inner", kind: "sequence", steps: [tool("t"), fail("f")] } }], wait("w")), {},
    { In: { type: "boolean", const: true } }));
  assertCertainFail(wrapped, "f");
  assert.deepEqual(walked(wrapped), ["route", "inner", "t", "f"]);
});

test("rule D: boolean cases that all fail are not ok; one that can succeed is taken on an assumed path", () => {
  const failing = (id: string): WorkflowNode => ({ id: `${id}_seq`, kind: "sequence", steps: [tool(`${id}_t`), fail(id)] });
  const both = dry(wf(onModel([{ when: true, run: failing("a") }, { when: false, run: failing("b") }]), {}, keyed({ type: "boolean" })));
  assertCertainFail(both, "b");
  // A default is unreachable when the cases cover every value; the validator already says so for a plain boolean,
  // and the walk agrees for an enum it does not analyse (its "x" can never be a boolean).
  const withDefault = dryRunWorkflow(wf(onModel([{ when: true, run: failing("a") }, { when: false, run: failing("b") }], wait("w")), {},
    keyed({ type: "boolean" })));
  assert.equal(withDefault.ok, false);
  const enumDefault = dry(wf(onModel([{ when: true, run: failing("a") }, { when: false, run: failing("b") }], wait("w")), {},
    keyed({ type: "boolean", enum: [true, false, "x"] })));
  assertCertainFail(enumDefault, "a");
  assert.equal(routeNote(enumDefault), "case 0 (true, placeholder), unreachable branches skipped");

  const one = dry(wf(onModel([{ when: true, run: wait("yes") }, { when: false, run: failing("b") }]), {}, keyed({ type: "boolean" })));
  assertOkNoError(one);
  assert.equal(routeNote(one), "case 0 (false, placeholder)");
  assert.deepEqual(walked(one), ["main", "m", "route", "yes"]);
  // A sequence that ends in a fail cannot succeed either.
  const late = dry(wf(onModel([{ when: true, run: { id: "inner", kind: "sequence", steps: [wait("yes"), fail("late")] } },
    { when: false, run: failing("b") }]), {}, keyed({ type: "boolean" })));
  assert.equal(late.ok, false, show(late));
  // A literal `until` has its run-time value: `truthy: false` never holds, so a loop with onLimit "fail" around it
  // cannot succeed, and with both cases unable to succeed the failure is certain.
  const neverEnds: WorkflowNode = { id: "inner", kind: "loop", maxIterations: 2, onLimit: "fail", until: { truthy: false }, run: wait("yes") };
  assertCertainFail(dry(wf(onModel([{ when: true, run: neverEnds }, { when: false, run: failing("b") }]), {}, keyed({ type: "boolean" }))), "b");
  // The path taken is assumed: a fail met on it is a warning, and the run is ok. (`eq` of a loop index and a literal is
  // not decided statically, so the loop can succeed by its structure; walked, it reaches its bound.)
  const bounded: WorkflowNode = { id: "inner", kind: "loop", maxIterations: 2, onLimit: "fail", until: { eq: [{ $ref: "loop.inner.index" }, 5] },
    run: wait("yes") };
  const assumed = dry(wf(onModel([{ when: true, run: bounded }, { when: false, run: failing("b") }]), {}, keyed({ type: "boolean" })));
  assertOkNoError(assumed);
  assert.equal(routeNote(assumed), "case 0 (false, placeholder)");
  assert.equal(assumed.steps.find((s) => s.nodeId === "inner")?.note, "would fail: reached maxIterations 2");
  assertWarningAt(assumed, "$.root.steps[1].cases[0].run", /^a run that takes this path fails here/);
});

test("rule D: enums, unreachable cases and defaults", () => {
  const ab = keyed({ type: "string", enum: ["a", "b"] });
  const takeB = dry(wf(onModel([{ when: "a", run: fail("fa") }, { when: "b", run: tool("tb") }]), {}, ab));
  assertOkNoError(takeB);
  assert.equal(routeNote(takeB), 'case 1 ("a", placeholder)');
  assert.deepEqual(walked(takeB), ["main", "m", "route", "tb"]);
  assert.ok(takeB.wouldCall.some((c) => c.nodeId === "tb"));

  // Cases a and b fail and cover the enum: the default is unreachable (the validator rejects it for a plain enum;
  // with a maxLength that rules out "cc" only the walk sees it).
  assert.equal(dryRunWorkflow(wf(onModel([{ when: "a", run: fail("fa") }, { when: "b", run: fail("fb") }], tool("td")), {}, ab)).ok, false);
  const narrowed = keyed({ enum: ["a", "b", "cc"], maxLength: 1 });
  const covered = dry(wf(onModel([{ when: "a", run: fail("fa") }, { when: "b", run: fail("fb") }], tool("td")), {}, narrowed));
  assertCertainFail(covered, "fa");
  assert.equal(routeNote(covered), 'case 0 ("a", placeholder), unreachable branches skipped');

  const reachableDefault = dry(wf(onModel([{ when: "a", run: fail("fa") }], tool("td")), {}, ab));
  assertOkNoError(reachableDefault);
  assert.equal(routeNote(reachableDefault), 'default ("a", placeholder)');

  // A `when` the schema of `on` never allows (the validator cannot see through the union) is skipped although it does not fail.
  const union = keyed({ anyOf: [{ type: "string" }] });
  const invalidWhen = dry(wf(onModel([{ when: 5, run: tool("never") }, { when: "x", run: fail("fx") }], fail("fd")), {}, union));
  assertCertainFail(invalidWhen, "fd");
  assert.equal(routeNote(invalidWhen), 'default ("", placeholder), unreachable branches skipped');
});

test("rule D: an unknown shape keeps every branch reachable; R05-02 stays fixed", () => {
  // `on` is a template: not statically known, so the placeholder's fail is passed over for the other case.
  const template = dry(wf(seq([model("m"), { id: "route", kind: "branch", on: "{{steps.m.k}}", cases: [{ when: "", run: fail("f") }, { when: "z", run: tool("tz") }] }]),
    {}, keyed({ type: "string" })));
  assertOkNoError(template);
  assert.equal(routeNote(template), 'case 1 ("", placeholder)');
  // `on` is a map variable over a tool's data: unknown shape, and every case fails: a default can still be reached.
  const vars = dry(wf(seq([tool("src"), { id: "each", kind: "map", over: { $ref: "steps.src.data" }, as: "it", concurrency: 1, maxItems: 2,
    run: { id: "route", kind: "branch", on: { $ref: "vars.it" }, cases: [{ when: null, run: fail("f") }], default: tool("td") } }]), {}, {}));
  assertOkNoError(vars);
  assert.equal(routeNote(vars), "default (null, placeholder)");

  // R05-02: a pattern-constrained answer whose placeholder lands on a fail case; another reachable case exists.
  const r0502 = dry(wf(onModel([{ when: "AA", run: fail("f") }, { when: "BB", run: tool("tb") }]), {}, keyed(CODE)));
  assertOkNoError(r0502);
  assert.equal(routeNote(r0502), 'case 1 ("AA", placeholder)');
});

test("rule D: the rule applies again at a branch nested in the chosen case", () => {
  const inner: WorkflowNode = { id: "inner", kind: "branch", on: { $ref: "steps.m.k" }, cases: [{ when: true, run: fail("fi") }] };
  const document = wf(seq([model("m"),
    { id: "route", kind: "branch", on: { $ref: "steps.m.n" }, cases: [{ when: "go", run: { id: "s", kind: "sequence", steps: [tool("t"), inner] } }], default: tool("td") }]),
  {}, { M: obj({ k: { type: "boolean", const: true }, n: { type: "string" } }, ["k", "n"]) });
  // The inner branch has one reachable outcome, a fail: the case cannot succeed and the outer default is taken.
  const r = dry(document);
  assertOkNoError(r);
  assert.equal(routeNote(r), 'default ("", placeholder)');
  assert.deepEqual(walked(r), ["main", "m", "route", "td"]);
  // With no other way out the outer branch takes the case for certain and the inner branch fails for certain.
  const forced = dry(wf(seq([model("m"),
    { id: "route", kind: "branch", on: { $ref: "steps.m.k" }, cases: [{ when: true, run: { id: "s", kind: "sequence", steps: [tool("t"), inner] } }] }]),
  {}, { M: obj({ k: { type: "boolean", const: true } }, ["k"]) }));
  assertCertainFail(forced, "fi");
  assert.equal(forced.steps.find((s) => s.nodeId === "inner")?.note, "case 0 (true, placeholder)");
});

test("rule D: a call whose saved target always fails is not chosen; the walk into a saved document uses its schemas", () => {
  const sub = (name: string, root: WorkflowNode, schemas: { [name: string]: JsonSchema } = {}): WorkflowDocument => ({ ...wf(root, {}, schemas), name });
  const saved = new Map<string, WorkflowDocument>([
    ["doomed", sub("doomed", fail("df"))],
    ["picky", sub("picky", seq([model("m"), { id: "route", kind: "branch", on: { $ref: "steps.m.k" },
      cases: [{ when: true, run: fail("pf") }], default: wait("pw") }]), keyed({ type: "boolean", const: true }))],
  ]);
  const resolveWorkflow = (name: string): WorkflowDocument | null => saved.get(name) ?? null;
  const call = (id: string, workflow: string): WorkflowNode => ({ id, kind: "call", workflow, input: {} });
  const avoided = dry(wf(onModel([{ when: "", run: call("c", "doomed") }, { when: "x", run: tool("tx") }]), {}, keyed({ type: "string" })), { resolveWorkflow });
  assertOkNoError(avoided);
  assert.equal(routeNote(avoided), 'case 1 ("", placeholder)');
  assert.deepEqual(avoided.wouldCall.map((c) => c.nodeId), ["m", "tx"]);
  // Inside the saved document its own schema makes the default unreachable: the call fails for certain.
  const nested = dry(wf(call("c", "picky"), {}, {}), { resolveWorkflow });
  assertCertainFail(nested, "pf");
  assert.equal(nested.steps.find((s) => s.nodeId === "route")?.note, "case 0 (true, placeholder), unreachable branches skipped");
});

test("rule D: a loop whose until cannot hold for the declared schemas ends at its bound", () => {
  const loop = (done: JsonSchema, onLimit: "fail" | "continue"): WorkflowDocument =>
    wf({ id: "lp", kind: "loop", maxIterations: 3, onLimit, until: { eq: [{ $ref: "steps.m.done" }, true] }, run: model("m") },
      { $ref: "steps.lp" }, { M: obj({ done }, ["done"]) });
  const never = dry(loop({ const: false }, "fail"));
  assert.equal(never.ok, false, show(never));
  assert.equal(never.steps[0]?.note, "would fail: reached maxIterations 3");
  assert.equal(never.wouldCall.length, 1, "the walk stops after the first iteration");
  assert.deepEqual(dependent(never), []);
  const may = dry(loop({ type: "boolean" }, "fail"));
  assertOkNoError(may);
  assert.equal(may.steps[0]?.note, "until depends on placeholder values; assumed to hold after iteration 1");
  const stops = dry(loop({ const: false }, "continue"));
  assertOkNoError(stops);
  assert.equal(stops.steps[0]?.note, "until cannot hold for the declared schemas; stopped at maxIterations 3");
  assert.deepEqual(stops.output, { iterations: 3, completed: false, last: { done: false } });
  // The other operators: ne over a one-value domain, truthy over a falsy-only domain, and/or, and the conservative rest.
  const until = (condition: Json, done: JsonSchema): DryRunReport => dry(wf({ id: "lp", kind: "loop", maxIterations: 2, onLimit: "fail",
    until: condition, run: model("m") } as unknown as WorkflowNode,
  {}, { M: obj({ done }, ["done"]) }));
  const ref = { $ref: "steps.m.done" };
  assert.equal(until({ ne: [ref, false] }, { const: false }).ok, false);
  assert.equal(until({ ne: [ref, false] }, { type: "boolean" }).ok, true);
  assert.equal(until({ truthy: ref }, { enum: [0, "", null] }).ok, false);
  assert.equal(until({ truthy: ref }, { enum: [0, 1] }).ok, true);
  assert.equal(until({ and: [{ eq: [ref, 1] }, { eq: [ref, 2] }] }, { enum: [1, 2] }).ok, true);
  assert.equal(until({ and: [{ eq: [ref, 1] }, { eq: [ref, 3] }] }, { enum: [1, 2] }).ok, false);
  assert.equal(until({ or: [{ eq: [ref, 3] }, { eq: [ref, 4] }] }, { enum: [1, 2] }).ok, false);
  assert.equal(until({ or: [{ eq: [ref, 3] }, { eq: [ref, 2] }] }, { enum: [1, 2] }).ok, true);
  assert.equal(until({ not: { eq: [ref, 1] } }, { const: 1 }).ok, false, "not swaps the verdict of its part: eq over a one-value domain always holds");
  assert.equal(until({ not: { eq: [ref, 1] } }, { enum: [1, 2] }).ok, true, "not of an unknown part is unknown");
  assert.equal(until({ eq: [{ $ref: "steps.m.done", default: 7 }, 7] }, { const: 1 }).ok, true, "a reference with a default may be the default");
  assert.equal(until({ eq: [null, ref] }, { const: 1 }).ok, false, "a null literal on the left is a literal");
  assert.equal(until({ eq: [null, ref] }, { type: "null" }).ok, true);
});

test("a map over an empty made-up list places an item by the reference-root rule of the list's named schema", () => {
  const list: JsonSchema = { type: "object", $defs: { X: { type: "string", minLength: 3 } }, required: ["items"],
    properties: { items: { type: "array", items: { $ref: "#/$defs/X" } } } };
  const r = dry(wf(seq([model("m", "L"), { id: "each", kind: "map", over: { $ref: "steps.m.items" }, as: "it", concurrency: 1, maxItems: 2,
    run: tool("put", { v: { $ref: "vars.it" } }) }]), {}, { L: list }));
  assertOkNoError(r);
  assert.deepEqual(dependent(r), [], show(r));
  assert.deepEqual(r.wouldCall.filter((c) => c.nodeId === "put").map((c) => c.detail), [{ args: { v: "xxx" } }]);
});
