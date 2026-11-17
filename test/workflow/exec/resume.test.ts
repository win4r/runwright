import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { Json } from "../../../src/core/json.ts";
import type { JournalRecord } from "../../../src/store/types.ts";
import type { ScriptedScript } from "../../../src/models/types.ts";
import type { WorkflowDocument } from "../../../src/workflow/types.ts";
import { doc, duplicateFinishes, setupWorkflow, untilRecord, type WorkflowSetup } from "./helpers.ts";

const schemas = {
  Input: { type: "object" },
  Summary: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
  Output: {},
};

const slowScript = (steps: string[]): ScriptedScript => ({
  steps: Object.fromEntries(steps.map((step) => [step, { output: { text: `${step}: {{first_message}}` }, delayMs: 400 }])),
});

async function runUninterrupted(t: TestContext, workflow: WorkflowDocument, script: ScriptedScript, data: Json): Promise<Json> {
  const s = await setupWorkflow(t);
  const done = await s.run(await s.agent({ workflow, script }), data);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  return done.output;
}

async function crashWhen(s: WorkflowSetup, runId: string, ready: (journal: readonly JournalRecord[]) => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!ready(await s.h.journal(runId))) {
    if (Date.now() > deadline) throw new Error("crash point not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await s.h.crashAndReplace();
}

const has = (journal: readonly JournalRecord[], type: string, key: string): boolean => journal.some((r) => r.type === type && r.key === key);

test("a crash during a delayed model step resumes without repeating finished nodes", async (t) => {
  const workflow = doc({
    id: "main", kind: "sequence", steps: [
      { id: "prep", kind: "sequence", steps: [
        { id: "a", kind: "tool", tool: "count", args: { label: "a", value: "A" } },
        { id: "b", kind: "tool", tool: "count", args: { label: "b", value: "B" } },
      ] },
      { id: "slow", kind: "model", prompt: "think about {{steps.a.data}}", output: "Summary" },
      { id: "c", kind: "tool", tool: "count", args: { label: "c", value: "{{steps.a.data}}{{steps.b.data}}" } },
    ],
  }, { a: { $ref: "steps.a.data" }, slow: { $ref: "steps.slow.text" }, c: { $ref: "steps.c.data" } }, { schemas });
  const script = slowScript(["slow"]);
  const expected = await runUninterrupted(t, workflow, script, {});

  const s = await setupWorkflow(t);
  const run = await s.h.start(await s.agent({ workflow, script }), { data: {} });
  await crashWhen(s, run.id, (j) => has(j, "model.started", "wf/slow#1"));
  const done = await s.h.until(run.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.deepEqual(done.output, expected);
  assert.deepEqual(done.output, { a: "A", slow: "slow: think about A", c: "AB" });
  for (const label of ["a", "b", "c"]) assert.equal(s.counters.get("count", label), 1, label);
  const journal = await s.h.journal(run.id);
  assert.deepEqual(duplicateFinishes(journal), []);
  assert.ok(journal.some((r) => r.type === "model.interrupted" && r.key === "wf/slow#1" && r.data["reason"] === "crash"));
  assert.ok(new Set(journal.map((r) => r.epoch)).size >= 2, "the run was claimed again");
});

test("a crash inside a parallel group resumes the unfinished branch only", async (t) => {
  const workflow = doc({
    id: "main", kind: "sequence", steps: [
      { id: "fan", kind: "parallel", branches: [
        { id: "left", kind: "sequence", steps: [
          { id: "l1", kind: "tool", tool: "count", args: { label: "l1", value: "L" } },
          { id: "slowl", kind: "model", prompt: "left", output: "Summary" },
        ] },
        { id: "r1", kind: "tool", tool: "count", args: { label: "r1", value: "R" } },
      ] },
      { id: "tail", kind: "tool", tool: "count", args: { label: "tail", value: "{{steps.l1.data}}{{steps.r1.data}}" } },
    ],
  }, { fan: { $ref: "steps.fan" }, tail: { $ref: "steps.tail.data" } }, { schemas });
  const script = slowScript(["slowl"]);
  const expected = await runUninterrupted(t, workflow, script, {});

  const s = await setupWorkflow(t);
  const run = await s.h.start(await s.agent({ workflow, script }), { data: {} });
  await crashWhen(s, run.id, (j) => has(j, "model.started", "wf/slowl#1") && has(j, "tool.finished", "wf/r1#1"));
  const done = await s.h.until(run.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.deepEqual(done.output, expected);
  for (const label of ["l1", "r1", "tail"]) assert.equal(s.counters.get("count", label), 1, label);
  assert.deepEqual(duplicateFinishes(await s.h.journal(run.id)), []);
});

test("a crash inside a map resumes the unfinished items only, in order", async (t) => {
  const workflow = doc({
    id: "m", kind: "map", over: { $ref: "input.items" }, as: "it", concurrency: 2, maxItems: 10,
    run: { id: "body", kind: "sequence", steps: [
      { id: "mark", kind: "tool", tool: "count", args: { label: "item-{{vars.it}}" } },
      { id: "think", kind: "model", prompt: "{{vars.it}} after {{steps.mark.content}}", output: "Summary" },
    ] },
  }, { $ref: "steps.m" }, { schemas });
  const script = slowScript(["think"]);
  const data = { items: ["w", "x", "y", "z"] };
  const expected = await runUninterrupted(t, workflow, script, data);

  const s = await setupWorkflow(t);
  const run = await s.h.start(await s.agent({ workflow, script }), { data });
  await crashWhen(s, run.id, (j) => has(j, "model.started", "wf/m[0]/think#1") && has(j, "model.started", "wf/m[1]/think#1"));
  const done = await s.h.until(run.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.deepEqual(done.output, expected);
  assert.deepEqual(done.output, data.items.map((it) => ({ text: `think: ${it} after item-${it}` })));
  for (const it of data.items) assert.equal(s.counters.get("count", `item-${it}`), 1, it);
  assert.deepEqual(duplicateFinishes(await s.h.journal(run.id)), []);
});

test("a wait node survives a crash and continues when answered", async (t) => {
  const workflow = doc({
    id: "main", kind: "sequence", steps: [
      { id: "a", kind: "tool", tool: "count", args: { label: "a" } },
      { id: "q", kind: "wait", question: "Proceed after {{steps.a.content}}?" },
      { id: "b", kind: "tool", tool: "count", args: { label: "b", value: { $ref: "steps.q.answer" } } },
    ],
  }, { $ref: "steps.b.data" }, { schemas });
  const s = await setupWorkflow(t);
  const run = await s.h.start(await s.agent({ workflow }), { data: {} });
  await s.h.until(run.id, "waiting");
  await s.h.crashAndReplace();
  const [pending] = await s.h.pendings(run.id);
  assert.equal(pending?.kind, "question");
  assert.equal(pending?.detail["question"], "Proceed after a?");
  await s.h.send(run.id, { type: "answer", pendingId: pending?.id ?? "", answer: "go ahead" });
  const done = await s.h.until(run.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(done.output, "go ahead");
  assert.equal(s.counters.get("count", "a"), 1);
  assert.equal(s.counters.get("count", "b"), 1);
});

test("pause and resume work in the middle of a workflow", async (t) => {
  const workflow = doc({
    id: "main", kind: "sequence", steps: [
      { id: "a", kind: "tool", tool: "count", args: { label: "a" } },
      { id: "slow", kind: "model", prompt: "x", output: "Summary" },
      { id: "b", kind: "tool", tool: "count", args: { label: "b" } },
    ],
  }, { $ref: "steps.slow.text" }, { schemas });
  const s = await setupWorkflow(t);
  const run = await s.h.start(await s.agent({ workflow, script: slowScript(["slow"]) }), { data: {} });
  await untilRecord(s.h, run.id, (r) => r.type === "model.started" && r.key === "wf/slow#1");
  await s.h.send(run.id, { type: "pause" });
  await s.h.until(run.id, "paused");
  assert.equal(s.counters.get("count", "b"), 0);
  const journal = await s.h.journal(run.id);
  assert.ok(journal.some((r) => r.type === "model.interrupted" && r.key === "wf/slow#1" && r.data["reason"] === "pause"));
  await s.h.send(run.id, { type: "resume" });
  const done = await s.h.until(run.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(done.output, "slow: x");
  assert.equal(s.counters.get("count", "a"), 1);
  assert.equal(s.counters.get("count", "b"), 1);
  assert.deepEqual(duplicateFinishes(await s.h.journal(run.id)), []);
});
