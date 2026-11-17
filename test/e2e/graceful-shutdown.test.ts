/**
 * Graceful shutdown (brief 3.10): SIGTERM during a run stops claiming, lets the in-flight step finish or
 * releases the run, closes the server (removing server.json) and the store, and exits 0 within the grace period.
 * A restarted host completes the run without repeating finished steps.
 */
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { makeTempDir } from "../helpers/tmp.ts";
import { waitFor } from "../helpers/wait.ts";
import { clientOf, startHost } from "../fixtures/process.ts";
import { callTurn, duplicateSteps, effectLines, fullTimeline, scriptedAgent, waitForStatus } from "../fixtures/runs.ts";

const LABELS = ["g1", "g2", "g3", "g4"];
const GRACE_MS = 3000;

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

test("SIGTERM releases the run, exits 0 and a restarted host finishes it", { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t, "runwright-e2e-shutdown-");
  const dataDir = join(dir, "data");
  const effects = join(dir, "effects.txt");
  const env = {
    RUNWRIGHT_DATA_DIR: dataDir, HOST_EFFECTS_FILE: effects, HOST_LEASE_MS: "400", HOST_POLL_MS: "40", HOST_GRACE_MS: String(GRACE_MS),
  };

  const first = await startHost(t, env);
  const client = clientOf(first);
  assert.ok(await exists(join(dataDir, "server.json")));
  const { agent } = await client.saveAgent(scriptedAgent({
    name: "Shutdown",
    tools: [{ name: "record_effect" }],
    script: { turns: [...LABELS.map((label) => callTurn("record_effect", { label }, { delayMs: 300 })), { text: "finished", delayMs: 300 }] },
  }), "shutdown");
  const { run } = await client.startRun({ agentId: agent.id, message: "go" });
  await waitFor(async () => (await fullTimeline(client, run.id)).some((r) => r.type === "tool.finished"), {
    timeoutMs: 15_000, intervalMs: 10, message: "the run never finished a tool call",
  });

  const sentAt = Date.now();
  first.kill("SIGTERM");
  const exit = await first.stopped;
  const tookMs = Date.now() - sentAt;
  assert.deepEqual(exit, { code: 0, signal: null }, first.stderr());
  assert.ok(tookMs < GRACE_MS + 1500, `exited after ${tookMs} ms`);
  assert.equal(await exists(join(dataDir, "server.json")), false, "server.json is removed");
  assert.ok(first.stderr().includes("app.stopped"));

  const second = await startHost(t, env);
  const client2 = clientOf(second);
  const released = await fullTimeline(client2, run.id);
  const leftWith = released.filter((r) => ["run.released", "run.completed"].includes(r.type)).map((r) => r.type);
  assert.equal(leftWith.length, 1, `the first host left the run cleanly: ${released.map((r) => r.type).join(",")}`);

  const { run: done } = await waitForStatus(client2, run.id, ["completed", "failed", "cancelled", "waiting"], 20_000);
  assert.equal(done.status, "completed");
  assert.deepEqual(done.output, { text: "finished" });
  assert.deepEqual(await effectLines(effects), LABELS);
  const records = await fullTimeline(client2, run.id);
  assert.deepEqual(duplicateSteps(records, "tool.finished"), []);
  assert.deepEqual(duplicateSteps(records, "tool.started"), []);
  assert.deepEqual(duplicateSteps(records, "model.finished"), []);
  assert.equal(records.filter((r) => r.type === "tool.interrupted").length, 0, "nothing was left half-done");
});
