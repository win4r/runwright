/**
 * The execution side of the field table (plan 2.6): for every expression, template and condition field of every
 * node kind, the dry run (given the same input) and a real execution read the field the same way and get the same
 * value. And rule V: a loop whose `until` can never hold ends at its bound in the dry run exactly as it does when
 * it runs; a literal `on` and a decision threshold select what a run selects.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Json, JsonObject } from "../../../src/core/json.ts";
import type { ModelRequest } from "../../../src/models/types.ts";
import { dryRunWorkflow, type DryRunOptions } from "../../../src/workflow/dryrun.ts";
import type { DryRunReport, WorkflowDocument, WorkflowNode } from "../../../src/workflow/types.ts";
import { fakeModels, reply } from "../../helpers/engine.ts";
import { fakeAgentLoop, setupWorkflow } from "./helpers.ts";

const INPUT = { k: "a", n: 1, list: [1, 2] };
const IN_SCHEMA = { type: "object", required: ["k", "n", "list"], properties: { k: { type: "string" }, n: { type: "integer" }, list: { type: "array" } } };

const probe = (id: string, args: JsonObject = {}): WorkflowNode => ({ id, kind: "tool", tool: "probe", args: { label: id, ...args } });

const ECHO: WorkflowDocument = {
  format: "runwright.workflow/v1", name: "echo", schemas: { In: {}, Out: {} }, input: "In", output: "Out", root: probe("echoed"), result: { $ref: "input" },
};

function flow(steps: WorkflowNode[], result: Json): WorkflowDocument {
  return {
    format: "runwright.workflow/v1", name: "fields", schemas: { In: IN_SCHEMA, Out: {}, Any: {} }, input: "In", output: "Out",
    root: { id: "main", kind: "sequence", steps }, result, workflows: { echo: ECHO },
  };
}

/** Every field but `wait.question` and `fail.message` (which end or hold the run), in one document. */
const FIELDS = flow([
  probe("t", { value: { k: { $ref: "input.k" }, text: "t {{input.k}}" } }),
  { id: "m", kind: "model", prompt: "P {{input.k}}", system: "S {{input.n}}", output: "Any" },
  { id: "q", kind: "decide", question: "Q {{input.k}}", decision: { type: "yes_no" } },
  { id: "d", kind: "decide", question: "low", decision: { type: "pick_one", options: ["a", "b"] },
    lowConfidence: { below: 0.5, run: probe("fallback_probe"), value: { $ref: "input.k" } } },
  { id: "b", kind: "branch", on: { $ref: "input.k" }, cases: [{ when: "a", run: probe("ca") }, { when: "b", run: probe("cb") }], default: probe("cd") },
  { id: "e", kind: "map", over: { $ref: "input.list" }, as: "it", concurrency: 1, maxItems: 5, run: probe("each", { value: { $ref: "vars.it" } }) },
  { id: "l", kind: "loop", maxIterations: 5, until: { eq: [{ $ref: "loop.l.index" }, { $ref: "input.n" }] }, run: probe("tick") },
  { id: "c", kind: "call", workflow: "echo", input: { v: { $ref: "input.k" }, s: "c {{input.n}}" } },
  { id: "ag", kind: "agent", message: "M {{input.k}}", instructions: "I {{input.n}}", maxTurns: 1 },
], {
  v: { $ref: "input.k" },
  lowValue: { $ref: "steps.d.value" },
  ranA: { $ref: "steps.ca.ok", default: "no" }, ranB: { $ref: "steps.cb.ok", default: "no" }, ranDefault: { $ref: "steps.cd.ok", default: "no" },
  mapped: { $ref: "steps.e.1.ok" },
  iterations: { $ref: "steps.l.iterations" }, completed: { $ref: "steps.l.completed" },
  called: { $ref: "steps.c" },
});

const DRY_OPTIONS: DryRunOptions = { input: INPUT, decisions: { d: { value: "b", confidence: 0.1 } } };

function dry(document: WorkflowDocument, options: DryRunOptions = DRY_OPTIONS): DryRunReport {
  const report = dryRunWorkflow(document, options);
  assert.deepEqual(report.problems.filter((p) => p.severity === "error"), []);
  return report;
}

function wouldCall(report: DryRunReport, nodeId: string): JsonObject {
  const found = report.wouldCall.filter((call) => call.nodeId === nodeId);
  assert.ok(found.length > 0, `the dry run would call ${nodeId}`);
  return (found[0] as { detail: JsonObject }).detail;
}

/** Answers model steps with `"x"`, decision `q` confidently, decision `d` with low confidence, and agent turns with text. */
function models(requests: ModelRequest[]): ReturnType<typeof fakeModels> {
  return fakeModels((request) => {
    requests.push(request);
    if (request.meta.purpose === "decision") {
      return reply({ output: request.meta.step === "d" ? { value: "b", confidence: 0.1, reason: "" } : { value: true, confidence: 1, reason: "" } });
    }
    if (request.meta.purpose === "step") return reply({ output: "x" });
    return reply({ text: "done" });
  });
}

test("every expression field reads the same value in the dry run and in a real run", async (t) => {
  const requests: ModelRequest[] = [];
  const messages: string[] = [];
  const s = await setupWorkflow(t, { models: models(requests), agentLoop: fakeAgentLoop((message) => messages.push(message)) });
  const run = await s.run(await s.agent({ workflow: FIELDS }), INPUT);
  assert.equal(run.status, "completed", JSON.stringify(run.error));
  const report = dry(FIELDS);
  assert.equal(report.ok, true, JSON.stringify(report.problems));

  // document `result`, `lowConfidence.value`, `branch.on`, `map.over`, `loop.until`, `call.input`: through the result.
  const expected = {
    v: "a", lowValue: "a", ranA: true, ranB: "no", ranDefault: "no", mapped: true, iterations: 2, completed: true, called: { v: "a", s: "c 1" },
  };
  assert.deepEqual(run.output, expected);
  assert.deepEqual(report.output, expected);

  // `tool.args`: the arguments the tool was called with.
  const started = (await s.h.journal(run.id)).filter((r) => r.type === "tool.started").map((r) => r.data["args"] as JsonObject);
  assert.deepEqual(started.find((args) => args["label"] === "t"), wouldCall(report, "t")["args"]);
  assert.deepEqual(wouldCall(report, "t")["args"], { label: "t", value: { k: "a", text: "t a" } });
  assert.deepEqual(started.filter((args) => args["label"] === "each").map((args) => args["value"]),
    report.wouldCall.filter((call) => call.nodeId === "each").map((call) => (call.detail["args"] as JsonObject)["value"]));

  // `model.prompt`, `model.system`, `decide.question`.
  const step = requests.find((r) => r.meta.step === "m" && r.meta.purpose === "step");
  assert.equal(step?.messages[0]?.content, wouldCall(report, "m")["prompt"]);
  assert.equal(step?.system, wouldCall(report, "m")["system"]);
  assert.deepEqual([wouldCall(report, "m")["prompt"], wouldCall(report, "m")["system"]], ["P a", "S 1"]);
  const question = requests.find((r) => r.meta.step === "q")?.messages[0]?.content;
  assert.equal(typeof question === "string" && question.startsWith(`${String(wouldCall(report, "q")["question"])}\n\n`), true, String(question));
  assert.equal(wouldCall(report, "q")["question"], "Q a");

  // `agent.message`, `agent.instructions`.
  assert.deepEqual(messages, [wouldCall(report, "ag")["message"]]);
  assert.equal(requests.find((r) => r.meta.purpose === "run")?.system, wouldCall(report, "ag")["instructions"]);
  assert.deepEqual([wouldCall(report, "ag")["message"], wouldCall(report, "ag")["instructions"]], ["M a", "I 1"]);
});

test("wait.question and fail.message read the same text in the dry run and in a real run", async (t) => {
  const s = await setupWorkflow(t);
  const asking = flow([{ id: "w", kind: "wait", question: "W {{input.k}} {{input.list}}" }], null);
  const held = await s.h.start(await s.agent({ workflow: asking }), { data: INPUT });
  await s.h.until(held.id, "waiting");
  const [pending] = await s.h.pendings(held.id);
  assert.equal(pending?.detail["question"], wouldCall(dry(asking), "w")["question"]);
  assert.equal(pending?.detail["question"], "W a [1,2]");

  const failing = flow([{ id: "f", kind: "fail", message: "F {{input.k}}" }], null);
  const failed = await s.run(await s.agent({ workflow: failing }), INPUT);
  assert.equal(failed.status, "failed");
  const report = dry(failing);
  assert.equal(report.steps.at(-1)?.note, "would fail: F a");
  assert.match(failed.error?.message ?? "", /node "f" failed: F a$/);
});

test("a loop whose until can never hold ends at its bound in the dry run as it does in a real run", async (t) => {
  const s = await setupWorkflow(t);
  const never = { and: [{ ne: [1, 1] }, { truthy: { $ref: "input.k" } }] };
  const loop = (onLimit: "fail" | "continue"): WorkflowDocument => flow([
    { id: "l", kind: "loop", maxIterations: 2, onLimit, until: never, run: probe("tick") } as WorkflowNode,
  ], { iterations: { $ref: "steps.l.iterations" }, completed: { $ref: "steps.l.completed" } });

  const continued = await s.run(await s.agent({ workflow: loop("continue") }), INPUT);
  assert.equal(continued.status, "completed", JSON.stringify(continued.error));
  assert.deepEqual(continued.output, { iterations: 2, completed: false });
  for (const options of [{}, { input: INPUT }]) {
    const report = dryRunWorkflow(loop("continue"), options);
    assert.equal(report.ok, true);
    assert.deepEqual(report.output, continued.output, JSON.stringify(options));
  }

  const failed = await s.run(await s.agent({ workflow: loop("fail") }), INPUT);
  assert.equal(failed.status, "failed");
  assert.match(failed.error?.message ?? "", /the loop reached maxIterations 2 before "until" held/);
  for (const options of [{}, { input: INPUT }]) {
    const report = dryRunWorkflow(loop("fail"), options);
    assert.equal(report.ok, false, JSON.stringify(options));
    assert.equal(report.steps.find((step) => step.nodeId === "l")?.note, "would fail: reached maxIterations 2");
  }
});

test("a decision exactly at its threshold is confident in the dry run and in a real run", async (t) => {
  const s = await setupWorkflow(t, {
    models: fakeModels(() => reply({ output: { value: true, confidence: 0.5, reason: "" } })),
  });
  const document = flow([{ id: "d", kind: "decide", question: "q", decision: { type: "yes_no" }, lowConfidence: { below: 0.5, run: probe("low") } }],
    { $ref: "steps.d.route" });
  const run = await s.run(await s.agent({ workflow: document }), INPUT);
  assert.equal(run.output, "confident");
  assert.equal(dry(document, { input: INPUT, decisions: { d: { value: true, confidence: 0.5 } } }).output, "confident");
  assert.equal(dry(document, { input: INPUT, decisions: { d: { value: true, confidence: 0.49 } } }).output, "low_confidence");
});
