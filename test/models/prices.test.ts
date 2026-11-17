import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_PRICES, PRICES_AS_OF, createPricing, formatCost, roundUpMicros } from "../../src/models/prices.ts";
import type { ModelPrice, Usage } from "../../src/models/types.ts";

const scripted = { provider: "scripted", name: "scripted-1" };
const usage = (u: Partial<Usage>): Usage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...u });

test("the scripted model has nominal prices and a dated table", () => {
  assert.deepEqual(BUILTIN_PRICES["scripted/scripted-1"], { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25 });
  assert.match(PRICES_AS_OF, /^\d{4}-\d{2}-\d{2}$/);
});

test("cost arithmetic: tokens x USD/MTok = micro-dollars, rounded up", () => {
  const pricing = createPricing();
  assert.equal(pricing.costMicros(scripted, usage({ inputTokens: 1000, outputTokens: 200 })), 2000);
  assert.equal(pricing.costMicros(scripted, usage({ inputTokens: 1_000_000 })), 1_000_000, "a million input tokens cost $1");
  assert.equal(pricing.costMicros(scripted, usage({ cacheReadTokens: 3 })), 1, "0.3 micro-dollars rounds up to 1");
  assert.equal(pricing.costMicros(scripted, usage({ cacheReadTokens: 10 })), 1, "exactly 1.0 stays 1 despite float noise");
  assert.equal(pricing.costMicros(scripted, usage({ cacheReadTokens: 3, inputTokens: 0, cacheWriteTokens: 0 })), 1);
  assert.equal(pricing.costMicros(scripted, usage({})), 0);
  assert.ok(Number.isInteger(pricing.costMicros(scripted, usage({ inputTokens: 7, outputTokens: 3, cacheReadTokens: 11, cacheWriteTokens: 13 }))));
});

test("cache prices apply, and fall back to the input price when absent", () => {
  const pricing = createPricing({ "anthropic/plain": { inputPerMTok: 2, outputPerMTok: 4 } });
  assert.equal(pricing.costMicros(scripted, usage({ cacheReadTokens: 1000, cacheWriteTokens: 1000 })), 100 + 1250);
  assert.equal(pricing.costMicros({ provider: "anthropic", name: "plain" }, usage({ cacheReadTokens: 1000, cacheWriteTokens: 500 })), 3000);
});

test("overrides win, exact keys beat wildcards, and the longest wildcard wins", () => {
  const pricing = createPricing({
    "scripted/scripted-1": { inputPerMTok: 2, outputPerMTok: 2 },
    "openai-compatible/gpt-*": { inputPerMTok: 9, outputPerMTok: 9 },
    "openai-compatible/gpt-9*": { inputPerMTok: 3, outputPerMTok: 3 },
    "openai-compatible/gpt-9-exact": { inputPerMTok: 1, outputPerMTok: 1 },
  });
  assert.equal(pricing.priceFor(scripted)?.inputPerMTok, 2);
  assert.equal(pricing.priceFor({ provider: "openai-compatible", name: "gpt-5-custom" })?.inputPerMTok, 9);
  assert.equal(pricing.priceFor({ provider: "openai-compatible", name: "gpt-9-mini" })?.inputPerMTok, 3);
  assert.equal(pricing.priceFor({ provider: "openai-compatible", name: "gpt-9-exact" })?.inputPerMTok, 1);
  assert.equal(pricing.priceFor({ provider: "openai-compatible", name: "llama" }), null);
  assert.equal(createPricing().priceFor(scripted)?.inputPerMTok, 1, "overrides belong to one pricing instance");
});

test("an unknown model has no price and its cost is null, never 0", () => {
  const pricing = createPricing();
  const unpriced = { provider: "scripted", name: "unpriced-1" };
  assert.equal(pricing.priceFor(unpriced), null);
  assert.equal(pricing.costMicros(unpriced, usage({ inputTokens: 10 })), null);
  assert.equal(pricing.costMicros(unpriced, usage({})), null);
  assert.equal(pricing.worstCaseMicros(unpriced, 10, 10), null);
});

test("worstCaseMicros prices input at max(input, cache read, cache write) plus all output", () => {
  const pricing = createPricing({ "anthropic/cheap-write": { inputPerMTok: 2, outputPerMTok: 10, cacheWritePerMTok: 1 } });
  assert.equal(pricing.worstCaseMicros(scripted, 1000, 100), 1250 + 500);
  assert.equal(pricing.worstCaseMicros({ provider: "anthropic", name: "cheap-write" }, 1000, 100), 2000 + 1000);
  assert.equal(pricing.worstCaseMicros(scripted, 1, 0), 2, "1.25 rounds up");
  const actual = pricing.costMicros(scripted, usage({ inputTokens: 400, cacheWriteTokens: 600, outputTokens: 100 }));
  assert.ok(actual !== null && actual <= (pricing.worstCaseMicros(scripted, 1000, 100) ?? 0));
});

test("worstCaseMicros uses the cache-read rate when it is the highest input-side rate", () => {
  const ref = { provider: "anthropic", name: "dear-read" };
  const pricing = createPricing({ "anthropic/dear-read": { inputPerMTok: 1, outputPerMTok: 1, cacheReadPerMTok: 100 } });
  assert.equal(pricing.worstCaseMicros(ref, 1000, 0), 100_000);
  assert.equal(pricing.costMicros(ref, usage({ cacheReadTokens: 1000 })), 100_000);
});

/** mulberry32: a small seeded generator, so every run checks the same cases. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("property: costMicros of any usage within (I, O) never exceeds worstCaseMicros(I, O)", () => {
  const random = seeded(0x5eed);
  const rate = (): number => Math.round(random() * 100 * 1000) / 1000;
  const upTo = (limit: number): number => Math.floor(random() * (limit + 1));
  for (let i = 0; i < 500; i++) {
    const price: ModelPrice = { inputPerMTok: rate(), outputPerMTok: rate() };
    if (random() < 0.5) price.cacheReadPerMTok = rate();
    if (random() < 0.5) price.cacheWritePerMTok = rate();
    const pricing = createPricing({ "anthropic/random": price });
    const ref = { provider: "anthropic", name: "random" };
    const inputBound = upTo(2_000_000);
    const outputBound = upTo(200_000);
    const inputTokens = upTo(inputBound);
    const cacheReadTokens = upTo(inputBound - inputTokens);
    const cacheWriteTokens = upTo(inputBound - inputTokens - cacheReadTokens);
    const spent = usage({ inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens: upTo(outputBound) });
    const cost = pricing.costMicros(ref, spent);
    const worst = pricing.worstCaseMicros(ref, inputBound, outputBound);
    assert.ok(cost !== null && worst !== null);
    assert.ok(cost <= worst, `case ${i}: ${JSON.stringify({ price, spent, inputBound, outputBound, cost, worst })}`);
  }
});

test("huge and malformed numbers never give a negative or NaN cost", () => {
  for (const value of [1e300, Number.MAX_VALUE, Infinity, Number.MAX_SAFE_INTEGER * 4]) {
    const rounded = roundUpMicros(value);
    assert.ok(Number.isInteger(rounded) && rounded >= 0 && rounded <= Number.MAX_SAFE_INTEGER, String(value));
  }
  assert.equal(roundUpMicros(-5), 0);
  assert.equal(roundUpMicros(Number.NaN), 0);
  const pricing = createPricing({ "anthropic/zero": { inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: 0 } });
  for (const bad of [Number.NaN, -1, -Infinity, Infinity, 1e308]) {
    for (const ref of [scripted, { provider: "anthropic", name: "zero" }]) {
      for (const field of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const) {
        const cost = pricing.costMicros(ref, usage({ [field]: bad }));
        assert.ok(cost !== null && Number.isInteger(cost) && cost >= 0, `${field}=${bad}: ${cost}`);
      }
      const worst = pricing.worstCaseMicros(ref, bad, bad);
      assert.ok(worst !== null && Number.isInteger(worst) && worst >= 0, `worst ${bad}: ${worst}`);
    }
  }
});

test("formatCost shows dollars, unknown, or a lower bound", () => {
  assert.equal(formatCost(12_300, false), "$0.0123");
  assert.equal(formatCost(0, false), "$0.0000");
  assert.equal(formatCost(1_500_000, false), "$1.5000");
  assert.equal(formatCost(0, true), "unknown");
  assert.equal(formatCost(12_300, true), ">= $0.0123");
});
