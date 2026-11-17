/**
 * A deadline on a `run_workflow` call stops the nested workflow (plan 4.6, finding R02-06): nested model and tool
 * calls in flight are aborted and journalled as such, no further nested node starts, and the call is journalled
 * `timeout`. A deadline measures one execution: a call resumed after a crash gets a fresh one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { JournalRecord } from "../../../src/store/types.ts";
import type { WorkflowDocument, WorkflowNode } from "../../../src/workflow/types.ts";
import { asObject, doc, duplicateFinishes, setupWorkflow, untilRecord, type WorkflowSetup } from "./helpers.ts";

const CALL = "wf/call#1";
const summary = { type: "object", required: ["text"], properties: { text: { type: "string" } } };

function saved(name: string, root: WorkflowNode, result: WorkflowDocument["result"] = "done"): WorkflowDocument {
  return {
    format: "runwright.workflow/v1", name, schemas: { In: { type: "object" }, Out: {}, Summary: summary },
    input: "In", output: "Out", root, result,
  };
}

/** The outer workflow: `call` runs the saved workflow `target` with `deadlineMs`, then `next` (a slow tool) keeps the run alive. */
function outerFlow(target: string, deadlineMs: number, nextDelayMs = 0): WorkflowDocument {
  return doc({ id: "main", kind: "sequence", steps: [
    { id: "call", kind: "tool", tool: "run_workflow", args: { name: target, input: {} }, deadlineMs, onError: "continue" },
    { id: "next", kind: "tool", tool: "probe", args: { label: "next", delayMs: nextDelayMs } },
  ] }, { $ref: "steps.call" });
}

const slowThenCount = (label = "after"): WorkflowNode => ({ id: "inner", kind: "sequence", steps: [
  { id: "slow", kind: "model", prompt: "think", output: "Summary" },
  { id: "after", kind: "tool", tool: "count", args: { label } },
] });

const workflowTools = [{ name: "run_workflow" }, { name: "count" }, { name: "probe" }, { name: "stubborn" }];

function registerStubborn(s: WorkflowSetup): { calls: () => number } {
  let calls = 0;
  s.h.tools.register({
    name: "stubborn", description: "ignores its signal", effect: "write", parameters: { type: "object", properties: {} },
    async handler() {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 120));
      return { content: "stubborn done" };
    },
  });
  return { calls: () => calls };
}

function finishedAt(journal: readonly JournalRecord[], key: string): JournalRecord {
  const found = journal.filter((r) => r.type === "tool.finished" && r.key === key);
  assert.equal(found.length, 1, `exactly one tool.finished at ${key}`);
  return found[0] as JournalRecord;
}

test("the reviewer's probe: a run_workflow deadline interrupts the nested model call and the next nested tool never runs", async (t) => {
  const s = await setupWorkflow(t);
  await s.h.store.saveWorkflow({ name: "slow_flow", source: "api", document: saved("slow_flow", slowThenCount()) });
  const script = { steps: { slow: { output: { text: "late" }, delayMs: 300, usage: { inputTokens: 10, outputTokens: 10 } } } };
  const agentId = await s.agent({ workflow: outerFlow("slow_flow", 30, 400), script, tools: workflowTools });
  const done = await s.run(agentId, {});
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(asObject(done.output)["ok"], false);

  const journal = await s.h.journal(done.id);
  const outer = finishedAt(journal, CALL);
  assert.equal(outer.data["outcome"], "timeout");
  const started = journal.find((r) => r.type === "tool.started" && r.key === CALL) as JournalRecord;
  assert.ok(outer.ts - started.ts < 250, `the call ended at its deadline, not after the nested model call (${outer.ts - started.ts} ms)`);

  const interrupted = journal.filter((r) => r.type === "model.interrupted" && r.key?.startsWith(`${CALL}/`) === true);
  assert.equal(interrupted.length, 1);
  assert.equal(interrupted[0]?.data["reason"], "deadline");
  const assumed = interrupted[0]?.data["assumedCostMicros"];
  assert.ok(typeof assumed === "number" && assumed > 0);
  assert.ok(done.usage.costMicros >= assumed, "the assumed cost is in the run's usage");
  assert.equal(journal.some((r) => r.type === "model.finished" && r.key?.startsWith(`${CALL}/`) === true), false);

  assert.equal(s.counters.get("count", "after"), 0, "the nested tool step never ran");
  assert.equal(s.counters.get("probe", "next"), 1);
  const late = journal.filter((r) => r.key?.startsWith(`${CALL}/`) === true && r.seq > outer.seq);
  assert.deepEqual(late.map((r) => `${r.seq} ${r.type} ${r.key ?? ""}`), [], "nothing under the call's key after it finished");
});

test("a nested cooperative tool in flight at the deadline is journalled timeout before the call", async (t) => {
  const s = await setupWorkflow(t);
  await s.h.store.saveWorkflow({ name: "coop_flow", source: "api", document: saved("coop_flow", { id: "inner", kind: "sequence", steps: [
    { id: "wait", kind: "tool", tool: "count", args: { label: "coop", delayMs: 2_000 } },
    { id: "after", kind: "tool", tool: "count", args: { label: "after" } },
  ] }) });
  const done = await s.run(await s.agent({ workflow: outerFlow("coop_flow", 30), tools: workflowTools }), {});
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  const journal = await s.h.journal(done.id);
  const nested = finishedAt(journal, `${CALL}/wf/wait#1`);
  assert.equal(nested.data["outcome"], "timeout");
  const outer = finishedAt(journal, CALL);
  assert.equal(outer.data["outcome"], "timeout");
  assert.ok(nested.seq < outer.seq);
  assert.equal(s.counters.get("count", "coop"), 1);
  assert.equal(s.counters.get("count", "after"), 0);
});

test("a nested tool that ignores its signal is journalled ok, and the next nested step does not start", async (t) => {
  const s = await setupWorkflow(t);
  const stubborn = registerStubborn(s);
  await s.h.store.saveWorkflow({ name: "stubborn_flow", source: "api", document: saved("stubborn_flow", { id: "inner", kind: "sequence", steps: [
    { id: "hold", kind: "tool", tool: "stubborn", args: {} },
    { id: "after", kind: "tool", tool: "count", args: { label: "after" } },
  ] }) });
  const done = await s.run(await s.agent({ workflow: outerFlow("stubborn_flow", 30), tools: workflowTools }), {});
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  const journal = await s.h.journal(done.id);
  assert.equal(stubborn.calls(), 1);
  assert.equal(finishedAt(journal, `${CALL}/wf/hold#1`).data["outcome"], "ok");
  assert.equal(finishedAt(journal, CALL).data["outcome"], "timeout");
  assert.equal(s.counters.get("count", "after"), 0);
  assert.equal(journal.some((r) => r.key === `${CALL}/wf/after#1`), false);
});

test("parallel nested steps: every one in flight gets its end record before the call is journalled timeout", async (t) => {
  const s = await setupWorkflow(t);
  registerStubborn(s);
  await s.h.store.saveWorkflow({ name: "fan_flow", source: "api", document: saved("fan_flow", { id: "fan", kind: "parallel", branches: [
    { id: "slow_a", kind: "model", prompt: "a", output: "Summary" },
    { id: "slow_b", kind: "model", prompt: "b", output: "Summary" },
    { id: "hold", kind: "tool", tool: "stubborn", args: {} },
  ] }) });
  const script = { steps: { slow_a: { output: { text: "a" }, delayMs: 300 }, slow_b: { output: { text: "b" }, delayMs: 300 } } };
  const done = await s.run(await s.agent({ workflow: outerFlow("fan_flow", 30, 400), script, tools: workflowTools }), {});
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  const journal = await s.h.journal(done.id);
  const outer = finishedAt(journal, CALL);
  assert.equal(outer.data["outcome"], "timeout");
  const interrupted = journal.filter((r) => r.type === "model.interrupted" && r.key?.startsWith(`${CALL}/`) === true);
  assert.deepEqual(interrupted.map((r) => r.data["reason"]), ["deadline", "deadline"]);
  const charged = interrupted.reduce((sum, r) => sum + (r.data["assumedCostMicros"] as number), 0);
  assert.ok(done.usage.costMicros >= charged && charged > 0);
  assert.equal(finishedAt(journal, `${CALL}/wf/hold#1`).data["outcome"], "ok");
  const late = journal.filter((r) => r.key?.startsWith(`${CALL}/`) === true && r.seq > outer.seq);
  assert.deepEqual(late.map((r) => `${r.seq} ${r.type} ${r.key ?? ""}`), [], "nothing under the call's key after it finished");
});

test("two levels: the outer deadline stops the innermost model call", async (t) => {
  const s = await setupWorkflow(t);
  await s.h.store.saveWorkflow({ name: "inner_flow", source: "api", document: saved("inner_flow", slowThenCount()) });
  await s.h.store.saveWorkflow({ name: "middle_flow", source: "api", document: saved("middle_flow", { id: "mid", kind: "sequence", steps: [
    { id: "deeper", kind: "tool", tool: "run_workflow", args: { name: "inner_flow", input: {} } },
    { id: "tail", kind: "tool", tool: "count", args: { label: "tail" } },
  ] }) });
  const script = { steps: { slow: { output: { text: "late" }, delayMs: 300 } } };
  const done = await s.run(await s.agent({ workflow: outerFlow("middle_flow", 30), script, tools: workflowTools }), {});
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  const journal = await s.h.journal(done.id);
  const deeper = `${CALL}/wf/deeper#1`;
  const interrupted = journal.filter((r) => r.type === "model.interrupted");
  assert.equal(interrupted.length, 1);
  assert.ok(interrupted[0]?.key?.startsWith(`${deeper}/`), `innermost model key ${interrupted[0]?.key ?? ""}`);
  assert.equal(interrupted[0]?.data["reason"], "deadline");
  assert.equal(finishedAt(journal, deeper).data["outcome"], "timeout");
  assert.equal(finishedAt(journal, CALL).data["outcome"], "timeout");
  assert.equal(s.counters.get("count", "after"), 0);
  assert.equal(s.counters.get("count", "tail"), 0);
});

test("a deadline long enough changes nothing", async (t) => {
  const s = await setupWorkflow(t);
  await s.h.store.saveWorkflow({ name: "slow_flow", source: "api", document: saved("slow_flow", slowThenCount(), { slow: { $ref: "steps.slow" } }) });
  const script = { steps: { slow: { output: { text: "in time" }, delayMs: 20 } } };
  const done = await s.run(await s.agent({ workflow: outerFlow("slow_flow", 5_000), script, tools: workflowTools }), {});
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  const output = asObject(done.output);
  assert.equal(output["ok"], true, JSON.stringify(output));
  assert.deepEqual(asObject(asObject(output["data"])["slow"]), { text: "in time" });
  assert.equal(finishedAt(await s.h.journal(done.id), CALL).data["outcome"], "ok");
  assert.equal(s.counters.get("count", "after"), 1);
});

test("a run_workflow call resumed after a crash gets a fresh deadline and repeats no finished nested node", async (t) => {
  const s = await setupWorkflow(t);
  await s.h.store.saveWorkflow({ name: "resume_flow", source: "api", document: saved("resume_flow", { id: "inner", kind: "sequence", steps: [
    { id: "first", kind: "tool", tool: "count", args: { label: "first" } },
    { id: "slow", kind: "model", prompt: "think", output: "Summary" },
    { id: "after", kind: "tool", tool: "count", args: { label: "after" } },
  ] }) });
  // The takeover needs the 300 ms lease to expire, so the resumed call cannot end within 800 ms of the first
  // start: it completes only because its deadline restarted with the resumed execution.
  const script = { steps: { slow: { output: { text: "resumed" }, delayMs: 600 } } };
  const run = await s.h.start(await s.agent({ workflow: outerFlow("resume_flow", 800), script, tools: workflowTools }), { data: {} });
  await untilRecord(s.h, run.id, (r) => r.type === "model.started" && r.key === `${CALL}/wf/slow#1`);
  await s.h.crashAndReplace();
  const done = await s.h.until(run.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  const journal = await s.h.journal(done.id);
  const finished = finishedAt(journal, CALL);
  assert.equal(finished.data["outcome"], "ok");
  const firstStart = journal.find((r) => r.type === "tool.started" && r.key === CALL) as JournalRecord;
  assert.ok(finished.ts - firstStart.ts > 800, `the call ended ${finished.ts - firstStart.ts} ms after it first started`);
  assert.equal(asObject(done.output)["ok"], true);
  assert.equal(s.counters.get("count", "first"), 1);
  assert.equal(s.counters.get("count", "after"), 1);
  assert.deepEqual(duplicateFinishes(journal), []);
  assert.deepEqual(journal.filter((r) => r.type === "model.interrupted").map((r) => r.data["reason"]), ["crash"]);
});
