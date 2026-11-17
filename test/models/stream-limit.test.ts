// One size limit per provider reply, however it arrives (R15D-models-02): the bytes read from one response body
// never pass the limit; passing it cancels the body and is a reply failure with unknown billing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isRunwrightError } from "../../src/core/errors.ts";
import { createAnthropicProvider } from "../../src/models/anthropic.ts";
import { createOpenAiProvider } from "../../src/models/openai.ts";
import { MAX_REPLY_BYTES, readSse } from "../../src/models/sse-parse.ts";
import type { ModelRequest, ModelResponse } from "../../src/models/types.ts";
import { makeRequest, signal, sse } from "./fake-fetch.ts";

const LIMIT = 64 * 1024;
const openAiModel = { provider: "openai-compatible" as const, name: "gpt-limit", baseUrl: "http://localhost:1/v1" };
const anthropicModel = { provider: "anthropic" as const, name: "claude-limit" };
const encoder = new TextEncoder();

interface BodyState { cancelled: boolean; bytes: number; pulls: number }

/**
 * A response body produced lazily, one piece per pull: `head`, then `next(i)` for i = 0, 1, … until it returns
 * null (never, for an endless body). `state` records the bytes handed out and whether the body was cancelled.
 */
function lazyBody(head: Uint8Array[], next: (index: number) => Uint8Array | null): { body: ReadableStream<Uint8Array>; state: BodyState } {
  const state: BodyState = { cancelled: false, bytes: 0, pulls: 0 };
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulls += 1;
      const piece = index < head.length ? head[index] : next(index - head.length);
      index += 1;
      if (piece === null || piece === undefined) {
        controller.close();
        return;
      }
      state.bytes += piece.byteLength;
      controller.enqueue(piece);
    },
    cancel() {
      state.cancelled = true;
    },
  }, { highWaterMark: 0 });
  return { body, state };
}

const fetchOf = (body: ReadableStream<Uint8Array>, type = "text/event-stream"): typeof fetch =>
  (async () => new Response(body, { status: 200, headers: { "content-type": type } })) as unknown as typeof fetch;

function openAi(body: ReadableStream<Uint8Array>, maxReplyBytes: number | undefined, request?: ModelRequest, type?: string): Promise<ModelResponse> {
  const deps = { apiKey: null, baseUrl: openAiModel.baseUrl, fetch: fetchOf(body, type), ...(maxReplyBytes === undefined ? {} : { maxReplyBytes }) };
  return createOpenAiProvider(deps).generate(request ?? makeRequest(openAiModel), { signal: signal() });
}

function anthropic(body: ReadableStream<Uint8Array>, maxReplyBytes: number | undefined, type?: string): Promise<ModelResponse> {
  const deps = { apiKey: "sk-ant-limit-test-0123456789", fetch: fetchOf(body, type), ...(maxReplyBytes === undefined ? {} : { maxReplyBytes }) };
  return createAnthropicProvider(deps).generate(makeRequest(anthropicModel), { signal: signal() });
}

const tooLarge = (provider: string, limit: number) => (error: unknown): boolean => {
  assert.ok(isRunwrightError(error), String(error));
  assert.equal(error.code, "model_failed", error.message);
  assert.equal(error.details?.["billing"], "unknown", error.message);
  assert.equal(error.message, `${provider} sent a reply larger than ${limit} bytes`);
  return true;
};

const event = (data: unknown, name?: string): Uint8Array => encoder.encode(sse([name === undefined ? { data } : { event: name, data }]));
const repeat = (piece: Uint8Array) => (): Uint8Array => piece;

/** The body was cancelled after at most the limit plus one piece was handed out. */
function assertStopped(state: BodyState, piece: number): void {
  assert.equal(state.cancelled, true, "the body was cancelled");
  assert.ok(state.bytes <= LIMIT + piece, `read ${state.bytes} bytes`);
}

const openAiDelta = (delta: object): Uint8Array => event({ choices: [{ index: 0, delta, finish_reason: null }] });
const anthropicStart = [
  event({ type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } }, "message_start"),
  event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, "content_block_start"),
  event({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "read_file", input: {} } }, "content_block_start"),
];

test("(R15D-models-02) OpenAI-compatible: many small content deltas whose sum passes the limit fail and cancel the body", { timeout: 10_000 }, async () => {
  const piece = openAiDelta({ content: "abcdefgh" });
  const { body, state } = lazyBody([], repeat(piece));
  await assert.rejects(openAi(body, LIMIT), tooLarge("openai-compatible", LIMIT));
  assertStopped(state, piece.byteLength);
});

test("(R15D-models-02) OpenAI-compatible: many small tool-argument deltas fail at the limit and cancel the body", { timeout: 10_000 }, async () => {
  const first = openAiDelta({ tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: "{\"path\":\"" } }] });
  const piece = openAiDelta({ tool_calls: [{ index: 0, function: { arguments: "aaaaaaaa" } }] });
  const { body, state } = lazyBody([first], repeat(piece));
  await assert.rejects(openAi(body, LIMIT), tooLarge("openai-compatible", LIMIT));
  assertStopped(state, piece.byteLength);
});

test("(R15D-models-02) Anthropic: many small text_delta events fail at the limit and cancel the body", { timeout: 10_000 }, async () => {
  const piece = event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "abcdefgh" } }, "content_block_delta");
  const { body, state } = lazyBody(anthropicStart, repeat(piece));
  await assert.rejects(anthropic(body, LIMIT), tooLarge("anthropic", LIMIT));
  assertStopped(state, piece.byteLength);
});

test("(R15D-models-02) Anthropic: many small input_json_delta events fail at the limit and cancel the body", { timeout: 10_000 }, async () => {
  const piece = event({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "aaaaaaaa" } }, "content_block_delta");
  const { body, state } = lazyBody(anthropicStart, repeat(piece));
  await assert.rejects(anthropic(body, LIMIT), tooLarge("anthropic", LIMIT));
  assertStopped(state, piece.byteLength);
});

test("(R15D-models-02) an endless stream of events the adapter ignores fails at the limit instead of running forever", { timeout: 10_000 }, async () => {
  const ignoredOpenAi = [encoder.encode(": keep-alive\n\n"), openAiDelta({}), event({ choices: [] }), encoder.encode("\n\n")];
  const open = lazyBody([], (i) => ignoredOpenAi[i % ignoredOpenAi.length] as Uint8Array);
  await assert.rejects(openAi(open.body, LIMIT), tooLarge("openai-compatible", LIMIT));
  assertStopped(open.state, 64);

  const ignoredAnthropic = [
    event({ type: "ping" }, "ping"),
    encoder.encode(": comment\n\n"),
    event({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } }, "content_block_delta"),
    event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } }, "content_block_delta"),
  ];
  const anth = lazyBody(anthropicStart, (i) => ignoredAnthropic[i % ignoredAnthropic.length] as Uint8Array);
  await assert.rejects(anthropic(anth.body, LIMIT), tooLarge("anthropic", LIMIT));
  assertStopped(anth.state, 128);
});

test("(R15D-models-02) readSse counts the raw bytes of the whole response, and a body of exactly the limit is read whole", { timeout: 10_000 }, async () => {
  const text = sse([{ data: "one" }, { data: "two" }]);
  const bytes = encoder.encode(text);
  const read = async (limit: number): Promise<string[]> => {
    const { body } = lazyBody([...bytes].map((byte) => new Uint8Array([byte])), () => null);
    const out: string[] = [];
    for await (const item of readSse(body, signal(), { provider: "p", maxBytes: limit })) out.push(item.data);
    return out;
  };
  assert.deepEqual(await read(bytes.byteLength), ["one", "two"]);
  await assert.rejects(read(bytes.byteLength - 1), tooLarge("p", bytes.byteLength - 1));
});

test("(R15D-models-02) a reply of exactly the limit passes, streamed or JSON, for both adapters; one byte more fails", { timeout: 10_000 }, async () => {
  const openStream = encoder.encode(sse([
    { data: { choices: [{ index: 0, delta: { content: "hello" }, finish_reason: "stop" }] } },
    { data: { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } } },
    { data: "[DONE]" },
  ]));
  const openJson = encoder.encode(JSON.stringify({ choices: [{ index: 0, message: { content: "hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
  const anthStream = encoder.encode(sse([
    { event: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 3, output_tokens: 1 } } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "hello" } } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ]));
  const anthJson = encoder.encode(JSON.stringify({ type: "message", content: [{ type: "text", text: "hello" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 } }));
  const cases: { name: string; bytes: Uint8Array; run: (body: ReadableStream<Uint8Array>, limit: number) => Promise<ModelResponse>; provider: string }[] = [
    { name: "OpenAI-compatible stream", bytes: openStream, run: (b, l) => openAi(b, l), provider: "openai-compatible" },
    { name: "OpenAI-compatible JSON", bytes: openJson, run: (b, l) => openAi(b, l, undefined, "application/json"), provider: "openai-compatible" },
    { name: "Anthropic stream", bytes: anthStream, run: (b, l) => anthropic(b, l), provider: "anthropic" },
    { name: "Anthropic JSON", bytes: anthJson, run: (b, l) => anthropic(b, l, "application/json"), provider: "anthropic" },
  ];
  for (const item of cases) {
    const pieces = (): Uint8Array[] => [item.bytes.subarray(0, 10), item.bytes.subarray(10)];
    const exact = await item.run(lazyBody(pieces(), () => null).body, item.bytes.byteLength);
    assert.equal(exact.text, "hello", item.name);
    const over = lazyBody(pieces(), () => null);
    await assert.rejects(item.run(over.body, item.bytes.byteLength - 1), tooLarge(item.provider, item.bytes.byteLength - 1), item.name);
    assert.equal(over.state.cancelled, true, `${item.name}: the body was cancelled`);
  }
});

test("(R15D-models-02) with the real limit, a stream of content just over MAX_REPLY_BYTES fails and is cancelled", { timeout: 60_000 }, async () => {
  const piece = openAiDelta({ content: "x".repeat(1024 * 1024 - 100) });
  const { body, state } = lazyBody([], () => (state.bytes > MAX_REPLY_BYTES ? null : piece));
  await assert.rejects(openAi(body, undefined), tooLarge("openai-compatible", MAX_REPLY_BYTES));
  assert.equal(state.cancelled, true);
  assert.ok(state.bytes > MAX_REPLY_BYTES && state.bytes <= MAX_REPLY_BYTES + piece.byteLength, `read ${state.bytes} bytes`);
});
