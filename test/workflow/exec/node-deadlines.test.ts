/**
 * `deadlineMs` on a composite node (sequence, parallel, branch, map, loop, call, agent) is an instant: the node's
 * journalled start plus `deadlineMs` (Rule T, R10-03). Calls in flight inside it are aborted and journalled as
 * timeouts, no further step of the node starts, and the node fails with `deadline_exceeded`. Time spent waiting,
 * paused or crashed counts: a run that comes back after the instant fails the node, and a waiting run is woken
 * for that. On a wait node the question must be answered by the instant, else the node fails. On fail it changes
 * nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Json } from "../../../src/core/json.ts";
import type { AgentLoopFn } from "../../../src/engine/types.ts";
import type { JournalRecord } from "../../../src/store/types.ts";
import { dryRunWorkflow } from "../../../src/workflow/dryrun.ts";
import type { ScriptedScript } from "../../../src/models/types.ts";
import type { WorkflowDocument, WorkflowNode } from "../../../src/workflow/types.ts";
import { waitFor } from "../../helpers/wait.ts";
import { asObject, doc, duplicateFinishes, setupWorkflow, untilRecord } from "./helpers.ts";

/** The slow tool waits this long on its abort signal; every deadline below is far shorter. */
const SLOW_MS = 5_000;
/** A run cut by its deadline ends well before the slow tool would have. */
const CUT_BOUND_MS = 2_500;

const summary = { type: "object", required: ["text"], properties: { text: { type: "string" } } };
const schemas = { Input: { type: "object" }, Output: {}, Summary: summary };

/** `[slow, after]`: a slow counting tool, then a step that must never start once the deadline passed. */
const slowThenAfter = (id = "body"): WorkflowNode => ({ id, kind: "sequence", steps: [
  { id: "slow", kind: "tool", tool: "count", args: { label: "slow", delayMs: SLOW_MS } },
  { id: "after", kind: "tool", tool: "count", args: { label: "after" } },
] });

/** `main`: the node under test, then `tail` (outside it). */
const withTail = (node: WorkflowNode): WorkflowNode => ({ id: "main", kind: "sequence", steps: [
  node,
  { id: "tail", kind: "tool", tool: "count", args: { label: "tail" } },
] });

function keyed(journal: readonly JournalRecord[], type: string, suffix: string): JournalRecord[] {
  return journal.filter((r) => r.type === type && (r.key ?? "").endsWith(suffix));
}

function deadlineFailure(message: string | undefined, nodeId: string, deadlineMs: number): void {
  assert.match(message ?? "", new RegExp(`node "${nodeId}" failed: deadline_exceeded: the deadline of ${deadlineMs} ms passed`));
}

/** A slow tool call, then a model call, as an agent hand-off would make them. */
const toolThenModelLoop: AgentLoopFn = async (ctx, params) => {
  await ctx.tool("t1", { name: "count", args: { label: "slow", delayMs: SLOW_MS } });
  const reply = await ctx.model("t2", { purpose: "run", system: params.instructions, messages: [{ role: "user", content: params.message }], turn: 1 });
  return { text: reply.text, data: null, turns: 1 };
};

const KINDS: { kind: string; node: (deadlineMs: number) => WorkflowNode; extra?: Partial<WorkflowDocument> }[] = [
  { kind: "sequence", node: (deadlineMs) => ({ ...slowThenAfter("box"), deadlineMs }) },
  { kind: "parallel", node: (deadlineMs) => ({ id: "box", kind: "parallel", deadlineMs, branches: [
    slowThenAfter(),
    { id: "quick", kind: "tool", tool: "probe", args: { label: "quick" } },
  ] }) },
  { kind: "branch", node: (deadlineMs) => ({ id: "box", kind: "branch", deadlineMs, on: true, cases: [{ when: true, run: slowThenAfter() }] }) },
  { kind: "map", node: (deadlineMs) => ({ id: "box", kind: "map", deadlineMs, over: [1, 2], as: "item", concurrency: 1, maxItems: 5, run: slowThenAfter() }) },
  { kind: "loop", node: (deadlineMs) => ({ id: "box", kind: "loop", deadlineMs, maxIterations: 3, until: { truthy: false }, run: slowThenAfter() }) },
  {
    kind: "call",
    node: (deadlineMs) => ({ id: "box", kind: "call", deadlineMs, workflow: "sub", input: {} }),
    extra: { workflows: { sub: { ...doc(slowThenAfter(), null), name: "sub" } } },
  },
];

for (const { kind, node, extra } of KINDS) {
  test(`a deadline on a ${kind} node stops the slow tool inside it, starts nothing after it, and fails the run`, async (t) => {
    const s = await setupWorkflow(t);
    const workflow = doc(withTail(node(150)), null, { schemas, ...extra });
    const startedAt = Date.now();
    const done = await s.run(await s.agent({ workflow }), {});
    const elapsed = Date.now() - startedAt;
    assert.equal(done.status, "failed");
    assert.equal(done.error?.code, "workflow_failed");
    deadlineFailure(done.error?.message, "box", 150);
    assert.ok(elapsed < CUT_BOUND_MS, `the run ended at the deadline, not after the slow tool (${elapsed} ms)`);

    const journal = await s.h.journal(done.id);
    const slow = keyed(journal, "tool.finished", "slow#1");
    assert.equal(slow.length, 1, "the slow tool ran once");
    assert.equal(slow[0]?.data["outcome"], "timeout");
    assert.equal(s.counters.get("count", "slow"), 1);
    assert.equal(keyed(journal, "tool.started", "after#1").length, 0, "the step after the slow tool never started");
    assert.equal(s.counters.get("count", "after"), 0);
    assert.equal(s.counters.get("count", "tail"), 0);
    assert.equal(journal.some((r) => r.type === "node.finished" && r.key === "wf/box"), false);
  });
}

test("a deadline on an agent node stops the hand-off's tool call in flight and starts no model call", async (t) => {
  const s = await setupWorkflow(t, { agentLoop: toolThenModelLoop });
  const workflow = doc(withTail({ id: "box", kind: "agent", deadlineMs: 150, message: "go", maxTurns: 3 }), null, { schemas });
  const startedAt = Date.now();
  const done = await s.run(await s.agent({ workflow }), {});
  assert.ok(Date.now() - startedAt < CUT_BOUND_MS);
  assert.equal(done.status, "failed");
  deadlineFailure(done.error?.message, "box", 150);
  const journal = await s.h.journal(done.id);
  assert.equal(keyed(journal, "tool.finished", "wf/box/t1")[0]?.data["outcome"], "timeout");
  assert.equal(journal.some((r) => r.type === "model.started"), false, "the hand-off's model call never started");
  assert.equal(s.counters.get("count", "tail"), 0);
});

test("a deadline on an agent node interrupts its model call, charges the worst case and fails the run", async (t) => {
  const s = await setupWorkflow(t);
  const workflow = doc(withTail({ id: "box", kind: "agent", deadlineMs: 150, message: "go", maxTurns: 3 }), null, { schemas });
  const script = { steps: { box: { text: "late", delayMs: SLOW_MS, usage: { inputTokens: 10, outputTokens: 10 } } } };
  const startedAt = Date.now();
  const done = await s.run(await s.agent({ workflow, script }), {});
  assert.ok(Date.now() - startedAt < CUT_BOUND_MS);
  assert.equal(done.status, "failed");
  deadlineFailure(done.error?.message, "box", 150);
  const journal = await s.h.journal(done.id);
  const interrupted = journal.filter((r) => r.type === "model.interrupted");
  assert.equal(interrupted.length, 1);
  assert.equal(interrupted[0]?.key, "wf/box/t1");
  assert.equal(interrupted[0]?.data["reason"], "deadline");
  const assumed = interrupted[0]?.data["assumedCostMicros"];
  assert.ok(typeof assumed === "number" && assumed > 0, "the worst case is charged");
  assert.ok(done.usage.costMicros >= assumed);
  assert.equal(journal.some((r) => r.type === "model.finished"), false);
});

test("a composite node that finishes within its deadline completes, and a slow step after it is not cut", async (t) => {
  const s = await setupWorkflow(t);
  const workflow = doc({ id: "main", kind: "sequence", steps: [
    { id: "box", kind: "sequence", deadlineMs: 300, steps: [{ id: "quick", kind: "tool", tool: "count", args: { label: "quick" } }] },
    { id: "later", kind: "tool", tool: "probe", args: { label: "later", delayMs: 700 } },
  ] }, { $ref: "steps.later.content" }, { schemas });
  const startedAt = Date.now();
  const done = await s.run(await s.agent({ workflow }), {});
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.ok(Date.now() - startedAt >= 650, "the step after the node ran to its end");
  assert.equal(done.output, "later");
  assert.equal(keyed(await s.h.journal(done.id), "tool.finished", "wf/later#1")[0]?.data["outcome"], "ok");
});

function callDoc(callDeadlineMs: number, innerDeadlineMs: number): WorkflowDocument {
  const sub: WorkflowDocument = { ...doc({ ...slowThenAfter("inner"), deadlineMs: innerDeadlineMs }, null), name: "sub" };
  return doc(withTail({ id: "outer", kind: "call", deadlineMs: callDeadlineMs, workflow: "sub", input: {} }), null, { schemas, workflows: { sub } });
}

test("a call's own deadline cuts the sub-workflow before the sub-workflow's longer node deadline", async (t) => {
  const s = await setupWorkflow(t);
  const done = await s.run(await s.agent({ workflow: callDoc(150, 4_000) }), {});
  assert.equal(done.status, "failed");
  deadlineFailure(done.error?.message, "outer", 150);
  assert.equal(keyed(await s.h.journal(done.id), "tool.finished", "slow#1")[0]?.data["outcome"], "timeout");
  assert.equal(s.counters.get("count", "after"), 0);
});

test("a sub-workflow's shorter node deadline passes first and names its own node", async (t) => {
  const s = await setupWorkflow(t);
  const done = await s.run(await s.agent({ workflow: callDoc(4_000, 150) }), {});
  assert.equal(done.status, "failed");
  deadlineFailure(done.error?.message, "inner", 150);
  assert.equal(keyed(await s.h.journal(done.id), "tool.finished", "slow#1")[0]?.data["outcome"], "timeout");
  assert.equal(s.counters.get("count", "after"), 0);
});

function mapDoc(deadlineMs: number): WorkflowDocument {
  return doc({
    id: "fan", kind: "map", deadlineMs, over: { $ref: "input.items" }, as: "item", concurrency: 2, maxItems: 10,
    run: { id: "work", kind: "tool", tool: "probe", args: { label: "{{vars.item}}", delayMs: 60 } },
  }, { $ref: "steps.fan" }, { schemas });
}

const SIX = ["a", "b", "c", "d", "e", "f"];

test("a deadline on a map covers all its iterations together: 3 rounds of 60 ms do not fit in 150 ms", async (t) => {
  const s = await setupWorkflow(t);
  const done = await s.run(await s.agent({ workflow: mapDoc(150) }), { items: SIX });
  assert.equal(done.status, "failed");
  deadlineFailure(done.error?.message, "fan", 150);
  const outcomes = (await s.h.journal(done.id)).filter((r) => r.type === "tool.finished").map((r) => r.data["outcome"]);
  assert.ok(outcomes.includes("timeout"), `an item in flight at the deadline was cut (${outcomes.join(", ")})`);
  assert.ok(outcomes.filter((o) => o === "ok").length < SIX.length, "not every item finished");
});

test("the same map with a 5 s deadline completes with every result", async (t) => {
  const s = await setupWorkflow(t);
  const done = await s.run(await s.agent({ workflow: mapDoc(5_000) }), { items: SIX });
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.deepEqual((done.output as Json[]).map((item) => asObject(item)["content"]), SIX);
  assert.equal(s.counters.highWater.get("probe"), 2);
});

/** A sequence `box` with `deadlineMs`: tool `a`, a wait `q` without its own deadline, then tool `b` (its answer). */
const waitInBox = (deadlineMs: number): WorkflowDocument => doc({ id: "box", kind: "sequence", deadlineMs, steps: [
  { id: "a", kind: "tool", tool: "count", args: { label: "a" } },
  { id: "q", kind: "wait", question: "Go on?" },
  { id: "b", kind: "tool", tool: "count", args: { label: "b", value: { $ref: "steps.q.answer" } } },
] }, { $ref: "steps.b.data" }, { schemas });

/** The `ts` of the node.started record of `key`. */
async function nodeStartedAt(s: { h: { journal(runId: string): Promise<JournalRecord[]> } }, runId: string, key: string): Promise<number> {
  const record = (await s.h.journal(runId)).find((r) => r.type === "node.started" && r.key === key);
  assert.ok(record !== undefined, `node.started ${key}`);
  return record.ts;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("time waiting for a person counts: a composite node waiting past its instant fails with no command, and the step after the wait never runs", async (t) => {
  const s = await setupWorkflow(t);
  const run = await s.h.start(await s.agent({ workflow: waitInBox(200) }), { data: {} });
  await s.h.until(run.id, "waiting");
  const startedAt = await nodeStartedAt(s, run.id, "wf/box");
  const [pending] = await s.h.pendings(run.id);
  assert.equal(pending?.detail["expiresAt"], startedAt + 200, "the question carries the enclosing instant");
  const done = await s.h.until(run.id, ["completed", "failed"], 3_000);
  assert.equal(done.status, "failed");
  assert.equal(done.error?.code, "workflow_failed");
  deadlineFailure(done.error?.message, "box", 200);
  assert.ok((done.finishedAt ?? 0) >= startedAt + 200);
  assert.equal(s.counters.get("count", "a"), 1);
  assert.equal(s.counters.get("count", "b"), 0, "the step after the wait never ran");
  assert.deepEqual(await s.h.pendings(run.id), [], "no open pending remains");
  assert.equal((await s.h.journal(run.id)).some((r) => r.type === "command.applied"), false, "no command was sent");
});

test("a composite node whose instant is far away completes when the wait is answered, each step once", async (t) => {
  const s = await setupWorkflow(t);
  const run = await s.h.start(await s.agent({ workflow: waitInBox(5_000) }), { data: {} });
  await s.h.until(run.id, "waiting");
  await sleep(300);
  const [pending] = await s.h.pendings(run.id);
  await s.h.send(run.id, { type: "answer", pendingId: pending?.id ?? "", answer: "yes" });
  const done = await s.h.until(run.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(done.output, "yes");
  assert.equal(s.counters.get("count", "a"), 1);
  assert.equal(s.counters.get("count", "b"), 1);
});

/** A sequence `box` with `deadlineMs`: tool `a`, a 300 ms model step `think`, then tool `b`. */
function pausedBox(deadlineMs: number): { workflow: WorkflowDocument; script: ScriptedScript } {
  return {
    workflow: doc({ id: "box", kind: "sequence", deadlineMs, steps: [
      { id: "a", kind: "tool", tool: "count", args: { label: "a" } },
      { id: "think", kind: "model", prompt: "x", output: "Summary" },
      { id: "b", kind: "tool", tool: "count", args: { label: "b" } },
    ] }, { $ref: "steps.think.text" }, { schemas }),
    script: { steps: { think: { output: { text: "thought" }, delayMs: 300 } } },
  };
}

test("paused in the middle of a composite node longer than its deadline: nothing wakes it, and on resume it fails without running the next step", async (t) => {
  const s = await setupWorkflow(t);
  const run = await s.h.start(await s.agent(pausedBox(400)), { data: {} });
  await untilRecord(s.h, run.id, (r) => r.type === "model.started" && r.key === "wf/think#1");
  await s.h.send(run.id, { type: "pause" });
  await s.h.until(run.id, "paused");
  const startedAt = await nodeStartedAt(s, run.id, "wf/box");
  await sleep(startedAt + 700 - Date.now());
  assert.equal((await s.h.store.getRun(run.id))?.status, "paused", "a paused run is not woken");
  await s.h.send(run.id, { type: "resume" });
  const done = await s.h.until(run.id, ["completed", "failed"]);
  assert.equal(done.status, "failed");
  deadlineFailure(done.error?.message, "box", 400);
  assert.equal(s.counters.get("count", "a"), 1);
  assert.equal(s.counters.get("count", "b"), 0, "the step after the pause never ran");
  assert.equal((await s.h.journal(done.id)).some((r) => r.type === "model.finished"), false);
});

test("paused in the middle of a composite node for less than its deadline: it completes after resume", async (t) => {
  const s = await setupWorkflow(t);
  const run = await s.h.start(await s.agent(pausedBox(5_000)), { data: {} });
  await untilRecord(s.h, run.id, (r) => r.type === "model.started" && r.key === "wf/think#1");
  await s.h.send(run.id, { type: "pause" });
  await s.h.until(run.id, "paused");
  await sleep(300);
  await s.h.send(run.id, { type: "resume" });
  const done = await s.h.until(run.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(done.output, "thought");
  assert.equal(s.counters.get("count", "a"), 1);
  assert.equal(s.counters.get("count", "b"), 1);
  assert.deepEqual(duplicateFinishes(await s.h.journal(done.id)), []);
});

test("a crash in the middle of a composite node with a generous deadline repeats no finished child", async (t) => {
  const s = await setupWorkflow(t);
  const workflow = doc({ id: "box", kind: "parallel", deadlineMs: 5_000, branches: [
    { id: "a", kind: "tool", tool: "count", args: { label: "a" } },
    { id: "chain", kind: "sequence", steps: [
      { id: "think", kind: "model", prompt: "x", output: "Summary" },
      { id: "b", kind: "tool", tool: "count", args: { label: "b" } },
    ] },
  ] }, { $ref: "steps.think.text" }, { schemas });
  const script = { steps: { think: { output: { text: "after crash" }, delayMs: 400 } } };
  const run = await s.h.start(await s.agent({ workflow, script }), { data: {} });
  await untilRecord(s.h, run.id, (r) => r.type === "model.started" && r.key === "wf/think#1");
  await untilRecord(s.h, run.id, (r) => r.type === "node.finished" && r.key === "wf/a");
  await s.h.crashAndReplace();
  const done = await s.h.until(run.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(done.output, "after crash");
  assert.equal(s.counters.get("count", "a"), 1);
  assert.equal(s.counters.get("count", "b"), 1);
  assert.deepEqual(duplicateFinishes(await s.h.journal(run.id)), []);
});

test("a composite node whose instant passes during a takeover after a crash fails instead of starting over", async (t) => {
  const s = await setupWorkflow(t);
  const workflow = doc({ id: "box", kind: "parallel", deadlineMs: 250, branches: [
    { id: "a", kind: "tool", tool: "count", args: { label: "a" } },
    { id: "chain", kind: "sequence", steps: [
      { id: "think", kind: "model", prompt: "x", output: "Summary" },
      { id: "b", kind: "tool", tool: "count", args: { label: "b" } },
    ] },
  ] }, { $ref: "steps.think.text" }, { schemas });
  const script = { steps: { think: { output: { text: "after crash" }, delayMs: 5_000 } } };
  const run = await s.h.start(await s.agent({ workflow, script }), { data: {} });
  await untilRecord(s.h, run.id, (r) => r.type === "model.started" && r.key === "wf/think#1");
  await s.h.crashAndReplace();
  const done = await s.h.until(run.id, ["completed", "failed"], 3_000);
  assert.equal(done.status, "failed");
  deadlineFailure(done.error?.message, "box", 250);
  const startedAt = await nodeStartedAt(s, run.id, "wf/box");
  const journal = await s.h.journal(run.id);
  const takeover = journal.filter((r) => r.type === "run.claimed")[1];
  assert.ok(takeover !== undefined && takeover.ts >= startedAt + 250, "the takeover came after the instant");
  assert.equal(s.counters.get("count", "b"), 0);
  assert.equal(journal.filter((r) => r.type === "model.started").length, 1, "the model step was not started again");
});

/** Every composite kind, with `deadlineMs` on each when `deadlineMs` is given. */
function everyComposite(deadlineMs?: number): WorkflowDocument {
  const d = deadlineMs === undefined ? {} : { deadlineMs };
  const sub: WorkflowDocument = { ...doc({ id: "sub_root", kind: "sequence", ...d, steps: [
    { id: "sub_tool", kind: "tool", tool: "count", args: { label: "sub" } },
  ] }, { $ref: "steps.sub_tool.content" }), name: "sub" };
  return doc({ id: "main", kind: "sequence", ...d, steps: [
    { id: "fan", kind: "parallel", ...d, branches: [
      { id: "p1", kind: "tool", tool: "count", args: { label: "p1" } },
      { id: "p2", kind: "tool", tool: "probe", args: { label: "p2" } },
    ] },
    { id: "pick", kind: "branch", ...d, on: true, cases: [{ when: true, run: { id: "picked", kind: "tool", tool: "count", args: { label: "picked" } } }] },
    { id: "each", kind: "map", ...d, over: [1, 2, 3], as: "item", concurrency: 2, maxItems: 5,
      run: { id: "item_tool", kind: "tool", tool: "probe", args: { label: "{{vars.item}}" } } },
    { id: "again", kind: "loop", ...d, maxIterations: 3, until: { gte: [{ $ref: "loop.again.index" }, 1] },
      run: { id: "loop_tool", kind: "tool", tool: "probe", args: { label: "loop" } } },
    { id: "nested", kind: "call", ...d, workflow: "sub", input: {} },
    { id: "helper", kind: "agent", ...d, message: "hi", maxTurns: 2 },
  ] }, { $ref: "steps.nested" }, { schemas, workflows: { sub } });
}

test("journal keys do not change when composite nodes carry deadlines that do not pass", async (t) => {
  const script = { steps: { helper: { text: "hello" } } };
  const keysOf = async (workflow: WorkflowDocument): Promise<string[]> => {
    const s = await setupWorkflow(t);
    const done = await s.run(await s.agent({ workflow, script }), {});
    assert.equal(done.status, "completed", JSON.stringify(done.error));
    assert.equal(done.output, "sub");
    return (await s.h.journal(done.id)).filter((r) => r.key !== undefined && r.key !== null).map((r) => `${r.type} ${r.key}`).sort();
  };
  const plain = await keysOf(everyComposite());
  const bounded = await keysOf(everyComposite(5_000));
  assert.ok(plain.length > 20);
  assert.deepEqual(bounded, plain);
});

test("a document with deadlines on composite nodes dry-runs exactly as the same document without them", () => {
  const plain = dryRunWorkflow(everyComposite(), { input: {} });
  const bounded = dryRunWorkflow(everyComposite(1), { input: {} });
  assert.equal(plain.ok, true, JSON.stringify(plain.problems));
  assert.deepEqual(bounded, plain);
});

const QUESTION_EXPIRED = /node "q" failed: deadline_exceeded: the question was not answered before its deadline$/;

test("deadlineMs on a wait node fails the run at the deadline with no command", async (t) => {
  const s = await setupWorkflow(t);
  const workflow = doc({ id: "q", kind: "wait", deadlineMs: 150, question: "Ready?" }, { $ref: "steps.q.answer" }, { schemas });
  const run = await s.h.start(await s.agent({ workflow }), { data: {} });
  await s.h.until(run.id, "waiting");
  const startedAt = await nodeStartedAt(s, run.id, "wf/q");
  const [pending] = await s.h.pendings(run.id);
  assert.deepEqual(pending?.detail, { question: "Ready?", choices: [], expiresAt: startedAt + 150 });
  const done = await s.h.until(run.id, ["completed", "failed"], 3_000);
  assert.equal(done.status, "failed");
  assert.equal(done.error?.code, "workflow_failed");
  assert.match(done.error?.message ?? "", QUESTION_EXPIRED);
  assert.ok((done.finishedAt ?? 0) >= startedAt + 150);
  assert.deepEqual(await s.h.pendings(run.id), [], "no open pending remains");
  assert.deepEqual((await s.h.store.getPending(pending?.id ?? ""))?.resolution, { expired: true, expiresAt: startedAt + 150 });
  assert.equal((await s.h.journal(run.id)).some((r) => r.type === "command.applied"), false);
});

test("deadlineMs on a wait node: answered at once, the run completes with the answer", async (t) => {
  const s = await setupWorkflow(t);
  const workflow = doc({ id: "q", kind: "wait", deadlineMs: 150, question: "Ready?" }, { $ref: "steps.q.answer" }, { schemas });
  const run = await s.h.start(await s.agent({ workflow }), { data: {} });
  await s.h.until(run.id, "waiting");
  const [pending] = await s.h.pendings(run.id);
  await s.h.send(run.id, { type: "answer", pendingId: pending?.id ?? "", answer: "ready" });
  const done = await s.h.until(run.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(done.output, "ready");
});

test("deadlineMs on a wait node holds across a crash while waiting: the new runner fails it at the instant", async (t) => {
  const s = await setupWorkflow(t);
  const workflow = doc({ id: "q", kind: "wait", deadlineMs: 250, question: "Ready?" }, { $ref: "steps.q.answer" }, { schemas });
  const run = await s.h.start(await s.agent({ workflow }), { data: {} });
  await s.h.until(run.id, "waiting");
  const startedAt = await nodeStartedAt(s, run.id, "wf/q");
  await s.h.crashAndReplace();
  const done = await s.h.until(run.id, ["completed", "failed"], 3_000);
  assert.equal(done.status, "failed");
  assert.match(done.error?.message ?? "", QUESTION_EXPIRED);
  assert.ok((done.finishedAt ?? 0) >= startedAt + 250);
  assert.deepEqual(await s.h.pendings(run.id), []);
});

test("a wait with a deadline inside a map body and inside a call: each execution has its own instant", async (t) => {
  const s = await setupWorkflow(t);
  const ask: WorkflowNode = { id: "q", kind: "wait", deadlineMs: 2_000, question: "Item?" };
  const sub: WorkflowDocument = { ...doc(ask, { $ref: "steps.q.answer" }), name: "sub" };
  const workflow = doc({ id: "main", kind: "sequence", steps: [
    { id: "each", kind: "map", over: [1, 2], as: "item", concurrency: 1, maxItems: 5, run: ask },
    { id: "c1", kind: "call", workflow: "sub", input: {} },
    { id: "c2", kind: "call", workflow: "sub", input: {} },
  ] }, { $ref: "steps.c2" }, { schemas, workflows: { sub } });
  const run = await s.h.start(await s.agent({ workflow }), { data: {} });
  const instants = new Map<string, number>();
  for (let i = 0; i < 4; i++) {
    const pending = await waitFor(async () => (await s.h.pendings(run.id)).find((p) => !instants.has(p.stepKey)));
    const startedAt = await nodeStartedAt(s, run.id, pending.stepKey);
    assert.equal(pending.detail["expiresAt"], startedAt + 2_000, pending.stepKey);
    instants.set(pending.stepKey, startedAt + 2_000);
    await sleep(60);
    await s.h.send(run.id, { type: "answer", pendingId: pending.id, answer: `a${i}` });
  }
  const done = await s.h.until(run.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(done.output, "a3");
  const values = [...instants.values()];
  assert.equal(new Set(values).size, 4, `four keys, four instants: ${JSON.stringify([...instants])}`);
  for (let i = 1; i < values.length; i++) assert.ok((values[i] as number) - (values[i - 1] as number) >= 60, JSON.stringify(values));
});

test("deadlineMs on a fail node changes nothing: it fails with its own message", async (t) => {
  const s = await setupWorkflow(t);
  const workflow = doc({ id: "main", kind: "sequence", steps: [
    { id: "a", kind: "tool", tool: "probe", args: { label: "a", delayMs: 100 } },
    { id: "stop", kind: "fail", deadlineMs: 1, message: "stopped on purpose" },
  ] }, null, { schemas });
  const done = await s.run(await s.agent({ workflow }), {});
  assert.equal(done.status, "failed");
  assert.match(done.error?.message ?? "", /node "stop" failed: stopped on purpose$/);
  assert.doesNotMatch(done.error?.message ?? "", /deadline/);
});
