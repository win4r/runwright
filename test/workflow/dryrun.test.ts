import { test } from "node:test";
import assert from "node:assert/strict";
import type { Json } from "../../src/core/json.ts";
import { checkDraft } from "../../src/learning/promotion.ts";
import type { JsonSchema } from "../../src/schema/validate.ts";
import { dryRunWorkflow, PLACEHOLDER_DEPENDENT } from "../../src/workflow/dryrun.ts";
import type { Condition, DryRunReport, WorkflowDocument, WorkflowNode } from "../../src/workflow/types.ts";

function triage(): WorkflowDocument {
  return {
    format: "runwright.workflow/v1",
    name: "triage",
    schemas: {
      Input: { type: "object", required: ["ticket"], properties: { ticket: { type: "string" } } },
      Output: { type: "object", required: ["urgent"], properties: { urgent: { type: "boolean" } } },
    },
    input: "Input",
    output: "Output",
    root: { id: "main", kind: "sequence", steps: [
      { id: "urgent", kind: "decide", question: "Is this urgent?\n{{input.ticket}}", decision: { type: "yes_no" },
        lowConfidence: { below: 0.7,
          run: { id: "review", kind: "agent", message: "Decide urgency: {{input.ticket}}", maxTurns: 4, output: "Output" },
          value: { $ref: "fallback.data.urgent" } } },
    ] },
    result: { urgent: { $ref: "steps.urgent.value" } },
  };
}

function doc(steps: WorkflowNode[], result: WorkflowDocument["result"] = { urgent: true }, extra?: Partial<WorkflowDocument>): WorkflowDocument {
  return { ...triage(), root: { id: "main", kind: "sequence", steps }, result, ...extra };
}

test("confident route: steps in order, every would-be call, typed output", () => {
  const report = dryRunWorkflow(triage(), { input: { ticket: "printer on fire" } });
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.deepEqual(report.steps.map((s) => s.nodeId), ["main", "urgent"]);
  assert.deepEqual(report.wouldCall, [{ nodeId: "urgent", type: "decision", name: "yes_no",
    detail: { question: "Is this urgent?\nprinter on fire", decision: { type: "yes_no" } } }]);
  assert.deepEqual(report.output, { urgent: true });
});

test("low-confidence route runs the fallback and applies its value", () => {
  const report = dryRunWorkflow(triage(), { decisions: { urgent: { value: true, confidence: 0.4 } } });
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.deepEqual(report.steps.map((s) => s.nodeId), ["main", "urgent", "review"]);
  assert.deepEqual(report.wouldCall.map((c) => c.type), ["decision", "agent"]);
  assert.deepEqual(report.output, { urgent: false });
  assert.match(report.steps[1]?.note ?? "", /low confidence/);
});

test("branch cases follow decision overrides", () => {
  const document = doc([
    { id: "kind", kind: "decide", question: "q", decision: { type: "pick_one", options: ["bug", "idea"] } },
    { id: "route", kind: "branch", on: { $ref: "steps.kind.value" }, cases: [
      { when: "bug", run: { id: "file_bug", kind: "tool", tool: "write_file", args: { path: "bug.md" } } },
      { when: "idea", run: { id: "ask", kind: "wait", question: "Keep {{steps.kind.value}}?", choices: ["yes", "no"] } }] },
  ]);
  const bug = dryRunWorkflow(document);
  assert.deepEqual(bug.steps.map((s) => s.nodeId), ["main", "kind", "route", "file_bug"]);
  assert.deepEqual(bug.wouldCall[1], { nodeId: "file_bug", type: "tool", name: "write_file", detail: { args: { path: "bug.md" } } });
  const idea = dryRunWorkflow(document, { decisions: { kind: { value: "idea", confidence: 1 } } });
  assert.deepEqual(idea.steps.map((s) => s.nodeId), ["main", "kind", "route", "ask"]);
  assert.deepEqual(idea.wouldCall[1]?.detail, { question: "Keep idea?", choices: ["yes", "no"] });
});

test("map over a literal list and over a placeholder", () => {
  const literal = dryRunWorkflow(doc([{ id: "each", kind: "map", over: ["a", "b", "c"], as: "item", concurrency: 2, maxItems: 5,
    run: { id: "put", kind: "tool", tool: "t", args: { v: "{{vars.item}}-{{vars.item_index}}" } } }]));
  assert.equal(literal.ok, true, JSON.stringify(literal.problems));
  assert.deepEqual(literal.wouldCall.map((c) => c.detail), [{ args: { v: "a-0" } }, { args: { v: "b-1" } }, { args: { v: "c-2" } }]);
  assert.deepEqual(literal.steps.filter((s) => s.nodeId === "put").map((s) => s.scope), ["each[0]/", "each[1]/", "each[2]/"]);
  const tooMany = dryRunWorkflow(doc([{ id: "each", kind: "map", over: [1, 2, 3], as: "item", concurrency: 1, maxItems: 2, run: { id: "w", kind: "wait", question: "q" } }]));
  assert.equal(tooMany.ok, false);
  const placeholder = dryRunWorkflow(doc([{ id: "each", kind: "map", over: { $ref: "input.tags" }, as: "tag", concurrency: 1, maxItems: 5,
    run: { id: "put", kind: "tool", tool: "t", args: { v: { $ref: "vars.tag" } } } }],
    { urgent: true }, { schemas: { ...triage().schemas, Input: { type: "object", properties: { tags: { type: "array", items: { type: "string" } } }, required: ["tags"] } } }));
  assert.equal(placeholder.ok, true, JSON.stringify(placeholder.problems));
  assert.deepEqual(placeholder.wouldCall.map((c) => c.detail), [{ args: { v: "" } }]);
  assert.match(placeholder.steps[1]?.note ?? "", /placeholder/);
});

test("loop stops on until and at its bound", () => {
  const until = dryRunWorkflow(doc([{ id: "lp", kind: "loop", maxIterations: 5, until: { gte: [{ $ref: "loop.lp.index" }, 1] },
    run: { id: "tick", kind: "tool", tool: "t", args: { i: { $ref: "loop.lp.index" } } } }]));
  assert.equal(until.wouldCall.length, 2);
  const bound = dryRunWorkflow(doc([{ id: "lp", kind: "loop", maxIterations: 3, until: { truthy: false }, run: { id: "tick", kind: "tool", tool: "t", args: {} } }],
    { urgent: { $ref: "steps.lp.completed" } }));
  assert.equal(bound.wouldCall.length, 3);
  assert.deepEqual(bound.output, { urgent: false });
  const failing = dryRunWorkflow(doc([{ id: "lp", kind: "loop", maxIterations: 2, onLimit: "fail", until: { truthy: false }, run: { id: "tick", kind: "tool", tool: "t", args: {} } }]));
  assert.equal(failing.ok, false);
  assert.equal(failing.wouldCall.length, 2);
});

test("sub-workflow calls recurse with the resolved input", () => {
  const sub = triage();
  const report = dryRunWorkflow(doc([{ id: "c", kind: "call", workflow: "sub", input: { ticket: "{{input.ticket}}!" } }], { urgent: { $ref: "steps.c.urgent" } },
    { workflows: { sub } }), { input: { ticket: "t" } });
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.deepEqual(report.wouldCall[0], { nodeId: "c", type: "workflow", name: "sub", detail: { input: { ticket: "t!" } } });
  assert.equal(report.steps.find((s) => s.nodeId === "urgent")?.scope, "c>/");
  assert.deepEqual(report.output, { urgent: true });
});

test("fail ends the walk", () => {
  const report = dryRunWorkflow(doc([{ id: "boom", kind: "fail", message: "no {{input.ticket}}" }]), { input: { ticket: "luck" } });
  assert.equal(report.ok, false);
  assert.equal(report.steps.at(-1)?.note, "would fail: no luck");
});

test("maxSteps truncates", () => {
  const report = dryRunWorkflow(doc([{ id: "lp", kind: "loop", maxIterations: 100, until: { truthy: false }, run: { id: "tick", kind: "tool", tool: "t", args: {} } }]), { maxSteps: 10 });
  assert.equal(report.truncated, true);
  assert.equal(report.steps.length, 10);
});

test("output and input are checked against their schemas", () => {
  // A person's answer is always a string: the validator proves it never fits the boolean, so nothing is walked.
  const badOut = dryRunWorkflow(doc([{ id: "w", kind: "wait", question: "q" }], { urgent: { $ref: "steps.w.answer" } }));
  assert.equal(badOut.ok, false);
  assert.ok(badOut.problems.some((p) => p.code === "schema_mismatch" && p.severity === "error" && p.path === "$.result.urgent"), JSON.stringify(badOut.problems));
  assert.deepEqual(badOut.steps, []);
  const unionOut = dryRunWorkflow(doc([{ id: "w", kind: "wait", question: "q" }], { urgent: { $ref: "steps.w.answer" } },
    { schemas: { ...triage().schemas, Output: { type: "object", properties: { urgent: { anyOf: [{ type: "boolean" }, { type: "string", minLength: 1 }] } } } } }));
  assert.equal(unionOut.ok, true, JSON.stringify(unionOut.problems));
  assert.ok(unionOut.problems.some((p) => p.code === PLACEHOLDER_DEPENDENT && p.path === "output.urgent"), JSON.stringify(unionOut.problems));
  const badIn = dryRunWorkflow(triage(), { input: { ticket: 5 } });
  assert.equal(badIn.ok, false);
  assert.equal(badIn.steps.length, 0);
  const invalid = dryRunWorkflow({ ...triage(), format: "x" } as unknown as WorkflowDocument);
  assert.equal(invalid.ok, false);
  assert.deepEqual(invalid.steps, []);
});

test("problems that depend on placeholder values are warnings with their own code; branch notes say when a value is made up", () => {
  assert.equal(PLACEHOLDER_DEPENDENT, "placeholder_dependent");
  const document = doc([
    { id: "kind", kind: "decide", question: "q", decision: { type: "pick_one", options: ["bug", "idea"] } },
    { id: "route", kind: "branch", on: { $ref: "steps.kind.value" }, cases: [
      { when: "bug", run: { id: "file_bug", kind: "tool", tool: "write_file", args: { path: "bug.md" } } },
      { when: "idea", run: { id: "ask", kind: "wait", question: "q" } }] },
  ], { urgent: { $ref: "steps.kind.reason" } });
  const routed = { ...document, result: { urgent: true } };
  const madeUp = dryRunWorkflow(routed);
  assert.equal(madeUp.steps[2]?.note, 'case 0 ("bug", placeholder)');
  const decided = dryRunWorkflow(routed, { decisions: { kind: { value: "idea", confidence: 1 } } });
  assert.equal(decided.steps[2]?.note, 'case 1 ("idea")');
  const certain = dryRunWorkflow(document);
  assert.equal(certain.ok, false, "a string into a boolean is certain whatever the model answers");
  assert.ok(certain.problems.some((p) => p.severity === "error" && p.code === "schema_mismatch" && p.path === "$.result.urgent"), JSON.stringify(certain.problems));
  const loose = dryRunWorkflow({ ...document, schemas: { ...document.schemas, Output: { type: "object", properties: { urgent: { type: "string", minLength: 2 } } } } });
  assert.equal(loose.ok, true, JSON.stringify(loose.problems));
  assert.deepEqual(loose.problems.filter((p) => p.code === PLACEHOLDER_DEPENDENT).map((p) => [p.path, p.severity]), [["output.urgent", "warning"]]);
});

// ---- R14-03 / R14D-workflow-02: a loop whose until can never hold fails at its bound (rule V) ----

const BOOL_IN: JsonSchema = { type: "object", required: ["go"], properties: { go: { type: "boolean" } } };
const DONE: JsonSchema = { type: "object", required: ["done"], properties: { done: { type: "boolean" } } };

/** A document with input `In`, output `Out` (any value) and a model schema `D`. */
function loopDoc(root: WorkflowNode, input: JsonSchema = { type: "object" }): WorkflowDocument {
  return {
    format: "runwright.workflow/v1", name: "probe", schemas: { In: input, Out: {}, D: DONE }, input: "In", output: "Out", root,
    result: { $ref: "steps.lp" },
  };
}

function loopOn(until: Condition, run: WorkflowNode, onLimit: "fail" | "continue" = "fail"): WorkflowNode {
  return { id: "lp", kind: "loop", maxIterations: 3, onLimit, until, run };
}

const model = (id: string): WorkflowNode => ({ id, kind: "model", prompt: "Done?", output: "D" });
const waitNode = (id: string): WorkflowNode => ({ id, kind: "wait", question: "q" });
const notes = (r: DryRunReport): (string | null)[] => r.steps.map((step) => step.note);
const draft = (document: WorkflowDocument): ReturnType<typeof checkDraft> =>
  checkDraft({ document: document as unknown as Json }, { name: "probe", tools: [], resolveWorkflow: () => null });

/** The certain failure of loop `lp` at its bound of 3: not ok, the note names the bound, nothing assumed. */
function assertFailsAtBound(r: DryRunReport): void {
  assert.equal(r.ok, false, JSON.stringify(r));
  const step = r.steps.find((s) => s.nodeId === "lp");
  assert.equal(step?.path, "$.root");
  assert.equal(step?.note, "would fail: reached maxIterations 3");
  assert.ok(!notes(r).some((note) => note !== null && note.includes("assumed to hold")), JSON.stringify(notes(r)));
  assert.deepEqual(r.problems.filter((p) => p.code === PLACEHOLDER_DEPENDENT), []);
}

test("the reviewer's documents: a literal ne that never holds, and-ed with a made-up boolean, fails at the bound", () => {
  const onInput = loopDoc(loopOn({ and: [{ ne: [1, 1] }, { truthy: { $ref: "input.go" } }] }, waitNode("w")), BOOL_IN);
  const onModel = loopDoc(loopOn({ and: [{ ne: [1, 1] }, { truthy: { $ref: "steps.m.done" } }] }, model("m")));
  for (const document of [onInput, onModel]) {
    assertFailsAtBound(dryRunWorkflow(document));
    const verdict = draft(document);
    assert.equal(verdict.ok, false, "the promotion gate keeps no workflow whose every run fails at the bound");
    assert.deepEqual(verdict.ok ? [] : verdict.problems, ["dry run $.root: would fail: reached maxIterations 3"]);
  }
  assertFailsAtBound(dryRunWorkflow(onInput, { input: { go: true } }));
  const either = loopDoc(loopOn({ or: [{ ne: [1, 1] }, { truthy: { $ref: "steps.m.done" } }] }, model("m")));
  const assumed = dryRunWorkflow(either);
  assert.equal(assumed.ok, true, "or with a part that may hold may hold");
  assert.deepEqual(notes(assumed)[0], "until depends on placeholder values; assumed to hold after iteration 1");
});

test("every operator of a literal part is decided as it evaluates: gt, truthy, not, nested", () => {
  const ref = { truthy: { $ref: "steps.m.done" } };
  for (const never of [{ gt: [1, 2] }, { truthy: false }, { not: { eq: [1, 1] } }, { lte: ["b", "a"] }, { and: [{ or: [{ eq: [1, 2] }, { ne: ["a", "a"] }] }] },
    { not: { or: [{ eq: [{ a: 1, b: 2 }, { b: 2, a: 1 }] }] } }] as Condition[]) {
    assertFailsAtBound(dryRunWorkflow(loopDoc(loopOn({ and: [ref, never] }, model("m")))));
    assertFailsAtBound(dryRunWorkflow(loopDoc(loopOn({ and: [never, ref] }, model("m")))));
  }
  for (const always of [{ gt: [2, 1] }, { truthy: "x" }, { not: { ne: [1, 1] } }, { eq: [{ a: 1, b: 2 }, { b: 2, a: 1 }] }] as Condition[]) {
    const r = dryRunWorkflow(loopDoc(loopOn({ or: [ref, always] }, model("m"))));
    assert.equal(r.ok, true, JSON.stringify(always));
    assert.equal(notes(r)[0], "until held after 1 iteration", "a part that always holds holds in the walk too");
  }
});

test("a literal-only until is evaluated, never assumed", () => {
  const never = dryRunWorkflow(loopDoc(loopOn({ ne: [1, 1] }, model("m"), "continue")));
  assert.equal(never.ok, true);
  assert.equal(never.wouldCall.length, 3, "every iteration is walked");
  assert.equal(notes(never)[0], "stopped at maxIterations 3");
  assert.deepEqual((never.output as { completed: boolean }).completed, false);
  assertFailsAtBound(dryRunWorkflow(loopDoc(loopOn({ ne: [1, 1] }, model("m")))));
  const holds = dryRunWorkflow(loopDoc(loopOn({ gte: ["b", "a"] }, model("m"))));
  assert.equal(notes(holds)[0], "until held after 1 iteration");
});

test("a made-up until that can never hold ends the loop at its bound with onLimit continue", () => {
  const r = dryRunWorkflow(loopDoc(loopOn({ and: [{ ne: [1, 1] }, { truthy: { $ref: "input.go" } }] }, waitNode("w"), "continue"), BOOL_IN));
  assert.equal(r.ok, true);
  assert.equal(notes(r)[0], "until cannot hold for the declared schemas; stopped at maxIterations 3");
  assert.deepEqual(r.output, { iterations: 3, completed: false, last: { answer: "" } });
});

test("a made-up until whose placeholder makes it hold is still ended at the bound when it can never hold", () => {
  // No value satisfies the schema, so the placeholder is its first candidate (5), which makes `eq` true; no valid
  // value can, so every run ends at the bound.
  const impossible: JsonSchema = { type: "object", required: ["done"], properties: { done: { type: "integer", minimum: 5, maximum: 1 } } };
  const document: WorkflowDocument = { ...loopDoc(loopOn({ eq: [{ $ref: "steps.m.done" }, 5] }, model("m"))), schemas: { In: { type: "object" }, Out: {}, D: impossible } };
  const r = dryRunWorkflow(document);
  assert.equal(r.ok, false);
  assert.deepEqual(notes(r), ["would fail: reached maxIterations 3", null]);
});

test("a branch on a literal value can only take the case a run takes, also in the static check", () => {
  const inner = (id: string): WorkflowNode => ({
    id, kind: "branch", on: "a", cases: [{ when: "a", run: { id: `${id}_fail`, kind: "fail", message: "stop" } }], default: waitNode(`${id}_w`),
  });
  const document: WorkflowDocument = {
    format: "runwright.workflow/v1", name: "probe", schemas: { In: { type: "object" }, Out: {}, K: { type: "object", required: ["k"], properties: { k: { type: "boolean" } } } },
    input: "In", output: "Out",
    root: { id: "main", kind: "sequence", steps: [
      { id: "m", kind: "model", prompt: "k?", output: "K" },
      { id: "route", kind: "branch", on: { $ref: "steps.m.k" }, cases: [{ when: true, run: inner("one") }, { when: false, run: inner("two") }] },
    ] },
    result: null,
  };
  const r = dryRunWorkflow(document);
  assert.equal(r.ok, false, "every reachable case reaches a fail: the failure is certain");
  assert.equal(r.steps.at(-1)?.note, "would fail: stop");
  assert.deepEqual(r.problems.filter((p) => p.code === PLACEHOLDER_DEPENDENT), []);
  const literalOn = dryRunWorkflow({ ...document, root: inner("solo") });
  assert.deepEqual([literalOn.ok, notes(literalOn)[0]], [false, 'case 0 ("a")']);
  const toDefault = dryRunWorkflow({ ...document, root: { ...inner("solo"), on: { $literal: "b" } } as WorkflowNode });
  assert.deepEqual([toDefault.ok, notes(toDefault)[0]], [true, 'default ("b")']);
});

test("decide thresholds compare as a run does: confidence below the threshold only", () => {
  const document = triage();
  const at = (confidence: number): string | null => dryRunWorkflow(document, { decisions: { urgent: { value: true, confidence } } }).steps[1]?.note ?? null;
  assert.equal(at(0.7), "confident (0.7 >= 0.7)");
  assert.equal(at(0.69), "low confidence (0.69 < 0.7)");
  assert.equal(at(1), "confident (1 >= 0.7)");
});
