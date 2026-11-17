import { test } from "node:test";
import assert from "node:assert/strict";
import type { Json } from "../../../src/core/json.ts";
import type { DecisionSpec, WorkflowDocument, WorkflowNode } from "../../../src/workflow/types.ts";
import { asObject, doc, fakeAgentLoop, setupWorkflow } from "./helpers.ts";

const schemas = { Input: { type: "object" }, Review: { type: "object" }, Output: {} };

function decideDoc(decision: DecisionSpec, fallback: WorkflowNode, value: Json): WorkflowDocument {
  return doc({
    id: "main", kind: "sequence", steps: [
      { id: "d", kind: "decide", question: "Decide about {{input.topic}}", decision, lowConfidence: { below: 0.7, run: fallback, value } },
    ],
  }, { $ref: "steps.d" }, { schemas });
}

const agentFallback: WorkflowNode = { id: "review", kind: "agent", message: "Review {{input.topic}}", maxTurns: 3, output: "Review" };
const waitFallback: WorkflowNode = { id: "ask", kind: "wait", question: "Pick for {{input.topic}}", choices: ["a", "b", "c"] };

async function setup(t: Parameters<typeof setupWorkflow>[0]) {
  const agentMessages: string[] = [];
  const s = await setupWorkflow(t, { agentLoop: fakeAgentLoop((message) => agentMessages.push(message)) });
  return { s, agentMessages };
}

for (const [label, confidence, route] of [["above", 0.9, "confident"], ["at the boundary", 0.7, "confident"], ["below", 0.5, "low_confidence"]] as const) {
  test(`yes_no with confidence ${confidence} (${label} the 0.7 threshold) takes the ${route} route`, async (t) => {
    const { s, agentMessages } = await setup(t);
    const workflow = decideDoc({ type: "yes_no" }, agentFallback, { $ref: "fallback.data.urgent" });
    const script = { steps: { d: { output: { value: true, confidence, reason: "model says" } }, review: { output: { urgent: false } } } };
    const done = await s.run(await s.agent({ workflow, script }), { topic: "outage" });
    assert.equal(done.status, "completed", JSON.stringify(done.error));
    const out = asObject(done.output);
    assert.equal(out["route"], route);
    assert.equal(out["confidence"], confidence);
    assert.equal(out["reason"], "model says");
    if (route === "confident") {
      assert.equal(out["value"], true);
      assert.equal(out["fallback"], null);
      assert.deepEqual(agentMessages, []);
    } else {
      assert.equal(out["value"], false);
      assert.deepEqual(asObject(out["fallback"])["data"], { urgent: false });
      assert.deepEqual(agentMessages, ["Review outage"]);
    }
  });
}

test("pick_one below the threshold asks a person through a wait node and uses the answer", async (t) => {
  const { s } = await setup(t);
  const workflow = decideDoc({ type: "pick_one", options: ["a", "b", "c"] }, waitFallback, { $ref: "fallback.answer" });
  const script = { steps: { d: { output: { value: "a", confidence: 0.2 } } } };
  const run = await s.h.start(await s.agent({ workflow, script }), { data: { topic: "colour" } });
  await s.h.until(run.id, "waiting");
  const [pending] = await s.h.pendings(run.id);
  assert.equal(pending?.detail["question"], "Pick for colour");
  await s.h.send(run.id, { type: "answer", pendingId: pending?.id ?? "", answer: "b" });
  const done = await s.h.until(run.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.deepEqual(done.output, { value: "b", confidence: 0.2, reason: "", route: "low_confidence", fallback: { answer: "b" } });
});

test("pick_one above the threshold never asks", async (t) => {
  const { s } = await setup(t);
  const workflow = decideDoc({ type: "pick_one", options: ["a", "b", "c"] }, waitFallback, { $ref: "fallback.answer" });
  const done = await s.run(await s.agent({ workflow, script: { steps: { d: { output: { value: "c", confidence: 0.95 } } } } }), { topic: "x" });
  assert.equal(done.status, "completed");
  assert.equal(asObject(done.output)["value"], "c");
  assert.equal(asObject(done.output)["route"], "confident");
  assert.equal((await s.h.journal(done.id)).some((r) => r.type === "pending.opened"), false);
});

test("score below the threshold takes the agent's score; above keeps the model's", async (t) => {
  const { s, agentMessages } = await setup(t);
  const workflow = decideDoc({ type: "score", min: 0, max: 10 }, agentFallback, { $ref: "fallback.data.score" });
  const low = await s.run(await s.agent({ workflow, script: { steps: { d: { output: { value: 3, confidence: 0.1 } }, review: { output: { score: 7 } } } } }), { topic: "a" });
  assert.equal(low.status, "completed", JSON.stringify(low.error));
  assert.equal(asObject(low.output)["value"], 7);
  assert.equal(asObject(low.output)["route"], "low_confidence");
  const high = await s.run(await s.agent({ workflow: { ...workflow, name: "score_high" }, script: { steps: { d: { output: { value: 3, confidence: 0.8 } } } } }), { topic: "b" });
  assert.equal(asObject(high.output)["value"], 3);
  assert.deepEqual(agentMessages, ["Review a"]);
});

test("a fallback value of the wrong type fails the node", async (t) => {
  const { s } = await setup(t);
  const workflow = decideDoc({ type: "yes_no" }, agentFallback, { $ref: "fallback.data.urgent" });
  const script = { steps: { d: { output: { value: true, confidence: 0.3 } }, review: { output: { urgent: "maybe" } } } };
  const done = await s.run(await s.agent({ workflow, script }), { topic: "x" });
  assert.equal(done.status, "failed");
  assert.equal(done.error?.code, "workflow_failed");
  assert.match(done.error?.message ?? "", /node "d" failed: the fallback value "maybe" does not fit the yes_no decision/);
});

test("a branch on the decision takes the matching case", async (t) => {
  const { s } = await setup(t);
  const workflow = doc({
    id: "main", kind: "sequence", steps: [
      { id: "d", kind: "decide", question: "Urgent?", decision: { type: "yes_no" } },
      { id: "route", kind: "branch", on: { $ref: "steps.d.value" }, cases: [
        { when: true, run: { id: "page", kind: "tool", tool: "count", args: { label: "page" } } },
        { when: false, run: { id: "queue", kind: "tool", tool: "count", args: { label: "queue" } } },
      ] },
    ],
  }, { $ref: "steps.route.content" }, { schemas });
  const yes = await s.run(await s.agent({ workflow, script: { steps: { d: { output: { value: true, confidence: 1 } } } } }), {});
  assert.equal(yes.output, "page");
  const no = await s.run(await s.agent({ workflow: { ...workflow, name: "other" }, script: { steps: { d: { output: { value: false, confidence: 1 } } } } }), {});
  assert.equal(no.output, "queue");
  assert.equal(s.counters.get("count", "page"), 1);
  assert.equal(s.counters.get("count", "queue"), 1);
});
