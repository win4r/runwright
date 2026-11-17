import { canonicalJson, isJsonObject, type Json, type JsonObject } from "../core/json.ts";
import { outputToolDescription, outputToolSchema, structuredResult, type OutputArgs, type StructuredResult } from "./output-transport.ts";
import {
  classifyEnvelope, envelopeError, isJsonResponse, parseJsonText, parseToolArgs, postToProvider, providerErrorMessage,
  MAX_REPLY_BYTES, readJsonBody, readSse, replyFailure, replyIndex, tokenField, truncatedStreamError,
} from "./sse-parse.ts";
import type { GenerateOptions, Message, ModelProvider, ModelRequest, ModelResponse, StopReason, ToolCall, Usage, UsageCount } from "./types.ts";

const PROVIDER = "openai-compatible";

/** Provider-neutral messages → Chat Completions messages (system first, tool results as `role: "tool"`). */
function toOpenAiMessages(system: string, messages: Message[]): JsonObject[] {
  const out: JsonObject[] = [];
  if (system !== "") out.push({ role: "system", content: system });
  for (const message of messages) {
    if (message.role === "user") {
      out.push({ role: "user", content: message.content });
    } else if (message.role === "assistant") {
      const entry: JsonObject = { role: "assistant", content: message.content === "" && message.toolCalls.length > 0 ? null : message.content };
      if (message.toolCalls.length > 0) {
        entry["tool_calls"] = message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        }));
      }
      out.push(entry);
    } else {
      out.push({ role: "tool", tool_call_id: message.toolCallId, content: message.isError ? `[error] ${message.content}` : message.content });
    }
  }
  return out;
}

function buildOpenAiBody(request: ModelRequest): JsonObject {
  const tools: JsonObject[] = request.tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
  const body: JsonObject = { model: request.model.name, messages: toOpenAiMessages(request.system, request.messages) };
  if (request.output !== null) {
    const spec = request.output;
    tools.push({
      type: "function",
      function: {
        name: spec.name,
        description: outputToolDescription(spec, "Return the result as the arguments of this function."),
        parameters: outputToolSchema(spec.schema),
      },
    });
    body["tool_choice"] = { type: "function", function: { name: spec.name } };
  }
  if (tools.length > 0) body["tools"] = tools;
  body["max_tokens"] = request.maxOutputTokens;
  body["stream"] = true;
  body["stream_options"] = { include_usage: true };
  return body;
}

function mapFinishReason(reason: string): StopReason {
  switch (reason) {
    case "stop":
      return "end";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    default:
      return "other";
  }
}

interface PartialCall { id: string; name: string; args: string }

/** What one usage report gave: the counts it reported, and the ones it did not, named. */
interface ReportedUsage { usage: Usage; missing: UsageCount[] }

/**
 * Rule U for both HTTP adapters: an adapter returns exactly the counts the provider reported and names every count
 * it did not get in `ModelResponse.usageMissing`; it never computes a substitute. Every reply path and count:
 *
 * | path                       | input                     | output                     | cache read                 | cache write                |
 * |----------------------------|---------------------------|----------------------------|----------------------------|----------------------------|
 * | OpenAI-compatible stream   | reported (`prompt_tokens` | reported (`completion_     | reported (`cached_tokens`  | reported 0 (the API has    |
 * |                            | of the last chunk giving  | tokens` of the last chunk  | beside that `prompt_       | no such count) when input  |
 * |                            | it), else named           | giving it), else named     | tokens`, absent = 0), else | is reported, else 0 under  |
 * |                            | in usageMissing           | in usageMissing            | 0 under "input"            | "input"                    |
 * | OpenAI-compatible JSON     | the same, from the        | the same, from the         | the same                   | the same                   |
 * |                            | completion's `usage`      | completion's `usage`       |                            |                            |
 * | Anthropic stream           | reported (`input_tokens`  | reported (`output_tokens`  | reported (`cache_read_     | reported (`cache_creation_ |
 * |                            | in message_start, a later | in a message_delta), else  | input_tokens`, omitted = 0 | input_tokens`, omitted = 0 |
 * |                            | message_delta's wins),    | reply failure with billing | as input is reported)      | as input is reported)      |
 * |                            | else reply failure with   | unknown; message_start     |                            |                            |
 * |                            | billing unknown           | must carry an early        |                            |                            |
 * |                            |                           | `output_tokens` too, else  |                            |                            |
 * |                            |                           | the same reply failure     |                            |                            |
 * | Anthropic JSON             | reported (`input_tokens`),| reported (`output_tokens`),| reported (omitted = 0 as   | reported (omitted = 0 as   |
 * |                            | else reply failure with   | else reply failure with    | input is reported)         | input is reported)         |
 * |                            | billing unknown           | billing unknown            |                            |                            |
 *
 * So no count is ever 0 without being named or reported, and none is estimated. A count that is present but not a
 * whole number >= 0 is a reply failure on every path (`tokenField`).
 *
 * For one OpenAI-compatible report: `prompt_tokens` present → the input side, with cached tokens split out (at most
 * the prompt); absent → inputTokens, cacheReadTokens and cacheWriteTokens all 0 and "input" missing (a
 * `cached_tokens` without `prompt_tokens` is ignored). `completion_tokens` absent → outputTokens 0 and "output"
 * missing. A `usage` that is absent, null or not an object reports nothing: both are missing.
 */
function usageFrom(raw: unknown): ReportedUsage {
  const prompt = tokenField(raw, "prompt_tokens", PROVIDER);
  const completion = tokenField(raw, "completion_tokens", PROVIDER);
  const details = isJsonObject(raw) ? raw["prompt_tokens_details"] : undefined;
  const cached = tokenField(details, "cached_tokens", PROVIDER) ?? 0;
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const missing: UsageCount[] = [];
  if (prompt === null) {
    missing.push("input");
  } else {
    usage.cacheReadTokens = Math.min(cached, prompt);
    usage.inputTokens = prompt - usage.cacheReadTokens;
  }
  if (completion === null) missing.push("output");
  else usage.outputTokens = completion;
  return { usage, missing };
}

/**
 * Folds a stream chunk's report into what earlier chunks reported: the last chunk that reports a count wins for
 * that count (the input side, cached tokens included, is one count), so a later chunk with only one count does not
 * erase the other.
 */
function mergeUsage(before: ReportedUsage, next: ReportedUsage): ReportedUsage {
  const input = next.missing.includes("input") ? before : next;
  const output = next.missing.includes("output") ? before : next;
  const missing: UsageCount[] = [];
  if (input.missing.includes("input")) missing.push("input");
  if (output.missing.includes("output")) missing.push("output");
  return {
    usage: {
      inputTokens: input.usage.inputTokens,
      outputTokens: output.usage.outputTokens,
      cacheReadTokens: input.usage.cacheReadTokens,
      cacheWriteTokens: input.usage.cacheWriteTokens,
    },
    missing,
  };
}

/**
 * One reading for streamed and plain-JSON replies alike: the first output-tool call decides the output. A call
 * whose function name is still empty when the reply finished is a reply failure.
 */
function finish(request: ModelRequest, text: string, calls: PartialCall[], finishReason: string, reported: ReportedUsage): ModelResponse {
  if (calls.some((call) => call.name === "")) throw replyFailure(`${PROVIDER} returned a tool call without a function name`);
  const toolCalls: ToolCall[] = [];
  let outputCall: OutputArgs | null = null;
  for (const [index, call] of calls.entries()) {
    if (request.output !== null && call.name === request.output.name && outputCall === null) {
      outputCall = { text: call.args };
    } else {
      const args = parseToolArgs(call.args, PROVIDER, call.name);
      toolCalls.push({ id: call.id !== "" ? call.id : `call_${request.meta.key}_${index}`, name: call.name, args });
    }
  }
  const structured: StructuredResult = request.output === null ? { output: null } : structuredResult(request.output, PROVIDER, outputCall, text);
  let stop = mapFinishReason(finishReason);
  if (stop === "tool_use" && toolCalls.length === 0 && outputCall !== null) stop = "end";
  const reply: ModelResponse = { text, toolCalls, ...structured, stopReason: stop, usage: reported.usage };
  if (reported.missing.length > 0) reply.usageMissing = reported.missing;
  return reply;
}

/** One tool-call fragment after its shape was checked. `args` is the raw `function.arguments` (any JSON, or undefined). */
interface ToolCallPart { raw: JsonObject; id: string | null; name: string | null; args: Json | undefined }

/** The checked part of a choice: its `delta` (stream) or `message` (JSON). */
interface ChoicePart { content: string | null; toolCalls: ToolCallPart[] }

/** True when `value` is absent: undefined or null. */
function isAbsent(value: unknown): value is undefined | null {
  return value === undefined || value === null;
}

/**
 * Checks the fields of a delta or message that are read: `content` a string or null (absent is fine);
 * `tool_calls`, when present and not null, an array of objects whose `id` is a string when present and not null,
 * and whose `function` is an object when present and not null, with `name` a string when present and not null.
 * `function.arguments` may be any JSON value (some local servers send it parsed), and other fields are ignored.
 */
function readChoicePart(part: JsonObject): ChoicePart {
  const content = part["content"];
  if (!isAbsent(content) && typeof content !== "string") throw replyFailure(`${PROVIDER}: "content" is not a string or null`);
  const rawCalls = part["tool_calls"];
  const toolCalls: ToolCallPart[] = [];
  if (!isAbsent(rawCalls)) {
    if (!Array.isArray(rawCalls) || !rawCalls.every(isJsonObject)) throw replyFailure(`${PROVIDER}: "tool_calls" is not an array of objects`);
    for (const raw of rawCalls) {
      const id = raw["id"];
      if (!isAbsent(id) && typeof id !== "string") throw replyFailure(`${PROVIDER}: a tool call "id" is not a string`);
      const fn = raw["function"];
      if (!isAbsent(fn) && !isJsonObject(fn)) throw replyFailure(`${PROVIDER}: a tool call "function" is not an object`);
      const name = isJsonObject(fn) ? fn["name"] : undefined;
      if (!isAbsent(name) && typeof name !== "string") throw replyFailure(`${PROVIDER}: a tool call function "name" is not a string`);
      toolCalls.push({ raw, id: id ?? null, name: name ?? null, args: isJsonObject(fn) ? fn["arguments"] : undefined });
    }
  }
  return { content: content ?? null, toolCalls };
}

/** Merges checked tool-call fragments by their `index` (the next position when they give none). */
function mergeToolCalls(calls: PartialCall[], parts: ToolCallPart[]): void {
  for (const part of parts) {
    const index = replyIndex(part.raw, calls.length, PROVIDER);
    const call = calls[index] ?? { id: "", name: "", args: "" };
    calls[index] = call;
    if (part.id !== null && part.id !== "") call.id = part.id;
    if (part.name !== null) call.name += part.name;
    if (typeof part.args === "string") call.args += part.args;
    else if (!isAbsent(part.args)) call.args += canonicalJson(part.args);
  }
}

/**
 * The first choice of a reply: null when `choices` is absent, null or empty (a usage-only chunk). `choices` that is
 * not an array, or a first element that is not an object, is a reply failure.
 */
function firstChoice(body: JsonObject): JsonObject | null {
  const choices = body["choices"];
  if (isAbsent(choices)) return null;
  if (!Array.isArray(choices)) throw replyFailure(`${PROVIDER}: "choices" is not an array`);
  if (choices.length === 0) return null;
  const first = choices[0];
  if (!isJsonObject(first)) throw replyFailure(`${PROVIDER}: the first choice is not an object`);
  return first;
}

/** A choice's `finish_reason`: null when absent or null; anything else must be a non-empty string. */
function finishReasonOf(choice: JsonObject): string | null {
  const reason = choice["finish_reason"];
  if (isAbsent(reason)) return null;
  if (typeof reason !== "string" || reason === "") throw replyFailure(`${PROVIDER}: "finish_reason" is not a non-empty string`);
  return reason;
}

/**
 * Chat Completions over fetch with a configurable base URL (OpenAI, OpenRouter, local servers), streamed.
 * `maxReplyBytes` (default MAX_REPLY_BYTES) bounds the bytes read from one response body, streamed or JSON.
 */
export function createOpenAiProvider(deps: { apiKey: string | null; baseUrl: string; fetch?: typeof fetch; maxReplyBytes?: number }): ModelProvider {
  const baseUrl = deps.baseUrl.replace(/\/+$/, "");
  const doFetch = deps.fetch ?? fetch;
  const maxReplyBytes = deps.maxReplyBytes ?? MAX_REPLY_BYTES;
  return {
    async generate(request: ModelRequest, options: GenerateOptions): Promise<ModelResponse> {
      const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream" };
      if (deps.apiKey !== null && deps.apiKey !== "") headers["authorization"] = `Bearer ${deps.apiKey}`;
      const response = await postToProvider({
        fetch: doFetch,
        provider: PROVIDER,
        url: `${baseUrl}/chat/completions`,
        headers,
        body: buildOpenAiBody(request),
        signal: options.signal,
        apiKey: deps.apiKey,
      });

      if (isJsonResponse(response)) {
        const completion = await readJsonBody(response, PROVIDER, options.signal, maxReplyBytes);
        if (!isJsonObject(completion)) throw replyFailure(`${PROVIDER} returned a reply that is not a JSON object`);
        if (!isAbsent(completion["error"])) throw envelopeError(PROVIDER, completion, deps.apiKey, "response");
        const choice = firstChoice(completion);
        if (choice === null) {
          if (providerErrorMessage(completion) !== null || classifyEnvelope(completion).status !== null) {
            throw envelopeError(PROVIDER, completion, deps.apiKey, "response");
          }
          throw replyFailure(`${PROVIDER}: no choices in the response`);
        }
        const message = choice["message"];
        if (!isJsonObject(message)) throw replyFailure(`${PROVIDER} returned a choice with no message object`);
        const part = readChoicePart(message);
        const finishReason = choice["finish_reason"] === "" ? null : finishReasonOf(choice);
        if (finishReason === null) throw replyFailure(`${PROVIDER} returned a choice with no finish_reason`);
        const calls: PartialCall[] = [];
        mergeToolCalls(calls, part.toolCalls);
        const text = part.content ?? "";
        const reply = finish(request, text, calls.filter((call) => call !== undefined), finishReason, usageFrom(completion["usage"]));
        if (text !== "" && options.onDelta !== undefined) options.onDelta(text);
        return reply;
      }
      if (response.body === null) throw truncatedStreamError(PROVIDER);

      let text = "";
      const calls: PartialCall[] = [];
      let finishReason: string | null = null;
      let usage = usageFrom(undefined);
      let done = false;
      let sawChoice = false;
      for await (const event of readSse(response.body, options.signal, { provider: PROVIDER, maxBytes: maxReplyBytes })) {
        if (event.data.trim() === "[DONE]") {
          done = true;
          break;
        }
        const chunk = parseJsonText(event.data);
        if (!isJsonObject(chunk)) throw replyFailure(`${PROVIDER} sent a stream event whose data is neither [DONE] nor a JSON object`);
        if (chunk["error"] !== undefined) throw envelopeError(PROVIDER, chunk, deps.apiKey, "stream");
        const reported = usageFrom(chunk["usage"]);
        const choice = firstChoice(chunk);
        if (choice !== null) {
          const delta = choice["delta"];
          if (!isAbsent(delta) && !isJsonObject(delta)) throw replyFailure(`${PROVIDER}: the delta of a choice is not an object`);
          const part: ChoicePart = isJsonObject(delta) ? readChoicePart(delta) : { content: null, toolCalls: [] };
          const reason = finishReasonOf(choice);
          sawChoice = true;
          mergeToolCalls(calls, part.toolCalls);
          if (part.content !== null && part.content !== "") {
            text += part.content;
            options.onDelta?.(part.content);
          }
          finishReason = reason ?? finishReason;
        }
        usage = mergeUsage(usage, reported);
      }
      if (!sawChoice) throw replyFailure(`${PROVIDER}: the stream ended without a completion (no chunk carried a choice)`);
      if (!done) throw truncatedStreamError(PROVIDER);
      if (finishReason === null) throw replyFailure(`${PROVIDER}: the stream ended without a finish_reason`);
      return finish(request, text, calls.filter((call) => call !== undefined), finishReason, usage);
    },
  };
}
