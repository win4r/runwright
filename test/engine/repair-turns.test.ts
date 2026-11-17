/**
 * R14-02: the turn of an open output repair stays reserved for as long as its step is unfinished, in every
 * session. A structured-output step's first call is admitted against `maxTurns`; its turn is counted only when the
 * step finishes. Between `model.invalid` and the closing record the turn is held in the session's map of open
 * repairs (moved there live, or reserved when a session claims the run), so no other step can be admitted for it,
 * whatever ends an invocation of the step: a crash, a pause, a release at shutdown, a spend-cap pending.
 *
 * Sessions are started by the test (`h.claimSession`), which checks `usage.turns + reserved.turns <= maxTurns`
 * whenever a turn is reserved or released and after every commit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isRunwrightError } from "../../src/core/errors.ts";
import type { Json, JsonObject } from "../../src/core/json.ts";
import type { GenerateOptions, ModelRequest, ModelResponse } from "../../src/models/types.ts";
import type { JournalRecord, NewJournalRecord, RunLimits } from "../../src/store/types.ts";
import { openRepairs } from "../../src/engine/context.ts";
import { settleAll } from "../../src/engine/control.ts";
import { newRecord } from "../../src/engine/journal-types.ts";
import { replayJournal } from "../../src/engine/state.ts";
import type { Driver, ModelStepRequest, RunContext } from "../../src/engine/types.ts";
import { commandGate, createHarness, fakeModels, reply, type Harness, type ManualSession } from "../helpers/engine.ts";
import { waitFor } from "../helpers/wait.ts";

const answerSchema = { type: "object", required: ["n"], properties: { n: { type: "integer" } }, additionalProperties: false };

/** A structured step whose turn counts (unless `countsAsTurn` says otherwise). */
function structured(overrides: Partial<ModelStepRequest> = {}): ModelStepRequest {
  return {
    purpose: "run", system: "Count.", messages: [{ role: "user", content: "how many?" }], maxOutputTokens: 100,
    output: { name: "Answer", schema: answerSchema }, countsAsTurn: true, ...overrides,
  };
}

/** A small plain step whose turn counts. */
const plain: ModelStepRequest = { purpose: "run", system: "s", messages: [{ role: "user", content: "b" }], maxOutputTokens: 10, countsAsTurn: true };

const isRepair = (request: ModelRequest): boolean => request.messages.length > 1;

/** Provider calls by step key, repairs counted apart as `<key>:repair`. */
type Calls = Map<string, number>;
const called = (calls: Calls, slot: string): number => calls.get(slot) ?? 0;

interface ModelOptions {
  /** Repairs reply invalid too. */
  repairInvalid?: boolean;
  /** Runs before a first (not repair) call of `key` replies. */
  beforeFirst?: (request: ModelRequest) => Promise<void> | void;
  /** Repair calls wait until they are aborted. */
  hangRepair?: boolean;
}

/** First replies of structured steps are invalid, repairs valid; plain steps answer "plain". Each call bills 20 micros. */
function models(calls: Calls, options: ModelOptions = {}) {
  return fakeModels(async (request: ModelRequest, generate: GenerateOptions): Promise<ModelResponse> => {
    const slot = isRepair(request) ? `${request.meta.key}:repair` : request.meta.key;
    calls.set(slot, called(calls, slot) + 1);
    const usage = { inputTokens: 10, outputTokens: 2 };
    if (request.output === null) return reply({ text: "plain", usage });
    if (!isRepair(request)) {
      await options.beforeFirst?.(request);
      return reply({ output: { n: "three" }, usage });
    }
    if (options.hangRepair === true) {
      await new Promise((_resolve, reject) => generate.signal.addEventListener("abort", () => reject(generate.signal.reason), { once: true }));
    }
    return reply({ output: options.repairInvalid === true ? { n: "still" } : { n: 3 }, usage });
  });
}

/** Runs every step function at once and returns `{key: output or error code}`. */
async function together(steps: [string, () => Promise<{ output: Json; text: string }>][]): Promise<JsonObject> {
  const results = await settleAll(steps.map(([, run]) => run()));
  const out: JsonObject = {};
  steps.forEach(([key], i) => {
    const r = results[i];
    out[key] = r === undefined ? null : r.output ?? r.text;
  });
  return out;
}

const hasInvalid = (ctx: RunContext, key: string): boolean => ctx.journal().some((r) => r.type === "model.invalid" && r.key === key);

/** Before `a` has an invalid reply: `a` alone. After: `b` first, then `a`, in parallel. */
const bFirstOnResume: Driver = async (ctx) => {
  if (!hasInvalid(ctx, "a")) {
    await ctx.model("a", structured());
    return "unreachable";
  }
  return together([["b", () => ctx.model("b", plain)], ["a", () => ctx.model("a", structured())]]);
};

const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };

const firstStarted = (key: string, countsAsTurn: boolean): NewJournalRecord => newRecord("model.started", {
  model: "scripted/scripted-1", purpose: "run", step: null, turn: 1, countsAsTurn, inputTokensEstimate: 1100,
  maxOutputTokens: 100, worstCaseMicros: 1600, repair: false, attempt: 1,
}, key);

const invalidReply = (key: string): NewJournalRecord => newRecord("model.invalid", {
  model: "scripted/scripted-1", purpose: "run", text: "", toolCalls: [], output: { n: "three" },
  problems: [{ path: "$.n", message: "must be integer" }], usage, costMicros: 20, durationMs: 1,
}, key);

/** A run whose dead runner journalled `a`'s first call and its invalid reply (lease 50 ms, so it expires soon). */
async function crashedAfterInvalid(h: Harness, agentId: string, limits: Partial<RunLimits>, countsAsTurn = true): Promise<string> {
  const run = await h.start(agentId, {}, limits);
  const [claimed] = await h.store.claimRuns({ runnerId: "runner_dead", limit: 1, leaseMs: 50 });
  assert.ok(claimed !== undefined && claimed.run.id === run.id);
  await h.store.commit(claimed.lease, {
    records: [newRecord("run.claimed", { runnerId: "runner_dead" }), firstStarted("a", countsAsTurn), invalidReply("a")],
    usage: [{ model: "scripted/scripted-1", purpose: "run", ...usage, costMicros: 20, assumed: false }],
  });
  return run.id;
}

/** Waits for the session to end and checks the invariant held and no hold outlived a closed repair. */
async function settled(manual: ManualSession): Promise<void> {
  await manual.session.done;
  assert.deepEqual(manual.violations, []);
  assert.deepEqual([...manual.core.repairTurns.keys()].sort(), openRepairs(manual.core.state).sort(), "one hold per open repair, no other");
}

async function openPendingKinds(h: Harness, runId: string): Promise<string[]> {
  return (await h.pendings(runId)).map((p) => `${p.kind}@${p.stepKey}`).sort();
}

for (const maxTurns of [1, 2]) {
  test(`the reviewer's probe: after a crash between model.invalid and the repair, maxTurns ${maxTurns}`, async (t) => {
    const calls: Calls = new Map();
    const h = await createHarness(t, { models: models(calls), drivers: { agent: bFirstOnResume }, autoStart: false });
    const agent = await h.saveAgent();
    const runId = await crashedAfterInvalid(h, agent.id, { maxTurns });
    const manual = await h.claimSession();
    await settled(manual);
    const run = await h.store.getRun(runId);
    assert.equal(called(calls, "a"), 0, "the first call is not sent again");
    assert.equal(called(calls, "a:repair"), 1);
    if (maxTurns === 1) {
      assert.equal(run?.status, "waiting");
      assert.equal(called(calls, "b"), 0, "b is not sent: the open repair holds the last turn");
      assert.deepEqual(await openPendingKinds(h, runId), ["turn_limit@b"]);
      assert.equal(run?.usage.turns, 1);
    } else {
      assert.equal(run?.status, "completed");
      assert.deepEqual(run?.output, { b: "plain", a: { n: 3 } });
      assert.equal(run?.usage.turns, 2);
    }
  });
}

test("a pause between model.invalid and the repair keeps the repair's turn reserved in the next session", async (t) => {
  const calls: Calls = new Map();
  const gate = commandGate();
  let harness: Harness | null = null;
  const h = await createHarness(t, {
    models: models(calls, {
      beforeFirst: async (request) => {
        if (request.meta.key !== "a") return;
        // The pause is applied after this reply's model.invalid is queued and before the repair's control check.
        await gate.hold((harness as Harness).store, request.meta.runId, { type: "pause" });
        gate.releaseSoon();
      },
    }),
    drivers: { agent: bFirstOnResume }, autoStart: false, wrapStore: gate.wrap,
  });
  harness = h;
  const agent = await h.saveAgent();
  const run = await h.start(agent.id, {}, { maxTurns: 1 });
  const first = await h.claimSession();
  await settled(first);
  assert.equal((await h.store.getRun(run.id))?.status, "paused");
  assert.deepEqual((await h.journal(run.id)).filter((r) => r.key === "a").map((r) => r.type), ["model.started", "model.invalid"]);
  assert.deepEqual([...first.core.repairTurns.keys()], ["a"], "the paused session still held the repair's turn");

  await h.send(run.id, { type: "resume" });
  const second = await h.claimSession();
  await settled(second);
  const after = await h.store.getRun(run.id);
  assert.equal(after?.status, "waiting");
  assert.equal(called(calls, "b"), 0);
  assert.equal(called(calls, "a:repair"), 1);
  assert.equal(after?.usage.turns, 1);
  assert.deepEqual(await openPendingKinds(h, run.id), ["turn_limit@b"]);
});

test("a release at shutdown between model.invalid and the repair keeps the repair's turn reserved in the next session", async (t) => {
  const calls: Calls = new Map();
  let current: ManualSession | null = null;
  const h = await createHarness(t, {
    models: models(calls, {
      beforeFirst: (request) => {
        if (request.meta.key === "a") current?.session.requestStop();
      },
    }),
    drivers: { agent: bFirstOnResume }, autoStart: false,
  });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id, {}, { maxTurns: 1 });
  current = await h.claimSession();
  await settled(current);
  assert.equal((await h.store.getRun(run.id))?.status, "queued");
  assert.equal((await h.records(run.id, "model.invalid")).length, 1);
  assert.equal((await h.records(run.id, "run.released")).length, 1);

  current = await h.claimSession();
  await settled(current);
  const after = await h.store.getRun(run.id);
  assert.equal(after?.status, "waiting");
  assert.equal(called(calls, "b"), 0);
  assert.equal(after?.usage.turns, 1);
  assert.deepEqual(await openPendingKinds(h, run.id), ["turn_limit@b"]);
});

/** The worst case of `a`'s first call, read from the spend_cap pending of a probe run with cap 0 (left waiting). */
async function firstWorstCase(h: Harness, agentId: string): Promise<number> {
  const probe = await h.start(agentId, { message: "probe" }, { maxCostMicros: 0 });
  const manual = await h.claimSession();
  await manual.session.done;
  const pending = (await h.pendings(probe.id)).find((p) => p.stepKey === "a");
  const worst = pending?.detail["nextCallWorstCaseMicros"];
  assert.equal(typeof worst, "number");
  return worst as number;
}

/** `a` and, once `a` waits on the spend cap (or, resumed, at once), `b` — in parallel. */
const bAfterRefusedRepair: Driver = async (ctx) => {
  if (ctx.run.input.message === "probe") return (await ctx.model("a", structured())).output;
  const refused = (): boolean => ctx.journal().some((r) => r.type === "pending.opened" && r.key === "a");
  return together([
    ["a", () => ctx.model("a", structured())],
    ["b", async () => {
      await waitFor(refused, { timeoutMs: 5000, intervalMs: 2 });
      return ctx.model("b", plain);
    }],
  ]);
};

test("within one session: a repair refused by the spend cap keeps its turn; a sibling asking for it gets a turn_limit pending", async (t) => {
  const calls: Calls = new Map();
  const h = await createHarness(t, { models: models(calls), drivers: { agent: bAfterRefusedRepair }, autoStart: false });
  const agent = await h.saveAgent();
  const cap = await firstWorstCase(h, agent.id);
  calls.clear();
  // a's first call fits; its repair (a larger request, after 20 spent) does not; b alone would fit.
  const run = await h.start(agent.id, {}, { maxTurns: 1, maxCostMicros: cap });
  const first = await h.claimSession();
  await settled(first);
  assert.equal((await h.store.getRun(run.id))?.status, "waiting");
  assert.deepEqual(await openPendingKinds(h, run.id), ["spend_cap@a", "turn_limit@b"]);
  assert.equal(called(calls, "b"), 0, "b was not sent");
  assert.deepEqual([...first.core.repairTurns.keys()], ["a"]);

  await h.send(run.id, { type: "limits", limits: { maxCostMicros: cap * 10 } });
  const second = await h.claimSession();
  await settled(second);
  const after = await h.store.getRun(run.id);
  assert.equal(after?.status, "waiting");
  assert.equal(called(calls, "a:repair"), 1);
  assert.equal(called(calls, "b"), 0);
  assert.equal(after?.usage.turns, 1);
  assert.deepEqual(await openPendingKinds(h, run.id), ["turn_limit@b"]);

  await h.send(run.id, { type: "limits", limits: { maxTurns: 2 } });
  const third = await h.claimSession();
  await settled(third);
  const done = await h.store.getRun(run.id);
  assert.equal(done?.status, "completed", JSON.stringify(done?.error));
  assert.deepEqual(done?.output, { a: { n: 3 }, b: "plain" });
  assert.equal(done?.usage.turns, 2);
});

test("a repair that fails (invalid again) frees its turn: a sibling is admitted next", async (t) => {
  const calls: Calls = new Map();
  const driver: Driver = async (ctx) => {
    let code: Json = null;
    try {
      await ctx.model("a", structured());
    } catch (error) {
      if (!isRunwrightError(error)) throw error;
      code = error.code;
    }
    return { a: code, b: (await ctx.model("b", plain)).text };
  };
  const h = await createHarness(t, { models: models(calls, { repairInvalid: true }), drivers: { agent: driver }, autoStart: false });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id, {}, { maxTurns: 1 });
  const manual = await h.claimSession();
  await settled(manual);
  const done = await h.store.getRun(run.id);
  assert.equal(done?.status, "completed", JSON.stringify(done?.error));
  assert.deepEqual(done?.output, { a: "model_output_invalid", b: "plain" });
  assert.equal(done?.usage.turns, 1);
  assert.equal(manual.core.reserved.turns, 0);
});

test("a repair ended by its deadline frees its turn, also when the repair was reserved at claim", async (t) => {
  for (const crashed of [false, true]) {
    const calls: Calls = new Map();
    const driver: Driver = async (ctx) => {
      let code: Json = null;
      try {
        await ctx.model("a", structured({ deadlineMs: 80 }));
      } catch (error) {
        if (!isRunwrightError(error)) throw error;
        code = error.code;
      }
      return { a: code, b: (await ctx.model("b", plain)).text };
    };
    const h = await createHarness(t, { models: models(calls, { hangRepair: true }), drivers: { agent: driver }, autoStart: false });
    const agent = await h.saveAgent();
    const runId = crashed ? await crashedAfterInvalid(h, agent.id, { maxTurns: 1 }) : (await h.start(agent.id, {}, { maxTurns: 1 })).id;
    const manual = await h.claimSession();
    await settled(manual);
    const done = await h.store.getRun(runId);
    assert.equal(done?.status, "completed", JSON.stringify(done?.error));
    assert.deepEqual(done?.output, { a: "deadline_exceeded", b: "plain" }, `crashed: ${crashed}`);
    assert.equal(done?.usage.turns, 1);
    const interrupted = await h.records(runId, "model.interrupted");
    assert.deepEqual(interrupted.map((r) => r.reason), ["deadline"]);
    assert.equal(manual.core.reserved.turns, 0);
  }
});

test("a step whose turn does not count reserves nothing for its repair", async (t) => {
  const calls: Calls = new Map();
  const driver: Driver = async (ctx) => together([
    ["b", () => ctx.model("b", plain)],
    ["a", () => ctx.model("a", structured({ purpose: "step", countsAsTurn: false }))],
  ]);
  const h = await createHarness(t, { models: models(calls), drivers: { agent: driver }, autoStart: false });
  const agent = await h.saveAgent();
  const runId = await crashedAfterInvalid(h, agent.id, { maxTurns: 1 }, false);
  const manual = await h.claimSession();
  await settled(manual);
  const done = await h.store.getRun(runId);
  assert.equal(done?.status, "completed", JSON.stringify(done?.error));
  assert.deepEqual(done?.output, { b: "plain", a: { n: 3 } });
  assert.equal(done?.usage.turns, 1);

  const live = await h.start(agent.id, {}, { maxTurns: 1 });
  const second = await h.claimSession();
  await settled(second);
  assert.equal((await h.store.getRun(live.id))?.status, "completed");
  assert.equal(second.core.repairTurns.size, 0);
});

// ---------------------------------------------------------------- openRepairs

function journal(records: NewJournalRecord[]): JournalRecord[] {
  return records.map((r, i) => ({ runId: "run_1", seq: i + 1, epoch: 1, ts: 1000 + i, type: r.type, key: r.key ?? null, data: r.data }));
}

const limits: RunLimits = { maxCostMicros: null, maxToolCalls: null, maxTurns: null, allowUnpriced: false };

test("openRepairs lists exactly the keys whose repair is open and whose turn counts", () => {
  const repairStarted = (key: string): NewJournalRecord => newRecord("model.started", {
    model: "p/m", purpose: "run", step: null, turn: 1, countsAsTurn: true, inputTokensEstimate: 1200, maxOutputTokens: 100,
    worstCaseMicros: 1700, repair: true, attempt: 1,
  }, key);
  const finishedReply = (key: string): NewJournalRecord => newRecord("model.finished", {
    model: "p/m", purpose: "run", text: "", toolCalls: [], output: { n: 3 }, stopReason: "end", usage, costMicros: 20, durationMs: 1,
  }, key);
  const interrupted = (key: string, reason: "pause" | "deadline" | "crash"): NewJournalRecord =>
    newRecord("model.interrupted", { model: "p/m", reason, assumedCostMicros: 1700, attempt: 1 }, key);
  const state = replayJournal(journal([
    firstStarted("open", true), invalidReply("open"),
    firstStarted("finished", true), invalidReply("finished"), repairStarted("finished"), finishedReply("finished"),
    firstStarted("failed", true), invalidReply("failed"), repairStarted("failed"),
    newRecord("model.failed", { model: "p/m", error: { code: "model_output_invalid", message: "x" }, usage, costMicros: 20 }, "failed"),
    firstStarted("deadline", true), invalidReply("deadline"), repairStarted("deadline"), interrupted("deadline", "deadline"),
    firstStarted("paused", true), invalidReply("paused"), repairStarted("paused"), interrupted("paused", "pause"),
    firstStarted("crashed", true), invalidReply("crashed"), repairStarted("crashed"),
    newRecord("model.retry", { attempt: 1, delayMs: 5, code: "model_transient", message: "503", status: 503, billing: "none" }, "waiting"),
    firstStarted("waiting", true), invalidReply("waiting"), repairStarted("waiting"),
    newRecord("model.retry", { attempt: 1, delayMs: 5, code: "model_transient", message: "cut", status: null, billing: "unknown", assumedCostMicros: 1700 }, "waiting"),
    firstStarted("grader", false), invalidReply("grader"),
    firstStarted("plain", true), finishedReply("plain"),
  ]), limits);
  assert.deepEqual(openRepairs(state).sort(), ["crashed", "open", "paused", "waiting"]);
});
