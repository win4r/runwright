/**
 * Brief, section 4, "Workflow", checked against wrong implementations the existing tests would let through
 * (finding class R09D-tests-01), through the whole app:
 * - the agent's own `deny` policy is not applied to a workflow's tool node (the existing tests cover the
 *   server deny list, `ask`, a tool not granted, a spend cap and the tool-call budget, not an agent-level deny);
 * - a dry run that "calls nothing" is asserted on the report alone; here the host tools count their real
 *   invocations in the effects file, and no run, usage row or model call may appear.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Json } from "../../src/core/json.ts";
import type { WorkflowDocument } from "../../src/workflow/types.ts";
import { startTestApp } from "../fixtures/app.ts";
import { effectLines, fullTimeline, scriptedAgent, waitForStatus } from "../fixtures/runs.ts";

function flow(root: WorkflowDocument["root"], result: Json, schemas?: WorkflowDocument["schemas"]): WorkflowDocument {
  return {
    format: "runwright.workflow/v1",
    name: "audit_flow",
    schemas: { Input: { type: "object" }, Output: {}, ...schemas },
    input: "Input",
    output: "Output",
    root,
    result,
  };
}

test("a tool the agent's policy denies is refused inside a workflow and its handler never runs", { timeout: 30_000 }, async (t) => {
  const { client, effects } = await startTestApp(t);
  const workflow = flow({ id: "main", kind: "sequence", steps: [
    { id: "act", kind: "tool", tool: "record_effect", args: { label: "denied-effect" } },
  ] }, { $ref: "steps.act.content" });
  const definition = { ...scriptedAgent({ name: "Denier", tools: [{ name: "record_effect", policy: "deny" }], script: { turns: [{ text: "unused" }] } }), workflow };
  const { agent } = await client.saveAgent(definition, "denier");
  const { run } = await client.startRun({ agentId: agent.id, data: {} });
  const { run: done, pendings } = await waitForStatus(client, run.id, ["completed", "failed", "waiting", "cancelled"]);
  assert.equal(done.status, "failed", JSON.stringify(done.output));
  assert.deepEqual(pendings, [], "a denied tool is not turned into an approval");
  assert.match(done.error?.message ?? "", /node "act" failed/);
  assert.match(done.error?.message ?? "", /deny|denied/i);
  assert.deepEqual(await effectLines(effects), [], "the handler never ran");
  const records = await fullTimeline(client, run.id);
  assert.equal(records.filter((r) => r.type === "tool.started").length, 0);

  const allowed = { ...definition, tools: [{ name: "record_effect", policy: "allow" as const }] };
  await client.saveAgent(allowed, "denier");
  const { run: second } = await client.startRun({ agentId: agent.id, data: {} });
  const { run: ok } = await waitForStatus(client, second.id, ["completed", "failed", "waiting", "cancelled"]);
  assert.equal(ok.status, "completed", "the same workflow runs once the policy allows the tool");
  assert.deepEqual(await effectLines(effects), ["denied-effect"]);
});

test("a dry run over the API calls no tool and no model, starts no run and records no usage", { timeout: 30_000 }, async (t) => {
  const { client, effects } = await startTestApp(t);
  await client.saveAgent(scriptedAgent({ name: "Owner", tools: [{ name: "record_effect" }], script: { turns: [{ text: "x" }] } }), "owner");
  const document = flow({ id: "main", kind: "sequence", steps: [
    { id: "first", kind: "tool", tool: "record_effect", args: { label: "dry-1" } },
    { id: "think", kind: "model", prompt: "Summarise {{steps.first.content}}", output: "Summary" },
    { id: "each", kind: "map", over: ["a", "b", "c"], as: "item", concurrency: 2, maxItems: 5,
      run: { id: "per", kind: "tool", tool: "slow_effect", args: { label: "dry-{{vars.item}}", ms: 1 } } },
    { id: "again", kind: "loop", maxIterations: 2, until: { truthy: false },
      run: { id: "tick", kind: "tool", tool: "record_effect", args: { label: "dry-loop" } } },
  ] }, { $ref: "steps.think.data" }, { Summary: { type: "object", required: ["text"], properties: { text: { type: "string" } } } });

  const report = await client.dryRunWorkflow(document as unknown as Json, { input: {} });
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  const calls = report.wouldCall.map((c) => [c.type, c.name, c.nodeId]);
  assert.deepEqual(calls.filter((c) => c[0] === "tool").length, 1 + 3 + 2, JSON.stringify(calls));
  assert.ok(calls.some((c) => c[0] === "model" && c[2] === "think"), JSON.stringify(calls));

  assert.deepEqual(await effectLines(effects), [], "no tool handler ran");
  assert.deepEqual((await client.listRuns()).runs, [], "no run was started");
  assert.deepEqual((await client.usage({ groupBy: "model" })).rows, [], "no model call was recorded");
});

// Brief, section 4, "decision thresholds route correctly", with a stored secret whose value is the decision's own
// field name (finding R12-02): the stored structured output keeps `confidence`, so the threshold still decides.
for (const [confidence, expected] of [[0.9, ["route-high"]], [0.2, ["fallback-ran", "route-low"]]] as const) {
  test(`a decision with confidence ${confidence} routes by its threshold while a stored secret equals "confidence"`, { timeout: 30_000 }, async (t) => {
    const { client, effects } = await startTestApp(t);
    await client.setSecret("WORD_SECRET", "confidence");
    const workflow = flow({ id: "main", kind: "sequence", steps: [
      { id: "d", kind: "decide", question: "Ship it?", decision: { type: "yes_no" },
        lowConfidence: { below: 0.6, run: { id: "fb", kind: "tool", tool: "record_effect", args: { label: "fallback-ran" } } } },
      { id: "r", kind: "branch", on: { $ref: "steps.d.route" }, cases: [
        { when: "confident", run: { id: "hi", kind: "tool", tool: "record_effect", args: { label: "route-high" } } },
        { when: "low_confidence", run: { id: "lo", kind: "tool", tool: "record_effect", args: { label: "route-low" } } },
      ] },
    ] }, { $ref: "steps.d.value" });
    const script = { steps: { d: { output: { value: true, confidence, reason: "checked" } } } };
    const definition = { ...scriptedAgent({ name: "Decider", tools: [{ name: "record_effect", policy: "allow" as const }], script }), workflow };
    const { agent } = await client.saveAgent(definition, "decider");
    const { run } = await client.startRun({ agentId: agent.id, data: {} });
    const { run: done } = await waitForStatus(client, run.id, ["completed", "failed", "waiting", "cancelled"]);
    assert.equal(done.status, "completed", JSON.stringify(done.error));
    assert.deepEqual(await effectLines(effects), expected);
  });
}
