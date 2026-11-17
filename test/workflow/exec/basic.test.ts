import { test } from "node:test";
import assert from "node:assert/strict";
import { isRunwrightError } from "../../../src/core/errors.ts";
import type { RunContext } from "../../../src/engine/types.ts";
import type { WorkflowDocument } from "../../../src/workflow/types.ts";
import { asObject, doc, duplicateFinishes, nodeFinished, setupWorkflow } from "./helpers.ts";

const inner: WorkflowDocument = {
  format: "runwright.workflow/v1",
  name: "inner",
  schemas: { In: { type: "object", required: ["n"], properties: { n: { type: "string" } } }, Out: { type: "string" } },
  input: "In",
  output: "Out",
  root: { id: "inner_tool", kind: "tool", tool: "count", args: { label: "inner", value: "inner:{{input.n}}" } },
  result: { $ref: "steps.inner_tool.data" },
};

const everything: WorkflowDocument = {
  format: "runwright.workflow/v1",
  name: "everything",
  schemas: {
    Input: {
      type: "object", required: ["ticket", "items"],
      properties: { ticket: { type: "string" }, items: { type: "array", items: { type: "string" } } },
    },
    Summary: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
    Review: { type: "object" },
    Output: { type: "object", required: ["first", "summary", "urgent"] },
  },
  input: "Input",
  output: "Output",
  workflows: { inner },
  root: {
    id: "main", kind: "sequence", steps: [
      { id: "first", kind: "tool", tool: "count", args: { label: "first", value: { $ref: "input.ticket" } } },
      { id: "summary", kind: "model", prompt: "Summarize {{input.ticket}}", output: "Summary" },
      {
        id: "urgent", kind: "decide", question: "Is {{input.ticket}} urgent?", decision: { type: "yes_no" },
        lowConfidence: {
          below: 0.7,
          run: { id: "review", kind: "agent", message: "Review {{input.ticket}}", maxTurns: 2, output: "Review" },
          value: { $ref: "fallback.data.urgent" },
        },
      },
      {
        id: "route", kind: "branch", on: { $ref: "steps.urgent.value" }, cases: [
          { when: true, run: { id: "page", kind: "tool", tool: "count", args: { label: "page" } } },
          { when: false, run: { id: "queue", kind: "tool", tool: "count", args: { label: "queue" } } },
        ],
      },
      {
        id: "both", kind: "parallel", branches: [
          { id: "pa", kind: "tool", tool: "count", args: { label: "pa" } },
          { id: "pb", kind: "model", prompt: "pb", output: "Summary" },
        ],
      },
      {
        id: "each", kind: "map", over: { $ref: "input.items" }, as: "item", concurrency: 2, maxItems: 10,
        run: { id: "one", kind: "tool", tool: "count", args: { label: "item-{{vars.item}}", value: { $ref: "vars.item_index" } } },
      },
      {
        id: "spin", kind: "loop", maxIterations: 5, until: { gte: [{ $ref: "loop.spin.index" }, 1] },
        run: { id: "turn", kind: "tool", tool: "probe", args: { label: "spin-{{loop.spin.index}}" } },
      },
      { id: "sub", kind: "call", workflow: "inner", input: { n: { $ref: "input.ticket" } } },
      { id: "confirm", kind: "wait", question: "Ship {{input.ticket}}?", choices: ["yes", "no"] },
    ],
  },
  result: {
    first: { $ref: "steps.first.data" },
    summary: { $ref: "steps.summary.text" },
    urgent: { $ref: "steps.urgent.value" },
    route: { $ref: "steps.route.content" },
    both: { $ref: "steps.both.pb.text" },
    each: { $ref: "steps.each" },
    spin: { $ref: "steps.spin.iterations" },
    sub: { $ref: "steps.sub" },
    confirm: { $ref: "steps.confirm.answer" },
  },
};

const everythingScript = {
  steps: {
    summary: { output: { text: "short: {{first_message}}" } },
    urgent: { output: { value: true, confidence: 0.4, reason: "unsure" } },
    review: { output: { urgent: false } },
    pb: { output: { text: "pb" } },
  },
};

test("a document using every node kind runs to the expected output and journals every node", async (t) => {
  const s = await setupWorkflow(t);
  const agentId = await s.agent({ workflow: everything, script: everythingScript });
  const started = await s.h.start(agentId, { data: { ticket: "T-1", items: ["a", "b", "c"] } });
  await s.h.until(started.id, "waiting");
  const [pending] = await s.h.pendings(started.id);
  assert.equal(pending?.kind, "question");
  assert.equal(pending?.detail["question"], "Ship T-1?");
  await s.h.send(started.id, { type: "answer", pendingId: pending?.id ?? "", answer: "yes" });
  const done = await s.h.until(started.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));

  const output = asObject(done.output);
  assert.equal(output["first"], "T-1");
  assert.equal(output["summary"], "short: Summarize T-1");
  assert.equal(output["urgent"], false);
  assert.equal(output["route"], "queue");
  assert.equal(output["both"], "pb");
  assert.deepEqual(output["each"], [
    { ok: true, content: "item-a", data: 0 },
    { ok: true, content: "item-b", data: 1 },
    { ok: true, content: "item-c", data: 2 },
  ]);
  assert.equal(output["spin"], 2);
  assert.equal(output["sub"], "inner:T-1");
  assert.equal(output["confirm"], "yes");

  assert.equal(s.counters.get("count", "page"), 0);
  assert.equal(s.counters.get("count", "queue"), 1);
  assert.equal(s.counters.get("probe", "spin-0"), 1);
  assert.equal(s.counters.get("probe", "spin-1"), 1);
  assert.equal(s.counters.get("probe", "spin-2"), 0);

  const journal = await s.h.journal(started.id);
  const finished = nodeFinished(journal);
  const keys = new Set(finished.map((f) => f.key));
  for (const key of [
    "wf/main", "wf/first", "wf/summary", "wf/urgent", "wf/review", "wf/route", "wf/queue", "wf/both", "wf/pa", "wf/pb",
    "wf/each", "wf/each[0]/one", "wf/each[2]/one", "wf/spin", "wf/spin#0/turn", "wf/spin#1/turn", "wf/sub",
    "wf/sub>/inner_tool", "wf/confirm",
  ]) {
    assert.ok(keys.has(key), `missing node.finished ${key}`);
  }
  assert.deepEqual(duplicateFinishes(journal), []);
  const startedMap = journal.find((r) => r.type === "node.started" && r.key === "wf/each[1]/one");
  assert.deepEqual({ kind: startedMap?.data["kind"], scope: startedMap?.data["scope"] }, { kind: "tool", scope: "each[1]/" });

  const urgent = asObject(finished.find((f) => f.name === "urgent")?.value);
  assert.equal(urgent["route"], "low_confidence");
  assert.equal(urgent["confidence"], 0.4);
  assert.deepEqual(asObject(urgent["fallback"])["data"], { urgent: false });

  const decisionCall = journal.find((r) => r.type === "model.started" && r.key === "wf/urgent#1");
  assert.equal(decisionCall?.data["purpose"], "decision");
  const stepCall = journal.find((r) => r.type === "model.started" && r.key === "wf/summary#1");
  assert.equal(stepCall?.data["purpose"], "step");
  assert.equal(stepCall?.data["countsAsTurn"], true);
});

test("an input that does not match the input schema fails the run with the path", async (t) => {
  const s = await setupWorkflow(t);
  const agentId = await s.agent({ workflow: everything, script: everythingScript });
  const done = await s.run(agentId, { ticket: 5, items: [] });
  assert.equal(done.status, "failed");
  assert.equal(done.error?.code, "validation_failed");
  assert.match(done.error?.message ?? "", /\$\.ticket/);
  assert.equal(s.counters.total("count"), 0);
});

test("a result that does not match the output schema fails the run with the path", async (t) => {
  const s = await setupWorkflow(t);
  const workflow = doc(
    { id: "only", kind: "tool", tool: "count", args: { label: "only" } },
    { x: { $ref: "input.x" } },
    { schemas: { Input: { type: "object" }, Output: { type: "object", properties: { x: { type: "number" } } } } },
  );
  const agentId = await s.agent({ workflow });
  const done = await s.run(agentId, { x: "not a number" });
  assert.equal(done.status, "failed");
  assert.equal(done.error?.code, "workflow_failed");
  assert.match(done.error?.message ?? "", /\$\.x/);
  assert.equal(s.counters.get("count", "only"), 1);
});

test("a fail node fails the run with its rendered message", async (t) => {
  const s = await setupWorkflow(t);
  const workflow = doc({
    id: "main", kind: "sequence", steps: [
      { id: "before", kind: "tool", tool: "count", args: { label: "before" } },
      { id: "stop", kind: "fail", message: "boom because {{input.why}}" },
    ],
  }, null);
  const agentId = await s.agent({ workflow });
  const done = await s.run(agentId, { why: "testing" });
  assert.equal(done.status, "failed");
  assert.equal(done.error?.code, "workflow_failed");
  assert.match(done.error?.message ?? "", /node "stop" failed: boom because testing/);
  assert.equal(s.counters.get("count", "before"), 1);
  const finished = nodeFinished(await s.h.journal(done.id)).map((f) => f.name);
  assert.deepEqual(finished, ["before"]);
});

test("onError continue turns a tool error into an output; without it the node fails with the tool's content", async (t) => {
  const s = await setupWorkflow(t);
  const make = (onError: "continue" | "fail") => doc({
    id: "main", kind: "sequence", steps: [
      { id: "x", kind: "tool", tool: "count", args: { label: `x-${onError}`, failTimes: 1 }, onError },
      { id: "after", kind: "tool", tool: "count", args: { label: `after-${onError}`, value: { $ref: "steps.x.ok" } } },
    ],
  }, { ok: { $ref: "steps.after.data" }, content: { $ref: "steps.x.content" } });

  const continued = await s.run(await s.agent({ workflow: make("continue") }), {});
  assert.equal(continued.status, "completed");
  assert.equal(asObject(continued.output)["ok"], false);
  assert.match(String(asObject(continued.output)["content"]), /x-continue failed on call 1/);

  const failed = await s.run(await s.agent({ workflow: { ...make("fail"), name: "fails" } }), {});
  assert.equal(failed.status, "failed");
  assert.match(failed.error?.message ?? "", /node "x" failed: .*x-fail failed on call 1/);
  assert.equal(s.counters.get("count", "after-fail"), 0);
});

test("an invalid document fails with workflow_invalid and the driver needs a workflow", async (t) => {
  const s = await setupWorkflow(t);
  const workflow = doc({ id: "main", kind: "tool", tool: "no_such_tool", args: {} }, null);
  const done = await s.run(await s.agent({ workflow }), {});
  assert.equal(done.status, "failed");
  assert.equal(done.error?.code, "workflow_invalid");
  assert.match(done.error?.message ?? "", /\$\.root\.tool/);

  const context = { definition: { name: "plain", instructions: "", model: { provider: "scripted", name: "scripted-1" }, tools: [], limits: {}, learning: false } };
  await assert.rejects(s.runtime.driver(context as unknown as RunContext), (error) => isRunwrightError(error) && error.code === "workflow_invalid");
});
