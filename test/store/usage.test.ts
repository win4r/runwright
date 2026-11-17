import { test } from "node:test";
import assert from "node:assert/strict";
import { openTestStore, testAgentDefinition } from "../helpers/store.ts";
import { createFakeClock } from "../../src/core/clock.ts";
import type { NewUsage } from "../../src/store/types.ts";

const row = (model: string, costMicros: number | null, tokens = 10): NewUsage => ({
  model, purpose: "run", inputTokens: tokens, outputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3, costMicros, assumed: false,
});

test("usageSummary groups by day, agent and model within [from, to)", async (t) => {
  const day1 = Date.UTC(2026, 2, 1, 23, 59);
  const clock = createFakeClock(day1);
  const { store } = await openTestStore(t, { clock });
  await store.saveAgent({ id: "a", definition: testAgentDefinition() });
  await store.saveAgent({ id: "b", definition: testAgentDefinition() });
  await store.createRun({ agentId: "a", input: { message: "", data: null } });
  await store.createRun({ agentId: "b", input: { message: "", data: null } });
  await store.createRun({ agentId: "a", input: { message: "", data: null } });
  const [c1, c2, c3] = await store.claimRuns({ runnerId: "r", limit: 3, leaseMs: 1e9 });
  await store.commit(c1!.lease, { records: [], usage: [row("scripted/scripted-1", 100), row("scripted/unpriced-1", null)] });
  clock.advance(2 * 60_000);
  await store.commit(c2!.lease, { records: [], usage: [row("scripted/scripted-1", 7, 5)] });
  await store.commit(c3!.lease, { records: [], usage: [row("scripted/scripted-1", 1)] });

  assert.deepEqual(await store.usageSummary({ groupBy: "day" }), [
    { key: "2026-03-01", runs: 1, calls: 2, inputTokens: 20, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 6, costMicros: 100, unknownCostCalls: 1 },
    { key: "2026-03-02", runs: 2, calls: 2, inputTokens: 15, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 6, costMicros: 8, unknownCostCalls: 0 },
  ]);
  const byAgent = await store.usageSummary({ groupBy: "agent" });
  assert.deepEqual(byAgent.map((r) => [r.key, r.runs, r.calls, r.costMicros, r.unknownCostCalls]), [["a", 2, 3, 101, 1], ["b", 1, 1, 7, 0]]);
  const byModel = await store.usageSummary({ groupBy: "model" });
  assert.deepEqual(byModel.map((r) => [r.key, r.runs, r.calls, r.costMicros, r.unknownCostCalls]),
    [["scripted/scripted-1", 3, 3, 108, 0], ["scripted/unpriced-1", 1, 1, 0, 1]]);
  assert.deepEqual((await store.usageSummary({ groupBy: "model", agentId: "b" })).map((r) => r.key), ["scripted/scripted-1"]);
  const late = await store.usageSummary({ groupBy: "day", from: day1 + 1 });
  assert.deepEqual(late.map((r) => r.key), ["2026-03-02"]);
  const early = await store.usageSummary({ groupBy: "day", to: day1 + 1 });
  assert.deepEqual(early.map((r) => r.key), ["2026-03-01"]);
  assert.deepEqual(await store.usageSummary({ groupBy: "day", from: day1, to: day1 }), [], "to is exclusive");
});

const MAX = Number.MAX_SAFE_INTEGER;
const big = (inputTokens: number, costMicros: number | null = 1): NewUsage => ({
  model: "scripted/scripted-1", purpose: "run", inputTokens, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros, assumed: false,
});

test("usage totals saturate: two runs reporting 2^53 − 1 and 1 input tokens summarise to 2^53 − 1 by day, agent and model", async (t) => {
  const { store } = await openTestStore(t, { clock: createFakeClock(Date.UTC(2026, 2, 1)) });
  await store.saveAgent({ id: "a", definition: testAgentDefinition() });
  await store.createRun({ agentId: "a", input: { message: "", data: null } });
  await store.createRun({ agentId: "a", input: { message: "", data: null } });
  const [c1, c2] = await store.claimRuns({ runnerId: "r", limit: 2, leaseMs: 1e9 });
  await store.commit(c1!.lease, { records: [], usage: [big(MAX, MAX)] });
  await store.commit(c2!.lease, { records: [], usage: [big(1, 1)] });
  for (const groupBy of ["day", "agent", "model"] as const) {
    const [summary] = await store.usageSummary({ groupBy });
    assert.equal(summary?.inputTokens, MAX, groupBy);
    assert.equal(summary?.costMicros, MAX, groupBy);
    assert.equal(summary?.outputTokens, 2, groupBy);
    assert.equal(summary?.calls, 2, groupBy);
    assert.ok(Number.isSafeInteger(summary?.inputTokens), groupBy);
  }
});

test("usage totals saturate: one run with two commits of 2^53 − 1 and 1 reads back at 2^53 − 1", async (t) => {
  const { store } = await openTestStore(t);
  await store.saveAgent({ id: "a", definition: testAgentDefinition() });
  const { run } = await store.createRun({ agentId: "a", input: { message: "", data: null } });
  const [claim] = await store.claimRuns({ runnerId: "r", limit: 1, leaseMs: 1e9 });
  await store.commit(claim!.lease, { records: [], usage: [big(MAX, MAX)], counters: { toolCalls: MAX, turns: MAX } });
  await store.commit(claim!.lease, { records: [], usage: [big(1, 1)], counters: { toolCalls: 1, turns: 1 } });
  const read = await store.getRun(run.id);
  assert.equal(read?.usage.inputTokens, MAX);
  assert.equal(read?.usage.costMicros, MAX);
  assert.equal(read?.usage.toolCalls, MAX);
  assert.equal(read?.usage.turns, MAX);
  assert.equal(read?.usage.outputTokens, 2);
  const listed = await store.listRuns({}, { limit: 10 });
  assert.equal(listed.items[0]?.usage.inputTokens, MAX);
});

test("usage totals saturate within one batch, and a single row's counts are clamped to integers in range", async (t) => {
  const { store } = await openTestStore(t);
  await store.saveAgent({ id: "a", definition: testAgentDefinition() });
  const { run } = await store.createRun({ agentId: "a", input: { message: "", data: null } });
  const [claim] = await store.claimRuns({ runnerId: "r", limit: 1, leaseMs: 1e9 });
  await store.commit(claim!.lease, { records: [], usage: [big(MAX, MAX), big(MAX, MAX), big(1e300, 1e300), big(-5, 2.5)] });
  const read = await store.getRun(run.id);
  assert.equal(read?.usage.inputTokens, MAX);
  assert.equal(read?.usage.costMicros, MAX);
  const [summary] = await store.usageSummary({ groupBy: "model" });
  assert.equal(summary?.inputTokens, MAX);
  assert.equal(summary?.costMicros, MAX);
  assert.equal(summary?.calls, 4);
});

test("small usage totals stay exact", async (t) => {
  const { store } = await openTestStore(t);
  await store.saveAgent({ id: "a", definition: testAgentDefinition() });
  const { run } = await store.createRun({ agentId: "a", input: { message: "", data: null } });
  const [claim] = await store.claimRuns({ runnerId: "r", limit: 1, leaseMs: 1e9 });
  await store.commit(claim!.lease, { records: [], usage: [big(MAX - 10, 3), big(7, null)] });
  await store.commit(claim!.lease, { records: [], usage: [big(2, 4)] });
  assert.equal((await store.getRun(run.id))?.usage.inputTokens, MAX - 1);
  const [summary] = await store.usageSummary({ groupBy: "agent" });
  assert.deepEqual([summary?.inputTokens, summary?.costMicros, summary?.unknownCostCalls], [MAX - 1, 7, 1]);
});

test("usageSummary bounds that are not integer milliseconds are bad_request", async (t) => {
  const { store } = await openTestStore(t);
  const { isRunwrightError } = await import("../../src/core/errors.ts");
  for (const bound of [Number.NaN, Infinity, 1.5, 2 ** 60]) {
    await assert.rejects(store.usageSummary({ groupBy: "day", from: bound }), (e: unknown) => isRunwrightError(e) && e.code === "bad_request", String(bound));
    await assert.rejects(store.usageSummary({ groupBy: "day", to: bound }), (e: unknown) => isRunwrightError(e) && e.code === "bad_request", String(bound));
  }
  assert.deepEqual(await store.usageSummary({ groupBy: "day", from: -1, to: 0 }), []);
});
