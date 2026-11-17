/**
 * R02-01 through the real providers: the Anthropic and OpenAI-compatible providers from `createModelRegistry`,
 * over a fake `fetch`, driven by the engine. A stream that breaks after the provider started to answer is charged
 * its worst case and retried as a new, separately journalled attempt; an HTTP 429 is retried for free after the
 * provider's retry-after hint.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createModelRegistry } from "../../src/models/registry.ts";
import type { ModelRef } from "../../src/models/types.ts";
import { worstCaseInputTokens } from "../../src/models/util.ts";
import type { Driver, ModelStepRequest } from "../../src/engine/types.ts";
import { createHarness, fakePricing } from "../helpers/engine.ts";
import { fakeFetch, sse, type FakeReply } from "../models/fake-fetch.ts";

const STEP: ModelStepRequest = { purpose: "step", system: "s", messages: [{ role: "user", content: "go" }], maxOutputTokens: 100 };
const driver: Driver = async (ctx) => (await ctx.model("m", STEP)).text;
const POLICY = { maxAttempts: 3, baseMs: 1, maxMs: 1000 };
const KEY = "sk-ant-retry-provider-test";

const worstCase = (ref: ModelRef): number =>
  fakePricing().worstCaseMicros(ref, worstCaseInputTokens({ system: "s", messages: STEP.messages, tools: [], output: null }), 100) as number;
/** fakePricing: 1 micro-dollar per input token, 5 per output token; both replies report 10 in, 3 out. */
const REPLY_COST = 10 + 3 * 5;

const anthropicEvents = [
  { event: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } } },
  { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
  { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } } },
  { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } } },
  { event: "message_stop", data: { type: "message_stop" } },
];
const openaiEvents = [
  { data: { choices: [{ index: 0, delta: { content: "hello" } }] } },
  { data: { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3 } } },
  { data: "[DONE]" },
];

interface Case { name: string; ref: ModelRef; complete: string; truncated: string }
const CASES: Case[] = [
  { name: "anthropic", ref: { provider: "anthropic", name: "claude-test-1" }, complete: sse(anthropicEvents), truncated: sse(anthropicEvents.slice(0, 3)) },
  {
    name: "openai-compatible", ref: { provider: "openai-compatible", name: "gpt-test-1", baseUrl: "http://127.0.0.1:9/v1" },
    complete: sse(openaiEvents), truncated: sse(openaiEvents.slice(0, 1)),
  },
];

async function setup(t: Parameters<typeof createHarness>[0], item: Case, replies: FakeReply[]) {
  const fake = fakeFetch(replies);
  const sleeps: number[] = [];
  const models = createModelRegistry({
    secrets: { reveal: async (names) => Object.fromEntries(names.filter((n) => n === "ANTHROPIC_API_KEY").map((n) => [n, KEY])) },
    retry: POLICY, fetch: fake.fetch, random: () => 0,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  const h = await createHarness(t, { models, drivers: { agent: driver } });
  const agent = await h.saveAgent({ model: item.ref });
  return { h, agent, fake, sleeps };
}

for (const item of CASES) {
  test(`${item.name}: a stream that ends early is charged its worst case and retried as attempt 2`, async (t) => {
    const { h, agent, fake } = await setup(t, item, [{ chunks: [item.truncated] }, { chunks: [item.complete] }]);
    const run = await h.start(agent.id);
    const done = await h.until(run.id, "completed");
    const W = worstCase(item.ref);
    assert.equal(done.output, "hello");
    assert.equal(fake.calls.length, 2);
    const [retry] = await h.records(run.id, "model.retry");
    assert.equal(retry?.attempt, 1);
    assert.equal(retry?.billing, "unknown");
    assert.equal(retry?.assumedCostMicros, W);
    assert.equal(retry?.code, "model_transient");
    assert.match(retry?.message ?? "", /stream ended before it finished/);
    assert.deepEqual((await h.records(run.id, "model.started")).map((s) => s.attempt), [1, 2]);
    assert.equal((await h.records(run.id, "model.finished")).length, 1);
    assert.equal(done.usage.costMicros, W + REPLY_COST);
  });

  test(`${item.name}: an HTTP 429 is retried after the retry-after hint and charged nothing`, async (t) => {
    const { h, agent, fake, sleeps } = await setup(t, item, [
      { status: 429, headers: { "retry-after": "2" }, text: JSON.stringify({ error: { message: "slow down" } }) },
      { chunks: [item.complete] },
    ]);
    const run = await h.start(agent.id, {}, { maxCostMicros: worstCase(item.ref) });
    const done = await h.until(run.id, "completed");
    assert.equal(fake.calls.length, 2);
    const [retry] = await h.records(run.id, "model.retry");
    assert.equal(retry?.status, 429);
    assert.equal(retry?.billing, "none");
    assert.equal(retry?.delayMs, 2000);
    assert.equal(Object.hasOwn(retry ?? {}, "assumedCostMicros"), false);
    assert.deepEqual(sleeps, [2000]);
    assert.equal(done.usage.costMicros, REPLY_COST);
  });

  test(`${item.name}: a Retry-After longer than ten times maxMs is waited out in full`, async (t) => {
    const { h, agent, fake, sleeps } = await setup(t, item, [
      { status: 429, headers: { "retry-after": "45" }, text: JSON.stringify({ error: { message: "slow down" } }) },
      { chunks: [item.complete] },
    ]);
    const run = await h.start(agent.id);
    const done = await h.until(run.id, "completed");
    assert.equal(done.output, "hello");
    assert.equal(fake.calls.length, 2);
    assert.deepEqual(sleeps, [45000], "the provider's wait, not 10 x maxMs");
    const [retry] = await h.records(run.id, "model.retry");
    assert.equal(retry?.delayMs, 45000);
    assert.equal(retry?.retryAfterMs, 45000);
  });

  const overLimit: [string, number, Record<string, string>, (ms: number) => boolean][] = [
    ["a 400-digit Retry-After", 429, { "retry-after": "9".repeat(400) }, (ms) => ms === Number.MAX_SAFE_INTEGER],
    ["a far-future Retry-After date", 429, { "retry-after": "Fri, 31 Dec 9999 23:59:59 GMT" }, (ms) => ms > 1e12],
    ["retry-after-ms: 1e400", 503, { "retry-after-ms": "1e400" }, (ms) => ms === Number.MAX_SAFE_INTEGER],
  ];
  for (const [label, status, headers, expected] of overLimit) {
    test(`${item.name}: ${label} stops the call after one request instead of retrying early`, async (t) => {
      const { h, agent, fake, sleeps } = await setup(t, item, [
        { status, headers, text: JSON.stringify({ error: { message: "come back later" } }) },
        { chunks: [item.complete] },
      ]);
      const run = await h.start(agent.id);
      const failed = await h.until(run.id, "failed");
      assert.equal(fake.calls.length, 1);
      assert.deepEqual(sleeps, []);
      const records = await h.records(run.id, "model.failed");
      assert.equal(records.length, 1);
      const [record] = records;
      assert.equal(record?.attempts, 1);
      assert.equal(record?.retryAfterOverLimit, true);
      assert.ok(typeof record?.retryAfterMs === "number" && expected(record.retryAfterMs), String(record?.retryAfterMs));
      assert.equal((await h.records(run.id, "model.retry")).length, 0);
      assert.equal(failed.error?.code, "model_failed");
      assert.ok(
        failed.error?.message.startsWith(`model call not retried after 1 attempt (last error: status ${status})`),
        failed.error?.message,
      );
    });
  }
}
