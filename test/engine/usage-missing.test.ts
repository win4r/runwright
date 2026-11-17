/**
 * R15-01 / R15D-models-01, the engine half (rule U): a count the provider did not report is charged the bound it
 * was reserved with. A missing input count is the attempt's worst-case input tokens (`model.started`'s
 * `inputTokensEstimate`), a missing output count its `maxOutputTokens`; the usage row is `assumed`, the journal
 * record names the counts in `usageAssumed`, and replay reproduces the same charge because the filled usage is
 * what is journalled. So a reply is never charged less than what a provider that bills at most W billed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RunwrightError } from "../../src/core/errors.ts";
import { replayJournal } from "../../src/engine/state.ts";
import type { Driver } from "../../src/engine/types.ts";
import { worstCaseInputTokens } from "../../src/models/util.ts";
import type { ModelRequest, ModelResponse, UsageCount } from "../../src/models/types.ts";
import type { RunLimits } from "../../src/store/types.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import { createHarness, fakeModels, reply, type Harness } from "../helpers/engine.ts";

const NO_LIMITS: RunLimits = { maxCostMicros: null, maxToolCalls: null, maxTurns: null, allowUnpriced: false };

const noop: ToolDefinition = {
  name: "noop", description: "Does nothing.", parameters: { type: "object", properties: {} }, effect: "read",
  handler: async () => ({ content: "ok" }),
};

function usageRows(h: Harness, runId: string): { assumed: number; input: number; output: number; costMicros: number | null }[] {
  const db = new DatabaseSync(join(h.dir, "runwright.db"), { readOnly: true });
  try {
    return db.prepare("SELECT assumed, input_tokens, output_tokens, cost_micros FROM usage WHERE run_id = ? ORDER BY rowid").all(runId)
      .map((row) => ({
        assumed: Number(row["assumed"]), input: Number(row["input_tokens"]), output: Number(row["output_tokens"]),
        costMicros: row["cost_micros"] === null ? null : Number(row["cost_micros"]),
      }));
  } finally {
    db.close();
  }
}

/** A tool-calling reply with the given counts missing (and the others as given). */
function noUsageTurn(missing: readonly UsageCount[], usage?: { inputTokens?: number; outputTokens?: number }): ModelResponse {
  return reply({ toolCalls: [{ id: "c", name: "noop", args: {} }], usage: usage ?? {}, usageMissing: missing });
}

test("(R15-01) the reviewer's probe: replies with no usage are charged their worst case, so the second call is not admitted", async (t) => {
  let requests = 0;
  const models = fakeModels(() => {
    requests += 1;
    return noUsageTurn(["input", "output"]);
  });
  // fakePricing: 1 micro per input token, 5 per output token; 1900 output tokens make W about 10 600.
  const h = await createHarness(t, { models, tools: [noop], engine: { defaultMaxOutputTokens: 1900 } });
  const agent = await h.saveAgent({ tools: [{ name: "noop" }] });
  const run = await h.start(agent.id, {}, { maxCostMicros: 20_000 });
  const paused = await h.until(run.id, "waiting");
  assert.equal(requests, 1, "on round 15 five calls ran");
  const [pending] = await h.pendings(run.id);
  assert.equal(pending?.kind, "spend_cap");
  const [started] = await h.records(run.id, "model.started");
  const worstCase = started?.worstCaseMicros ?? 0;
  assert.ok(worstCase > 10_000 && worstCase <= 20_000, `W = ${worstCase}`);
  assert.equal(paused.usage.costMicros, worstCase);
  assert.ok(paused.usage.costMicros <= 20_000, "recorded spend never exceeds the cap");
  assert.deepEqual(usageRows(h, run.id), [{ assumed: 1, input: started?.inputTokensEstimate ?? -1, output: 1900, costMicros: worstCase }]);
});

test("(R15-01) a partial report: only the missing count is charged its bound, and a replay computes the same usage", async (t) => {
  const replies: ModelResponse[] = [
    noUsageTurn(["output"], { inputTokens: 1000 }),
    noUsageTurn(["input"], { outputTokens: 7 }),
    reply({ text: "done", usage: { inputTokens: 3, outputTokens: 2 } }),
  ];
  let index = 0;
  const models = fakeModels(() => replies[index++] as ModelResponse);
  const h = await createHarness(t, { models, tools: [noop], engine: { defaultMaxOutputTokens: 300 } });
  const agent = await h.saveAgent({ tools: [{ name: "noop" }] });
  const run = await h.start(agent.id);
  const done = await h.until(run.id, "completed");
  const started = await h.records(run.id, "model.started");
  const finished = await h.records(run.id, "model.finished");
  const estimate2 = started[1]?.inputTokensEstimate ?? -1;

  assert.deepEqual(finished.map((f) => f.usage), [
    { inputTokens: 1000, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 },
    { inputTokens: estimate2, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
    { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
  ]);
  assert.deepEqual(finished.map((f) => f.costMicros), [1000 + 300 * 5, estimate2 + 7 * 5, 3 + 2 * 5]);
  assert.deepEqual(finished.map((f) => f.usageAssumed ?? null), [["output"], ["input"], null]);
  assert.deepEqual(usageRows(h, run.id).map((r) => r.assumed), [1, 1, 0]);

  const journal = await h.journal(run.id);
  const replayed = replayJournal(journal, NO_LIMITS).usage;
  assert.deepEqual(replayed, done.usage, "a second session replaying the journal computes the same run usage");
  assert.equal(done.usage.costMicros, (1000 + 1500) + (estimate2 + 35) + 13);
});

test("(R15-01) a missing input count is priced at the highest input-side rate, as the reservation was", async (t) => {
  const pricing = {
    priceFor: () => ({ inputPerMTok: 1, outputPerMTok: 5, cacheWritePerMTok: 3 }),
    costMicros: (_ref: unknown, u: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }) =>
      u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens * 3 + u.outputTokens * 5,
    worstCaseMicros: (_ref: unknown, input: number, output: number) => input * 3 + output * 5,
  };
  const models = fakeModels(() => reply({ text: "done", usage: { outputTokens: 4 }, usageMissing: ["input"] }));
  const h = await createHarness(t, { models, pricing, engine: { defaultMaxOutputTokens: 100 } });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id);
  await h.until(run.id, "completed");
  const [started] = await h.records(run.id, "model.started");
  const [finished] = await h.records(run.id, "model.finished");
  const estimate = started?.inputTokensEstimate ?? -1;
  assert.equal(finished?.costMicros, estimate * 3 + 4 * 5);
  assert.ok((finished?.costMicros ?? 0) <= (started?.worstCaseMicros ?? 0));
});

/** A small deterministic generator (mulberry32). */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

test("(R15-01) property: against a provider that bills at most W, 200 runs never bill more than their cap", async (t) => {
  const RUNS = 200;
  const next = random(1501);
  const billed = new Map<string, number>();
  const caps = new Map<string, number>();
  const breaches: string[] = [];
  let requests = 0;
  const respond = (request: ModelRequest): ModelResponse => {
    requests += 1;
    const runId = request.meta.runId;
    const estimate = worstCaseInputTokens(request);
    const input = Math.floor(next() * (estimate + 1));
    const output = Math.floor(next() * (request.maxOutputTokens + 1));
    const total = (billed.get(runId) ?? 0) + input + output * 5;
    billed.set(runId, total);
    const cap = caps.get(runId) ?? 0;
    if (total > cap) breaches.push(`${runId}: billed ${total} > cap ${cap}`);
    const kind = Math.floor(next() * 5);
    if (kind === 0) {
      throw new RunwrightError("model_transient", "the stream broke after the request was sent", { details: { billing: "unknown" } });
    }
    const missing: UsageCount[] = kind === 1 ? ["input", "output"] : kind === 2 ? ["input"] : kind === 3 ? ["output"] : [];
    const usage = { inputTokens: missing.includes("input") ? 0 : input, outputTokens: missing.includes("output") ? 0 : output };
    const finish = request.meta.turn >= 1 + Math.floor(next() * 8);
    return finish
      ? reply({ text: "done", usage, usageMissing: missing })
      : reply({ toolCalls: [{ id: "c", name: "noop", args: {} }], usage, usageMissing: missing });
  };
  const retry = { policy: { maxAttempts: 3, baseMs: 0, maxMs: 0 }, random: () => 0, sleep: async () => undefined };
  const h = await createHarness(t, {
    models: fakeModels(respond, retry), tools: [noop], engine: { defaultMaxOutputTokens: 200, concurrency: 16 },
  });
  const agent = await h.saveAgent({ tools: [{ name: "noop" }] });
  const runIds: string[] = [];
  for (let i = 0; i < RUNS; i++) {
    const cap = 2000 + Math.floor(next() * 12_000);
    const run = await h.start(agent.id, {}, { maxCostMicros: cap });
    caps.set(run.id, cap);
    runIds.push(run.id);
  }
  const statuses = new Set<string>();
  for (const runId of runIds) {
    const end = await h.until(runId, ["completed", "waiting", "failed"], 30_000);
    statuses.add(end.status);
    assert.ok(end.usage.costMicros <= (caps.get(runId) ?? 0), `${runId}: recorded ${end.usage.costMicros}`);
    assert.ok(end.usage.costMicros >= (billed.get(runId) ?? 0), `${runId}: recorded ${end.usage.costMicros} >= billed ${billed.get(runId) ?? 0}`);
  }
  assert.deepEqual(breaches, []);
  assert.ok(statuses.has("completed") && statuses.has("waiting"), [...statuses].join(", "));
  assert.ok(requests > 2 * RUNS, `${requests} requests`);
});

test("(R15-01) a structured step whose invalid first reply has no usage: model.invalid is charged by the same rule", async (t) => {
  const outputs: ModelResponse[] = [
    reply({ output: { wrong: true }, usageMissing: ["input", "output"] }),
    reply({ output: { still: "wrong" }, usage: { inputTokens: 5 }, usageMissing: ["output"] }),
  ];
  let index = 0;
  const driver: Driver = async (ctx) => {
    try {
      await ctx.model("s", {
        purpose: "step", system: "s", messages: [{ role: "user", content: "x" }],
        output: { name: "answer", schema: { type: "object", required: ["x"], properties: { x: { type: "string" } } } },
      });
    } catch (error) {
      return { code: error instanceof RunwrightError ? error.code : "other" };
    }
    return { code: "none" };
  };
  const h = await createHarness(t, {
    models: fakeModels(() => outputs[index++] as ModelResponse), drivers: { agent: driver }, engine: { defaultMaxOutputTokens: 50 },
  });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id);
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, { code: "model_output_invalid" });
  const [first, repair] = await h.records(run.id, "model.started");
  const [invalid] = await h.records(run.id, "model.invalid");
  assert.deepEqual(invalid?.usage, { inputTokens: first?.inputTokensEstimate, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 });
  assert.equal(invalid?.costMicros, first?.worstCaseMicros);
  assert.deepEqual(invalid?.usageAssumed, ["input", "output"]);
  const [failed] = await h.records(run.id, "model.failed");
  assert.deepEqual(failed?.usage, { inputTokens: 5, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 });
  assert.equal(failed?.costMicros, 5 + 250);
  assert.deepEqual(failed?.usageAssumed, ["output"]);
  assert.deepEqual(usageRows(h, run.id).map((r) => [r.assumed, r.costMicros]), [[1, first?.worstCaseMicros], [1, 255]]);
  assert.ok(repair?.repair === true);
  assert.deepEqual(replayJournal(await h.journal(run.id), NO_LIMITS).usage, done.usage);
});
