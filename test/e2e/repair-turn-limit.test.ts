/**
 * R14-02 through the real app: a workflow's parallel group runs two model steps under `maxTurns: 1`. The spend cap
 * makes branch `a` wait before its first call; branch `b` is admitted (it takes the one turn), its reply is invalid
 * and its output repair waits on the cap too. The process is restarted (the runner abandoned, a new app on the same
 * data directory). Once the cap is raised, `b`'s repair still holds the turn it was admitted for, so `a` waits on
 * the turn limit instead of the run finishing with two turns; raising `maxTurns` lets it complete with two.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PendingRecord, RunRecord } from "../../src/store/types.ts";
import { WORKFLOW_FORMAT, type WorkflowDocument } from "../../src/workflow/types.ts";
import { startTestApp, type TestApp } from "../fixtures/app.ts";
import { scriptedAgent } from "../fixtures/runs.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { waitFor } from "../helpers/wait.ts";

const N = { type: "object", required: ["n"], properties: { n: { type: "integer" } }, additionalProperties: false };

const workflow: WorkflowDocument = {
  format: WORKFLOW_FORMAT, name: "two_steps", schemas: { Input: { type: "object" }, Output: {}, N }, input: "Input", output: "Output",
  root: {
    id: "both", kind: "parallel", branches: [
      // A longer prompt: a's first call costs more than b's.
      { id: "a", kind: "model", prompt: `Count the words of this text. ${"lorem ipsum dolor sit amet ".repeat(40)}`, output: "N" },
      { id: "b", kind: "model", prompt: "Count to two.", output: "N" },
    ],
  },
  result: { a: { $ref: "steps.a" }, b: { $ref: "steps.b" } },
};

const usage = { inputTokens: 10, outputTokens: 2 };

const script = {
  steps: { a: { output: { n: 1 }, usage }, b: { output: { n: "two" }, usage } },
  // The repair request carries the problems of the invalid reply.
  variants: [{ when: { contains: "did not match the schema", in: "messages" as const }, steps: { b: { output: { n: 2 }, usage } } }],
};

async function statusOf(app: TestApp, runId: string, statuses: RunRecord["status"][]): Promise<RunRecord> {
  return waitFor(async () => {
    const run = await app.app.store.getRun(runId);
    return run !== null && statuses.includes(run.status) ? run : null;
  }, { timeoutMs: 15_000, intervalMs: 20 });
}

async function pendingsOf(app: TestApp, runId: string): Promise<PendingRecord[]> {
  return (await app.client.listPendings({ runId })).pendings;
}

test("an output repair carried over a restart keeps its turn: the other branch waits on the turn limit", { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t, "runwright-e2e-repair-");
  const first = await startTestApp(t, { dir });
  const { agent } = await first.app.store.saveAgent({ id: "two", definition: { ...scriptedAgent({ name: "Two", script }), workflow } });

  // The worst case of b's first call, read from a probe run with a zero cap.
  const probe = (await first.app.store.createRun({ agentId: agent.id, input: { message: "probe", data: {} }, limits: { maxCostMicros: 0 } })).run;
  await statusOf(first, probe.id, ["waiting"]);
  const probePendings = await waitFor(async () => {
    const open = await pendingsOf(first, probe.id);
    return open.length === 2 ? open : null;
  });
  const worst = (key: RegExp): number => {
    const value = probePendings.find((p) => key.test(p.stepKey))?.detail["nextCallWorstCaseMicros"];
    assert.equal(typeof value, "number");
    return value as number;
  };
  const cap = worst(/(^|\/)b#/);
  assert.ok(worst(/(^|\/)a#/) > cap, "a's first call does not fit the cap");
  await first.client.cancelRun(probe.id);

  const { run } = await first.app.store.createRun({ agentId: agent.id, input: { message: "go", data: {} }, limits: { maxTurns: 1, maxCostMicros: cap } });
  await statusOf(first, run.id, ["waiting"]);
  const before = await waitFor(async () => {
    const open = await pendingsOf(first, run.id);
    return open.length === 2 ? open : null;
  });
  assert.deepEqual(before.map((p) => p.kind), ["spend_cap", "spend_cap"]);
  const journal = await first.app.store.readJournal(run.id, { afterSeq: 0, limit: 10_000 });
  assert.equal(journal.filter((r) => r.type === "model.invalid").length, 1, "b reached its output repair");
  assert.equal(journal.filter((r) => r.type === "model.started").length, 1, "only b's first call was sent");

  assert.ok(first.app.runner !== null);
  await first.app.runner.abandon();
  await first.app.stop({ graceMs: 50 });
  const second = await startTestApp(t, { dir });

  await second.client.setLimits(run.id, { maxCostMicros: cap * 100 });
  const paused = await waitFor(async () => {
    const current = await second.app.store.getRun(run.id);
    if (current?.status !== "waiting") return null;
    const open = await pendingsOf(second, run.id);
    return open.length === 1 && open[0]?.kind === "turn_limit" ? { current, open } : null;
  }, { timeoutMs: 15_000 });
  assert.equal(paused.current.usage.turns, 1, "b's repair finished and counted the one turn");
  assert.match(paused.open[0]?.stepKey ?? "", /(^|\/)a#/, "a waits on the turn limit");
  const afterRestart = await second.app.store.readJournal(run.id, { afterSeq: 0, limit: 10_000 });
  assert.equal(afterRestart.filter((r) => r.type === "model.finished").length, 1);

  await second.client.setLimits(run.id, { maxTurns: 2 });
  const done = await statusOf(second, run.id, ["completed", "failed", "cancelled"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(done.usage.turns, 2);
  assert.deepEqual(done.output, { a: { n: 1 }, b: { n: 2 } });
});
