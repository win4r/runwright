/**
 * A `wait` node's deadline across real processes (finding R10-03): the deadline is an instant fixed by the node's
 * journalled start, so it holds when the process that left the run waiting is SIGKILLed and another one starts on
 * the same data directory, whether the instant passed while no host was up or after the new host started. Nobody
 * sends anything: the new host wakes the run, closes the question as expired and fails the run. A second run answered through the API before its instant completes with the answer, and a late
 * answer to the expired question is refused.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { RunwrightError } from "../../src/core/errors.ts";
import type { RunwrightClient } from "../../src/client/index.ts";
import type { PendingRecord } from "../../src/store/types.ts";
import type { WorkflowDocument } from "../../src/workflow/types.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { waitFor } from "../helpers/wait.ts";
import { clientOf, startHost } from "../fixtures/process.ts";
import { fullTimeline, scriptedAgent, waitForStatus } from "../fixtures/runs.ts";

const DEADLINE_MS = 1500;
/** How long after the instant (or after a runner is up again, whichever is later) the run may still be waiting. */
const WAKE_BUDGET_MS = 3000;

const asking: WorkflowDocument = {
  format: "runwright.workflow/v1",
  name: "confirm",
  schemas: { In: { type: "object" }, Out: { type: "string" } },
  input: "In",
  output: "Out",
  root: { id: "ask", kind: "wait", question: "Ship it?", deadlineMs: DEADLINE_MS },
  result: { $ref: "steps.ask.answer" },
};

async function openQuestion(client: RunwrightClient, runId: string): Promise<PendingRecord> {
  const { run, pendings } = await waitForStatus(client, runId, ["waiting", "completed", "failed", "cancelled"], 5000);
  assert.equal(run.status, "waiting");
  assert.equal(pendings.length, 1);
  const pending = pendings[0] as PendingRecord;
  assert.equal(pending.kind, "question");
  return pending;
}

function expiryOf(pending: PendingRecord): number {
  const at = pending.detail["expiresAt"];
  assert.equal(typeof at, "number", "the question carries detail.expiresAt");
  return at as number;
}

test("a wait deadline that passes while the host is down fails the run after the restart with nothing sent; an answer before it completes the run",
  { timeout: 60_000 }, async (t) => {
    const dir = await makeTempDir(t, "runwright-e2e-wait-deadline-");
    const env = { RUNWRIGHT_DATA_DIR: join(dir, "data"), HOST_LEASE_MS: "400", HOST_POLL_MS: "40" };

    const first = await startHost(t, env);
    const client = clientOf(first);
    const { agent } = await client.saveAgent({
      ...scriptedAgent({ name: "Confirmer", script: { turns: [{ text: "unused" }] } }),
      workflow: asking,
    }, "confirmer");

    // One run is answered through the API before its instant and completes with the answer.
    const answered = (await client.startRun({ agentId: agent.id, data: {} })).run;
    const other = await openQuestion(client, answered.id);
    assert.ok(Date.now() < expiryOf(other), "the answer is sent before the instant");
    await client.answer(other.id, "yes");
    const done = await waitForStatus(client, answered.id, ["completed", "failed", "cancelled"], 5000);
    assert.equal(done.run.status, "completed", JSON.stringify(done.run.error));
    assert.equal(done.run.output, "yes");

    const unanswered = (await client.startRun({ agentId: agent.id, data: {} })).run;
    const question = await openQuestion(client, unanswered.id);
    const expiresAt = expiryOf(question);
    const started = (await client.getRun(unanswered.id)).run.startedAt;
    assert.ok(started !== null, "the run has started");
    assert.ok(expiresAt >= unanswered.createdAt + DEADLINE_MS && expiresAt <= Date.now() + DEADLINE_MS,
      `expiresAt ${expiresAt} is the deadline after the node's start (run created ${unanswered.createdAt}, started ${started})`);

    // Right before the kill the first run is still waiting on its open question: the restart is what is tested.
    const beforeKill = await client.getRun(unanswered.id);
    assert.equal(beforeKill.run.status, "waiting");
    assert.deepEqual(beforeKill.pendings.map((p) => p.id), [question.id]);
    first.kill("SIGKILL");
    await first.stopped;

    // The host is down when the instant passes; then a new host starts on the same data directory.
    await waitFor(() => Date.now() > expiresAt + 50, { timeoutMs: DEADLINE_MS + 1000, intervalMs: 20 });
    const second = await startHost(t, env);
    const client2 = clientOf(second);
    const upAt = Date.now();

    const budget = Math.max(expiresAt, upAt) + WAKE_BUDGET_MS - Date.now();
    const failed = await waitForStatus(client2, unanswered.id, ["completed", "failed", "cancelled"], Math.max(budget, 1));
    assert.equal(failed.run.status, "failed");
    assert.deepEqual(failed.run.error, {
      code: "workflow_failed",
      message: 'node "ask" failed: deadline_exceeded: the question was not answered before its deadline',
    });
    const closed = await client2.getPending(question.id);
    assert.equal(closed.status, "resolved");
    assert.deepEqual(closed.resolution, { expired: true, expiresAt });
    const records = await fullTimeline(client2, unanswered.id);
    assert.equal(records.some((r) => r.type === "command.applied"), false, "no command reached the run");
    assert.equal(records.filter((r) => r.type === "pending.resolved").length, 1);

    // A late answer to the expired question is refused.
    await assert.rejects(client2.answer(question.id, "too late"), (error: unknown) =>
      error instanceof RunwrightError && error.code === "pending_not_open" && error.status === 409);
    assert.equal((await client2.getRun(unanswered.id)).run.status, "failed");
  });

test("a wait deadline that passes after the host was restarted fails the run at the instant, not before, with nothing sent",
  { timeout: 60_000 }, async (t) => {
    const deadlineMs = 2500;
    const dir = await makeTempDir(t, "runwright-e2e-wait-deadline-");
    const env = { RUNWRIGHT_DATA_DIR: join(dir, "data"), HOST_LEASE_MS: "400", HOST_POLL_MS: "40" };

    const first = await startHost(t, env);
    const client = clientOf(first);
    const { agent } = await client.saveAgent({
      ...scriptedAgent({ name: "Confirmer", script: { turns: [{ text: "unused" }] } }),
      workflow: { ...asking, root: { ...asking.root, deadlineMs } as WorkflowDocument["root"] },
    }, "confirmer");
    const { run } = await client.startRun({ agentId: agent.id, data: {} });
    const question = await openQuestion(client, run.id);
    const expiresAt = expiryOf(question);
    first.kill("SIGKILL");
    await first.stopped;

    // The process whose timer would have woken the run is gone; the new host only has the stored instant.
    const second = await startHost(t, env);
    const client2 = clientOf(second);
    assert.ok(Date.now() < expiresAt, "the new host is up before the instant");
    assert.equal((await client2.getRun(run.id)).run.status, "waiting");

    const failed = await waitForStatus(client2, run.id, ["completed", "failed", "cancelled"], expiresAt + WAKE_BUDGET_MS - Date.now());
    assert.equal(failed.run.status, "failed");
    assert.equal(failed.run.error?.message, 'node "ask" failed: deadline_exceeded: the question was not answered before its deadline');
    assert.ok(failed.run.finishedAt !== null && failed.run.finishedAt >= expiresAt, `finished ${failed.run.finishedAt} at or after ${expiresAt}`);
    assert.deepEqual((await client2.getPending(question.id)).resolution, { expired: true, expiresAt });
    await assert.rejects(client2.answer(question.id, "too late"), (error: unknown) =>
      error instanceof RunwrightError && error.code === "pending_not_open" && error.status === 409);
  });
