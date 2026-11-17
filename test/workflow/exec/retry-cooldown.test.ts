/**
 * R07-01 at the level of a workflow node: a node's `retry` never starts the node's next attempt before a provider
 * retry-after wait left outstanding by the failed model step has passed (also after a pause or a crash during the
 * node's backoff, and when the node's deadline cut the engine's own wait), and it never retries a model call the
 * engine stopped because the provider asked for a wait longer than `models.retry.maxRetryAfterMs`.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { delay } from "../../../src/core/clock.ts";
import { RunwrightError } from "../../../src/core/errors.ts";
import type { JsonObject } from "../../../src/core/json.ts";
import type { JournalRecord } from "../../../src/store/types.ts";
import type { ModelResponse, ModelRetry } from "../../../src/models/types.ts";
import { isRetryable, providerWaitMs, providerWaitOf, toolAttemptError } from "../../../src/workflow/exec/errors.ts";
import type { WorkflowNode } from "../../../src/workflow/types.ts";
import { fakeModels, reply } from "../../helpers/engine.ts";
import { twoLayerWiring, wordSecrets } from "../../helpers/two-layer.ts";
import { PROVIDER_WAIT_DATA_FIELDS } from "../../../src/workflow/exec/value-fields.ts";
import { doc, setupWorkflow, untilRecord, type WorkflowSetup } from "./helpers.ts";

const schemas = {
  Input: { type: "object" },
  Summary: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
  Output: {},
};
const single = (node: WorkflowNode) => doc(node, { $ref: `steps.${node.id}` }, { schemas, name: "cooldown_flow" });

function engineRetry(maxAttempts = 1): ModelRetry {
  return { policy: { maxAttempts, baseMs: 1, maxMs: 1 }, random: () => 0, sleep: delay };
}

function rateLimited(retryAfterMs: number | null): RunwrightError {
  const details: JsonObject = { status: 429, billing: "none" };
  if (retryAfterMs !== null) details["retryAfterMs"] = retryAfterMs;
  return new RunwrightError("model_transient", "HTTP 429", { details });
}

interface Provider { calls: () => number }

/** A workflow setup whose provider fails the listed calls (1-based) with 429 and the given hint. */
async function setup(
  t: TestContext, failing: readonly number[], hint: number | null, output: () => ModelResponse, retry = engineRetry(),
): Promise<WorkflowSetup & Provider> {
  let calls = 0;
  const models = fakeModels(() => {
    calls += 1;
    if (failing.includes(calls)) throw rateLimited(hint);
    return output();
  }, retry);
  const s = await setupWorkflow(t, { models });
  return Object.assign(s, { calls: () => calls });
}

const summary = (): ModelResponse => reply({ output: { text: "done" } });
const decision = (): ModelResponse => reply({ output: { value: true, confidence: 0.9, reason: "clear" } });

function one(journal: readonly JournalRecord[], type: string, key: string): JournalRecord {
  const found = journal.filter((r) => r.type === type && r.key === key);
  assert.equal(found.length, 1, `exactly one ${type} at ${key}`);
  return found[0] as JournalRecord;
}

async function retries(s: WorkflowSetup, runId: string): Promise<[string, number, number][]> {
  return (await s.h.records(runId, "node.retry")).map((r) => [r.nodeId, r.attempt, r.delayMs]);
}

test("providerWaitMs and isRetryable read the outstanding wait and the explicit stop", () => {
  assert.equal(providerWaitMs(new Error("plain")), 0);
  assert.equal(providerWaitMs(new RunwrightError("model_failed", "no details")), 0);
  for (const value of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, "7"]) {
    assert.equal(providerWaitMs(new RunwrightError("model_failed", "x", { details: { retryAfterMs: value as number } })), 0, String(value));
  }
  assert.equal(providerWaitMs(new RunwrightError("model_failed", "x", { details: { retryAfterMs: 1500 } })), 1500);

  assert.equal(isRetryable(new RunwrightError("model_failed", "stopped", { details: { retryAfterMs: 400_000, retryAfterOverLimit: true } })), false);
  assert.equal(isRetryable(new RunwrightError("model_failed", "exhausted", { details: { retryAfterMs: 1500 } })), true);
  assert.equal(isRetryable(new RunwrightError("deadline_exceeded", "late", { details: { retryAfterMs: 300 } })), true);
  assert.equal(isRetryable(new RunwrightError("tool_failed", "t", { details: { tool: "x", outcome: "error" } })), true);
  assert.equal(isRetryable(new RunwrightError("tool_failed", "t", { details: { tool: "x", outcome: "denied" } })), false);
  assert.equal(isRetryable(new RunwrightError("validation_failed", "bad")), false);
  assert.equal(isRetryable(new Error("plain")), true);
});

test("a model node's retry waits out the provider's wait", async (t) => {
  const s = await setup(t, [1], 400, summary);
  const workflow = single({ id: "ask", kind: "model", prompt: "x", output: "Summary", retry: { maxAttempts: 2, backoffMs: 1 } });
  const done = await s.run(await s.agent({ workflow }), {});
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(s.calls(), 2);
  assert.deepEqual(await retries(s, done.id), [["ask", 1, 400]]);
  const journal = await s.h.journal(done.id);
  const failed = one(journal, "model.failed", "wf/ask#1");
  assert.equal(failed.data["retryAfterMs"], 400);
  const next = one(journal, "model.started", "wf/ask#2");
  assert.ok(next.ts - failed.ts >= 380, `gap ${next.ts - failed.ts} ms`);
});

test("a hint shorter than the node's backoff, or no hint, leaves the backoff as it is", async (t) => {
  const workflow = single({ id: "ask", kind: "model", prompt: "x", output: "Summary", retry: { maxAttempts: 2, backoffMs: 60 } });
  const short = await setup(t, [1], 5, summary);
  const shortDone = await short.run(await short.agent({ workflow }), {});
  assert.equal(shortDone.status, "completed", JSON.stringify(shortDone.error));
  assert.deepEqual(await retries(short, shortDone.id), [["ask", 1, 60]]);

  const none = await setup(t, [1], null, summary);
  const noneDone = await none.run(await none.agent({ workflow }), {});
  assert.equal(noneDone.status, "completed", JSON.stringify(noneDone.error));
  assert.deepEqual(await retries(none, noneDone.id), [["ask", 1, 60]]);
});

test("a decide node's retry waits out the provider's wait", async (t) => {
  const s = await setup(t, [1], 300, decision);
  const workflow = single({ id: "pick", kind: "decide", question: "Go?", decision: { type: "yes_no" }, retry: { maxAttempts: 2, backoffMs: 1 } });
  const done = await s.run(await s.agent({ workflow }), {});
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(s.calls(), 2);
  assert.deepEqual(await retries(s, done.id), [["pick", 1, 300]]);
  const journal = await s.h.journal(done.id);
  const gap = one(journal, "model.started", "wf/pick#2").ts - one(journal, "model.failed", "wf/pick#1").ts;
  assert.ok(gap >= 280, `gap ${gap} ms`);
});

test("a model call the engine stopped over the limit is not retried by the node", async (t) => {
  const s = await setup(t, [1, 2, 3], 400_000, summary);
  const workflow = single({ id: "ask", kind: "model", prompt: "x", output: "Summary", retry: { maxAttempts: 3, backoffMs: 1 } });
  const done = await s.run(await s.agent({ workflow }), {});
  assert.equal(done.status, "failed");
  assert.match(done.error?.message ?? "", /node "ask" failed: model_failed: model call not retried after 1 attempt/);
  assert.equal(s.calls(), 1);
  assert.deepEqual(await retries(s, done.id), []);
  assert.equal((await s.h.journal(done.id)).filter((r) => r.type === "model.started").length, 1);
});

test("a pause during the node's backoff does not bring the next request forward", async (t) => {
  const s = await setup(t, [1], 1500, summary);
  const workflow = single({ id: "ask", kind: "model", prompt: "x", output: "Summary", retry: { maxAttempts: 2, backoffMs: 1 } });
  const run = await s.h.start(await s.agent({ workflow }), { data: {} });
  await untilRecord(s.h, run.id, (r) => r.type === "node.retry");
  await s.h.send(run.id, { type: "pause" });
  await s.h.until(run.id, "paused");
  await s.h.send(run.id, { type: "resume" });
  const done = await s.h.until(run.id, ["completed", "failed"], 5000);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(s.calls(), 2);
  const journal = await s.h.journal(run.id);
  const gap = one(journal, "model.started", "wf/ask#2").ts - one(journal, "model.failed", "wf/ask#1").ts;
  assert.ok(gap >= 1450, `gap ${gap} ms`);
  assert.equal(journal.filter((r) => r.type === "node.retry").length, 1);
});

test("a crash during the node's backoff does not bring the next request forward", async (t) => {
  const s = await setup(t, [1], 1500, summary);
  const workflow = single({ id: "ask", kind: "model", prompt: "x", output: "Summary", retry: { maxAttempts: 2, backoffMs: 1 } });
  const run = await s.h.start(await s.agent({ workflow }), { data: {} });
  await untilRecord(s.h, run.id, (r) => r.type === "node.retry");
  await s.h.crashAndReplace();
  const done = await s.h.until(run.id, ["completed", "failed"], 5000);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(s.calls(), 2);
  const journal = await s.h.journal(run.id);
  const gap = one(journal, "model.started", "wf/ask#2").ts - one(journal, "model.failed", "wf/ask#1").ts;
  assert.ok(gap >= 1450, `gap ${gap} ms`);
  assert.equal(journal.filter((r) => r.type === "node.retry").length, 1);
});

test("a deadline that cuts the engine's wait leaves the rest of it to the node's retry", async (t) => {
  const s = await setup(t, [1], 700, summary, engineRetry(2));
  const workflow = single({
    id: "ask", kind: "model", prompt: "x", output: "Summary", deadlineMs: 100, retry: { maxAttempts: 2, backoffMs: 1 },
  });
  const done = await s.run(await s.agent({ workflow }), {});
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(s.calls(), 2);
  const journal = await s.h.journal(done.id);
  const failed = one(journal, "model.failed", "wf/ask#1");
  assert.equal((failed.data["error"] as { code: string }).code, "deadline_exceeded");
  const left = failed.data["retryAfterMs"];
  assert.ok(typeof left === "number" && left > 0 && left <= 700, `retryAfterMs ${String(left)}`);
  assert.deepEqual(await retries(s, done.id), [["ask", 1, left]]);
  const gap = one(journal, "model.started", "wf/ask#2").ts - one(journal, "model.retry", "wf/ask#1").ts;
  assert.ok(gap >= 680, `gap ${gap} ms`);
});

// ------------------------------------------------------------------ a tool node's retry around run_workflow

test("providerWaitOf and toolAttemptError carry a nested provider wait", () => {
  assert.equal(providerWaitOf(new Error("plain")), null);
  assert.equal(providerWaitOf(new RunwrightError("workflow_failed", "x", { details: { nodeId: "a" } })), null);
  assert.deepEqual(providerWaitOf(new RunwrightError("model_failed", "x", { details: { retryAfterMs: 900 } })), { retryAfterMs: 900 });
  assert.deepEqual(providerWaitOf(new RunwrightError("workflow_failed", "x", {
    details: { nodeId: "ask", code: "model_failed", cause: { status: 429, retryAfterMs: 600_000, retryAfterOverLimit: true } },
  })), { retryAfterMs: 600_000, retryAfterOverLimit: true });

  assert.deepEqual(toolAttemptError("t", "error", "c").details, { tool: "t", outcome: "error" });
  assert.deepEqual(toolAttemptError("t", "error", "c", { retryAfterMs: 900 }).details, { tool: "t", outcome: "error" },
    "only data.providerWait names a wait");
  const waiting = toolAttemptError("t", "error", "c", { providerWait: { retryAfterMs: 900 } });
  assert.deepEqual(waiting.details, { tool: "t", outcome: "error", retryAfterMs: 900 });
  assert.equal(providerWaitMs(waiting), 900);
  assert.equal(isRetryable(waiting), true);
  const stopped = toolAttemptError("t", "error", "c", { providerWait: { retryAfterMs: 600_000, retryAfterOverLimit: true } });
  assert.equal(isRetryable(stopped), false);
});

/** A saved workflow `inner` whose root is the model node `ask`, and a caller whose tool node `run` runs it with retry. */
async function nestedSetup(s: WorkflowSetup): Promise<string> {
  await s.h.store.saveWorkflow({
    name: "inner", source: "api",
    document: single({ id: "ask", kind: "model", prompt: "x", output: "Summary" }),
  });
  const workflow = doc({
    id: "run", kind: "tool", tool: "run_workflow", args: { name: "inner", input: {} }, idempotent: true,
    retry: { maxAttempts: 2, backoffMs: 1 },
  }, { $ref: "steps.run.data" });
  return s.agent({ workflow, tools: [{ name: "run_workflow" }] });
}

test("a tool node's retry around run_workflow waits out the nested model step's provider wait", async (t) => {
  const s = await setup(t, [1], 400, summary);
  const done = await s.run(await nestedSetup(s), {});
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(s.calls(), 2);
  const journal = await s.h.journal(done.id);
  const failedCall = one(journal, "tool.finished", "wf/run#1");
  assert.deepEqual(failedCall.data["data"], { providerWait: { retryAfterMs: 400 } });
  assert.deepEqual(await retries(s, done.id), [["run", 1, 400]]);
  const gap = one(journal, "model.started", "wf/run#2/wf/ask#1").ts - one(journal, "model.failed", "wf/run#1/wf/ask#1").ts;
  assert.ok(gap >= 380, `gap ${gap} ms`);
});

// Finding R12-02: secrets whose values are the provider wait's field names (or their parts) do not hide the wait.
const WAIT_WORDS = Object.fromEntries(wordSecrets(PROVIDER_WAIT_DATA_FIELDS).map((word, index) => [`WAIT_WORD_${index}`, word]));

for (const split of ["handed", "stored"] as const) {
  test(`a tool node's retry around run_workflow waits out the provider wait while secrets name its fields (secrets ${split})`, async (t) => {
    assert.ok(Object.values(WAIT_WORDS).includes("providerWait") && Object.values(WAIT_WORDS).includes("retryAfterMs"));
    let calls = 0;
    const models = fakeModels(() => {
      calls += 1;
      if (calls === 1) throw rateLimited(400);
      return summary();
    }, engineRetry());
    const s = await setupWorkflow(t, { models, twoLayer: { wiring: twoLayerWiring(), secrets: WAIT_WORDS } });
    await s.h.store.saveWorkflow({
      name: "inner", source: "api",
      document: single({ id: "ask", kind: "model", prompt: "x", output: "Summary" }),
    });
    const workflow = doc({
      id: "run", kind: "tool", tool: "run_workflow", args: { name: "inner", input: {} }, idempotent: true,
      retry: { maxAttempts: 2, backoffMs: 1 },
    }, { $ref: "steps.run.data" });
    const agentId = await s.agent({ workflow, tools: [{ name: "run_workflow" }], ...(split === "handed" ? { secrets: Object.keys(WAIT_WORDS) } : {}) });
    const done = await s.run(agentId, {});
    assert.equal(done.status, "completed", JSON.stringify(done.error));
    assert.equal(calls, 2);
    const journal = await s.h.journal(done.id);
    assert.deepEqual(one(journal, "tool.finished", "wf/run#1").data["data"], { providerWait: { retryAfterMs: 400 } });
    assert.deepEqual(await retries(s, done.id), [["run", 1, 400]]);
  });
}

test("a tool node's retry around run_workflow does not undo the engine's stop of a nested model call", async (t) => {
  const s = await setup(t, [1, 2], 600_000, summary);
  const done = await s.run(await nestedSetup(s), {});
  assert.equal(done.status, "failed");
  assert.match(done.error?.message ?? "", /model call not retried after 1 attempt/);
  assert.equal(s.calls(), 1);
  assert.deepEqual(await retries(s, done.id), []);
});
