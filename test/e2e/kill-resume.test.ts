/**
 * Brief, section 4, "Kill and resume": a real child process running server + runner is SIGKILLed in the middle
 * of a run with observable side effects; a new process on the same data directory finishes the run, and no
 * finished step ran twice.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { makeTempDir } from "../helpers/tmp.ts";
import { waitFor } from "../helpers/wait.ts";
import { clientOf, startHost } from "../fixtures/process.ts";
import { callTurn, duplicateSteps, effectLines, fullTimeline, scriptedAgent, waitForStatus } from "../fixtures/runs.ts";

const LABELS = ["e1", "e2", "e3", "e4", "e5", "e6"];
const FINAL_TEXT = "all six effects recorded";

test("a SIGKILLed process resumes the run on restart without repeating finished steps", { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t, "runwright-e2e-kill-");
  const dataDir = join(dir, "data");
  const effects = join(dir, "effects.txt");
  const env = { RUNWRIGHT_DATA_DIR: dataDir, HOST_EFFECTS_FILE: effects, HOST_LEASE_MS: "400", HOST_POLL_MS: "40" };

  const first = await startHost(t, env);
  const client = clientOf(first);
  const definition = scriptedAgent({
    name: "Kill resume",
    tools: [{ name: "record_effect" }],
    script: {
      turns: [
        ...LABELS.map((label) => callTurn("record_effect", { label }, { delayMs: 250 })),
        { text: FINAL_TEXT, delayMs: 250 },
      ],
    },
  });
  const { agent } = await client.saveAgent(definition, "kill-resume");
  const { run } = await client.startRun({ agentId: agent.id, message: "record the effects" });

  // Kill while the model is "thinking" (inside a model call) after at least two finished tool calls, so the
  // kill never lands between tool.started and tool.finished of the write tool.
  await waitFor(async () => {
    const records = await fullTimeline(client, run.id);
    const finished = records.filter((r) => r.type === "tool.finished").length;
    return finished >= 2 && records.at(-1)?.type === "model.started";
  }, { timeoutMs: 15_000, intervalMs: 5, message: "the run never reached its third model call" });
  first.kill("SIGKILL");
  const exit = await first.stopped;
  assert.equal(exit.signal, "SIGKILL");
  const beforeRestart = await effectLines(effects);
  assert.ok(beforeRestart.length >= 2 && beforeRestart.length < LABELS.length, `effects at kill time: ${beforeRestart.join(",")}`);

  const second = await startHost(t, env);
  const client2 = clientOf(second);
  const { run: done } = await waitForStatus(client2, run.id, ["completed", "failed", "cancelled", "waiting"], 30_000);
  assert.equal(done.status, "completed");
  assert.deepEqual(done.output, { text: FINAL_TEXT });

  assert.deepEqual(await effectLines(effects), LABELS, "each effect exactly once and in order");
  const records = await fullTimeline(client2, run.id);
  assert.deepEqual(duplicateSteps(records, "tool.finished"), []);
  assert.deepEqual(duplicateSteps(records, "model.finished"), []);
  assert.deepEqual(duplicateSteps(records, "tool.started"), [], "no write tool was started twice");
  const claims = records.filter((r) => r.type === "run.claimed").map((r) => r.epoch);
  assert.deepEqual(claims, [1, 2]);
  assert.equal(records.filter((r) => r.type === "run.completed").length, 1);
  assert.equal(records.filter((r) => r.type === "tool.finished").length, LABELS.length);
});
