import { test } from "node:test";
import assert from "node:assert/strict";
import { isRunwrightError } from "../../src/core/errors.ts";
import { createOpenAiProvider } from "../../src/models/openai.ts";
import { decisionSchema } from "../../src/workflow/decision.ts";
import { fakeFetch, fragment, makeRequest, signal, sse, type FakeReply } from "./fake-fetch.ts";

const KEY = "sk-openai-test-abcdef0123456789";
const model = { provider: "openai-compatible" as const, name: "gpt-4.1-mini", baseUrl: "http://localhost:1/v1" };
const codeOf = (error: unknown): string => (isRunwrightError(error) ? error.code : "not-runwright");

function chunk(delta: object, finish: string | null = null): { data: unknown } {
  return { data: { choices: [{ index: 0, delta, finish_reason: finish }] } };
}

const textStream = sse([
  chunk({ role: "assistant", content: "" }),
  chunk({ content: "Hel" }),
  chunk({ content: "lo" }),
  chunk({}, "stop"),
  { data: { choices: [], usage: { prompt_tokens: 100, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 40 } } } },
  { data: "[DONE]" },
]);

const toolStream = sse([
  chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "read_file", arguments: "" } }] }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: "{\"path\":" } }] }),
  chunk({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "list_files", arguments: "{}" } }] }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: "\"a.txt\"}" } }] }),
  chunk({}, "tool_calls"),
  { data: { choices: [], usage: { prompt_tokens: 20, completion_tokens: 8 } } },
  { data: "[DONE]" },
]);

test("request body: system first, tool calls as JSON strings, tool results as role tool", async () => {
  const fake = fakeFetch([{ chunks: [textStream] }]);
  await createOpenAiProvider({ apiKey: KEY, baseUrl: "https://api.example.test/v1/", fetch: fake.fetch }).generate(
    makeRequest(model, {
      tools: [{ name: "read_file", description: "Read", parameters: { type: "object" } }],
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", args: { path: "a" } }] },
        { role: "tool", toolCallId: "c1", name: "read_file", content: "A", isError: false },
        { role: "tool", toolCallId: "c2", name: "read_file", content: "gone", isError: true },
        { role: "assistant", content: "done", toolCalls: [] },
      ],
    }),
    { signal: signal() },
  );
  const call = fake.calls[0];
  assert.ok(call !== undefined);
  assert.equal(call.url, "https://api.example.test/v1/chat/completions");
  assert.equal(call.headers["authorization"], `Bearer ${KEY}`);
  assert.deepEqual(call.body, {
    model: "gpt-4.1-mini",
    messages: [
      { role: "system", content: "You are terse." },
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a\"}" } }] },
      { role: "tool", tool_call_id: "c1", content: "A" },
      { role: "tool", tool_call_id: "c2", content: "[error] gone" },
      { role: "assistant", content: "done" },
    ],
    tools: [{ type: "function", function: { name: "read_file", description: "Read", parameters: { type: "object" } } }],
    max_tokens: 256,
    stream: true,
    stream_options: { include_usage: true },
  });
});

test("no authorization header without a key", async () => {
  const fake = fakeFetch([{ chunks: [textStream] }]);
  await createOpenAiProvider({ apiKey: null, baseUrl: "http://localhost:1/v1", fetch: fake.fetch }).generate(makeRequest(model), { signal: signal() });
  assert.equal(fake.calls[0]?.headers["authorization"], undefined);
});

test("streamed text, usage with cached tokens split out, and stop reason", async () => {
  const deltas: string[] = [];
  const reply = await createOpenAiProvider({ apiKey: KEY, baseUrl: model.baseUrl, fetch: fakeFetch([{ chunks: fragment(textStream, 9) }]).fetch })
    .generate(makeRequest(model), { signal: signal(), onDelta: (d) => deltas.push(d) });
  assert.equal(reply.text, "Hello");
  assert.deepEqual(deltas, ["Hel", "lo"]);
  assert.equal(reply.stopReason, "end");
  assert.deepEqual(reply.usage, { inputTokens: 60, outputTokens: 12, cacheReadTokens: 40, cacheWriteTokens: 0 });
});

test("tool calls are merged by index from fragmented argument deltas", async () => {
  const reply = await createOpenAiProvider({ apiKey: KEY, baseUrl: model.baseUrl, fetch: fakeFetch([{ chunks: fragment(toolStream, 4) }]).fetch })
    .generate(makeRequest(model), { signal: signal() });
  assert.equal(reply.stopReason, "tool_use");
  assert.deepEqual(reply.toolCalls, [
    { id: "call_a", name: "read_file", args: { path: "a.txt" } },
    { id: "call_b", name: "list_files", args: {} },
  ]);
  assert.deepEqual(reply.usage, { inputTokens: 20, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0 });
});

test("structured output is a forced function whose arguments become the output", async () => {
  const stream = sse([
    chunk({ tool_calls: [{ index: 0, id: "x", type: "function", function: { name: "verdict", arguments: "{\"value\":\"b\"}" } }] }),
    chunk({}, "stop"),
    { data: { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } } },
    { data: "[DONE]" },
  ]);
  const fake = fakeFetch([{ chunks: [stream] }]);
  const schema = { type: "object" };
  const reply = await createOpenAiProvider({ apiKey: KEY, baseUrl: model.baseUrl, fetch: fake.fetch })
    .generate(makeRequest(model, { output: { name: "verdict", schema } }), { signal: signal() });
  assert.deepEqual(reply.output, { value: "b" });
  assert.deepEqual(reply.toolCalls, []);
  assert.equal(reply.stopReason, "end");
  assert.deepEqual(fake.calls[0]?.body["tool_choice"], { type: "function", function: { name: "verdict" } });
  assert.deepEqual(fake.calls[0]?.body["tools"], [{ type: "function", function: { name: "verdict", description: "Return the result as the arguments of this function.", parameters: schema } }]);
});

test("finish reasons map to the neutral set", async () => {
  for (const [raw, expected] of [["length", "max_tokens"], ["content_filter", "other"], ["stop", "end"]] as const) {
    const stream = sse([chunk({ content: "x" }, raw), { data: "[DONE]" }]);
    const reply = await createOpenAiProvider({ apiKey: KEY, baseUrl: model.baseUrl, fetch: fakeFetch([{ chunks: [stream] }]).fetch })
      .generate(makeRequest(model), { signal: signal() });
    assert.equal(reply.stopReason, expected, raw);
  }
});

test("a plain JSON completion is handled", async () => {
  const completion = {
    choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "read_file", arguments: "{\"path\":\"x\"}" } }] } }],
    usage: { prompt_tokens: 9, completion_tokens: 4 },
  };
  const reply = await createOpenAiProvider({ apiKey: null, baseUrl: model.baseUrl, fetch: fakeFetch([{ text: JSON.stringify(completion) }]).fetch })
    .generate(makeRequest(model), { signal: signal() });
  assert.equal(reply.text, "");
  assert.deepEqual(reply.toolCalls, [{ id: "c", name: "read_file", args: { path: "x" } }]);
  assert.equal(reply.stopReason, "tool_use");
  assert.deepEqual(reply.usage, { inputTokens: 9, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 });
});

test("a server that reports no usage names both counts missing instead of inventing them", async () => {
  const stream = sse([chunk({ content: "some reply text" }, "stop"), { data: "[DONE]" }]);
  const reply = await createOpenAiProvider({ apiKey: null, baseUrl: model.baseUrl, fetch: fakeFetch([{ chunks: [stream] }]).fetch })
    .generate(makeRequest(model), { signal: signal() });
  assert.deepEqual(reply.usage, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  assert.deepEqual(reply.usageMissing, ["input", "output"]);
});

test("tool-call arguments that are not a JSON object are model_failed", async () => {
  for (const args of ["[1]", "{\"a\":"]) {
    const stream = sse([chunk({ tool_calls: [{ index: 0, id: "c", function: { name: "t", arguments: args } }] }, "tool_calls"), { data: "[DONE]" }]);
    await assert.rejects(
      createOpenAiProvider({ apiKey: KEY, baseUrl: model.baseUrl, fetch: fakeFetch([{ chunks: [stream] }]).fetch }).generate(makeRequest(model), { signal: signal() }),
      (error: unknown) => codeOf(error) === "model_failed" && isRunwrightError(error) && error.details?.["billing"] === "unknown",
    );
  }
});

test("errors: 429 with Retry-After, 500, 400, network, truncated stream; the key never leaks", async () => {
  const withCode = (code: string): Error => new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
  const cases: { reply: FakeReply; code: string; status: number | null; retryAfterMs?: number | null; billing: string }[] = [
    { reply: { status: 429, headers: { "retry-after": "2" }, text: JSON.stringify({ error: { message: "rate limited" } }) }, code: "model_transient", status: 429, retryAfterMs: 2000, billing: "none" },
    { reply: { status: 503, headers: { "retry-after-ms": "120" }, text: "" }, code: "model_transient", status: 503, retryAfterMs: 120, billing: "none" },
    { reply: { status: 500, text: "oops" }, code: "model_transient", status: 500, retryAfterMs: null, billing: "none" },
    { reply: { status: 401, text: JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}` } }) }, code: "model_failed", status: 401, billing: "none" },
    { reply: { status: 400, text: JSON.stringify({ error: { message: "bad schema" } }) }, code: "model_failed", status: 400, billing: "none" },
    { reply: { reject: new TypeError("connect ECONNREFUSED") }, code: "model_transient", status: null, billing: "unknown" },
    { reply: { reject: withCode("ECONNREFUSED") }, code: "model_transient", status: null, billing: "none" },
    { reply: { reject: withCode("ENOTFOUND") }, code: "model_transient", status: null, billing: "none" },
    { reply: { reject: withCode("UND_ERR_CONNECT_TIMEOUT") }, code: "model_transient", status: null, billing: "none" },
    { reply: { reject: withCode("UND_ERR_SOCKET") }, code: "model_transient", status: null, billing: "unknown" },
    { reply: { chunks: [sse([chunk({ content: "partial" })])] }, code: "model_transient", status: null, billing: "unknown" },
    { reply: { chunks: [sse([{ data: { error: { message: "server melted" } } }])] }, code: "model_failed", status: null, billing: "unknown" },
    { reply: { text: JSON.stringify({ error: { message: "no choices" } }) }, code: "model_failed", status: null, billing: "unknown" },
    { reply: { text: "<html>" }, code: "model_failed", status: null, billing: "unknown" },
  ];
  for (const item of cases) {
    const provider = createOpenAiProvider({ apiKey: KEY, baseUrl: model.baseUrl, fetch: fakeFetch([item.reply]).fetch });
    await assert.rejects(provider.generate(makeRequest(model), { signal: signal() }), (error: unknown) => {
      assert.ok(isRunwrightError(error));
      assert.equal(error.code, item.code, error.message);
      assert.equal(error.details?.["status"], item.status);
      if (item.retryAfterMs !== undefined) assert.equal(error.details?.["retryAfterMs"], item.retryAfterMs);
      assert.equal(error.details?.["billing"], item.billing, error.message);
      assert.ok(!error.message.includes(KEY), error.message);
      return true;
    });
  }
  const fake = fakeFetch([{ status: 400, text: JSON.stringify({ error: { message: "bad schema" } }) }]);
  await assert.rejects(createOpenAiProvider({ apiKey: KEY, baseUrl: model.baseUrl, fetch: fake.fetch }).generate(makeRequest(model), { signal: signal() }), /bad schema/);
});

test("aborting mid-stream rejects with aborted", async () => {
  const controller = new AbortController();
  const fake = fakeFetch([{ chunks: [sse([chunk({ content: "first" })])], hang: true }]);
  const pending = createOpenAiProvider({ apiKey: KEY, baseUrl: model.baseUrl, fetch: fake.fetch })
    .generate(makeRequest(model), { signal: controller.signal, onDelta: () => controller.abort() });
  await assert.rejects(pending, (error: unknown) => codeOf(error) === "aborted");
});

// ---- Structured output of any JSON type (plan 3.1, 3.2) ----

const ARRAY_SCHEMA = { type: "array", items: { type: "integer" } };

/** A reply with optional text and an optional output-function call, streamed or as a plain JSON completion. */
function outputReply(options: { args?: unknown; name?: string; text?: string }, streamed: boolean): FakeReply {
  const name = options.name ?? "out";
  const call = options.args === undefined ? null : { index: 0, id: "c1", type: "function", function: { name, arguments: options.args } };
  const finish = call === null ? "stop" : "tool_calls";
  if (streamed) {
    const events: { data: unknown }[] = [];
    if (options.text !== undefined) events.push(chunk({ content: options.text }));
    if (call !== null) events.push(chunk({ tool_calls: [call] }));
    events.push(chunk({}, finish), { data: { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } } }, { data: "[DONE]" });
    return { chunks: [sse(events)] };
  }
  const message = { role: "assistant", content: options.text ?? null, ...(call === null ? {} : { tool_calls: [call] }) };
  return { text: JSON.stringify({ choices: [{ index: 0, finish_reason: finish, message }], usage: { prompt_tokens: 3, completion_tokens: 2 } }) };
}

async function structuredCall(schema: Record<string, unknown>, reply: FakeReply, description?: string) {
  const fake = fakeFetch([reply]);
  const output = { name: "out", schema: schema as never, ...(description === undefined ? {} : { description }) };
  const response = await createOpenAiProvider({ apiKey: KEY, baseUrl: model.baseUrl, fetch: fake.fetch })
    .generate(makeRequest(model, { output }), { signal: signal() });
  return { response, body: fake.calls[0]?.body };
}

const PATHS = [["streaming", true], ["plain JSON", false]] as const;

test("R05-01 reviewer's probe: an array output schema answered with [1,2] comes back as [1,2]", async () => {
  for (const [label, streamed] of PATHS) {
    const { response } = await structuredCall(ARRAY_SCHEMA, outputReply({ args: "[1,2]" }, streamed));
    assert.deepEqual(response.output, [1, 2], label);
    assert.deepEqual(response.toolCalls, [], label);
    assert.equal(response.stopReason, "end", label);
    assert.notEqual(response.outputMissing, true, label);
    assert.equal(Object.hasOwn(response, "outputMissing"), false, `${label}: outputMissing is only written when true`);
  }
});

test("the wrapped answer {\"value\":[1,2]} is unwrapped on both paths", async () => {
  for (const [label, streamed] of PATHS) {
    const { response } = await structuredCall(ARRAY_SCHEMA, outputReply({ args: "{\"value\":[1,2]}" }, streamed));
    assert.deepEqual(response.output, [1, 2], label);
    assert.equal(response.stopReason, "end", label);
  }
});

test("request body: a non-object schema is sent wrapped, with the value sentence and $defs on the wrapper", async () => {
  const { body } = await structuredCall(ARRAY_SCHEMA, outputReply({ args: "[1]" }, true));
  assert.deepEqual(body?.["tools"], [{
    type: "function",
    function: {
      name: "out",
      description: "Return the result as the arguments of this function. Put the result in the \"value\" argument.",
      parameters: { type: "object", additionalProperties: false, required: ["value"], properties: { value: ARRAY_SCHEMA } },
    },
  }]);
  const custom = await structuredCall(ARRAY_SCHEMA, outputReply({ args: "[1]" }, true), "List them.");
  const tools = custom.body?.["tools"] as { function: { description: string } }[];
  assert.equal(tools[0]?.function.description, "List them. Put the result in the \"value\" argument.");

  const row = { type: "object", required: ["id"], properties: { id: { type: "integer" } } };
  const withDefs = { type: "array", items: { $ref: "#/$defs/Row" }, $defs: { Row: row } };
  const sent = await structuredCall(withDefs, outputReply({ args: "{\"value\":[{\"id\":1}]}" }, true));
  const parameters = (sent.body?.["tools"] as { function: { parameters: Record<string, unknown> } }[])[0]?.function.parameters;
  assert.deepEqual(parameters, {
    type: "object", additionalProperties: false, required: ["value"],
    properties: { value: { type: "array", items: { $ref: "#/$defs/Row" } } }, $defs: { Row: row },
  });
  assert.deepEqual(sent.response.output, [{ id: 1 }]);
});

test("scalar and null outputs come back as the value on both paths", async () => {
  const cases: { schema: Record<string, unknown>; args: string; expected: unknown }[] = [
    { schema: { type: "string" }, args: "{\"value\":\"hi\"}", expected: "hi" },
    { schema: { type: "number" }, args: "{\"value\":1.5}", expected: 1.5 },
    { schema: { type: "integer" }, args: "{\"value\":3}", expected: 3 },
    { schema: { type: "boolean" }, args: "{\"value\":false}", expected: false },
    { schema: { type: "null" }, args: "{\"value\":null}", expected: null },
    { schema: { type: ["string", "null"] }, args: "{\"value\":null}", expected: null },
    { schema: { type: "string" }, args: "\"hi\"", expected: "hi" },
    { schema: { type: "boolean" }, args: "false", expected: false },
  ];
  for (const [label, streamed] of PATHS) {
    for (const item of cases) {
      const { response } = await structuredCall(item.schema, outputReply({ args: item.args }, streamed));
      const name = `${label} ${JSON.stringify(item.schema)} ${item.args}`;
      assert.deepEqual(response.output, item.expected, name);
      assert.notEqual(response.outputMissing, true, name);
    }
  }
});

test("the decision schema is an object schema: sent as it is and not unwrapped", async () => {
  const schema = decisionSchema({ type: "yes_no" });
  for (const [label, streamed] of PATHS) {
    const { response, body } = await structuredCall(schema, outputReply({ args: "{\"value\":true,\"confidence\":0.9}" }, streamed));
    const tools = body?.["tools"] as { function: { parameters: unknown; description: string } }[];
    assert.deepEqual(tools[0]?.function.parameters, schema, label);
    assert.equal(tools[0]?.function.description, "Return the result as the arguments of this function.", label);
    assert.deepEqual(response.output, { value: true, confidence: 0.9 }, label);
  }
});

test("no output: a wrapper without value or a non-JSON text is missing, never null; JSON text is the bare value", async () => {
  for (const [label, streamed] of PATHS) {
    const emptyWrapper = await structuredCall(ARRAY_SCHEMA, outputReply({ args: "{}" }, streamed));
    assert.equal(emptyWrapper.response.output, null, label);
    assert.equal(emptyWrapper.response.outputMissing, true, label);
    const emptyArgs = await structuredCall(ARRAY_SCHEMA, outputReply({ args: "" }, streamed));
    assert.equal(emptyArgs.response.outputMissing, true, `${label}: empty arguments are {}`);
    const refusal = await structuredCall(ARRAY_SCHEMA, outputReply({ text: "I cannot say" }, streamed));
    assert.equal(refusal.response.output, null, label);
    assert.equal(refusal.response.outputMissing, true, label);
    const textArray = await structuredCall(ARRAY_SCHEMA, outputReply({ text: "[1,2]" }, streamed));
    assert.deepEqual(textArray.response.output, [1, 2], label);
    assert.notEqual(textArray.response.outputMissing, true, label);
    const textWrapper = await structuredCall(ARRAY_SCHEMA, outputReply({ text: "{\"value\":[1,2]}" }, streamed));
    assert.deepEqual(textWrapper.response.output, { value: [1, 2] }, `${label}: a text answer is the bare value`);
    const textNull = await structuredCall({ type: "null" }, outputReply({ text: " null " }, streamed));
    assert.equal(textNull.response.output, null, label);
    assert.notEqual(textNull.response.outputMissing, true, `${label}: an answered null is not missing`);
  }
});

test("output-tool arguments that are not JSON, or not an object under an object schema, are model_failed", async () => {
  const failed = (pattern: RegExp) => (error: unknown) =>
    codeOf(error) === "model_failed" && isRunwrightError(error) && error.details?.["billing"] === "unknown" && pattern.test(error.message);
  for (const [, streamed] of PATHS) {
    await assert.rejects(structuredCall(ARRAY_SCHEMA, outputReply({ args: "[1," }, streamed)), failed(/tool "out" that are not valid JSON/));
    await assert.rejects(structuredCall({ type: "object" }, outputReply({ args: "[1,2]" }, streamed)), failed(/tool "out" that are not a JSON object/));
    await assert.rejects(structuredCall({ type: "object" }, outputReply({ args: "{\"a\":" }, streamed)), failed(/tool "out" that are not a JSON object/));
  }
});

test("only the first output-function call decides the output; a second one is an ordinary call", async () => {
  const stream = sse([
    chunk({ tool_calls: [{ index: 0, id: "a", type: "function", function: { name: "out", arguments: "[1]" } }] }),
    chunk({ tool_calls: [{ index: 1, id: "b", type: "function", function: { name: "out", arguments: "{\"value\":[2]}" } }] }),
    chunk({}, "tool_calls"),
    { data: "[DONE]" },
  ]);
  const { response } = await structuredCall(ARRAY_SCHEMA, { chunks: [stream] });
  assert.deepEqual(response.output, [1]);
  assert.deepEqual(response.toolCalls, [{ id: "b", name: "out", args: { value: [2] } }]);
  assert.equal(response.stopReason, "tool_use");
});

test("arguments sent as a parsed JSON value: an object is used, an array fails the reply instead of becoming {}", async () => {
  const completion = (args: unknown) => JSON.stringify({
    choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "t", arguments: args } }] } }],
  });
  const provider = (args: unknown) => createOpenAiProvider({ apiKey: KEY, baseUrl: model.baseUrl, fetch: fakeFetch([{ text: completion(args) }]).fetch });
  const ok = await provider({ path: "x" }).generate(makeRequest(model), { signal: signal() });
  assert.deepEqual(ok.toolCalls, [{ id: "c", name: "t", args: { path: "x" } }]);
  for (const args of [[1], 5, "\"s\""]) {
    await assert.rejects(
      provider(args).generate(makeRequest(model), { signal: signal() }),
      (error: unknown) => codeOf(error) === "model_failed" && isRunwrightError(error) && error.details?.["billing"] === "unknown",
      JSON.stringify(args),
    );
  }
  const streamed = sse([chunk({ tool_calls: [{ index: 0, id: "c", function: { name: "t", arguments: [1] } }] }, "tool_calls"), { data: "[DONE]" }]);
  await assert.rejects(
    createOpenAiProvider({ apiKey: KEY, baseUrl: model.baseUrl, fetch: fakeFetch([{ chunks: [streamed] }]).fetch }).generate(makeRequest(model), { signal: signal() }),
    (error: unknown) => codeOf(error) === "model_failed",
  );
  const structured = await structuredCall(ARRAY_SCHEMA, outputReply({ args: [1, 2] }, false));
  assert.deepEqual(structured.response.output, [1, 2], "a parsed array as the output function's arguments is the value");
});

// ---- A success reply must be a reply (R09D-models-03) ----

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

const generateWith = (reply: FakeReply) =>
  createOpenAiProvider({ apiKey: KEY, baseUrl: model.baseUrl, fetch: fakeFetch([reply]).fetch }).generate(makeRequest(model), { signal: signal() });

test("rule 8: a JSON reply that is not an object, or carries an error, is a reply failure", async () => {
  for (const body of ["[]", "\"text\"", "3", "null"]) {
    await assert.rejects(generateWith({ text: body }), rejectsAs("model_failed", /not a JSON object/), body);
  }
  const withError = { error: { message: `quota exceeded for ${KEY}` }, choices: [{ message: { content: "hi" } }] };
  await assert.rejects(generateWith({ text: JSON.stringify(withError) }), rejectsAs("model_failed", /quota exceeded for \[redacted\]/));
  const bareError = { error: { code: 1 }, choices: [{ message: { content: "hi" } }] };
  await assert.rejects(generateWith({ text: JSON.stringify(bareError) }), rejectsAs("model_failed", /the response carries an error/));
  const nullError = await generateWith({ text: JSON.stringify({ error: null, choices: [{ message: { content: "hi" }, finish_reason: "stop" }] }) });
  assert.equal(nullError.text, "hi", "error: null is not an error");
});

test("rule 9: a first choice without a message object is a reply failure; usage stays optional", async () => {
  for (const choice of [{}, { message: null }, { message: "hi" }, { delta: { content: "hi" } }]) {
    await assert.rejects(generateWith({ text: JSON.stringify({ choices: [choice] }) }), rejectsAs("model_failed", /no message object/), JSON.stringify(choice));
  }
  const reply = await generateWith({ text: JSON.stringify({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }] }) });
  assert.equal(reply.text, "hi");
  assert.deepEqual(reply.usageMissing, ["input", "output"], "a reply without usage names what it did not report");
});

test("rule 10: a stream payload that is neither [DONE] nor a JSON object is a reply failure, not skipped", async () => {
  for (const bad of [`oops ${KEY}`, "[1]", "42"]) {
    const stream = sse([chunk({ content: "hi" }), { data: bad }, chunk({}, "stop"), { data: "[DONE]" }]);
    await assert.rejects(generateWith({ chunks: [stream] }), rejectsAs("model_failed", /neither \[DONE\] nor a JSON object/), bad);
  }
});

test("rule 11: [DONE] or the end of the body before any choice is a reply failure", async () => {
  const usageOnly = { data: { choices: [], usage: { prompt_tokens: 3, completion_tokens: 0 } } };
  for (const events of [[{ data: "[DONE]" }], [usageOnly, { data: "[DONE]" }], [usageOnly]]) {
    await assert.rejects(generateWith({ chunks: [sse(events)] }), rejectsAs("model_failed", /stream ended without a completion/), JSON.stringify(events));
  }
  await assert.rejects(generateWith({ chunks: [""] }), rejectsAs("model_failed", /stream ended without a completion/));
  const truncated = sse([chunk({ content: "hi" })]);
  await assert.rejects(generateWith({ chunks: [truncated] }), rejectsAs("model_transient", /stream ended before it finished/));
});

test("end to end: a 200 reply of {} is rejected instead of returning an empty response", async () => {
  await assert.rejects(generateWith({ text: "{}" }), rejectsAs("model_failed", /no choices in the response/));
});

test("a tool-call index outside 0..4095 is a reply failure instead of a huge sparse scan", async () => {
  for (const index of [1e9, -1, 0.5]) {
    const stream = sse([
      chunk({ tool_calls: [{ index, id: "c", type: "function", function: { name: "read_file", arguments: "{}" } }] }),
      chunk({}, "tool_calls"),
      { data: "[DONE]" },
    ]);
    await assert.rejects(generateWith({ chunks: [stream] }), rejectsAs("model_failed", /index that is not an integer/), String(index));
  }
});

// ---- A reply part that is read is checked, and success needs a terminal finish_reason (R10-05) ----

const usageChunk = { data: { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } } };
const streamOfChunks = (...events: { data: unknown }[]): FakeReply => ({ chunks: [sse([...events, { data: "[DONE]" }])] });
const choiceChunk = (choice: unknown): { data: unknown } => ({ data: { choices: [choice] } });
const jsonReply = (choice: unknown, extra: Record<string, unknown> = {}): FakeReply =>
  ({ text: JSON.stringify({ choices: [choice], usage: { prompt_tokens: 5, completion_tokens: 2 }, ...extra }) });

test("a stream whose choices never carry a finish_reason is a reply failure, not an empty success", async () => {
  const noFinish = /openai-compatible: the stream ended without a finish_reason/;
  await assert.rejects(generateWith(streamOfChunks(choiceChunk({}))), rejectsAs("model_failed", noFinish));
  await assert.rejects(generateWith(streamOfChunks(choiceChunk({ index: 0, delta: { role: "assistant" } }))), rejectsAs("model_failed", noFinish));
  await assert.rejects(generateWith(streamOfChunks(chunk({ content: "hi" }), usageChunk)), rejectsAs("model_failed", noFinish));
  await assert.rejects(
    generateWith(streamOfChunks(chunk({ tool_calls: [{ index: 0, id: "c", function: { name: "t", arguments: "{}" } }] }))),
    rejectsAs("model_failed", noFinish),
  );
});

test("choices that is not an array, or a first choice that is not an object, is a reply failure", async () => {
  const finished = chunk({ content: "ok" }, "stop");
  await assert.rejects(generateWith(streamOfChunks({ data: { choices: {} } }, finished)), rejectsAs("model_failed", /"choices" is not an array/));
  await assert.rejects(generateWith(streamOfChunks({ data: { choices: "x" } }, finished)), rejectsAs("model_failed", /"choices" is not an array/));
  for (const first of ["x", 5, null, [1]]) {
    await assert.rejects(generateWith(streamOfChunks({ data: { choices: [first] } }, finished)), rejectsAs("model_failed", /the first choice is not an object/), JSON.stringify(first));
  }
  await assert.rejects(generateWith({ text: JSON.stringify({ choices: { message: { content: "hi" } } }) }), rejectsAs("model_failed", /"choices" is not an array/));
  await assert.rejects(generateWith({ text: JSON.stringify({ choices: ["x"] }) }), rejectsAs("model_failed", /the first choice is not an object/));
  const withNull = await generateWith(streamOfChunks({ data: { choices: null, usage: { prompt_tokens: 1, completion_tokens: 1 } } }, finished));
  assert.equal(withNull.text, "ok", "choices: null is a chunk without a choice");
});

test("a delta of the wrong shape is a reply failure instead of an empty delta", async () => {
  const finished = chunk({}, "stop");
  const cases: [unknown, RegExp][] = [
    ["x", /the delta of a choice is not an object/],
    [5, /the delta of a choice is not an object/],
    [[{ content: "hi" }], /the delta of a choice is not an object/],
    [{ content: 7 }, /"content" is not a string or null/],
    [{ content: { text: "hi" } }, /"content" is not a string or null/],
    [{ tool_calls: {} }, /"tool_calls" is not an array of objects/],
    [{ tool_calls: ["x"] }, /"tool_calls" is not an array of objects/],
    [{ tool_calls: [{ index: 0, id: 5, function: { name: "t", arguments: "{}" } }] }, /a tool call "id" is not a string/],
    [{ tool_calls: [{ index: 0, id: "c", function: "t" }] }, /a tool call "function" is not an object/],
    [{ tool_calls: [{ index: 0, id: "c", function: { name: 5, arguments: "{}" } }] }, /a tool call function "name" is not a string/],
  ];
  for (const [delta, pattern] of cases) {
    const deltas: string[] = [];
    const reply = createOpenAiProvider({ apiKey: KEY, baseUrl: model.baseUrl, fetch: fakeFetch([streamOfChunks(choiceChunk({ index: 0, delta }), finished)]).fetch })
      .generate(makeRequest(model), { signal: signal(), onDelta: (d) => deltas.push(d) });
    await assert.rejects(reply, rejectsAs("model_failed", pattern), JSON.stringify(delta));
    assert.deepEqual(deltas, [], `${JSON.stringify(delta)}: nothing is emitted from a rejected chunk`);
  }
  const lenient = await generateWith(streamOfChunks(
    choiceChunk({ index: 0, delta: null }),
    chunk({ content: null, tool_calls: null }),
    chunk({ tool_calls: [{ id: null, function: null }] }),
    chunk({ tool_calls: [{ index: 0, id: "c", function: { name: "t", arguments: { a: 1 } } }] }),
    chunk({}, "tool_calls"),
  ));
  assert.deepEqual(lenient.toolCalls, [{ id: "c", name: "t", args: { a: 1 } }], "null parts are absent; parsed arguments and a missing index stay accepted");
});

test("a finish_reason that is not a non-empty string is a reply failure", async () => {
  for (const finish of [5, "", true, { reason: "stop" }]) {
    await assert.rejects(
      generateWith(streamOfChunks(choiceChunk({ index: 0, delta: { content: "hi" }, finish_reason: finish }))),
      rejectsAs("model_failed", /"finish_reason" is not a non-empty string/),
      JSON.stringify(finish),
    );
  }
  await assert.rejects(generateWith(jsonReply({ message: { content: "hi" }, finish_reason: 5 })), rejectsAs("model_failed", /"finish_reason" is not a non-empty string/));
});

test("a JSON reply needs a finish_reason and a message of the right shape", async () => {
  const noFinish = /openai-compatible returned a choice with no finish_reason/;
  await assert.rejects(generateWith(jsonReply({ message: { content: "hi" } })), rejectsAs("model_failed", noFinish));
  await assert.rejects(generateWith(jsonReply({ message: { content: "hi" }, finish_reason: null })), rejectsAs("model_failed", noFinish));
  await assert.rejects(generateWith(jsonReply({ message: { content: "hi" }, finish_reason: "" })), rejectsAs("model_failed", noFinish));
  await assert.rejects(generateWith(jsonReply({ message: { content: 7 }, finish_reason: "stop" })), rejectsAs("model_failed", /"content" is not a string or null/));
  await assert.rejects(generateWith(jsonReply({ message: { content: null, tool_calls: { id: "c" } }, finish_reason: "tool_calls" })), rejectsAs("model_failed", /"tool_calls" is not an array of objects/));
  await assert.rejects(
    generateWith(jsonReply({ message: { content: null, tool_calls: [{ id: "c", function: "t" }] }, finish_reason: "tool_calls" })),
    rejectsAs("model_failed", /a tool call "function" is not an object/),
  );
  const deltas: string[] = [];
  await assert.rejects(
    createOpenAiProvider({ apiKey: KEY, baseUrl: model.baseUrl, fetch: fakeFetch([jsonReply({ message: { content: "hi" } })]).fetch })
      .generate(makeRequest(model), { signal: signal(), onDelta: (d) => deltas.push(d) }),
    rejectsAs("model_failed", noFinish),
  );
  assert.deepEqual(deltas, [], "a rejected JSON reply emits no text");
});

test("a finished tool call without a function name is a reply failure (stream and JSON)", async () => {
  const noName = /openai-compatible returned a tool call without a function name/;
  await assert.rejects(
    generateWith(streamOfChunks(chunk({ tool_calls: [{ index: 0, id: "c", function: { arguments: "{}" } }] }), chunk({}, "tool_calls"))),
    rejectsAs("model_failed", noName),
  );
  await assert.rejects(
    generateWith(streamOfChunks(chunk({ tool_calls: [{ index: 0, id: "c", function: { name: "", arguments: "{}" } }] }), chunk({}, "tool_calls"))),
    rejectsAs("model_failed", noName),
  );
  await assert.rejects(
    generateWith(jsonReply({ message: { content: null, tool_calls: [{ id: "c", type: "function", function: { arguments: "{}" } }] }, finish_reason: "tool_calls" })),
    rejectsAs("model_failed", noName),
  );
});

test("still valid: usage-only chunks, an empty completion with a finish_reason, length, tool calls; no [DONE] stays transient", async () => {
  const withUsage = await generateWith({ chunks: [sse([chunk({ content: "a" }), usageChunk, chunk({ content: "b" }), chunk({}, "stop"), usageChunk, { data: "[DONE]" }])] });
  assert.equal(withUsage.text, "ab");
  assert.equal(withUsage.stopReason, "end");
  assert.deepEqual(withUsage.usage, { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 });

  const usageOnlyKey = await generateWith(streamOfChunks(chunk({ content: "x" }, "stop"), { data: { usage: { prompt_tokens: 1, completion_tokens: 1 } } }));
  assert.deepEqual(usageOnlyKey.usage, { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });

  const empty = await generateWith(streamOfChunks(chunk({}, "stop")));
  assert.equal(empty.text, "");
  assert.deepEqual(empty.toolCalls, []);
  assert.equal(empty.stopReason, "end");
  const emptyJson = await generateWith(jsonReply({ message: { role: "assistant", content: "" }, finish_reason: "stop" }));
  assert.equal(emptyJson.text, "");
  assert.equal(emptyJson.stopReason, "end");
  const absentContent = await generateWith(jsonReply({ message: { role: "assistant" }, finish_reason: "stop" }));
  assert.equal(absentContent.text, "");

  const length = await generateWith(streamOfChunks(chunk({ content: "cut" }), chunk({}, "length")));
  assert.equal(length.stopReason, "max_tokens");
  const lengthJson = await generateWith(jsonReply({ message: { content: "cut" }, finish_reason: "length" }));
  assert.equal(lengthJson.stopReason, "max_tokens");

  const tools = await generateWith(streamOfChunks(chunk({ tool_calls: [{ index: 0, id: "c", type: "function", function: { name: "t", arguments: "{}" } }] }), chunk({}, "tool_calls")));
  assert.equal(tools.stopReason, "tool_use");
  assert.deepEqual(tools.toolCalls, [{ id: "c", name: "t", args: {} }]);

  await assert.rejects(generateWith({ chunks: [sse([chunk({ content: "hi" }, "stop")])] }), rejectsAs("model_transient", /stream ended before it finished/));
});

test("usage whose token counts are not non-negative numbers is a reply failure; a missing count is named", async () => {
  for (const usage of [
    { prompt_tokens: "100", completion_tokens: 5 },
    { prompt_tokens: 100, completion_tokens: -5 },
    { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: -50 } },
    { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: "50" } },
  ]) {
    await assert.rejects(
      generateWith(streamOfChunks(chunk({ content: "some reply text" }, "stop"), { data: { choices: [], usage } })),
      rejectsAs("model_failed", /openai-compatible sent a usage field \w+ that is not a non-negative number/),
      JSON.stringify(usage),
    );
  }
  const partial = await generateWith(streamOfChunks(chunk({ content: "some reply text" }, "stop"), { data: { choices: [], usage: { completion_tokens: 1 } } }));
  assert.deepEqual(partial.usage, { inputTokens: 0, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });
  assert.deepEqual(partial.usageMissing, ["input"], "a report missing prompt_tokens names the input count");
  const nullUsage = await generateWith(streamOfChunks(chunk({ content: "some reply text" }, "stop"), { data: { choices: [], usage: null } }));
  assert.deepEqual(nullUsage.usageMissing, ["input", "output"]);
  const overCached = await generateWith(streamOfChunks(chunk({ content: "x" }, "stop"), { data: { choices: [], usage: { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 40 } } } }));
  assert.deepEqual(overCached.usage, { inputTokens: 0, outputTokens: 1, cacheReadTokens: 10, cacheWriteTokens: 0 }, "cached tokens are at most the prompt");
});

// ---- Error envelopes inside a 200 reply are classified (R13D-models-01) ----

const envelopeCases: { body: Record<string, unknown>; code: string; status: number | null }[] = [
  { body: { error: { code: 503, message: "temporarily unavailable" } }, code: "model_transient", status: 503 },
  { body: { error: { type: "rate_limit_exceeded", message: "slow down" } }, code: "model_transient", status: null },
  { body: { error: { code: "invalid_api_key", message: "bad key" } }, code: "model_failed", status: null },
  { body: { error: { code: 400, message: "bad request" } }, code: "model_failed", status: 400 },
];

function envelopeAssert(code: string, status: number | null, pattern: RegExp) {
  return (error: unknown): boolean => {
    assert.ok(isRunwrightError(error), String(error));
    assert.equal(error.code, code, error.message);
    assert.equal(error.details?.["status"], status, error.message);
    assert.equal(error.details?.["billing"], "unknown", error.message);
    if (code === "model_transient") assert.equal(error.details?.["retryAfterMs"], null);
    assert.match(error.message, pattern);
    return true;
  };
}

test("envelopes: an error streamed in a 200 reply is classified by status and kind", async () => {
  for (const item of envelopeCases) {
    const stream = sse([chunk({ content: "partial" }), { data: item.body }]);
    await assert.rejects(generateWith({ chunks: [stream] }), envelopeAssert(item.code, item.status, /^openai-compatible stream error: /), JSON.stringify(item.body));
  }
});

test("envelopes: the same errors as a plain JSON body are classified the same way", async () => {
  for (const item of envelopeCases) {
    await assert.rejects(generateWith({ text: JSON.stringify(item.body) }), envelopeAssert(item.code, item.status, /^openai-compatible: /), JSON.stringify(item.body));
  }
});

test("envelopes: numeric-string codes, error.status, top-level codes and transient kinds", async () => {
  await assert.rejects(generateWith({ text: JSON.stringify({ error: { code: "502", message: "gateway" } }) }), envelopeAssert("model_transient", 502, /gateway/));
  await assert.rejects(generateWith({ text: JSON.stringify({ error: { status: 429, message: "busy" } }) }), envelopeAssert("model_transient", 429, /busy/));
  await assert.rejects(generateWith({ text: JSON.stringify({ code: 500, message: "upstream down" }) }), envelopeAssert("model_transient", 500, /upstream down/));
  await assert.rejects(generateWith({ text: JSON.stringify({ error: { type: "Server_Error", message: "oops" } }) }), envelopeAssert("model_transient", null, /oops/));
  await assert.rejects(generateWith({ text: JSON.stringify({ error: { code: 1000, type: "overloaded", message: "x" } }) }), envelopeAssert("model_transient", null, /x/));
  await assert.rejects(generateWith({ text: JSON.stringify({ error: "plain text error" }) }), envelopeAssert("model_failed", null, /plain text error/));
  await assert.rejects(generateWith({ text: JSON.stringify({ choices: [] }) }), envelopeAssert("model_failed", null, /no choices in the response/));
});

// ---- A reply without usage names its missing counts, whatever it visibly holds (R14D-models-01, rule U) ----

test("(R14D-models-01) a reply without usage, or with one count, is never given an estimate for the other", async () => {
  const text = "漢字の答え \u{1F600}\u{1F600}\u{1F600} done";
  const args = "{\"path\":\"été.txt\"}";
  const streamed = await generateWith(streamOfChunks(
    chunk({ content: text }),
    chunk({ tool_calls: [{ index: 0, id: "c", function: { name: "read_file", arguments: args } }] }, "tool_calls"),
  ));
  assert.deepEqual(streamed.usage, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  assert.deepEqual(streamed.usageMissing, ["input", "output"]);
  const plain = await generateWith({
    text: JSON.stringify({ choices: [{ index: 0, message: { content: text, tool_calls: [{ id: "c", function: { name: "read_file", arguments: args } }] }, finish_reason: "tool_calls" }] }),
  });
  assert.deepEqual(plain.usageMissing, ["input", "output"]);
  const cases: { partial: object; usage: object; missing: string[] }[] = [
    { partial: { prompt_tokens: 5 }, usage: { inputTokens: 5, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, missing: ["output"] },
    { partial: { completion_tokens: 1 }, usage: { inputTokens: 0, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, missing: ["input"] },
    { partial: { prompt_tokens: 5, completion_tokens: null }, usage: { inputTokens: 5, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, missing: ["output"] },
  ];
  for (const item of cases) {
    const reply = await generateWith({
      text: JSON.stringify({ choices: [{ index: 0, message: { content: text }, finish_reason: "stop" }], usage: item.partial }),
    });
    assert.deepEqual(reply.usage, item.usage, JSON.stringify(item.partial));
    assert.deepEqual(reply.usageMissing, item.missing, JSON.stringify(item.partial));
  }
});

test("(R14D-models-01) fractional, string and negative counts are reply failures on the stream and the JSON path", async () => {
  const pattern = /openai-compatible sent a usage field \w+ that is not a non-negative number/;
  for (const usage of [{ prompt_tokens: 10, completion_tokens: 2.5 }, { prompt_tokens: 0.5, completion_tokens: 2 }, { prompt_tokens: 10, completion_tokens: "2" },
    { prompt_tokens: 10, completion_tokens: -2 }, { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 1.5 } }]) {
    await assert.rejects(generateWith(streamOfChunks(chunk({ content: "x" }, "stop"), { data: { choices: [], usage } })), rejectsAs("model_failed", pattern), JSON.stringify(usage));
    await assert.rejects(
      generateWith({ text: JSON.stringify({ choices: [{ index: 0, message: { content: "x" }, finish_reason: "stop" }], usage }) }),
      rejectsAs("model_failed", pattern),
      `JSON ${JSON.stringify(usage)}`,
    );
  }
  const huge = await generateWith(streamOfChunks(chunk({ content: "x" }, "stop"), { data: { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1e300 } } }));
  assert.equal(huge.usage.outputTokens, 1e300, "an absurd count is passed on; the engine saturates it, over any cap");
});
