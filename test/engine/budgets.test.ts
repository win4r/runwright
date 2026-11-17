import { test } from "node:test";
import assert from "node:assert/strict";
import { isRunwrightError } from "../../src/core/errors.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import type { Driver } from "../../src/engine/types.ts";
import { checkCount, checkSpend, mergeLimits } from "../../src/engine/budget.ts";
import { createHarness, fakeModels, reply, toolReply } from "../helpers/engine.ts";

const noop: ToolDefinition = {
  name: "noop", description: "Does nothing.", parameters: { type: "object", properties: {} }, effect: "read",
  handler: async () => ({ content: "ok" }),
};

/** Calls noop on turns 1 and 2, then finishes. */
const twoToolTurns = fakeModels((request) => (request.meta.turn <= 2 ? toolReply("noop", {}) : reply({ text: "done" })));

test("budget arithmetic", () => {
  assert.deepEqual(checkCount(null, 100), { ok: true });
  assert.deepEqual(checkCount(2, 1), { ok: true });
  assert.deepEqual(checkCount(2, 2), { ok: false, detail: { limit: 2, used: 2, needed: 1 } });
  const base = { capMicros: 100, spentMicros: 40, reservedMicros: 10, worstCaseMicros: 50, costUnknown: false, allowUnpriced: false, model: "m" };
  assert.deepEqual(checkSpend(base), { ok: true });
  const over = checkSpend({ ...base, worstCaseMicros: 51 });
  assert.equal(over.ok, false);
  assert.equal(!over.ok && over.detail["neededMicros"], 1);
  assert.equal(checkSpend({ ...base, capMicros: null, worstCaseMicros: null }).ok, true);
  const unknown = checkSpend({ ...base, worstCaseMicros: null });
  assert.equal(!unknown.ok && unknown.detail["reason"], "unknown_price");
  assert.equal(checkSpend({ ...base, worstCaseMicros: null, allowUnpriced: true }).ok, true);
  assert.deepEqual(checkSpend({ ...base, spentMicros: 95, worstCaseMicros: null, allowUnpriced: true }), {
    ok: false,
    detail: { capMicros: 100, spentMicros: 95, neededMicros: 5, nextCallWorstCaseMicros: null, reason: "cap", model: "m" },
  }, "allowing an unpriced call never admits it while the known spend and reservations are over the cap");
  assert.deepEqual(checkSpend({ ...base, worstCaseMicros: 51, costUnknown: true, allowUnpriced: true }), {
    ok: false,
    detail: { capMicros: 100, spentMicros: 40, neededMicros: 1, nextCallWorstCaseMicros: 51, reason: "cap", model: "m" },
  }, "a priced call of a run whose cost is already unknown is still compared with the cap");
  assert.equal(checkSpend({ ...base, costUnknown: true }).ok, false);
  const limits = { maxCostMicros: null, maxToolCalls: 1, maxTurns: null, allowUnpriced: false };
  assert.deepEqual(mergeLimits(limits, { maxToolCalls: 3 }), { limits: { ...limits, maxToolCalls: 3 } });
  assert.ok("error" in mergeLimits(limits, { maxToolCalls: -1 }));
  assert.ok("error" in mergeLimits(limits, {}));
});

test("the reviewer's probe: allowing unpriced models does not admit a priced call over the cap (R04-03)", () => {
  const check = checkSpend({
    capMicros: 100, spentMicros: 10_000, reservedMicros: 0, worstCaseMicros: 5000, costUnknown: true, allowUnpriced: true, model: "m",
  });
  assert.equal(check.ok, false);
  assert.equal(!check.ok && check.detail["reason"], "cap");
  assert.equal(!check.ok && check.detail["neededMicros"], 14_900);
  assert.equal(!check.ok && check.detail["nextCallWorstCaseMicros"], 5000);
  assert.equal(!check.ok && check.detail["capMicros"], 100);
  assert.equal(!check.ok && check.detail["spentMicros"], 10_000);
});

interface SpendRow {
  costUnknown: boolean; worst: number | null; allowUnpriced: boolean; spent: number; reserved: number;
  ok: boolean; reason?: "cap" | "unknown_price"; needed?: number | null;
}

/**
 * Every combination of costUnknown x next call priced or not x allowUnpriced x the known total fits or not, with a
 * cap of 1000. "Fits" rows sit exactly on the cap; "does not fit" rows are over it by a known amount.
 */
const SPEND_TABLE: SpendRow[] = [
  // Nothing unknown: the plain cap check, whatever allowUnpriced says.
  { costUnknown: false, worst: 500, allowUnpriced: false, spent: 400, reserved: 100, ok: true },
  { costUnknown: false, worst: 501, allowUnpriced: false, spent: 400, reserved: 100, ok: false, reason: "cap", needed: 1 },
  { costUnknown: false, worst: 500, allowUnpriced: true, spent: 400, reserved: 100, ok: true },
  { costUnknown: false, worst: 500, allowUnpriced: true, spent: 400, reserved: 101, ok: false, reason: "cap", needed: 1 },
  // Unpriced next call, the run's cost known so far.
  { costUnknown: false, worst: null, allowUnpriced: false, spent: 0, reserved: 0, ok: false, reason: "unknown_price", needed: null },
  { costUnknown: false, worst: null, allowUnpriced: false, spent: 2000, reserved: 0, ok: false, reason: "unknown_price", needed: null },
  { costUnknown: false, worst: null, allowUnpriced: true, spent: 900, reserved: 100, ok: true },
  { costUnknown: false, worst: null, allowUnpriced: true, spent: 900, reserved: 300, ok: false, reason: "cap", needed: 200 },
  // Priced next call of a run that already has an unknown cost.
  { costUnknown: true, worst: 500, allowUnpriced: false, spent: 0, reserved: 0, ok: false, reason: "unknown_price", needed: null },
  { costUnknown: true, worst: 5000, allowUnpriced: false, spent: 10_000, reserved: 0, ok: false, reason: "unknown_price", needed: null },
  { costUnknown: true, worst: 500, allowUnpriced: true, spent: 300, reserved: 200, ok: true },
  { costUnknown: true, worst: 500, allowUnpriced: true, spent: 300, reserved: 201, ok: false, reason: "cap", needed: 1 },
  // Unpriced next call of a run that already has an unknown cost.
  { costUnknown: true, worst: null, allowUnpriced: false, spent: 0, reserved: 0, ok: false, reason: "unknown_price", needed: null },
  { costUnknown: true, worst: null, allowUnpriced: false, spent: 5000, reserved: 5000, ok: false, reason: "unknown_price", needed: null },
  { costUnknown: true, worst: null, allowUnpriced: true, spent: 1000, reserved: 0, ok: true },
  { costUnknown: true, worst: null, allowUnpriced: true, spent: 1001, reserved: 0, ok: false, reason: "cap", needed: 1 },
];

test("checkSpend over costUnknown x priced next call x allowUnpriced x fits: only the unknown part counts as zero", () => {
  const fits = (r: SpendRow): boolean => r.spent + r.reserved + (r.worst ?? 0) <= 1000;
  const combinations = new Set(SPEND_TABLE.map((r) => `${r.costUnknown}/${r.worst === null}/${r.allowUnpriced}/${fits(r)}`));
  assert.equal(SPEND_TABLE.length, 16);
  assert.equal(combinations.size, 16, "every combination appears exactly once");
  for (const row of SPEND_TABLE) {
    const label = JSON.stringify(row);
    const check = checkSpend({
      capMicros: 1000, spentMicros: row.spent, reservedMicros: row.reserved, worstCaseMicros: row.worst,
      costUnknown: row.costUnknown, allowUnpriced: row.allowUnpriced, model: "p/m",
    });
    if (row.ok) {
      assert.deepEqual(check, { ok: true }, label);
      continue;
    }
    assert.deepEqual(check, {
      ok: false,
      detail: {
        capMicros: 1000, spentMicros: row.spent, neededMicros: row.needed ?? null, nextCallWorstCaseMicros: row.worst,
        reason: row.reason ?? null, model: "p/m",
      },
    }, label);
  }
});

test("without a cap nothing is checked, known or unknown", () => {
  for (const costUnknown of [false, true]) {
    for (const allowUnpriced of [false, true]) {
      for (const worst of [null, 10 ** 12]) {
        assert.deepEqual(checkSpend({
          capMicros: null, spentMicros: 10 ** 12, reservedMicros: 10 ** 12, worstCaseMicros: worst, costUnknown, allowUnpriced, model: "m",
        }), { ok: true });
      }
    }
  }
});

test("the tool-call budget pauses with {limit, used, needed} and resumes when raised", async (t) => {
  let ran = 0;
  const counted: ToolDefinition = { ...noop, handler: async () => { ran++; return { content: "ok" }; } };
  const h = await createHarness(t, { models: twoToolTurns, tools: [counted] });
  const agent = await h.saveAgent({ tools: [{ name: "noop" }], limits: { maxToolCalls: 1 } });
  const run = await h.start(agent.id);
  await h.until(run.id, "waiting");
  const [pending] = await h.pendings(run.id);
  assert.equal(pending?.kind, "tool_budget");
  assert.equal(pending?.stepKey, "t2.c0");
  assert.deepEqual(pending?.detail, { limit: 1, used: 1, needed: 1 });
  assert.equal(ran, 1);
  await h.send(run.id, { type: "limits", limits: { maxToolCalls: 2 } });
  const done = await h.until(run.id, "completed");
  assert.equal(ran, 2);
  assert.equal(done.usage.toolCalls, 2);
  assert.equal(done.limits.maxToolCalls, 2);
  assert.deepEqual((await h.records(run.id, "limits.changed")).map((r) => r.limits.maxToolCalls), [2]);
});

test("the turn limit pauses before the next turn and resumes when raised", async (t) => {
  let calls = 0;
  const models = fakeModels((request) => { calls++; return request.meta.turn === 1 ? toolReply("noop", {}) : reply({ text: "done" }); });
  const h = await createHarness(t, { models, tools: [noop] });
  const agent = await h.saveAgent({ tools: [{ name: "noop" }] });
  const run = await h.start(agent.id, {}, { maxTurns: 1 });
  await h.until(run.id, "waiting");
  const [pending] = await h.pendings(run.id);
  assert.equal(pending?.kind, "turn_limit");
  assert.deepEqual(pending?.detail, { limit: 1, used: 1, needed: 1 });
  assert.equal(calls, 1);
  await h.send(run.id, { type: "limits", limits: { maxTurns: 1 } });
  await h.until(run.id, "waiting");
  assert.equal((await h.records(run.id, "pending.opened")).length, 2, "a limit that is still too low opens a fresh pending");
  await h.send(run.id, { type: "limits", limits: { maxTurns: 2 } });
  const done = await h.until(run.id, "completed");
  assert.equal(done.usage.turns, 2);
});

test('onLimit "skip" throws limit_reached and opens nothing', async (t) => {
  const driver: Driver = async (ctx) => {
    const outcomes: string[] = [];
    for (const step of ["turns", "spend"]) {
      try {
        await ctx.model(step, {
          purpose: step === "turns" ? "run" : "step", system: "s", messages: [{ role: "user", content: "x" }], onLimit: "skip",
        });
        outcomes.push("ran");
      } catch (error) {
        if (!isRunwrightError(error)) throw error;
        outcomes.push(error.code);
      }
    }
    return { outcomes };
  };
  const h = await createHarness(t, { models: fakeModels(() => reply({ text: "x" })), drivers: { agent: driver } });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id, {}, { maxTurns: 0, maxCostMicros: 1 });
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, { outcomes: ["limit_reached", "limit_reached"] });
  assert.equal((await h.records(run.id, "pending.opened")).length, 0);
});

test("an invalid limits command is rejected", async (t) => {
  const h = await createHarness(t, { models: twoToolTurns, tools: [noop] });
  const agent = await h.saveAgent({ tools: [{ name: "noop" }], limits: { maxToolCalls: 0 } });
  const run = await h.start(agent.id);
  await h.until(run.id, "waiting");
  await h.send(run.id, { type: "limits", limits: { maxToolCalls: -3 } });
  await h.until(run.id, "waiting");
  const [rejected] = await h.records(run.id, "command.rejected");
  assert.match(rejected?.reason ?? "", /maxToolCalls must be/);
  assert.equal((await h.pendings(run.id))[0]?.kind, "tool_budget");
});
