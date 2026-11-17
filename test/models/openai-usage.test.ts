// Rule U at the adapters (R15-01 / R15D-models-01): an adapter returns exactly the counts the provider reported
// and names every count it did not get; it never computes a substitute.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isRunwrightError } from "../../src/core/errors.ts";
import { createAnthropicProvider } from "../../src/models/anthropic.ts";
import { createOpenAiProvider } from "../../src/models/openai.ts";
import type { ModelResponse, Usage } from "../../src/models/types.ts";
import { fakeFetch, makeRequest, signal, sse, type FakeReply } from "./fake-fetch.ts";

const openAiModel = { provider: "openai-compatible" as const, name: "gpt-usage", baseUrl: "http://localhost:1/v1" };
const anthropicModel = { provider: "anthropic" as const, name: "claude-usage" };

const openAi = (reply: FakeReply): Promise<ModelResponse> =>
  createOpenAiProvider({ apiKey: null, baseUrl: openAiModel.baseUrl, fetch: fakeFetch([reply]).fetch }).generate(makeRequest(openAiModel), { signal: signal() });
const anthropic = (reply: FakeReply): Promise<ModelResponse> =>
  createAnthropicProvider({ apiKey: "sk-ant-usage-test-0123456789", fetch: fakeFetch([reply]).fetch }).generate(makeRequest(anthropicModel), { signal: signal() });

/** A streamed OpenAI-compatible reply "hello" whose usage chunks are `reports` (each one chunk's `usage`). */
function openAiStream(...reports: unknown[]): FakeReply {
  return {
    chunks: [sse([
      { data: { choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }] } },
      { data: { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] } },
      ...reports.map((usage) => ({ data: { choices: [], usage } })),
      { data: "[DONE]" },
    ])],
  };
}

/** A plain-JSON OpenAI-compatible reply "hello" with `usage` (left out when undefined). */
function openAiJson(usage: unknown): FakeReply {
  const body: Record<string, unknown> = { choices: [{ index: 0, message: { content: "hello" }, finish_reason: "stop" }] };
  if (usage !== undefined) body["usage"] = usage;
  return { text: JSON.stringify(body) };
}

const usage = (inputTokens: number, outputTokens: number, cacheReadTokens = 0): Usage => ({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens: 0 });

const reportCases: { name: string; report: unknown; usage: Usage; missing: string[] | undefined }[] = [
  { name: "no usage", report: undefined, usage: usage(0, 0), missing: ["input", "output"] },
  { name: "only prompt_tokens", report: { prompt_tokens: 1000 }, usage: usage(1000, 0), missing: ["output"] },
  { name: "only completion_tokens", report: { completion_tokens: 256 }, usage: usage(0, 256), missing: ["input"] },
  { name: "both", report: { prompt_tokens: 1000, completion_tokens: 256 }, usage: usage(1000, 256), missing: undefined },
];

for (const item of reportCases) {
  test(`(R15-01) OpenAI-compatible stream, ${item.name}: exactly the reported counts, the others named`, async () => {
    const reply = await openAi(item.report === undefined ? openAiStream() : openAiStream(item.report));
    assert.deepEqual(reply.usage, item.usage);
    assert.deepEqual(reply.usageMissing, item.missing);
    assert.equal(reply.text, "hello");
  });

  test(`(R15-01) OpenAI-compatible JSON, ${item.name}: exactly the reported counts, the others named`, async () => {
    const reply = await openAi(openAiJson(item.report));
    assert.deepEqual(reply.usage, item.usage);
    assert.deepEqual(reply.usageMissing, item.missing);
  });
}

test("(R15-01) a complete report leaves usageMissing out of the reply altogether", async () => {
  const reply = await openAi(openAiStream({ prompt_tokens: 1, completion_tokens: 1 }));
  assert.equal(Object.hasOwn(reply, "usageMissing"), false);
});

test("(R15-01) a stream whose usage arrives in two chunks, one count each, ends complete", async () => {
  for (const reports of [
    [{ prompt_tokens: 1000 }, { completion_tokens: 256 }],
    [{ completion_tokens: 256 }, { prompt_tokens: 1000 }],
  ]) {
    const reply = await openAi(openAiStream(...reports));
    assert.deepEqual(reply.usage, usage(1000, 256), JSON.stringify(reports));
    assert.equal(reply.usageMissing, undefined, JSON.stringify(reports));
  }
});

test("(R15-01) in a stream the last chunk reporting a count wins for that count; a usage-less chunk erases nothing", async () => {
  const reply = await openAi(openAiStream(
    { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 4 } },
    { completion_tokens: 30 },
    null,
    { prompt_tokens: 900, prompt_tokens_details: { cached_tokens: 100 } },
  ));
  assert.deepEqual(reply.usage, usage(800, 30, 100));
  assert.equal(reply.usageMissing, undefined);
});

test("(R15-01) cached_tokens without prompt_tokens is ignored: the input side is 0 and named missing", async () => {
  const details = { completion_tokens: 7, prompt_tokens_details: { cached_tokens: 500 } };
  for (const reply of [await openAi(openAiStream(details)), await openAi(openAiJson(details))]) {
    assert.deepEqual(reply.usage, usage(0, 7));
    assert.deepEqual(reply.usageMissing, ["input"]);
  }
});

test("(R15-01) a negative or fractional count is still a reply failure, on the stream and the JSON path", async () => {
  const failure = (error: unknown): boolean =>
    isRunwrightError(error) && error.code === "model_failed" && error.details?.["billing"] === "unknown" &&
    /openai-compatible sent a usage field \w+ that is not a non-negative number/.test(error.message);
  for (const report of [{ prompt_tokens: -1 }, { completion_tokens: 2.5 }, { prompt_tokens: 0.5, completion_tokens: 3 }, { completion_tokens: -3 }]) {
    await assert.rejects(openAi(openAiStream(report)), failure, `stream ${JSON.stringify(report)}`);
    await assert.rejects(openAi(openAiJson(report)), failure, `JSON ${JSON.stringify(report)}`);
    await assert.rejects(openAi(openAiStream({ prompt_tokens: 5, completion_tokens: 5 }, report)), failure, `later chunk ${JSON.stringify(report)}`);
  }
});

// ---- Anthropic: every cell of the usage table that is not "reported" is a reply failure with billing unknown ----

const billingUnknown = (pattern: RegExp) => (error: unknown): boolean => {
  assert.ok(isRunwrightError(error), String(error));
  assert.equal(error.code, "model_failed", error.message);
  assert.equal(error.details?.["billing"], "unknown", error.message);
  assert.match(error.message, pattern);
  return true;
};

/** A streamed Anthropic reply "hi" with the given message_start usage and message_delta usage (left out when undefined). */
function anthropicStream(startUsage: unknown, deltaUsage: unknown): FakeReply {
  const message: Record<string, unknown> = {};
  if (startUsage !== undefined) message["usage"] = startUsage;
  const delta: Record<string, unknown> = { delta: { stop_reason: "end_turn" } };
  if (deltaUsage !== undefined) delta["usage"] = deltaUsage;
  return {
    chunks: [sse([
      { event: "message_start", data: { type: "message_start", message } },
      { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
      { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } } },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
      { event: "message_delta", data: { type: "message_delta", ...delta } },
      { event: "message_stop", data: { type: "message_stop" } },
    ])],
  };
}

/** A plain-JSON Anthropic message "hi" with `usage` (left out when undefined). */
function anthropicJson(usageValue: unknown): FakeReply {
  const body: Record<string, unknown> = { type: "message", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" };
  if (usageValue !== undefined) body["usage"] = usageValue;
  return { text: JSON.stringify(body) };
}

test("(R15-01) Anthropic stream, input not reported: message_start without input_tokens is a reply failure", async () => {
  for (const start of [undefined, { output_tokens: 1 }, { input_tokens: null, output_tokens: 1 }, { cache_read_input_tokens: 50, output_tokens: 1 }]) {
    await assert.rejects(anthropic(anthropicStream(start, { output_tokens: 9 })), billingUnknown(/no usage in message_start/), JSON.stringify(start));
  }
});

test("(R15-01) Anthropic stream, output not reported: no output_tokens in a message_delta is a reply failure", async () => {
  for (const delta of [undefined, {}, { output_tokens: null }, { input_tokens: 40 }]) {
    await assert.rejects(anthropic(anthropicStream({ input_tokens: 40, output_tokens: 1 }, delta)), billingUnknown(/no output_tokens in a message_delta/), JSON.stringify(delta));
  }
});

test("(R15-01) Anthropic JSON, input not reported: a message without input_tokens is a reply failure", async () => {
  for (const reported of [undefined, { output_tokens: 4 }, { input_tokens: null, output_tokens: 4 }, { cache_read_input_tokens: 9, output_tokens: 4 }]) {
    await assert.rejects(anthropic(anthropicJson(reported)), billingUnknown(/no usage/), JSON.stringify(reported));
  }
});

test("(R15-01) Anthropic JSON, output not reported: a message without output_tokens is a reply failure", async () => {
  for (const reported of [{ input_tokens: 3 }, { input_tokens: 3, output_tokens: null }]) {
    await assert.rejects(anthropic(anthropicJson(reported)), billingUnknown(/no usage/), JSON.stringify(reported));
  }
});

test("(R15-01) Anthropic: cache counts omitted beside a reported input count are reported 0, never named missing", async () => {
  const streamed = await anthropic(anthropicStream({ input_tokens: 40, output_tokens: 1 }, { output_tokens: 9 }));
  assert.deepEqual(streamed.usage, usage(40, 9));
  assert.equal(streamed.usageMissing, undefined);
  const plain = await anthropic(anthropicJson({ input_tokens: 3, output_tokens: 4, cache_creation_input_tokens: 2 }));
  assert.deepEqual(plain.usage, { inputTokens: 3, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 2 });
  assert.equal(plain.usageMissing, undefined);
});
