import { test } from "node:test";
import assert from "node:assert/strict";
import type { JournalRecord, NewJournalRecord, RunLimits } from "../../src/store/types.ts";
import { newRecord } from "../../src/engine/journal-types.ts";
import { applyRecord, createReplayState, latestPending, openPendings, replayJournal } from "../../src/engine/state.ts";
import { settleAll } from "../../src/engine/control.ts";
import type { Driver } from "../../src/engine/types.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import { planCommands } from "../../src/engine/commands.ts";
import { checkSpend, clampTotal, saturatingAdd } from "../../src/engine/budget.ts";
import { createHarness, fakeModels, reply } from "../helpers/engine.ts";
import type { JsonObject } from "../../src/core/json.ts";

const limits: RunLimits = { maxCostMicros: null, maxToolCalls: null, maxTurns: null, allowUnpriced: false };

function journal(records: NewJournalRecord[]): JournalRecord[] {
  return records.map((r, i) => ({ runId: "run_1", seq: i + 1, epoch: 1, ts: 1000 + i, type: r.type, key: r.key ?? null, data: r.data }));
}

const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };
const started = (key: string, countsAsTurn: boolean) => newRecord("model.started", {
  model: "p/m", purpose: "run", step: null, turn: 1, countsAsTurn, inputTokensEstimate: 40, maxOutputTokens: 8, worstCaseMicros: 80,
}, key);
const finished = (key: string, costMicros: number | null) => newRecord("model.finished", {
  model: "p/m", purpose: "run", text: "", toolCalls: [], output: null, stopReason: "end", usage, costMicros, durationMs: 1,
}, key);

test("the reducer totals usage, turns, tool calls and assumed charges", () => {
  const state = replayJournal(journal([
    newRecord("run.created", { agentId: "a", revision: 1, input: { message: "m", data: null }, limits: { ...limits, maxTurns: 4 }, trigger: null }),
    started("t1", true), finished("t1", 20),
    started("x", false), finished("x", null),
    started("t2", true), newRecord("model.interrupted", { model: "p/m", reason: "crash", assumedCostMicros: 80 }, "t2"),
    newRecord("tool.started", { callId: "c", tool: "w", args: {}, effect: "write", attempt: 1 }, "t1.c0"),
    newRecord("tool.started", { callId: "c", tool: "w", args: {}, effect: "write", attempt: 2 }, "t1.c0"),
    newRecord("limits.changed", { limits: { ...limits, maxTurns: 9 } }),
  ]), limits);
  assert.deepEqual(state.usage, {
    inputTokens: 10 + 10 + 40, outputTokens: 2 + 2 + 8, cacheReadTokens: 0, cacheWriteTokens: 0,
    costMicros: 20 + 80, costUnknown: true, toolCalls: 1, turns: 1,
  });
  assert.equal(state.limits.maxTurns, 9);
  assert.equal(state.keys.get("t1.c0")?.lastTool?.seq, 9);
});

test("the reducer charges failed attempts with uncertain billing exactly as the engine's usage rows do", () => {
  const records = journal([
    started("m", false),
    newRecord("model.retry", { attempt: 1, delayMs: 5, code: "model_transient", message: "cut", status: null, billing: "unknown", assumedCostMicros: 80 }, "m"),
    started("m", false),
    newRecord("model.retry", { attempt: 2, delayMs: 10, code: "model_transient", message: "429", status: 429, billing: "none" }, "m"),
    started("m", false),
    newRecord("model.failed", { model: "p/m", error: { code: "model_failed", message: "after 3" }, attempts: 3, assumedCostMicros: 80 }, "m"),
    started("u", false),
    newRecord("model.retry", { attempt: 1, delayMs: 5, code: "model_transient", message: "cut", status: null, billing: "unknown", assumedCostMicros: null }, "u"),
    started("n", false),
    newRecord("model.failed", { model: "p/m", error: { code: "model_failed", message: "400" }, attempts: 1 }, "n"),
  ]);
  const state = replayJournal(records, limits);
  assert.deepEqual(state.usage, {
    inputTokens: 40 * 3, outputTokens: 8 * 3, cacheReadTokens: 0, cacheWriteTokens: 0,
    costMicros: 80 + 80, costUnknown: true, toolCalls: 0, turns: 0,
  });
  assert.equal(state.keys.get("m")?.lastModel?.type, "model.failed");
  assert.equal(state.keys.get("u")?.lastModel?.type, "model.retry", "a round-3 retry record ends an attempt");

  const priced = replayJournal(records.slice(0, 4), limits);
  assert.equal(priced.usage.costMicros, 80, "a refused attempt is not charged");
  assert.equal(priced.usage.costUnknown, false);
});

test("the reducer tracks pendings, approvals, messages, cancel and pause", () => {
  const pending = { id: "p1", kind: "approval" as const, stepKey: "t1.c0", title: "Approve w", detail: { tool: "w", args: {} } };
  const state = replayJournal(journal([
    newRecord("pending.opened", { pending }, "t1.c0"),
    newRecord("command.applied", { commandId: "c1", command: { type: "approve", pendingId: "p1", always: true } }),
    newRecord("pending.resolved", { pendingId: "p1", kind: "approval", resolution: { decision: "approve", always: true, reason: null }, commandId: "c1" }, "t1.c0"),
    newRecord("command.applied", { commandId: "c2", command: { type: "message", text: "hello" } }),
    newRecord("command.applied", { commandId: "c3", command: { type: "message", text: "again" } }),
    newRecord("inbox.taken", { messages: [{ commandId: "c2", text: "hello", at: 1003 }] }, "t2.in"),
    newRecord("command.applied", { commandId: "c4", command: { type: "pause" } }),
    newRecord("command.applied", { commandId: "c5", command: { type: "resume" } }),
    newRecord("command.applied", { commandId: "c6", command: { type: "cancel", reason: "stop" } }),
  ]), limits);
  assert.deepEqual([...state.approvedAlways], ["w"]);
  assert.equal(latestPending(state, "t1.c0", "approval")?.status, "resolved");
  assert.deepEqual(openPendings(state), []);
  assert.deepEqual(state.messages, [{ commandId: "c3", text: "again", at: 1004 }]);
  assert.equal(state.paused, null);
  assert.deepEqual(state.cancelled, { reason: "stop" });
  assert.deepEqual([...state.appliedCommands], ["c1", "c2", "c3", "c4", "c5", "c6"]);
});

test("planCommands resolves pendings once, merges limits and skips applied commands", () => {
  const cap = { id: "p1", kind: "spend_cap" as const, stepKey: "t2", title: "cap", detail: {} };
  const question = { id: "p2", kind: "question" as const, stepKey: "q", title: "q?", detail: {} };
  const state = replayJournal(journal([
    newRecord("pending.opened", { pending: cap }, "t2"),
    newRecord("pending.opened", { pending: question }, "q"),
    newRecord("command.applied", { commandId: "old", command: { type: "message", text: "x" } }),
  ]), limits);
  const at = 0;
  const plan = planCommands(state, [
    { id: "old", runId: "run_1", command: { type: "message", text: "x" }, createdAt: at, consumedAt: null },
    { id: "a", runId: "run_1", command: { type: "answer", pendingId: "p2", answer: "yes" }, createdAt: at, consumedAt: null },
    { id: "b", runId: "run_1", command: { type: "answer", pendingId: "p2", answer: "again" }, createdAt: at, consumedAt: null },
    { id: "c", runId: "run_1", command: { type: "limits", limits: { maxCostMicros: 500 } }, createdAt: at, consumedAt: null },
    { id: "d", runId: "run_1", command: { type: "limits", limits: { maxTurns: 3 } }, createdAt: at, consumedAt: null },
  ]);
  assert.ok(plan !== null);
  assert.deepEqual(plan.batch.consumeCommands, ["a", "b", "c", "d"]);
  assert.deepEqual(plan.batch.records.map((r) => r.type), [
    "command.applied", "pending.resolved", "command.rejected", "command.applied", "limits.changed", "pending.resolved",
    "command.applied", "limits.changed",
  ]);
  assert.deepEqual(plan.batch.setLimits, { maxCostMicros: 500, maxToolCalls: null, maxTurns: 3, allowUnpriced: false });
  assert.deepEqual(plan.batch.resolvePendings?.map((r) => r.id), ["p2", "p1"]);
  assert.equal(planCommands(state, []), null);
});

test("the reducer adds a model.invalid record's usage and cost but counts the turn once, on model.finished", () => {
  const invalid = (costMicros: number | null) => newRecord("model.invalid", {
    model: "p/m", purpose: "run", text: "", toolCalls: [], output: { n: "x" }, problems: [{ path: "$.n", message: "bad" }],
    usage, costMicros, durationMs: 1,
  }, "t1");
  const repaired = replayJournal(journal([started("t1", true), invalid(20), started("t1", true), finished("t1", 20)]), limits);
  assert.deepEqual(repaired.usage, {
    inputTokens: 20, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 40, costUnknown: false, toolCalls: 0, turns: 1,
  });
  assert.equal(repaired.keys.get("t1")?.lastModel?.type, "model.finished");
  const waiting = replayJournal(journal([started("t1", true), invalid(null)]), limits);
  assert.equal(waiting.usage.turns, 0, "an invalid reply alone counts no turn");
  assert.equal(waiting.usage.costUnknown, true);
  assert.equal(waiting.keys.get("t1")?.lastModel?.type, "model.invalid");
});

test("usage totals saturate at Number.MAX_SAFE_INTEGER in the replay state (C9)", () => {
  const MAX = Number.MAX_SAFE_INTEGER;
  const big = (key: string, inputTokens: number, costMicros: number) => newRecord("model.finished", {
    model: "p/m", purpose: "run", text: "", toolCalls: [], output: null, stopReason: "end",
    usage: { inputTokens, outputTokens: inputTokens, cacheReadTokens: inputTokens, cacheWriteTokens: inputTokens }, costMicros, durationMs: 1,
  }, key);
  const state = replayJournal(journal([
    started("a", true), big("a", MAX, MAX),
    started("b", true), big("b", 1, 1),
    started("c", false), newRecord("model.interrupted", { model: "p/m", reason: "crash", assumedCostMicros: 80 }, "c"),
    newRecord("model.failed", { model: "p/m", error: { code: "x", message: "y" }, usage: { inputTokens: MAX, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, costMicros: MAX }, "d"),
  ]), limits);
  assert.equal(state.usage.inputTokens, MAX);
  assert.equal(state.usage.outputTokens, MAX);
  assert.equal(state.usage.cacheReadTokens, MAX);
  assert.equal(state.usage.cacheWriteTokens, MAX);
  assert.equal(state.usage.costMicros, MAX);
  assert.equal(state.usage.turns, 2);
  for (const value of Object.values(state.usage)) if (typeof value === "number") assert.ok(Number.isSafeInteger(value));
});

test("a spend check over a saturated total still reports over, and saturatingAdd stops at the limit", () => {
  const MAX = Number.MAX_SAFE_INTEGER;
  assert.equal(saturatingAdd(MAX, 1), MAX);
  assert.equal(saturatingAdd(MAX - 1, 1), MAX);
  assert.equal(saturatingAdd(2, 3), 5);
  assert.equal(clampTotal(MAX * 4), MAX);
  assert.equal(clampTotal(-3), 0);
  assert.equal(clampTotal(Number.NaN), 0);
  const base = { reservedMicros: 0, costUnknown: false, allowUnpriced: false, model: "p/m" };
  const atCap = checkSpend({ ...base, capMicros: MAX, spentMicros: MAX, worstCaseMicros: 1 });
  assert.equal(atCap.ok, false);
  assert.ok(!atCap.ok && Number.isSafeInteger(atCap.detail["neededMicros"]));
  assert.equal(checkSpend({ ...base, capMicros: MAX, spentMicros: MAX, worstCaseMicros: 0 }).ok, false, "a saturated spend is over even a maximal cap");
  const huge = checkSpend({ ...base, capMicros: 1000, spentMicros: MAX, reservedMicros: MAX, worstCaseMicros: MAX });
  assert.equal(huge.ok, false);
  assert.ok(!huge.ok && huge.detail["neededMicros"] === MAX);
  assert.equal(checkSpend({ ...base, capMicros: MAX, spentMicros: MAX - 10, worstCaseMicros: 10 }).ok, true);
  assert.equal(checkSpend({ ...base, capMicros: MAX, spentMicros: MAX - 10, worstCaseMicros: 11 }).ok, false);
});

test("a provider's oversized usage counts are journalled and totalled as Number.MAX_SAFE_INTEGER", async (t) => {
  const MAX = Number.MAX_SAFE_INTEGER;
  const models = fakeModels(() => reply({ text: "big", usage: { inputTokens: 1e300, outputTokens: MAX * 8, cacheReadTokens: -5, cacheWriteTokens: 2.7 } }));
  const h = await createHarness(t, { models });
  const run = await h.start((await h.saveAgent()).id);
  const done = await h.until(run.id, "completed");
  const [finished] = await h.records(run.id, "model.finished");
  assert.deepEqual(finished?.usage, { inputTokens: MAX, outputTokens: MAX, cacheReadTokens: 0, cacheWriteTokens: 2 });
  assert.ok(typeof finished?.costMicros === "number" && finished.costMicros <= MAX);
  assert.equal(done.usage.inputTokens, MAX);
  assert.equal(done.usage.outputTokens, MAX);
});

// ---------------------------------------------------------------- rule R: lastWriteFinishedSeq

const toolStarted = (key: string, effect: "read" | "write" | null): NewJournalRecord => {
  const data: JsonObject = { callId: key, tool: "t", args: {}, attempt: 1 };
  if (effect !== null) data["effect"] = effect;
  return { type: "tool.started", key, data };
};
const toolFinished = (key: string, outcome: string): NewJournalRecord => newRecord("tool.finished", {
  callId: key, tool: "t", outcome: outcome as "ok", content: "", data: null, isError: false, untrusted: false,
  truncated: false, fullResultPath: null, durationMs: 1,
}, key);

test("lastWriteFinishedSeq is the seq of the latest finish of a call that started as a write", () => {
  const seqOf = (records: NewJournalRecord[]): number => replayJournal(journal(records), limits).lastWriteFinishedSeq;
  assert.equal(seqOf([]), 0, "no finish");
  assert.equal(seqOf([toolStarted("w", "write")]), 0, "started, not finished");
  assert.equal(seqOf([toolStarted("w", "write"), toolFinished("w", "ok")]), 2);
  assert.equal(seqOf([toolStarted("r", "read"), toolFinished("r", "ok")]), 0, "a read does not count");
  assert.equal(seqOf([toolStarted("old", null), toolFinished("old", "ok")]), 2, "a start without effect counts as a write");
  for (const outcome of ["denied", "unknown_tool", "invalid_args", "skipped"]) {
    assert.equal(seqOf([toolFinished("x", outcome)]), 0, `${outcome} with no tool.started does not count`);
  }
  for (const outcome of ["error", "timeout", "aborted", "skipped"]) {
    assert.equal(seqOf([toolStarted("w", "write"), toolFinished("w", outcome)]), 2, `${outcome} of a started write counts`);
  }
  assert.equal(seqOf([
    toolStarted("w", "write"), toolFinished("w", "ok"), toolStarted("r", "read"), toolFinished("r", "ok"), toolFinished("d", "denied"),
  ]), 2, "later reads and finishes without a start leave it");
  assert.equal(seqOf([
    toolStarted("a", "write"), toolStarted("b", "write"), toolFinished("b", "ok"), toolFinished("a", "error"),
  ]), 4, "the highest finish wins");
  assert.equal(seqOf([toolStarted("n/inner", "write"), toolFinished("n/inner", "ok")]), 2, "a nested call counts");
});

test("lastWriteFinishedSeq applied record by record equals the replayed value, and a live session agrees with the replay", async (t) => {
  const records = journal([
    toolStarted("a", "write"), toolStarted("r", "read"), toolFinished("r", "ok"), toolFinished("x", "denied"),
    toolFinished("a", "ok"), toolStarted("b", null), toolFinished("b", "skipped"), toolStarted("c", "write"),
  ]);
  const live = createReplayState(limits);
  const seen: number[] = [];
  for (const record of records) {
    applyRecord(live, record);
    seen.push(live.lastWriteFinishedSeq);
    assert.equal(live.lastWriteFinishedSeq, replayJournal(records.slice(0, record.seq), limits).lastWriteFinishedSeq);
  }
  assert.deepEqual(seen, [0, 0, 0, 0, 5, 5, 7, 7]);

  const tool = (name: string, effect: "read" | "write"): ToolDefinition => ({
    name, description: name, effect, parameters: { type: "object", properties: {} }, handler: async () => ({ content: name }),
  });
  const driver: Driver = async (ctx) => {
    await settleAll([ctx.tool("w1", { name: "w", args: {} }), ctx.tool("r1", { name: "r", args: {} }), ctx.tool("d1", { name: "denied", args: {} })]);
    await ctx.tool("r2", { name: "r", args: {} });
    return null;
  };
  const h = await createHarness(t, {
    models: fakeModels(() => reply({})), tools: [tool("w", "write"), tool("r", "read"), tool("denied", "write")],
    drivers: { agent: driver }, autoStart: false,
  });
  const agent = await h.saveAgent({ tools: [{ name: "w" }, { name: "r" }, { name: "denied", policy: "deny" }] });
  const run = await h.start(agent.id);
  const manual = await h.claimSession();
  await manual.session.done;
  assert.equal((await h.store.getRun(run.id))?.status, "completed");
  const stored = await h.journal(run.id);
  const replayed = replayJournal(stored, limits).lastWriteFinishedSeq;
  const writeFinish = stored.find((r) => r.type === "tool.finished" && r.key === "w1");
  assert.ok(writeFinish !== undefined);
  assert.equal(replayed, writeFinish.seq);
  assert.equal(manual.core.state.lastWriteFinishedSeq, replayed);
});
