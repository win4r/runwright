import { test } from "node:test";
import assert from "node:assert/strict";
import { isRunwrightError } from "../../src/core/errors.ts";
import { literal, node, ref, tpl, workflow, type NodeOptions } from "../../src/workflow/builder.ts";
import type { SequenceNode } from "../../src/workflow/types.ts";
import { validateWorkflow } from "../../src/workflow/validate.ts";

const handWritten = {
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

test("builder output equals the hand-written plan example and validates", () => {
  const built = workflow("triage")
    .describe("Classify a ticket; unsure ones go to an agent")
    .input("Input", { type: "object", required: ["ticket"], properties: { ticket: { type: "string" } } })
    .output("Output", { type: "object", required: ["urgent"], properties: { urgent: { type: "boolean" } } })
    .root(node.sequence("main",
      node.decide("urgent", {
        question: `Is this urgent?\n${tpl("input.ticket")}`,
        decision: { type: "yes_no" },
        lowConfidence: { below: 0.7, run: node.agent("review", { message: "Decide urgency: {{input.ticket}}", maxTurns: 4, output: "Output" }), value: ref("fallback.data.urgent") },
      })))
    .result({ urgent: ref("steps.urgent.value") })
    .build();
  assert.deepEqual(built, handWritten);
  assert.equal(validateWorkflow(built).ok, true);
});

test("helpers produce plain JSON", () => {
  assert.deepEqual(ref("input.x", 0), { $ref: "input.x", default: 0 });
  assert.deepEqual(literal({ $ref: "no" }), { $literal: { $ref: "no" } });
  assert.deepEqual(node.wait("w", "q"), { id: "w", kind: "wait", question: "q" });
  assert.deepEqual(node.branch("b", true, []), { id: "b", kind: "branch", on: true, cases: [] });
  assert.deepEqual(node.tool("t", "web_fetch", { url: "u" }, { idempotent: true }), { id: "t", kind: "tool", tool: "web_fetch", args: { url: "u" }, idempotent: true });
});

test("build() throws workflow_invalid with problems", () => {
  try {
    workflow("bad").input("In", { type: "object" }).output("Out", { type: "object" })
      .root(node.sequence("main", node.fail("stop", "x"), node.wait("never", "q"))).result({}).build();
    assert.fail("expected build to throw");
  } catch (error) {
    assert.ok(isRunwrightError(error));
    assert.equal(error.code, "workflow_invalid");
    const problems = error.details?.["problems"] as { code: string }[];
    assert.ok(problems.some((p) => p.code === "unreachable"));
  }
});

test("every node builder accepts deadlineMs and passes it through", () => {
  const leaf = node.tool("leaf", "probe", {});
  assert.deepEqual(node.sequence("s", { deadlineMs: 100 }, leaf), { id: "s", kind: "sequence", deadlineMs: 100, steps: [leaf] });
  assert.deepEqual(node.parallel("p", { deadlineMs: 200, title: "Fan out" }, leaf),
    { id: "p", kind: "parallel", title: "Fan out", deadlineMs: 200, branches: [leaf] });
  assert.deepEqual(node.branch("b", true, [{ when: true, run: leaf }], undefined, { deadlineMs: 300 }),
    { id: "b", kind: "branch", deadlineMs: 300, on: true, cases: [{ when: true, run: leaf }] });
  assert.deepEqual(node.call("c", "sub", {}, { deadlineMs: 400 }), { id: "c", kind: "call", deadlineMs: 400, workflow: "sub", input: {} });
  assert.deepEqual(node.wait("w", "q", undefined, { deadlineMs: 500 }), { id: "w", kind: "wait", deadlineMs: 500, question: "q" });
  assert.deepEqual(node.fail("f", "no", { deadlineMs: 600 }), { id: "f", kind: "fail", deadlineMs: 600, message: "no" });
  assert.equal(node.map("m", { over: [], as: "x", concurrency: 1, maxItems: 1, run: leaf, deadlineMs: 700 }).deadlineMs, 700);
  assert.equal(node.loop("l", { maxIterations: 1, until: { truthy: true }, run: leaf, deadlineMs: 800 }).deadlineMs, 800);
  assert.equal(node.agent("a", { message: "m", maxTurns: 1, deadlineMs: 900 }).deadlineMs, 900);
  assert.equal(node.tool("t", "probe", {}, { deadlineMs: 1000 }).deadlineMs, 1000);
  assert.equal(node.model("mo", { prompt: "p", output: "Out", deadlineMs: 1100 }).deadlineMs, 1100);
  assert.equal(node.decide("d", { question: "q", decision: { type: "yes_no" }, deadlineMs: 1200 }).deadlineMs, 1200);
});

test("without options the builders give the same nodes as before, and a leading node is never read as options", () => {
  const a = node.tool("a", "probe", {});
  const b = node.tool("b", "probe", {});
  assert.deepEqual(node.sequence("s", a, b), { id: "s", kind: "sequence", steps: [a, b] });
  assert.deepEqual(node.parallel("p", a), { id: "p", kind: "parallel", branches: [a] });
  assert.deepEqual(node.sequence("empty"), { id: "empty", kind: "sequence", steps: [] });
  assert.deepEqual(node.call("c", "sub", {}), { id: "c", kind: "call", workflow: "sub", input: {} });
  assert.deepEqual(node.fail("f", "no"), { id: "f", kind: "fail", message: "no" });
  assert.equal(Object.hasOwn(node.wait("w", "q", ["y"], {}), "deadlineMs"), false);
});

test("a built document with deadlines on every kind validates, with the warning on fail only", () => {
  const built = workflow("bounded")
    .input("In", { type: "object" }).output("Out", {})
    .sub("sub", workflow("sub").input("In", { type: "object" }).output("Out", {}).root(node.tool("inner", "probe", {})).result(null).build())
    .root(node.sequence("main", { deadlineMs: 5000 },
      node.parallel("fan", { deadlineMs: 4000 }, node.tool("one", "probe", {}, { deadlineMs: 100 })),
      node.branch("pick", true, [{ when: true, run: node.call("nested", "sub", {}, { deadlineMs: 3000 }) }], undefined, { deadlineMs: 3500 }),
      node.map("each", { over: [1], as: "x", concurrency: 1, maxItems: 1, run: node.tool("two", "probe", {}), deadlineMs: 2000 }),
      node.loop("again", { maxIterations: 1, until: { truthy: true }, run: node.tool("three", "probe", {}), deadlineMs: 2000 }),
      node.agent("helper", { message: "hi", maxTurns: 1, deadlineMs: 2000 }),
      node.wait("ask", "ok?", undefined, { deadlineMs: 10 }),
      node.fail("stop", "done", { deadlineMs: 10 })))
    .result(null)
    .build();
  const problems = validateWorkflow(built).problems.filter((p) => p.code === "bad_deadline");
  assert.deepEqual(problems.map((p) => [p.severity, p.nodeId, p.message]), [["warning", "stop", '"deadlineMs" has no effect on a fail node']]);
  assert.equal((built.root as { steps: { id: string; deadlineMs?: number }[] }).steps.find((s) => s.id === "ask")?.deadlineMs, 10, "the wait node keeps its deadline");
});

test("the builder's types: deadlineMs on every kind, retry only where the kind has it", () => {
  const options: NodeOptions = { deadlineMs: 1, title: "t" };
  const leaf = node.tool("leaf", "probe", {}, { retry: { maxAttempts: 2, backoffMs: 0 } });
  // @ts-expect-error retry is not a sequence option
  node.sequence("s", { retry: { maxAttempts: 2, backoffMs: 0 } }, leaf);
  // @ts-expect-error retry is not a call option
  node.call("c", "sub", {}, { retry: { maxAttempts: 2, backoffMs: 0 } });
  // @ts-expect-error retry is not a map option
  node.map("m", { over: [], as: "x", concurrency: 1, maxItems: 1, run: leaf, retry: { maxAttempts: 2, backoffMs: 0 } });
  // @ts-expect-error deadlineMs is a number of milliseconds
  node.wait("w", "q", undefined, { deadlineMs: "soon" });
  const typed: SequenceNode = node.sequence("s", options, leaf);
  assert.equal(typed.deadlineMs, 1);
});

test("a tool node's args is a map of argument expressions: a reference or literal form in its place is a type error", () => {
  const map = node.tool("t", "web_fetch", { url: ref("input.url"), note: literal({ $ref: "kept" }) });
  assert.deepEqual(map.args, { url: { $ref: "input.url" }, note: { $literal: { $ref: "kept" } } });
  // @ts-expect-error a reference in place of the argument map
  const whole = node.tool("t", "web_fetch", ref("steps.fetch"));
  // @ts-expect-error a literal form in place of the argument map
  const fixed = node.tool("t", "web_fetch", literal({ url: "u" }));
  const built = (args: unknown): boolean => {
    try {
      workflow("w").input("In", { type: "object" }).output("Out", {}).root(node.sequence("main", { id: "t", kind: "tool", tool: "web_fetch", args } as never))
        .result(null).build();
      return true;
    } catch (error) {
      assert.ok(isRunwrightError(error) && error.code === "workflow_invalid", String(error));
      return false;
    }
  };
  assert.equal(built(whole.args), false);
  assert.equal(built(fixed.args), false);
  assert.equal(built(map.args), true);
});
