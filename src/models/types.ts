import type { Json, JsonObject } from "../core/json.ts";
import type { JsonSchema } from "../schema/validate.ts";
import type { ModelPurpose } from "../store/types.ts";

export type { ModelPurpose };

export type ModelProviderName = "scripted" | "anthropic" | "openai-compatible";
export interface ModelRef { provider: ModelProviderName; name: string; baseUrl?: string; apiKeySecret?: string;
  maxOutputTokens?: number; contextTokens?: number; script?: ScriptedScript }
export interface ToolCall { id: string; name: string; args: JsonObject }
export type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string; isError: boolean };
export interface ToolSpec { name: string; description: string; parameters: JsonSchema }
export interface StructuredOutputSpec { name: string; description?: string; schema: JsonSchema }
export interface ModelRequestMeta { runId: string; key: string; purpose: ModelPurpose; turn: number; step: string | null; attempt: number }
export interface ModelRequest { model: ModelRef; system: string; messages: Message[]; tools: ToolSpec[];
  output: StructuredOutputSpec | null; maxOutputTokens: number; meta: ModelRequestMeta }
/** inputTokens excludes cache reads and cache writes. */
export interface Usage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
export type StopReason = "end" | "tool_use" | "max_tokens" | "other";
/** A token count a provider reply did not report. */
export type UsageCount = "input" | "output";
/** output is null unless request.output was set. */
export interface ModelResponse { text: string; toolCalls: ToolCall[]; output: Json; stopReason: StopReason; usage: Usage;
  /**
   * True when request.output was set and the reply carried no output at all: the output tool was not called (or,
   * for a wrapped schema, was called with an object that has no "value") and the text is not JSON. `output` is
   * then null, and that null is not an answer. Absent or false in every other case.
   */
  outputMissing?: boolean;
  /**
   * The counts the provider did not report. Absent or empty: `usage` is what the provider reported. A named count
   * is 0 in `usage` (for "input": inputTokens, cacheReadTokens and cacheWriteTokens are all 0) and the engine
   * charges the request's worst case for it.
   */
  usageMissing?: readonly UsageCount[] }
/**
 * Whether a failed provider attempt may have been billed.
 * "none": the provider answered with an HTTP error status, or the request never left this machine.
 * "unknown": anything else (a connection that broke after the request was sent, a truncated or malformed reply).
 */
export type AttemptBilling = "none" | "unknown";

/** How the engine retries transient provider failures. */
export interface ModelRetry {
  /** `maxRetryAfterMs` absent: DEFAULT_MAX_RETRY_AFTER_MS (`src/models/retry.ts`). */
  policy: { maxAttempts: number; baseMs: number; maxMs: number; maxRetryAfterMs?: number };
  random: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** What one provider request gets. A provider never retries: the engine owns the attempt loop. */
export interface GenerateOptions { signal: AbortSignal; onDelta?: (text: string) => void }

/** A secret value a provider sends with its requests, under the name of the secret it came from. */
export interface ModelCredential { name: string; value: string }

/**
 * One call = one provider request. Throws RunwrightError "model_transient" (the engine may try again),
 * "model_failed" or "aborted". Every "model_transient" and "model_failed" error carries
 * `details.billing: AttemptBilling`.
 */
export interface ModelProvider {
  generate(request: ModelRequest, options: GenerateOptions): Promise<ModelResponse>;
  /** The credentials this provider object sends. Absent or empty: it sends none. */
  readonly credentials?: readonly ModelCredential[];
}

/** `resolve` throws model_unknown | secret_missing. */
export interface ModelRegistry {
  resolve(ref: ModelRef): Promise<ModelProvider>;
  /** Absent: one attempt, no retry. */
  readonly retry?: ModelRetry;
}

/** USD per million tokens. */
export interface ModelPrice { inputPerMTok: number; outputPerMTok: number; cacheReadPerMTok?: number; cacheWritePerMTok?: number }
export interface Pricing {
  priceFor(ref: { provider: string; name: string }): ModelPrice | null;
  /** Integer micro-dollars, rounded up; null = unknown. */
  costMicros(ref: { provider: string; name: string }, usage: Usage): number | null;
  /**
   * inputTokens priced at the highest input-side rate, max(input, cacheRead, cacheWrite) (an absent cache rate is the
   * input rate), plus maxOutputTokens at the output price, rounded up: never less than costMicros of any usage whose
   * input, cache-read and cache-write tokens sum to at most inputTokens and whose output is at most maxOutputTokens.
   */
  worstCaseMicros(ref: { provider: string; name: string }, inputTokens: number, maxOutputTokens: number): number | null;
}

export interface ScriptedFailure {
  attempts: number; status?: number; network?: boolean; retryAfterMs?: number; message?: string;
  /** Default "none". "unknown" simulates a reply that broke off after the provider had started to generate. */
  billing?: AttemptBilling;
}
export interface ScriptedTurn { text?: string; toolCalls?: { name: string; args: JsonObject; id?: string }[]; output?: Json;
  usage?: Partial<Usage>; delayMs?: number; fail?: ScriptedFailure; chunks?: number }
export interface ScriptedVariant { when: { contains: string; in?: "system" | "messages" | "any" }; turns?: ScriptedTurn[];
  steps?: Record<string, ScriptedTurn | ScriptedTurn[]> }
export interface ScriptedScript { turns?: ScriptedTurn[]; variants?: ScriptedVariant[]; steps?: Record<string, ScriptedTurn | ScriptedTurn[]> }
