/**
 * Finding R02-02 across processes: a server without a runner and a separate runner process on one data
 * directory. The runner polls only once a minute, so a command sent through the API reaches it only when the
 * run's final commit is refused by the store (`commands_pending`). A cancel sent while the last model call is in
 * flight makes the run `cancelled`, never `completed`; a message sent at the same point is consumed and the
 * timeline says it was not delivered. Neither run is left with an unconsumed command.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { RunwrightClient } from "../../src/client/index.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { waitFor } from "../helpers/wait.ts";
import { clientOf, startHost } from "../fixtures/process.ts";
import { callTurn, fullTimeline, scriptedAgent, waitForStatus } from "../fixtures/runs.ts";

const LAST_STEP_MS = 1_200;

/** Waits until the run's second model call (its last step) has been journalled as started. */
async function lastStepInFlight(client: RunwrightClient, runId: string): Promise<void> {
  await waitFor(async () => (await fullTimeline(client, runId)).filter((r) => r.type === "model.started").length === 2, {
    timeoutMs: 15_000, intervalMs: 10, message: `run ${runId} never started its last step`,
  });
}

function unconsumed(dbPath: string, runId: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT count(*) AS n FROM commands WHERE run_id = ? AND consumed_at IS NULL").get(runId) as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

test("a command that reaches a polling runner only at the final commit is honoured, not stranded", { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t, "runwright-e2e-late-");
  const dataDir = join(dir, "data");
  const server = await startHost(t, { RUNWRIGHT_DATA_DIR: dataDir, HOST_ROLE: "server", RUNWRIGHT_NO_RUNNER: "1" });
  const client = clientOf(server);
  const { agent } = await client.saveAgent(scriptedAgent({
    name: "Slow finisher",
    tools: [{ name: "list_files" }],
    script: { turns: [callTurn("list_files", {}), { text: "all done", delayMs: LAST_STEP_MS }] },
  }), "slow-finisher");

  // Both runs are queued before the runner starts: its start-up claim takes them, and nothing else wakes it.
  const toCancel = (await client.startRun({ agentId: agent.id, message: "work, then stop" })).run;
  const toMessage = (await client.startRun({ agentId: agent.id, message: "work, then listen" })).run;
  const runner = await startHost(t, { RUNWRIGHT_DATA_DIR: dataDir, HOST_ROLE: "runner", HOST_POLL_MS: "60000" });
  assert.equal(runner.url, "");

  const [cancel, message] = await Promise.all([
    lastStepInFlight(client, toCancel.id).then(() => client.cancelRun(toCancel.id, "changed my mind")),
    lastStepInFlight(client, toMessage.id).then(() => client.sendMessage(toMessage.id, "one more thing")),
  ]);

  const { run: cancelled } = await waitForStatus(client, toCancel.id, ["completed", "failed", "cancelled"]);
  assert.equal(cancelled.status, "cancelled", "a cancel accepted before the run completed wins");
  const cancelRecords = await fullTimeline(client, toCancel.id);
  assert.equal(cancelRecords.some((r) => r.type === "run.completed"), false);
  assert.equal(cancelRecords.filter((r) => r.type === "model.finished").length, 2, "the cancel was not seen until the last step had finished");
  assert.ok(cancelRecords.some((r) => r.type === "command.applied" && r.data["commandId"] === cancel.id));

  const { run: finished } = await waitForStatus(client, toMessage.id, ["completed", "failed", "cancelled"]);
  assert.equal(finished.status, "completed");
  const messageRecords = await fullTimeline(client, toMessage.id);
  const fate = messageRecords.filter((r) => (r.type === "message.undelivered" || r.type === "command.rejected") && r.data["commandId"] === message.id);
  assert.equal(fate.length, 1, `the timeline says what happened to the message: ${messageRecords.map((r) => r.type).join(", ")}`);

  runner.kill("SIGTERM");
  server.kill("SIGTERM");
  assert.equal((await runner.stopped).code, 0, runner.stderr());
  assert.equal((await server.stopped).code, 0, server.stderr());
  const dbPath = join(dataDir, "runwright.db");
  assert.equal(unconsumed(dbPath, toCancel.id), 0);
  assert.equal(unconsumed(dbPath, toMessage.id), 0);
});
