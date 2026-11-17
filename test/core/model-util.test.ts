import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FRAMING_ALLOWANCE_TOKENS, apiKeySecretName, modelKey, requestBytes, textTokens, typicalTokens, worstCaseInputTokens,
} from "../../src/models/util.ts";
import { canonicalJson } from "../../src/core/json.ts";

const request = {
  system: "You are terse.",
  messages: [{ role: "user" as const, content: "héllo" }],
  tools: [{ name: "read_file", description: "Read", parameters: { type: "object" } }],
  output: null,
};

test("modelKey joins provider and name", () => {
  assert.equal(modelKey({ provider: "scripted", name: "scripted-1" }), "scripted/scripted-1");
});

test("requestBytes counts UTF-8 bytes of the canonical request", () => {
  const expected = Buffer.byteLength(canonicalJson({ messages: request.messages, output: null, system: request.system, tools: request.tools }), "utf8");
  assert.equal(requestBytes(request), expected);
  assert.equal(typicalTokens(request), Math.ceil(expected / 4));
});

test("worstCaseInputTokens is one token per request byte plus the framing allowance", () => {
  assert.equal(FRAMING_ALLOWANCE_TOKENS, 1024);
  const bytes = requestBytes(request);
  assert.equal(worstCaseInputTokens(request), bytes + 1024);
  // A token is at least one byte, so no tokenizer can bill more input tokens than the request has bytes;
  // the allowance covers what a provider adds around the request.
  assert.ok(worstCaseInputTokens(request) >= bytes + FRAMING_ALLOWANCE_TOKENS);
  assert.ok(worstCaseInputTokens(request) > 4 * typicalTokens(request));
  const empty = { system: "", messages: [], tools: [], output: null };
  assert.equal(worstCaseInputTokens(empty), requestBytes(empty) + 1024);
  const multibyte = { system: "", messages: [{ role: "user" as const, content: "日本語".repeat(100) }], tools: [], output: null };
  assert.ok(worstCaseInputTokens(multibyte) >= "日本語".repeat(100).length * 3, "counts UTF-8 bytes, not characters");
});

test("textTokens rounds up bytes / 4", () => {
  assert.equal(textTokens(""), 0);
  assert.equal(textTokens("abcd"), 1);
  assert.equal(textTokens("abcde"), 2);
  assert.equal(textTokens("é"), 1);
});

test("apiKeySecretName defaults per provider", () => {
  assert.equal(apiKeySecretName({ provider: "anthropic", name: "m" }), "ANTHROPIC_API_KEY");
  assert.equal(apiKeySecretName({ provider: "openai-compatible", name: "m" }), "OPENAI_API_KEY");
  assert.equal(apiKeySecretName({ provider: "scripted", name: "m" }), null);
  assert.equal(apiKeySecretName({ provider: "openai-compatible", name: "m", apiKeySecret: "OPENROUTER_KEY" }), "OPENROUTER_KEY");
});
