import { test } from "node:test";
import assert from "node:assert/strict";
import type { WorkflowNode } from "../../../src/workflow/types.ts";
import { retryDelayMs } from "../../../src/workflow/exec/nodes.ts";
import { asObject, doc, setupWorkflow, untilRecord } from "./helpers.ts";

const schemas = {
  Input: { type: "object" },
  Summary: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
  Output: {},
};
const single = (node: WorkflowNode, name = "single") => doc(node, { $ref: `steps.${node.id}` }, { schemas, name });

test("retry delays grow by the factor and are capped", () => {
  assert.equal(retryDelayMs({ maxAttempts: 5, backoffMs: 100 }, 1), 100);
  assert.equal(retryDelayMs({ maxAttempts: 5, backoffMs: 100 }, 3), 400);
  assert.equal(retryDelayMs({ maxAttempts: 5, backoffMs: 100, factor: 3 }, 3), 900);
  assert.equal(retryDelayMs({ maxAttempts: 5, backoffMs: 100, factor: 3, maxBackoffMs: 500 }, 3), 500);
  assert.equal(retryDelayMs({ maxAttempts: 20, backoffMs: 1000 }, 10), 60_000);
});

test("retry delays are finite and never longer than one timer can hold, for any policy", () => {
  assert.equal(retryDelayMs({ maxAttempts: 3, backoffMs: 2147483648, maxBackoffMs: 2147483648 }, 1), 2147483647);
  assert.equal(retryDelayMs({ maxAttempts: 3, backoffMs: 1000, factor: 1e300, maxBackoffMs: Infinity }, 3), 60_000);
  assert.equal(retryDelayMs({ maxAttempts: 3, backoffMs: 0, factor: 1e200 }, 3), 0);
  assert.equal(retryDelayMs({ maxAttempts: 3, backoffMs: 5, factor: NaN }, 2), 60_000);
  assert.equal(retryDelayMs({ maxAttempts: 3, backoffMs: NaN }, 1), 0);
  assert.equal(retryDelayMs({ maxAttempts: 3, backoffMs: -5 }, 1), 0);
  assert.equal(retryDelayMs({ maxAttempts: 3, backoffMs: Infinity, maxBackoffMs: 700 }, 1), 700);
  const policies = [
    { maxAttempts: 10, backoffMs: 1 },
    { maxAttempts: 10, backoffMs: 2147483647, factor: 10, maxBackoffMs: 2147483647 },
    { maxAttempts: 10, backoffMs: 1e9, factor: 1e308, maxBackoffMs: 1e20 },
    { maxAttempts: 10, backoffMs: 0, factor: Infinity, maxBackoffMs: NaN },
    { maxAttempts: 10, backoffMs: 50, factor: -3, maxBackoffMs: -1 },
    { maxAttempts: 10, backoffMs: Infinity, factor: 0.5 },
  ];
  for (const policy of policies) {
    for (let attempt = 1; attempt <= 10; attempt++) {
      const ms = retryDelayMs(policy, attempt);
      assert.ok(Number.isFinite(ms) && ms >= 0 && ms <= 2147483647, `${JSON.stringify(policy)} attempt ${attempt}: ${ms}`);
    }
  }
});

test("a failing idempotent tool is retried with backoff up to maxAttempts, then fails the node", async (t) => {
  const s = await setupWorkflow(t);
  const workflow = single({
    id: "fetch", kind: "tool", tool: "flaky", args: { label: "always", failTimes: 10 }, retry: { maxAttempts: 3, backoffMs: 10 },
  });
  const done = await s.run(await s.agent({ workflow }), {});
  assert.equal(done.status, "failed");
  assert.match(done.error?.message ?? "", /node "fetch" failed: .*always failed on call 3/);
  assert.equal(s.counters.get("flaky", "always"), 3);
  const retries = await s.h.records(done.id, "node.retry");
  assert.deepEqual(retries.map((r) => [r.nodeId, r.attempt, r.delayMs]), [["fetch", 1, 10], ["fetch", 2, 20]]);
  assert.equal(retries[0]?.error.code, "tool_failed");
});

test("a second attempt that succeeds lets the workflow continue", async (t) => {
  const s = await setupWorkflow(t);
  const workflow = single({
    id: "fetch", kind: "tool", tool: "flaky", args: { label: "once", failTimes: 1, value: 42 }, retry: { maxAttempts: 3, backoffMs: 5 },
  });
  const done = await s.run(await s.agent({ workflow }), {});
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.deepEqual(done.output, { ok: true, content: "once", data: 42 });
  assert.equal(s.counters.get("flaky", "once"), 2);
  assert.equal((await s.h.records(done.id, "node.retry")).length, 1);
  const keys = (await s.h.journal(done.id)).filter((r) => r.type === "tool.finished").map((r) => r.key);
  assert.deepEqual(keys, ["wf/fetch#1", "wf/fetch#2"]);
});

test("a read-only tool may be retried without the idempotent flag", async (t) => {
  const s = await setupWorkflow(t);
  const workflow = single({ id: "look", kind: "tool", tool: "probe", args: { label: "look", failTimes: 1 }, retry: { maxAttempts: 2, backoffMs: 1 } });
  const done = await s.run(await s.agent({ workflow }), {});
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(s.counters.get("probe", "look"), 2);
});

test("retry on a tool that is not safe to retry is rejected", async (t) => {
  const s = await setupWorkflow(t);
  const workflow = single({ id: "act", kind: "tool", tool: "count", args: { label: "act" }, retry: { maxAttempts: 2, backoffMs: 1 } });
  const done = await s.run(await s.agent({ workflow }), {});
  assert.equal(done.status, "failed");
  assert.equal(done.error?.code, "workflow_invalid");
  assert.match(done.error?.message ?? "", /not safe to retry/);
  assert.equal(s.counters.get("count", "act"), 0);
});

test("a tool exceeding deadlineMs fails the node, or is retried when allowed", async (t) => {
  const s = await setupWorkflow(t);
  const plain = single({ id: "slow", kind: "tool", tool: "count", args: { label: "plain", delayMs: 2000 }, deadlineMs: 50 });
  const failed = await s.run(await s.agent({ workflow: plain }), {});
  assert.equal(failed.status, "failed");
  assert.match(failed.error?.message ?? "", /timed out after 50 ms/);
  assert.equal(s.counters.get("count", "plain"), 1);

  const retried = single({
    id: "slow", kind: "tool", tool: "flaky", args: { label: "retried", delayMs: 2000 }, deadlineMs: 50, retry: { maxAttempts: 2, backoffMs: 1 },
  }, "retried");
  const again = await s.run(await s.agent({ workflow: retried }), {});
  assert.equal(again.status, "failed");
  assert.equal(s.counters.get("flaky", "retried"), 2);
  const outcomes = (await s.h.records(again.id, "tool.finished")).map((r) => r.outcome);
  assert.deepEqual(outcomes, ["timeout", "timeout"]);
});

test("a model node past its deadline is retried, then fails", async (t) => {
  const s = await setupWorkflow(t);
  const workflow = single({ id: "think", kind: "model", prompt: "x", output: "Summary", deadlineMs: 40, retry: { maxAttempts: 2, backoffMs: 1 } });
  const script = { steps: { think: { output: { text: "late" }, delayMs: 1000 } } };
  const done = await s.run(await s.agent({ workflow, script }), {});
  assert.equal(done.status, "failed");
  assert.match(done.error?.message ?? "", /node "think" failed: deadline_exceeded/);
  const interrupted = (await s.h.journal(done.id)).filter((r) => r.type === "model.interrupted");
  assert.deepEqual(interrupted.map((r) => [r.key, r.data["reason"]]), [["wf/think#1", "deadline"], ["wf/think#2", "deadline"]]);
});

test("after a crash between attempts the attempt count is not reset", async (t) => {
  const s = await setupWorkflow(t);
  const workflow = single({
    id: "fetch", kind: "tool", tool: "flaky", args: { label: "crashy", failTimes: 1, value: "fine" }, retry: { maxAttempts: 2, backoffMs: 800 },
  });
  const run = await s.h.start(await s.agent({ workflow }), { data: {} });
  await untilRecord(s.h, run.id, (r) => r.type === "node.retry");
  await s.h.crashAndReplace();
  const done = await s.h.until(run.id, ["completed", "failed"], 8000);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(asObject(done.output)["data"], "fine");
  assert.equal(s.counters.get("flaky", "crashy"), 2);
  const journal = await s.h.journal(run.id);
  const started = journal.filter((r) => r.type === "tool.started").map((r) => r.key);
  assert.deepEqual(started, ["wf/fetch#1", "wf/fetch#2"]);
  assert.equal(journal.filter((r) => r.type === "node.retry").length, 1);
});
