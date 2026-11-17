/**
 * R13D-engine-02 on real processes: a process is SIGKILLed while a scripted model call is in flight, the run is
 * cancelled while no runner is up, and a runner starts again. The attempt that may have been sent is charged its
 * worst case when the run is claimed, before the cancel is applied, so the usage summary counts it.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { makeTempDir } from "../helpers/tmp.ts";
import { waitFor } from "../helpers/wait.ts";
import { clientOf, startHost } from "../fixtures/process.ts";
import { fullTimeline, scriptedAgent, waitForStatus } from "../fixtures/runs.ts";

test("a model call killed mid-flight and cancelled while down is still charged and counted by /v1/usage", { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t, "runwright-e2e-crash-charge-");
  const dataDir = join(dir, "data");
  const env = { RUNWRIGHT_DATA_DIR: dataDir, HOST_LEASE_MS: "400", HOST_POLL_MS: "40" };

  const first = await startHost(t, env);
  const client = clientOf(first);
  const { agent } = await client.saveAgent(scriptedAgent({
    name: "Crash charge", script: { turns: [{ text: "never seen", delayMs: 20_000 }] },
  }), "crash-charge");
  const { run } = await client.startRun({ agentId: agent.id, message: "think for a long time" });
  await waitFor(async () => (await fullTimeline(client, run.id)).at(-1)?.type === "model.started",
    { timeoutMs: 15_000, intervalMs: 5, message: "the model call never started" });
  first.kill("SIGKILL");
  assert.equal((await first.stopped).signal, "SIGKILL");

  // No runner is up: the cancel only waits in the store.
  const idle = await startHost(t, { ...env, RUNWRIGHT_NO_RUNNER: "1" });
  await clientOf(idle).cancelRun(run.id, "not needed any more");
  idle.kill("SIGTERM");
  await idle.stopped;

  const second = await startHost(t, env);
  const client2 = clientOf(second);
  const { run: done } = await waitForStatus(client2, run.id, ["completed", "failed", "cancelled", "waiting"], 30_000);
  assert.equal(done.status, "cancelled");

  const records = await fullTimeline(client2, run.id);
  const started = records.filter((r) => r.type === "model.started");
  assert.equal(started.length, 1, "the request was not sent again");
  const worst = Number(started[0]?.data["worstCaseMicros"]);
  assert.ok(worst > 0);
  const charges = records.filter((r) => r.type === "model.interrupted");
  assert.deepEqual(charges.map((r) => [r.key, r.data["reason"], r.data["assumedCostMicros"]]), [[started[0]?.key, "crash", worst]]);
  const claims = records.filter((r) => r.type === "run.claimed");
  assert.equal(claims.length, 2);
  const types = records.map((r) => r.type);
  const claimAt = records.indexOf(claims[1] as (typeof records)[number]);
  assert.deepEqual(types.slice(claimAt, claimAt + 3), ["run.claimed", "model.interrupted", "command.applied"]);
  assert.equal(done.usage.costMicros, worst);

  const usage = await client2.usage({ groupBy: "agent", agentId: agent.id });
  const row = usage.rows.find((r) => r.key === agent.id);
  assert.ok(row !== undefined, JSON.stringify(usage));
  assert.equal(row.calls, 1, "the assumed call is counted");
  assert.equal(row.costMicros, worst);
  assert.equal(row.inputTokens, Number(started[0]?.data["inputTokensEstimate"]));
  assert.equal(row.outputTokens, Number(started[0]?.data["maxOutputTokens"]));
});
