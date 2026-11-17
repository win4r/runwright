import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createModelRegistry } from "../../src/models/registry.ts";
import { createHarness } from "../helpers/engine.ts";
import { fakeFetch, sse, type FakeReply } from "../models/fake-fetch.ts";

/**
 * R13D-models-01: an OpenAI-compatible server that answers 200 and then streams an error envelope. A transient
 * envelope retries through the engine like a 503 status; a non-transient one fails the call at once.
 */

const model = { provider: "openai-compatible" as const, name: "gpt-envelope", baseUrl: "http://127.0.0.1:9/v1" };

const delta = (content: string, finish: string | null = null): { data: unknown } =>
  ({ data: { choices: [{ index: 0, delta: { content }, finish_reason: finish }] } });

const brokenReply: FakeReply = {
  chunks: [sse([delta("Hel"), { data: { error: { code: 503, message: "temporarily unavailable" } } }])],
};
const goodReply: FakeReply = {
  chunks: [sse([
    delta("Hello"), delta("", "stop"),
    { data: { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } } }, { data: "[DONE]" },
  ])],
};

async function harnessWith(t: TestContext, replies: FakeReply[], maxAttempts: number) {
  const fake = fakeFetch(replies);
  const models = createModelRegistry({
    secrets: { reveal: async () => ({}) },
    retry: { maxAttempts, baseMs: 1, maxMs: 2 },
    fetch: fake.fetch,
    random: () => 0,
    sleep: async () => undefined,
  });
  const h = await createHarness(t, { models });
  const agent = await h.saveAgent({ model });
  return { h, fake, agent };
}

function usageRows(dir: string, runId: string): { assumed: number }[] {
  const db = new DatabaseSync(join(dir, "runwright.db"), { readOnly: true });
  try {
    return db.prepare("SELECT assumed FROM usage WHERE run_id = ? ORDER BY id").all(runId).map((row) => ({ assumed: Number(row["assumed"]) }));
  } finally {
    db.close();
  }
}

test("a 503 envelope streamed after a text delta is retried and the run completes", async (t) => {
  const { h, fake, agent } = await harnessWith(t, [brokenReply, goodReply], 3);
  const run = await h.start(agent.id);
  const done = await h.until(run.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(fake.calls.length, 2);
  const retries = await h.records(run.id, "model.retry");
  assert.equal(retries.length, 1);
  assert.equal(retries[0]?.status, 503);
  assert.equal(retries[0]?.billing, "unknown");
  assert.equal(retries[0]?.code, "model_transient");
  assert.equal((await h.records(run.id, "model.finished")).length, 1);
  assert.equal((await h.records(run.id, "model.failed")).length, 0);
  const rows = usageRows(h.dir, run.id);
  assert.equal(rows.filter((row) => row.assumed === 1).length, 1, JSON.stringify(rows));
  assert.equal(rows.filter((row) => row.assumed === 0).length, 1, JSON.stringify(rows));
});

test("with maxAttempts 1 the transient envelope fails the run with the exhausted-retries error", async (t) => {
  const { h, fake, agent } = await harnessWith(t, [brokenReply, goodReply], 1);
  const run = await h.start(agent.id);
  const done = await h.until(run.id, ["completed", "failed"]);
  assert.equal(done.status, "failed");
  assert.equal(fake.calls.length, 1);
  assert.match(done.error?.message ?? "", /model call failed after 1 attempt \(last error: status 503\)/);
  assert.equal((await h.records(run.id, "model.retry")).length, 0);
});

test("a non-transient envelope fails the run on the first attempt with no model.retry", async (t) => {
  const invalid: FakeReply = { chunks: [sse([delta("Hel"), { data: { error: { code: "invalid_api_key", message: "bad key" } } }])] };
  const { h, fake, agent } = await harnessWith(t, [invalid, goodReply], 3);
  const run = await h.start(agent.id);
  const done = await h.until(run.id, ["completed", "failed"]);
  assert.equal(done.status, "failed");
  assert.equal(fake.calls.length, 1);
  assert.match(done.error?.message ?? "", /openai-compatible stream error: bad key/);
  assert.equal((await h.records(run.id, "model.retry")).length, 0);
  const failed = await h.records(run.id, "model.failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.error.code, "model_failed");
});

/**
 * R14D-models-01 through the engine: an Anthropic stream whose `message_delta` has a `stop_reason` but no
 * `output_tokens` is a reply failure with unknown billing. The attempt is charged its worst case as an assumed
 * cost (never the `output_tokens: 0` of `message_start`), nothing is retried, and the run fails.
 */
const anthropicModel = { provider: "anthropic" as const, name: "claude-usage-probe" };

const anthropicStream = (deltaUsage: Record<string, unknown>): FakeReply => ({
  chunks: [sse([
    { event: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 12, output_tokens: 0 } } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "a long answer" } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, ...deltaUsage } },
    { event: "message_stop", data: { type: "message_stop" } },
  ])],
});

async function anthropicHarness(t: TestContext, replies: FakeReply[]) {
  const fake = fakeFetch(replies);
  const models = createModelRegistry({
    secrets: { reveal: async () => ({ ANTHROPIC_API_KEY: "sk-ant-test-key-0001" }) },
    retry: { maxAttempts: 3, baseMs: 1, maxMs: 2 },
    fetch: fake.fetch,
    random: () => 0,
    sleep: async () => undefined,
  });
  const h = await createHarness(t, { models, secrets: { ANTHROPIC_API_KEY: "sk-ant-test-key-0001" } });
  const agent = await h.saveAgent({ model: anthropicModel });
  return { h, fake, agent };
}

test("(R14D-models-01) an Anthropic stream without final output_tokens is charged its worst case and fails the run", async (t) => {
  for (const deltaUsage of [{}, { usage: {} }, { usage: { output_tokens: null } }]) {
    const { h, fake, agent } = await anthropicHarness(t, [anthropicStream(deltaUsage), anthropicStream({ usage: { output_tokens: 7 } })]);
    const run = await h.start(agent.id);
    const done = await h.until(run.id, ["completed", "failed"]);
    const label = JSON.stringify(deltaUsage);
    assert.equal(done.status, "failed", label);
    assert.equal(fake.calls.length, 1, `a reply failure is not retried: ${label}`);
    assert.match(done.error?.message ?? "", /no output_tokens in a message_delta/, label);
    const started = await h.records(run.id, "model.started");
    assert.equal(started.length, 1);
    const worst = Number(started[0]?.worstCaseMicros);
    assert.ok(worst > 0, label);
    const failed = await h.records(run.id, "model.failed");
    assert.equal(failed.length, 1, label);
    assert.equal(failed[0]?.error.code, "model_failed");
    assert.equal(failed[0]?.assumedCostMicros, worst, `the failed attempt is charged its worst case: ${label}`);
    assert.deepEqual(usageRows(h.dir, run.id), [{ assumed: 1 }], label);
    assert.equal(done.usage.costMicros, worst, `the run's cost is the worst case, not the start count: ${label}`);
    assert.equal(await h.records(run.id, "model.finished").then((rows) => rows.length), 0, label);
  }
});

test("(R14D-models-01) the same Anthropic stream with output_tokens in its message_delta completes, billed as reported", async (t) => {
  const { h, agent } = await anthropicHarness(t, [anthropicStream({ usage: { output_tokens: 7 } })]);
  const run = await h.start(agent.id);
  const done = await h.until(run.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.deepEqual(usageRows(h.dir, run.id), [{ assumed: 0 }]);
  assert.equal(done.usage.outputTokens, 7);
  assert.equal(done.usage.inputTokens, 12);
});
