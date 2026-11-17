/**
 * Brief, section 4, "Spend cap", through the whole app (real pricing, scripted usage): a capped run pauses
 * before the call that could exceed the cap and reports the least extra budget it needs; raising by less keeps
 * it paused, raising by that amount resumes it; an unpriced model's cost is "unknown" (never 0) and, under a
 * cap, pauses with reason "unknown_price" until unpriced models are allowed; allowing them never lets a priced
 * call past the cap (finding R04-03: a priced grader call over the cap is not sent); the overshoot bound holds; and
 * a retried provider attempt is admitted and charged on its own (charged only when it may have been billed).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunwrightClient } from "../../src/client/index.ts";
import { formatCost } from "../../src/models/prices.ts";
import type { PendingRecord } from "../../src/store/types.ts";
import { waitFor } from "../helpers/wait.ts";
import { startTestApp } from "../fixtures/app.ts";
import { callTurn, fullTimeline, scriptedAgent, waitForStatus } from "../fixtures/runs.ts";

const USAGE = { inputTokens: 200, outputTokens: 20 };
const SCRIPT = {
  turns: [
    callTurn("list_files", {}, { usage: USAGE }),
    callTurn("list_files", {}, { usage: USAGE }),
    { text: "spent wisely", usage: USAGE },
  ],
};

async function openCapPending(client: RunwrightClient, runId: string, notId?: string): Promise<PendingRecord> {
  return waitFor(async () => {
    const { run, pendings } = await client.getRun(runId);
    const pending = pendings[0];
    if (run.status !== "waiting" || pending === undefined || pending.id === notId) return null;
    assert.equal(pending.kind, "spend_cap");
    return pending;
  }, { timeoutMs: 10_000, intervalMs: 20, message: "the run did not pause on its cap" });
}

test("a capped run pauses with the minimum needed and resumes when the cap is raised by it", { timeout: 30_000 }, async (t) => {
  const { client } = await startTestApp(t);
  const { agent } = await client.saveAgent(scriptedAgent({
    name: "Capped", tools: [{ name: "list_files" }], model: { maxOutputTokens: 100 }, script: SCRIPT,
  }), "capped");
  const { run } = await client.startRun({ agentId: agent.id, message: "go", limits: { maxCostMicros: 1 } });

  const first = await openCapPending(client, run.id);
  const detail = first.detail;
  assert.equal(detail["reason"], "cap");
  assert.equal(detail["capMicros"], 1);
  assert.equal(detail["spentMicros"], 0);
  const worst = Number(detail["nextCallWorstCaseMicros"]);
  assert.ok(worst > 1);
  assert.equal(detail["neededMicros"], worst - 1, "needed = spent + worst case - cap");

  // One micro-dollar short: the command is applied and the run pauses again without calling the model.
  const short = await client.setLimits(run.id, { maxCostMicros: worst - 1 });
  await waitFor(async () => {
    const records = await fullTimeline(client, run.id);
    const applied = records.some((r) => r.type === "command.applied" && r.data["commandId"] === short.id);
    return applied && (await client.getRun(run.id)).run.status === "waiting";
  }, { timeoutMs: 10_000, intervalMs: 20, message: "the short raise was never applied" });
  const stillOpen = (await client.getRun(run.id)).pendings;
  assert.equal(stillOpen.length, 1);
  assert.equal(stillOpen[0]?.kind, "spend_cap");
  assert.equal(stillOpen[0]?.detail["neededMicros"], 1);
  assert.equal((await fullTimeline(client, run.id)).filter((r) => r.type === "model.finished").length, 0);

  let cap = worst;
  let answered = stillOpen[0]!.id;
  await client.setLimits(run.id, { maxCostMicros: cap });
  let pauses = 1;
  for (;;) {
    const state = await waitFor(async () => {
      const current = await client.getRun(run.id);
      if (["completed", "failed", "cancelled"].includes(current.run.status)) return current;
      const open = current.pendings[0];
      return current.run.status === "waiting" && open !== undefined && open.id !== answered ? current : null;
    }, { timeoutMs: 10_000, intervalMs: 20 });
    if (state.run.status !== "waiting") {
      assert.equal(state.run.status, "completed");
      break;
    }
    const next = state.pendings[0]!;
    const spent = Number(next.detail["spentMicros"]);
    const nextWorst = Number(next.detail["nextCallWorstCaseMicros"]);
    assert.equal(next.detail["capMicros"], cap);
    assert.equal(next.detail["neededMicros"], spent + nextWorst - cap);
    assert.ok(spent <= cap, "it paused before going over the cap");
    cap += Number(next.detail["neededMicros"]);
    answered = next.id;
    pauses += 1;
    await client.setLimits(run.id, { maxCostMicros: cap });
  }
  assert.ok(pauses >= 2, "a later call needed another raise");

  const done = (await client.getRun(run.id)).run;
  assert.deepEqual(done.output, { text: "spent wisely" });
  const records = await fullTimeline(client, run.id);
  const worstCases = records.filter((r) => r.type === "model.started").map((r) => Number(r.data["worstCaseMicros"]));
  const spent = records.filter((r) => r.type === "model.finished").reduce((sum, r) => sum + Number(r.data["costMicros"]), 0);
  assert.equal(spent, done.usage.costMicros);
  assert.equal(spent, 3 * (USAGE.inputTokens * 1 + USAGE.outputTokens * 5), "scripted usage at the scripted-1 price");
  assert.ok(spent <= cap + Math.max(...worstCases), "overshoot bound: spent <= cap + one call's worst case");
  assert.equal(done.usage.costUnknown, false);
});

test("an unpriced model's cost is unknown, and under a cap it pauses until unpriced models are allowed", { timeout: 30_000 }, async (t) => {
  const { client } = await startTestApp(t);
  const { agent } = await client.saveAgent(scriptedAgent({
    name: "Unpriced", tools: [{ name: "list_files" }], model: { name: "unpriced-1", maxOutputTokens: 100 }, script: SCRIPT,
  }), "unpriced");

  const free = (await client.startRun({ agentId: agent.id, message: "go" })).run;
  const { run: uncapped } = await waitForStatus(client, free.id, ["completed", "failed", "waiting"]);
  assert.equal(uncapped.status, "completed");
  assert.equal(uncapped.usage.costUnknown, true);
  assert.equal(formatCost(uncapped.usage.costMicros, uncapped.usage.costUnknown), "unknown");
  const rows = (await client.usage({ groupBy: "model" })).rows;
  const row = rows.find((r) => r.key === "scripted/unpriced-1");
  assert.ok(row !== undefined, JSON.stringify(rows));
  assert.equal(row.unknownCostCalls, 3);

  const capped = (await client.startRun({ agentId: agent.id, message: "go", limits: { maxCostMicros: 1_000_000 } })).run;
  const pending = await openCapPending(client, capped.id);
  assert.equal(pending.detail["reason"], "unknown_price");
  assert.equal((await fullTimeline(client, capped.id)).filter((r) => r.type === "model.started").length, 0);
  await client.setLimits(capped.id, { allowUnpriced: true });
  const { run: allowed } = await waitForStatus(client, capped.id, ["completed", "failed"]);
  assert.equal(allowed.status, "completed");
  assert.equal(allowed.usage.costUnknown, true);
  assert.equal(allowed.limits.allowUnpriced, true);
});

/**
 * Finding R02-01 through the whole app: a provider attempt that failed after it may have been billed is charged
 * its worst case on its own `model.retry`, so a cap that fits exactly one call pauses before the second attempt.
 */
async function worstCaseOfFirstCall(client: RunwrightClient, agentId: string): Promise<number> {
  const probe = (await client.startRun({ agentId, message: "go", limits: { maxCostMicros: 1 } })).run;
  const pending = await openCapPending(client, probe.id);
  await client.cancelRun(probe.id);
  await waitForStatus(client, probe.id, "cancelled");
  return Number(pending.detail["nextCallWorstCaseMicros"]);
}

const REPLY_USAGE = { inputTokens: 100, outputTokens: 10 };
const REPLY_COST = REPLY_USAGE.inputTokens * 1 + REPLY_USAGE.outputTokens * 5;

test("an attempt that failed with uncertain billing is charged, and the next attempt waits for a raised cap", { timeout: 30_000 }, async (t) => {
  const { client } = await startTestApp(t, { configure: (config) => { config.models.retry.baseMs = 5; config.models.retry.maxMs = 20; } });
  const { agent } = await client.saveAgent(scriptedAgent({
    name: "Flaky", model: { maxOutputTokens: 100 },
    script: { turns: [{ text: "made it", usage: REPLY_USAGE, fail: { attempts: 1, status: 503, billing: "unknown" } }] },
  }), "flaky");
  const worst = await worstCaseOfFirstCall(client, agent.id);
  assert.ok(worst > REPLY_COST);

  const { run } = await client.startRun({ agentId: agent.id, message: "go", limits: { maxCostMicros: worst } });
  const pending = await openCapPending(client, run.id);
  assert.equal(pending.detail["reason"], "cap");
  assert.equal(pending.detail["capMicros"], worst);
  assert.equal(pending.detail["spentMicros"], worst, "the failed attempt was charged its worst case");
  assert.equal(pending.detail["neededMicros"], worst, "the next attempt needs one more worst case");
  const paused = await fullTimeline(client, run.id);
  assert.equal(paused.filter((r) => r.type === "model.started").length, 1, "one provider request so far");
  const retries = paused.filter((r) => r.type === "model.retry");
  assert.equal(retries.length, 1);
  assert.equal(retries[0]?.data["billing"], "unknown");
  assert.equal(retries[0]?.data["status"], 503);
  assert.equal(retries[0]?.data["assumedCostMicros"], worst);
  assert.equal((await client.getRun(run.id)).run.usage.costMicros, worst);

  const cap = worst + Number(pending.detail["neededMicros"]);
  await client.setLimits(run.id, { maxCostMicros: cap });
  const { run: done } = await waitForStatus(client, run.id, ["completed", "failed", "cancelled"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.deepEqual(done.output, { text: "made it" });
  assert.equal(done.usage.costMicros, worst + REPLY_COST, "the assumed charge plus the reply");
  assert.ok(done.usage.costMicros <= cap, "never above the cap in force");
  const records = await fullTimeline(client, run.id);
  const started = records.filter((r) => r.type === "model.started");
  assert.deepEqual(started.map((r) => r.data["attempt"]), [1, 2]);
  assert.equal(records.filter((r) => r.type === "model.finished").length, 1);
});

test("an attempt refused with an HTTP status is not charged, so the retry fits under the same cap", { timeout: 30_000 }, async (t) => {
  const { client } = await startTestApp(t, { configure: (config) => { config.models.retry.baseMs = 5; config.models.retry.maxMs = 20; } });
  const { agent } = await client.saveAgent(scriptedAgent({
    name: "Refused", model: { maxOutputTokens: 100 },
    script: { turns: [{ text: "made it", usage: REPLY_USAGE, fail: { attempts: 1, status: 503 } }] },
  }), "refused");
  const worst = await worstCaseOfFirstCall(client, agent.id);

  const { run } = await client.startRun({ agentId: agent.id, message: "go", limits: { maxCostMicros: worst } });
  const { run: done } = await waitForStatus(client, run.id, ["completed", "failed", "cancelled", "waiting"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(done.usage.costMicros, REPLY_COST);
  const records = await fullTimeline(client, run.id);
  const retry = records.find((r) => r.type === "model.retry");
  assert.equal(retry?.data["billing"], "none");
  assert.equal(Object.hasOwn(retry?.data ?? {}, "assumedCostMicros"), false, "nothing assumed for a refused request");
  assert.equal(records.filter((r) => r.type === "model.started").length, 2);
  assert.equal(records.some((r) => r.type === "pending.opened"), false, "it never paused");
});

/**
 * Finding R04-03 through the whole app: the agent runs on an unpriced model with unpriced models allowed, the
 * configured grader model is priced. Allowing unpriced models does not let the grader call past the cap: it is
 * not sent. Under `learning.onLimit: "skip"` the note it would have judged is held for a person; under the
 * default (`"pause"`) the run waits on a spend cap at the grader's step and grades once the cap is raised.
 */
const NOTE_PATH = "notes/build.md";
const NOTE = { path: NOTE_PATH, content: "---\ntitle: Build command\ndescription: How this project builds.\n---\nRun `make all` from the repository root." };
const LEARNER_SCRIPT = { turns: [{ text: "built" }], steps: { "learning.propose": { output: { job_finished: true, files: [NOTE] } } } };
const GRADER_USAGE = { inputTokens: 300, outputTokens: 30 };
const GRADER_SCRIPT = {
  turns: [],
  steps: {
    "learning.grade": {
      output: { job_finished: true, decisions: [{ path: NOTE_PATH, verdict: "keep", reason: "reusable" }] }, usage: GRADER_USAGE,
    },
  },
};

test("an unpriced agent with allowUnpriced and learning.onLimit \"skip\": a priced grader call over the cap is not sent", { timeout: 30_000 }, async (t) => {
  const { client } = await startTestApp(t, {
    configure: (config) => {
      config.learning.graderModel = { provider: "scripted", name: "scripted-1", script: GRADER_SCRIPT };
      config.learning.onLimit = "skip";
    },
  });
  const definition = (name: string) => scriptedAgent({ name, model: { name: "unpriced-1" }, script: LEARNER_SCRIPT, learning: true });
  const roomy = (await client.saveAgent(definition("Roomy builder"), "roomy-builder")).agent;
  const tight = (await client.saveAgent(definition("Tight builder"), "tight-builder")).agent;

  // A cap that fits the grader call: it is sent, its cost is counted and the note becomes active.
  const fits = (await client.startRun({ agentId: roomy.id, message: "build it", limits: { maxCostMicros: 1_000_000, allowUnpriced: true } })).run;
  const { run: fitted } = await waitForStatus(client, fits.id, ["completed", "failed", "waiting"]);
  assert.equal(fitted.status, "completed", JSON.stringify(fitted.error));
  const fitsTimeline = await fullTimeline(client, fits.id);
  const graderStarted = fitsTimeline.filter((r) => r.type === "model.started" && r.data["purpose"] === "grader");
  assert.equal(graderStarted.length, 1);
  assert.equal(graderStarted[0]?.data["model"], "scripted/scripted-1");
  const graderWorst = Number(graderStarted[0]?.data["worstCaseMicros"]);
  assert.ok(graderWorst > 2);
  const graderCost = GRADER_USAGE.inputTokens * 1 + GRADER_USAGE.outputTokens * 5;
  assert.equal(fitted.usage.costMicros, graderCost, "the grader's cost is counted; the unpriced calls count as zero");
  assert.equal(fitted.usage.costUnknown, true);
  const roomyNotes = await client.listLearning({ agentId: roomy.id, kind: "note" });
  assert.deepEqual(roomyNotes.map((n) => [n.name, n.status]), [["build", "active"]]);

  // A cap below the grader call's worst case: the run completes, no grader call is sent, the note is held.
  const cap = Math.floor(graderWorst / 2);
  const capped = (await client.startRun({ agentId: tight.id, message: "build it", limits: { maxCostMicros: cap, allowUnpriced: true } })).run;
  const { run: done } = await waitForStatus(client, capped.id, ["completed", "failed", "waiting"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  const records = await fullTimeline(client, capped.id);
  const started = records.filter((r) => r.type === "model.started");
  assert.ok(started.some((r) => r.data["step"] === "learning.propose"), "the proposal ran on the unpriced agent model");
  assert.equal(started.filter((r) => r.data["purpose"] === "grader").length, 0, "no grader call was sent");
  assert.equal(records.some((r) => r.type === "pending.opened"), false, "learning calls skip on a limit, they do not pause");
  const graded = records.find((r) => r.type === "learning.graded");
  const decisions = (graded?.data["decisions"] ?? []) as { path: string; verdict: string; reason: string }[];
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]?.path, NOTE_PATH);
  assert.equal(decisions[0]?.verdict, "hold");
  assert.match(decisions[0]?.reason ?? "", /the grader could not run \(limit\)/);
  const tightNotes = await client.listLearning({ agentId: tight.id, kind: "note" });
  assert.deepEqual(tightNotes.map((n) => [n.name, n.status]), [["build", "held"]]);
  assert.equal(done.usage.costMicros, 0);
  assert.equal(done.usage.costUnknown, true);
  const rows = (await client.usage({ groupBy: "model", agentId: tight.id })).rows;
  assert.equal(rows.some((r) => r.key === "scripted/scripted-1"), false, JSON.stringify(rows));
  assert.ok(rows.some((r) => r.key === "scripted/unpriced-1"), JSON.stringify(rows));
});

test("an unpriced agent with allowUnpriced, default learning.onLimit: the run waits at the grader's step until the cap is raised", { timeout: 30_000 }, async (t) => {
  const { client } = await startTestApp(t, {
    configure: (config) => { config.learning.graderModel = { provider: "scripted", name: "scripted-1", script: GRADER_SCRIPT }; },
  });
  const agent = (await client.saveAgent(scriptedAgent({ name: "Paused builder", model: { name: "unpriced-1" }, script: LEARNER_SCRIPT, learning: true }), "paused-builder")).agent;
  const { run } = await client.startRun({ agentId: agent.id, message: "build it", limits: { maxCostMicros: 2, allowUnpriced: true } });
  const { run: waiting, pendings } = await waitForStatus(client, run.id, ["completed", "failed", "waiting"]);
  assert.equal(waiting.status, "waiting", JSON.stringify(waiting.error));
  const open = pendings.filter((p) => p.status === "open");
  assert.deepEqual(open.map((p) => [p.kind, p.stepKey]), [["spend_cap", "learning/grade"]]);
  const before = await fullTimeline(client, run.id);
  assert.equal(before.filter((r) => r.type === "model.started" && r.data["purpose"] === "grader").length, 0, "no grader call was sent over the cap");
  assert.ok(before.some((r) => r.type === "run.output"), "the job's output is journalled before learning waits");
  assert.deepEqual((await client.listLearning({ agentId: agent.id, kind: "note" })).length, 0, "nothing is applied while it waits");

  await client.setLimits(run.id, { maxCostMicros: 1_000_000 });
  const { run: done } = await waitForStatus(client, run.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  const after = await fullTimeline(client, run.id);
  assert.equal(after.filter((r) => r.type === "model.started" && r.data["purpose"] === "grader").length, 1, "the grader ran once, after the raise");
  const notes = await client.listLearning({ agentId: agent.id, kind: "note" });
  assert.deepEqual(notes.map((n) => [n.name, n.status]), [["build", "active"]]);
  assert.equal(done.usage.costMicros, GRADER_USAGE.inputTokens * 1 + GRADER_USAGE.outputTokens * 5);
});
