import { test } from "node:test";
import assert from "node:assert/strict";
import { isRunwrightError } from "../../src/core/errors.ts";
import type { Json } from "../../src/core/json.ts";
import type { GenerateOptions, ModelRequest, ModelResponse } from "../../src/models/types.ts";
import type { Driver, ModelStepRequest } from "../../src/engine/types.ts";
import { settleAll } from "../../src/engine/control.ts";
import { newRecord } from "../../src/engine/journal-types.ts";
import { createHarness, fakeModels, reply, type Harness } from "../helpers/engine.ts";
import { waitFor } from "../helpers/wait.ts";

const answerSchema = { type: "object", required: ["n"], properties: { n: { type: "integer" } }, additionalProperties: false };

function structured(overrides: Partial<ModelStepRequest> = {}): ModelStepRequest {
  return {
    purpose: "step", system: "Count.", messages: [{ role: "user", content: "how many?" }], maxOutputTokens: 100,
    output: { name: "Answer", schema: answerSchema }, ...overrides,
  };
}

const isRepair = (request: ModelRequest): boolean => request.messages.length > 1;

interface Calls { first: number; repair: number }

/**
 * First replies are invalid ({n: "three"}), repairs valid ({n: 3}) unless `repairValid` is false; every call bills
 * 10 input and 2 output tokens (20 micro-dollars). `hang` decides which calls wait until they are aborted.
 */
function repairingModels(calls: Calls, options: { repairValid?: boolean; delayMs?: number; hang?: (request: ModelRequest, calls: Calls) => boolean } = {}) {
  return fakeModels(async (request: ModelRequest, generate: GenerateOptions): Promise<ModelResponse> => {
    if (isRepair(request)) calls.repair++;
    else calls.first++;
    if (options.hang?.(request, calls) === true) {
      await new Promise((_resolve, reject) => generate.signal.addEventListener("abort", () => reject(generate.signal.reason), { once: true }));
    }
    if (options.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    const valid = isRepair(request) && options.repairValid !== false;
    return reply({ output: valid ? { n: 3 } : { n: "three" }, usage: { inputTokens: 10, outputTokens: 2 } });
  });
}

const oneStep: Driver = async (ctx) => (await ctx.model("count", structured())).output;

/** The worst case of the first call of the step at `key`, read from the spend_cap pending of a cancelled probe run (cap 0). */
async function firstCallWorstCase(h: Harness, agentId: string, key = "count"): Promise<number> {
  const probe = await h.start(agentId, { message: "probe" }, { maxCostMicros: 0 });
  await h.until(probe.id, "waiting");
  const pending = (await h.pendings(probe.id)).find((p) => p.stepKey === key);
  const worst = pending?.detail["nextCallWorstCaseMicros"];
  assert.equal(typeof worst, "number");
  await h.send(probe.id, { type: "cancel", reason: "probe" });
  await h.until(probe.id, "cancelled");
  return worst as number;
}

async function modelRecords(h: Harness, runId: string, key: string) {
  return (await h.journal(runId)).filter((r) => r.key === key && r.type.startsWith("model.")).map((r) => r.type);
}

test("a repair that does not fit the cap pauses the run instead of failing it; raising the cap completes it", async (t) => {
  const calls: Calls = { first: 0, repair: 0 };
  const h = await createHarness(t, { models: repairingModels(calls), drivers: { agent: oneStep } });
  const agent = await h.saveAgent();
  const cap = await firstCallWorstCase(h, agent.id);
  const run = await h.start(agent.id, {}, { maxCostMicros: cap });
  const waiting = await h.until(run.id, ["waiting", "failed"]);
  assert.equal(waiting.status, "waiting", "the run waits for budget, it does not fail");
  const pendings = await h.pendings(run.id);
  assert.equal(pendings.length, 1);
  const [pending] = pendings;
  assert.equal(pending?.kind, "spend_cap");
  assert.equal(pending?.stepKey, "count");
  const [invalid] = await h.records(run.id, "model.invalid");
  assert.deepEqual(invalid?.usage, { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 });
  assert.equal(invalid?.costMicros, 20);
  assert.equal(waiting.usage.costMicros, 20, "only the first call was spent");
  assert.deepEqual(calls, { first: 1, repair: 0 });
  const detail = pending?.detail as { neededMicros: number; spentMicros: number; nextCallWorstCaseMicros: number };
  assert.equal(detail.spentMicros, 20);
  assert.ok(detail.nextCallWorstCaseMicros > cap, "the repair request is larger than the first");
  assert.equal(detail.neededMicros, 20 + detail.nextCallWorstCaseMicros - cap);

  await h.send(run.id, { type: "limits", limits: { maxCostMicros: cap + detail.neededMicros - 1 } });
  await waitFor(async () => (await h.records(run.id, "pending.opened")).length === 2);
  await h.until(run.id, "waiting");
  const [again] = await h.pendings(run.id);
  assert.equal(again?.detail["neededMicros"], 1);
  assert.deepEqual(calls, { first: 1, repair: 0 }, "no provider call while the repair does not fit");

  await h.send(run.id, { type: "limits", limits: { maxCostMicros: cap + detail.neededMicros } });
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, { n: 3 });
  assert.deepEqual(calls, { first: 1, repair: 1 }, "the provider was called exactly twice");
  assert.deepEqual(await modelRecords(h, run.id, "count"), ["model.started", "model.invalid", "model.started", "model.finished"]);
  assert.equal(done.usage.costMicros, 40);
});

test("a crash between the phases: the new runner issues only the repair, built from the recorded reply", async (t) => {
  const calls: Calls = { first: 0, repair: 0 };
  const seen: ModelRequest[] = [];
  const models = repairingModels(calls);
  const h = await createHarness(t, {
    models: { resolve: async (ref) => {
      const inner = await models.resolve(ref);
      return { generate: (request, options) => {
        seen.push(request);
        return inner.generate(request, options);
      } };
    } },
    drivers: { agent: oneStep }, autoStart: false,
  });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id);
  // A runner that died right after journalling the invalid first reply.
  const [claimed] = await h.store.claimRuns({ runnerId: "runner_dead", limit: 1, leaseMs: 50 });
  assert.ok(claimed !== undefined);
  const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };
  await h.store.commit(claimed.lease, {
    records: [
      newRecord("run.claimed", { runnerId: "runner_dead" }),
      newRecord("model.started", {
        model: "scripted/scripted-1", purpose: "step", step: null, turn: 1, countsAsTurn: false, inputTokensEstimate: 1100,
        maxOutputTokens: 100, worstCaseMicros: 1600, repair: false,
      }, "count"),
      newRecord("model.invalid", {
        model: "scripted/scripted-1", purpose: "step", text: "", toolCalls: [], output: { n: "three" },
        problems: [{ path: "$.n", message: "must be integer" }], usage, costMicros: 20, durationMs: 1,
      }, "count"),
    ],
    usage: [{ model: "scripted/scripted-1", purpose: "step", ...usage, costMicros: 20, assumed: false }],
  });
  h.runner.start();
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, { n: 3 });
  assert.deepEqual(calls, { first: 0, repair: 1 }, "the first request is never sent again");
  const repair = seen[0]?.messages ?? [];
  assert.deepEqual(repair[1], { role: "assistant", content: '{"n":"three"}', toolCalls: [] });
  assert.match(repair[2]?.content ?? "", /- \$\.n: must be integer/);
  assert.equal(done.usage.costMicros, 40);
  assert.deepEqual((await h.records(run.id, "model.started")).map((r) => r.repair), [false, true]);
});

test("a crash during the repair call is charged the repair's worst case and the repair is issued again", async (t) => {
  const calls: Calls = { first: 0, repair: 0 };
  const h = await createHarness(t, {
    models: repairingModels(calls, { hang: (request, seen) => isRepair(request) && seen.repair === 1 }),
    drivers: { agent: oneStep },
  });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id);
  await waitFor(async () => (await h.records(run.id, "model.started")).length === 2);
  await h.crashAndReplace();
  const done = await h.until(run.id, "completed");
  const started = await h.records(run.id, "model.started");
  assert.deepEqual(started.map((r) => r.repair), [false, true, true]);
  const repairWorst = started[1]?.worstCaseMicros as number;
  assert.ok(repairWorst > (started[0]?.worstCaseMicros as number));
  const [interrupted] = await h.records(run.id, "model.interrupted");
  assert.equal(interrupted?.reason, "crash");
  assert.equal(interrupted?.assumedCostMicros, repairWorst);
  assert.deepEqual(calls, { first: 1, repair: 2 });
  assert.equal(done.usage.costMicros, 20 + repairWorst + 20);
  assert.deepEqual(await modelRecords(h, run.id, "count"),
    ["model.started", "model.invalid", "model.started", "model.interrupted", "model.started", "model.finished"]);
});

test("a repair that is still invalid fails the step with model_output_invalid, charged for both calls; replay rethrows", async (t) => {
  const calls: Calls = { first: 0, repair: 0 };
  const driver: Driver = async (ctx) => {
    let code: Json = null;
    try {
      await ctx.model("count", structured());
    } catch (error) {
      if (!isRunwrightError(error)) throw error;
      code = error.code;
    }
    await ctx.ask("q", { question: "go on?" });
    return { code };
  };
  const h = await createHarness(t, { models: repairingModels(calls, { repairValid: false }), drivers: { agent: driver } });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id);
  const waiting = await h.until(run.id, "waiting");
  const [failed] = await h.records(run.id, "model.failed");
  assert.equal(failed?.error.code, "model_output_invalid");
  assert.match(failed?.error.message ?? "", /"Answer" is invalid after one repair: \$\.n/);
  assert.equal(waiting.usage.costMicros, 40, "both calls are charged");
  assert.equal(waiting.usage.inputTokens, 20);
  const [pending] = await h.pendings(run.id);
  await h.send(run.id, { type: "answer", pendingId: (pending as { id: string }).id, answer: "yes" });
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, { code: "model_output_invalid" });
  assert.deepEqual(calls, { first: 1, repair: 1 }, "the replay did not call the provider");
  assert.equal(done.usage.costMicros, 40);
});

test("onLimit skip: a repair that does not fit throws limit_reached to the caller and opens no pending", async (t) => {
  const calls: Calls = { first: 0, repair: 0 };
  const driver: Driver = async (ctx) => {
    const onLimit = ctx.run.input.message === "probe" ? "pause" : "skip";
    try {
      return (await ctx.model("count", structured({ onLimit }))).output;
    } catch (error) {
      if (!isRunwrightError(error)) throw error;
      return { code: error.code };
    }
  };
  const h = await createHarness(t, { models: repairingModels(calls), drivers: { agent: driver } });
  const agent = await h.saveAgent();
  const cap = await firstCallWorstCase(h, agent.id);
  const run = await h.start(agent.id, {}, { maxCostMicros: cap });
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, { code: "limit_reached" });
  assert.deepEqual(calls, { first: 1, repair: 0 });
  assert.equal((await h.records(run.id, "pending.opened")).length, 0);
  assert.equal(done.usage.costMicros, 20);
});

test("a repair in one parallel branch holds its own reservation: the second branch's repair waits", async (t) => {
  const calls: Calls = { first: 0, repair: 0 };
  const driver: Driver = async (ctx) => {
    const [a, b] = await settleAll([ctx.model("a", structured()), ctx.model("b", structured())]);
    return { a: a?.output ?? null, b: b?.output ?? null };
  };
  const h = await createHarness(t, { models: repairingModels(calls, { delayMs: 30 }), drivers: { agent: driver } });
  const agent = await h.saveAgent();
  const first = await firstCallWorstCase(h, agent.id, "a");
  // Both first calls fit; after them (40 spent) one repair fits but not two.
  const cap = 2 * first;
  const run = await h.start(agent.id, {}, { maxCostMicros: cap });
  await h.until(run.id, "waiting");
  assert.deepEqual(calls, { first: 2, repair: 1 });
  const pendings = await h.pendings(run.id);
  assert.equal(pendings.length, 1);
  assert.equal(pendings[0]?.kind, "spend_cap");
  const blocked = pendings[0]?.stepKey as string;
  assert.ok(blocked === "a" || blocked === "b");
  assert.deepEqual(await modelRecords(h, run.id, blocked), ["model.started", "model.invalid"]);
  const detail = pendings[0]?.detail as { spentMicros: number; neededMicros: number; nextCallWorstCaseMicros: number };
  assert.ok(detail.spentMicros + detail.nextCallWorstCaseMicros <= cap, "the repair alone would fit: the other repair's reservation blocks it");
  await h.send(run.id, { type: "limits", limits: { maxCostMicros: cap * 2 } });
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, { a: { n: 3 }, b: { n: 3 } });
  assert.deepEqual(calls, { first: 2, repair: 2 });
});

test("a step that needed a repair counts one turn", async (t) => {
  const calls: Calls = { first: 0, repair: 0 };
  const driver: Driver = async (ctx) => {
    const counted = await ctx.model("t1", structured({ purpose: "run" }));
    const next = await ctx.model("t2", { purpose: "run", system: "s", messages: [{ role: "user", content: "next" }] });
    return { counted: counted.output, next: next.output };
  };
  const models = fakeModels(async (request) => {
    if (request.meta.key === "t2") return reply({ text: "second" });
    if (isRepair(request)) calls.repair++;
    else calls.first++;
    return reply({ output: isRepair(request) ? { n: 3 } : { n: "three" } });
  });
  const h = await createHarness(t, { models, drivers: { agent: driver } });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id, {}, { maxTurns: 1 });
  const waiting = await h.until(run.id, "waiting");
  assert.deepEqual(calls, { first: 1, repair: 1 });
  assert.equal(waiting.usage.turns, 1);
  const [pending] = await h.pendings(run.id);
  assert.equal(pending?.kind, "turn_limit");
  assert.equal(pending?.stepKey, "t2");
  assert.equal(pending?.detail["used"], 1);
  await h.send(run.id, { type: "limits", limits: { maxTurns: 2 } });
  const done = await h.until(run.id, "completed");
  assert.equal(done.usage.turns, 2);
});
