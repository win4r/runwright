/**
 * Finding R12-02 in workflows: a secret whose value is, or is contained in, a field name the executor wrote
 * (`confidence`, `fallback`, `completed`, `iterations`, a node id) or an enumerated word (`confident`,
 * `low_confidence`) changes neither which way a decision routes, nor what a branch or a reference to a node's
 * output sees, live or after a resume; the text and data inside the values are still redacted. Every case runs
 * through both redaction layers as `createApp` wires them, with the secrets handed to the run and only stored.
 *
 * Assertions go through what ran (counting tools, branches whose cases call differently labelled tools) and the
 * stored `node.finished` records, never through the run's output: a workflow's result is a payload.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, type Json, type JsonObject } from "../../src/core/json.ts";
import type { JournalRecord } from "../../src/store/types.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import { DECISION_OUTPUT_FIELDS, nodeValueFields } from "../../src/workflow/exec/value-fields.ts";
import type { WorkflowNode } from "../../src/workflow/types.ts";
import { twoLayerWiring, undeclaredPaths, wordSecrets, type TwoLayerWiring } from "../helpers/two-layer.ts";
import { asObject, doc, setupWorkflow, untilRecord, type WorkflowSetup } from "../workflow/exec/helpers.ts";

const schemas = {
  Input: { type: "object" },
  Summary: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
  Output: {},
};

const count = (id: string, label: string, value?: Json): WorkflowNode => ({
  id, kind: "tool", tool: "count", args: value === undefined ? { label } : { label, value },
});
const decide = (id: string, lowConfidence?: { below: number; run: WorkflowNode }): WorkflowNode => ({
  id, kind: "decide", question: "Go ahead?", decision: { type: "yes_no" }, ...(lowConfidence === undefined ? {} : { lowConfidence }),
});
const loop = (id: string, run: WorkflowNode, maxIterations = 2): WorkflowNode => ({
  id, kind: "loop", maxIterations, until: { gte: [{ $ref: `loop.${id}.index` }, 1] }, run,
});
/** A branch on `on` whose cases call the counting tool with `<label>_<case>`. */
const routeOn = (id: string, on: string, label: string): WorkflowNode => ({
  id, kind: "branch", on: { $ref: on }, cases: [
    { when: "confident", run: count(`${id}_hi`, `${label}_hi`) },
    { when: "low_confidence", run: count(`${id}_lo`, `${label}_lo`) },
  ],
});
const truthOn = (id: string, on: string, label: string): WorkflowNode => ({
  id, kind: "branch", on: { $ref: on }, cases: [
    { when: true, run: count(`${id}_yes`, `${label}_yes`) },
    { when: false, run: count(`${id}_no`, `${label}_no`) },
  ],
});
const answer = (confidence: number) => ({ output: { value: true, confidence, reason: "checked" } });

const SAMPLE_DECIDE = decide("d", { below: 0.6, run: count("x", "x") });
const DECISION_WORDS = [...wordSecrets(DECISION_OUTPUT_FIELDS, nodeValueFields(SAMPLE_DECIDE)), "confident", "low_confidence"];
const LOOP_WORDS = wordSecrets(nodeValueFields(loop("l", count("x", "x"))));
const WORDS = [...new Set([...DECISION_WORDS, ...LOOP_WORDS])];

function named(words: readonly string[]): Record<string, string> {
  return Object.fromEntries(words.map((word, index) => [`WORD_${index}`, word]));
}

const SPLITS = ["handed", "stored"] as const;
type Split = (typeof SPLITS)[number];

interface Setup { s: WorkflowSetup; wiring: TwoLayerWiring; names: string[] }

async function setup(t: TestContext, secrets: Record<string, string>): Promise<Setup> {
  const wiring = twoLayerWiring();
  const s = await setupWorkflow(t, { twoLayer: { wiring, secrets } });
  return { s, wiring, names: Object.keys(secrets) };
}

function secretsFor(split: Split, names: string[]): { secrets?: string[] } {
  return split === "handed" ? { secrets: names } : {};
}

function finishedAt(journal: readonly JournalRecord[], key: string): Json {
  const found = journal.filter((r) => r.type === "node.finished" && r.key === key);
  assert.equal(found.length, 1, `one node.finished at ${key}`);
  return (found[0] as JournalRecord).data["value"] ?? null;
}

test("the secrets of these tests include the decision's field names and words", () => {
  for (const word of ["confidence", "confiden", "nfidence", "fallback", "confident", "low_confidence", "completed", "iterations"]) {
    assert.ok(WORDS.includes(word), word);
  }
});

for (const split of SPLITS) {
  for (const [confidence, route] of [[0.9, "confident"], [0.2, "low_confidence"]] as const) {
    test(`decision thresholds: confidence ${confidence} takes the ${route} route (secrets ${split})`, async (t) => {
      const { s, names } = await setup(t, named(DECISION_WORDS));
      const workflow = doc({ id: "main", kind: "sequence", steps: [
        decide("d", { below: 0.6, run: count("fb", "fb") }),
        routeOn("r", "steps.d.route", "route"),
      ] }, null, { schemas });
      const agentId = await s.agent({ workflow, script: { steps: { d: answer(confidence) } }, ...secretsFor(split, names) });
      const done = await s.run(agentId, {});
      assert.equal(done.status, "completed", JSON.stringify(done.error));
      const low = route === "low_confidence";
      assert.equal(s.counters.get("count", "fb"), low ? 1 : 0, "the fallback runs only below the threshold");
      assert.equal(s.counters.get("count", "route_hi"), low ? 0 : 1);
      assert.equal(s.counters.get("count", "route_lo"), low ? 1 : 0);
      const stored = asObject(finishedAt(await s.h.journal(done.id), "wf/d"));
      assert.equal(stored["route"], route);
      assert.equal(stored["confidence"], confidence);
      assert.equal(stored["value"], true);
      assert.equal(stored["reason"], "checked");
      if (low) assert.equal(asObject(stored["fallback"])["ok"], true);
      else assert.equal(stored["fallback"], null);
    });
  }

  test(`a loop's completed and iterations reach a branch and a tool argument (secrets ${split})`, async (t) => {
    const { s, names } = await setup(t, named(LOOP_WORDS));
    const seen: Json[] = [];
    const capture: ToolDefinition = {
      name: "capture", description: "records its argument", effect: "read",
      parameters: { type: "object", required: ["n"], properties: { n: {} } },
      async handler(args) {
        seen.push(args["n"] ?? null);
        return { content: "captured" };
      },
    };
    s.h.tools.register(capture);
    const workflow = doc({ id: "main", kind: "sequence", steps: [
      loop("l", count("tick", "tick"), 3),
      truthOn("b", "steps.l.completed", "done"),
      { id: "use", kind: "tool", tool: "capture", args: { n: { $ref: "steps.l.iterations" } } },
    ] }, null, { schemas });
    const agentId = await s.agent({ workflow, tools: [{ name: "count" }, { name: "capture" }], ...secretsFor(split, names) });
    const done = await s.run(agentId, {});
    assert.equal(done.status, "completed", JSON.stringify(done.error));
    assert.equal(s.counters.get("count", "tick"), 2);
    assert.equal(s.counters.get("count", "done_yes"), 1);
    assert.equal(s.counters.get("count", "done_no"), 0);
    assert.deepEqual(seen, [2]);
    const stored = asObject(finishedAt(await s.h.journal(done.id), "wf/l"));
    assert.equal(stored["completed"], true);
    assert.equal(stored["iterations"], 2);
  });

  test(`nested composites keep the names of what they enclose (secrets ${split})`, async (t) => {
    const { s, names } = await setup(t, named(WORDS));
    const workflow = doc({ id: "main", kind: "sequence", steps: [
      { id: "p", kind: "parallel", branches: [decide("a", { below: 0.6, run: count("afb", "afb") }), loop("b", count("btick", "btick"))] },
      { id: "s", kind: "sequence", steps: [count("s1", "s1"), decide("sd")] },
      { id: "m", kind: "map", over: [1, 2], as: "item", concurrency: 1, maxItems: 5, run: decide("md") },
      decide("d", { below: 0.6, run: loop("fl", count("fltick", "fltick")) }),
      routeOn("r1", "steps.p.a.route", "pa"),
      truthOn("r2", "steps.p.b.completed", "pb"),
      routeOn("r3", "steps.s.route", "sr"),
      routeOn("r4", "steps.m.0.route", "mr"),
      truthOn("r5", "steps.d.fallback.completed", "df"),
    ] }, null, { schemas });
    const script = { steps: { a: answer(0.9), sd: answer(0.9), md: answer(0.95), d: answer(0.1) } };
    const done = await s.run(await s.agent({ workflow, script, ...secretsFor(split, names) }), {});
    assert.equal(done.status, "completed", JSON.stringify(done.error));
    for (const label of ["pa_hi", "pb_yes", "sr_hi", "mr_hi", "df_yes"]) assert.equal(s.counters.get("count", label), 1, label);
    assert.equal(s.counters.get("count", "fltick"), 2, "the fallback loop ran");
    for (const label of ["pa_lo", "pb_no", "sr_lo", "mr_lo", "df_no", "afb"]) assert.equal(s.counters.get("count", label), 0, label);
    const journal = await s.h.journal(done.id);
    const mapped = finishedAt(journal, "wf/m");
    assert.ok(Array.isArray(mapped) && mapped.length === 2);
    for (const item of mapped) assert.equal(asObject(item)["route"], "confident");
    const parallel = asObject(finishedAt(journal, "wf/p"));
    assert.deepEqual(Object.keys(parallel), ["a", "b"]);
    assert.equal(asObject(parallel["a"])["confidence"], 0.9);
    assert.equal(asObject(parallel["b"])["completed"], true);
    assert.equal(asObject(asObject(finishedAt(journal, "wf/d"))["fallback"])["iterations"], 2);
  });
}

// ------------------------------------------------------------------ live and replayed runs agree

const REPLAY_WORDS = [...WORDS, "password"];

function replayWorkflow() {
  return doc({ id: "main", kind: "sequence", steps: [
    { id: "first", kind: "sequence", steps: [
      { id: "grp", kind: "parallel", branches: [count("check_password", "pw", "pw-value"), loop("lp", count("lp_tick", "lp_tick"))] },
      decide("dq"),
    ] },
    { id: "slow", kind: "model", prompt: "think", output: "Summary" },
    routeOn("after_dq", "steps.dq.route", "dq"),
    truthOn("after_lp", "steps.lp.completed", "lp"),
    truthOn("after_pw", "steps.check_password.ok", "pw_ok"),
    count("use_pw", "use_pw", { $ref: "steps.check_password.data" }),
    count("use_grp", "use_grp", { $ref: "steps.grp.lp.iterations" }),
  ] }, null, { schemas });
}

const REPLAY_SCRIPT = { steps: { dq: answer(0.8), slow: { output: { text: "slow" }, delayMs: 400 } } };
const LATER = ["wf/after_dq", "wf/after_lp", "wf/after_pw", "wf/use_pw", "wf/use_grp", "wf/first", "wf/grp", "wf/check_password"];

for (const split of SPLITS) {
  test(`a run resumed after a crash sees the enclosed nodes as the uninterrupted run did (secrets ${split})`, async (t) => {
    const live = await setup(t, named(REPLAY_WORDS));
    const liveDone = await live.s.run(await live.s.agent({ workflow: replayWorkflow(), script: REPLAY_SCRIPT, ...secretsFor(split, live.names) }), {});
    assert.equal(liveDone.status, "completed", JSON.stringify(liveDone.error));
    const liveJournal = await live.s.h.journal(liveDone.id);

    const resumed = await setup(t, named(REPLAY_WORDS));
    const run = await resumed.s.h.start(await resumed.s.agent({ workflow: replayWorkflow(), script: REPLAY_SCRIPT, ...secretsFor(split, resumed.names) }), { data: {} });
    await untilRecord(resumed.s.h, run.id, (r) => r.type === "model.started" && r.key === "wf/slow#1");
    await resumed.s.h.crashAndReplace();
    const done = await resumed.s.h.until(run.id, ["completed", "failed"]);
    assert.equal(done.status, "completed", JSON.stringify(done.error));
    const journal = await resumed.s.h.journal(done.id);
    assert.ok(new Set(journal.map((r) => r.epoch)).size >= 2, "the run was claimed again");

    assert.deepEqual([...resumed.s.counters.calls.entries()].sort(), [...live.s.counters.calls.entries()].sort());
    for (const label of ["pw", "lp_tick", "dq_hi", "lp_yes", "pw_ok_yes", "use_pw", "use_grp"]) {
      assert.ok(live.s.counters.get("count", label) >= 1, label);
    }
    for (const key of LATER) assert.equal(canonicalJson(finishedAt(journal, key)), canonicalJson(finishedAt(liveJournal, key)), key);
    const scope = journal.find((r) => r.type === "step.finished" && r.key === "wf/first/scope");
    assert.ok(scope !== undefined);
    assert.ok(Object.hasOwn(asObject(scope.data["value"] ?? null), "check_password"), "the scope copy keeps the node id");
  });
}

// ------------------------------------------------------------------ text inside is still redacted

const TOOL_SECRET = "tool-secret-0001";
/** What the process-wide layer writes in place of a secret the run was not handed. */
const PLACEHOLDER = "[redacted]";
const KEY_SECRET = "key-secret-0002";

test("the text and data inside a node's value are still redacted (secrets stored only)", async (t) => {
  const { s, names } = await setup(t, { TOOL_SECRET, KEY_SECRET });
  assert.equal(names.length, 2);
  const workflow = doc({ id: "main", kind: "sequence", steps: [
    count("t", `content holds ${TOOL_SECRET}`, { [KEY_SECRET]: `data holds ${TOOL_SECRET}`, plain: 1 }),
    { id: "w", kind: "wait", question: "Anything to add?" },
  ] }, null, { schemas });
  const run = await s.h.start(await s.agent({ workflow }), { data: {} });
  await s.h.until(run.id, "waiting");
  const [pending] = await s.h.pendings(run.id);
  await s.h.send(run.id, { type: "answer", pendingId: pending?.id ?? "", answer: `my answer has ${TOOL_SECRET}` });
  const done = await s.h.until(run.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  const journal = await s.h.journal(done.id);
  const tool = asObject(finishedAt(journal, "wf/t"));
  assert.deepEqual(Object.keys(tool), ["ok", "content", "data"]);
  assert.equal(tool["ok"], true);
  // Stored only: the process-wide layer redacts, with its own placeholder.
  assert.equal(tool["content"], `content holds ${PLACEHOLDER}`);
  assert.deepEqual(tool["data"], { [PLACEHOLDER]: `data holds ${PLACEHOLDER}`, plain: 1 });
  assert.deepEqual(finishedAt(journal, "wf/w"), { answer: `my answer has ${PLACEHOLDER}` });
  assert.equal(JSON.stringify(journal).includes(TOOL_SECRET), false);
  assert.equal(JSON.stringify(journal).includes(KEY_SECRET), false);
});

// ------------------------------------------------------------------ the limits, pinned

test("a value an author's expression builds is a payload; the node's own record keeps its names", async (t) => {
  const { s, wiring } = await setup(t, { WORD: "confidence" });
  const sub = doc(decide("dd"), { $ref: "steps.dd" }, { name: "sub_flow", schemas });
  const workflow = doc({ id: "main", kind: "sequence", steps: [
    { id: "c", kind: "call", workflow: "sub_flow", input: {} },
    { id: "br", kind: "branch", on: { $ref: "input.pick" }, cases: [
      { when: "tool", run: count("bt", "bt") },
      { when: "decide", run: decide("bd") },
    ] },
  ] }, null, { schemas, workflows: { sub_flow: sub } });
  const done = await s.run(await s.agent({ workflow, script: { steps: { dd: answer(0.7), bd: answer(0.7) } } }), { pick: "decide" });
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  const journal = await s.h.journal(done.id);
  const called = asObject(finishedAt(journal, "wf/c"));
  assert.equal(Object.hasOwn(called, "confidence"), false, "the call's value is a payload");
  assert.equal(called[PLACEHOLDER], 0.7);
  assert.equal(asObject(finishedAt(journal, "wf/c>/dd"))["confidence"], 0.7, "the decide node's own record keeps confidence");
  const mixed = asObject(finishedAt(journal, "wf/br"));
  assert.equal(Object.hasOwn(mixed, "confidence"), false, "a branch whose cases differ is a payload");
  assert.equal(asObject(finishedAt(journal, "wf/bd"))["confidence"], 0.7);
  const declared = wiring.batches.flatMap((b) => b.records).find((r) => r.type === "node.finished" && r.key === "wf/br");
  assert.equal(declared?.fields?.fields["value"], "payload");
});

// ------------------------------------------------------------------ completeness

test("a workflow that uses every node kind journals nothing that no specification names", async (t) => {
  const { s, wiring } = await setup(t, {});
  const leaf = doc(count("leaf", "leaf"), { $ref: "steps.leaf.data" }, { name: "saved_leaf", schemas });
  await s.h.store.saveWorkflow({ name: "saved_leaf", source: "api", document: leaf });
  const inline = doc(decide("inner"), { $ref: "steps.inner.value" }, { name: "inline_sub", schemas });
  const workflow = doc({ id: "main", kind: "sequence", steps: [
    count("t", "t", { nested: [1, "two"] }),
    { id: "think", kind: "model", prompt: "think", output: "Summary" },
    decide("d", { below: 0.6, run: { id: "ask", kind: "wait", question: "Low confidence: go?" } }),
    { id: "p", kind: "parallel", branches: [count("pa", "pa"), { id: "helper", kind: "agent", message: "help", maxTurns: 1 }] },
    { id: "m", kind: "map", over: [1, 2], as: "item", concurrency: 2, maxItems: 5, run: count("mt", "mt") },
    loop("l", decide("ld")),
    { id: "c", kind: "call", workflow: "inline_sub", input: {} },
    { id: "cs", kind: "call", workflow: "saved_leaf", input: {} },
    { id: "b", kind: "branch", on: { $ref: "input.mode" }, cases: [
      { when: "never", run: { id: "stop", kind: "fail", message: "not reached" } },
      { when: "normal", run: count("ok_case", "ok_case") },
    ] },
  ] }, { $ref: "steps.m" }, { schemas, workflows: { inline_sub: inline } });
  const script = { steps: { think: { output: { text: "t" } }, d: answer(0.3), ld: answer(0.9), inner: answer(0.9), helper: { text: "helped" } } };
  const run = await s.h.start(await s.agent({ workflow, script }), { data: { mode: "normal" } });
  await s.h.until(run.id, "waiting");
  const [pending] = await s.h.pendings(run.id);
  await s.h.send(run.id, { type: "answer", pendingId: pending?.id ?? "", answer: "go" });
  const done = await s.h.until(run.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  const kinds = new Set((await s.h.journal(done.id)).filter((r) => r.type === "node.started").map((r) => String(r.data["kind"])));
  for (const kind of ["tool", "model", "decide", "wait", "parallel", "agent", "map", "loop", "call", "branch", "sequence"]) assert.ok(kinds.has(kind), kind);
  assert.deepEqual(undeclaredPaths(wiring.batches), []);
  const finished: JsonObject[] = wiring.batches.flatMap((b) => b.records).filter((r) => r.type === "node.finished").map((r) => r.data);
  assert.ok(finished.length > 10);
});
