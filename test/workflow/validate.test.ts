import { test } from "node:test";
import assert from "node:assert/strict";
import { dryRunWorkflow } from "../../src/workflow/dryrun.ts";
import { validateWorkflow, type ValidateOptions } from "../../src/workflow/validate.ts";
import type { Expr, WorkflowDocument, WorkflowNode, WorkflowProblem } from "../../src/workflow/types.ts";

function example(): WorkflowDocument {
  return {
    format: "runwright.workflow/v1",
    name: "triage",
    description: "Classify a ticket; unsure ones go to an agent",
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

function withSteps(steps: WorkflowNode[], extra?: Partial<WorkflowDocument>): WorkflowDocument {
  return { ...example(), root: { id: "main", kind: "sequence", steps }, result: { urgent: true }, ...extra };
}

function only(document: unknown, codeName: string, options?: ValidateOptions): WorkflowProblem {
  const { problems } = validateWorkflow(document, options);
  const matching = problems.filter((p) => p.code === codeName);
  assert.equal(matching.length, 1, JSON.stringify(problems, null, 2));
  const found = matching[0] as WorkflowProblem;
  assert.ok(found.message.length > 10, found.message);
  return found;
}

const tools: ValidateOptions["tools"] = [
  { name: "web_fetch", parameters: { type: "object", required: ["url"], additionalProperties: false, properties: { url: { type: "string" } } }, retrySafe: true },
  { name: "write_file", parameters: { type: "object", properties: { path: { type: "string" } } }, retrySafe: false },
];

test("the plan example validates clean", () => {
  assert.deepEqual(validateWorkflow(example()), { ok: true, problems: [] });
});

test("format and shape", () => {
  assert.equal(only({ ...example(), format: "v0" }, "format").path, "$.format");
  const missing = validateWorkflow({ format: "runwright.workflow/v1" });
  assert.equal(missing.ok, false);
  for (const path of ["$.name", "$.schemas", "$.input", "$.output", "$.root", "$.result"]) {
    assert.ok(missing.problems.some((p) => p.path === path && p.code === "shape"), path);
  }
  const extra = only(withSteps([{ id: "a", kind: "fail", message: "x", colour: "red" } as unknown as WorkflowNode]), "shape");
  assert.equal(extra.path, "$.root.steps[0].colour");
  assert.equal(extra.severity, "warning");
  assert.equal(only(withSteps([{ id: "a", kind: "tool", tool: "x" } as unknown as WorkflowNode]), "shape").path, "$.root.steps[0]");
});

test("unknown_kind stops at that node", () => {
  const p = only(withSteps([{ id: "a", kind: "teleport", steps: [{ id: "A!" }] } as unknown as WorkflowNode]), "unknown_kind");
  assert.equal(p.path, "$.root.steps[0].kind");
  assert.equal(p.nodeId, "a");
});

test("duplicate_id and id pattern", () => {
  const dup = withSteps([{ id: "a", kind: "wait", question: "q" }, { id: "a", kind: "wait", question: "q" }]);
  assert.equal(only(dup, "duplicate_id").path, "$.root.steps[1].id");
  assert.equal(only(withSteps([{ id: "Bad-Id", kind: "wait", question: "q" }]), "duplicate_id").path, "$.root.steps[0].id");
});

test("unknown_schema and invalid_schema", () => {
  assert.equal(only({ ...example(), output: "Nope" }, "unknown_schema").path, "$.output");
  assert.equal(only(withSteps([{ id: "m", kind: "model", prompt: "p", output: "Ghost" }]), "unknown_schema").path, "$.root.steps[0].output");
  const bad = { ...example(), schemas: { ...example().schemas, Broken: { type: "strng" } } };
  assert.equal(only(bad, "invalid_schema").path, "$.schemas.Broken.type");
});

test("bad_reference cases", () => {
  assert.equal(only(withSteps([{ id: "a", kind: "wait", question: "{{input.__proto__}}" }]), "bad_reference").path, "$.root.steps[0].question");
  assert.equal(only(withSteps([{ id: "a", kind: "tool", tool: "t", args: { x: { $ref: "fallback.x" } } }]), "bad_reference").path, "$.root.steps[0].args.x");
  assert.equal(only(withSteps([{ id: "a", kind: "tool", tool: "t", args: { x: { $ref: "vars.item" } } }]), "bad_reference").path, "$.root.steps[0].args.x");
  const loopOutside = withSteps([
    { id: "lp", kind: "loop", maxIterations: 2, until: { truthy: true }, run: { id: "w", kind: "wait", question: "{{loop.lp.index}}" } },
    { id: "after", kind: "wait", question: "{{loop.lp.index}}" },
  ]);
  assert.equal(only(loopOutside, "bad_reference").path, "$.root.steps[1].question");
  assert.equal(only(withSteps([{ id: "a", kind: "tool", tool: "t", args: { x: { $ref: 5 } } } as unknown as WorkflowNode]), "bad_reference").path, "$.root.steps[0].args.x");
});

test("unknown_reference and visibility", () => {
  assert.equal(only(withSteps([{ id: "a", kind: "wait", question: "{{steps.ghost}}" }]), "unknown_reference").path, "$.root.steps[0].question");
  const later = withSteps([{ id: "a", kind: "wait", question: "{{steps.b.answer}}" }, { id: "b", kind: "wait", question: "q" }]);
  assert.match(only(later, "unknown_reference").message, /later/);
  const sibling = withSteps([{ id: "p", kind: "parallel", branches: [{ id: "a", kind: "wait", question: "q" }, { id: "b", kind: "wait", question: "{{steps.a.answer}}" }] }]);
  assert.equal(only(sibling, "unknown_reference").path, "$.root.steps[0].branches[1].question");
  const ok = withSteps([
    { id: "a", kind: "wait", question: "q" },
    { id: "inner", kind: "sequence", steps: [{ id: "b", kind: "wait", question: "{{steps.a.answer}}" }] },
    { id: "c", kind: "wait", question: "{{steps.b.answer}}" },
  ]);
  assert.equal(validateWorkflow(ok).ok, true, JSON.stringify(validateWorkflow(ok).problems));
});

test("conditional references need a default; templates never have one", () => {
  const steps: WorkflowNode[] = [
    { id: "br", kind: "branch", on: true, cases: [{ when: true, run: { id: "x", kind: "wait", question: "q" } }] },
    { id: "use", kind: "tool", tool: "t", args: { a: { $ref: "steps.x.answer" } } },
  ];
  assert.equal(only(withSteps(steps), "conditional_reference").path, "$.root.steps[1].args.a");
  const withDefault = withSteps([steps[0] as WorkflowNode, { id: "use", kind: "tool", tool: "t", args: { a: { $ref: "steps.x.answer", default: "" } } }]);
  assert.equal(validateWorkflow(withDefault).problems.filter((p) => p.code === "conditional_reference").length, 0);
  const template = withSteps([steps[0] as WorkflowNode, { id: "use", kind: "wait", question: "{{steps.x.answer}}" }]);
  assert.equal(only(template, "conditional_reference").path, "$.root.steps[1].question");
  const fromMap = withSteps([
    { id: "m", kind: "map", over: [1], as: "item", concurrency: 1, maxItems: 5, run: { id: "inside", kind: "wait", question: "{{vars.item}}" } },
    { id: "use", kind: "wait", question: "{{steps.inside.answer}}" },
  ]);
  assert.equal(only(fromMap, "conditional_reference").path, "$.root.steps[1].question");
});

test("schema_mismatch cases", () => {
  const closed = withSteps([{ id: "w", kind: "wait", question: "q" }, { id: "u", kind: "wait", question: "{{steps.w.nope}}" }]);
  assert.equal(only(closed, "schema_mismatch").path, "$.root.steps[1].question");
  const open = only(withSteps([{ id: "u", kind: "wait", question: "{{input.other}}" }]), "schema_mismatch");
  assert.equal(open.severity, "warning");
  const scalar = only(withSteps([{ id: "u", kind: "wait", question: "{{input.ticket.x}}" }]), "schema_mismatch");
  assert.equal(scalar.severity, "error");
  assert.equal(only(withSteps([{ id: "m", kind: "map", over: { $ref: "input.ticket" }, as: "i", concurrency: 1, maxItems: 2, run: { id: "f", kind: "fail", message: "x" } }]), "schema_mismatch").path, "$.root.steps[0].over");
  const branchType = withSteps([
    { id: "d", kind: "decide", question: "q", decision: { type: "yes_no" } },
    { id: "b", kind: "branch", on: { $ref: "steps.d.value" }, cases: [{ when: "yes", run: { id: "f", kind: "wait", question: "q" } }] },
  ]);
  assert.equal(only(branchType, "schema_mismatch").path, "$.root.steps[1].cases[0].when");
  assert.equal(only(withSteps([{ id: "t", kind: "tool", tool: "web_fetch", args: { url: 5 } }]), "schema_mismatch", { tools }).path, "$.root.steps[0].args.url");
  assert.equal(only(withSteps([{ id: "t", kind: "tool", tool: "web_fetch", args: {} }]), "schema_mismatch", { tools }).path, "$.root.steps[0].args");
  assert.equal(only({ ...example(), result: { urgent: "yes" } }, "schema_mismatch").path, "$.result.urgent");
  assert.equal(only(withSteps([{ id: "d", kind: "decide", question: "q", decision: { type: "pick_one", options: ["a"] } }]), "schema_mismatch").path, "$.root.steps[0].decision.options");
  assert.equal(only(withSteps([{ id: "d", kind: "decide", question: "q", decision: { type: "score", min: 5, max: 5 } }]), "schema_mismatch").path, "$.root.steps[0].decision");
  assert.equal(only(withSteps([{ id: "d", kind: "decide", question: "q", decision: { type: "yes_no" }, lowConfidence: { below: 1.5, run: { id: "w", kind: "wait", question: "q" } } }]), "schema_mismatch").path, "$.root.steps[0].lowConfidence.below");
  const callInput = withSteps([{ id: "c", kind: "call", workflow: "sub", input: { ticket: 3 } }], { workflows: { sub: example() } });
  assert.equal(only(callInput, "schema_mismatch").path, "$.root.steps[0].input.ticket");
});

test("unknown_tool and unknown_workflow", () => {
  assert.equal(only(withSteps([{ id: "t", kind: "tool", tool: "nuke", args: {} }]), "unknown_tool", { tools }).path, "$.root.steps[0].tool");
  assert.equal(only(withSteps([{ id: "a", kind: "agent", message: "m", maxTurns: 1, tools: ["web_fetch", "nuke"] }]), "unknown_tool", { tools }).path, "$.root.steps[0].tools[1]");
  const call = withSteps([{ id: "c", kind: "call", workflow: "elsewhere", input: null }]);
  const err = only(call, "unknown_workflow", { resolveWorkflow: () => null });
  assert.equal(err.path, "$.root.steps[0].workflow");
  assert.equal(err.severity, "error");
  assert.equal(only(call, "unknown_workflow").severity, "warning");
});

test("call_cycle of length 1, 2 and 3", () => {
  const caller = (name: string, target: string): WorkflowDocument => ({ ...withSteps([{ id: "c", kind: "call", workflow: target, input: { ticket: "t" } }]), name });
  const self = only(caller("a", "a"), "call_cycle");
  assert.match(self.message, /a -> a/);
  const saved: Record<string, WorkflowDocument> = { b: caller("b", "a"), c: caller("c", "d"), d: caller("d", "a") };
  const resolveWorkflow = (name: string) => saved[name] ?? null;
  assert.match(only(caller("a", "b"), "call_cycle", { resolveWorkflow }).message, /a -> b -> a/);
  const three = only(caller("a", "c"), "call_cycle", { resolveWorkflow });
  assert.match(three.message, /a -> c -> d -> a/);
  assert.equal(three.path, "$.root.steps[0].workflow");
});

test("inline sub-workflows are validated with prefixed paths", () => {
  const doc = { ...example(), workflows: { sub: { ...example(), format: "bad" } } };
  assert.equal(only(doc, "format").path, "$.workflows.sub.format");
});

test("missing_bound cases", () => {
  const p = (node: WorkflowNode) => validateWorkflow(withSteps([node])).problems.filter((x) => x.code === "missing_bound").map((x) => x.path);
  assert.deepEqual(p({ id: "m", kind: "map", over: [], as: "i", run: { id: "f", kind: "wait", question: "q" } } as unknown as WorkflowNode), ["$.root.steps[0].concurrency", "$.root.steps[0].maxItems"]);
  assert.deepEqual(p({ id: "m", kind: "map", over: [], as: "i", concurrency: 65, maxItems: 1, run: { id: "f", kind: "wait", question: "q" } }), ["$.root.steps[0].concurrency"]);
  assert.deepEqual(p({ id: "l", kind: "loop", until: { truthy: true }, run: { id: "f", kind: "wait", question: "q" } } as unknown as WorkflowNode), ["$.root.steps[0].maxIterations"]);
  assert.deepEqual(p({ id: "a", kind: "agent", message: "m" } as unknown as WorkflowNode), ["$.root.steps[0].maxTurns"]);
  assert.deepEqual(p({ id: "m", kind: "model", prompt: "p", output: "Output", retry: { maxAttempts: 11, backoffMs: -1 } }), ["$.root.steps[0].retry.maxAttempts", "$.root.steps[0].retry.backoffMs"]);
});

test("every unreachable case", () => {
  const after = withSteps([{ id: "f", kind: "fail", message: "x" }, { id: "w", kind: "wait", question: "q" }]);
  assert.equal(only(after, "unreachable").path, "$.root.steps[1]");
  const decide: WorkflowNode = { id: "d", kind: "decide", question: "q", decision: { type: "pick_one", options: ["a", "b"] } };
  const dupCase = withSteps([decide, { id: "b", kind: "branch", on: { $ref: "steps.d.value" }, cases: [
    { when: "a", run: { id: "x", kind: "wait", question: "q" } }, { when: "a", run: { id: "y", kind: "wait", question: "q" } }] }]);
  assert.equal(only(dupCase, "unreachable").path, "$.root.steps[1].cases[1]");
  const never = withSteps([decide, { id: "b", kind: "branch", on: { $ref: "steps.d.value" }, cases: [{ when: "z", run: { id: "x", kind: "wait", question: "q" } }] }]);
  assert.equal(only(never, "unreachable").path, "$.root.steps[1].cases[0]");
  const exhaustive = withSteps([{ id: "d", kind: "decide", question: "q", decision: { type: "yes_no" } }, { id: "b", kind: "branch", on: { $ref: "steps.d.value" },
    cases: [{ when: true, run: { id: "x", kind: "wait", question: "q" } }, { when: false, run: { id: "y", kind: "wait", question: "q" } }],
    default: { id: "z", kind: "wait", question: "q" } }]);
  assert.equal(only(exhaustive, "unreachable").path, "$.root.steps[1].default");
  assert.equal(only(withSteps([{ id: "l", kind: "loop", maxIterations: 0, until: { truthy: true }, run: { id: "x", kind: "wait", question: "q" } }]), "unreachable").path, "$.root.steps[0].run");
  assert.equal(only(withSteps([{ id: "m", kind: "map", over: [], as: "i", concurrency: 1, maxItems: 0, run: { id: "x", kind: "wait", question: "q" } }]), "unreachable").path, "$.root.steps[0].run");
});

test("retry_unsafe and bad_deadline", () => {
  assert.equal(only(withSteps([{ id: "t", kind: "tool", tool: "write_file", args: {}, retry: { maxAttempts: 2, backoffMs: 10 } }]), "retry_unsafe", { tools }).severity, "error");
  assert.equal(validateWorkflow(withSteps([{ id: "t", kind: "tool", tool: "web_fetch", args: { url: "u" }, retry: { maxAttempts: 2, backoffMs: 10 } }]), { tools }).ok, true);
  assert.equal(validateWorkflow(withSteps([{ id: "t", kind: "tool", tool: "write_file", args: {}, idempotent: true, retry: { maxAttempts: 2, backoffMs: 10 } }]), { tools }).ok, true);
  assert.equal(only(withSteps([{ id: "w", kind: "wait", question: "q", retry: { maxAttempts: 2, backoffMs: 1 } } as unknown as WorkflowNode]), "retry_unsafe").path, "$.root.steps[0].retry");
  const onWait = validateWorkflow(withSteps([{ id: "w", kind: "wait", question: "q", deadlineMs: 5 } as unknown as WorkflowNode]));
  assert.deepEqual([onWait.ok, onWait.problems], [true, []], "a deadline on a wait node bounds the answer: no problem");
  const inert = withSteps([{ id: "f", kind: "fail", message: "x", deadlineMs: 5 } as unknown as WorkflowNode]);
  const warning = only(inert, "bad_deadline");
  assert.deepEqual([warning.path, warning.severity, warning.message], ["$.root.steps[0].deadlineMs", "warning", `"deadlineMs" has no effect on a fail node`]);
  assert.equal(validateWorkflow(inert).ok, true);
  assert.equal(only(withSteps([{ id: "w", kind: "wait", question: "q", deadlineMs: 0 } as unknown as WorkflowNode]), "bad_deadline").severity, "error");
  assert.equal(only(withSteps([{ id: "m", kind: "model", prompt: "p", output: "Output", deadlineMs: 0 }]), "bad_deadline").path, "$.root.steps[0].deadlineMs");
});

test("several different problems are all reported", () => {
  const doc = { ...withSteps([
    { id: "a", kind: "wait", question: "{{steps.ghost}}" },
    { id: "a", kind: "teleport" } as unknown as WorkflowNode,
    { id: "l", kind: "loop", until: { truthy: true }, run: { id: "x", kind: "wait", question: "q" } } as unknown as WorkflowNode,
  ]), format: "nope" };
  const codes = new Set(validateWorkflow(doc).problems.map((p) => p.code));
  for (const c of ["format", "unknown_reference", "duplicate_id", "unknown_kind", "missing_bound"]) assert.ok(codes.has(c), c);
});

test("never throws on garbage", () => {
  for (const garbage of [null, 3, "x", [], { root: 5 }, { root: { id: "a", kind: "sequence", steps: "no" } }]) {
    assert.equal(validateWorkflow(garbage).ok, false);
  }
});

// Durations a workflow can declare are bounded by the longest wait one Node timer holds (2147483647 ms); a larger
// value, Infinity or NaN would otherwise become a 1 ms timer.
const timerNodes = (deadlineMs: unknown): WorkflowNode[] => [
  { id: "m", kind: "model", prompt: "p", output: "Output", deadlineMs } as unknown as WorkflowNode,
  { id: "d", kind: "decide", question: "q", decision: { type: "yes_no" }, deadlineMs } as unknown as WorkflowNode,
  { id: "t", kind: "tool", tool: "web_fetch", args: { url: "u" }, deadlineMs } as unknown as WorkflowNode,
];

const leaf = (id: string): WorkflowNode => ({ id, kind: "wait", question: "q" });
/** One node of every kind that a deadline bounds, each valid on its own. */
const boundedNodes = (deadlineMs: unknown): WorkflowNode[] => [
  ...timerNodes(deadlineMs),
  { id: "s", kind: "sequence", steps: [leaf("s1")], deadlineMs },
  { id: "p", kind: "parallel", branches: [leaf("p1")], deadlineMs },
  { id: "b", kind: "branch", on: true, cases: [{ when: true, run: leaf("b1") }], deadlineMs },
  { id: "mp", kind: "map", over: [1], as: "i", concurrency: 1, maxItems: 1, run: leaf("m1"), deadlineMs },
  { id: "l", kind: "loop", maxIterations: 1, until: { truthy: true }, run: leaf("l1"), deadlineMs },
  { id: "c", kind: "call", workflow: "sub", input: { ticket: "t" }, deadlineMs },
  { id: "a", kind: "agent", message: "m", maxTurns: 1, deadlineMs },
  { id: "w", kind: "wait", question: "q", deadlineMs },
] as unknown as WorkflowNode[];
const inertNodes = (deadlineMs: unknown): WorkflowNode[] => [
  { id: "f", kind: "fail", message: "x", deadlineMs },
] as unknown as WorkflowNode[];
const deadlineDoc = (node: WorkflowNode): WorkflowDocument => withSteps([node], { workflows: { sub: example() } });

test("deadlineMs is an integer from 1 to 2147483647 on every node kind", () => {
  for (const value of [1, 1000, 2147483647]) {
    for (const node of boundedNodes(value)) {
      const { ok, problems } = validateWorkflow(deadlineDoc(node), { tools });
      assert.equal(ok, true, `${node.kind} ${value}: ${JSON.stringify(problems)}`);
      assert.deepEqual(problems.filter((p) => p.code === "bad_deadline"), [], `${node.kind} ${value}`);
    }
  }
  for (const value of [2147483648, 1e12, Infinity, NaN, 1.5, 0, -1, "1s"]) {
    for (const node of [...boundedNodes(value), ...inertNodes(value)]) {
      const problem = only(deadlineDoc(node), "bad_deadline", { tools });
      assert.equal(problem.path, "$.root.steps[0].deadlineMs", `${node.kind} ${value}`);
      assert.equal(problem.severity, "error", `${node.kind} ${value}`);
      assert.match(problem.message, /2147483647/);
    }
  }
});

test("a valid deadlineMs on a wait node gives no problem; on a fail node it is accepted with a warning", () => {
  for (const value of [1, 1000, 2147483647]) {
    const onWait = validateWorkflow(deadlineDoc({ id: "w", kind: "wait", question: "q", deadlineMs: value } as unknown as WorkflowNode));
    assert.deepEqual([onWait.ok, onWait.problems], [true, []], `wait ${value}`);
  }
  for (const node of inertNodes(1000)) {
    const result = validateWorkflow(deadlineDoc(node));
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.deepEqual(result.problems.filter((p) => p.code === "bad_deadline").map((p) => [p.path, p.severity, p.message]),
      [["$.root.steps[0].deadlineMs", "warning", `"deadlineMs" has no effect on a ${node.kind} node`]]);
  }
});

test("retry stays limited to tool, model and decide nodes", () => {
  for (const node of boundedNodes(1000).slice(3)) {
    const withRetry = { ...node, retry: { maxAttempts: 2, backoffMs: 1 } } as unknown as WorkflowNode;
    assert.equal(only(deadlineDoc(withRetry), "retry_unsafe", { tools }).path, "$.root.steps[0].retry", node.kind);
  }
});

const retryNode = (retry: Record<string, unknown>): WorkflowNode =>
  ({ id: "m", kind: "model", prompt: "p", output: "Output", retry: { maxAttempts: 2, backoffMs: 10, ...retry } }) as unknown as WorkflowNode;

function retryProblems(retry: Record<string, unknown>): WorkflowProblem[] {
  return validateWorkflow(withSteps([retryNode(retry)])).problems.filter((p) => p.path.startsWith("$.root.steps[0].retry"));
}

test("retry.backoffMs is a finite number from 0 to 2147483647", () => {
  for (const value of [0, 2147483647]) assert.deepEqual(retryProblems({ backoffMs: value }), [], String(value));
  for (const value of [2147483648, Infinity, NaN, -1, "5"]) {
    const problem = only(withSteps([retryNode({ backoffMs: value })]), "missing_bound");
    assert.equal(problem.path, "$.root.steps[0].retry.backoffMs", String(value));
    assert.equal(problem.message, `"retry.backoffMs" must be a number from 0 to 2147483647`);
  }
});

test("retry.maxBackoffMs is a finite number from 0 to 2147483647", () => {
  for (const value of [0, 2147483647]) assert.deepEqual(retryProblems({ maxBackoffMs: value }), [], String(value));
  for (const value of [2147483648, Infinity, NaN, -1]) {
    const problems = retryProblems({ maxBackoffMs: value });
    assert.equal(problems.length, 1, `${value}: ${JSON.stringify(problems)}`);
    assert.equal(problems[0]?.code, "shape");
    assert.equal(problems[0]?.path, "$.root.steps[0].retry.maxBackoffMs");
    assert.equal(problems[0]?.message, `"retry.maxBackoffMs" must be a number from 0 to 2147483647`);
  }
});

test("retry.factor is a finite number of at least 1", () => {
  for (const value of [1, 2.5]) assert.deepEqual(retryProblems({ factor: value }), [], String(value));
  for (const value of [0.5, NaN, Infinity]) {
    const problems = retryProblems({ factor: value });
    assert.equal(problems.length, 1, `${value}: ${JSON.stringify(problems)}`);
    assert.equal(problems[0]?.code, "shape");
    assert.equal(problems[0]?.path, "$.root.steps[0].retry.factor");
    assert.equal(problems[0]?.message, `"retry.factor" must be a finite number >= 1`);
  }
});

test("a model node with deadlineMs 2147483648 makes the workflow invalid", () => {
  const result = validateWorkflow(withSteps([{ id: "m", kind: "model", prompt: "p", output: "Output", deadlineMs: 2147483648 }]));
  assert.equal(result.ok, false);
});

// Rule P: a part of a value that flows into a schema is reported only when no run that reads it could make it fit. A literal is checked in
// full, a reference by its shape; unions, unknown shapes and types that may fit are left to the run.

const ruleTools: ValidateOptions["tools"] = [
  { name: "write_file", parameters: { type: "object", required: ["path", "content"], additionalProperties: false,
    properties: { path: { type: "string" }, content: { type: "string" } } }, retrySafe: false },
  { name: "pick", parameters: { anyOf: [
    { type: "object", required: ["x"], properties: { x: { type: "string" } } },
    { type: "object", required: ["y"], properties: { y: { type: "number" } } }] }, retrySafe: true },
  { name: "pick_one_of", parameters: { oneOf: [
    { type: "object", required: ["x"], properties: { x: { type: "string" } } },
    { type: "object", required: ["y"], properties: { y: { type: "number" } } }] }, retrySafe: true },
  { name: "count", parameters: { type: "object", properties: { n: { type: "integer" } } }, retrySafe: true },
  { name: "pair", parameters: { type: "object", required: ["a", "b"], properties: { a: { type: "string" }, b: { type: "string" } } }, retrySafe: true },
];

const IN = { type: "object", required: ["n", "s", "x"], properties: {
  n: { type: "number" }, i: { type: "integer" }, s: { type: "string" }, x: { type: "string" },
  maybe: { type: ["string", "null"] }, open: {} } };

function typed(steps: WorkflowNode[], result: WorkflowDocument["result"], schemas: WorkflowDocument["schemas"] = {}, extra?: Partial<WorkflowDocument>): WorkflowDocument {
  return { ...example(), schemas: { Input: IN, Output: { type: "object" }, ...schemas }, root: { id: "main", kind: "sequence", steps }, result, ...extra };
}

function mismatches(document: WorkflowDocument, options?: ValidateOptions): [string, string][] {
  return validateWorkflow(document, options).problems.filter((p) => p.code === "schema_mismatch").map((p) => [p.path, p.message]);
}

const toolNode = (tool: string, args: { [name: string]: Expr }): WorkflowNode => ({ id: "t", kind: "tool", tool, args });

test("Rule P reports a reference whose shape never fits its destination", () => {
  assert.deepEqual(mismatches(typed([leaf("w")], { $ref: "input" }, { Input: { type: "number" }, Output: { type: "string" } })),
    [["$.result", `does not fit schema "Output": is number, but expected string`]]);
  assert.deepEqual(mismatches(typed([toolNode("write_file", { path: "a.txt", content: { $ref: "input.n" } })], {}), { tools: ruleTools }),
    [["$.root.steps[0].args.content", `argument does not fit tool "write_file": is number, but expected string`]]);
  const modelObject = typed([{ id: "m", kind: "model", prompt: "p", output: "M" }, { ...toolNode("write_file", { path: "a", content: { $ref: "steps.m" } }), id: "t" }], {},
    { M: { type: "object", properties: { text: { type: "string" } } } });
  assert.deepEqual(mismatches(modelObject, { tools: ruleTools }), [["$.root.steps[1].args.content", `argument does not fit tool "write_file": is object, but expected string`]]);
  const call = typed([{ id: "c", kind: "call", workflow: "sub", input: { ticket: { $ref: "input.n" } } }], {}, {}, { workflows: { sub: example() } });
  assert.deepEqual(mismatches(call), [["$.root.steps[0].input.ticket", `does not fit schema "Input": is number, but expected string`]]);
  const record = typed([leaf("w")], { $ref: "steps.w" }, { Output: { type: "object", required: ["urgent"], properties: { urgent: { type: "boolean" } } } });
  assert.deepEqual(mismatches(record), [["$.result.urgent", `does not fit schema "Output": never has the required property "urgent"`]]);
  const pick: WorkflowNode = { id: "d", kind: "decide", question: "q", decision: { type: "pick_one", options: ["p", "q"] } };
  const values = typed([pick], { v: { $ref: "steps.d.value" } }, { Output: { type: "object", properties: { v: { enum: ["a", "b"] } } } });
  assert.deepEqual(mismatches(values), [["$.result.v", `does not fit schema "Output": can only be "p", "q", none of which fits`]]);
  assert.deepEqual(mismatches(typed([toolNode("pair", { a: { $ref: "input.s" }, b: 5 })], {}), { tools: ruleTools }),
    [["$.root.steps[0].args.b", `argument does not fit tool "pair": expected string, got integer`]]);
  const missing = validateWorkflow(typed([toolNode("pair", { a: { $ref: "input.s" } })], {}), { tools: ruleTools }).problems.filter((p) => p.code === "schema_mismatch");
  assert.deepEqual(missing.map((p) => [p.path, p.message]), [["$.root.steps[0].args", `tool "pair" needs the argument "b"`]]);
  assert.deepEqual(mismatches(typed([toolNode("count", { n: "{{input.s}}" })], {}), { tools: ruleTools }),
    [["$.root.steps[0].args.n", `argument does not fit tool "count": is string, but expected integer`]]);
  assert.deepEqual(mismatches(typed([toolNode("count", { n: [{ $ref: "input.n" }] })], {}), { tools: ruleTools }),
    [["$.root.steps[0].args.n", `argument does not fit tool "count": is an array, but expected integer`]]);
  assert.deepEqual(mismatches(typed([toolNode("write_file", { path: "a", content: "c", extra: { $ref: "input.s" } })], {}), { tools: ruleTools }),
    [["$.root.steps[0].args.extra", `argument does not fit tool "write_file": property "extra" is not allowed`]]);
});

test("Rule P checks the default of a reference that may be missing, and the reference's shape whenever it resolves", () => {
  const branch: WorkflowNode = { id: "br", kind: "branch", on: true, cases: [{ when: true, run: leaf("x") }] };
  const doc = (fallback: Expr) => typed([branch, toolNode("write_file", { path: "a", content: { $ref: "steps.x.answer", default: fallback } })], {});
  assert.deepEqual(mismatches(doc(5), { tools: ruleTools }), [["$.root.steps[1].args.content.default", `argument does not fit tool "write_file": expected string, got integer`]]);
  assert.deepEqual(mismatches(doc(""), { tools: ruleTools }), []);
  const numberWithDefault = typed([toolNode("write_file", { path: "a", content: { $ref: "input.n", default: "" } })], {});
  assert.deepEqual(mismatches(numberWithDefault, { tools: ruleTools }),
    [["$.root.steps[0].args.content", `argument does not fit tool "write_file": is number, but expected string`]],
    "input.n is required, so it always resolves to a number and the default is never read");
  const openWithDefault = typed([toolNode("write_file", { path: "a", content: { $ref: "input.open", default: "" } })], {});
  assert.deepEqual(mismatches(openWithDefault, { tools: ruleTools }), [], "a run may read the default, which fits");
});

test("Rule P leaves unions, unknown shapes and types that may fit to the run", () => {
  assert.deepEqual(mismatches(typed([toolNode("pick", { x: { $ref: "input.x" } })], {}), { tools: ruleTools }), []);
  assert.deepEqual(mismatches(typed([toolNode("pick_one_of", { x: { $ref: "input.x" } })], {}), { tools: ruleTools }), []);
  assert.deepEqual(mismatches(typed([toolNode("count", { n: { $ref: "input.n" } })], {}), { tools: ruleTools }), [], "3.0 is an integer");
  assert.deepEqual(mismatches(typed([toolNode("write_file", { path: "a", content: { $ref: "input.maybe" } })], {}), { tools: ruleTools }), []);
  assert.deepEqual(mismatches(typed([toolNode("write_file", { path: "a", content: { $ref: "input.open" } })], {}), { tools: ruleTools }), []);
  const data = typed([{ ...toolNode("count", {}), id: "src" }, toolNode("write_file", { path: "a", content: { $ref: "steps.src.data" } })],
    { $ref: "steps.src.data" }, { Output: { type: "object", required: ["z"], additionalProperties: false, properties: { z: { type: "boolean" } } } });
  assert.deepEqual(mismatches(data, { tools: ruleTools }), []);
  const branch: WorkflowNode = { id: "br", kind: "branch", on: true, cases: [{ when: true, run: leaf("x") }] };
  const unknownShape = typed([branch], { $ref: "steps.br" }, { Output: { type: "object", required: ["z"], additionalProperties: false, properties: { z: { type: "boolean" } } } });
  assert.deepEqual(mismatches(unknownShape), []);
  const propertiesOnly = typed([toolNode("write_file", { path: "a", content: { $ref: "input.s" } })], {}, {});
  assert.deepEqual(mismatches(propertiesOnly, { tools: [{ name: "write_file", parameters: { properties: { content: { properties: { a: {} } } } }, retrySafe: false }] }), [],
    "a schema with only properties accepts a string");
  const lastIsNullFirst = typed([{ id: "lp", kind: "loop", maxIterations: 2, until: { truthy: true },
    run: { id: "body", kind: "sequence", steps: [{ id: "probe", kind: "tool", tool: "nulls", args: { v: { $ref: "loop.lp.last" } } }, leaf("w")] } }], {});
  assert.deepEqual(mismatches(lastIsNullFirst, { tools: [{ name: "nulls", parameters: { type: "object", properties: { v: { type: "null" } } }, retrySafe: true }] }), [],
    "loop.<id>.last is null in the first iteration");
});

test("a reference with a default that may be missing gives no shape to the map items or to a branch's on", () => {
  const each = (over: Expr): WorkflowDocument => typed([{ id: "m", kind: "map", over, as: "item", concurrency: 1, maxItems: 5,
    run: toolNode("count", { n: { $ref: "vars.item" } }) }], {}, { Input: { ...IN, properties: { ...IN.properties, tags: { type: "array", items: { type: "string" } } } } });
  assert.deepEqual(mismatches(each({ $ref: "input.tags" }), { tools: ruleTools }),
    [["$.root.steps[0].run.args.n", `argument does not fit tool "count": is string, but expected integer`]]);
  assert.deepEqual(mismatches(each({ $ref: "input.tags", default: [1, 2] }), { tools: ruleTools }), []);
  const route = (on: Expr): WorkflowDocument => typed([{ id: "b", kind: "branch", on, cases: [{ when: 5, run: leaf("x") }] }], {});
  assert.deepEqual(mismatches(route({ $ref: "input.s" })).map(([path]) => path), ["$.root.steps[0].cases[0].when"]);
  assert.deepEqual(mismatches(route({ $ref: "input.maybe", default: 5 })), [], "input.maybe is optional, so on may be the default");
  assert.deepEqual(mismatches(route({ $ref: "input.s", default: 5 })).map(([path]) => path), ["$.root.steps[0].cases[0].when"],
    "input.s is required, so on is always the string");
});

test("the decision fallback, map over and literal checks keep their messages", () => {
  const decide = (value: Expr): WorkflowNode => ({ id: "d", kind: "decide", question: "q", decision: { type: "yes_no" },
    lowConfidence: { below: 0.5, run: leaf("w"), value } });
  assert.deepEqual(mismatches(typed([decide({ $ref: "fallback.answer" })], {})),
    [["$.root.steps[0].lowConfidence.value", "the fallback value does not fit the yes_no decision: is string, but expected boolean"]]);
  assert.deepEqual(mismatches(typed([decide("yes")], {})), [["$.root.steps[0].lowConfidence.value", "the fallback value does not fit the yes_no decision"]]);
  const over = (value: Expr): WorkflowDocument => typed([{ id: "m", kind: "map", over: value, as: "i", concurrency: 1, maxItems: 2, run: leaf("f") }], {});
  assert.deepEqual(mismatches(over({ $ref: "input.s" })), [["$.root.steps[0].over", `"over" must be an array: is string, but expected array`]]);
  assert.deepEqual(mismatches(over({ a: { $ref: "input.s" } })), [["$.root.steps[0].over", `"over" must be an array: is an object, but expected array`]]);
  assert.deepEqual(mismatches(over("x")), [["$.root.steps[0].over", `"over" must be an array: expected array, got string`]]);
  assert.deepEqual(mismatches(over({ $ref: "input.open" })), []);
});

test("savedAs: a call to the storage name is a call to the document being validated", () => {
  const calling = (name: string, target: string): WorkflowDocument => ({ ...withSteps([{ id: "c", kind: "call", workflow: target, input: { ticket: "t" } }]), name });
  const stale = calling("saved", "x");
  const resolveWorkflow = (name: string): WorkflowDocument | null => (name === "saved" ? stale : name === "b" ? calling("b", "saved") : null);
  const self = only(calling("different", "saved"), "call_cycle", { savedAs: "saved", resolveWorkflow });
  assert.match(self.message, /saved -> saved/);
  assert.equal(self.path, "$.root.steps[0].workflow");
  assert.match(only(calling("different", "b"), "call_cycle", { savedAs: "saved", resolveWorkflow }).message, /saved -> b -> saved/);
  const byName = validateWorkflow(calling("different", "different"), { savedAs: "saved", resolveWorkflow });
  assert.deepEqual(byName.problems.filter((p) => p.code === "call_cycle"), []);
  assert.deepEqual(byName.problems.filter((p) => p.code === "unknown_workflow").map((p) => [p.path, p.severity]), [["$.root.steps[0].workflow", "error"]]);
  const resolved = validateWorkflow(calling("different", "different"), { savedAs: "saved", resolveWorkflow: (name) => (name === "different" ? example() : null) });
  assert.equal(resolved.ok, true, JSON.stringify(resolved.problems));
  assert.match(only(calling("a", "a"), "call_cycle").message, /a -> a/, "without savedAs the document's name is used");
});

test("savedAs has three values: a storage name, null (no identity) and absent (the document's name)", () => {
  const calling = (name: string, target: string): WorkflowDocument => ({ ...withSteps([{ id: "c", kind: "call", workflow: target, input: { ticket: "t" } }]), name });
  const helper = example();
  const resolveWorkflow = (name: string): WorkflowDocument | null => (name === "helper" ? helper : null);
  const cycles = (document: WorkflowDocument, options: ValidateOptions): string[] =>
    validateWorkflow(document, options).problems.filter((p) => p.code === "call_cycle").map((p) => p.message);
  // Saved as main, named helper, calling the saved helper: the storage name decides, so there is no cycle.
  const main = calling("helper", "helper");
  assert.deepEqual(cycles(main, { savedAs: "main", resolveWorkflow }), []);
  assert.equal(validateWorkflow(main, { savedAs: "main", resolveWorkflow }).ok, true);
  // null: no identity, the call resolves to the saved helper.
  assert.deepEqual(cycles(main, { savedAs: null, resolveWorkflow }), []);
  assert.equal(validateWorkflow(main, { savedAs: null, resolveWorkflow }).ok, true);
  // absent: the document's own name is its identity, so the call is to itself.
  assert.deepEqual(cycles(main, { resolveWorkflow }), ["call nodes form a cycle: helper -> helper"]);
  // A string identity that is called is a cycle, labelled with the storage name; with null the label is the name.
  assert.deepEqual(cycles(calling("x", "loop"), { savedAs: "loop" }), ["call nodes form a cycle: loop -> loop"]);
  const back = (name: string): WorkflowDocument | null => (name === "b" ? calling("b", "named") : null);
  assert.deepEqual(cycles(calling("named", "b"), { savedAs: null, resolveWorkflow: back }), []);
  assert.deepEqual(cycles(calling("named", "b"), { resolveWorkflow: back }), ["call nodes form a cycle: named -> b -> named"]);
});

test("dryRunWorkflow(doc, {savedAs}) agrees with validateWorkflow(doc, {savedAs})", () => {
  const helper: WorkflowDocument = { ...example(), name: "helper" };
  const resolveWorkflow = (name: string): WorkflowDocument | null => (name === "helper" ? helper : null);
  const calling = (name: string, target: string): WorkflowDocument => ({ ...withSteps([{ id: "c", kind: "call", workflow: target, input: { ticket: "t" } }]), name });
  const documents = [calling("helper", "helper"), calling("x", "x"), calling("loop", "helper")];
  for (const document of documents) {
    for (const savedAs of ["main", "x", null, undefined]) {
      const options = { resolveWorkflow, ...(savedAs === undefined ? {} : { savedAs }) };
      const validation = validateWorkflow(document, options);
      const report = dryRunWorkflow(document, options);
      const label = `${document.name} saved as ${String(savedAs)}`;
      assert.deepEqual(report.problems.filter((p) => p.code === "call_cycle"), validation.problems.filter((p) => p.code === "call_cycle"), label);
      if (!validation.ok) assert.equal(report.ok, false, label);
      else assert.equal(report.ok, true, `${label}: ${JSON.stringify(report.problems)}`);
    }
  }
});

test("numeric bounds: loop.maxIterations, map.maxItems, agent.maxTurns, score min and max, lowConfidence.below", () => {
  const codes = (node: WorkflowNode, code: string): string[] =>
    validateWorkflow(withSteps([node])).problems.filter((p) => p.code === code).map((p) => p.path);
  const loop = (maxIterations: unknown): WorkflowNode => ({ id: "l", kind: "loop", maxIterations, until: { truthy: true }, run: leaf("x") }) as unknown as WorkflowNode;
  const map = (maxItems: unknown): WorkflowNode => ({ id: "m", kind: "map", over: [], as: "i", concurrency: 1, maxItems, run: leaf("x") }) as unknown as WorkflowNode;
  const agent = (maxTurns: unknown): WorkflowNode => ({ id: "a", kind: "agent", message: "m", maxTurns }) as unknown as WorkflowNode;
  for (const ok of [1, 1000000]) assert.deepEqual(codes(loop(ok), "missing_bound"), [], `loop ${ok}`);
  for (const bad of [-1, 1000001, 1.5, Infinity]) assert.deepEqual(codes(loop(bad), "missing_bound"), ["$.root.steps[0].maxIterations"], `loop ${bad}`);
  assert.match(only(withSteps([loop(1000001)]), "missing_bound").message, /from 0 to 1000000/);
  for (const ok of [1, 1000000]) assert.deepEqual(codes(map(ok), "missing_bound"), [], `map ${ok}`);
  for (const bad of [-1, 1000001, NaN]) assert.deepEqual(codes(map(bad), "missing_bound"), ["$.root.steps[0].maxItems"], `map ${bad}`);
  assert.match(only(withSteps([map(1000001)]), "missing_bound").message, /from 0 to 1000000/);
  for (const ok of [1, 10000]) assert.deepEqual(codes(agent(ok), "missing_bound"), [], `agent ${ok}`);
  for (const bad of [0, 10001, Infinity]) assert.deepEqual(codes(agent(bad), "missing_bound"), ["$.root.steps[0].maxTurns"], `agent ${bad}`);
  assert.match(only(withSteps([agent(10001)]), "missing_bound").message, /from 1 to 10000/);
  const score = (min: unknown, max: unknown): WorkflowNode => ({ id: "d", kind: "decide", question: "q", decision: { type: "score", min, max } }) as unknown as WorkflowNode;
  assert.deepEqual(codes(score(-1e9, 1e9), "shape"), []);
  for (const [min, max] of [[NaN, 1], [0, NaN], [-Infinity, 1], [0, Infinity]]) {
    assert.deepEqual(codes(score(min, max), "shape"), ["$.root.steps[0].decision"], `${min} ${max}`);
  }
  const below = (value: unknown): WorkflowNode => ({ id: "d", kind: "decide", question: "q", decision: { type: "yes_no" }, lowConfidence: { below: value, run: leaf("w") } }) as unknown as WorkflowNode;
  assert.deepEqual(validateWorkflow(withSteps([below(1)])).ok, true);
  assert.deepEqual(validateWorkflow(withSteps([below(Number.MIN_VALUE)])).ok, true);
  assert.deepEqual(codes(below(NaN), "shape"), ["$.root.steps[0].lowConfidence.below"]);
  assert.deepEqual(codes(below(Infinity), "shape"), ["$.root.steps[0].lowConfidence.below"]);
  assert.deepEqual(codes(below(0), "schema_mismatch"), ["$.root.steps[0].lowConfidence.below"]);
  assert.deepEqual(codes(below(1.0000001), "schema_mismatch"), ["$.root.steps[0].lowConfidence.below"]);
});

// ---- R14D-workflow-01: `args` is a map of argument expressions (plan 2.6) ----

const ARGS_MESSAGE = "`args` must be an object of argument expressions, not a reference or a literal form";

/** A document whose step `t` (at `$.root.steps[1]`) is a tool node with the given `args`, after a wait node `w`, beside a parallel sibling `p`. */
function argsDoc(args: unknown): WorkflowDocument {
  return withSteps([
    { id: "w", kind: "wait", question: "q" },
    { id: "t", kind: "tool", tool: "web_fetch", args } as unknown as WorkflowNode,
    { id: "later", kind: "wait", question: "q" },
    { id: "par", kind: "parallel", branches: [{ id: "p", kind: "wait", question: "q" }, { id: "q", kind: "wait", question: "q" }] },
  ]);
}

test("a reference or literal form in place of a tool node's args is one shape error at the args path", () => {
  const forms: unknown[] = [
    { $ref: "steps.missing" }, { $ref: "steps.w" }, { $ref: "steps.later" }, { $ref: "steps.p" }, { $ref: "input" },
    { $ref: "steps.w", default: { url: "u" } }, { $literal: { url: "u" } }, { $ref: 7 }, { $ref: "steps.w", url: "u" },
    { $literal: { url: "u" }, extra: 1 },
  ];
  for (const args of forms) {
    for (const options of [undefined, { tools }] as const) {
      const report = validateWorkflow(argsDoc(args), options);
      const errors = report.problems.filter((p) => p.severity === "error");
      assert.deepEqual(errors.map((p) => [p.path, p.code, p.message, p.nodeId]), [["$.root.steps[1].args", "shape", ARGS_MESSAGE, "t"]],
        `${JSON.stringify(args)} ${options === undefined ? "" : "with tools"}`);
      assert.equal(report.ok, false);
    }
  }
});

test("an argument that is a reference is checked as an argument, as before", () => {
  const missing = only(argsDoc({ url: { $ref: "steps.missing" } }), "unknown_reference");
  assert.equal(missing.path, "$.root.steps[1].args.url");
  const later = only(argsDoc({ url: { $ref: "steps.later.answer" } }), "unknown_reference");
  assert.equal(later.path, "$.root.steps[1].args.url");
  assert.deepEqual(validateWorkflow(argsDoc({ url: { $ref: "steps.w.answer" } }), { tools }).problems, []);
  assert.deepEqual(validateWorkflow(argsDoc({ url: { $literal: "{{not a template}}" } }), { tools }).problems, []);
  const named = validateWorkflow(argsDoc({ url: "u", default: 1 }), { tools });
  assert.deepEqual(named.problems.map((p) => [p.path, p.code]), [["$.root.steps[1].args.default", "schema_mismatch"]],
    "an argument named default is an argument (and web_fetch has no such parameter)");
});

test("the dry run reports the args form and walks nothing", () => {
  const report = dryRunWorkflow(argsDoc({ $ref: "steps.w" }));
  assert.equal(report.ok, false);
  assert.deepEqual(report.steps, []);
  assert.deepEqual(report.problems.filter((p) => p.severity === "error").map((p) => [p.path, p.code]), [["$.root.steps[1].args", "shape"]]);
});
