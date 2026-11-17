/**
 * Brief, section 4, "Pauses survive restart": runs waiting on a question, an approval and a spend cap are still
 * waiting, with the same pendings, after the process is SIGKILLed and started again; answering, approving and
 * raising the cap then lets each one complete, and the asked and approved effects happen once.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { PendingRecord } from "../../src/store/types.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { waitFor } from "../helpers/wait.ts";
import { clientOf, startHost } from "../fixtures/process.ts";
import { callTurn, effectLines, scriptedAgent, waitForStatus } from "../fixtures/runs.ts";

test("question, approval and spend-cap pauses survive a process restart", { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t, "runwright-e2e-pauses-");
  const dataDir = join(dir, "data");
  const effects = join(dir, "effects.txt");
  const env = { RUNWRIGHT_DATA_DIR: dataDir, HOST_EFFECTS_FILE: effects, HOST_LEASE_MS: "400", HOST_POLL_MS: "40" };

  const first = await startHost(t, env);
  const client = clientOf(first);

  const asker = await client.saveAgent(scriptedAgent({
    name: "Asker",
    tools: [{ name: "ask_person" }, { name: "record_effect" }],
    script: { turns: [
      callTurn("ask_person", { question: "Which colour?" }),
      callTurn("record_effect", { label: "asked:{{last_result}}" }),
      { text: "noted" },
    ] },
  }), "asker");
  const approver = await client.saveAgent(scriptedAgent({
    name: "Approver",
    tools: [{ name: "write_file", policy: "ask" }, { name: "record_effect" }],
    script: { turns: [
      callTurn("write_file", { path: "approved.txt", content: "approved content" }),
      callTurn("record_effect", { label: "approved" }),
      { text: "written" },
    ] },
  }), "approver");
  const capped = await client.saveAgent(scriptedAgent({
    name: "Capped",
    tools: [{ name: "record_effect" }],
    model: { maxOutputTokens: 200 },
    limits: { maxCostMicros: 100 },
    script: { turns: [callTurn("record_effect", { label: "capped" }), { text: "within budget" }] },
  }), "capped");

  const askRun = (await client.startRun({ agentId: asker.agent.id, message: "ask me" })).run;
  const approveRun = (await client.startRun({ agentId: approver.agent.id, message: "write it" })).run;
  const capRun = (await client.startRun({ agentId: capped.agent.id, message: "spend" })).run;

  const kinds = new Map<string, string>([[askRun.id, "question"], [approveRun.id, "approval"], [capRun.id, "spend_cap"]]);
  const before = new Map<string, PendingRecord>();
  for (const [runId, kind] of kinds) {
    const { run, pendings } = await waitForStatus(client, runId, ["waiting", "completed", "failed"]);
    assert.equal(run.status, "waiting");
    assert.equal(pendings.length, 1);
    assert.equal(pendings[0]?.kind, kind);
    before.set(runId, pendings[0]!);
  }
  const listedBefore = (await client.listPendings()).pendings.map((p) => p.id).sort();
  assert.deepEqual(listedBefore, [...before.values()].map((p) => p.id).sort());

  first.kill("SIGKILL");
  await first.stopped;
  const second = await startHost(t, env);
  const client2 = clientOf(second);

  const listedAfter = (await client2.listPendings()).pendings;
  assert.deepEqual(listedAfter.map((p) => p.id).sort(), listedBefore, "the same pendings are listed after the restart");
  for (const runId of kinds.keys()) {
    assert.equal((await client2.getRun(runId)).run.status, "waiting");
  }

  const capPending = before.get(capRun.id)!;
  const needed = Number(capPending.detail["neededMicros"]);
  assert.ok(Number.isInteger(needed) && needed > 0, `neededMicros ${needed}`);
  await client2.answer(before.get(askRun.id)!.id, "teal");
  await client2.approve(before.get(approveRun.id)!.id);
  await client2.setLimits(capRun.id, { maxCostMicros: 100 + needed });

  const asked = await waitForStatus(client2, askRun.id, ["completed", "failed", "cancelled"]);
  assert.equal(asked.run.status, "completed");
  const approved = await waitForStatus(client2, approveRun.id, ["completed", "failed", "cancelled"]);
  assert.equal(approved.run.status, "completed");

  // The cap was raised by exactly what the first call needed; a later call may ask for more again.
  let raisedTo = 100 + needed;
  let answered = capPending.id;
  for (;;) {
    const state = await waitFor(async () => {
      const current = await client2.getRun(capRun.id);
      if (["completed", "failed", "cancelled"].includes(current.run.status)) return current;
      const open = current.pendings[0];
      return current.run.status === "waiting" && open !== undefined && open.id !== answered ? current : null;
    }, { timeoutMs: 15_000, intervalMs: 25, message: "the capped run neither completed nor paused again" });
    if (state.run.status !== "waiting") {
      assert.equal(state.run.status, "completed");
      break;
    }
    const next = state.pendings[0]!;
    assert.equal(next.kind, "spend_cap");
    raisedTo += Number(next.detail["neededMicros"]);
    answered = next.id;
    await client2.setLimits(capRun.id, { maxCostMicros: raisedTo });
  }

  const lines = await effectLines(effects);
  assert.deepEqual(lines.filter((line) => line.startsWith("asked:")), ["asked:teal"]);
  assert.deepEqual(lines.filter((line) => line === "approved"), ["approved"]);
  assert.deepEqual(lines.filter((line) => line === "capped"), ["capped"]);
  const file = await client2.readFile(approveRun.id, "approved.txt");
  assert.equal(new TextDecoder().decode(file.body), "approved content");
});
