/**
 * Invariant M (R13D-engine-02): every `model.started` is closed under its key by exactly one record, and an attempt
 * that may have been sent is charged its worst case exactly once. An attempt left unfinished by a crash is charged
 * when the run is next claimed, in the claim's own commit and before any command is applied, so a cancel, a
 * passed deadline or a spend cap all see the charge; a run that ends for good with an attempt still unfinished
 * settles it in its final commit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { RunwrightError } from "../../src/core/errors.ts";
import type { Json } from "../../src/core/json.ts";
import type { GenerateOptions, ModelResponse } from "../../src/models/types.ts";
import type { JournalRecord, RunLimits } from "../../src/store/types.ts";
import type { Driver } from "../../src/engine/types.ts";
import { newRecord } from "../../src/engine/journal-types.ts";
import { replayJournal } from "../../src/engine/state.ts";
import { settlementBatch } from "../../src/engine/session.ts";
import { createHarness, fakeModels, reply, type Harness } from "../helpers/engine.ts";
import { waitFor } from "../helpers/wait.ts";

function usageRows(h: Harness, runId: string): { assumed: number; costMicros: number | null }[] {
  const db = new DatabaseSync(join(h.dir, "runwright.db"), { readOnly: true });
  try {
    return db.prepare("SELECT assumed, cost_micros FROM usage WHERE run_id = ? ORDER BY rowid").all(runId)
      .map((row) => ({ assumed: Number(row["assumed"]), costMicros: row["cost_micros"] === null ? null : Number(row["cost_micros"]) }));
  } finally {
    db.close();
  }
}

function hang(options: GenerateOptions): Promise<ModelResponse> {
  return new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new RunwrightError("aborted", "the model call was aborted")), { once: true });
  });
}

/** A model whose first call hangs until aborted; every later call answers at once. */
function hangingFirstModels(): { models: ReturnType<typeof fakeModels>; calls: () => number } {
  let calls = 0;
  const models = fakeModels((_request, options) => {
    calls++;
    if (calls === 1) return hang(options);
    return reply({ text: "answered", usage: { inputTokens: 10, outputTokens: 2 } });
  });
  return { models, calls: () => calls };
}

const lastIsStarted = (h: Harness, runId: string, key: string) => async (): Promise<boolean> => {
  const last = (await h.journal(runId)).at(-1);
  return last?.type === "model.started" && last.key === key;
};

/** The records written after the second claim, as `type [key]`. */
function afterClaim(journal: readonly JournalRecord[], claim: number): string[] {
  const claims = journal.filter((r) => r.type === "run.claimed");
  const at = journal.indexOf(claims[claim - 1] as JournalRecord);
  return journal.slice(at).map((r) => (r.key === null ? r.type : `${r.type} [${r.key}]`));
}

for (const priced of [true, false]) {
  test(`a cancel sent while the process is down still charges the crashed attempt (${priced ? "priced" : "unpriced"} model)`, async (t) => {
    const { models, calls } = hangingFirstModels();
    const h = await createHarness(t, { models });
    const agent = await h.saveAgent(priced ? {} : { model: { provider: "scripted", name: "unpriced-1" } });
    const run = await h.start(agent.id);
    await waitFor(lastIsStarted(h, run.id, "t1"));
    await h.runner.abandon();
    await h.send(run.id, { type: "cancel", reason: "changed my mind" });
    h.runner = h.newRunner();
    const done = await h.until(run.id, "cancelled");

    assert.equal(calls(), 1, "the request was not sent again");
    const [started] = await h.records(run.id, "model.started");
    assert.ok(started !== undefined);
    assert.deepEqual(await h.records(run.id, "model.interrupted"), [
      { model: started.model, reason: "crash", assumedCostMicros: started.worstCaseMicros, attempt: 1 },
    ]);
    const journal = await h.journal(run.id);
    assert.deepEqual(afterClaim(journal, 2).slice(0, 3), ["run.claimed", "model.interrupted [t1]", "command.applied"],
      "charged in the claim's batch, before the cancel is applied");
    const claim = journal.filter((r) => r.type === "run.claimed")[1] as JournalRecord;
    const charge = journal.find((r) => r.type === "model.interrupted") as JournalRecord;
    assert.equal(charge.seq, claim.seq + 1);
    assert.deepEqual(usageRows(h, run.id), [{ assumed: 1, costMicros: started.worstCaseMicros }]);
    if (priced) {
      assert.ok(typeof started.worstCaseMicros === "number" && started.worstCaseMicros > 0);
      assert.equal(done.usage.costMicros, started.worstCaseMicros);
      assert.equal(done.usage.costUnknown, false);
    } else {
      assert.equal(started.worstCaseMicros, null);
      assert.equal(done.usage.costUnknown, true);
    }
    assert.equal(done.usage.inputTokens, started.inputTokensEstimate);
    assert.equal(done.usage.outputTokens, started.maxOutputTokens);
  });
}

test("an enclosing deadline that passed while the process was down fails the run, and the crashed attempt is charged once", async (t) => {
  const DEADLINE_MS = 1500;
  const { models } = hangingFirstModels();
  const driver: Driver = async (ctx) => {
    const begun = await ctx.memo("begin", { recordType: "step", name: "begin" }, async ({ startedAt }) => ({ at: startedAt }));
    return ctx.deadline(DEADLINE_MS, async (scoped) => {
      const answer = await scoped.model("slow", { purpose: "run", system: "s", messages: [{ role: "user", content: "go" }] });
      return answer.text;
    }, { startedAt: (begun as { at: number }).at });
  };
  const h = await createHarness(t, { models, drivers: { agent: driver } });
  const run = await h.start((await h.saveAgent()).id);
  await waitFor(lastIsStarted(h, run.id, "slow"));
  await h.runner.abandon();
  const [begin] = (await h.journal(run.id)).filter((r) => r.type === "step.started");
  await waitFor(() => Date.now() > (begin as JournalRecord).ts + DEADLINE_MS + 20, { timeoutMs: DEADLINE_MS + 2000 });
  h.runner = h.newRunner();
  const done = await h.until(run.id, "failed");

  assert.equal(done.error?.code, "deadline_exceeded");
  const [started] = await h.records(run.id, "model.started");
  const interrupted = await h.records(run.id, "model.interrupted");
  assert.deepEqual(interrupted.map((r) => r.reason), ["crash"]);
  assert.equal(done.usage.costMicros, started?.worstCaseMicros);
  assert.equal(usageRows(h, run.id).length, 1);
});

test("two crashes in a row: the unfinished attempt is charged once, at the first claim after it", async (t) => {
  let passes = 0;
  let modelCalls = 0;
  const models = fakeModels((_request, options) => {
    modelCalls++;
    return modelCalls === 1 ? hang(options) : reply({ text: "answered", usage: { inputTokens: 10, outputTokens: 2 } });
  });
  const driver: Driver = async (ctx) => {
    passes++;
    // The second session stops before any step until it is killed.
    if (passes === 2) await ctx.sleep(60_000);
    const answer = await ctx.model("t1", { purpose: "run", system: "s", messages: [{ role: "user", content: "go" }], turn: 1 });
    return answer.text;
  };
  const h = await createHarness(t, { models, drivers: { agent: driver } });
  const run = await h.start((await h.saveAgent()).id);
  await waitFor(lastIsStarted(h, run.id, "t1"));
  await h.runner.abandon();
  h.runner = h.newRunner();
  await waitFor(() => passes === 2);
  await h.runner.abandon();
  h.runner = h.newRunner();
  const done = await h.until(run.id, "completed");

  assert.equal(passes, 3);
  const journal = await h.journal(run.id);
  assert.equal(journal.filter((r) => r.type === "run.claimed").length, 3);
  assert.deepEqual(afterClaim(journal, 2).slice(0, 2), ["run.claimed", "model.interrupted [t1]"], "charged at the second claim");
  assert.equal(afterClaim(journal, 3)[1], "model.started [t1]", "the third claim charges nothing again");
  assert.deepEqual(journal.filter((r) => r.type.startsWith("model.")).map((r) => [r.type, r.data["attempt"] ?? null]), [
    ["model.started", 1], ["model.interrupted", 1], ["model.started", 1], ["model.finished", null],
  ]);
  const [started] = await h.records(run.id, "model.started");
  const [finished] = await h.records(run.id, "model.finished");
  assert.equal(done.usage.costMicros, (started?.worstCaseMicros ?? 0) + (finished?.costMicros ?? 0));
  assert.deepEqual(usageRows(h, run.id).map((r) => r.assumed), [1, 0]);
});

test("a crash and a plain resume: the step runs again at the same attempt, charged one assumed attempt plus the real one", async (t) => {
  const { models, calls } = hangingFirstModels();
  const h = await createHarness(t, { models });
  const run = await h.start((await h.saveAgent()).id);
  await waitFor(lastIsStarted(h, run.id, "t1"));
  await h.crashAndReplace();
  const done = await h.until(run.id, "completed");
  assert.equal(calls(), 2);
  const journal = await h.journal(run.id);
  assert.deepEqual(afterClaim(journal, 2), [
    "run.claimed", "model.interrupted [t1]", "model.started [t1]", "model.finished [t1]", "run.output", "run.completed",
  ]);
  const started = await h.records(run.id, "model.started");
  assert.deepEqual(started.map((s) => s.attempt), [1, 1]);
  const [finished] = await h.records(run.id, "model.finished");
  assert.equal(done.usage.costMicros, (started[0]?.worstCaseMicros ?? 0) + (finished?.costMicros ?? 0));
});

test("a run that fails while a parallel model call is in flight settles that call once in its final commit", async (t) => {
  let releaseSlow: () => void = () => undefined;
  const slowGate = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  const models = fakeModels(async (request) => {
    if (request.meta.key === "fast") throw new RunwrightError("model_failed", "the fast call is refused", { details: { status: 400, billing: "none" } });
    await slowGate;
    return reply({ text: "too late", usage: { inputTokens: 1, outputTokens: 1 } });
  });
  const driver: Driver = async (ctx) => {
    const ask = (key: string) => ctx.model(key, { purpose: "run", system: "s", messages: [{ role: "user", content: key }] });
    const slow = ask("slow");
    slow.catch(() => undefined);
    await waitFor(() => ctx.journal().some((r) => r.type === "model.started" && r.key === "slow"));
    await ask("fast");
    return (await slow).text as Json;
  };
  const h = await createHarness(t, { models, drivers: { agent: driver } });
  const run = await h.start((await h.saveAgent()).id);
  const done = await h.until(run.id, "failed");
  releaseSlow();
  await new Promise((resolve) => setTimeout(resolve, 100));

  const slowRecords = (await h.journal(run.id)).filter((r) => r.key === "slow").map((r) => r.type);
  assert.deepEqual(slowRecords, ["model.started", "model.interrupted"], "one closing record; the late reply is refused");
  const [started] = (await h.records(run.id, "model.started")).filter((s) => s.attempt === 1);
  assert.ok(started !== undefined);
  const after = await h.store.getRun(run.id);
  assert.equal(done.usage.costMicros, after?.usage.costMicros);
  const slowStarted = (await h.journal(run.id)).find((r) => r.type === "model.started" && r.key === "slow") as JournalRecord;
  assert.equal(after?.usage.costMicros, slowStarted.data["worstCaseMicros"], "only the unfinished slow call is charged");
  const journal = await h.journal(run.id);
  const end = journal.findIndex((r) => r.type === "run.failed");
  const settle = journal.findIndex((r) => r.type === "model.interrupted" && r.key === "slow");
  assert.equal(settle, end - 1, "settled in the run's final commit, before its end record");
  assert.equal(journal[end]?.seq, (journal[settle]?.seq ?? 0) + 1);
});

test("settlementBatch builds 200 000 undelivered messages and 200 000 open pendings without a RangeError", () => {
  const limits: RunLimits = { maxCostMicros: null, maxToolCalls: null, maxTurns: null, allowUnpriced: false };
  const N = 200_000;
  const state = replayJournal([], limits);
  for (let i = 0; i < N; i++) {
    state.messages.push({ commandId: `cmd_${i}`, text: "m", at: i });
    state.pendings.set(`pend_${i}`, {
      id: `pend_${i}`, kind: "question", stepKey: `q${i}`, title: "q", detail: {}, status: "open", resolution: null,
    });
  }
  const settled = settlementBatch(state, "cancelled");
  assert.equal(settled.records.length, 2 * N);
  assert.equal(settled.resolvePendings.length, N);
  assert.equal(settled.records[0]?.type, "message.undelivered");
  assert.equal(settled.records[N]?.type, "pending.resolved");
  assert.deepEqual(settled.usage, []);
});

test("settlementBatch charges every unfinished model start, first, with its assumed usage row", () => {
  const limits: RunLimits = { maxCostMicros: null, maxToolCalls: null, maxTurns: null, allowUnpriced: false };
  const started = (attempt: number) => newRecord("model.started", {
    model: "p/m", purpose: "run", step: null, turn: 1, countsAsTurn: true, inputTokensEstimate: 40, maxOutputTokens: 8,
    worstCaseMicros: 80, attempt,
  }, "k");
  const records = [started(2)].map((r, i): JournalRecord => ({ runId: "r", seq: i + 1, epoch: 1, ts: i, type: r.type, key: r.key ?? null, data: r.data }));
  const state = replayJournal(records, limits);
  state.messages.push({ commandId: "c", text: "m", at: 0 });
  const settled = settlementBatch(state, "completed");
  assert.deepEqual(settled.records.map((r) => r.type), ["model.interrupted", "message.undelivered"]);
  assert.deepEqual(settled.records[0]?.data, { model: "p/m", reason: "crash", assumedCostMicros: 80, attempt: 2 });
  assert.deepEqual(settled.usage, [{
    model: "p/m", purpose: "run", inputTokens: 40, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 80, assumed: true,
  }]);
});
