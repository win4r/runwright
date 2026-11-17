/**
 * Finding R01-02 on a real host: SIGTERM with a grace period shorter than the tool call in flight. The forced
 * shutdown aborts the call; it is never journalled as finished. A write call is left `interrupted` for a person
 * (and skipping it with a result completes the run without running the handler again); a read-only call is run
 * again by the next host by itself.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { JournalRecord } from "../../src/store/types.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { waitFor } from "../helpers/wait.ts";
import { clientOf, startHost } from "../fixtures/process.ts";
import { callTurn, effectLines, fullTimeline, scriptedAgent, waitForStatus } from "../fixtures/runs.ts";

const SKIP_RESULT = "result supplied after the shutdown";

function ofType(records: readonly JournalRecord[], type: string): JournalRecord[] {
  return records.filter((r) => r.type === type);
}

async function setup(t: TestContext, prefix: string) {
  const dir = await makeTempDir(t, prefix);
  const effects = join(dir, "effects.txt");
  const env = { RUNWRIGHT_DATA_DIR: join(dir, "data"), HOST_EFFECTS_FILE: effects, HOST_LEASE_MS: "400", HOST_POLL_MS: "40" };
  return { effects, env };
}

test("a forced shutdown leaves a write call interrupted, never finished; skip completes the run", { timeout: 30_000 }, async (t) => {
  const { effects, env } = await setup(t, "runwright-e2e-forced-write-");
  const first = await startHost(t, { ...env, HOST_GRACE_MS: "200" });
  const client = clientOf(first);
  const agent = await client.saveAgent(scriptedAgent({
    name: "Writer", tools: [{ name: "slow_effect" }],
    script: { turns: [callTurn("slow_effect", { label: "w", ms: 20_000 }), { text: "final: {{last_result}}" }] },
  }), "writer");
  const { run } = await client.startRun({ agentId: agent.agent.id, message: "go" });

  await waitFor(async () => (await effectLines(effects)).includes("start:w"), { timeoutMs: 10_000, intervalMs: 5 });
  const stopAt = Date.now();
  first.kill("SIGTERM");
  const exit = await first.stopped;
  assert.equal(exit.code, 0, "the host exits 0 after a forced shutdown");
  assert.ok(Date.now() - stopAt < 5_000, "the forced shutdown did not wait for the 20 s tool call");
  assert.deepEqual(await effectLines(effects), ["start:w"]);

  const second = await startHost(t, env);
  const client2 = clientOf(second);
  const { run: waiting } = await waitForStatus(client2, run.id, ["waiting", "completed", "failed", "cancelled"]);
  assert.equal(waiting.status, "waiting");
  const records = await fullTimeline(client2, run.id);
  const interrupted = ofType(records, "tool.interrupted");
  assert.equal(interrupted.length, 1);
  assert.equal(interrupted[0]?.data["reason"], "shutdown");
  assert.equal(interrupted[0]?.data["tool"], "slow_effect");
  assert.equal(ofType(records, "tool.finished").length, 0, "no tool.finished for the aborted call");

  const { pendings } = await client2.listPendings({ runId: run.id });
  assert.equal(pendings.length, 1);
  assert.equal(pendings[0]?.kind, "interrupted");
  assert.equal(pendings[0]?.detail["reason"], "shutdown");
  assert.deepEqual(await effectLines(effects), ["start:w"], "the write call was not re-run");

  await client2.resolveInterrupted(pendings[0]!.id, "skip", SKIP_RESULT);
  const done = await waitForStatus(client2, run.id, ["completed", "failed", "cancelled"]);
  assert.equal(done.run.status, "completed");
  assert.deepEqual(done.run.output, { text: `final: ${SKIP_RESULT}` }, "the model saw the supplied result");
  assert.deepEqual(await effectLines(effects), ["start:w"], "skip did not run the handler");
  const finished = ofType(await fullTimeline(client2, run.id), "tool.finished");
  assert.equal(finished.length, 1);
  assert.equal(finished[0]?.data["outcome"], "skipped");
});

test("a forced shutdown leaves a read call unfinished and the next host runs it again by itself", { timeout: 30_000 }, async (t) => {
  const { effects, env } = await setup(t, "runwright-e2e-forced-read-");
  // The grace period (100 ms) is shorter than the call (1 500 ms); the retry on the second host has time to finish.
  const first = await startHost(t, { ...env, HOST_GRACE_MS: "100" });
  const client = clientOf(first);
  const agent = await client.saveAgent(scriptedAgent({
    name: "Reader", tools: [{ name: "slow_read" }],
    script: { turns: [callTurn("slow_read", { label: "r", ms: 1_500 }), { text: "final: {{last_result}}" }] },
  }), "reader");
  const { run } = await client.startRun({ agentId: agent.agent.id, message: "go" });

  await waitFor(async () => (await effectLines(effects)).includes("start:r"), { timeoutMs: 10_000, intervalMs: 5 });
  first.kill("SIGTERM");
  const exit = await first.stopped;
  assert.equal(exit.code, 0);
  assert.deepEqual(await effectLines(effects), ["start:r"], "the first attempt was aborted before it ended");

  const second = await startHost(t, env);
  const client2 = clientOf(second);
  const done = await waitForStatus(client2, run.id, ["completed", "failed", "cancelled", "waiting"]);
  assert.equal(done.run.status, "completed");
  assert.deepEqual(done.run.output, { text: "final: slow_read r done" });
  const { pendings } = await client2.listPendings({ runId: run.id });
  assert.equal(pendings.length, 0);

  const records = await fullTimeline(client2, run.id);
  assert.deepEqual(ofType(records, "tool.started").map((r) => r.data["attempt"]), [1, 2]);
  assert.equal(ofType(records, "tool.interrupted").length, 0);
  assert.equal(ofType(records, "tool.finished").length, 1);
  assert.equal(ofType(records, "tool.finished")[0]?.data["outcome"], "ok");
  const lines = await effectLines(effects);
  assert.equal(lines.filter((l) => l === "start:r").length, 2);
  assert.equal(lines.filter((l) => l === "end:r").length, 1);
});
