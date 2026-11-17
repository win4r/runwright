import { test } from "node:test";
import assert from "node:assert/strict";
import { isRunwrightError } from "../../src/core/errors.ts";
import { MAX_CACHED_PROVIDERS, createModelRegistry } from "../../src/models/registry.ts";
import type { ModelRef } from "../../src/models/types.ts";
import { fakeFetch, makeRequest, signal, sse } from "./fake-fetch.ts";

const retry = { maxAttempts: 3, baseMs: 1, maxMs: 2 };
const secretsOf = (values: Record<string, string>) => {
  const asked: string[][] = [];
  return {
    asked,
    reader: {
      async reveal(names: readonly string[]) {
        asked.push([...names]);
        const out: Record<string, string> = {};
        for (const name of names) if (Object.hasOwn(values, name)) out[name] = values[name] ?? "";
        return out;
      },
    },
  };
};
const codeOf = (error: unknown): string => (isRunwrightError(error) ? error.code : "not-runwright");

const anthropicStream = sse([
  { event: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 0 } } } },
  { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "from anthropic" } } },
  { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } } },
  { event: "message_stop", data: { type: "message_stop" } },
]);
const openaiStream = sse([{ data: { choices: [{ index: 0, delta: { content: "from openai" }, finish_reason: "stop" }] } }, { data: "[DONE]" }]);

test("scripted models resolve without secrets; providers make one request per call and the registry carries the retry runtime", async () => {
  const { reader, asked } = secretsOf({});
  const random = (): number => 0.25;
  const sleeps: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleeps.push(ms);
  };
  const registry = createModelRegistry({ secrets: reader, retry, random, sleep });
  assert.deepEqual(registry.retry?.policy, retry);
  assert.equal(registry.retry?.random, random);
  assert.equal(registry.retry?.sleep, sleep);

  const ref: ModelRef = { provider: "scripted", name: "scripted-1", script: { turns: [{ text: "recovered", fail: { attempts: 2, status: 503 } }] } };
  const provider = await registry.resolve(ref);
  for (const attempt of [1, 2]) {
    await assert.rejects(provider.generate(makeRequest(ref, { meta: { ...makeRequest(ref).meta, attempt } }), { signal: signal() }), (error: unknown) => {
      assert.ok(isRunwrightError(error));
      assert.equal(error.code, "model_transient", "the transient failure reaches the caller: the provider does not retry");
      assert.deepEqual(error.details, { status: 503, retryAfterMs: null, billing: "none" });
      return true;
    });
  }
  const third = await provider.generate(makeRequest(ref, { meta: { ...makeRequest(ref).meta, attempt: 3 } }), { signal: signal() });
  assert.equal(third.text, "recovered");
  assert.deepEqual(sleeps, [], "the registry never waits on its own");
  assert.equal(await registry.resolve({ provider: "scripted", name: "other" }), provider, "providers are cached");
  assert.deepEqual(asked, []);
});

test("an anthropic provider from the registry sends exactly one request when it fails", async () => {
  const fake = fakeFetch([{ status: 503, text: "busy" }]);
  const registry = createModelRegistry({ secrets: secretsOf({ ANTHROPIC_API_KEY: "sk-ant-one-shot" }).reader, retry, fetch: fake.fetch, sleep: async () => undefined });
  const ref: ModelRef = { provider: "anthropic", name: "claude-opus-4-8" };
  await assert.rejects((await registry.resolve(ref)).generate(makeRequest(ref), { signal: signal() }), (error: unknown) => codeOf(error) === "model_transient");
  assert.equal(fake.calls.length, 1);
});

test("anthropic resolves its key from secrets; a missing key is secret_missing naming the secret", async () => {
  const fake = fakeFetch([{ chunks: [anthropicStream] }]);
  const { reader, asked } = secretsOf({ ANTHROPIC_API_KEY: "sk-ant-registry-key-1" });
  const registry = createModelRegistry({ secrets: reader, retry, fetch: fake.fetch, random: () => 0, sleep: async () => undefined });
  const ref: ModelRef = { provider: "anthropic", name: "claude-opus-4-8" };
  const provider = await registry.resolve(ref);
  const reply = await provider.generate(makeRequest(ref), { signal: signal() });
  assert.equal(reply.text, "from anthropic");
  assert.equal(fake.calls[0]?.headers["x-api-key"], "sk-ant-registry-key-1");
  assert.deepEqual(asked, [["ANTHROPIC_API_KEY"]]);
  assert.equal(await registry.resolve(ref), provider, "same provider, base URL and key → cached");

  await assert.rejects(registry.resolve({ provider: "anthropic", name: "x", apiKeySecret: "TEAM_KEY" }), (error: unknown) => {
    assert.ok(isRunwrightError(error));
    assert.equal(error.code, "secret_missing");
    assert.match(error.message, /TEAM_KEY/);
    assert.deepEqual(error.details, { secret: "TEAM_KEY" });
    return true;
  });
});

test("openai-compatible: the default base URL needs a key; a custom one works without", async () => {
  const fake = fakeFetch([{ chunks: [openaiStream] }]);
  const { reader } = secretsOf({ OPENAI_API_KEY: "sk-openai-registry-key", LOCAL_KEY: "local-secret-value" });
  const registry = createModelRegistry({ secrets: reader, retry, fetch: fake.fetch });

  const local = await registry.resolve({ provider: "openai-compatible", name: "llama", baseUrl: "http://127.0.0.1:9/v1" });
  await local.generate(makeRequest({ provider: "openai-compatible", name: "llama" }), { signal: signal() });
  assert.equal(fake.calls[0]?.url, "http://127.0.0.1:9/v1/chat/completions");
  assert.equal(fake.calls[0]?.headers["authorization"], undefined, "the default OpenAI key is not sent to another server");

  const keyed = await registry.resolve({ provider: "openai-compatible", name: "llama", baseUrl: "http://127.0.0.1:9/v1", apiKeySecret: "LOCAL_KEY" });
  await keyed.generate(makeRequest({ provider: "openai-compatible", name: "llama" }), { signal: signal() });
  assert.equal(fake.calls[1]?.headers["authorization"], "Bearer local-secret-value");

  const official = await registry.resolve({ provider: "openai-compatible", name: "gpt-4.1" });
  await official.generate(makeRequest({ provider: "openai-compatible", name: "gpt-4.1" }), { signal: signal() });
  assert.equal(fake.calls[2]?.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(fake.calls[2]?.headers["authorization"], "Bearer sk-openai-registry-key");

  const empty = createModelRegistry({ secrets: secretsOf({}).reader, retry, fetch: fake.fetch });
  await assert.rejects(empty.resolve({ provider: "openai-compatible", name: "gpt-4.1" }), (error: unknown) => codeOf(error) === "secret_missing");
  await assert.rejects(empty.resolve({ provider: "openai-compatible", name: "m", baseUrl: "ftp://x" }), (error: unknown) => codeOf(error) === "validation_failed");
});

test("an unknown provider is model_unknown", async () => {
  const registry = createModelRegistry({ secrets: secretsOf({}).reader, retry });
  const ref = { provider: "mystery", name: "m" } as unknown as ModelRef;
  await assert.rejects(registry.resolve(ref), (error: unknown) => codeOf(error) === "model_unknown");
});

test("providers carry the credential they send, under the secret's name; scripted and keyless ones carry none", async () => {
  const { reader } = secretsOf({ ANTHROPIC_API_KEY: "anthropic-key-1", OPENAI_API_KEY: "openai-key-1", LOCAL_KEY: "local-key-1", TEAM_KEY: "team-key-1" });
  const registry = createModelRegistry({ secrets: reader, retry, fetch: fakeFetch([{ chunks: [openaiStream] }]).fetch });
  const credentialsOf = async (ref: ModelRef) => [...((await registry.resolve(ref)).credentials ?? [])];

  assert.deepEqual(await credentialsOf({ provider: "anthropic", name: "claude" }), [{ name: "ANTHROPIC_API_KEY", value: "anthropic-key-1" }]);
  assert.deepEqual(await credentialsOf({ provider: "anthropic", name: "claude", apiKeySecret: "TEAM_KEY" }), [{ name: "TEAM_KEY", value: "team-key-1" }]);
  assert.deepEqual(await credentialsOf({ provider: "openai-compatible", name: "gpt" }), [{ name: "OPENAI_API_KEY", value: "openai-key-1" }]);
  assert.deepEqual(
    await credentialsOf({ provider: "openai-compatible", name: "llama", baseUrl: "http://127.0.0.1:9/v1", apiKeySecret: "LOCAL_KEY" }),
    [{ name: "LOCAL_KEY", value: "local-key-1" }],
  );
  assert.deepEqual(await credentialsOf({ provider: "openai-compatible", name: "llama", baseUrl: "http://127.0.0.1:9/v1" }), []);
  assert.deepEqual(await credentialsOf({ provider: "scripted", name: "s" }), []);

  const provider = await registry.resolve({ provider: "openai-compatible", name: "gpt" });
  assert.equal(Object.isFrozen(provider.credentials), true);
  assert.equal(Object.isFrozen(provider.credentials?.[0]), true);
});

test("two secret names holding the same key give providers whose credential names their own secret", async () => {
  const { reader } = secretsOf({ TEAM_A: "same-key-value", TEAM_B: "same-key-value" });
  const registry = createModelRegistry({ secrets: reader, retry });
  const a = await registry.resolve({ provider: "anthropic", name: "m", apiKeySecret: "TEAM_A" });
  const b = await registry.resolve({ provider: "anthropic", name: "m", apiKeySecret: "TEAM_B" });
  assert.deepEqual(a.credentials, [{ name: "TEAM_A", value: "same-key-value" }]);
  assert.deepEqual(b.credentials, [{ name: "TEAM_B", value: "same-key-value" }]);
});

test("a rotated key gives a provider whose credential is the new value, and that provider sends it", async () => {
  const values: Record<string, string> = { OPENAI_API_KEY: "old-openai-key", ANTHROPIC_API_KEY: "old-anthropic-key" };
  const ff = fakeFetch([{ chunks: [openaiStream] }]);
  const registry = createModelRegistry({ secrets: secretsOf(values).reader, retry, fetch: ff.fetch });
  const gpt = { provider: "openai-compatible", name: "gpt" } as const;
  const before = await registry.resolve(gpt);
  assert.deepEqual(before.credentials, [{ name: "OPENAI_API_KEY", value: "old-openai-key" }]);
  assert.equal(await registry.resolve(gpt), before, "the same key gives the cached provider");
  values["OPENAI_API_KEY"] = "new-openai-key";
  values["ANTHROPIC_API_KEY"] = "new-anthropic-key";
  const after = await registry.resolve(gpt);
  assert.notEqual(after, before);
  assert.deepEqual(after.credentials, [{ name: "OPENAI_API_KEY", value: "new-openai-key" }]);
  await after.generate(makeRequest(gpt), { signal: signal() });
  assert.equal(ff.calls[0]?.headers["authorization"], "Bearer new-openai-key");
  assert.deepEqual((await registry.resolve({ provider: "anthropic", name: "c" })).credentials, [{ name: "ANTHROPIC_API_KEY", value: "new-anthropic-key" }]);
});

test("the provider cache keeps at most MAX_CACHED_PROVIDERS entries, dropping the oldest", async () => {
  const { reader } = secretsOf({});
  const registry = createModelRegistry({ secrets: reader, retry });
  const ref = (i: number): ModelRef => ({ provider: "openai-compatible", name: "m", baseUrl: `http://localhost:${1000 + i}/v1` });
  const first = await registry.resolve(ref(0));
  assert.equal(await registry.resolve(ref(0)), first, "a cached provider is reused");
  for (let i = 1; i <= MAX_CACHED_PROVIDERS; i++) await registry.resolve(ref(i));
  const newest = await registry.resolve(ref(MAX_CACHED_PROVIDERS));
  assert.equal(await registry.resolve(ref(MAX_CACHED_PROVIDERS)), newest);
  assert.notEqual(await registry.resolve(ref(0)), first, "the oldest entry was dropped and is made again");
});
