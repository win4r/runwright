import type { ModelPrice, Pricing, Usage } from "./types.ts";
import { modelKey } from "./util.ts";

/** Date of the published list prices below. Operators override or extend them with `config.models.prices`. */
export const PRICES_AS_OF = "2026-11-03";

function anthropic(input: number, output: number, cacheRead: number): ModelPrice {
  return Object.freeze({ inputPerMTok: input, outputPerMTok: output, cacheReadPerMTok: cacheRead, cacheWritePerMTok: input * 1.25 });
}

function openai(input: number, output: number, cachedInput: number): ModelPrice {
  return Object.freeze({ inputPerMTok: input, outputPerMTok: output, cacheReadPerMTok: cachedInput, cacheWritePerMTok: input });
}

/**
 * USD per million tokens, keyed `"<provider>/<name>"`. Anthropic cache writes are the 5-minute rate (1.25 x input);
 * OpenAI does not charge for cache writes, so they are priced as plain input. A key ending in `*` matches by prefix.
 */
export const BUILTIN_PRICES: Readonly<{ [modelKey: string]: ModelPrice }> = Object.freeze({
  "scripted/scripted-1": Object.freeze({ inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25 }),
  "anthropic/claude-fable-5-2": anthropic(8, 40, 0.2),
  "anthropic/claude-fable-5-1": anthropic(10, 50, 0.25),
  "anthropic/claude-fable-5": anthropic(10, 50, 1),
  "anthropic/claude-opus-5-5": anthropic(4, 20, 0.2),
  "anthropic/claude-opus-5": anthropic(5, 25, 0.5),
  "anthropic/claude-opus-4-8": anthropic(5, 25, 0.5),
  "anthropic/claude-opus-4-7": anthropic(5, 25, 0.5),
  "anthropic/claude-opus-4-6": anthropic(5, 25, 0.5),
  "anthropic/claude-sonnet-5-5": anthropic(2, 10, 0.1),
  "anthropic/claude-sonnet-5": anthropic(2, 10, 0.2),
  "anthropic/claude-sonnet-4-6": anthropic(3, 15, 0.3),
  "anthropic/claude-haiku-4-5": anthropic(1, 5, 0.1),
  "openai-compatible/gpt-4o": openai(2.5, 10, 1.25),
  "openai-compatible/gpt-4o-mini": openai(0.15, 0.6, 0.075),
  "openai-compatible/gpt-4.1": openai(2, 8, 0.5),
  "openai-compatible/gpt-4.1-mini": openai(0.4, 1.6, 0.1),
  "openai-compatible/gpt-4.1-nano": openai(0.1, 0.4, 0.025),
});

type PriceTable = Readonly<{ [modelKey: string]: ModelPrice }>;

function lookup(table: PriceTable, key: string): ModelPrice | null {
  if (Object.hasOwn(table, key)) return table[key] ?? null;
  let best: { length: number; price: ModelPrice } | null = null;
  for (const candidate of Object.keys(table)) {
    if (!candidate.endsWith("*")) continue;
    const prefix = candidate.slice(0, -1);
    if (!key.startsWith(prefix)) continue;
    const price = table[candidate];
    if (price !== undefined && (best === null || prefix.length > best.length)) best = { length: prefix.length, price };
  }
  return best?.price ?? null;
}

/**
 * A token count or a rate as a finite number >= 0: NaN and negative numbers are 0, Infinity and anything above
 * Number.MAX_SAFE_INTEGER is Number.MAX_SAFE_INTEGER. So no price or usage can make a cost negative or NaN.
 */
function amount(value: number): number {
  if (Number.isNaN(value) || value <= 0) return 0;
  return Math.min(value, Number.MAX_SAFE_INTEGER);
}

/**
 * Rounds up to whole micro-dollars, ignoring floating-point noise below a millionth of a micro-dollar. The result
 * is an integer from 0 to Number.MAX_SAFE_INTEGER (about 9 billion dollars), whatever the input.
 */
export function roundUpMicros(value: number): number {
  if (Number.isNaN(value) || value <= 0) return 0;
  const rounded = Math.ceil(Math.round(Math.min(value, Number.MAX_SAFE_INTEGER) * 1e6) / 1e6);
  return Math.min(rounded, Number.MAX_SAFE_INTEGER);
}

/** The highest of the three input-side rates (input, cache read, cache write): what any input token can cost. */
function worstInputRate(price: ModelPrice): number {
  const input = amount(price.inputPerMTok);
  return Math.max(input, amount(price.cacheReadPerMTok ?? input), amount(price.cacheWritePerMTok ?? input));
}

export function createPricing(overrides?: { [modelKey: string]: ModelPrice }): Pricing {
  const operator: PriceTable = Object.freeze({ ...(overrides ?? {}) });
  const priceFor = (ref: { provider: string; name: string }): ModelPrice | null => {
    const key = modelKey(ref);
    return lookup(operator, key) ?? lookup(BUILTIN_PRICES, key);
  };
  return {
    priceFor,
    costMicros(ref, usage: Usage): number | null {
      const price = priceFor(ref);
      if (price === null) return null;
      const input = amount(price.inputPerMTok);
      // Tokens x USD per million tokens = micro-dollars.
      const micros =
        amount(usage.inputTokens) * input +
        amount(usage.outputTokens) * amount(price.outputPerMTok) +
        amount(usage.cacheReadTokens) * amount(price.cacheReadPerMTok ?? input) +
        amount(usage.cacheWriteTokens) * amount(price.cacheWritePerMTok ?? input);
      return roundUpMicros(micros);
    },
    worstCaseMicros(ref, inputTokens: number, maxOutputTokens: number): number | null {
      const price = priceFor(ref);
      if (price === null) return null;
      return roundUpMicros(amount(inputTokens) * worstInputRate(price) + amount(maxOutputTokens) * amount(price.outputPerMTok));
    },
  };
}

/** "$0.0123" for a known cost; "unknown" when nothing is priced; ">= $x" when only part of the cost is known. */
export function formatCost(costMicros: number, unknown: boolean): string {
  const dollars = `$${(costMicros / 1e6).toFixed(4)}`;
  if (!unknown) return dollars;
  return costMicros === 0 ? "unknown" : `>= ${dollars}`;
}
