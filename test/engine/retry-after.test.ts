/**
 * R07-01: a provider's retry-after wait is served in full, also after a resume, or the call stops explicitly.
 * A hint longer than `models.retry.maxRetryAfterMs` stops the call at once with `model_failed`; a pause, crash
 * or takeover inside a hinted wait resumes by waiting what is left of it before the next attempt; and a call that
 * ends while a provider wait is outstanding says so in `model.failed.retryAfterMs` and in the thrown error's
 * `details`, live and replayed. The providers here are fakes that fail on chosen attempts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { delay } from "../../src/core/clock.ts";
import { RunwrightError, isRunwrightError } from "../../src/core/errors.ts";
import type { Json } from "../../src/core/json.ts";
import type { JournalRecord } from "../../src/store/types.ts";
import type { AttemptBilling, ModelRef, ModelRetry } from "../../src/models/types.ts";
import { worstCaseInputTokens } from "../../src/models/util.ts";
import type { Driver, ModelStepRequest } from "../../src/engine/types.ts";
import type { JsonSchema } from "../../src/schema/validate.ts";
import { createHarness, fakeModels, fakePricing, reply, type Harness } from "../helpers/engine.ts";
import { waitFor } from "../helpers/wait.ts";

const REF: ModelRef = { provider: "scripted", name: "scripted-1" };
const MODEL = "scripted/scripted-1";
const STEP: ModelStepRequest = { purpose: "step", system: "s", messages: [{ role: "user", content: "go" }], maxOutputTokens: 100 };
const W = fakePricing().worstCaseMicros(REF, worstCaseInputTokens({ system: "s", messages: STEP.messages, tools: [], output: null }), 100) as number;
const POLICY = { maxAttempts: 3, baseMs: 10, maxMs: 100 };

/** A transient provider failure; `hint` is its retry-after hint in ms (null: none). */
const transient = (status: number, hint: number | null, billing: AttemptBilling = "none"): RunwrightError =>
  new RunwrightError("model_transient", `HTTP ${status}`, { details: { status, retryAfterMs: hint, billing } });

const stopMessage = (attempts: number, status: number, hint: number, limit: number): string =>
  `model call not retried after ${attempts} attempt${attempts === 1 ? "" : "s"} (last error: status ${status}): ` +
  `the provider asked for a wait of ${hint} ms, more than models.retry.maxRetryAfterMs (${limit} ms): HTTP ${status}`;

/**
 * A retry runtime that records every sleep. The sleeps whose index `blocks` accepts never end by themselves (they
 * reject when their signal aborts); the others resolve at once. `onSleep` runs as each sleep is requested.
 */
function waitRuntime(options: { policy?: ModelRetry["policy"]; blocks?: (index: number) => boolean; onSleep?: () => void } = {}) {
  const sleeps: number[] = [];
  const blocks = options.blocks ?? (() => false);
  const retry: ModelRetry = {
    policy: options.policy ?? POLICY,
    random: () => 0,
    sleep: (ms, signal) => {
      const index = sleeps.length;
      sleeps.push(ms);
      options.onSleep?.();
      if (!blocks(index)) return Promise.resolve();
      return new Promise((_resolve, reject) => {
        if (signal.aborted) reject(new Error("wait aborted"));
        else signal.addEventListener("abort", () => reject(new Error("wait aborted")), { once: true });
      });
    },
  };
  return { retry, sleeps };
}

/** A provider that fails attempt n with `failures[n - 1]` (when set) and otherwise replies. */
function scriptedFailures(failures: (RunwrightError | null)[], retry?: ModelRetry) {
  const attempts: number[] = [];
  const models = fakeModels((request) => {
    attempts.push(request.meta.attempt);
    const failure = failures[request.meta.attempt - 1];
    if (failure !== undefined && failure !== null) throw failure;
    return reply({ text: `attempt ${request.meta.attempt}`, usage: { inputTokens: 10, outputTokens: 2 } });
  }, retry);
  return { models, attempts };
}

const oneStep: Driver = async (ctx) => (await ctx.model("m", STEP)).text;

interface Caught { code: string; message: string; details: Json }
function caught(error: unknown): Caught {
  if (!isRunwrightError(error)) throw error;
  return { code: error.code, message: error.message, details: (error.details ?? null) as Json };
}

/** Calls the step twice under one key: the second call is a replay from the journal. Returns both errors. */
function twiceDriver(step: ModelStepRequest = STEP): Driver {
  return async (ctx) => {
    const errors: Caught[] = [];
    for (let i = 0; i < 2; i++) {
      try {
        await ctx.model("m", step);
        errors.push({ code: "none", message: "", details: null });
      } catch (error) {
        errors.push(caught(error));
      }
    }
    return errors as unknown as Json;
  };
}

function modelTrace(journal: readonly JournalRecord[]): [string, number | null][] {
  return journal.filter((r) => r.type.startsWith("model.")).map((r) => [r.type, (r.data["attempt"] ?? r.data["attempts"] ?? null) as number | null]);
}

function usageRows(h: Harness, runId: string): { assumed: number; costMicros: number | null }[] {
  const db = new DatabaseSync(join(h.dir, "runwright.db"), { readOnly: true });
  try {
    return db.prepare("SELECT assumed, cost_micros FROM usage WHERE run_id = ? ORDER BY rowid").all(runId)
      .map((row) => ({ assumed: Number(row["assumed"]), costMicros: row["cost_micros"] === null ? null : Number(row["cost_micros"]) }));
  } finally {
    db.close();
  }
}

const inResumedRange = (ms: number | undefined): boolean => typeof ms === "number" && ms > 50_000 && ms <= 60_000;

// ------------------------------------------------------------------ T3: over the limit

test("a hint over the default limit stops the call after one request: no wait, no retry, the documented message", async (t) => {
  const { retry, sleeps } = waitRuntime();
  const { models, attempts } = scriptedFailures([transient(429, 300_001)], retry);
  const h = await createHarness(t, { models, drivers: { agent: oneStep } });
  const run = await h.start((await h.saveAgent()).id);
  const failed = await h.until(run.id, "failed");
  const message = stopMessage(1, 429, 300_001, 300_000);
  assert.deepEqual(attempts, [1]);
  assert.deepEqual(sleeps, []);
  assert.equal(failed.error?.code, "model_failed");
  assert.equal(failed.error?.message, message);
  assert.deepEqual(await h.records(run.id, "model.failed"), [{
    model: MODEL, error: { code: "model_failed", message }, attempts: 1, retryAfterMs: 300_001, retryAfterOverLimit: true,
  }]);
  assert.equal((await h.records(run.id, "model.retry")).length, 0);
  assert.equal(failed.usage.costMicros, 0);
  assert.deepEqual(modelTrace(await h.journal(run.id)), [["model.started", 1], ["model.failed", 1]]);
});

test("a hint exactly at the limit is waited out in full and the next attempt completes the call", async (t) => {
  const { retry, sleeps } = waitRuntime();
  const { models, attempts } = scriptedFailures([transient(429, 300_000)], retry);
  const h = await createHarness(t, { models, drivers: { agent: oneStep } });
  const run = await h.start((await h.saveAgent()).id);
  const done = await h.until(run.id, "completed");
  assert.deepEqual(sleeps, [300_000]);
  assert.deepEqual(attempts, [1, 2]);
  assert.equal(done.output, "attempt 2");
});

test("maxRetryAfterMs moves the limit both ways", async (t) => {
  const raised = waitRuntime({ policy: { ...POLICY, maxRetryAfterMs: 600_000 } });
  const long = scriptedFailures([transient(429, 300_001)], raised.retry);
  const h = await createHarness(t, { models: long.models, drivers: { agent: oneStep } });
  const run = await h.start((await h.saveAgent()).id);
  await h.until(run.id, "completed");
  assert.deepEqual(raised.sleeps, [300_001]);
  assert.deepEqual(long.attempts, [1, 2]);

  const lowered = waitRuntime({ policy: { ...POLICY, maxRetryAfterMs: 1000 } });
  const short = scriptedFailures([transient(429, 1001)], lowered.retry);
  const h2 = await createHarness(t, { models: short.models, drivers: { agent: oneStep } });
  const run2 = await h2.start((await h2.saveAgent()).id);
  const failed = await h2.until(run2.id, "failed");
  assert.deepEqual(lowered.sleeps, []);
  assert.deepEqual(short.attempts, [1]);
  assert.equal(failed.error?.message, stopMessage(1, 429, 1001, 1000));
  assert.match(failed.error?.message ?? "", /\(1000 ms\)/);
});

test("a hint over the limit on a later attempt stops there, with the attempts left unused", async (t) => {
  const { retry, sleeps } = waitRuntime();
  const { models, attempts } = scriptedFailures([transient(503, null), transient(429, 400_000)], retry);
  const h = await createHarness(t, { models, drivers: { agent: oneStep } });
  const run = await h.start((await h.saveAgent()).id);
  const failed = await h.until(run.id, "failed");
  assert.deepEqual(attempts, [1, 2]);
  assert.deepEqual(sleeps, [5], "only the engine's own backoff after attempt 1");
  const [record] = await h.records(run.id, "model.failed");
  assert.equal(record?.attempts, 2);
  assert.equal(record?.retryAfterOverLimit, true);
  assert.ok(failed.error?.message.startsWith("model call not retried after 2 attempts"), failed.error?.message);
});

test("a hint over the limit with uncertain billing: the attempt is charged its worst case once", async (t) => {
  const { retry } = waitRuntime();
  const { models, attempts } = scriptedFailures([transient(429, 400_000, "unknown")], retry);
  const h = await createHarness(t, { models, drivers: { agent: oneStep } });
  const run = await h.start((await h.saveAgent()).id);
  const failed = await h.until(run.id, "failed");
  assert.deepEqual(attempts, [1]);
  assert.deepEqual(await h.records(run.id, "model.failed"), [{
    model: MODEL, error: { code: "model_failed", message: stopMessage(1, 429, 400_000, 300_000) }, attempts: 1,
    assumedCostMicros: W, retryAfterMs: 400_000, retryAfterOverLimit: true,
  }]);
  assert.equal(failed.usage.costMicros, W);
  assert.deepEqual(usageRows(h, run.id), [{ assumed: 1, costMicros: W }]);
});

test("without a retry runtime the default limit still applies; a hint under it is recorded on the failure", async (t) => {
  const over = scriptedFailures([transient(429, 400_000)]);
  const h = await createHarness(t, { models: over.models, drivers: { agent: oneStep } });
  const run = await h.start((await h.saveAgent()).id);
  const failed = await h.until(run.id, "failed");
  assert.deepEqual(over.attempts, [1]);
  assert.equal(failed.error?.message, stopMessage(1, 429, 400_000, 300_000));

  const under = scriptedFailures([transient(429, 2000)]);
  const h2 = await createHarness(t, { models: under.models, drivers: { agent: oneStep } });
  const run2 = await h2.start((await h2.saveAgent()).id);
  const failed2 = await h2.until(run2.id, "failed");
  const message = "model call failed after 1 attempt (last error: status 429): HTTP 429";
  assert.equal(failed2.error?.message, message);
  assert.deepEqual(await h2.records(run2.id, "model.failed"), [{
    model: MODEL, error: { code: "model_failed", message }, attempts: 1, retryAfterMs: 2000,
  }]);
});

test("the stop error's details, live and replayed from the journal without a new request", async (t) => {
  const { retry } = waitRuntime();
  const { models, attempts } = scriptedFailures([transient(429, 300_001)], retry);
  const h = await createHarness(t, { models, drivers: { agent: twiceDriver() } });
  const run = await h.start((await h.saveAgent()).id);
  const done = await h.until(run.id, "completed");
  const [live, replayed] = done.output as unknown as Caught[];
  const message = stopMessage(1, 429, 300_001, 300_000);
  assert.deepEqual(live, {
    code: "model_failed", message,
    details: { status: 429, attempts: 1, retryAfterMs: 300_001, maxRetryAfterMs: 300_000, retryAfterOverLimit: true },
  });
  assert.equal(replayed?.code, "model_failed");
  assert.equal(replayed?.message, message);
  const details = replayed?.details as { retryAfterMs?: unknown; retryAfterOverLimit?: unknown };
  assert.equal(details.retryAfterOverLimit, true);
  assert.ok(typeof details.retryAfterMs === "number" && details.retryAfterMs > 0 && details.retryAfterMs <= 300_001, String(details.retryAfterMs));
  assert.deepEqual(attempts, [1], "the replay sent nothing");
});

// ------------------------------------------------------------------ T5: resume inside the wait

test("a crash during a hinted wait: the new session waits the rest of it before attempt 2", async (t) => {
  const attemptsAtSleep: number[] = [];
  const attempts: number[] = [];
  const { retry, sleeps } = waitRuntime({ blocks: (i) => i === 0, onSleep: () => attemptsAtSleep.push(attempts.length) });
  const models = fakeModels((request) => {
    attempts.push(request.meta.attempt);
    if (request.meta.attempt === 1) throw transient(429, 60_000);
    return reply({ text: "after the wait" });
  }, retry);
  const h = await createHarness(t, { models, drivers: { agent: oneStep } });
  const run = await h.start((await h.saveAgent()).id);
  await waitFor(() => sleeps.length === 1);
  assert.equal(sleeps[0], 60_000);
  await h.crashAndReplace();
  const done = await h.until(run.id, "completed");
  assert.equal(done.output, "after the wait");
  assert.deepEqual(attempts, [1, 2]);
  assert.equal(sleeps.length, 2);
  assert.ok(inResumedRange(sleeps[1]), String(sleeps[1]));
  assert.equal(attemptsAtSleep[1], 1, "attempt 2 was not sent before the resumed wait");
  const retries = await h.records(run.id, "model.retry");
  assert.equal(retries.length, 1);
  assert.equal(retries[0]?.retryAfterMs, 60_000);
  assert.deepEqual(modelTrace(await h.journal(run.id)), [["model.started", 1], ["model.retry", 1], ["model.started", 2], ["model.finished", null]]);
});

test("a pause during a hinted wait: nothing is written, and resume waits the rest before attempt 2", async (t) => {
  const { retry, sleeps } = waitRuntime({ blocks: (i) => i === 0 });
  const { models, attempts } = scriptedFailures([transient(429, 60_000)], retry);
  const h = await createHarness(t, { models, drivers: { agent: oneStep } });
  const run = await h.start((await h.saveAgent()).id);
  await waitFor(() => sleeps.length === 1);
  const before = (await h.journal(run.id)).filter((r) => r.type.startsWith("model.")).length;
  await h.send(run.id, { type: "pause" });
  await h.until(run.id, "paused");
  assert.equal((await h.journal(run.id)).filter((r) => r.type.startsWith("model.")).length, before, "the wait wrote nothing");
  assert.deepEqual(attempts, [1]);
  await h.send(run.id, { type: "resume" });
  await h.until(run.id, "completed");
  assert.equal(sleeps.length, 2);
  assert.ok(inResumedRange(sleeps[1]), String(sleeps[1]));
  assert.deepEqual(attempts, [1, 2]);
});

test("a pause during the resumed wait: the next resume waits again and no attempt number is used up", async (t) => {
  const { retry, sleeps } = waitRuntime({ blocks: (i) => i <= 1 });
  const { models, attempts } = scriptedFailures([transient(429, 60_000)], retry);
  const h = await createHarness(t, { models, drivers: { agent: oneStep } });
  const run = await h.start((await h.saveAgent()).id);
  await waitFor(() => sleeps.length === 1);
  await h.send(run.id, { type: "pause" });
  await h.until(run.id, "paused");
  await h.send(run.id, { type: "resume" });
  await waitFor(() => sleeps.length === 2);
  assert.ok(inResumedRange(sleeps[1]), String(sleeps[1]));
  await h.send(run.id, { type: "pause" });
  await h.until(run.id, "paused");
  assert.deepEqual(attempts, [1]);
  await h.send(run.id, { type: "resume" });
  await h.until(run.id, "completed");
  assert.equal(sleeps.length, 3);
  assert.ok(inResumedRange(sleeps[2]), String(sleeps[2]));
  assert.deepEqual(attempts, [1, 2]);
  assert.deepEqual((await h.records(run.id, "model.started")).map((s) => s.attempt), [1, 2]);
});

test("a wait that has already passed is not waited again after a crash", async (t) => {
  const { retry, sleeps } = waitRuntime({ blocks: (i) => i === 0 });
  const { models, attempts } = scriptedFailures([transient(429, 30)], retry);
  const h = await createHarness(t, { models, drivers: { agent: oneStep } });
  const run = await h.start((await h.saveAgent()).id);
  await waitFor(() => sleeps.length === 1);
  await delay(120);
  await h.crashAndReplace();
  await h.until(run.id, "completed");
  assert.deepEqual(attempts, [1, 2]);
  assert.equal(sleeps.length, 1);
});

test("without a hint the engine's own backoff is not served again after a crash", async (t) => {
  const { retry, sleeps } = waitRuntime({ blocks: (i) => i === 0 });
  const { models, attempts } = scriptedFailures([transient(503, null)], retry);
  const h = await createHarness(t, { models, drivers: { agent: oneStep } });
  const run = await h.start((await h.saveAgent()).id);
  await waitFor(() => sleeps.length === 1);
  await h.crashAndReplace();
  await h.until(run.id, "completed");
  assert.deepEqual(attempts, [1, 2]);
  assert.equal(sleeps.length, 1);
  const [record] = await h.records(run.id, "model.retry");
  assert.equal(Object.hasOwn(record ?? {}, "retryAfterMs"), false);
});

test("repair phase: a crash during the repair call's hinted wait waits the rest, then sends the repair's attempt 2", async (t) => {
  const requests: [boolean, number][] = [];
  const { retry, sleeps } = waitRuntime({ blocks: (i) => i === 0 });
  const models = fakeModels((request) => {
    const repair = request.messages.length > 1;
    requests.push([repair, request.meta.attempt]);
    if (!repair) return reply({ output: { n: "not a number" } });
    if (request.meta.attempt === 1) throw transient(429, 60_000);
    return reply({ output: { n: 7 } });
  }, retry);
  const schema: JsonSchema = { type: "object", properties: { n: { type: "number" } }, required: ["n"] };
  const driver: Driver = async (ctx) => (await ctx.model("m", { ...STEP, output: { name: "out", schema } })).output;
  const h = await createHarness(t, { models, drivers: { agent: driver } });
  const run = await h.start((await h.saveAgent()).id);
  await waitFor(() => sleeps.length === 1);
  assert.equal(sleeps[0], 60_000);
  await h.crashAndReplace();
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, { n: 7 });
  assert.equal(sleeps.length, 2);
  assert.ok(inResumedRange(sleeps[1]), String(sleeps[1]));
  assert.deepEqual(requests, [[false, 1], [true, 1], [true, 2]], "the first call is never sent again");
});

test("a deadline during the resumed wait: model.failed deadline_exceeded with what is left of the wait, attempt 2 never sent", async (t) => {
  const { retry, sleeps } = waitRuntime({ blocks: () => true });
  const { models, attempts } = scriptedFailures([transient(429, 60_000)], retry);
  const driver: Driver = async (ctx) => {
    const resumed = ctx.journal().some((r) => r.type === "model.retry");
    try {
      await ctx.model("m", { ...STEP, ...(resumed ? { deadlineMs: 80 } : {}) });
      return null;
    } catch (error) {
      const { code, details } = caught(error);
      return { code, details };
    }
  };
  const h = await createHarness(t, { models, drivers: { agent: driver } });
  const run = await h.start((await h.saveAgent()).id);
  await waitFor(() => sleeps.length === 1);
  await h.crashAndReplace();
  const done = await h.until(run.id, "completed");
  const records = await h.records(run.id, "model.failed");
  assert.equal(records.length, 1);
  const [record] = records;
  assert.equal(record?.error.code, "deadline_exceeded");
  assert.equal(record?.attempts, 1);
  assert.ok(inResumedRange(record?.retryAfterMs), String(record?.retryAfterMs));
  const output = done.output as { code: string; details: { retryAfterMs: number } };
  assert.equal(output.code, "deadline_exceeded");
  assert.equal(output.details.retryAfterMs, record?.retryAfterMs);
  assert.deepEqual(attempts, [1], "attempt 2 was never sent");
});

// ------------------------------------------------------------------ T6: a call that ends while a wait is outstanding

test("the last attempt fails with a hint: model.failed and the error carry it, live and replayed", async (t) => {
  const { retry, sleeps } = waitRuntime({ policy: { ...POLICY, maxAttempts: 2 } });
  const { models, attempts } = scriptedFailures([transient(429, 2000), transient(429, 7000)], retry);
  const h = await createHarness(t, { models, drivers: { agent: twiceDriver() } });
  const run = await h.start((await h.saveAgent()).id);
  const done = await h.until(run.id, "completed");
  const message = "model call failed after 2 attempts (last error: status 429): HTTP 429";
  assert.deepEqual(sleeps, [2000]);
  assert.deepEqual(attempts, [1, 2]);
  assert.deepEqual(await h.records(run.id, "model.failed"), [{ model: MODEL, error: { code: "model_failed", message }, attempts: 2, retryAfterMs: 7000 }]);
  const [live, replayed] = done.output as unknown as Caught[];
  assert.deepEqual(live, { code: "model_failed", message, details: { status: 429, attempts: 2, retryAfterMs: 7000 } });
  assert.equal(replayed?.code, "model_failed");
  assert.equal(replayed?.message, message);
  const details = replayed?.details as Record<string, unknown>;
  assert.deepEqual(Object.keys(details), ["retryAfterMs"]);
  const left = details["retryAfterMs"];
  assert.ok(typeof left === "number" && left > 0 && left <= 7000, String(left));
});

test("a deadline during a hinted wait: model.failed and the error carry what is left of the wait, live and replayed", async (t) => {
  const { retry } = waitRuntime({ blocks: () => true });
  const { models, attempts } = scriptedFailures([transient(429, 60_000)], retry);
  const h = await createHarness(t, { models, drivers: { agent: twiceDriver({ ...STEP, deadlineMs: 80 }) } });
  const run = await h.start((await h.saveAgent()).id);
  const done = await h.until(run.id, "completed");
  assert.deepEqual(attempts, [1]);
  const [record] = await h.records(run.id, "model.failed");
  assert.equal(record?.error.code, "deadline_exceeded");
  assert.equal(record?.attempts, 1);
  assert.ok(inResumedRange(record?.retryAfterMs), String(record?.retryAfterMs));
  const [live, replayed] = done.output as unknown as Caught[];
  assert.equal(live?.code, "deadline_exceeded");
  assert.equal((live?.details as { retryAfterMs: number }).retryAfterMs, record?.retryAfterMs);
  assert.equal(replayed?.code, "deadline_exceeded");
  const left = (replayed?.details as { retryAfterMs: number }).retryAfterMs;
  assert.ok(left > 0 && left <= (record?.retryAfterMs ?? 0), String(left));
});

test("an exhausted failure without a hint has no wait fields and details exactly {status, attempts}", async (t) => {
  const { retry } = waitRuntime({ policy: { ...POLICY, maxAttempts: 2 } });
  const { models } = scriptedFailures([transient(503, null), transient(529, null)], retry);
  const h = await createHarness(t, { models, drivers: { agent: twiceDriver() } });
  const run = await h.start((await h.saveAgent()).id);
  const done = await h.until(run.id, "completed");
  const [record] = await h.records(run.id, "model.failed");
  assert.equal(Object.hasOwn(record ?? {}, "retryAfterMs"), false);
  assert.equal(Object.hasOwn(record ?? {}, "retryAfterOverLimit"), false);
  const [live, replayed] = done.output as unknown as Caught[];
  assert.deepEqual(live?.details, { status: 529, attempts: 2 });
  assert.equal(replayed?.details, null, "a replayed failure without a wait has no details");
});

test("a spend-cap pause between hinted attempts: raising the cap serves the rest of the wait before attempt 2", async (t) => {
  const attemptsAtSleep: number[] = [];
  const attempts: number[] = [];
  const { retry, sleeps } = waitRuntime({ onSleep: () => attemptsAtSleep.push(attempts.length) });
  const models = fakeModels((request) => {
    attempts.push(request.meta.attempt);
    if (request.meta.attempt === 1) throw transient(429, 60_000, "unknown");
    return reply({ text: "after the cap", usage: { inputTokens: 10, outputTokens: 2 } });
  }, retry);
  const h = await createHarness(t, { models, drivers: { agent: oneStep } });
  const run = await h.start((await h.saveAgent()).id, {}, { maxCostMicros: W });
  await h.until(run.id, "waiting");
  const [pending] = await h.pendings(run.id);
  assert.equal(pending?.kind, "spend_cap");
  assert.deepEqual(sleeps, [], "the wait starts only once the next attempt is admitted");
  assert.deepEqual(attempts, [1]);

  await h.send(run.id, { type: "limits", limits: { maxCostMicros: 3 * W } });
  const done = await h.until(run.id, "completed");
  assert.equal(done.output, "after the cap");
  assert.equal(sleeps.length, 1);
  assert.ok(inResumedRange(sleeps[0]), String(sleeps[0]));
  assert.deepEqual(attemptsAtSleep, [1], "attempt 2 was not sent before the rest of the wait");
  assert.deepEqual(attempts, [1, 2]);
  assert.deepEqual(modelTrace(await h.journal(run.id)), [["model.started", 1], ["model.retry", 1], ["model.started", 2], ["model.finished", null]]);
});
