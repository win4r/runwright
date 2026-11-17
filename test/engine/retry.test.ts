/**
 * R02-01: every provider attempt is admitted against the cap on its own, journalled as its own model.started and
 * ended by exactly one record that says what it was charged (plan 4.1). The engine owns the attempt loop; the
 * providers here are fakes that count their requests and fail on chosen attempts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RunwrightError, isRunwrightError } from "../../src/core/errors.ts";
import type { JournalRecord, RunLimits, RunRecord, RunStatus } from "../../src/store/types.ts";
import type { ModelRef, ModelRequest, ModelRetry } from "../../src/models/types.ts";
import { worstCaseInputTokens } from "../../src/models/util.ts";
import { isControlSignal, settleAll } from "../../src/engine/control.ts";
import { modelResumePoint } from "../../src/engine/context.ts";
import { newRecord } from "../../src/engine/journal-types.ts";
import { replayJournal } from "../../src/engine/state.ts";
import type { Driver, ModelStepRequest } from "../../src/engine/types.ts";
import type { JsonSchema } from "../../src/schema/validate.ts";
import { createHarness, fakeModels, fakePricing, reply, type Harness } from "../helpers/engine.ts";
import { waitFor } from "../helpers/wait.ts";

const REF: ModelRef = { provider: "scripted", name: "scripted-1" };
const pricing = fakePricing();
const STEP: ModelStepRequest = { purpose: "step", system: "s", messages: [{ role: "user", content: "go" }], maxOutputTokens: 100 };
/** The worst case of one attempt of STEP. */
const W = pricing.worstCaseMicros(REF, worstCaseInputTokens({ system: "s", messages: STEP.messages, tools: [], output: null }), 100) as number;
const REPLY_USAGE = { inputTokens: 10, outputTokens: 2 };
const REPLY_COST = 10 * 1 + 2 * 5;

const uncertain = (code: "model_transient" | "model_failed" = "model_transient"): RunwrightError =>
  new RunwrightError(code, "the stream ended before it finished", { details: { status: null, retryAfterMs: null, billing: "unknown" } });
const refused = (status: number): RunwrightError =>
  new RunwrightError(status === 400 ? "model_failed" : "model_transient", `HTTP ${status}`, { details: { status, retryAfterMs: null, billing: "none" } });

const instant = (maxAttempts = 3): ModelRetry => ({ policy: { maxAttempts, baseMs: 10, maxMs: 100 }, random: () => 0, sleep: async () => undefined });

/** A retry runtime whose wait only ends when it is aborted. */
function blockingRetry(sleeps: number[]): ModelRetry {
  return {
    policy: { maxAttempts: 3, baseMs: 10, maxMs: 100 },
    random: () => 0,
    sleep: (ms, signal) => new Promise((_resolve, reject) => {
      sleeps.push(ms);
      if (signal.aborted) reject(new Error("wait aborted"));
      else signal.addEventListener("abort", () => reject(new Error("wait aborted")), { once: true });
    }),
  };
}

/** A provider that fails attempt n with `failures[n - 1]` (when set) and otherwise replies. */
function scriptedFailures(failures: (RunwrightError | null)[], retry?: ModelRetry) {
  const attempts: number[] = [];
  const models = fakeModels((request) => {
    attempts.push(request.meta.attempt);
    const failure = failures[request.meta.attempt - 1];
    if (failure !== undefined && failure !== null) throw failure;
    return reply({ text: `attempt ${request.meta.attempt}`, usage: REPLY_USAGE });
  }, retry);
  return { models, attempts };
}

const oneStep: Driver = async (ctx) => (await ctx.model("m", STEP)).text;

function usageRows(h: Harness, runId: string): { assumed: number; costMicros: number | null }[] {
  const db = new DatabaseSync(join(h.dir, "runwright.db"), { readOnly: true });
  try {
    return db.prepare("SELECT assumed, cost_micros FROM usage WHERE run_id = ? ORDER BY rowid").all(runId)
      .map((row) => ({ assumed: Number(row["assumed"]), costMicros: row["cost_micros"] === null ? null : Number(row["cost_micros"]) }));
  } finally {
    db.close();
  }
}

function modelTrace(journal: readonly JournalRecord[]): [string, number | null][] {
  return journal.filter((r) => r.type.startsWith("model.")).map((r) => [r.type, (r.data["attempt"] ?? r.data["attempts"] ?? null) as number | null]);
}

test("the reviewer's probe: a cap that fits one call, attempt 1 fails with uncertain billing → charged, paused, one request; raising the cap sends attempt 2", async (t) => {
  const { models, attempts } = scriptedFailures([uncertain()], instant());
  const h = await createHarness(t, { models, drivers: { agent: oneStep } });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id, {}, { maxCostMicros: W });

  const waiting = await h.until(run.id, "waiting");
  assert.deepEqual(attempts, [1], "the provider was called once");
  assert.deepEqual(await h.records(run.id, "model.retry"), [{
    attempt: 1, delayMs: 5, code: "model_transient", message: "the stream ended before it finished", status: null,
    billing: "unknown", assumedCostMicros: W,
  }]);
  const [pending] = await h.pendings(run.id);
  assert.equal(pending?.kind, "spend_cap");
  assert.equal(pending?.stepKey, "m");
  assert.equal(pending?.detail["spentMicros"], W);
  assert.equal(pending?.detail["neededMicros"], W, "spent W + next attempt W - cap W");
  assert.equal(waiting.usage.costMicros, W);
  assert.ok(waiting.usage.costMicros <= W);

  await h.send(run.id, { type: "limits", limits: { maxCostMicros: 2 * W } });
  const done = await h.until(run.id, "completed");
  assert.deepEqual(attempts, [1, 2]);
  assert.equal(done.output, "attempt 2");
  assert.equal(done.usage.costMicros, W + REPLY_COST);
  assert.ok(done.usage.costMicros <= 2 * W);
  const started = await h.records(run.id, "model.started");
  assert.deepEqual(started.map((s) => s.attempt), [1, 2]);
  assert.deepEqual(usageRows(h, run.id), [{ assumed: 1, costMicros: W }, { assumed: 0, costMicros: REPLY_COST }]);
});

test("failures the provider refused with an HTTP status are retried under a cap that fits one call and charged nothing", async (t) => {
  const { models, attempts } = scriptedFailures([refused(429), refused(503)], instant());
  const h = await createHarness(t, { models, drivers: { agent: oneStep } });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id, {}, { maxCostMicros: W });
  const done = await h.until(run.id, "completed");
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.equal(done.usage.costMicros, REPLY_COST);
  const retries = await h.records(run.id, "model.retry");
  assert.deepEqual(retries.map((r) => [r.attempt, r.status, r.billing]), [[1, 429, "none"], [2, 503, "none"]]);
  for (const retry of retries) assert.equal(Object.hasOwn(retry, "assumedCostMicros"), false);
  assert.deepEqual(retries.map((r) => r.delayMs), [5, 10], "capped exponential backoff");
  assert.deepEqual(usageRows(h, run.id), [{ assumed: 0, costMicros: REPLY_COST }]);
});

test("exhausted retries: model.failed {attempts: 3}, three assumed charges, the run fails with the documented message", async (t) => {
  const { models, attempts } = scriptedFailures([uncertain(), uncertain(), uncertain()], instant(3));
  const h = await createHarness(t, { models, drivers: { agent: oneStep } });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id);
  const failed = await h.until(run.id, "failed");
  assert.deepEqual(attempts, [1, 2, 3]);
  const message = "model call failed after 3 attempts (last error: no status): the stream ended before it finished";
  assert.deepEqual(await h.records(run.id, "model.failed"), [{
    model: "scripted/scripted-1", error: { code: "model_failed", message }, attempts: 3, assumedCostMicros: W,
  }]);
  assert.equal(failed.error?.code, "model_failed");
  assert.equal(failed.error?.message, message);
  assert.equal(failed.usage.costMicros, 3 * W);
  assert.deepEqual(usageRows(h, run.id), [1, 2, 3].map(() => ({ assumed: 1, costMicros: W })));
  assert.deepEqual(modelTrace(await h.journal(run.id)), [
    ["model.started", 1], ["model.retry", 1], ["model.started", 2], ["model.retry", 2], ["model.started", 3], ["model.failed", 3],
  ]);
});

test("exhausted retries name the last status", async (t) => {
  const { models } = scriptedFailures([refused(503), refused(529)], instant(2));
  const h = await createHarness(t, { models, drivers: { agent: oneStep } });
  const run = await h.start((await h.saveAgent()).id);
  const failed = await h.until(run.id, "failed");
  assert.equal(failed.error?.message, "model call failed after 2 attempts (last error: status 529): HTTP 529");
  assert.equal(failed.usage.costMicros, 0);
  const [record] = await h.records(run.id, "model.failed");
  assert.equal(record?.attempts, 2);
  assert.equal(Object.hasOwn(record ?? {}, "assumedCostMicros"), false);
});

test("without a retry runtime a model call is one attempt: a transient failure fails after 1 attempt", async (t) => {
  const { models, attempts } = scriptedFailures([refused(503)]);
  const h = await createHarness(t, { models, drivers: { agent: oneStep } });
  const run = await h.start((await h.saveAgent()).id);
  const failed = await h.until(run.id, "failed");
  assert.deepEqual(attempts, [1]);
  assert.equal(failed.error?.message, "model call failed after 1 attempt (last error: status 503): HTTP 503");
});

test("a non-retry failure after the reply started is charged its worst case; one the provider refused is not", async (t) => {
  const broken = scriptedFailures([uncertain("model_failed")], instant());
  const h = await createHarness(t, { models: broken.models, drivers: { agent: oneStep } });
  const run = await h.start((await h.saveAgent()).id);
  const failed = await h.until(run.id, "failed");
  assert.deepEqual(broken.attempts, [1], "not retried");
  assert.deepEqual(await h.records(run.id, "model.failed"), [{
    model: "scripted/scripted-1", error: { code: "model_failed", message: "the stream ended before it finished" }, attempts: 1, assumedCostMicros: W,
  }]);
  assert.equal(failed.usage.costMicros, W);
  assert.deepEqual(usageRows(h, run.id), [{ assumed: 1, costMicros: W }]);

  const rejected = scriptedFailures([refused(400)], instant());
  const h2 = await createHarness(t, { models: rejected.models, drivers: { agent: oneStep } });
  const run2 = await h2.start((await h2.saveAgent()).id);
  const failed2 = await h2.until(run2.id, "failed");
  assert.deepEqual(rejected.attempts, [1]);
  const [record] = await h2.records(run2.id, "model.failed");
  assert.deepEqual(record, { model: "scripted/scripted-1", error: { code: "model_failed", message: "HTTP 400" }, attempts: 1 });
  assert.equal(failed2.usage.costMicros, 0);
  assert.deepEqual(usageRows(h2, run2.id), []);
});

test("a failure that is not a RunwrightError is treated as possibly billed", async (t) => {
  const models = fakeModels(() => {
    throw new Error("the provider broke");
  }, instant());
  const h = await createHarness(t, { models, drivers: { agent: oneStep } });
  const run = await h.start((await h.saveAgent()).id);
  const failed = await h.until(run.id, "failed");
  assert.equal(failed.usage.costMicros, W);
  assert.equal((await h.records(run.id, "model.failed"))[0]?.assumedCostMicros, W);
});

test("a crash while waiting between attempts: the new runner sends attempt 2, attempt 1 is not sent again and is charged once", async (t) => {
  const sleeps: number[] = [];
  const { models, attempts } = scriptedFailures([uncertain()], blockingRetry(sleeps));
  const h = await createHarness(t, { models, drivers: { agent: oneStep } });
  const run = await h.start((await h.saveAgent()).id);
  await waitFor(async () => (await h.records(run.id, "model.retry")).length === 1);
  await waitFor(async () => sleeps.length === 1);
  await h.crashAndReplace();
  const done = await h.until(run.id, "completed");
  assert.deepEqual(attempts, [1, 2]);
  assert.equal(done.output, "attempt 2");
  assert.equal(done.usage.costMicros, W + REPLY_COST);
  assert.equal((await h.records(run.id, "model.retry")).length, 1);
  assert.equal((await h.records(run.id, "model.interrupted")).length, 0, "nothing was in flight");
  assert.deepEqual(usageRows(h, run.id), [{ assumed: 1, costMicros: W }, { assumed: 0, costMicros: REPLY_COST }]);
  assert.deepEqual(modelTrace(await h.journal(run.id)), [["model.started", 1], ["model.retry", 1], ["model.started", 2], ["model.finished", null]]);
});

test("a crash while attempt 2 is in flight: it is charged its worst case once and attempt 2 is sent again", async (t) => {
  const attempts: number[] = [];
  let hung = false;
  const models = fakeModels((request, options) => {
    attempts.push(request.meta.attempt);
    if (request.meta.attempt === 1) throw refused(503);
    if (!hung) {
      hung = true;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new RunwrightError("aborted", "the model call was aborted")), { once: true });
      });
    }
    return reply({ text: "after the crash", usage: REPLY_USAGE });
  }, instant());
  const h = await createHarness(t, { models, drivers: { agent: oneStep } });
  const run = await h.start((await h.saveAgent()).id);
  await waitFor(async () => (await h.records(run.id, "model.started")).some((s) => s.attempt === 2));
  await h.crashAndReplace();
  const done = await h.until(run.id, "completed");
  assert.deepEqual(attempts, [1, 2, 2]);
  assert.deepEqual(await h.records(run.id, "model.interrupted"), [{ model: "scripted/scripted-1", reason: "crash", assumedCostMicros: W, attempt: 2 }]);
  assert.equal(done.usage.costMicros, W + REPLY_COST);
  assert.deepEqual(usageRows(h, run.id), [{ assumed: 1, costMicros: W }, { assumed: 0, costMicros: REPLY_COST }]);
  assert.deepEqual(modelTrace(await h.journal(run.id)), [
    ["model.started", 1], ["model.retry", 1], ["model.started", 2], ["model.interrupted", 2], ["model.started", 2], ["model.finished", null],
  ]);
});

test("a pause while waiting between attempts pauses with nothing new charged; resume sends attempt 2", async (t) => {
  const sleeps: number[] = [];
  const { models, attempts } = scriptedFailures([uncertain()], blockingRetry(sleeps));
  const h = await createHarness(t, { models, drivers: { agent: oneStep } });
  const run = await h.start((await h.saveAgent()).id);
  await waitFor(async () => sleeps.length === 1);
  const before = (await h.journal(run.id)).filter((r) => r.type.startsWith("model.")).length;
  await h.send(run.id, { type: "pause" });
  const paused = await h.until(run.id, "paused");
  assert.equal(paused.usage.costMicros, W);
  assert.equal((await h.journal(run.id)).filter((r) => r.type.startsWith("model.")).length, before, "the wait wrote nothing");
  assert.deepEqual(attempts, [1]);
  await h.send(run.id, { type: "resume" });
  const done = await h.until(run.id, "completed");
  assert.deepEqual(attempts, [1, 2]);
  assert.equal(done.usage.costMicros, W + REPLY_COST);
});

test("a step deadline that passes while waiting: model.failed deadline_exceeded, and replaying the step throws it again without a request", async (t) => {
  const sleeps: number[] = [];
  const { models, attempts } = scriptedFailures([refused(503)], blockingRetry(sleeps));
  const driver: Driver = async (ctx) => {
    const errors: string[] = [];
    for (let i = 0; i < 2; i++) {
      try {
        await ctx.model("m", { ...STEP, deadlineMs: 80 });
      } catch (error) {
        if (!isRunwrightError(error)) throw error;
        errors.push(`${error.code}: ${error.message}`);
      }
    }
    return errors;
  };
  const h = await createHarness(t, { models, drivers: { agent: driver } });
  const run = await h.start((await h.saveAgent()).id);
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, ["deadline_exceeded: the model step's deadline passed", "deadline_exceeded: the model step's deadline passed"]);
  assert.deepEqual(attempts, [1], "the replay sent nothing");
  assert.deepEqual(await h.records(run.id, "model.failed"), [{
    model: "scripted/scripted-1", error: { code: "deadline_exceeded", message: "the model step's deadline passed" }, attempts: 1,
  }]);
  assert.equal(done.usage.costMicros, 0);
});

test("onLimit skip: when the next attempt does not fit, the step throws limit_reached and no pending is opened", async (t) => {
  const { models, attempts } = scriptedFailures([uncertain()], instant());
  const driver: Driver = async (ctx) => {
    try {
      await ctx.model("m", { ...STEP, onLimit: "skip" });
      return "ran";
    } catch (error) {
      if (!isRunwrightError(error)) throw error;
      return { code: error.code, kind: error.details?.["kind"] ?? null, needed: error.details?.["neededMicros"] ?? null };
    }
  };
  const h = await createHarness(t, { models, drivers: { agent: driver } });
  const run = await h.start((await h.saveAgent()).id, {}, { maxCostMicros: W });
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, { code: "limit_reached", kind: "spend_cap", needed: W });
  assert.deepEqual(attempts, [1]);
  assert.equal((await h.records(run.id, "pending.opened")).length, 0);
  assert.equal(done.usage.costMicros, W);
});

test("repair phase: the repair call's attempt 1 fails transiently, attempt 2 of the repair succeeds, the first call is never sent again", async (t) => {
  const requests: [boolean, number][] = [];
  const models = fakeModels((request) => {
    const repair = request.messages.length > 1;
    requests.push([repair, request.meta.attempt]);
    if (!repair) return reply({ output: { n: "not a number" }, usage: REPLY_USAGE });
    if (request.meta.attempt === 1) throw uncertain();
    return reply({ output: { n: 7 }, usage: REPLY_USAGE });
  }, instant());
  const schema: JsonSchema = { type: "object", properties: { n: { type: "number" } }, required: ["n"] };
  const driver: Driver = async (ctx) => (await ctx.model("m", { ...STEP, output: { name: "out", schema } })).output;
  const h = await createHarness(t, { models, drivers: { agent: driver } });
  const run = await h.start((await h.saveAgent()).id);
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, { n: 7 });
  assert.deepEqual(requests, [[false, 1], [true, 1], [true, 2]]);
  const journal = await h.journal(run.id);
  assert.deepEqual(modelTrace(journal), [
    ["model.started", 1], ["model.invalid", null], ["model.started", 1], ["model.retry", 1], ["model.started", 2], ["model.finished", null],
  ]);
  const started = journal.filter((r) => r.type === "model.started").map((r) => r.data["repair"]);
  assert.deepEqual(started, [false, true, true]);
  const repairWorst = journal.filter((r) => r.type === "model.started")[1]?.data["worstCaseMicros"] as number;
  assert.equal(done.usage.costMicros, REPLY_COST + repairWorst + REPLY_COST);
});

test("modelResumePoint reads the journal: retry → next attempt, crash → same attempt, records before round 3 → attempt 1", () => {
  const record = (type: string, data: Record<string, unknown>): JournalRecord => ({
    runId: "r", seq: 1, epoch: 1, ts: 0, type, key: "m", data: data as JournalRecord["data"],
  });
  const startedData = { model: "p/m", purpose: "step", step: null, turn: 1, countsAsTurn: false, inputTokensEstimate: 1, maxOutputTokens: 1, worstCaseMicros: 6 };
  assert.deepEqual(modelResumePoint(null), { kind: "attempt", attempt: 1 });
  assert.deepEqual(modelResumePoint(record("model.retry", { attempt: 2, delayMs: 1, code: "c", message: "m", status: null, billing: "none" })), { kind: "attempt", attempt: 3 });
  assert.equal(modelResumePoint(record("model.started", { ...startedData, attempt: 2 })).kind, "crashed");
  assert.equal((modelResumePoint(record("model.started", startedData)) as { attempt: number }).attempt, 1);
  assert.deepEqual(modelResumePoint(record("model.interrupted", { model: "p/m", reason: "pause", assumedCostMicros: 6, attempt: 2 })), { kind: "attempt", attempt: 2 });
  assert.deepEqual(modelResumePoint(record("model.interrupted", { model: "p/m", reason: "shutdown", assumedCostMicros: 6 })), { kind: "attempt", attempt: 1 });
  assert.deepEqual(modelResumePoint(record("model.interrupted", { model: "p/m", reason: "deadline", assumedCostMicros: 6, attempt: 2 })), { kind: "deadline" });
  assert.equal(modelResumePoint(record("model.failed", { model: "p/m", error: { code: "model_failed", message: "x" } })).kind, "failed");
  assert.deepEqual(modelResumePoint(record("model.invalid", {})), { kind: "attempt", attempt: 1 });
});

test("a model.retry written before round 3 (no billing) does not decide where the call resumes", () => {
  const records: JournalRecord[] = [
    newRecord("model.started", { model: "p/m", purpose: "step", step: null, turn: 1, countsAsTurn: false, inputTokensEstimate: 4, maxOutputTokens: 2, worstCaseMicros: 14 }, "m"),
    newRecord("model.retry", { attempt: 1, delayMs: 5, code: "model_transient", message: "429" }, "m"),
  ].map((r, i) => ({ runId: "r", seq: i + 1, epoch: 1, ts: 0, type: r.type, key: r.key ?? null, data: r.data }));
  const state = replayJournal(records, { maxCostMicros: null, maxToolCalls: null, maxTurns: null, allowUnpriced: false });
  assert.equal(state.keys.get("m")?.lastModel?.type, "model.started", "an old retry record came from inside one call");
  assert.equal(state.usage.costMicros, 0);
  assert.equal(modelResumePoint(state.keys.get("m")?.lastModel ?? null).kind, "crashed");
});

// ------------------------------------------------------------------ audit

/** mulberry32 */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

interface TurnPlan { parallel: boolean; structured: boolean }
interface RunPlan { seed: number; turns: TurnPlan[] }

const AUDIT_SCHEMA: JsonSchema = { type: "object", properties: { n: { type: "number" } }, required: ["n"] };

/** Runs the plan's turns; model failures are caught so the run goes on, control signals stop it. */
const auditDriver: Driver = async (ctx) => {
  const plan = ctx.run.input.data as unknown as RunPlan;
  const step = (key: string, structured: boolean): ModelStepRequest => ({
    purpose: "step", system: `seed:${plan.seed}`, messages: [{ role: "user", content: `do ${key}` }], maxOutputTokens: 40 + (plan.seed % 5) * 20,
    ...(structured ? { output: { name: "out", schema: AUDIT_SCHEMA } } : {}),
  });
  const call = async (key: string, structured: boolean): Promise<string> => {
    try {
      return (await ctx.model(key, step(key, structured))).text;
    } catch (error) {
      if (isControlSignal(error) || !isRunwrightError(error)) throw error;
      return error.code;
    }
  };
  const out: string[] = [];
  for (const [i, turn] of plan.turns.entries()) {
    if (turn.parallel) out.push(...(await settleAll([call(`t${i}a`, turn.structured), call(`t${i}b`, false)])));
    else out.push(await call(`t${i}`, turn.structured));
  }
  return out;
};

type Outcome = "reply" | "invalid" | "status" | "uncertain" | "fatal";

function outcomeOf(request: ModelRequest): Outcome {
  const seed = Number(request.system.slice("seed:".length));
  const roll = prng(hashString(`${seed}|${request.meta.key}|${request.meta.attempt}|${request.messages.length}`))();
  if (roll < 0.4) return "reply";
  if (roll < 0.5) return request.output !== null && request.messages.length === 1 ? "invalid" : "reply";
  if (roll < 0.67) return "status";
  if (roll < 0.87) return "uncertain";
  return "fatal";
}

const STOPPED: readonly RunStatus[] = ["waiting", "completed", "failed", "cancelled"];
const END_TYPES = new Set(["model.finished", "model.invalid", "model.retry", "model.failed", "model.interrupted"]);

/**
 * Replays the journal: what was charged so far plus the worst case of every attempt in flight (journalled
 * model.started, not yet ended) never exceeds the cap in force. An attempt sent without its own admission (the
 * round-2 retry wrapper) breaks this as soon as an earlier attempt of the same call was charged.
 */
function checkExposure(journal: readonly JournalRecord[], initialCap: number | null, label: string): void {
  let cap = initialCap;
  let spent = 0;
  const inFlight = new Map<string, number>();
  for (const record of journal) {
    const key = record.key ?? "";
    const data = record.data;
    if (record.type === "run.claimed") inFlight.clear();
    else if (record.type === "limits.changed") cap = (data["limits"] as unknown as RunLimits).maxCostMicros;
    else if (record.type === "model.started") inFlight.set(key, data["worstCaseMicros"] as number);
    else if (END_TYPES.has(record.type)) {
      spent += typeof data["costMicros"] === "number" ? data["costMicros"] : 0;
      spent += typeof data["assumedCostMicros"] === "number" ? data["assumedCostMicros"] : 0;
      inFlight.delete(key);
    }
    const exposure = spent + [...inFlight.values()].reduce((sum, w) => sum + w, 0);
    if (cap !== null) assert.ok(exposure <= cap, `${label}: at seq ${record.seq} (${record.type} ${key}) spent ${spent} + in flight = ${exposure} > cap ${cap}`);
  }
}

/** Every model.started is followed, for its key, by exactly one end record before the key's next model.started. */
function checkOneEndPerAttempt(journal: readonly JournalRecord[], label: string): void {
  const open = new Map<string, number>();
  for (const record of journal) {
    const key = record.key ?? "";
    if (record.type === "model.started") {
      assert.equal(open.has(key), false, `${label}: ${key} started twice without an end`);
      open.set(key, record.seq);
    } else if (END_TYPES.has(record.type)) {
      assert.equal(open.has(key), true, `${label}: ${record.type} at ${key} ends no attempt`);
      open.delete(key);
    }
  }
}

test("audit: random failures, caps, sequential and parallel calls — requests = model.started, one end record each, spend within the cap, reducer = run row", { timeout: 120_000 }, async (t) => {
  const RUNS = 200;
  const pricingOf = fakePricing();
  const requests = new Map<string, number>();
  const billed = new Map<string, number>();
  const models = fakeModels(async (request) => {
    const runId = request.meta.runId;
    requests.set(runId, (requests.get(runId) ?? 0) + 1);
    const outcome = outcomeOf(request);
    const roll = prng(hashString(`${request.system}|${request.meta.key}|${request.meta.attempt}|${request.messages.length}|usage`));
    const worstIn = worstCaseInputTokens(request);
    const bill = (micros: number): void => {
      billed.set(runId, (billed.get(runId) ?? 0) + micros);
    };
    if (outcome === "status") throw refused(roll() < 0.5 ? 429 : 503);
    if (outcome === "uncertain") {
      bill(pricingOf.worstCaseMicros(request.model, worstIn, request.maxOutputTokens) as number);
      throw uncertain();
    }
    if (outcome === "fatal") {
      if (roll() < 0.5) throw refused(400);
      bill(pricingOf.worstCaseMicros(request.model, worstIn, request.maxOutputTokens) as number);
      throw uncertain("model_failed");
    }
    const usage = { inputTokens: Math.floor(roll() * (worstIn + 1)), outputTokens: Math.floor(roll() * (request.maxOutputTokens + 1)) };
    bill(pricingOf.costMicros(request.model, { ...usage, cacheReadTokens: 0, cacheWriteTokens: 0 }) as number);
    const output = request.output === null ? null : outcome === "invalid" ? { n: "x" } : { n: 1 };
    return reply({ text: request.meta.key, output, usage });
  }, { policy: { maxAttempts: 3, baseMs: 1, maxMs: 4 }, random: () => 0.5, sleep: async () => undefined });

  const h = await createHarness(t, { models, drivers: { agent: auditDriver }, engine: { concurrency: 32, leaseMs: 10_000, heartbeatMs: 500 } });
  const agent = await h.saveAgent();
  const plans = Array.from({ length: RUNS }, (_, i) => {
    const random = prng(1000 + i);
    const turns: TurnPlan[] = Array.from({ length: 1 + Math.floor(random() * 4) }, () => ({ parallel: random() < 0.4, structured: random() < 0.3 }));
    const cap = random() < 0.3 ? null : Math.floor(W * (0.5 + random() * 5));
    return { plan: { seed: 1000 + i, turns }, cap, random };
  });

  const started = Date.now();
  const finals = await Promise.all(plans.map(async ({ plan, cap, random }, i): Promise<{ run: RunRecord; initialCap: number | null }> => {
    const created = await h.start(agent.id, { data: plan as unknown as RunRecord["input"]["data"] }, { maxCostMicros: cap });
    const label = `run ${i} (seed ${plan.seed})`;
    let current = cap;
    for (let raises = 0; ; raises++) {
      const run = await h.until(created.id, STOPPED, 60_000);
      if (current !== null) assert.ok(run.usage.costMicros <= current, `${label}: spend ${run.usage.costMicros} > cap ${current} while ${run.status}`);
      if (run.status !== "waiting" || raises >= 3) return { run, initialCap: cap };
      const [pending] = await h.pendings(created.id);
      assert.equal(pending?.kind, "spend_cap", label);
      const needed = pending?.detail["neededMicros"] as number;
      assert.ok(needed > 0, label);
      current = (current as number) + needed + Math.floor(random() * W);
      const applied = (await h.records(created.id, "limits.changed")).length;
      await h.send(created.id, { type: "limits", limits: { maxCostMicros: current } });
      await waitFor(async () => (await h.records(created.id, "limits.changed")).length > applied, { timeoutMs: 60_000, intervalMs: 10 });
    }
  }));
  const elapsedMs = Date.now() - started;

  const seen = new Set<string>();
  let retried = 0;
  let parallelRetries = 0;
  for (const [i, { run, initialCap }] of finals.entries()) {
    const label = `run ${i}`;
    const journal = await h.journal(run.id);
    const startedCount = journal.filter((r) => r.type === "model.started").length;
    assert.equal(requests.get(run.id) ?? 0, startedCount, `${label}: provider requests = model.started records`);
    checkOneEndPerAttempt(journal, label);
    checkExposure(journal, initialCap, label);
    assert.ok(run.usage.costMicros >= (billed.get(run.id) ?? 0), `${label}: charged ${run.usage.costMicros} < billed ${billed.get(run.id) ?? 0}`);
    const replayed = replayJournal(journal, run.limits).usage;
    assert.deepEqual(replayed, run.usage, `${label}: reducer totals = run row`);
    for (const record of journal) if (record.type.startsWith("model.")) seen.add(`${record.type}:${String(record.data["billing"] ?? "")}`);
    if (journal.some((r) => r.type === "model.retry")) retried++;
    if (journal.some((r) => r.type === "model.retry" && /^t\d+[ab]$/.test(r.key ?? ""))) parallelRetries++;
  }
  // The random plans reach every kind of end record and both billings.
  for (const kind of ["model.finished:", "model.invalid:", "model.retry:none", "model.retry:unknown", "model.failed:"]) assert.ok(seen.has(kind), kind);
  assert.ok(finals.some((f) => f.run.status === "waiting"), "some runs end at their cap");
  assert.ok(finals.some((f) => f.run.status === "completed"));
  assert.ok(retried > RUNS / 4 && parallelRetries > 0, `${retried} runs retried, ${parallelRetries} in parallel branches`);
  t.diagnostic(`${RUNS} runs in ${elapsedMs} ms`);
});
