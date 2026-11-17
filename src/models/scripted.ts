import { MAX_TIMER_MS, delay } from "../core/clock.ts";
import { RunwrightError } from "../core/errors.ts";
import { canonicalJson, isJsonObject, type Json, type JsonObject } from "../core/json.ts";
import { placeholderFor } from "../schema/placeholder.ts";
import { readOutputText } from "./output-transport.ts";
import { isRetryableStatus } from "./retry.ts";
import type {
  GenerateOptions, Message, ModelProvider, ModelRequest, ModelResponse, ScriptedScript, ScriptedTurn,
  ScriptedVariant, ToolCall, Usage,
} from "./types.ts";
import { textTokens, typicalTokens } from "./util.ts";

const FINISHED_TEXT = "(script finished)";

function abortedError(signal: AbortSignal): RunwrightError {
  return new RunwrightError("aborted", "the model call was aborted", { cause: signal.reason });
}

/**
 * Whether a variant applies to `request`. Revisions stored by older versions are not validated again, so a
 * variant without a `when` object or a string `when.contains` never matches (it is never an error).
 */
function variantMatches(variant: ScriptedVariant, request: ModelRequest): boolean {
  const when: unknown = (variant as { when?: unknown } | null)?.when;
  if (!isJsonObject(when)) return false;
  const needle = when["contains"];
  if (typeof needle !== "string") return false;
  const where = when["in"] ?? "any";
  const inSystem = request.system.includes(needle);
  if (where === "system") return inSystem;
  const inMessages = request.messages.some((message) => message.content.includes(needle));
  return where === "messages" ? inMessages : inSystem || inMessages;
}

function pickFromEntry(entry: ScriptedTurn | ScriptedTurn[] | undefined, turn: number): ScriptedTurn | null {
  if (entry === undefined) return null;
  if (!Array.isArray(entry)) return entry;
  if (entry.length === 0) return null;
  const index = Math.min(Math.max(turn - 1, 0), entry.length - 1);
  return entry[index] ?? null;
}

function stepEntry(script: ScriptedScript, variants: ScriptedVariant[], step: string, turn: number): ScriptedTurn | null {
  for (const variant of variants) {
    if (variant.steps !== undefined && Object.hasOwn(variant.steps, step)) {
      const picked = pickFromEntry(variant.steps[step], turn);
      if (picked !== null) return picked;
    }
  }
  if (script.steps !== undefined && Object.hasOwn(script.steps, step)) return pickFromEntry(script.steps[step], turn);
  return null;
}

function turnEntry(script: ScriptedScript, variants: ScriptedVariant[], turn: number): ScriptedTurn {
  const list = variants.find((variant) => variant.turns !== undefined)?.turns ?? script.turns ?? [];
  return (turn >= 1 ? list[turn - 1] : undefined) ?? { text: FINISHED_TEXT };
}

/** Picks the scripted turn: a step entry, else a schema placeholder for a structured step, else the turn rule. */
function selectTurn(request: ModelRequest): ScriptedTurn {
  const script = request.model.script ?? {};
  const variants = (script.variants ?? []).filter((variant) => variantMatches(variant, request));
  const { step, turn } = request.meta;
  if (step !== null) {
    const entry = stepEntry(script, variants, step, turn);
    if (entry !== null) return entry;
    if (request.output !== null) return { output: placeholderFor(request.output.schema) };
  }
  return turnEntry(script, variants, turn);
}

interface Substitutions { lastResult: string; firstMessage: string }

function substitutions(messages: Message[]): Substitutions {
  let lastResult = "";
  for (const message of messages) if (message.role === "tool") lastResult = message.content;
  const first = messages.find((message) => message.role === "user");
  return { lastResult, firstMessage: first?.content ?? "" };
}

function substituteText(text: string, subs: Substitutions): string {
  return text.replaceAll("{{last_result}}", subs.lastResult).replaceAll("{{first_message}}", subs.firstMessage);
}

function substituteJson(value: Json, subs: Substitutions): Json {
  if (typeof value === "string") return substituteText(value, subs);
  if (Array.isArray(value)) return value.map((item) => substituteJson(item, subs));
  if (isJsonObject(value)) {
    const out: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      Object.defineProperty(out, key, { value: substituteJson(item, subs), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return value;
}

/*
 * Scripts are JSON read without a deep check, so every number in one is bounded where it is read: a value that is
 * not a finite number in range is treated as absent (or, for a count, as its smallest sensible value).
 */

/** A finite number >= 0, or null. */
function nonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** `fail.attempts`: a number > 0 (Infinity: every attempt fails); anything else is 0, so the failure is never applied. */
function failingAttempts(value: unknown): number {
  return typeof value === "number" && value > 0 ? value : 0;
}

/** `fail.status` as an HTTP status: an integer from 100 to 599, else 500. */
function failureStatus(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : 500;
}

/** `delayMs`: a number > 0 is waited, at most the longest timer (Infinity included); anything else is no delay. */
function scriptedDelayMs(value: unknown): number {
  return typeof value === "number" && value > 0 ? Math.min(value, MAX_TIMER_MS) : 0;
}

/** `chunks`: an integer >= 1 (rounded down); anything else is one chunk. */
function chunkCount(value: unknown): number {
  const count = nonNegative(value);
  return count === null || count < 1 ? 1 : Math.floor(count);
}

/** A scripted token count: a finite number >= 0 (rounded up), else `fallback`. */
function tokenCount(value: unknown, fallback: number): number {
  const count = nonNegative(value);
  return count === null ? fallback : Math.ceil(count);
}

function failIfScripted(turn: ScriptedTurn, attempt: number): void {
  const fail = turn.fail;
  if (fail === undefined || attempt > failingAttempts(fail.attempts)) return;
  const retryAfterMs = nonNegative(fail.retryAfterMs);
  const billing = fail.billing === "unknown" ? "unknown" : "none";
  if (fail.network === true) {
    throw new RunwrightError("model_transient", fail.message ?? "network error", { details: { status: null, retryAfterMs, billing } });
  }
  const status = failureStatus(fail.status);
  const message = fail.message ?? `scripted failure (status ${status})`;
  if (isRetryableStatus(status)) {
    throw new RunwrightError("model_transient", message, { details: { status, retryAfterMs, billing } });
  }
  throw new RunwrightError("model_failed", message, { details: { status, billing } });
}

function splitIntoChunks(text: string, chunks: number): string[] {
  const chars = Array.from(text);
  const count = Math.max(1, Math.min(Math.floor(chunks), chars.length));
  const size = Math.ceil(chars.length / count);
  const pieces: string[] = [];
  for (let i = 0; i < chars.length; i += size) pieces.push(chars.slice(i, i + size).join(""));
  return pieces;
}

/**
 * The deterministic offline model. Stateless: every reply is a function of the request alone (script, step,
 * turn, attempt and conversation), so a resumed run gets the same answers it would have got before a crash.
 */
export function createScriptedProvider(deps?: { sleep?: (ms: number, signal: AbortSignal) => Promise<void> }): ModelProvider {
  const sleep = deps?.sleep ?? delay;
  return {
    async generate(request: ModelRequest, options: GenerateOptions): Promise<ModelResponse> {
      if (options.signal.aborted) throw abortedError(options.signal);
      const turn = selectTurn(request);
      failIfScripted(turn, request.meta.attempt);
      const delayMs = scriptedDelayMs(turn.delayMs);
      if (delayMs > 0) {
        try {
          await sleep(delayMs, options.signal);
        } catch (error) {
          if (options.signal.aborted) throw abortedError(options.signal);
          throw error;
        }
      }
      if (options.signal.aborted) throw abortedError(options.signal);

      const subs = substitutions(request.messages);
      const text = substituteText(turn.text ?? "", subs);
      const toolCalls: ToolCall[] = (turn.toolCalls ?? []).map((call, index) => ({
        id: call.id ?? `call_${request.meta.key}_${index}`,
        name: call.name,
        args: substituteJson(call.args, subs) as JsonObject,
      }));
      let output: Json = null;
      let outputMissing = false;
      if (request.output !== null) {
        if (turn.output !== undefined) {
          output = substituteJson(turn.output, subs);
        } else {
          const reading = readOutputText(text);
          if (reading.kind === "value") output = reading.value;
          else outputMissing = true;
        }
      }

      if (options.onDelta !== undefined && text !== "") {
        for (const piece of splitIntoChunks(text, chunkCount(turn.chunks))) options.onDelta(piece);
      }

      const replyShape =
        text +
        (toolCalls.length > 0 ? canonicalJson(toolCalls as unknown as Json) : "") +
        (output !== null ? canonicalJson(output) : "");
      const given = turn.usage ?? {};
      const usage: Usage = {
        inputTokens: tokenCount(given.inputTokens, typicalTokens(request)),
        outputTokens: tokenCount(given.outputTokens, textTokens(replyShape)),
        cacheReadTokens: tokenCount(given.cacheReadTokens, 0),
        cacheWriteTokens: tokenCount(given.cacheWriteTokens, 0),
      };
      const response: ModelResponse = { text, toolCalls, output, stopReason: toolCalls.length > 0 ? "tool_use" : "end", usage };
      if (outputMissing) response.outputMissing = true;
      return response;
    },
  };
}
