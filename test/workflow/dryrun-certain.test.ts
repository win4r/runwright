import { test } from "node:test";
import assert from "node:assert/strict";
import { isJsonObject, type Json } from "../../src/core/json.ts";
import { validateSchema, type JsonSchema } from "../../src/schema/validate.ts";
import { checkDraft } from "../../src/learning/promotion.ts";
import { dryRunWorkflow, PLACEHOLDER_DEPENDENT } from "../../src/workflow/dryrun.ts";
import { validateWorkflow } from "../../src/workflow/validate.ts";
import type { Condition, DryRunReport, Expr, WorkflowDocument, WorkflowNode } from "../../src/workflow/types.ts";

const BOOL: JsonSchema = { type: "boolean" };
const arr = (items: JsonSchema, minItems: number, maxItems: number): JsonSchema => {
  const schema: JsonSchema = { type: "array", items, maxItems };
  if (minItems > 0) schema["minItems"] = minItems;
  return schema;
};
const obj = (properties: { [name: string]: JsonSchema }): JsonSchema => ({ type: "object", required: Object.keys(properties), properties });

function wf(input: JsonSchema, root: WorkflowNode, extra?: Partial<WorkflowDocument>): WorkflowDocument {
  return { format: "runwright.workflow/v1", name: "probe", input: "In", output: "Out", schemas: { In: input, Out: { type: "string" } }, root, result: "done", ...extra };
}

const fail = (id: string): WorkflowNode => ({ id, kind: "fail", message: `stopped at ${id}` });
const tool = (id: string): WorkflowNode => ({ id, kind: "tool", tool: "t", args: {} });
const map = (id: string, over: Expr, run: WorkflowNode, as = "it", maxItems = 5): WorkflowNode => ({ id, kind: "map", over, as, concurrency: 1, maxItems, run });
const branch = (id: string, on: Expr, cases: [Json, WorkflowNode][], fallback?: WorkflowNode): WorkflowNode => {
  const node: WorkflowNode = { id, kind: "branch", on, cases: cases.map(([when, run]) => ({ when, run })) };
  if (fallback !== undefined) node.default = fallback;
  return node;
};
const loop = (id: string, until: Condition, run: WorkflowNode, maxIterations: number, onLimit: "fail" | "continue" = "continue"): WorkflowNode =>
  ({ id, kind: "loop", maxIterations, onLimit, until, run });
const ref = (path: string): Expr => ({ $ref: path });

const show = (r: DryRunReport): string => JSON.stringify({ ok: r.ok, problems: r.problems, steps: r.steps.map((s) => [s.nodeId, s.note]) });
const dependent = (r: DryRunReport): string[] => r.problems.filter((p) => p.code === PLACEHOLDER_DEPENDENT).map((p) => `${p.path}: ${p.message}`);

function valid(document: WorkflowDocument): WorkflowDocument {
  const validation = validateWorkflow(document);
  assert.equal(validation.ok, true, `the document is valid: ${JSON.stringify(validation.problems)}`);
  return document;
}

/** A certain failure: not ok, no error problem (the walk reached a `fail` off an assumed path), and no assumed-path warning. */
function assertCertainFail(r: DryRunReport): void {
  assert.equal(r.ok, false, show(r));
  assert.ok(!r.truncated, show(r));
  assert.ok(!dependent(r).some((p) => p.includes("a run that takes this path fails here")), show(r));
  assert.ok(r.steps.some((s) => s.note !== null && s.note.startsWith("would fail")), show(r));
}

function assertAssumedFail(r: DryRunReport): void {
  assert.equal(r.ok, true, show(r));
  assert.ok(dependent(r).some((p) => p.includes("a run that takes this path fails here")), show(r));
}

/** Every value of a finite schema (booleans, enums, consts, arrays with maxItems, objects of such properties). */
function enumerate(schema: JsonSchema): Json[] {
  if (Object.hasOwn(schema, "const")) return [schema["const"] ?? null];
  if (Array.isArray(schema["enum"])) return schema["enum"];
  const type = schema["type"];
  if (type === "boolean") return [true, false];
  if (type === "array") {
    const items = enumerate(schema["items"] as JsonSchema);
    const min = typeof schema["minItems"] === "number" ? schema["minItems"] : 0;
    const max = schema["maxItems"] as number;
    const out: Json[] = [];
    let lists: Json[][] = [[]];
    for (let length = 0; length <= max; length++) {
      if (length >= min) out.push(...lists);
      lists = lists.flatMap((list) => items.map((item) => [...list, item]));
    }
    return out;
  }
  if (type === "object") {
    const properties = schema["properties"] as { [name: string]: JsonSchema };
    let objects: { [name: string]: Json }[] = [{}];
    for (const [name, sub] of Object.entries(properties)) {
      objects = objects.flatMap((partial) => enumerate(sub).map((value) => ({ ...partial, [name]: value })));
    }
    return objects;
  }
  throw new Error(`not a finite schema: ${JSON.stringify(schema)}`);
}

const probe = (minItems: number): WorkflowDocument => wf(arr(BOOL, minItems, 1), map("each", ref("input"), fail("boom")));

test("(R15-02) the reviewer's probe: a map over a list the schema keeps non-empty, with a failing body, fails for certain", () => {
  const document = valid(probe(1));
  assertCertainFail(dryRunWorkflow(document));
  for (const input of [[true], [false]]) assertCertainFail(dryRunWorkflow(document, { input }));
  const draft = checkDraft({ document: document as unknown as Json }, { name: "probe", tools: [], resolveWorkflow: () => null });
  assert.equal(draft.ok, false, JSON.stringify(draft));
});

test("(R15-02) the same map without minItems is ok with the assumed-path warning: an empty list is a valid input that succeeds", () => {
  const document = valid(probe(0));
  const r = dryRunWorkflow(document);
  assertAssumedFail(r);
  assert.deepEqual(dependent(r), ["$.root.run: a run that takes this path fails here; the walk took it because of placeholder values"]);
  assert.equal(dryRunWorkflow(document, { input: [] }).ok, true);
  const draft = checkDraft({ document: document as unknown as Json }, { name: "probe", tools: [], resolveWorkflow: () => null });
  assert.equal(draft.ok, true, JSON.stringify(draft));
});

test("(R15-02) over a nested property with minItems 2, a written list and a step output whose schema has minItems 1: certain", () => {
  const nested = wf(obj({ outer: obj({ rows: arr({ type: "string" }, 2, 3) }) }), map("each", ref("input.outer.rows"), fail("boom")));
  assertCertainFail(dryRunWorkflow(valid(nested)));
  const written = wf(obj({ flag: BOOL }), map("each", [ref("input.flag")], fail("boom")));
  assertCertainFail(dryRunWorkflow(valid(written)));
  const literal = wf(obj({ flag: BOOL }), map("each", { $literal: ["a", "b"] }, fail("boom")));
  assertCertainFail(dryRunWorkflow(valid(literal)));
  const fromStep = wf(obj({}), {
    id: "main", kind: "sequence", steps: [
      { id: "m", kind: "model", prompt: "List.", output: "L" },
      map("each", ref("steps.m.items"), fail("boom")),
    ],
  }, { schemas: { In: obj({}), Out: { type: "string" }, L: obj({ items: arr({ type: "string" }, 1, 4) }) } });
  assertCertainFail(dryRunWorkflow(valid(fromStep)));
  // The second item of a list with minItems 1 is not guaranteed: a fail only at index 1 stays a warning.
  const second = wf({ ...arr(BOOL, 1, 2), examples: [[true, true]] }, map("each", ref("input"), branch("at", ref("vars.it_index"), [[1, fail("boom")]], tool("t"))));
  const r = dryRunWorkflow(valid(second));
  assertAssumedFail(r);
  assert.equal(r.wouldCall.length, 1, "the first item's body calls the tool");
});

test("(R15-02) a reference with a default, an optional property and a union-typed list do not guarantee an item", () => {
  const withDefault = wf(obj({ rows: arr(BOOL, 1, 1) }), map("each", { $ref: "input.rows", default: [] }, fail("boom")));
  assertAssumedFail(dryRunWorkflow(valid(withDefault)));
  const optional = wf({ type: "object", properties: { rows: arr(BOOL, 1, 1) } }, map("each", ref("input.rows"), fail("boom")));
  assertAssumedFail(dryRunWorkflow(valid(optional)));
  const union = wf({ anyOf: [arr(BOOL, 1, 1), arr(BOOL, 0, 0)] }, map("each", ref("input"), fail("boom")));
  assertAssumedFail(dryRunWorkflow(valid(union)));
  const twoTypes = wf({ type: ["array", "object"], items: BOOL, minItems: 1 }, map("each", ref("input"), fail("boom")));
  assertAssumedFail(dryRunWorkflow(valid(twoTypes)));
});

test("(R15-02) a body that fails only for some item values stays a warning", () => {
  const document = valid(wf(arr(BOOL, 1, 2), map("each", ref("input"), branch("pick", ref("vars.it"), [[true, fail("boom")], [false, tool("t")]]))));
  const r = dryRunWorkflow(document);
  assert.equal(r.ok, true, show(r));
  assert.equal(dryRunWorkflow(document, { input: [false] }).ok, true);
  assert.equal(dryRunWorkflow(document, { input: [true] }).ok, false);
});

test("(R15-02) a branch on a made-up value whose every reachable case is a map with a guaranteed item and a failing body is not ok", () => {
  const each = (id: string): WorkflowNode => map(id, ref("input.list"), fail(`${id}_fail`));
  const document = valid(wf(obj({ flag: BOOL, list: arr(BOOL, 1, 1) }), branch("route", ref("input.flag"), [[true, each("yes")], [false, each("no")]])));
  assertCertainFail(dryRunWorkflow(document));
  const escape = valid(wf(obj({ flag: BOOL, list: arr(BOOL, 1, 1) }), branch("route", ref("input.flag"), [[true, each("yes")], [false, tool("t")]])));
  const r = dryRunWorkflow(escape);
  assert.equal(r.ok, true, show(r));
  assert.equal(r.steps.find((s) => s.nodeId === "route")?.note?.startsWith("case 1"), true, show(r));
});

test("(R15-02) a loop whose body is an unconditional fail, over made-up values, is not ok", () => {
  const made = valid(wf(obj({ flag: BOOL }), loop("lp", { truthy: ref("input.flag") }, fail("boom"), 3)));
  assertCertainFail(dryRunWorkflow(made));
  // Inside a map over a guaranteed list, with an until on the item.
  const inMap = valid(wf(arr(BOOL, 1, 2), map("each", ref("input"), loop("lp", { truthy: ref("vars.it") }, fail("boom"), 2))));
  assertCertainFail(dryRunWorkflow(inMap));
});

test("(R15-02) a loop whose made-up until can never hold runs every iteration: a fail in a later iteration is certain", () => {
  const body = branch("at", ref("loop.lp.index"), [[2, fail("boom")]], tool("t"));
  const document = valid(wf(obj({ flag: BOOL }), loop("lp", { eq: [ref("input.flag"), "never"] }, body, 3)));
  const r = dryRunWorkflow(document);
  assertCertainFail(r);
  assert.equal(r.wouldCall.length, 2, "iterations 1 and 2 call the tool, iteration 3 fails");
  const continues = valid(wf(obj({ flag: BOOL }), loop("lp", { eq: [ref("input.flag"), "never"] }, tool("t"), 3)));
  const ends = dryRunWorkflow(continues);
  assert.equal(ends.ok, true, show(ends));
  assert.equal(ends.wouldCall.length, 3, "every iteration is walked");
  assert.equal(ends.steps[0]?.note, "until cannot hold for the declared schemas; stopped at maxIterations 3");
});

interface Row { name: string; document: WorkflowDocument; allFail: boolean }

const failing = (id: string): WorkflowNode => fail(id);
const listOf = (id: string, over: Expr, run: WorkflowNode = failing(`${id}_fail`), as = "it"): WorkflowNode => map(id, over, run, as);

const ROWS: Row[] = [
  { name: "map body, over input with minItems 1", allFail: true, document: wf(arr(BOOL, 1, 1), listOf("each", ref("input"))) },
  { name: "map body, over input without minItems", allFail: false, document: wf(arr(BOOL, 0, 1), listOf("each", ref("input"))) },
  { name: "map body, over a nested property with minItems 2", allFail: true,
    document: wf(obj({ rows: arr({ enum: ["a", "b"] }, 2, 2) }), listOf("each", ref("input.rows"))) },
  { name: "map body, over a written list of references", allFail: true, document: wf(obj({ flag: BOOL }), listOf("each", [ref("input.flag")])) },
  { name: "map body, a branch on the item that may succeed", allFail: false,
    document: wf(arr(BOOL, 1, 2), listOf("each", ref("input"), branch("pick", ref("vars.it"), [[true, failing("f")], [false, tool("t")]]))) },
  { name: "map body, a branch on the item whose every case fails", allFail: true,
    document: wf(arr(BOOL, 1, 1), listOf("each", ref("input"), branch("pick", ref("vars.it"), [[true, failing("f")], [false, failing("g")]]))) },
  { name: "branch case, every reachable case a certain map", allFail: true,
    document: wf(obj({ flag: BOOL, list: arr(BOOL, 1, 1) }), branch("route", ref("input.flag"), [[true, listOf("yes", ref("input.list"))], [false, listOf("no", ref("input.list"))]])) },
  { name: "branch case, one case escapes", allFail: false,
    document: wf(obj({ flag: BOOL, list: arr(BOOL, 1, 1) }), branch("route", ref("input.flag"), [[true, listOf("yes", ref("input.list"))], [false, tool("t")]])) },
  { name: "branch default on an enum, every outcome a certain map or a fail", allFail: true,
    document: wf(obj({ mode: { enum: ["a", "b", "c"] }, list: arr(BOOL, 1, 1) }),
      branch("route", ref("input.mode"), [["a", listOf("on_a", ref("input.list"))], ["b", failing("on_b")]], listOf("other", ref("input.list")))) },
  { name: "loop iteration 1, until made up", allFail: true, document: wf(obj({ flag: BOOL }), loop("lp", { truthy: ref("input.flag") }, failing("f"), 2)) },
  { name: "loop iteration 3, after an until that can never hold", allFail: true,
    document: wf(obj({ flag: BOOL }), loop("lp", { eq: [ref("input.flag"), "never"] }, branch("at", ref("loop.lp.index"), [[2, failing("f")]], tool("t")), 3)) },
  { name: "loop iteration 2, after an until that may hold", allFail: false,
    document: wf(obj({ flag: BOOL }), loop("lp", { truthy: ref("input.flag") }, branch("at", ref("loop.lp.index"), [[1, failing("f")]], tool("t")), 2)) },
  { name: "loop bound with onLimit fail, until can never hold", allFail: true,
    document: wf(obj({ flag: BOOL }), loop("lp", { eq: [ref("input.flag"), "never"] }, tool("t"), 2, "fail")) },
  { name: "sequence around a certain map", allFail: true,
    document: wf(arr(BOOL, 1, 2), { id: "main", kind: "sequence", steps: [tool("t"), listOf("each", ref("input"), { id: "inner", kind: "sequence", steps: [tool("u"), failing("f")] })] }) },
  { name: "parallel with a certain map", allFail: true,
    document: wf(arr({ enum: ["x", "y"] }, 1, 1), { id: "both", kind: "parallel", branches: [listOf("each", ref("input")), tool("t")] }) },
  { name: "nested maps over a non-empty item", allFail: true,
    document: wf(arr(arr(BOOL, 1, 1), 1, 1), listOf("rows", ref("input"), listOf("cells", ref("vars.row")), "row")) },
  { name: "nested maps over an item that may be empty", allFail: false,
    document: wf(arr(arr(BOOL, 0, 1), 1, 1), listOf("rows", ref("input"), listOf("cells", ref("vars.row")), "row")) },
  { name: "call into a sub-workflow whose map body fails", allFail: true,
    document: wf(arr(BOOL, 1, 1), { id: "c", kind: "call", workflow: "sub", input: ref("input") }, {
      workflows: { sub: wf(arr(BOOL, 1, 1), listOf("each", ref("input")), { name: "sub" }) },
    }) },
];

test("(R15-02) the class as a property: the placeholder run fails for certain exactly when every valid input fails", () => {
  assert.ok(ROWS.length >= 12);
  for (const row of ROWS) {
    const document = valid(row.document);
    const inputs = enumerate(document.schemas["In"] as JsonSchema);
    assert.ok(inputs.length > 0, row.name);
    let anySucceeds = false;
    for (const input of inputs) {
      assert.deepEqual(validateSchema(document.schemas["In"] as JsonSchema, input), [], `${row.name}: ${JSON.stringify(input)} is valid`);
      const r = dryRunWorkflow(document, { input });
      assert.ok(isJsonObject(r) && !r.truncated, row.name);
      assert.deepEqual(dependent(r), [], `${row.name}: a supplied-input walk depends on no made-up control flow: ${show(r)}`);
      if (r.ok) anySucceeds = true;
    }
    assert.equal(!anySucceeds, row.allFail, `${row.name}: the table's expectation matches the enumeration`);
    const placeholder = dryRunWorkflow(document);
    assert.equal(placeholder.ok, anySucceeds, `${row.name}: ${show(placeholder)}`);
  }
});
