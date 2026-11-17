/**
 * The field specifications of workflow node values (`src/workflow/exec/value-fields.ts`): the table by node kind,
 * composites that follow what they enclose, the depth bound, the scope step's specification, and that redaction
 * by them keeps every field name and every computed value whatever secrets exist (finding R12-02).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Json } from "../../../src/core/json.ts";
import { createRedactor } from "../../../src/core/redact.ts";
import {
  fieldList, fieldObject, isFieldSpec, MAX_FIELD_SPEC_DEPTH, recordFieldsWith, redactBySpec, sameFieldSpec, unlistedPaths,
  type ArraySpec, type FieldSpec, type MapSpec, type ObjectSpec,
} from "../../../src/store/record-fields.ts";
import {
  DECISION_OUTPUT_FIELDS, enclosedNodes, MAX_NODE_SPEC_DEPTH, nodeValueFields, PROVIDER_WAIT_DATA_FIELDS, RESOLVE_VALUE_FIELDS,
  scopeValueFields,
} from "../../../src/workflow/exec/value-fields.ts";
import type { WorkflowNode } from "../../../src/workflow/types.ts";
import { wordSecrets } from "../../helpers/two-layer.ts";
import { doc, setupWorkflow } from "./helpers.ts";

const K = "keep";
const T = "text";
const P = "payload";

const tool = (id: string): WorkflowNode => ({ id, kind: "tool", tool: "count", args: { label: id } });
const model = (id: string): WorkflowNode => ({ id, kind: "model", prompt: "p", output: "Out" });
const wait = (id: string): WorkflowNode => ({ id, kind: "wait", question: "q?" });
const agent = (id: string): WorkflowNode => ({ id, kind: "agent", message: "m", maxTurns: 1 });
const call = (id: string): WorkflowNode => ({ id, kind: "call", workflow: "other", input: {} });
const fail = (id: string): WorkflowNode => ({ id, kind: "fail", message: "no" });
const decide = (id: string, fallback?: WorkflowNode, value?: Json): WorkflowNode => ({
  id, kind: "decide", question: "q?", decision: { type: "yes_no" },
  ...(fallback === undefined ? {} : { lowConfidence: { below: 0.5, run: fallback, ...(value === undefined ? {} : { value }) } }),
});
const loop = (id: string, run: WorkflowNode): WorkflowNode => ({ id, kind: "loop", maxIterations: 1, until: { truthy: true }, run });
const map = (id: string, run: WorkflowNode): WorkflowNode => ({ id, kind: "map", over: [1], as: "item", concurrency: 1, maxItems: 5, run });
const sequence = (id: string, steps: WorkflowNode[]): WorkflowNode => ({ id, kind: "sequence", steps });
const parallel = (id: string, branches: WorkflowNode[]): WorkflowNode => ({ id, kind: "parallel", branches });
const branch = (id: string, runs: WorkflowNode[], otherwise?: WorkflowNode): WorkflowNode => ({
  id, kind: "branch", on: "x", cases: runs.map((run, index) => ({ when: index, run })), ...(otherwise === undefined ? {} : { default: otherwise }),
});

const TOOL = fieldObject({ ok: K, content: T, data: P });
const DECIDE_PLAIN = fieldObject({ value: P, confidence: P, reason: T, route: K, fallback: K });
const decideWith = (fallback: FieldSpec): FieldSpec => fieldObject({ value: P, confidence: P, reason: T, route: K, fallback });
const LOOP_OF = (last: FieldSpec): FieldSpec => fieldObject({ iterations: K, completed: K, last });

function deepFrozen(spec: FieldSpec): boolean {
  if (typeof spec === "string") return true;
  if (!Object.isFrozen(spec)) return false;
  if ("items" in spec) return deepFrozen((spec as ArraySpec).items);
  if ("values" in spec) return deepFrozen((spec as MapSpec).values);
  const object = spec as ObjectSpec;
  return Object.isFrozen(object.fields) && Object.values(object.fields).every(deepFrozen) && (object.rest === undefined || deepFrozen(object.rest));
}

/** Container levels of a specification (a word is 0). */
function depth(spec: FieldSpec): number {
  if (typeof spec === "string") return 0;
  if ("items" in spec) return 1 + depth((spec as ArraySpec).items);
  if ("values" in spec) return 1 + depth((spec as MapSpec).values);
  const object = spec as ObjectSpec;
  return 1 + Math.max(0, ...Object.values(object.fields).map(depth), object.rest === undefined ? 0 : depth(object.rest));
}

/** The innermost word on the chain of `last` fields of nested loop specifications. */
function innermostLast(spec: FieldSpec): FieldSpec {
  let current = spec;
  while (typeof current !== "string") current = (current as ObjectSpec).fields["last"] as FieldSpec;
  return current;
}

function assertSame(actual: FieldSpec, expected: FieldSpec, label: string): void {
  assert.ok(sameFieldSpec(actual, expected), `${label}: ${JSON.stringify(actual)} is not ${JSON.stringify(expected)}`);
}

test("the constants have the specifications of the contract", () => {
  assertSame(RESOLVE_VALUE_FIELDS, fieldObject({ version: K }), "resolve");
  assertSame(DECISION_OUTPUT_FIELDS, fieldObject({ value: P, confidence: P, reason: T }), "decision output");
  assertSame(PROVIDER_WAIT_DATA_FIELDS, fieldObject({ providerWait: fieldObject({ retryAfterMs: K, retryAfterOverLimit: K }) }), "provider wait");
  for (const spec of [RESOLVE_VALUE_FIELDS, DECISION_OUTPUT_FIELDS, PROVIDER_WAIT_DATA_FIELDS]) {
    assert.equal(isFieldSpec(spec), true);
    assert.equal(deepFrozen(spec), true);
  }
});

test("nodeValueFields follows the table for every kind, frozen and cached per node object", () => {
  const table: [WorkflowNode, FieldSpec][] = [
    [tool("t"), TOOL],
    [model("m"), P],
    [decide("d"), DECIDE_PLAIN],
    [decide("d", wait("w")), decideWith(fieldObject({ answer: T }))],
    [decide("d", agent("a"), { $ref: "fallback.data.x" }), decideWith(fieldObject({ text: T, data: P }))],
    [wait("w"), fieldObject({ answer: T })],
    [agent("a"), fieldObject({ text: T, data: P })],
    [sequence("s", [model("m"), tool("t")]), TOOL],
    [sequence("s", []), K],
    [map("mp", decide("d")), fieldList(DECIDE_PLAIN)],
    [parallel("p", [tool("x"), wait("y"), model("z")]), fieldObject({ x: TOOL, y: fieldObject({ answer: T }), z: P })],
    [loop("l", tool("t")), LOOP_OF(TOOL)],
    [branch("b", [tool("x"), tool("y")], tool("z")), TOOL],
    [call("c"), P],
    [fail("f"), P],
  ];
  for (const [node, expected] of table) {
    const spec = nodeValueFields(node);
    assertSame(spec, expected, `${node.kind} ${JSON.stringify(node).slice(0, 80)}`);
    assert.equal(isFieldSpec(spec), true, node.kind);
    assert.equal(deepFrozen(spec), true, node.kind);
    assert.equal(nodeValueFields(node), spec, `${node.kind}: the same node object gives the same specification`);
  }
});

test("a branch: cases that agree share their specification, cases that differ are a payload, nothing is kept", () => {
  assertSame(nodeValueFields(branch("b", [decide("x"), decide("y")])), DECIDE_PLAIN, "agreeing cases");
  assertSame(nodeValueFields(branch("b", [tool("x"), decide("y")])), P, "differing cases");
  assertSame(nodeValueFields(branch("b", [tool("x")], decide("y"))), P, "a default that differs from the case");
  assertSame(nodeValueFields(branch("b", [])), K, "no case and no default");
  assertSame(nodeValueFields(branch("b", [], loop("l", wait("w")))), LOOP_OF(fieldObject({ answer: T })), "a default only");
  assertSame(nodeValueFields(branch("b", [sequence("s", [tool("x")]), tool("y")])), TOOL, "a sequence ending in a tool agrees with a tool");
});

test("composites of composites: a map of sequences whose last step is a loop of decisions", () => {
  const node = map("m", sequence("s", [tool("first"), loop("l", decide("d", parallel("p", [tool("a"), model("b")])))]));
  const expected = fieldList(LOOP_OF(decideWith(fieldObject({ a: TOOL, b: P }))));
  assertSame(nodeValueFields(node), expected, "nested");
  assert.equal(depth(nodeValueFields(node)), 5);
});

test("the depth bound: 40 nested loops give a specification of at most 32 levels whose innermost part is a payload", () => {
  let node: WorkflowNode = tool("leaf");
  const loops: WorkflowNode[] = [];
  for (let i = 39; i >= 0; i--) {
    node = loop(`l${i}`, node);
    loops.unshift(node);
  }
  const spec = nodeValueFields(node);
  assert.equal(isFieldSpec(spec), true);
  assert.equal(depth(spec), MAX_NODE_SPEC_DEPTH);
  assert.equal(innermostLast(spec), P);
  assert.ok(MAX_NODE_SPEC_DEPTH + 2 <= MAX_FIELD_SPEC_DEPTH, "a scope step and the record still fit the engine's bound");
  assert.equal(isFieldSpec(recordFieldsWith("node.finished", "value", spec)), true);
  assert.equal(isFieldSpec(recordFieldsWith("step.finished", "value", scopeValueFields(sequence("s", [node])))), true);
  // An inner node gets its own full specification, not the truncated part of its parent's.
  // l20 encloses 20 loops and the tool: it fits, so its own specification reaches the tool's.
  let inner = nodeValueFields(loops[20] as WorkflowNode);
  assert.equal(depth(inner), 21);
  for (let i = 0; i < 20; i++) inner = (inner as ObjectSpec).fields["last"] as FieldSpec;
  assertSame(inner, TOOL, "the innermost value of l20");
});

test("a workflow nested 40 loops deep runs to completion", async (t) => {
  let node: WorkflowNode = { id: "leaf", kind: "tool", tool: "count", args: { label: "leaf" } };
  for (let i = 39; i >= 0; i--) node = loop(`l${i}`, node);
  const s = await setupWorkflow(t);
  const done = await s.run(await s.agent({ workflow: doc(node, { $ref: "steps.l0.completed" }) }), {});
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(done.output, true);
  assert.equal(s.counters.get("count", "leaf"), 1);
});

test("scopeValueFields lists every node of the frame and none inside a map or loop body or a sub-workflow", () => {
  const root = sequence("s", [
    tool("a"),
    parallel("p", [decide("d", wait("w")), tool("constructor"), tool("valueof")]),
    map("m", tool("in_map")),
    loop("l", sequence("body", [tool("in_loop")])),
    call("c"),
    branch("b", [tool("case_one")], tool("other")),
  ]);
  const spec = scopeValueFields(root);
  const ids = ["a", "p", "d", "w", "constructor", "valueof", "m", "l", "c", "b", "case_one", "other"];
  assert.deepEqual(Object.keys(spec.fields), ids);
  assert.deepEqual(enclosedNodes(root).map((node) => node.id), ids);
  for (const id of ids) {
    assert.ok(Object.hasOwn(spec.fields, id), `${id} is an own listed key`);
    const node = enclosedNodes(root).find((entry) => entry.id === id) as WorkflowNode;
    assertSame(spec.fields[id] as FieldSpec, nodeValueFields(node), id);
  }
  assert.equal(spec.rest, undefined, "everything else in the scope value is a payload");
  assert.equal(deepFrozen(spec), true);
  assert.equal(scopeValueFields(root), spec, "cached per node object");
  assert.deepEqual(Object.keys(scopeValueFields(tool("x")).fields), []);
  assert.deepEqual(Object.keys(scopeValueFields(map("m", tool("x"))).fields), []);
});

/** Asserts that every "keep" value and every key under an ObjectSpec came through redaction unchanged. */
function assertKept(original: Json, redacted: Json, spec: FieldSpec, path: string): void {
  if (spec === K) {
    assert.deepEqual(redacted, original, `${path} is kept`);
    return;
  }
  if (typeof spec === "string" || original === null) return;
  if ("items" in spec) {
    assert.ok(Array.isArray(original) && Array.isArray(redacted), path);
    original.forEach((item, index) => assertKept(item, (redacted as Json[])[index] ?? null, (spec as ArraySpec).items, `${path}[${index}]`));
    return;
  }
  const object = spec as ObjectSpec;
  const from = original as Record<string, Json>;
  const to = redacted as Record<string, Json>;
  assert.deepEqual(Object.keys(to), Object.keys(from), `${path}: the keys are kept`);
  for (const key of Object.keys(from)) assertKept(from[key] as Json, to[key] as Json, object.fields[key] as FieldSpec, `${path}.${key}`);
}

test("redaction by a node's specification keeps every listed name and every computed value, whatever the secrets", () => {
  const toolValue: Json = { ok: true, content: "the tool said something", data: { result: 3 } };
  const decision = (fallback: Json): Json => ({ value: true, confidence: 0.25, reason: "a reason", route: "low_confidence", fallback });
  const loopValue = (last: Json): Json => ({ iterations: 3, completed: true, last });
  const cases: [string, WorkflowNode, Json][] = [
    ["tool", tool("t"), toolValue],
    ["decide", decide("d"), { value: "b", confidence: 0.9, reason: "clear", route: "confident", fallback: null }],
    ["decide with a loop fallback", decide("d", loop("l", tool("t"))), decision(loopValue(toolValue))],
    ["wait", wait("w"), { answer: "yes" }],
    ["agent", agent("a"), { text: "done", data: { x: 1 } }],
    ["sequence", sequence("s", [model("m"), decide("d")]), decision(null)],
    ["map", map("m", decide("d")), [decision(null), decision(null)]],
    ["parallel", parallel("p", [decide("a"), loop("b", wait("w"))]), { a: decision(null), b: loopValue({ answer: "ok" }) }],
    ["loop", loop("l", sequence("s", [decide("d", wait("w"))])), loopValue(decision({ answer: "a" }))],
    ["branch", branch("b", [tool("x"), tool("y")]), toolValue],
    ["empty sequence", sequence("s", []), null],
  ];
  for (const [label, node, value] of cases) {
    const spec = nodeValueFields(node);
    const words = [...wordSecrets(spec, DECISION_OUTPUT_FIELDS), "confident", "low_confidence"];
    const redactor = createRedactor(Object.fromEntries(words.map((word, index) => [`WORD_${index}`, word])));
    const redacted = redactBySpec(value, spec, redactor);
    assert.deepEqual(unlistedPaths(value, spec), [], label);
    assertKept(value, redacted, spec, label);
  }
  const scope = scopeValueFields(sequence("s", [tool("check_password"), decide("d")]));
  const scopeValue: Json = { check_password: toolValue, d: decision(null) };
  const redactor = createRedactor({ A: "password", B: "check_password", C: "confidence", D: "confident" });
  assert.deepEqual(unlistedPaths(scopeValue, scope), []);
  assertKept(scopeValue, redactBySpec(scopeValue, scope, redactor), scope, "scope");
});
