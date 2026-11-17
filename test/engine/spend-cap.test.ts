import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { ModelRef, ModelRegistry, ModelRequest, Pricing } from "../../src/models/types.ts";
import type { JournalRecord, PendingRecord } from "../../src/store/types.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import type { Driver, ModelStepRequest } from "../../src/engine/types.ts";
import { settleAll } from "../../src/engine/control.ts";
import { worstCaseInputTokens } from "../../src/models/util.ts";
import { createHarness, fakeModels, fakePricing, reply, toolReply, type Harness } from "../helpers/engine.ts";
import { waitFor } from "../helpers/wait.ts";

/**
 * The worst case of the first model call of a run of `agentId`, read from the spend_cap pending of a probe run
 * started with a cap of 0 (then cancelled).
 */
async function firstCallWorstCase(h: Harness, agentId: string): Promise<number> {
  const probe = await h.start(agentId, { message: "go" }, { maxCostMicros: 0 });
  await h.until(probe.id, "waiting");
  const [pending] = await h.pendings(probe.id);
  const worst = pending?.detail["nextCallWorstCaseMicros"];
  assert.equal(typeof worst, "number");
  await h.send(probe.id, { type: "cancel", reason: "probe" });
  await h.until(probe.id, "cancelled");
  return worst as number;
}

const noop: ToolDefinition = {
  name: "noop", description: "Does nothing.", parameters: { type: "object", properties: {} }, effect: "read",
  handler: async () => ({ content: "ok" }),
};

test("the run pauses before a call that could exceed the cap and needs exactly neededMicros more", async (t) => {
  let calls = 0;
  const models = fakeModels((request) => {
    calls++;
    return request.meta.turn === 1
      ? { ...toolReply("noop", {}), usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } }
      : reply({ text: "done", usage: { inputTokens: 100, outputTokens: 10 } });
  });
  const h = await createHarness(t, { models, tools: [noop], engine: { defaultMaxOutputTokens: 100 } });
  const agent = await h.saveAgent({ tools: [{ name: "noop" }] });
  // The first call (cost 150) fits; the second, whose request is larger than the first, does not.
  const cap = (await firstCallWorstCase(h, agent.id)) + 149;
  calls = 0;
  const run = await h.start(agent.id, {}, { maxCostMicros: cap });
  await h.until(run.id, "waiting");
  assert.equal(calls, 1, "the second call was not issued");
  const [pending] = await h.pendings(run.id);
  assert.ok(pending !== undefined);
  assert.equal(pending.kind, "spend_cap");
  assert.equal(pending.stepKey, "t2");
  const detail = pending.detail as { capMicros: number; spentMicros: number; neededMicros: number; nextCallWorstCaseMicros: number; reason: string; model: string };
  assert.equal(detail.reason, "cap");
  assert.equal(detail.model, "scripted/scripted-1");
  assert.equal(detail.capMicros, cap);
  assert.equal(detail.spentMicros, 150);
  assert.equal(detail.neededMicros, detail.spentMicros + detail.nextCallWorstCaseMicros - cap);
  assert.ok(detail.neededMicros > 1);

  await h.send(run.id, { type: "limits", limits: { maxCostMicros: cap + detail.neededMicros - 1 } });
  await waitFor(async () => (await h.records(run.id, "pending.opened")).length === 2);
  await h.until(run.id, "waiting");
  const [again] = await h.pendings(run.id);
  assert.equal(again?.detail["neededMicros"], 1);
  assert.equal(calls, 1);

  await h.send(run.id, { type: "limits", limits: { maxCostMicros: cap + detail.neededMicros } });
  const done = await h.until(run.id, "completed");
  assert.equal(calls, 2);
  assert.equal(done.limits.maxCostMicros, cap + detail.neededMicros);
  assert.equal(done.usage.costMicros, 300);
});

test("an unpriced model makes the cost unknown, never 0", async (t) => {
  const h = await createHarness(t, { models: fakeModels(() => reply({ text: "hi", usage: { inputTokens: 50, outputTokens: 5 } })) });
  const agent = await h.saveAgent({ model: { provider: "scripted", name: "unpriced-1" } });
  const run = await h.start(agent.id);
  const done = await h.until(run.id, "completed");
  assert.equal(done.usage.costUnknown, true);
  const [finished] = await h.records(run.id, "model.finished");
  assert.equal(finished?.costMicros, null);
  const [row] = await h.store.usageSummary({ groupBy: "model" });
  assert.equal(row?.key, "scripted/unpriced-1");
  assert.equal(row?.unknownCostCalls, 1);
});

test("with a cap, an unpriced model pauses with unknown_price until allowUnpriced is sent", async (t) => {
  let calls = 0;
  const h = await createHarness(t, { models: fakeModels(() => { calls++; return reply({ text: "hi" }); }) });
  const agent = await h.saveAgent({ model: { provider: "scripted", name: "unpriced-1" } });
  const run = await h.start(agent.id, {}, { maxCostMicros: 1_000_000 });
  await h.until(run.id, "waiting");
  const [pending] = await h.pendings(run.id);
  assert.equal(pending?.kind, "spend_cap");
  assert.equal(pending?.detail["reason"], "unknown_price");
  assert.equal(calls, 0);
  await h.send(run.id, { type: "limits", limits: { maxCostMicros: 2_000_000 } });
  await waitFor(async () => (await h.records(run.id, "pending.opened")).length === 2);
  assert.equal(calls, 0, "raising the cap does not make an unknown price known");
  await h.until(run.id, "waiting");
  await h.send(run.id, { type: "limits", limits: { allowUnpriced: true } });
  const done = await h.until(run.id, "completed");
  assert.equal(calls, 1);
  assert.equal(done.usage.costUnknown, true);
});

test("allowUnpricedModels in the engine config lets unpriced models run under a cap", async (t) => {
  const h = await createHarness(t, { models: fakeModels(() => reply({ text: "hi" })), engine: { allowUnpricedModels: true } });
  const agent = await h.saveAgent({ model: { provider: "scripted", name: "unpriced-1" } });
  const run = await h.start(agent.id, {}, { maxCostMicros: 10 });
  const done = await h.until(run.id, "completed");
  assert.equal(done.usage.costUnknown, true);
});

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

interface Admission { key: string; spent: number; reserved: number; worst: number }

/**
 * Replays the journal's model records in order: the spend so far (finished, invalid and failed calls at their
 * recorded cost, interrupted calls at their assumed cost) and the worst cases of the calls in flight, as each
 * call was admitted.
 */
function admissions(journal: readonly JournalRecord[]): Admission[] {
  const inFlight = new Map<string, number>();
  const out: Admission[] = [];
  let spent = 0;
  for (const record of journal) {
    const key = record.key ?? "";
    if (record.type === "model.started") {
      const worst = record.data["worstCaseMicros"] as number;
      out.push({ key, spent, reserved: [...inFlight.values()].reduce((a, b) => a + b, 0), worst });
      inFlight.set(key, worst);
    } else if (record.type === "model.finished" || record.type === "model.invalid" || record.type === "model.failed") {
      spent += typeof record.data["costMicros"] === "number" ? record.data["costMicros"] : 0;
      inFlight.delete(key);
    } else if (record.type === "model.interrupted") {
      spent += typeof record.data["assumedCostMicros"] === "number" ? record.data["assumedCostMicros"] : 0;
      inFlight.delete(key);
    }
  }
  return out;
}

const groupStep = (text: string, maxOutputTokens = 100): ModelStepRequest => ({
  purpose: "step", system: "s", messages: [{ role: "user", content: text }], maxOutputTokens,
});

/** A provider that waits 30 ms and bills exactly the call's worst case. */
function billingWorstCase(counter: { calls: number }) {
  return fakeModels(async (request) => {
    counter.calls++;
    await new Promise((resolve) => setTimeout(resolve, 30));
    return reply({ text: request.meta.key, usage: { inputTokens: worstCaseInputTokens(request), outputTokens: request.maxOutputTokens } });
  });
}

const threeInParallel: Driver = async (ctx) => {
  const results = await settleAll(["a", "b", "c"].map((k) => ctx.model(k, groupStep(k))));
  return results.map((r) => r.text);
};

const W = fakePricing().worstCaseMicros({ provider: "scripted", name: "scripted-1" },
  worstCaseInputTokens({ system: "s", messages: [{ role: "user", content: "a" }], tools: [], output: null }), 100) as number;

test("parallel calls billed at their full worst case all fit a cap of 3W, and spend stays within it", async (t) => {
  const counter = { calls: 0 };
  const h = await createHarness(t, { models: billingWorstCase(counter), drivers: { agent: threeInParallel } });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id, {}, { maxCostMicros: 3 * W });
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, ["a", "b", "c"]);
  assert.equal(counter.calls, 3);
  assert.equal(done.usage.costMicros, 3 * W, "each call billed exactly W");
  assert.ok(done.usage.costMicros <= 3 * W);
});

test("parallel calls billed at their full worst case: under 3W - 1 only two are issued and spend stays within the cap", async (t) => {
  const counter = { calls: 0 };
  const h = await createHarness(t, { models: billingWorstCase(counter), drivers: { agent: threeInParallel } });
  const agent = await h.saveAgent();
  const cap = 3 * W - 1;
  const run = await h.start(agent.id, {}, { maxCostMicros: cap });
  const waiting = await h.until(run.id, "waiting");
  assert.equal(counter.calls, 2);
  const pendings = await h.pendings(run.id);
  assert.equal(pendings.length, 1);
  assert.equal(pendings[0]?.kind, "spend_cap");
  assert.equal(pendings[0]?.stepKey, "c");
  assert.equal(pendings[0]?.detail["neededMicros"], 1);
  assert.equal(waiting.usage.costMicros, 2 * W);
  assert.ok(waiting.usage.costMicros <= cap);
  for (const admitted of admissions(await h.journal(run.id))) assert.ok(admitted.spent + admitted.reserved + admitted.worst <= cap);
});

test("bound: with calls billed at most their worst case, spend never exceeds the cap, sequentially or in parallel", async (t) => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const random = lcg(seed);
    const models = fakeModels(async (request) => {
      await new Promise((resolve) => setTimeout(resolve, Math.floor(random() * 10)));
      return reply({
        text: "x",
        usage: {
          inputTokens: Math.floor(random() * (worstCaseInputTokens(request) + 1)),
          outputTokens: Math.floor(random() * (request.maxOutputTokens + 1)),
        },
      });
    });
    const maxOut = 50 + seed * 20;
    const driver: Driver = async (ctx) => {
      for (let round = 1; round <= 4; round++) {
        await ctx.model(`s${round}`, groupStep(`sequential turn ${round}`, maxOut));
        await settleAll([1, 2, 3].map((j) => ctx.model(`p${round}.${j}`, groupStep(`branch ${round}.${j}`, maxOut))));
      }
      return "done";
    };
    // Nothing here exercises a takeover, and the exact count of 16 admissions assumes none: with the harness's
    // 300 ms lease, an event-loop stall on a loaded machine lets the runner's own claim pick its run up again and
    // send an in-flight call once more after crash recovery (the bound below still holds then).
    const h = await createHarness(t, { models, drivers: { agent: driver }, engine: { leaseMs: 30_000 } });
    const agent = await h.saveAgent();
    let cap = W * 2 + seed * 300;
    const run = await h.start(agent.id, {}, { maxCostMicros: cap });
    let pauses = 0;
    for (;;) {
      const current = await h.until(run.id, ["waiting", "completed"]);
      assert.ok(current.usage.costMicros <= cap, `seed ${seed}: spend ${current.usage.costMicros} > cap ${cap}`);
      if (current.status === "completed") break;
      pauses++;
      const pending = (await h.pendings(run.id))[0];
      assert.equal(pending?.kind, "spend_cap");
      const needed = pending?.detail["neededMicros"] as number;
      const applied = (await h.records(run.id, "limits.changed")).length;
      cap += needed + Math.floor(random() * W);
      await h.send(run.id, { type: "limits", limits: { maxCostMicros: cap } });
      await waitFor(async () => (await h.records(run.id, "limits.changed")).length > applied);
    }
    assert.ok(pauses >= 1, `seed ${seed}: the cap was reached`);
    const journal = await h.journal(run.id);
    const admitted = admissions(journal);
    assert.equal(admitted.length, 16);
    const caps = journal.filter((r) => r.type === "limits.changed" || r.type === "model.started");
    let effective = W * 2 + seed * 300;
    let i = 0;
    for (const record of caps) {
      if (record.type === "limits.changed") {
        effective = (record.data["limits"] as { maxCostMicros: number }).maxCostMicros;
        continue;
      }
      const call = admitted[i++] as Admission;
      assert.ok(call.spent + call.reserved + call.worst <= effective,
        `seed ${seed}: ${call.key} was admitted with ${call.spent} + ${call.reserved} + ${call.worst} > ${effective}`);
    }
  }
});

test("a provider that bills more than the worst case: the real cost is recorded and the run pauses before its next call", async (t) => {
  let calls = 0;
  const models = fakeModels((request) => {
    calls++;
    if (request.meta.turn > 1) return reply({ text: "done" });
    return { ...toolReply("noop", {}), usage: { inputTokens: worstCaseInputTokens(request) + 500, outputTokens: request.maxOutputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  });
  const h = await createHarness(t, { models, tools: [noop], engine: { defaultMaxOutputTokens: 100 } });
  const agent = await h.saveAgent({ tools: [{ name: "noop" }] });
  const cap = await firstCallWorstCase(h, agent.id);
  calls = 0;
  const run = await h.start(agent.id, {}, { maxCostMicros: cap });
  const waiting = await h.until(run.id, "waiting");
  assert.equal(calls, 1);
  const [started] = await h.records(run.id, "model.started");
  const [finished] = await h.records(run.id, "model.finished");
  assert.equal(started?.worstCaseMicros, cap);
  assert.equal(finished?.costMicros, cap + 500, "the real cost is recorded, not the worst case");
  assert.equal(waiting.usage.costMicros, cap + 500, "spend exceeds the cap by the provider's excess");
  const [pending] = await h.pendings(run.id);
  assert.equal(pending?.kind, "spend_cap");
  assert.equal(pending?.stepKey, "t2");
  const detail = pending?.detail as { spentMicros: number; neededMicros: number; nextCallWorstCaseMicros: number };
  assert.equal(detail.spentMicros, cap + 500);
  assert.equal(detail.neededMicros, detail.spentMicros + detail.nextCallWorstCaseMicros - cap);
});

test("two parallel model calls cannot both pass a cap that fits one", async (t) => {
  const step = (text: string): ModelStepRequest => groupStep(text);
  const worst = W;
  let calls = 0;
  const models = fakeModels(async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 30));
    return reply({ text: "x", usage: { inputTokens: 1, outputTokens: 1 } });
  });
  const driver: Driver = async (ctx) => {
    const [a, b] = await settleAll([ctx.model("a", step("a")), ctx.model("b", step("b"))]);
    return { a: a?.text ?? null, b: b?.text ?? null };
  };
  const h = await createHarness(t, { models, drivers: { agent: driver } });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id, {}, { maxCostMicros: Math.floor(worst * 1.5) });
  await h.until(run.id, "waiting");
  assert.equal(calls, 1);
  const pendings = await h.pendings(run.id);
  assert.equal(pendings.length, 1);
  assert.equal(pendings[0]?.kind, "spend_cap");
  assert.equal(pendings[0]?.stepKey, "b");
  await h.send(run.id, { type: "limits", limits: { maxCostMicros: worst * 3 } });
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, { a: "x", b: "x" });
  assert.equal(calls, 2);
});

/* Finding R04-03: allowing unpriced models never switches off the cap for known costs (invariant B1). */

const PRICED: ModelRef = { provider: "scripted", name: "scripted-1" };
const UNPRICED: ModelRef = { provider: "scripted", name: "unpriced-1" };
const on = (model: ModelRef, text: string): ModelStepRequest => ({ ...groupStep(text), model });

/** Every model answers after `delayMs` with `bill(request)` as usage; provider requests are counted per model name. */
function perModel(bill: (request: ModelRequest) => { inputTokens: number; outputTokens: number }, delayMs = 0) {
  const calls: Record<string, number> = {};
  const models: ModelRegistry = {
    resolve: async (ref) => ({
      generate: async (request: ModelRequest) => {
        calls[ref.name] = (calls[ref.name] ?? 0) + 1;
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        return reply({ text: request.meta.key, usage: bill(request) });
      },
    }),
  };
  return { models, calls };
}

const SMALL = { inputTokens: 10, outputTokens: 2 };
const SMALL_COST = 10 * 1 + 2 * 5;
const billWorstCase = (request: ModelRequest) => ({ inputTokens: worstCaseInputTokens(request), outputTokens: request.maxOutputTokens });

/** Waits for the n-th pending of the run and returns the open one. */
async function nthPending(h: Harness, runId: string, n: number): Promise<PendingRecord> {
  await waitFor(async () => (await h.records(runId, "pending.opened")).length === n);
  await h.until(runId, "waiting");
  const [pending] = await h.pendings(runId);
  assert.ok(pending !== undefined);
  assert.equal(pending.kind, "spend_cap");
  return pending;
}

const unpricedThenPriced: Driver = async (ctx) => {
  const u = await ctx.model("u", on(UNPRICED, "u"));
  const p = await ctx.model("p", on(PRICED, "p"));
  return [u.text, p.text];
};

async function unpricedThenPricedPauses(t: TestContext, allow: { run: boolean; server: boolean }): Promise<void> {
  const { models, calls } = perModel(() => SMALL);
  const h = await createHarness(t, { models, drivers: { agent: unpricedThenPriced }, engine: { allowUnpricedModels: allow.server } });
  const agent = await h.saveAgent();
  const cap = Math.floor(W / 2);
  const run = await h.start(agent.id, {}, { maxCostMicros: cap, ...(allow.run ? { allowUnpriced: true } : {}) });
  const pending = await nthPending(h, run.id, 1);
  assert.deepEqual(calls, { "unpriced-1": 1 }, "the unpriced call was sent, the priced one was not");
  assert.equal(pending.stepKey, "p");
  assert.deepEqual(pending.detail, {
    capMicros: cap, spentMicros: 0, neededMicros: W - cap, nextCallWorstCaseMicros: W, reason: "cap", model: "scripted/scripted-1",
  });
  const needed = W - cap;

  await h.send(run.id, { type: "limits", limits: { maxCostMicros: cap + needed - 1 } });
  const again = await nthPending(h, run.id, 2);
  assert.equal(again.detail["reason"], "cap");
  assert.equal(again.detail["neededMicros"], 1);
  assert.deepEqual(calls, { "unpriced-1": 1 });

  await h.send(run.id, { type: "limits", limits: { maxCostMicros: cap + needed } });
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, ["u", "p"]);
  assert.deepEqual(calls, { "unpriced-1": 1, "scripted-1": 1 });
  assert.equal(done.usage.costUnknown, true);
  assert.equal(done.usage.costMicros, SMALL_COST, "the priced call's cost is still counted");
}

test("allowUnpriced: an unpriced call runs, and a later priced call over the cap pauses with reason cap", async (t) => {
  await unpricedThenPricedPauses(t, { run: true, server: false });
});

test("allowUnpricedModels in the engine config is no bypass of the cap for a priced call either", async (t) => {
  await unpricedThenPricedPauses(t, { run: false, server: true });
});

test("priced then unpriced: the priced cost is recorded, the unpriced call runs while the known spend fits", async (t) => {
  const driver: Driver = async (ctx) => {
    const p = await ctx.model("p", on(PRICED, "p"));
    const u = await ctx.model("u", on(UNPRICED, "u"));
    return [p.text, u.text];
  };
  const { models, calls } = perModel(() => SMALL);
  const h = await createHarness(t, { models, drivers: { agent: driver } });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id, {}, { maxCostMicros: W, allowUnpriced: true });
  const done = await h.until(run.id, "completed");
  assert.deepEqual(calls, { "scripted-1": 1, "unpriced-1": 1 });
  assert.equal(done.usage.costMicros, SMALL_COST);
  assert.equal(done.usage.costUnknown, true);
  assert.equal((await h.records(run.id, "pending.opened")).length, 0);
});

test("priced, unpriced, then a priced call that does not fit: pauses with reason cap before it", async (t) => {
  const driver: Driver = async (ctx) => {
    const out: string[] = [];
    for (const [key, model] of [["p1", PRICED], ["u", UNPRICED], ["p2", PRICED]] as const) out.push((await ctx.model(key, on(model, "x"))).text);
    return out;
  };
  const { models, calls } = perModel(() => SMALL);
  const h = await createHarness(t, { models, drivers: { agent: driver } });
  const agent = await h.saveAgent();
  const cap = W + 5;
  const run = await h.start(agent.id, {}, { maxCostMicros: cap, allowUnpriced: true });
  const pending = await nthPending(h, run.id, 1);
  assert.deepEqual(calls, { "scripted-1": 1, "unpriced-1": 1 });
  assert.equal(pending.stepKey, "p2");
  assert.deepEqual(pending.detail, {
    capMicros: cap, spentMicros: SMALL_COST, neededMicros: SMALL_COST + W - cap, nextCallWorstCaseMicros: W, reason: "cap",
    model: "scripted/scripted-1",
  });
  await h.send(run.id, { type: "limits", limits: { maxCostMicros: SMALL_COST + W } });
  const done = await h.until(run.id, "completed");
  assert.deepEqual(calls, { "scripted-1": 2, "unpriced-1": 1 });
  assert.equal(done.usage.costMicros, 2 * SMALL_COST);
  assert.equal(done.usage.costUnknown, true);
});

test("a run whose known spend is already over the cap pauses even before an allowed unpriced call", async (t) => {
  const driver: Driver = async (ctx) => {
    const p = await ctx.model("p", on(PRICED, "p"));
    const u = await ctx.model("u", on(UNPRICED, "u"));
    return [p.text, u.text];
  };
  // The provider bills 500 micro-dollars more than the priced call's worst case.
  const { models, calls } = perModel((request) => ({ inputTokens: worstCaseInputTokens(request) + 500, outputTokens: request.maxOutputTokens }));
  const h = await createHarness(t, { models, drivers: { agent: driver } });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id, {}, { maxCostMicros: W, allowUnpriced: true });
  const pending = await nthPending(h, run.id, 1);
  assert.deepEqual(calls, { "scripted-1": 1 });
  assert.equal(pending.stepKey, "u");
  assert.deepEqual(pending.detail, {
    capMicros: W, spentMicros: W + 500, neededMicros: 500, nextCallWorstCaseMicros: null, reason: "cap", model: "scripted/unpriced-1",
  });
  assert.match(pending.title, /^Spend cap reached: the next scripted\/unpriced-1 call needs /);
  await h.send(run.id, { type: "limits", limits: { maxCostMicros: W + 500 } });
  const done = await h.until(run.id, "completed");
  assert.deepEqual(calls, { "scripted-1": 1, "unpriced-1": 1 });
  assert.equal(done.usage.costUnknown, true);
});

for (const order of ["in flight together", "unpriced call finished first"] as const) {
  test(`parallel, ${order}: an allowed unpriced call never lets two priced calls pass a cap that fits one`, async (t) => {
    const driver: Driver = async (ctx) => {
      if (order === "unpriced call finished first") {
        await ctx.model("u", on(UNPRICED, "u"));
        const results = await settleAll([ctx.model("a", on(PRICED, "a")), ctx.model("b", on(PRICED, "b"))]);
        return results.map((r) => r.text);
      }
      const results = await settleAll([ctx.model("u", on(UNPRICED, "u")), ctx.model("a", on(PRICED, "a")), ctx.model("b", on(PRICED, "b"))]);
      return results.map((r) => r.text);
    };
    const { models, calls } = perModel(billWorstCase, 30);
    const h = await createHarness(t, { models, drivers: { agent: driver } });
    const agent = await h.saveAgent();
    const run = await h.start(agent.id, {}, { maxCostMicros: W, allowUnpriced: true });
    const waiting = await h.until(run.id, "waiting");
    assert.deepEqual(calls, { "unpriced-1": 1, "scripted-1": 1 }, "one priced call was sent, the other was held");
    const pendings = await h.pendings(run.id);
    assert.equal(pendings.length, 1);
    const pending = pendings[0] as PendingRecord;
    assert.equal(pending.kind, "spend_cap");
    assert.ok(pending.stepKey === "a" || pending.stepKey === "b", String(pending.stepKey));
    assert.equal(pending.detail["reason"], "cap");
    assert.equal(pending.detail["neededMicros"], W);
    assert.ok(waiting.usage.costMicros <= W);
    for (const admitted of admissions(await h.journal(run.id))) assert.ok(admitted.spent + admitted.reserved + admitted.worst <= W);
    await h.send(run.id, { type: "limits", limits: { maxCostMicros: 2 * W } });
    const done = await h.until(run.id, "completed");
    assert.deepEqual(calls, { "unpriced-1": 1, "scripted-1": 2 });
    assert.equal(done.usage.costMicros, 2 * W);
    assert.equal(done.usage.costUnknown, true);
  });
}

test("withdrawing allowUnpriced after an unpriced call: the next priced call pauses with unknown_price", async (t) => {
  const { models, calls } = perModel(() => SMALL);
  const h = await createHarness(t, { models, drivers: { agent: unpricedThenPriced } });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id, {}, { maxCostMicros: W - 1, allowUnpriced: true });
  const capped = await nthPending(h, run.id, 1);
  assert.equal(capped.detail["reason"], "cap");
  await h.send(run.id, { type: "limits", limits: { allowUnpriced: false, maxCostMicros: 1_000_000 } });
  const unknown = await nthPending(h, run.id, 2);
  assert.equal(unknown.stepKey, "p");
  assert.deepEqual(unknown.detail, {
    capMicros: 1_000_000, spentMicros: 0, neededMicros: null, nextCallWorstCaseMicros: W, reason: "unknown_price", model: "scripted/scripted-1",
  });
  assert.deepEqual(calls, { "unpriced-1": 1 });
  await h.send(run.id, { type: "limits", limits: { allowUnpriced: true } });
  const done = await h.until(run.id, "completed");
  assert.deepEqual(calls, { "unpriced-1": 1, "scripted-1": 1 });
  assert.equal(done.usage.costUnknown, true);
});

/** fakePricing, except that the model names in `unpricedAtFirst` have no price until `turnOn(name)`. */
function switchablePricing(unpricedAtFirst: readonly string[]): { pricing: Pricing; turnOn(name: string): void } {
  const base = fakePricing();
  const off = new Set(unpricedAtFirst);
  const known = (ref: { name: string }): boolean => !off.has(ref.name);
  return {
    pricing: {
      priceFor: (ref) => (known(ref) ? base.priceFor(ref) : null),
      costMicros: (ref, usage) => (known(ref) ? base.costMicros(ref, usage) : null),
      worstCaseMicros: (ref, input, maxOut) => (known(ref) ? base.worstCaseMicros(ref, input, maxOut) : null),
    },
    turnOn: (name) => { off.delete(name); },
  };
}

test("a price configured while a run waits on unknown_price: the next check is the ordinary cap check", async (t) => {
  const later: ModelRef = { provider: "scripted", name: "later-1" };
  const switchable = switchablePricing(["later-1"]);
  const driver: Driver = async (ctx) => (await ctx.model("c", on(later, "c"))).text;
  const { models, calls } = perModel(() => SMALL);
  const h = await createHarness(t, { models, drivers: { agent: driver }, pricing: switchable.pricing });
  const agent = await h.saveAgent({ model: later });
  const roomy = await h.start(agent.id, {}, { maxCostMicros: 1_000_000 });
  const tight = await h.start(agent.id, {}, { maxCostMicros: 10 });
  for (const run of [roomy, tight]) {
    const pending = await nthPending(h, run.id, 1);
    assert.equal(pending.detail["reason"], "unknown_price");
    assert.equal(pending.detail["nextCallWorstCaseMicros"], null);
  }
  assert.deepEqual(calls, {}, "nothing was sent while the price was unknown");

  switchable.turnOn("later-1");
  await h.send(roomy.id, { type: "limits", limits: { maxCostMicros: 1_000_001 } });
  await h.send(tight.id, { type: "limits", limits: { maxCostMicros: 11 } });
  const done = await h.until(roomy.id, "completed");
  assert.equal(done.usage.costUnknown, false);
  assert.equal(done.usage.costMicros, SMALL_COST);
  assert.equal(done.limits.allowUnpriced, false);

  const capped = await nthPending(h, tight.id, 2);
  assert.equal(capped.detail["reason"], "cap");
  assert.equal(capped.detail["nextCallWorstCaseMicros"], W);
  assert.equal(capped.detail["neededMicros"], W - 11);
  assert.deepEqual(calls, { "later-1": 1 });
  await h.send(tight.id, { type: "limits", limits: { maxCostMicros: W } });
  const tightDone = await h.until(tight.id, "completed");
  assert.equal(tightDone.usage.costUnknown, false);
  assert.equal(tightDone.usage.costMicros, SMALL_COST);
});

test("a price configured later does not make a past unknown cost known", async (t) => {
  const later: ModelRef = { provider: "scripted", name: "later-2" };
  const switchable = switchablePricing(["later-2"]);
  const driver: Driver = async (ctx) => {
    const out: string[] = [];
    for (const [key, model] of [["u", later], ["p", PRICED], ["v", later]] as const) out.push((await ctx.model(key, on(model, "x"))).text);
    return out;
  };
  const { models, calls } = perModel(() => SMALL);
  const h = await createHarness(t, { models, drivers: { agent: driver }, pricing: switchable.pricing });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id, {}, { maxCostMicros: W - 1, allowUnpriced: true });
  const capped = await nthPending(h, run.id, 1);
  assert.equal(capped.stepKey, "p");
  assert.equal(capped.detail["reason"], "cap");
  assert.deepEqual(calls, { "later-2": 1 });

  switchable.turnOn("later-2");
  await h.send(run.id, { type: "limits", limits: { allowUnpriced: false, maxCostMicros: 1_000_000 } });
  const unknown = await nthPending(h, run.id, 2);
  assert.equal(unknown.stepKey, "p");
  assert.equal(unknown.detail["reason"], "unknown_price");
  assert.equal((await h.store.getRun(run.id))?.usage.costUnknown, true);

  await h.send(run.id, { type: "limits", limits: { allowUnpriced: true, maxCostMicros: W - 1 } });
  const againCapped = await nthPending(h, run.id, 3);
  assert.equal(againCapped.detail["reason"], "cap", "admitted against the cap by its worst case");
  assert.equal(againCapped.detail["neededMicros"], 1);
  assert.deepEqual(calls, { "later-2": 1 });
  // p (W) and then v (now priced, W) must both fit after p's real cost is recorded.
  await h.send(run.id, { type: "limits", limits: { maxCostMicros: SMALL_COST + W } });
  const done = await h.until(run.id, "completed");
  assert.deepEqual(calls, { "later-2": 2, "scripted-1": 1 });
  assert.equal(done.usage.costUnknown, true, "the first call's cost stays unknown");
  assert.equal(done.usage.costMicros, 2 * SMALL_COST, "known costs after the price change are counted");
});
