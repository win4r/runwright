import { test } from "node:test";
import assert from "node:assert/strict";
import { createScriptedProvider } from "../../src/models/scripted.ts";
import type { ModelRef, ModelRequest, ScriptedScript } from "../../src/models/types.ts";
import { typicalTokens } from "../../src/models/util.ts";
import { isRunwrightError } from "../../src/core/errors.ts";
import { makeRequest, signal } from "./fake-fetch.ts";

const model = (script?: ScriptedScript): ModelRef => ({ provider: "scripted", name: "scripted-1", ...(script === undefined ? {} : { script }) });

function req(script: ScriptedScript | undefined, overrides?: Partial<ModelRequest>, meta?: Partial<ModelRequest["meta"]>): ModelRequest {
  const base = makeRequest(model(script), overrides);
  return { ...base, meta: { ...base.meta, ...meta } };
}

const provider = createScriptedProvider();
const codeOf = (error: unknown): string => (isRunwrightError(error) ? error.code : "not-runwright");

test("turns are selected by meta.turn and past the end the script is finished", async () => {
  const script: ScriptedScript = { turns: [{ text: "one" }, { text: "two", toolCalls: [{ name: "read_file", args: { path: "a" } }] }] };
  const first = await provider.generate(req(script, {}, { turn: 1 }), { signal: signal() });
  assert.equal(first.text, "one");
  assert.equal(first.stopReason, "end");
  const second = await provider.generate(req(script, {}, { turn: 2, key: "t2" }), { signal: signal() });
  assert.equal(second.stopReason, "tool_use");
  assert.deepEqual(second.toolCalls, [{ id: "call_t2_0", name: "read_file", args: { path: "a" } }]);
  const third = await provider.generate(req(script, {}, { turn: 3 }), { signal: signal() });
  assert.equal(third.text, "(script finished)");
  assert.deepEqual(third.toolCalls, []);
});

test("a ref without a script behaves as an empty script", async () => {
  const reply = await provider.generate(req(undefined), { signal: signal() });
  assert.equal(reply.text, "(script finished)");
  assert.equal(reply.output, null);
});

test("variants match on system, messages or either, in order", async () => {
  const script: ScriptedScript = {
    turns: [{ text: "default" }],
    variants: [
      { when: { contains: "EXPERT", in: "system" }, turns: [{ text: "expert" }] },
      { when: { contains: "invoice", in: "messages" }, turns: [{ text: "billing" }] },
      { when: { contains: "zebra" }, turns: [{ text: "any" }] },
      { when: { contains: "hello" }, steps: { other: { text: "no turns here" } } },
    ],
  };
  const gen = async (system: string, content: string): Promise<string> =>
    (await provider.generate(req(script, { system, messages: [{ role: "user", content }] }), { signal: signal() })).text;
  assert.equal(await gen("You are an EXPERT", "hello"), "expert");
  assert.equal(await gen("plain", "EXPERT please"), "default", "system-only variant ignores messages");
  assert.equal(await gen("plain", "my invoice"), "billing");
  assert.equal(await gen("invoice in system", "x"), "default", "messages-only variant ignores system");
  assert.equal(await gen("zebra", "x"), "any");
  assert.equal(await gen("plain", "zebra"), "any");
  assert.equal(await gen("plain", "hello"), "default", "a matching variant without turns falls through");
});

test("steps: variant step first, then script step, arrays indexed by turn and clamped", async () => {
  const script: ScriptedScript = {
    steps: { classify: [{ text: "a" }, { text: "b" }], "learning.propose": { text: "propose" } },
    variants: [{ when: { contains: "special" }, steps: { classify: { text: "variant" } } }],
  };
  const step = async (turn: number, content = "x"): Promise<string> =>
    (await provider.generate(req(script, { messages: [{ role: "user", content }] }, { step: "classify", turn }), { signal: signal() })).text;
  assert.equal(await step(1), "a");
  assert.equal(await step(2), "b");
  assert.equal(await step(7), "b");
  assert.equal(await step(1, "special"), "variant");
  const learning = await provider.generate(req(script, {}, { step: "learning.propose", purpose: "learning" }), { signal: signal() });
  assert.equal(learning.text, "propose");
});

test("an unscripted structured step returns a schema placeholder; an unscripted plain step uses the turn rule", async () => {
  const schema = { type: "object", required: ["label", "score"], properties: { label: { enum: ["yes", "no"] }, score: { type: "integer", minimum: 3 } } };
  const structured = await provider.generate(
    req({ turns: [{ text: "turn" }] }, { output: { name: "decision", schema } }, { step: "decide_1" }),
    { signal: signal() },
  );
  assert.deepEqual(structured.output, { label: "yes", score: 3 });
  const plain = await provider.generate(req({ turns: [{ text: "turn" }] }, {}, { step: "nothing" }), { signal: signal() });
  assert.equal(plain.text, "turn");
  assert.equal(plain.output, null, "output is null when no output was requested");
});

test("structured output comes from the turn's output, else its text parsed as JSON", async () => {
  const output = { name: "out", schema: { type: "object" } };
  const fromOutput = await provider.generate(req({ steps: { s: { output: { ok: true } } } }, { output }, { step: "s" }), { signal: signal() });
  assert.deepEqual(fromOutput.output, { ok: true });
  const fromText = await provider.generate(req({ steps: { s: { text: "{\"n\":2}" } } }, { output }, { step: "s" }), { signal: signal() });
  assert.deepEqual(fromText.output, { n: 2 });
  const notJson = await provider.generate(req({ steps: { s: { text: "nope" } } }, { output }, { step: "s" }), { signal: signal() });
  assert.equal(notJson.output, null);
});

test("{{last_result}} and {{first_message}} are substituted in text, args and output", async () => {
  const script: ScriptedScript = {
    turns: [{
      text: "got {{last_result}} for {{first_message}}",
      toolCalls: [{ name: "write_file", args: { path: "out.txt", content: "{{last_result}}", nested: ["{{first_message}}", 3] }, id: "fixed" }],
    }],
    steps: { s: { output: { echo: "{{first_message}}" } } },
  };
  const messages: ModelRequest["messages"] = [
    { role: "user", content: "task A" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", args: {} }] },
    { role: "tool", toolCallId: "c1", name: "read_file", content: "first", isError: false },
    { role: "tool", toolCallId: "c2", name: "read_file", content: "latest", isError: false },
  ];
  const reply = await provider.generate(req(script, { messages }), { signal: signal() });
  assert.equal(reply.text, "got latest for task A");
  assert.deepEqual(reply.toolCalls, [{ id: "fixed", name: "write_file", args: { path: "out.txt", content: "latest", nested: ["task A", 3] } }]);
  const structured = await provider.generate(req(script, { messages, output: { name: "o", schema: { type: "object" } } }, { step: "s" }), { signal: signal() });
  assert.deepEqual(structured.output, { echo: "task A" });
});

test("usage: given fields win, missing ones are estimated so shorter conversations cost less", async () => {
  const script: ScriptedScript = { turns: [{ text: "reply text" }], steps: { u: { text: "x", usage: { inputTokens: 7, cacheReadTokens: 2 } } } };
  const short = req(script);
  const long = req(script, { messages: [{ role: "user", content: "hello ".repeat(200) }] });
  const shortReply = await provider.generate(short, { signal: signal() });
  const longReply = await provider.generate(long, { signal: signal() });
  assert.equal(shortReply.usage.inputTokens, typicalTokens(short));
  assert.ok(shortReply.usage.inputTokens < longReply.usage.inputTokens);
  assert.equal(shortReply.usage.outputTokens, Math.ceil(Buffer.byteLength("reply text") / 4));
  assert.equal(shortReply.usage.cacheReadTokens, 0);
  const given = await provider.generate(req(script, {}, { step: "u" }), { signal: signal() });
  assert.deepEqual(given.usage, { inputTokens: 7, outputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 0 });
});

test("streaming delivers the text in the requested number of chunks", async () => {
  const deltas: string[] = [];
  const reply = await provider.generate(req({ turns: [{ text: "abcdefghij", chunks: 3 }] }), { signal: signal(), onDelta: (d) => deltas.push(d) });
  assert.equal(deltas.length, 3);
  assert.equal(deltas.join(""), reply.text);
  const single: string[] = [];
  await provider.generate(req({ turns: [{ text: "whole" }] }), { signal: signal(), onDelta: (d) => single.push(d) });
  assert.deepEqual(single, ["whole"]);
});

test("delayMs waits through the injected sleep and an abort rejects with aborted", async () => {
  const waits: number[] = [];
  const recorded = createScriptedProvider({ sleep: async (ms) => { waits.push(ms); } });
  await recorded.generate(req({ turns: [{ text: "slow", delayMs: 250 }] }), { signal: signal() });
  assert.deepEqual(waits, [250]);

  const controller = new AbortController();
  const pending = provider.generate(req({ turns: [{ text: "slow", delayMs: 10_000 }] }), { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, (error: unknown) => isRunwrightError(error) && error.code === "aborted");
});

test("failure injection by attempt: transient statuses, network errors and non-retryable statuses", async () => {
  const script: ScriptedScript = {
    turns: [{ text: "ok", fail: { attempts: 2, status: 429, retryAfterMs: 1500 } }],
    steps: {
      net: { text: "ok", fail: { attempts: 1, network: true } },
      bad: { text: "ok", fail: { attempts: 1, status: 400, message: "bad request" } },
    },
  };
  for (const attempt of [1, 2]) {
    await assert.rejects(provider.generate(req(script, {}, { attempt }), { signal: signal() }), (error: unknown) => {
      assert.ok(isRunwrightError(error));
      assert.equal(error.code, "model_transient");
      assert.deepEqual(error.details, { status: 429, retryAfterMs: 1500, billing: "none" });
      return true;
    });
  }
  assert.equal((await provider.generate(req(script, {}, { attempt: 3 }), { signal: signal() })).text, "ok");
  await assert.rejects(provider.generate(req(script, {}, { step: "net" }), { signal: signal() }), (error: unknown) => {
    assert.ok(isRunwrightError(error));
    assert.equal(error.code, "model_transient");
    assert.equal(error.message, "network error");
    assert.deepEqual(error.details, { status: null, retryAfterMs: null, billing: "none" });
    return true;
  });
  await assert.rejects(provider.generate(req(script, {}, { step: "bad" }), { signal: signal() }), (error: unknown) => {
    assert.ok(isRunwrightError(error));
    assert.equal(error.code, "model_failed");
    assert.equal(error.message, "bad request");
    assert.deepEqual(error.details, { status: 400, billing: "none" });
    return true;
  });
});

test("a scripted failure can simulate a reply that broke off after the provider started (billing unknown)", async () => {
  const script: ScriptedScript = {
    turns: [{ text: "ok", fail: { attempts: 1, network: true, billing: "unknown" } }],
    steps: { broken: { text: "ok", fail: { attempts: 1, status: 400, billing: "unknown", message: "cut" } } },
  };
  await assert.rejects(provider.generate(req(script, {}, { attempt: 1 }), { signal: signal() }), (error: unknown) => {
    assert.ok(isRunwrightError(error));
    assert.equal(error.code, "model_transient");
    assert.deepEqual(error.details, { status: null, retryAfterMs: null, billing: "unknown" });
    return true;
  });
  assert.equal((await provider.generate(req(script, {}, { attempt: 2 }), { signal: signal() })).text, "ok");
  await assert.rejects(provider.generate(req(script, {}, { step: "broken" }), { signal: signal() }), (error: unknown) => {
    assert.ok(isRunwrightError(error));
    assert.equal(error.code, "model_failed");
    assert.deepEqual(error.details, { status: 400, billing: "unknown" });
    return true;
  });
});

test("determinism: the same request gives the same reply", async () => {
  const script: ScriptedScript = { turns: [{ text: "x {{first_message}}", toolCalls: [{ name: "t", args: { a: "{{last_result}}" } }] }] };
  const a = await provider.generate(req(script), { signal: signal() });
  const b = await createScriptedProvider().generate(req(script), { signal: signal() });
  assert.deepEqual(a, b);
});

test("a structured turn with no output and non-JSON text is outputMissing; given outputs and JSON text are values", async () => {
  const structured = { output: { name: "out", schema: { type: ["array", "string", "null"] } } };
  const answer = async (turn: ScriptedScript["turns"]) => provider.generate(req({ turns: turn }, structured), { signal: signal() });

  for (const text of ["I cannot say", ""]) {
    const missing = await answer([{ text }]);
    assert.equal(missing.output, null, text);
    assert.equal(missing.outputMissing, true, text);
  }
  for (const output of [[1, 2], "x", null]) {
    const given = await answer([{ text: "not json", output }]);
    assert.deepEqual(given.output, output);
    assert.equal(Object.hasOwn(given, "outputMissing"), false, JSON.stringify(output));
  }
  const fromText = await answer([{ text: "[1,2]" }]);
  assert.deepEqual(fromText.output, [1, 2]);
  assert.equal(Object.hasOwn(fromText, "outputMissing"), false);
  const nullText = await answer([{ text: " null " }]);
  assert.equal(nullText.output, null);
  assert.equal(Object.hasOwn(nullText, "outputMissing"), false, "an answered null is not missing");

  const unstructured = await provider.generate(req({ turns: [{ text: "plain" }] }), { signal: signal() });
  assert.equal(Object.hasOwn(unstructured, "outputMissing"), false, "no output spec, no flag");
});

test("script numbers that are not finite and in range are bounded where the script is read", async () => {
  const slept: number[] = [];
  const recording = createScriptedProvider({ sleep: async (ms) => { slept.push(ms); } });
  const turn = {
    text: "abcdef",
    delayMs: Number.POSITIVE_INFINITY,
    chunks: Number.NaN,
    usage: { inputTokens: -5, outputTokens: Number.NaN, cacheReadTokens: Number.POSITIVE_INFINITY, cacheWriteTokens: 2.5 },
  };
  const pieces: string[] = [];
  const reply = await recording.generate(req({ turns: [turn] }), { signal: signal(), onDelta: (piece) => pieces.push(piece) });
  assert.deepEqual(slept, [2_147_483_647], "an endless delay is the longest timer");
  assert.deepEqual(pieces, ["abcdef"], "a NaN chunk count is one chunk, the text is not dropped");
  assert.equal(reply.usage.inputTokens, typicalTokens(req({ turns: [turn] })));
  assert.equal(reply.usage.outputTokens, Math.ceil(Buffer.byteLength("abcdef") / 4));
  assert.equal(reply.usage.cacheReadTokens, 0);
  assert.equal(reply.usage.cacheWriteTokens, 3);

  const negativeDelay = await recording.generate(req({ turns: [{ text: "x", delayMs: -1 }] }), { signal: signal() });
  assert.equal(negativeDelay.text, "x");
  assert.equal(slept.length, 1, "a negative delay does not sleep");

  const nanAttempts = { turns: [{ text: "ok", fail: { attempts: Number.NaN, status: 500 } }] };
  assert.equal((await provider.generate(req(nanAttempts), { signal: signal() })).text, "ok", "NaN attempts never fails");
  const always = { turns: [{ text: "ok", fail: { attempts: Number.POSITIVE_INFINITY, status: 400 } }] };
  await assert.rejects(provider.generate(req(always, {}, { attempt: 1000 }), { signal: signal() }), (error: unknown) => codeOf(error) === "model_failed");

  const odd = { turns: [{ text: "ok", fail: { attempts: 1, status: 1e9, retryAfterMs: -3 } }] };
  await assert.rejects(provider.generate(req(odd), { signal: signal() }), (error: unknown) => {
    assert.ok(isRunwrightError(error));
    assert.equal(error.code, "model_transient");
    assert.equal(error.details?.["status"], 500);
    assert.equal(error.details?.["retryAfterMs"], null);
    return true;
  });
});

test("a variant without when (or without a string when.contains) never matches and never throws", async () => {
  const script = {
    turns: [{ text: "default" }],
    variants: [{ turns: [{ text: "no when" }] }, { when: {}, turns: [{ text: "empty when" }] }, { when: { contains: 3 }, turns: [{ text: "number" }] }, null],
  } as unknown as ScriptedScript;
  const reply = await provider.generate(req(script, { messages: [{ role: "user", content: "3 hello" }] }), { signal: signal() });
  assert.equal(reply.text, "default");
});

test("(R14D-models-01 sweep) a scripted turn without counts is never free; only a count the script gives as 0 is 0", async () => {
  const script: ScriptedScript = {
    turns: [{ toolCalls: [{ name: "read_file", args: { path: "a.txt" } }] }],
    steps: { zero: { text: "said", usage: { inputTokens: 0, outputTokens: 0 } }, empty: { text: "" } },
  };
  const calls = await provider.generate(req(script), { signal: signal() });
  assert.ok(calls.usage.inputTokens > 0, "no input count: estimated from the request");
  assert.ok(calls.usage.outputTokens > 0, "a reply of tool calls only is not free output");
  const zero = await provider.generate(req(script, {}, { step: "zero" }), { signal: signal() });
  assert.deepEqual([zero.usage.inputTokens, zero.usage.outputTokens], [0, 0]);
  const empty = await provider.generate(req(script, {}, { step: "empty" }), { signal: signal() });
  assert.ok(empty.usage.inputTokens > 0);
});
