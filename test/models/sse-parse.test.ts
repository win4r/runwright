import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_ERROR_BODY_BYTES, MAX_REPLY_BYTES, MAX_SSE_EVENT_CHARS, SseParser, cleanProviderText, fetchRejectionBilling, parseToolArgs,
  parseToolArgsJson, postToProvider, readJsonBody, readSse, toolArgsObject,
} from "../../src/models/sse-parse.ts";
import { createAnthropicProvider } from "../../src/models/anthropic.ts";
import { createOpenAiProvider } from "../../src/models/openai.ts";
import { makeRequest } from "./fake-fetch.ts";
import { isRunwrightError } from "../../src/core/errors.ts";

test("SSE parser handles names, multi-line data, comments, ids and every line ending", () => {
  const parser = new SseParser();
  const events = [
    ...parser.push(": comment\nevent: a\ndata: one\ndata: two\nid: 7\n\n"),
    ...parser.push("data: crlf\r\n\r\n"),
    ...parser.push("data:no-space\r"),
    ...parser.push("\n\r\n"),
    ...parser.push("event: lonely\n\n"),
    ...parser.push("data: un"),
    ...parser.push("split\n\n"),
  ];
  assert.deepEqual(events, [
    { event: "a", data: "one\ntwo", id: "7" },
    { event: "message", data: "crlf", id: "7" },
    { event: "message", data: "no-space", id: "7" },
    { event: "message", data: "unsplit", id: "7" },
  ]);
});

test("readSse decodes split UTF-8 and drops an unfinished trailing event", async () => {
  const bytes = new TextEncoder().encode("data: héllo\n\ndata: tail");
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  });
  const out: string[] = [];
  for await (const event of readSse(body, new AbortController().signal, { provider: "p" })) out.push(event.data);
  assert.deepEqual(out, ["héllo"]);
});

test("readSse maps a failing body to model_transient", async () => {
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error("socket hang up"));
    },
  });
  await assert.rejects(async () => {
    for await (const event of readSse(body, new AbortController().signal, { provider: "p" })) assert.fail(event.data);
  }, (error: unknown) => isRunwrightError(error) && error.code === "model_transient" && error.details?.["billing"] === "unknown");
});

const coded = (code: string, message = code): Error => Object.assign(new Error(message), { code });

test("fetchRejectionBilling: none only when the cause chain says no connection was made", () => {
  for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]) {
    assert.equal(fetchRejectionBilling(new TypeError("fetch failed", { cause: coded(code) })), "none", code);
  }
  assert.equal(fetchRejectionBilling(coded("ECONNREFUSED")), "none", "the code on the error itself counts");
  const deep = new TypeError("fetch failed", { cause: new Error("wrapper", { cause: new Error("inner", { cause: coded("ENOTFOUND") }) }) });
  assert.equal(fetchRejectionBilling(deep), "none", "the chain is walked");
  for (const code of ["ECONNRESET", "UND_ERR_SOCKET", "ETIMEDOUT", "EPIPE"]) {
    assert.equal(fetchRejectionBilling(new TypeError("fetch failed", { cause: coded(code) })), "unknown", code);
  }
  assert.equal(fetchRejectionBilling(new TypeError("connect ECONNREFUSED")), "unknown", "a message alone is not a code");
  assert.equal(fetchRejectionBilling(new TypeError("fetch failed")), "unknown");
  assert.equal(fetchRejectionBilling("text"), "unknown");
  assert.equal(fetchRejectionBilling(null), "unknown");

  const allRefused = new AggregateError([coded("ECONNREFUSED"), coded("EHOSTUNREACH")], "connect failed");
  assert.equal(fetchRejectionBilling(new TypeError("fetch failed", { cause: allRefused })), "none", "every address refused");
  const oneReset = new AggregateError([coded("ECONNREFUSED"), coded("ECONNRESET")], "connect failed");
  assert.equal(fetchRejectionBilling(new TypeError("fetch failed", { cause: oneReset })), "unknown", "one address may have been reached");

  let chain: Error = coded("ECONNREFUSED");
  for (let i = 0; i < 50; i++) chain = new Error(`level ${i}`, { cause: chain });
  assert.equal(fetchRejectionBilling(chain), "unknown", "the walk is bounded");
  const loop = new Error("loop") as Error & { cause?: unknown };
  loop.cause = loop;
  assert.equal(fetchRejectionBilling(loop), "unknown", "a cyclic chain ends");
});

test("postToProvider: a bad URL is model_failed with billing none and fetch is never called", async () => {
  let calls = 0;
  const fetchSpy = (async () => {
    calls++;
    return new Response("{}");
  }) as unknown as typeof fetch;
  await assert.rejects(
    postToProvider({ fetch: fetchSpy, provider: "p", url: "::not a url::", headers: {}, body: {}, signal: new AbortController().signal, apiKey: null }),
    (error: unknown) => isRunwrightError(error) && error.code === "model_failed" && error.details?.["billing"] === "none",
  );
  assert.equal(calls, 0);
});

test("cleanProviderText removes the key and trims long text", () => {
  assert.equal(cleanProviderText("bad key sk-123456789 here", "sk-123456789"), "bad key [redacted] here");
  assert.equal(cleanProviderText("x".repeat(600), null).length, 503);
});

test("tool-call arguments: any JSON is parsed, empty text is {}, ordinary calls need an object", () => {
  assert.deepEqual(parseToolArgsJson("[1,2]", "p", "t", "json"), [1, 2]);
  assert.deepEqual(parseToolArgsJson(" ", "p", "t", "json"), {});
  assert.equal(parseToolArgsJson("null", "p", "t", "object"), null);
  const failed = (pattern: RegExp) => (error: unknown) =>
    isRunwrightError(error) && error.code === "model_failed" && error.details?.["billing"] === "unknown" && pattern.test(error.message);
  assert.throws(() => parseToolArgsJson("{", "p", "t", "json"), failed(/^p returned arguments for tool "t" that are not valid JSON$/));
  assert.throws(() => parseToolArgsJson("{", "p", "t", "object"), failed(/^p returned arguments for tool "t" that are not a JSON object$/));
  assert.deepEqual(toolArgsObject({ a: 1 }, "p", "t"), { a: 1 });
  for (const value of [[1], "s", 0, false, null]) assert.throws(() => toolArgsObject(value, "p", "t"), failed(/not a JSON object/), JSON.stringify(value));
  assert.deepEqual(parseToolArgs("", "p", "t"), {});
  assert.deepEqual(parseToolArgs("{\"a\":1}", "p", "t"), { a: 1 });
  assert.throws(() => parseToolArgs("[1]", "p", "t"), failed(/not a JSON object/));
});

// ---- Provider bodies are bounded and closed on every exit (R14D-tools-01 / R14D-store-01 sweep) ----

/** A body that sends `chunk` for ever (or `limit` times) and records whether it was cancelled. */
function endlessBody(chunk: Uint8Array, limit = Number.POSITIVE_INFINITY): { body: ReadableStream<Uint8Array>; state: { cancelled: boolean; pulls: number } } {
  const state = { cancelled: false, pulls: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulls++;
      if (state.pulls > limit) controller.close();
      else controller.enqueue(chunk);
    },
    cancel() {
      state.cancelled = true;
    },
  }, { highWaterMark: 0 });
  return { body, state };
}

const failedAs = (code: string, pattern: RegExp) => (error: unknown): boolean =>
  isRunwrightError(error) && error.code === code && error.details?.["billing"] === "unknown" && pattern.test(error.message);

test("SSE parser: an event or a line longer than its bound is a reply failure; the count restarts with each event", () => {
  const lineOnly = new SseParser(16);
  assert.deepEqual(lineOnly.push("data: 12345678\n\n"), [{ event: "message", data: "12345678", id: null }]);
  assert.throws(() => lineOnly.push("data: 0123456789abcdef"), failedAs("model_failed", /event longer than 16 characters/));
  const dataLines = new SseParser(16);
  assert.deepEqual(dataLines.push("data: 1234567\n\ndata: 1234567\n\n").length, 2, "each event counts on its own");
  assert.throws(() => dataLines.push("data: 1234567\ndata: 1234567\ndata: 1\n"), failedAs("model_failed", /event longer than 16 characters/));
  assert.ok(MAX_SSE_EVENT_CHARS >= 1024 * 1024);
});

test("readSse: a stream that never ends a line fails at the bound and cancels the body", { timeout: 20_000 }, async () => {
  const { body, state } = endlessBody(new Uint8Array(1024 * 1024).fill(0x61));
  await assert.rejects(async () => {
    for await (const event of readSse(body, new AbortController().signal, { provider: "p" })) assert.fail(event.data);
  }, failedAs("model_failed", /event longer than/));
  assert.equal(state.cancelled, true);
  assert.ok(state.pulls <= MAX_SSE_EVENT_CHARS / (1024 * 1024) + 3, `read ${state.pulls} chunks`);
});

test("an error status whose body never ends is answered after a bounded read, and the body is cancelled", { timeout: 10_000 }, async () => {
  const { body, state } = endlessBody(new TextEncoder().encode("x".repeat(4096)));
  const fetchEndless = (async () => new Response(body, { status: 503, headers: { "content-type": "text/plain" } })) as unknown as typeof fetch;
  await assert.rejects(
    postToProvider({ fetch: fetchEndless, provider: "p", url: "https://example.test/x", headers: {}, body: {}, signal: new AbortController().signal, apiKey: null }),
    (error: unknown) => isRunwrightError(error) && error.code === "model_transient" && error.details?.["status"] === 503 && /^p returned HTTP 503: x+/.test(error.message),
  );
  assert.equal(state.cancelled, true);
  assert.ok(state.pulls * 4096 <= MAX_ERROR_BODY_BYTES + 2 * 4096);
});

test("a plain-JSON reply over its bound is a reply failure with unknown billing, and the body is cancelled", { timeout: 30_000 }, async () => {
  const { body, state } = endlessBody(new Uint8Array(1024 * 1024).fill(0x20));
  await assert.rejects(
    readJsonBody(new Response(body, { headers: { "content-type": "application/json" } }), "p", new AbortController().signal),
    failedAs("model_failed", /p sent a reply larger than \d+ bytes/),
  );
  assert.equal(state.cancelled, true);
  assert.ok(state.pulls <= MAX_REPLY_BYTES / (1024 * 1024) + 3);
});

test("both providers cancel the stream when a reply failure is thrown inside their read loop", async () => {
  const model = { provider: "anthropic" as const, name: "claude-test" };
  const anthropicEvents = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n' +
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":3,"delta":{"type":"text_delta","text":"x"}}\n\n';
  const openAiEvents = 'data: {"choices":[{"index":0,"delta":{"content":5}}]}\n\n';
  for (const [name, events] of [["anthropic", anthropicEvents], ["openai-compatible", openAiEvents]] as const) {
    let cancelled = false;
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) controller.enqueue(new TextEncoder().encode(events));
        sent = true;
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchStream = (async () => new Response(body, { headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
    const provider = name === "anthropic"
      ? createAnthropicProvider({ apiKey: "k", fetch: fetchStream })
      : createOpenAiProvider({ apiKey: null, baseUrl: "https://example.test/v1", fetch: fetchStream });
    await assert.rejects(provider.generate(makeRequest(model), { signal: new AbortController().signal }), failedAs("model_failed", /./), name);
    assert.equal(cancelled, true, name);
  }
});

test("an error body sent as one chunk over the bound still gives its first bytes as the message", async () => {
  const big = new TextEncoder().encode(`{"error":{"message":"quota"}} ${"y".repeat(MAX_ERROR_BODY_BYTES * 2)}`);
  const fetchBig = (async () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(big); c.close(); } }), { status: 400 })) as unknown as typeof fetch;
  await assert.rejects(
    postToProvider({ fetch: fetchBig, provider: "p", url: "https://example.test/x", headers: {}, body: {}, signal: new AbortController().signal, apiKey: null }),
    (error: unknown) => isRunwrightError(error) && error.code === "model_failed" && /^p returned HTTP 400: \{"error":\{"message":"quota"\}\} y+\.\.\.$/.test(error.message),
  );
});
