/**
 * The default clause of Rule P (R10-02): a reference with a default is compared by its shape like any other
 * reference, and its default is checked only when the reference may be missing. Whole documents go through
 * validateWorkflow (and dryRunWorkflow), plus unit cases for pathAlwaysPresent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { JsonSchema } from "../../src/schema/validate.ts";
import { dryRunWorkflow } from "../../src/workflow/dryrun.ts";
import type { Expr, WorkflowDocument, WorkflowNode } from "../../src/workflow/types.ts";
import { validateWorkflow, type ValidateOptions } from "../../src/workflow/validate.ts";
import { UNKNOWN_SHAPE, namedShape, pathAlwaysPresent, plainShape, type Shape } from "../../src/workflow/walk.ts";

const wait = (id: string): WorkflowNode => ({ id, kind: "wait", question: "q" });

function document(input: JsonSchema, steps: WorkflowNode[], result: Expr, extra?: Partial<WorkflowDocument>): WorkflowDocument {
  return {
    format: "runwright.workflow/v1",
    name: "probe",
    schemas: { Input: input, Output: { type: "object" } },
    input: "Input",
    output: "Output",
    root: { id: "main", kind: "sequence", steps },
    result,
    ...extra,
  };
}

function mismatches(doc: WorkflowDocument, options?: ValidateOptions): [string, string][] {
  return validateWorkflow(doc, options).problems.filter((p) => p.code === "schema_mismatch").map((p) => [p.path, p.message]);
}

const tools: ValidateOptions["tools"] = [
  { name: "write_file", parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } }, retrySafe: false },
];
const writeFile = (id: string, path: Expr): WorkflowNode => ({ id, kind: "tool", tool: "write_file", args: { path } });

test("the reviewer's probe: a number input with a string default into a string output is rejected, and the dry run stops", () => {
  const probe: WorkflowDocument = {
    format: "runwright.workflow/v1",
    name: "probe",
    schemas: { In: { type: "number" }, Out: { type: "string" } },
    input: "In",
    output: "Out",
    root: wait("w"),
    result: { $ref: "input", default: "fallback" },
  };
  const result = validateWorkflow(probe);
  assert.equal(result.ok, false);
  const found = result.problems.filter((p) => p.code === "schema_mismatch");
  assert.deepEqual(found.map((p) => [p.path, p.message]), [["$.result", `does not fit schema "Out": is number, but expected string`]]);
  const dry = dryRunWorkflow(probe, { input: 3 });
  assert.equal(dry.ok, false);
  assert.deepEqual(dry.steps, []);
  assert.ok(dry.problems.some((p) => p.code === "schema_mismatch" && p.path === "$.result"), JSON.stringify(dry.problems));
});

test("the same bypass is closed for a tool argument and for a call node's input", () => {
  const input: JsonSchema = { type: "object", required: ["n"], properties: { n: { type: "integer" } } };
  assert.deepEqual(mismatches(document(input, [writeFile("t", { $ref: "input.n", default: "x" })], {}), { tools }),
    [["$.root.steps[0].args.path", `argument does not fit tool "write_file": is integer, but expected string`]]);
  const sub = document({ type: "object", required: ["s"], properties: { s: { type: "string" } } }, [wait("w")], {});
  const call: WorkflowNode = { id: "c", kind: "call", workflow: "sub", input: { s: { $ref: "input.n", default: "x" } } };
  assert.deepEqual(mismatches(document(input, [call], {}, { workflows: { sub } })),
    [["$.root.steps[0].input.s", `does not fit schema "Input": is integer, but expected string`]]);
});

test("an optional input property: the default is checked, and so is the property's shape", () => {
  const input = (opt: JsonSchema): JsonSchema => ({ type: "object", properties: { opt } });
  const doc = (opt: JsonSchema, fallback: Expr) => document(input(opt), [writeFile("t", { $ref: "input.opt", default: fallback })], {});
  assert.deepEqual(mismatches(doc({ type: "string" }, 5), { tools }),
    [["$.root.steps[0].args.path.default", `argument does not fit tool "write_file": expected string, got integer`]]);
  assert.deepEqual(mismatches(doc({ type: "integer" }, "x"), { tools }),
    [["$.root.steps[0].args.path", `argument does not fit tool "write_file": is integer, but expected string`]]);
  assert.deepEqual(mismatches(doc({ type: "string" }, "x"), { tools }), []);
});

test("a node that may not have run reads its default; a node that ran before never does", () => {
  const branch: WorkflowNode = { id: "br", kind: "branch", on: true, cases: [{ when: true, run: wait("inner") }] };
  const after = (fallback: Expr) => document({ type: "object" }, [branch, writeFile("t", { $ref: "steps.inner.answer", default: fallback })], {});
  assert.deepEqual(mismatches(after(5), { tools }),
    [["$.root.steps[1].args.path.default", `argument does not fit tool "write_file": expected string, got integer`]]);
  assert.deepEqual(mismatches(after("x"), { tools }), []);
  const before = (fallback: Expr) => document({ type: "object" }, [wait("w"), writeFile("t", { $ref: "steps.w.answer", default: fallback })], {});
  assert.deepEqual(mismatches(before(5), { tools }), [], "steps.w.answer always resolves, so its default is never read");
  const loop: WorkflowNode = { id: "lp", kind: "loop", maxIterations: 2, until: { truthy: true },
    run: { id: "body", kind: "sequence", steps: [wait("w")] } };
  const shapeOnly = document({ type: "object" }, [wait("w"), { id: "d", kind: "decide", question: "q", decision: { type: "yes_no" } },
    writeFile("t", { $ref: "steps.d.value", default: "x" }), loop], {});
  assert.deepEqual(mismatches(shapeOnly, { tools }),
    [["$.root.steps[2].args.path", `argument does not fit tool "write_file": is boolean, but expected string`]], "its shape is still compared");
});

test("roots that always resolve never read their default: run.id, a map variable, a loop index", () => {
  const map: WorkflowNode = { id: "m", kind: "map", over: { $ref: "input.tags" }, as: "item", concurrency: 1, maxItems: 4,
    run: { id: "each", kind: "sequence", steps: [writeFile("a", { $ref: "vars.item", default: 5 }), writeFile("b", { $ref: "vars.item_index", default: "x" })] } };
  const input: JsonSchema = { type: "object", required: ["tags"], properties: { tags: { type: "array", items: { type: "string" } } } };
  assert.deepEqual(mismatches(document(input, [map, writeFile("r", { $ref: "run.id", default: 5 })], {}), { tools }),
    [["$.root.steps[0].run.steps[1].args.path", `argument does not fit tool "write_file": is integer, but expected string`]]);
  const loop: WorkflowNode = { id: "lp", kind: "loop", maxIterations: 2, until: { truthy: true },
    run: { id: "body", kind: "sequence", steps: [writeFile("i", { $ref: "loop.lp.index", default: "x" })] } };
  assert.deepEqual(mismatches(document({ type: "object" }, [loop], {}), { tools }),
    [["$.root.steps[0].run.steps[0].args.path", `argument does not fit tool "write_file": is integer, but expected string`]]);
});

test("loop.<id>.last is null in the first iteration, so a path below it may be missing and its default is checked", () => {
  const loop = (fallback: Expr): WorkflowNode => ({ id: "lp", kind: "loop", maxIterations: 2, until: { truthy: true },
    run: { id: "body", kind: "sequence", steps: [writeFile("t", { $ref: "loop.lp.last.answer", default: fallback }), wait("w")] } });
  assert.deepEqual(mismatches(document({ type: "object" }, [loop(5)], {}), { tools }),
    [["$.root.steps[0].run.steps[0].args.path.default", `argument does not fit tool "write_file": expected string, got integer`]]);
  assert.deepEqual(mismatches(document({ type: "object" }, [loop("x")], {}), { tools }), []);
});

test("a branch on a reference with a default uses the referenced shape when the reference always resolves", () => {
  const route = (required: string[]) => document({ type: "object", required, properties: { flag: { type: "boolean" } } }, [{
    id: "b", kind: "branch", on: { $ref: "input.flag", default: true },
    cases: [{ when: true, run: wait("y") }, { when: false, run: wait("n") }, { when: "yes", run: wait("s") }],
    default: wait("d"),
  }], {});
  const always = validateWorkflow(route(["flag"])).problems;
  assert.deepEqual(always.filter((p) => p.code === "schema_mismatch").map((p) => p.path), ["$.root.steps[0].cases[2].when"]);
  assert.deepEqual(always.filter((p) => p.code === "unreachable").map((p) => p.path), ["$.root.steps[0].default"]);
  const maybe = validateWorkflow(route([])).problems;
  assert.deepEqual(maybe.filter((p) => p.code === "schema_mismatch" || p.code === "unreachable"), []);
});

test("a map over a reference with a default gives its items a shape when the reference always resolves", () => {
  const each = (required: string[]) => document({ type: "object", required, properties: { items: { type: "array", items: { type: "integer" } } } }, [{
    id: "m", kind: "map", over: { $ref: "input.items", default: [] }, as: "item", concurrency: 1, maxItems: 4,
    run: writeFile("t", { $ref: "vars.item" }),
  }], {});
  assert.deepEqual(mismatches(each(["items"]), { tools }),
    [["$.root.steps[0].run.args.path", `argument does not fit tool "write_file": is integer, but expected string`]]);
  assert.deepEqual(mismatches(each([]), { tools }), []);
});

test("pathAlwaysPresent", () => {
  const string = plainShape({ type: "string" });
  const record: Shape = { t: "record", fields: { ok: plainShape({ type: "boolean" }), data: UNKNOWN_SHAPE } };
  assert.equal(pathAlwaysPresent(record, ["ok"]), true, "a record field");
  assert.equal(pathAlwaysPresent(record, ["missing"]), false, "not a field of the record");
  assert.equal(pathAlwaysPresent(record, ["data", "x"]), false, "below an unknown shape");
  const object = plainShape({ type: "object", required: ["a"], properties: { a: { type: "object", required: ["b"], properties: { b: { type: "string" } } }, c: { type: "string" } } });
  assert.equal(pathAlwaysPresent(object, ["a", "b"]), true, "required properties all the way");
  assert.equal(pathAlwaysPresent(object, ["c"]), false, "an optional property");
  const noSchema = plainShape({ type: "object", required: ["a"] });
  assert.equal(pathAlwaysPresent(noSchema, ["a"]), true, "a required property with no declared schema");
  assert.equal(pathAlwaysPresent(noSchema, ["a", "b"]), false, "and nothing is known below it");
  assert.equal(pathAlwaysPresent(plainShape({ type: ["object", "null"], required: ["a"] }), ["a"]), false, "the value may be null");
  assert.equal(pathAlwaysPresent(plainShape({ type: "object", required: ["a"], anyOf: [{ required: ["b"] }] }), ["a"]), false, "a union");
  assert.equal(pathAlwaysPresent(plainShape({ oneOf: [{ type: "object", required: ["a"] }] }), ["a"]), false, "a union");
  const array = plainShape({ type: "array", minItems: 2, items: { type: "object", required: ["k"] } });
  assert.equal(pathAlwaysPresent(array, [1, "k"]), true, "an index below minItems");
  assert.equal(pathAlwaysPresent(array, [2]), false, "an index at minItems");
  assert.equal(pathAlwaysPresent(plainShape({ type: "array", items: {} }), [0]), false, "no minItems");
  assert.equal(pathAlwaysPresent({ t: "list", items: string }, [0]), false, "a list index");
  assert.equal(pathAlwaysPresent(UNKNOWN_SHAPE, ["a"]), false, "an unknown shape");
  const schemas = { Root: { $ref: "#/schemas/Inner" }, Inner: { type: "object", required: ["x"], properties: { x: { type: "integer" } } } };
  assert.equal(pathAlwaysPresent(namedShape(schemas, "Root"), ["x"]), true, "a $ref to a named schema");
  assert.equal(pathAlwaysPresent(namedShape(schemas, "Root"), ["y"]), false);
  assert.equal(pathAlwaysPresent(UNKNOWN_SHAPE, []), true, "an empty path");
  assert.equal(pathAlwaysPresent(string, []), true, "an empty path");
  assert.equal(pathAlwaysPresent(string, ["a"]), false, "a string has no property");
});
