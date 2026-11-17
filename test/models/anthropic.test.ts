import { test } from "node:test";
import assert from "node:assert/strict";
import { isRunwrightError } from "../../src/core/errors.ts";
import { createAnthropicProvider } from "../../src/models/anthropic.ts";
import { decisionSchema } from "../../src/workflow/decision.ts";
import type { ModelRequest } from "../../src/models/types.ts";
import { fakeFetch, fragment, makeRequest, signal, sse, type FakeReply } from "./fake-fetch.ts";

const KEY = "sk-ant-test-0123456789abcdef";
const model = { provider: "anthropic" as const, name: "claude-opus-4-8" };

function streamOf(blocks: { event: string; data: unknown }[]): string {
  return sse(blocks.map((b) => ({ event: b.event, data: { type: b.event, ...(b.data as object) } })));
}

const textStream = streamOf([
  { event: "message_start", data: { message: { usage: { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 } } } },
  { event: "content_block_start", data: { index: 0, content_block: { type: "text", text: "" } } },
  { event: "ping", data: {} },
  { event: "content_block_delta", data: { index: 0, delta: { type: "text_delta", text: "Hello" } } },
  { event: "content_block_delta", data: { index: 0, delta: { type: "text_delta", text: ", world" } } },
  { event: "content_block_stop", data: { index: 0 } },
  { event: "message_delta", data: { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 42 } } },
  { event: "message_stop", data: {} },
]);

const toolStream = streamOf([
  { event: "message_start", data: { message: { usage: { input_tokens: 50, output_tokens: 1 } } } },
  { event: "content_block_start", data: { index: 0, content_block: { type: "thinking", thinking: "" } } },
  { event: "content_block_delta", data: { index: 0, delta: { type: "thinking_delta", thinking: "hmm" } } },
  { event: "content_block_stop", data: { index: 0 } },
  { event: "content_block_start", data: { index: 1, content_block: { type: "text", text: "Reading." } } },
  { event: "content_block_stop", data: { index: 1 } },
  { event: "content_block_start", data: { index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "read_file", input: {} } } },
  { event: "content_block_delta", data: { index: 2, delta: { type: "input_json_delta", partial_json: "{\"pa" } } },
  { event: "content_block_delta", data: { index: 2, delta: { type: "input_json_delta", partial_json: "th\": \"a.txt\"}" } } },
  { event: "content_block_stop", data: { index: 2 } },
  { event: "content_block_start", data: { index: 3, content_block: { type: "tool_use", id: "toolu_2", name: "list_files", input: {} } } },
  { event: "content_block_stop", data: { index: 3 } },
  { event: "message_delta", data: { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 17 } } },
  { event: "message_stop", data: {} },
]);

test("request body maps system, tools, assistant tool calls and merged tool results", async () => {
  const fake = fakeFetch([{ chunks: [textStream] }]);
  const provider = createAnthropicProvider({ apiKey: KEY, baseUrl: "https://example.test/", fetch: fake.fetch });
  const request: ModelRequest = makeRequest(model, {
    tools: [{ name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }],
    messages: [
      { role: "user", content: "read both" },
      { role: "assistant", content: "ok", toolCalls: [{ id: "c1", name: "read_file", args: { path: "a" } }, { id: "c2", name: "read_file", args: { path: "b" } }] },
      { role: "tool", toolCallId: "c1", name: "read_file", content: "A", isError: false },
      { role: "tool", toolCallId: "c2", name: "read_file", content: "missing", isError: true },
      { role: "user", content: "thanks" },
    ],
  });
  await provider.generate(request, { signal: signal() });
  const call = fake.calls[0];
  assert.ok(call !== undefined);
  assert.equal(call.url, "https://example.test/v1/messages");
  assert.equal(call.headers["x-api-key"], KEY);
  assert.equal(call.headers["anthropic-version"], "2023-06-01");
  assert.equal(call.headers["content-type"], "application/json");
  assert.deepEqual(call.body, {
    model: "claude-opus-4-8",
    max_tokens: 256,
    system: "You are terse.",
    messages: [
      { role: "user", content: "read both" },
      { role: "assistant", content: [
        { type: "text", text: "ok" },
        { type: "tool_use", id: "c1", name: "read_file", input: { path: "a" } },
        { type: "tool_use", id: "c2", name: "read_file", input: { path: "b" } },
      ] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "c1", content: "A", is_error: false },
        { type: "tool_result", tool_use_id: "c2", content: "missing", is_error: true },
      ] },
      { role: "user", content: "thanks" },
    ],
    tools: [{ name: "read_file", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
    stream: true,
  });
});

test("streamed text arrives as deltas, with usage including cache fields", async () => {
  const fake = fakeFetch([{ chunks: fragment(textStream, 7) }]);
  const provider = createAnthropicProvider({ apiKey: KEY, fetch: fake.fetch });
  const deltas: string[] = [];
  const reply = await provider.generate(makeRequest(model), { signal: signal(), onDelta: (d) => deltas.push(d) });
  assert.equal(fake.calls[0]?.url, "https://api.anthropic.com/v1/messages");
  assert.equal(reply.text, "Hello, world");
  assert.deepEqual(deltas, ["Hello", ", world"]);
  assert.equal(reply.stopReason, "end");
  assert.deepEqual(reply.usage, { inputTokens: 120, outputTokens: 42, cacheReadTokens: 30, cacheWriteTokens: 10 });
  assert.deepEqual(reply.toolCalls, []);
  assert.equal(reply.output, null);
});

test("tool calls are assembled from fragmented JSON deltas; thinking blocks are ignored", async () => {
  const fake = fakeFetch([{ chunks: fragment(toolStream, 5) }]);
  const reply = await createAnthropicProvider({ apiKey: KEY, fetch: fake.fetch }).generate(makeRequest(model), { signal: signal() });
  assert.equal(reply.text, "Reading.");
  assert.equal(reply.stopReason, "tool_use");
  assert.deepEqual(reply.toolCalls, [
    { id: "toolu_1", name: "read_file", args: { path: "a.txt" } },
    { id: "toolu_2", name: "list_files", args: {} },
  ]);
  assert.deepEqual(reply.usage, { inputTokens: 50, outputTokens: 17, cacheReadTokens: 0, cacheWriteTokens: 0 });
});

test("structured output is a forced tool whose input becomes the output", async () => {
  const stream = streamOf([
    { event: "message_start", data: { message: { usage: { input_tokens: 5, output_tokens: 1 } } } },
    { event: "content_block_start", data: { index: 0, content_block: { type: "tool_use", id: "t", name: "verdict", input: {} } } },
    { event: "content_block_delta", data: { index: 0, delta: { type: "input_json_delta", partial_json: "{\"value\":true,\"confidence\":0.9}" } } },
    { event: "message_delta", data: { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } } },
    { event: "message_stop", data: {} },
  ]);
  const fake = fakeFetch([{ chunks: [stream] }, { chunks: [stream] }]);
  const provider = createAnthropicProvider({ apiKey: KEY, fetch: fake.fetch });
  const schema = { type: "object", properties: { value: { type: "boolean" } } };
  const reply = await provider.generate(makeRequest(model, { output: { name: "verdict", description: "Decide", schema } }), { signal: signal() });
  assert.deepEqual(reply.output, { value: true, confidence: 0.9 });
  assert.deepEqual(reply.toolCalls, []);
  assert.equal(reply.stopReason, "end");
  const body = fake.calls[0]?.body;
  assert.deepEqual(body?.["tool_choice"], { type: "tool", name: "verdict" });
  assert.deepEqual(body?.["tools"], [{ name: "verdict", description: "Decide", input_schema: schema }]);

  await provider.generate(makeRequest({ provider: "anthropic", name: "claude-opus-5-5" }, { output: { name: "verdict", schema } }), { signal: signal() });
  const newer = fake.calls[1]?.body;
  assert.deepEqual(newer?.["tool_choice"], { type: "auto" }, "models that reject a forced tool_choice get auto");
  assert.match(String(newer?.["system"]), /calling the tool "verdict"/);
});

test("stop reasons map to the neutral set", async () => {
  for (const [raw, expected] of [["stop_sequence", "end"], ["max_tokens", "max_tokens"], ["refusal", "other"]] as const) {
    const stream = streamOf([
      { event: "message_start", data: { message: { usage: { input_tokens: 1, output_tokens: 0 } } } },
      { event: "message_delta", data: { delta: { stop_reason: raw }, usage: { output_tokens: 1 } } },
      { event: "message_stop", data: {} },
    ]);
    const reply = await createAnthropicProvider({ apiKey: KEY, fetch: fakeFetch([{ chunks: [stream] }]).fetch }).generate(makeRequest(model), { signal: signal() });
    assert.equal(reply.stopReason, expected, raw);
  }
});

const codeOf = (error: unknown): string => (isRunwrightError(error) ? error.code : "not-runwright");

test("errors map to transient or failed, honour Retry-After and never contain the key", async () => {
  const refused = new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" }) });
  const reset = new TypeError("fetch failed", { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
  const cases: { reply: FakeReply; code: string; status: number | null; retryAfterMs?: number | null; billing: string }[] = [
    { reply: { status: 429, headers: { "retry-after": "3" }, text: JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }) }, code: "model_transient", status: 429, retryAfterMs: 3000, billing: "none" },
    { reply: { status: 500, text: "upstream broke" }, code: "model_transient", status: 500, retryAfterMs: null, billing: "none" },
    { reply: { status: 529, text: "{}" }, code: "model_transient", status: 529, billing: "none" },
    { reply: { status: 400, text: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: `bad key ${KEY}` } }) }, code: "model_failed", status: 400, billing: "none" },
    { reply: { reject: new TypeError("fetch failed") }, code: "model_transient", status: null, billing: "unknown" },
    { reply: { reject: refused }, code: "model_transient", status: null, billing: "none" },
    { reply: { reject: reset }, code: "model_transient", status: null, billing: "unknown" },
    { reply: { text: "this is not json" }, code: "model_failed", status: null, billing: "unknown" },
  ];
  for (const item of cases) {
    const provider = createAnthropicProvider({ apiKey: KEY, fetch: fakeFetch([item.reply]).fetch });
    await assert.rejects(provider.generate(makeRequest(model), { signal: signal() }), (error: unknown) => {
      assert.ok(isRunwrightError(error));
      assert.equal(error.code, item.code);
      assert.equal(error.details?.["status"], item.status);
      if (item.retryAfterMs !== undefined) assert.equal(error.details?.["retryAfterMs"], item.retryAfterMs);
      assert.equal(error.details?.["billing"], item.billing, error.message);
      assert.ok(!error.message.includes(KEY), error.message);
      assert.ok(!JSON.stringify(error.details).includes(KEY));
      return true;
    });
  }
});

test("the 400 error carries the provider's message", async () => {
  const fake = fakeFetch([{ status: 400, text: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "max_tokens too large" } }) }]);
  await assert.rejects(createAnthropicProvider({ apiKey: KEY, fetch: fake.fetch }).generate(makeRequest(model), { signal: signal() }), /max_tokens too large/);
});

const billingOf = (error: unknown): unknown => (isRunwrightError(error) ? error.details?.["billing"] : undefined);

test("a truncated stream is transient; a stream error event is mapped by type; all of them may have been billed", async () => {
  const truncated = textStream.slice(0, textStream.indexOf("event: message_delta"));
  await assert.rejects(
    createAnthropicProvider({ apiKey: KEY, fetch: fakeFetch([{ chunks: [truncated] }]).fetch }).generate(makeRequest(model), { signal: signal() }),
    (error: unknown) => codeOf(error) === "model_transient" && billingOf(error) === "unknown",
  );
  const overloaded = sse([{ event: "error", data: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } }]);
  await assert.rejects(
    createAnthropicProvider({ apiKey: KEY, fetch: fakeFetch([{ chunks: [overloaded] }]).fetch }).generate(makeRequest(model), { signal: signal() }),
    (error: unknown) => codeOf(error) === "model_transient" && billingOf(error) === "unknown",
  );
  const invalid = sse([{ event: "error", data: { type: "error", error: { type: "invalid_request_error", message: "nope" } } }]);
  await assert.rejects(
    createAnthropicProvider({ apiKey: KEY, fetch: fakeFetch([{ chunks: [invalid] }]).fetch }).generate(makeRequest(model), { signal: signal() }),
    (error: unknown) => codeOf(error) === "model_failed" && billingOf(error) === "unknown",
  );
});

test("a request that cannot be built is model_failed and never sent", async () => {
  const fake = fakeFetch([{ chunks: [textStream] }]);
  await assert.rejects(
    createAnthropicProvider({ apiKey: KEY, baseUrl: "not a url", fetch: fake.fetch }).generate(makeRequest(model), { signal: signal() }),
    (error: unknown) => codeOf(error) === "model_failed" && billingOf(error) === "none",
  );
  assert.equal(fake.calls.length, 0);
});

test("invalid tool-call JSON is model_failed", async () => {
  const stream = streamOf([
    { event: "message_start", data: { message: { usage: { input_tokens: 1, output_tokens: 0 } } } },
    { event: "content_block_start", data: { index: 0, content_block: { type: "tool_use", id: "t", name: "x", input: {} } } },
    { event: "content_block_delta", data: { index: 0, delta: { type: "input_json_delta", partial_json: "[1,2" } } },
    { event: "message_delta", data: { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } } },
    { event: "message_stop", data: {} },
  ]);
  await assert.rejects(
    createAnthropicProvider({ apiKey: KEY, fetch: fakeFetch([{ chunks: [stream] }]).fetch }).generate(makeRequest(model), { signal: signal() }),
    (error: unknown) => codeOf(error) === "model_failed" && billingOf(error) === "unknown",
  );
});

test("aborting mid-stream rejects with aborted", async () => {
  const partial = textStream.slice(0, textStream.indexOf("event: message_delta"));
  const controller = new AbortController();
  const provider = createAnthropicProvider({ apiKey: KEY, fetch: fakeFetch([{ chunks: [partial], hang: true }]).fetch });
  const pending = provider.generate(makeRequest(model), { signal: controller.signal, onDelta: () => controller.abort() });
  await assert.rejects(pending, (error: unknown) => codeOf(error) === "aborted");
  const before = new AbortController();
  before.abort();
  await assert.rejects(provider.generate(makeRequest(model), { signal: before.signal }), (error: unknown) => codeOf(error) === "aborted");
});

test("a plain JSON message response is accepted", async () => {
  const message = {
    type: "message",
    content: [{ type: "text", text: "hi" }, { type: "tool_use", id: "tu", name: "list_files", input: { dir: "." } }],
    stop_reason: "tool_use",
    usage: { input_tokens: 3, output_tokens: 4 },
  };
  const reply = await createAnthropicProvider({ apiKey: KEY, fetch: fakeFetch([{ text: JSON.stringify(message) }]).fetch }).generate(makeRequest(model), { signal: signal() });
  assert.equal(reply.text, "hi");
  assert.deepEqual(reply.toolCalls, [{ id: "tu", name: "list_files", args: { dir: "." } }]);
  assert.deepEqual(reply.usage, { inputTokens: 3, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 });
});

// ---- Structured output of any JSON type (plan 3.1, 3.2) ----

const ARRAY_SCHEMA = { type: "array", items: { type: "integer" } };

/**
 * A reply with optional text and an optional tool_use block. Streamed, the block's input arrives as one
 * input_json_delta of `json` (the text the model streamed); as a plain JSON message, the block carries `input`.
 */
function toolUseReply(options: { json?: string; input?: unknown; name?: string; text?: string }, streamed: boolean): FakeReply {
  const name = options.name ?? "out";
  const hasCall = options.json !== undefined || options.input !== undefined;
  const stop = hasCall ? "tool_use" : "end_turn";
  if (streamed) {
    const events: { event: string; data: unknown }[] = [{ event: "message_start", data: { message: { usage: { input_tokens: 4, output_tokens: 1 } } } }];
    let index = 0;
    if (options.text !== undefined) {
      events.push(
        { event: "content_block_start", data: { index, content_block: { type: "text", text: "" } } },
        { event: "content_block_delta", data: { index, delta: { type: "text_delta", text: options.text } } },
        { event: "content_block_stop", data: { index } },
      );
      index++;
    }
    if (hasCall) {
      events.push({ event: "content_block_start", data: { index, content_block: { type: "tool_use", id: "tu", name, input: {} } } });
      const json = options.json ?? JSON.stringify(options.input);
      if (json !== "") events.push({ event: "content_block_delta", data: { index, delta: { type: "input_json_delta", partial_json: json } } });
      events.push({ event: "content_block_stop", data: { index } });
    }
    events.push({ event: "message_delta", data: { delta: { stop_reason: stop }, usage: { output_tokens: 3 } } }, { event: "message_stop", data: {} });
    return { chunks: [streamOf(events)] };
  }
  const content: unknown[] = [];
  if (options.text !== undefined) content.push({ type: "text", text: options.text });
  if (hasCall) {
    const input = options.input !== undefined ? options.input : options.json === "" ? {} : JSON.parse(options.json ?? "{}");
    content.push({ type: "tool_use", id: "tu", name, input });
  }
  return { text: JSON.stringify({ type: "message", content, stop_reason: stop, usage: { input_tokens: 4, output_tokens: 3 } }) };
}

async function structuredCall(schema: Record<string, unknown>, reply: FakeReply, options: { model?: string; description?: string } = {}) {
  const fake = fakeFetch([reply]);
  const output = { name: "out", schema: schema as never, ...(options.description === undefined ? {} : { description: options.description }) };
  const response = await createAnthropicProvider({ apiKey: KEY, fetch: fake.fetch })
    .generate(makeRequest({ provider: "anthropic", name: options.model ?? model.name }, { output }), { signal: signal() });
  return { response, body: fake.calls[0]?.body };
}

const PATHS = [["streaming", true], ["plain JSON", false]] as const;

test("R05-01 reviewer's probe: an array output schema answered with [1,2] comes back as [1,2]", async () => {
  for (const [label, streamed] of PATHS) {
    const { response } = await structuredCall(ARRAY_SCHEMA, toolUseReply({ input: [1, 2] }, streamed));
    assert.deepEqual(response.output, [1, 2], label);
    assert.deepEqual(response.toolCalls, [], label);
    assert.equal(response.stopReason, "end", label);
    assert.notEqual(response.outputMissing, true, label);
    assert.equal(Object.hasOwn(response, "outputMissing"), false, `${label}: outputMissing is only written when true`);
  }
});

test("the wrapped answer {\"value\":[1,2]} is unwrapped on both paths", async () => {
  for (const [label, streamed] of PATHS) {
    const { response } = await structuredCall(ARRAY_SCHEMA, toolUseReply({ input: { value: [1, 2] } }, streamed));
    assert.deepEqual(response.output, [1, 2], label);
    assert.equal(response.stopReason, "end", label);
  }
});

test("request body: a non-object schema is sent wrapped, with the value sentences and $defs on the wrapper", async () => {
  const { body } = await structuredCall(ARRAY_SCHEMA, toolUseReply({ input: [1] }, true));
  assert.deepEqual(body?.["tools"], [{
    name: "out",
    description: "Return the result as the input of this tool. Its input must match the schema. Put the result in the \"value\" argument.",
    input_schema: { type: "object", additionalProperties: false, required: ["value"], properties: { value: ARRAY_SCHEMA } },
  }]);
  assert.deepEqual(body?.["tool_choice"], { type: "tool", name: "out" });
  assert.equal(body?.["system"], "You are terse.", "a forced tool choice gets no instruction");

  const custom = await structuredCall(ARRAY_SCHEMA, toolUseReply({ input: [1] }, true), { description: "List them." });
  assert.equal((custom.body?.["tools"] as { description: string }[])[0]?.description, "List them. Put the result in the \"value\" argument.");

  const auto = await structuredCall(ARRAY_SCHEMA, toolUseReply({ input: [1] }, true), { model: "claude-opus-5-5" });
  assert.deepEqual(auto.body?.["tool_choice"], { type: "auto" });
  assert.equal(auto.body?.["system"], "You are terse.\n\nGive your answer by calling the tool \"out\" exactly once. Put the answer in its \"value\" argument.");
  const autoObject = await structuredCall({ type: "object" }, toolUseReply({ input: {} }, true), { model: "claude-opus-5-5" });
  assert.equal(autoObject.body?.["system"], "You are terse.\n\nGive your answer by calling the tool \"out\" exactly once.");

  const row = { type: "object", required: ["id"], properties: { id: { type: "integer" } } };
  const withDefs = { type: "array", items: { $ref: "#/$defs/Row" }, $defs: { Row: row } };
  const sent = await structuredCall(withDefs, toolUseReply({ input: { value: [{ id: 1 }] } }, true));
  assert.deepEqual((sent.body?.["tools"] as { input_schema: unknown }[])[0]?.input_schema, {
    type: "object", additionalProperties: false, required: ["value"],
    properties: { value: { type: "array", items: { $ref: "#/$defs/Row" } } }, $defs: { Row: row },
  });
  assert.deepEqual(sent.response.output, [{ id: 1 }]);
});

test("scalar and null outputs come back as the value on both paths", async () => {
  const cases: { schema: Record<string, unknown>; input: unknown; expected: unknown }[] = [
    { schema: { type: "string" }, input: { value: "hi" }, expected: "hi" },
    { schema: { type: "number" }, input: { value: 1.5 }, expected: 1.5 },
    { schema: { type: "integer" }, input: { value: 3 }, expected: 3 },
    { schema: { type: "boolean" }, input: { value: false }, expected: false },
    { schema: { type: "null" }, input: { value: null }, expected: null },
    { schema: { type: ["string", "null"] }, input: { value: null }, expected: null },
    { schema: { type: "string" }, input: "hi", expected: "hi" },
    { schema: { type: "integer" }, input: 3, expected: 3 },
  ];
  for (const [label, streamed] of PATHS) {
    for (const item of cases) {
      const { response } = await structuredCall(item.schema, toolUseReply({ input: item.input }, streamed));
      const name = `${label} ${JSON.stringify(item.schema)} ${JSON.stringify(item.input)}`;
      assert.deepEqual(response.output, item.expected, name);
      assert.notEqual(response.outputMissing, true, name);
    }
  }
});

test("the decision schema is an object schema: sent as it is and not unwrapped", async () => {
  const schema = decisionSchema({ type: "yes_no" });
  for (const [label, streamed] of PATHS) {
    const { response, body } = await structuredCall(schema, toolUseReply({ input: { value: true, confidence: 0.9 } }, streamed));
    const tools = body?.["tools"] as { input_schema: unknown; description: string }[];
    assert.deepEqual(tools[0]?.input_schema, schema, label);
    assert.equal(tools[0]?.description, "Return the result as the input of this tool. Its input must match the schema.", label);
    assert.deepEqual(response.output, { value: true, confidence: 0.9 }, label);
  }
});

test("no output: a wrapper without value or a non-JSON text is missing, never null; JSON text is the bare value", async () => {
  for (const [label, streamed] of PATHS) {
    const emptyWrapper = await structuredCall(ARRAY_SCHEMA, toolUseReply({ input: {} }, streamed));
    assert.equal(emptyWrapper.response.output, null, label);
    assert.equal(emptyWrapper.response.outputMissing, true, label);
    const refusal = await structuredCall(ARRAY_SCHEMA, toolUseReply({ text: "I cannot say" }, streamed));
    assert.equal(refusal.response.output, null, label);
    assert.equal(refusal.response.outputMissing, true, label);
    const textArray = await structuredCall(ARRAY_SCHEMA, toolUseReply({ text: "[1,2]" }, streamed));
    assert.deepEqual(textArray.response.output, [1, 2], label);
    assert.notEqual(textArray.response.outputMissing, true, label);
    const textWrapper = await structuredCall(ARRAY_SCHEMA, toolUseReply({ text: "{\"value\":[1,2]}" }, streamed));
    assert.deepEqual(textWrapper.response.output, { value: [1, 2] }, `${label}: a text answer is the bare value`);
  }
  const noDelta = await structuredCall(ARRAY_SCHEMA, toolUseReply({ json: "" }, true));
  assert.equal(noDelta.response.outputMissing, true, "a streamed block with no input deltas reads its input {}");
});

test("output-tool input that is not JSON, or not an object under an object schema, is model_failed", async () => {
  const failed = (pattern: RegExp) => (error: unknown) =>
    codeOf(error) === "model_failed" && isRunwrightError(error) && error.details?.["billing"] === "unknown" && pattern.test(error.message);
  await assert.rejects(structuredCall(ARRAY_SCHEMA, toolUseReply({ json: "[1," }, true)), failed(/tool "out" that are not valid JSON/));
  await assert.rejects(structuredCall({ type: "object" }, toolUseReply({ json: "{\"a\":" }, true)), failed(/tool "out" that are not a JSON object/));
  for (const [, streamed] of PATHS) {
    await assert.rejects(structuredCall({ type: "object" }, toolUseReply({ input: [1, 2] }, streamed)), failed(/tool "out" that are not a JSON object/));
  }
});

test("an ordinary tool call with non-object input fails the reply on both paths instead of running with {}", async () => {
  for (const [label, streamed] of PATHS) {
    for (const input of [[1], "x", 2, null]) {
      const fake = fakeFetch([toolUseReply({ input, name: "read_file" }, streamed)]);
      await assert.rejects(
        createAnthropicProvider({ apiKey: KEY, fetch: fake.fetch }).generate(makeRequest(model), { signal: signal() }),
        (error: unknown) => codeOf(error) === "model_failed" && isRunwrightError(error) && error.details?.["billing"] === "unknown",
        `${label} ${JSON.stringify(input)}`,
      );
    }
  }
  const plain = { text: JSON.stringify({ type: "message", content: [{ type: "tool_use", id: "a", name: "list_files" }], stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } }) };
  const absent = await createAnthropicProvider({ apiKey: KEY, fetch: fakeFetch([plain]).fetch }).generate(makeRequest(model), { signal: signal() });
  assert.deepEqual(absent.toolCalls, [{ id: "a", name: "list_files", args: {} }], "absent input means {}");
});

// ---- A success reply must be a reply (R09D-models-03) ----

/** Asserts a typed reply failure: `code`, billing "unknown", a message matching `pattern` and without the key. */
function rejectsAs(code: string, pattern: RegExp) {
  return (error: unknown): boolean => {
    assert.ok(isRunwrightError(error), String(error));
    assert.equal(error.code, code, error.message);
    assert.equal(error.details?.["billing"], "unknown", error.message);
    assert.match(error.message, pattern);
    assert.ok(!error.message.includes(KEY), error.message);
    assert.ok(!JSON.stringify(error.details ?? {}).includes(KEY));
    return true;
  };
}

const generateWith = (reply: FakeReply): Promise<unknown> =>
  createAnthropicProvider({ apiKey: KEY, fetch: fakeFetch([reply]).fetch }).generate(makeRequest(model), { signal: signal() });

const validMessage = { type: "message", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 4 } };

test("rule 1: a JSON reply that is not an object is a reply failure", async () => {
  for (const body of ["[]", "\"text\"", "3", "null"]) {
    await assert.rejects(generateWith({ text: body }), rejectsAs("model_failed", /anthropic returned a reply that is not a JSON object/), body);
  }
});

test("rule 2: an error envelope in a 200 reply keeps the stream-error mapping", async () => {
  const overloaded = { type: "error", error: { type: "overloaded_error", message: `Overloaded ${KEY}` } };
  await assert.rejects(generateWith({ text: JSON.stringify(overloaded) }), rejectsAs("model_transient", /overloaded_error.*Overloaded \[redacted\]/));
  const invalid = { error: { type: "invalid_request_error", message: `bad ${KEY}` } };
  await assert.rejects(generateWith({ text: JSON.stringify(invalid) }), rejectsAs("model_failed", /invalid_request_error/));
});

test("rule 3: a reply that is not a message (type, content, stop_reason) is a reply failure", async () => {
  const bodies: unknown[] = [
    { ...validMessage, type: `completion ${KEY}` },
    { ...validMessage, type: undefined },
    { ...validMessage, content: "hi" },
    { ...validMessage, stop_reason: null },
  ];
  for (const body of bodies) {
    await assert.rejects(generateWith({ text: JSON.stringify(body) }), rejectsAs("model_failed", /not a message/), JSON.stringify(body));
  }
});

test("rule 4: a message without numeric usage is a reply failure, never billed as $0", async () => {
  const bodies: unknown[] = [
    { ...validMessage, usage: undefined },
    { ...validMessage, usage: { input_tokens: 3 } },
    { ...validMessage, usage: { input_tokens: "3", output_tokens: 4 } },
  ];
  for (const body of bodies) {
    await assert.rejects(generateWith({ text: JSON.stringify(body) }), rejectsAs("model_failed", /no usage/), JSON.stringify(body));
  }
  const accepted = await generateWith({ text: JSON.stringify(validMessage) });
  assert.deepEqual((accepted as { text: string }).text, "hi");
});

test("rule 5: a stream event whose data is not a JSON object is a reply failure, not skipped", async () => {
  const start = { event: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 0 } } } };
  for (const bad of [`not json ${KEY}`, "[1,2]", "7"]) {
    const stream = sse([
      start,
      { event: `content_block_delta${KEY}`, data: bad },
      { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } },
      { event: "message_stop", data: { type: "message_stop" } },
    ]);
    await assert.rejects(generateWith({ chunks: [stream] }), rejectsAs("model_failed", /data is not a JSON object/), bad);
  }
  const pingOnly = sse([start, { event: "ping", data: "not json" },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } },
    { event: "message_stop", data: { type: "message_stop" } }]);
  await generateWith({ chunks: [pingOnly] });
});

test("rule 6: message_stop without a complete message is a reply failure", async () => {
  const startEvent = (usage: unknown) => ({ event: "message_start", data: { type: "message_start", message: { usage } } });
  const delta = { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } };
  const noStopDelta = { event: "message_delta", data: { type: "message_delta", delta: {}, usage: { output_tokens: 1 } } };
  const stop = { event: "message_stop", data: { type: "message_stop" } };
  const cases: [string, { event: string; data: unknown }[]][] = [
    ["no message_start", [delta, stop]],
    ["no usage in message_start", [startEvent(undefined), delta, stop]],
    ["no stop_reason", [startEvent({ input_tokens: 1, output_tokens: 0 }), noStopDelta, stop]],
    ["only message_stop", [stop]],
  ];
  for (const [label, events] of cases) {
    await assert.rejects(generateWith({ chunks: [sse(events)] }), rejectsAs("model_failed", /stream ended without a complete message/), label);
  }
});

test("rule 7: a truncated stream stays transient and an error event keeps its mapping", async () => {
  const truncated = textStream.slice(0, textStream.indexOf("event: message_stop"));
  await assert.rejects(generateWith({ chunks: [truncated] }), rejectsAs("model_transient", /stream ended before it finished/));
  const overloaded = sse([{ event: "error", data: { type: "error", error: { type: "overloaded_error", message: `busy ${KEY}` } } }]);
  await assert.rejects(generateWith({ chunks: [overloaded] }), rejectsAs("model_transient", /overloaded_error/));
});

test("end to end: a 200 reply of {} is rejected instead of returning an empty response", async () => {
  await assert.rejects(generateWith({ text: "{}" }), rejectsAs("model_failed", /not a message/));
});

test("a content block index outside 0..4095 is a reply failure instead of a huge sparse scan", async () => {
  for (const index of [1e9, -1, 1.5, "0"]) {
    const stream = sse([
      { event: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 0 } } } },
      { event: "content_block_start", data: { type: "content_block_start", index, content_block: { type: "text", text: "a" } } },
      { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } },
      { event: "message_stop", data: { type: "message_stop" } },
    ]);
    await assert.rejects(generateWith({ chunks: [stream] }), rejectsAs("model_failed", /index that is not an integer/), String(index));
  }
});

// ---- Every content block, delta and usage field that is read is checked (R10-05) ----

const startEvent = { event: "message_start", data: { message: { usage: { input_tokens: 4, output_tokens: 1 } } } };
const endEvents = [
  { event: "message_delta", data: { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } } },
  { event: "message_stop", data: {} },
];
/** A complete stream around `middle`: message_start first, a stop_reason and message_stop last. */
const fullStream = (...middle: { event: string; data: unknown }[]): FakeReply => ({ chunks: [streamOf([startEvent, ...middle, ...endEvents])] });
const textBlock = (index: number) => ({ event: "content_block_start", data: { index, content_block: { type: "text", text: "" } } });
const jsonMessage = (content: unknown[]): FakeReply => ({ text: JSON.stringify({ ...validMessage, content }) });

test("a content block that is not an object with a type is a reply failure (stream and JSON)", async () => {
  const pattern = /anthropic sent a content block that is not an object with a type/;
  for (const block of ["x", 5, null, [], {}, { type: 5 }]) {
    await assert.rejects(
      generateWith(fullStream({ event: "content_block_start", data: { index: 0, content_block: block } })),
      rejectsAs("model_failed", pattern),
      JSON.stringify(block),
    );
    await assert.rejects(generateWith(jsonMessage([{ type: "text", text: "hi" }, block])), rejectsAs("model_failed", pattern), `JSON ${JSON.stringify(block)}`);
  }
});

test("a tool_use block without a non-empty id and name is a reply failure (stream and JSON)", async () => {
  const pattern = /anthropic sent a tool_use block without an id and a name/;
  for (const block of [{ type: "tool_use", id: "tu", input: {} }, { type: "tool_use", name: "t", input: {} }, { type: "tool_use", id: "", name: "t" }, { type: "tool_use", id: "tu", name: 5 }]) {
    await assert.rejects(generateWith(fullStream({ event: "content_block_start", data: { index: 0, content_block: block } })), rejectsAs("model_failed", pattern), JSON.stringify(block));
    await assert.rejects(generateWith(jsonMessage([block])), rejectsAs("model_failed", pattern), `JSON ${JSON.stringify(block)}`);
  }
});

test("a delta for a block that was never started is a reply failure, not skipped", async () => {
  const pattern = /anthropic sent a delta for a content block that was never started/;
  const delta = { type: "text_delta", text: "lost" };
  await assert.rejects(generateWith(fullStream({ event: "content_block_delta", data: { index: 0, delta } })), rejectsAs("model_failed", pattern));
  await assert.rejects(generateWith(fullStream(textBlock(0), { event: "content_block_delta", data: { index: 1, delta } })), rejectsAs("model_failed", pattern));
  await assert.rejects(generateWith(fullStream(textBlock(0), { event: "content_block_delta", data: { delta } })), rejectsAs("model_failed", pattern), "no index");
});

test("a delta that is not an object with a type, or whose text is not a string, is a reply failure", async () => {
  const notDelta = /anthropic sent a delta that is not an object with a type/;
  for (const delta of ["x", 5, null, {}, { type: 1, text: "a" }]) {
    await assert.rejects(generateWith(fullStream(textBlock(0), { event: "content_block_delta", data: { index: 0, delta } })), rejectsAs("model_failed", notDelta), JSON.stringify(delta));
  }
  await assert.rejects(
    generateWith(fullStream(textBlock(0), { event: "content_block_delta", data: { index: 0, delta: { type: "text_delta", text: 5 } } })),
    rejectsAs("model_failed", /anthropic sent a text_delta whose text is not a string/),
  );
  await assert.rejects(
    generateWith(fullStream(textBlock(0), { event: "content_block_delta", data: { index: 0, delta: { type: "text_delta" } } })),
    rejectsAs("model_failed", /anthropic sent a text_delta whose text is not a string/),
  );
  const toolBlock = { event: "content_block_start", data: { index: 0, content_block: { type: "tool_use", id: "tu", name: "t", input: {} } } };
  await assert.rejects(
    generateWith(fullStream(toolBlock, { event: "content_block_delta", data: { index: 0, delta: { type: "input_json_delta", partial_json: { a: 1 } } } })),
    rejectsAs("model_failed", /anthropic sent an input_json_delta whose partial_json is not a string/),
  );
  await assert.rejects(
    generateWith(fullStream({ event: "content_block_start", data: { index: 0, content_block: { type: "text", text: 5 } } })),
    rejectsAs("model_failed", /anthropic sent a text block whose text is not a string/),
  );
  await assert.rejects(generateWith(jsonMessage([{ type: "text", text: 5 }])), rejectsAs("model_failed", /anthropic sent a text block whose text is not a string/));
});

test("a message_delta without a delta object, or with a stop_reason that is not a string, is a reply failure", async () => {
  for (const delta of [undefined, "end_turn", null]) {
    const stream = streamOf([startEvent, { event: "message_delta", data: { delta, usage: { output_tokens: 3 } } }, { event: "message_stop", data: {} }]);
    await assert.rejects(generateWith({ chunks: [stream] }), rejectsAs("model_failed", /anthropic sent a message_delta without a delta object/), JSON.stringify(delta));
  }
  const badStop = streamOf([startEvent, { event: "message_delta", data: { delta: { stop_reason: 5 } } }, ...endEvents]);
  await assert.rejects(generateWith({ chunks: [badStop] }), rejectsAs("model_failed", /anthropic sent a stop_reason that is not a string/));
});

test("usage token fields that are present but not non-negative numbers are a reply failure, never a smaller charge", async () => {
  const pattern = /anthropic sent a usage field \w+ that is not a non-negative number/;
  for (const usage of [{ output_tokens: "500" }, { output_tokens: -1 }, { output_tokens: 3, cache_read_input_tokens: "9" }, { output_tokens: 3, input_tokens: -4 }]) {
    const stream = streamOf([startEvent, { event: "message_delta", data: { delta: { stop_reason: "end_turn" }, usage } }, { event: "message_stop", data: {} }]);
    await assert.rejects(generateWith({ chunks: [stream] }), rejectsAs("model_failed", pattern), JSON.stringify(usage));
  }
  const startBad = streamOf([{ event: "message_start", data: { message: { usage: { input_tokens: 4, output_tokens: 1, cache_creation_input_tokens: "7" } } } }, ...endEvents]);
  await assert.rejects(generateWith({ chunks: [startBad] }), rejectsAs("model_failed", pattern));
  await assert.rejects(
    generateWith({ text: JSON.stringify({ ...validMessage, usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: -2 } }) }),
    rejectsAs("model_failed", pattern),
  );
  await assert.rejects(generateWith({ text: JSON.stringify({ ...validMessage, usage: { input_tokens: -3, output_tokens: 4 } }) }), rejectsAs("model_failed", /no usage/));
  const nulls = streamOf([startEvent, { event: "message_delta", data: { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9, input_tokens: null, cache_read_input_tokens: null } } }, { event: "message_stop", data: {} }]);
  const reply = await generateWith({ chunks: [nulls] }) as { usage: unknown };
  assert.deepEqual(reply.usage, { inputTokens: 4, outputTokens: 9, cacheReadTokens: 0, cacheWriteTokens: 0 }, "a null usage field is absent");
});

test("still valid: unknown block types, unknown delta types and unknown events are read past; a thinking block before the text", async () => {
  const stream = fullStream(
    { event: "content_block_start", data: { index: 0, content_block: { type: "thinking", thinking: "" } } },
    { event: "content_block_delta", data: { index: 0, delta: { type: "thinking_delta", thinking: "hmm" } } },
    { event: "content_block_delta", data: { index: 0, delta: { type: "signature_delta", signature: "sig" } } },
    { event: "content_block_stop", data: { index: 0 } },
    { event: "content_block_start", data: { index: 1, content_block: { type: "server_widget", payload: 5 } } },
    { event: "content_block_delta", data: { index: 1, delta: { type: "widget_delta", value: [1] } } },
    { event: "some_future_event", data: { anything: true } },
    textBlock(2),
    { event: "content_block_delta", data: { index: 2, delta: { type: "text_delta", text: "answer" } } },
    { event: "content_block_delta", data: { index: 2, delta: { type: "citations_delta", citation: {} } } },
    { event: "content_block_stop", data: { index: 2 } },
  );
  const reply = await generateWith(stream) as { text: string; stopReason: string; toolCalls: unknown[] };
  assert.equal(reply.text, "answer");
  assert.equal(reply.stopReason, "end");
  assert.deepEqual(reply.toolCalls, []);
  const json = await generateWith(jsonMessage([{ type: "thinking", thinking: "hmm", signature: "s" }, { type: "redacted_thinking", data: "x" }, { type: "text", text: "answer" }])) as { text: string };
  assert.equal(json.text, "answer");
});

// ---- Error envelopes carry the same numeric rule as the OpenAI-compatible provider (R13D-models-01) ----

function envelopeAssert(code: string, status: number | null) {
  return (error: unknown): boolean => {
    assert.ok(isRunwrightError(error), String(error));
    assert.equal(error.code, code, error.message);
    assert.equal(error.details?.["status"], status, error.message);
    assert.equal(error.details?.["billing"], "unknown", error.message);
    assert.match(error.message, /^anthropic stream error \(/);
    return true;
  };
}

const anthropicEnvelopes: { body: Record<string, unknown>; code: string; status: number | null }[] = [
  { body: { type: "error", error: { type: "error", code: 503, message: "temporarily unavailable" } }, code: "model_transient", status: 503 },
  { body: { type: "error", error: { type: "rate_limit_exceeded", message: "slow" } }, code: "model_transient", status: null },
  { body: { type: "error", error: { type: "error", code: "invalid_api_key", message: "bad" } }, code: "model_failed", status: null },
  { body: { type: "error", error: { type: "error", code: 400, message: "bad request" } }, code: "model_failed", status: 400 },
  { body: { type: "error", error: { type: "overloaded_error", message: "busy" } }, code: "model_transient", status: 529 },
];

test("envelopes: a streamed error envelope with a status code classifies by that status", async () => {
  for (const item of anthropicEnvelopes) {
    const stream = streamOf([
      { event: "message_start", data: { message: { usage: { input_tokens: 5, output_tokens: 1 } } } },
      { event: "content_block_start", data: { index: 0, content_block: { type: "text", text: "" } } },
      { event: "content_block_delta", data: { index: 0, delta: { type: "text_delta", text: "Hi" } } },
    ]) + sse([{ event: "error", data: item.body }]);
    await assert.rejects(generateWith({ chunks: [stream] }), envelopeAssert(item.code, item.status), JSON.stringify(item.body));
  }
});

test("envelopes: the same envelopes as a plain JSON body classify the same way", async () => {
  for (const item of anthropicEnvelopes) {
    await assert.rejects(generateWith({ text: JSON.stringify(item.body) }), envelopeAssert(item.code, item.status), JSON.stringify(item.body));
  }
});

// ---- A reply is accepted only with a usage report that covers what was generated (R14D-models-01) ----

/** A streamed reply whose message_start reports `output_tokens: 0`, with text, ending in a message_delta of `deltaData`. */
const finalUsageStream = (deltaData: Record<string, unknown>): FakeReply => ({
  chunks: [streamOf([
    { event: "message_start", data: { message: { usage: { input_tokens: 12, output_tokens: 0 } } } },
    textBlock(0),
    { event: "content_block_delta", data: { index: 0, delta: { type: "text_delta", text: "a long answer the model generated" } } },
    { event: "content_block_stop", data: { index: 0 } },
    { event: "message_delta", data: { delta: { stop_reason: "end_turn" }, ...deltaData } },
    { event: "message_stop", data: {} },
  ])],
});

test("(R14D-models-01) a stream whose message_delta carries no output_tokens is a reply failure with unknown billing", async () => {
  const missing = /anthropic: the stream ended without a complete message \(no output_tokens in a message_delta\)/;
  for (const deltaData of [{}, { usage: {} }, { usage: { output_tokens: null } }, { usage: null }, { usage: { input_tokens: 12 } }]) {
    await assert.rejects(generateWith(finalUsageStream(deltaData)), rejectsAs("model_failed", missing), JSON.stringify(deltaData));
  }
  const reply = await generateWith(finalUsageStream({ usage: { output_tokens: 7 } })) as { usage: unknown; text: string };
  assert.equal(reply.text, "a long answer the model generated");
  assert.deepEqual(reply.usage, { inputTokens: 12, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 });
});

test("(R14D-models-01) the final output count is read from the message_delta, not from message_start", async () => {
  const reply = await generateWith(finalUsageStream({ usage: { output_tokens: 0 } })) as { usage: { outputTokens: number } };
  assert.equal(reply.usage.outputTokens, 0, "an explicit zero in the message_delta is a report, not a missing one");
});

test("(R14D-models-01) token counts that are fractional, NaN-like or strings are reply failures on both paths; huge ones are kept", async () => {
  const pattern = /anthropic sent a usage field \w+ that is not a non-negative number/;
  for (const usage of [{ output_tokens: 2.5 }, { output_tokens: "7" }, { output_tokens: -1 }, { output_tokens: 7, input_tokens: 0.1 }, { output_tokens: {} }]) {
    await assert.rejects(generateWith(finalUsageStream({ usage })), rejectsAs("model_failed", pattern), JSON.stringify(usage));
    await assert.rejects(
      generateWith({ text: JSON.stringify({ ...validMessage, usage: { input_tokens: 3, ...usage } }) }),
      rejectsAs("model_failed", /anthropic (sent a usage field \w+ that is not a non-negative number|returned a message with no usage)/),
      `JSON ${JSON.stringify(usage)}`,
    );
  }
  const huge = await generateWith(finalUsageStream({ usage: { output_tokens: 1e300 } })) as { usage: { outputTokens: number } };
  assert.equal(huge.usage.outputTokens, 1e300, "an absurd count is passed on as it is; the engine saturates it, over any cap");
});

test("(R14D-models-01) a plain JSON message needs usage with both counts", async () => {
  for (const usage of [undefined, null, {}, { input_tokens: 3 }, { output_tokens: 4 }, { input_tokens: 3, output_tokens: null }]) {
    const body = usage === undefined ? { ...validMessage, usage: undefined } : { ...validMessage, usage };
    await assert.rejects(generateWith({ text: JSON.stringify(body) }), rejectsAs("model_failed", /anthropic returned a message with no usage/), JSON.stringify(usage));
  }
  const reply = await generateWith({ text: JSON.stringify(validMessage) }) as { usage: unknown };
  assert.deepEqual(reply.usage, { inputTokens: 3, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 });
});
