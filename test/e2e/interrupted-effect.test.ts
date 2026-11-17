/**
 * Brief, section 4, "Interrupted effect": the process is SIGKILLed while four runs are inside a tool call
 * (journalled started, not finished). After a restart the read-only call is retried by itself; each of the
 * three write calls pauses its run as `interrupted` and is never re-run without a person's decision. The three
 * decisions (retry, skip with a supplied result, cancel) each work.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { RunwrightClient } from "../../src/client/index.ts";
import type { PendingRecord } from "../../src/store/types.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { waitFor } from "../helpers/wait.ts";
import { clientOf, startHost } from "../fixtures/process.ts";
import { callTurn, effectLines, fullTimeline, scriptedAgent, waitForStatus } from "../fixtures/runs.ts";

const SKIP_RESULT = "result supplied by a person";

async function interruptedPending(client: RunwrightClient, runId: string): Promise<PendingRecord> {
  const { pendings } = await client.listPendings({ runId });
  assert.equal(pendings.length, 1, `run ${runId} should have exactly one open pending`);
  const [pending] = pendings as [PendingRecord];
  assert.equal(pending.kind, "interrupted");
  return pending;
}

test("a crash inside tool calls retries the read tool and pauses each write tool for a decision", { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t, "runwright-e2e-interrupted-");
  const dataDir = join(dir, "data");
  const effects = join(dir, "effects.txt");
  const env = { RUNWRIGHT_DATA_DIR: dataDir, HOST_EFFECTS_FILE: effects, HOST_LEASE_MS: "400", HOST_POLL_MS: "40" };

  const first = await startHost(t, env);
  const client = clientOf(first);
  // The label is the run's message, and the final answer quotes the last tool result.
  const script = (tool: string) => ({
    turns: [callTurn(tool, { label: "{{first_message}}", ms: 1500 }), { text: "final: {{last_result}}" }],
  });
  const writer = await client.saveAgent(scriptedAgent({ name: "Writer", tools: [{ name: "slow_effect" }], script: script("slow_effect") }), "writer");
  const reader = await client.saveAgent(scriptedAgent({ name: "Reader", tools: [{ name: "slow_read" }], script: script("slow_read") }), "reader");

  const retryRun = (await client.startRun({ agentId: writer.agent.id, message: "w-retry" })).run;
  const skipRun = (await client.startRun({ agentId: writer.agent.id, message: "w-skip" })).run;
  const cancelRun = (await client.startRun({ agentId: writer.agent.id, message: "w-cancel" })).run;
  const readRun = (await client.startRun({ agentId: reader.agent.id, message: "r-read" })).run;

  await waitFor(async () => (await effectLines(effects)).filter((line) => line.startsWith("start:")).length === 4, {
    timeoutMs: 15_000, intervalMs: 5, message: "the four tool calls never all started",
  });
  first.kill("SIGKILL");
  await first.stopped;
  assert.deepEqual((await effectLines(effects)).filter((line) => line.startsWith("end:")), [], "killed inside every handler");

  const second = await startHost(t, env);
  const client2 = clientOf(second);

  const read = await waitForStatus(client2, readRun.id, ["completed", "failed", "waiting", "cancelled"], 20_000);
  assert.equal(read.run.status, "completed", "the read-only call was retried by itself");
  assert.deepEqual(read.run.output, { text: "final: slow_read r-read done" });
  const readRecords = await fullTimeline(client2, readRun.id);
  assert.deepEqual(readRecords.filter((r) => r.type === "tool.started").map((r) => r.data["attempt"]), [1, 2]);
  assert.equal(readRecords.filter((r) => r.type === "tool.interrupted").length, 0);

  const pendings = new Map<string, PendingRecord>();
  for (const run of [retryRun, skipRun, cancelRun]) {
    const { run: waiting } = await waitForStatus(client2, run.id, ["waiting", "completed", "failed", "cancelled"], 20_000);
    assert.equal(waiting.status, "waiting");
    const pending = await interruptedPending(client2, run.id);
    assert.equal(pending.detail["tool"], "slow_effect");
    pendings.set(run.id, pending);
    const records = await fullTimeline(client2, run.id);
    assert.equal(records.filter((r) => r.type === "tool.interrupted").length, 1);
  }
  const lines = await effectLines(effects);
  for (const label of ["w-retry", "w-skip", "w-cancel"]) {
    assert.equal(lines.filter((line) => line === `start:${label}`).length, 1, `${label} was not re-run blindly`);
  }
  assert.equal(lines.filter((line) => line === "start:r-read").length, 2, "the read handler ran twice");

  await client2.resolveInterrupted(pendings.get(retryRun.id)!.id, "retry");
  await client2.resolveInterrupted(pendings.get(skipRun.id)!.id, "skip", SKIP_RESULT);
  await client2.resolveInterrupted(pendings.get(cancelRun.id)!.id, "cancel");

  const retried = await waitForStatus(client2, retryRun.id, ["completed", "failed", "cancelled"], 20_000);
  assert.equal(retried.run.status, "completed");
  assert.deepEqual(retried.run.output, { text: "final: slow_effect w-retry done" });
  const skipped = await waitForStatus(client2, skipRun.id, ["completed", "failed", "cancelled"], 20_000);
  assert.equal(skipped.run.status, "completed");
  assert.deepEqual(skipped.run.output, { text: `final: ${SKIP_RESULT}` }, "the next model request carried the supplied result");
  const cancelled = await waitForStatus(client2, cancelRun.id, ["completed", "failed", "cancelled"], 20_000);
  assert.equal(cancelled.run.status, "cancelled");

  const after = await effectLines(effects);
  assert.equal(after.filter((line) => line === "start:w-retry").length, 2, "retry ran the handler again");
  assert.ok(after.includes("end:w-retry"));
  assert.equal(after.filter((line) => line === "start:w-skip").length, 1, "skip did not run the handler");
  assert.equal(after.filter((line) => line === "start:w-cancel").length, 1, "cancel did not run the handler");

  const retryRecords = await fullTimeline(client2, retryRun.id);
  assert.deepEqual(retryRecords.filter((r) => r.type === "tool.started").map((r) => r.data["attempt"]), [1, 2]);
  const skipFinished = (await fullTimeline(client2, skipRun.id)).filter((r) => r.type === "tool.finished");
  assert.equal(skipFinished.length, 1);
  assert.equal(skipFinished[0]?.data["outcome"], "skipped");
  assert.equal(skipFinished[0]?.data["content"], SKIP_RESULT);
});
