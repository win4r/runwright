/**
 * Finding R01-08 on real hosts: the server deny list is set between a SIGKILL and the restart. The unfinished
 * read-only call would normally be retried by itself; with the tool now denied, the retry is refused before the
 * handler runs, journalled as a denial, and the model receives the denial as the tool result.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { makeTempDir } from "../helpers/tmp.ts";
import { waitFor } from "../helpers/wait.ts";
import { clientOf, startHost } from "../fixtures/process.ts";
import { callTurn, effectLines, fullTimeline, scriptedAgent, waitForStatus } from "../fixtures/runs.ts";

test("a deny list set while the host was down applies to the recovered call", { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t, "runwright-e2e-deny-restart-");
  const effects = join(dir, "effects.txt");
  const env = { RUNWRIGHT_DATA_DIR: join(dir, "data"), HOST_EFFECTS_FILE: effects, HOST_LEASE_MS: "400", HOST_POLL_MS: "40" };

  const first = await startHost(t, env);
  const client = clientOf(first);
  const agent = await client.saveAgent(scriptedAgent({
    name: "Reader", tools: [{ name: "slow_read" }],
    script: { turns: [callTurn("slow_read", { label: "r", ms: 20_000 }), { text: "final: {{last_result}}" }] },
  }), "reader");
  const { run } = await client.startRun({ agentId: agent.agent.id, message: "go" });
  await waitFor(async () => (await effectLines(effects)).includes("start:r"), { timeoutMs: 10_000, intervalMs: 5 });
  first.kill("SIGKILL");
  await first.stopped;

  const second = await startHost(t, { ...env, RUNWRIGHT_DENY_TOOLS: "slow_read" });
  const client2 = clientOf(second);
  const done = await waitForStatus(client2, run.id, ["completed", "failed", "cancelled", "waiting"]);
  assert.equal(done.run.status, "completed");
  const output = done.run.output as { text?: unknown } | null;
  assert.equal(typeof output?.text, "string");
  assert.match(String(output?.text), /^final: tool "slow_read" was denied: /, "the model quoted the denial");

  const records = await fullTimeline(client2, run.id);
  const finished = records.filter((r) => r.type === "tool.finished");
  assert.equal(finished.length, 1);
  assert.equal(finished[0]?.data["outcome"], "denied");
  assert.equal(finished[0]?.data["tool"], "slow_read");
  assert.deepEqual(records.filter((r) => r.type === "tool.started").map((r) => r.data["attempt"]), [1], "no second start was journalled");
  assert.deepEqual(await effectLines(effects), ["start:r"], "the handler did not run again");
});
