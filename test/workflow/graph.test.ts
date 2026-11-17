import { test } from "node:test";
import assert from "node:assert/strict";
import { toGraph, toMermaid } from "../../src/workflow/graph.ts";
import type { WorkflowDocument } from "../../src/workflow/types.ts";

const everyKind: WorkflowDocument = {
  format: "runwright.workflow/v1",
  name: "all",
  schemas: { In: { type: "object" }, Out: { type: "object" } },
  input: "In",
  output: "Out",
  root: { id: "main", kind: "sequence", steps: [
    { id: "fetch", kind: "tool", tool: "web_fetch", args: {} },
    { id: "summ", kind: "model", prompt: "x", output: "Out" },
    { id: "ok", kind: "decide", question: "q", decision: { type: "yes_no" },
      lowConfidence: { below: 0.5, run: { id: "ask", kind: "wait", question: "?" } } },
    { id: "route", kind: "branch", on: { $ref: "steps.ok.value" },
      cases: [{ when: true, run: { id: "par", kind: "parallel", branches: [{ id: "p1", kind: "fail", message: "m" }] } }],
      default: { id: "fix", kind: "agent", message: "m", maxTurns: 2 } },
    { id: "each", kind: "map", over: [], as: "item", concurrency: 1, maxItems: 3, run: { id: "body", kind: "call", workflow: "sub", input: null } },
    { id: "again", kind: "loop", maxIterations: 2, until: { truthy: true }, run: { id: "again_body", kind: "call", workflow: "sub", input: null } },
  ] },
  result: {},
};

test("graph nodes and edges for every kind", () => {
  const graph = toGraph(everyKind);
  assert.deepEqual(graph.nodes.map((n) => n.id), ["main", "fetch", "summ", "ok", "ask", "route", "par", "p1", "fix", "each", "body", "workflow:sub", "again", "again_body"]);
  assert.equal(graph.nodes.find((n) => n.id === "fetch")?.label, "tool: fetch (web_fetch)");
  const has = (from: string, to: string, kind: string, label: string | null) =>
    assert.ok(graph.edges.some((e) => e.from === from && e.to === to && e.kind === kind && e.label === label), `${from} ${kind} ${to}`);
  has("main", "fetch", "contains", null);
  has("fetch", "summ", "next", null);
  has("ok", "ask", "low_confidence", "< 0.5");
  has("route", "par", "case", "true");
  has("route", "fix", "default", null);
  has("par", "p1", "contains", null);
  has("each", "body", "contains", "each item");
  has("body", "workflow:sub", "call", null);
  has("again_body", "workflow:sub", "call", null);
  assert.equal(graph.nodes.filter((n) => n.id === "workflow:sub").length, 1);
});

test("mermaid output neutralises hostile labels", () => {
  const hostile = '"] --> evil["x"]\n</script><script>alert(1)</script> `tick` & |pipe| {b} (p);';
  const doc: WorkflowDocument = { ...everyKind, root: { id: "main", kind: "sequence", title: hostile, steps: [{ id: "f", kind: "fail", message: "m" }] } };
  const text = toMermaid(toGraph(doc));
  assert.ok(text.startsWith("flowchart TD\n"));
  assert.ok(!text.includes("</script>"));
  assert.ok(!text.includes("<script>"));
  const labelLine = text.split("\n").find((line) => line.includes("n_main[")) as string;
  const inner = labelLine.slice(labelLine.indexOf('["') + 2, labelLine.lastIndexOf('"]'));
  for (const bad of ['"', "<", ">", "`", "|", "[", "]", "\n"]) assert.ok(!inner.includes(bad), `label still has ${JSON.stringify(bad)}`);
  assert.ok(!inner.includes("-->") || !/[\["]/.test(inner));
  assert.equal(text.split("\n").filter((l) => l.includes("evil")).length, 1);
});
