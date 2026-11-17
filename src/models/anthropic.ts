import { RunwrightError } from "../core/errors.ts";
import { isJsonObject, type Json, type JsonObject } from "../core/json.ts";
import {
  WRAPPED_INSTRUCTION_SENTENCE, isObjectOutputSchema, outputToolDescription, outputToolSchema, structuredResult,
  type OutputArgs, type StructuredResult,
} from "./output-transport.ts";
import {
  MAX_REPLY_BYTES, classifyEnvelope, isJsonResponse, parseJsonText, parseToolArgs, postToProvider, providerErrorMessage, readJsonBody,
  isTokenCount, readSse, replyFailure, replyIndex, stringField, tokenField, toolArgsObject, truncatedStreamError, cleanProviderText,
} from "./sse-parse.ts";
import type { GenerateOptions, Message, ModelProvider, ModelRequest, ModelResponse, StopReason, ToolCall, Usage } from "./types.ts";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";
const PROVIDER = "anthropic";

/**
 * Model families that reject a forced `tool_choice` (and run with thinking on by default). For these, structured
 * output is requested with `tool_choice: auto` plus an instruction to call the output tool.
 */
function supportsForcedToolChoice(model: string): boolean {
  return !/^claude-(fable|mythos|opus|sonnet|haiku)-5/.test(model);
}

type Block = JsonObject;

function assistantBlocks(message: Extract<Message, { role: "assistant" }>): Block[] {
  const blocks: Block[] = [];
  if (message.content !== "") blocks.push({ type: "text", text: message.content });
  for (const call of message.toolCalls) blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.args });
  return blocks;
}

/** Provider-neutral messages → Messages API turns; consecutive tool results share one user turn. */
function toAnthropicMessages(messages: Message[]): JsonObject[] {
  const out: JsonObject[] = [];
  let toolResults: Block[] | null = null;
  for (const message of messages) {
    if (message.role === "tool") {
      const block: Block = { type: "tool_result", tool_use_id: message.toolCallId, content: message.content, is_error: message.isError };
      if (toolResults === null) {
        toolResults = [block];
        out.push({ role: "user", content: toolResults });
      } else {
        toolResults.push(block);
      }
      continue;
    }
    toolResults = null;
    if (message.role === "user") {
      out.push({ role: "user", content: message.content });
    } else {
      const blocks = assistantBlocks(message);
      if (blocks.length > 0) out.push({ role: "assistant", content: blocks });
    }
  }
  return out;
}

function buildAnthropicBody(request: ModelRequest): JsonObject {
  const tools: JsonObject[] = request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
  let system = request.system;
  const body: JsonObject = { model: request.model.name, max_tokens: request.maxOutputTokens };
  if (request.output !== null) {
    const spec = request.output;
    tools.push({
      name: spec.name,
      description: outputToolDescription(spec, "Return the result as the input of this tool. Its input must match the schema."),
      input_schema: outputToolSchema(spec.schema),
    });
    if (supportsForcedToolChoice(request.model.name)) {
      body["tool_choice"] = { type: "tool", name: spec.name };
    } else {
      body["tool_choice"] = { type: "auto" };
      const instruction = `Give your answer by calling the tool "${spec.name}" exactly once.` +
        (isObjectOutputSchema(spec.schema) ? "" : WRAPPED_INSTRUCTION_SENTENCE);
      system = system === "" ? instruction : `${system}\n\n${instruction}`;
    }
  }
  if (system !== "") body["system"] = system;
  body["messages"] = toAnthropicMessages(request.messages);
  if (tools.length > 0) body["tools"] = tools;
  body["stream"] = true;
  return body;
}

function mapStopReason(reason: string | null): StopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    default:
      return "other";
  }
}

interface UsageAccumulator { input: number; output: number; cacheRead: number; cacheWrite: number }

/** Copies the token counts `usage` reports; a field that is present but not a non-negative number is a reply failure. */
function readUsage(acc: UsageAccumulator, usage: unknown): void {
  const input = tokenField(usage, "input_tokens", PROVIDER);
  const output = tokenField(usage, "output_tokens", PROVIDER);
  const cacheRead = tokenField(usage, "cache_read_input_tokens", PROVIDER);
  const cacheWrite = tokenField(usage, "cache_creation_input_tokens", PROVIDER);
  if (input !== null) acc.input = input;
  if (output !== null) acc.output = output;
  if (cacheRead !== null) acc.cacheRead = cacheRead;
  if (cacheWrite !== null) acc.cacheWrite = cacheWrite;
}

/** `input`: the block's own input as the provider sent it (any JSON), or undefined when it had none. */
interface PartialBlock { type: string; text: string; id: string; name: string; json: string; input: Json | undefined }

/** A tool_use block's arguments as sent: the streamed input_json_delta text when there is any, else the block's input. */
function blockArgs(block: PartialBlock): OutputArgs {
  return block.json !== "" || block.input === undefined ? { text: block.json } : { value: block.input };
}

/** Anthropic's transient error types, with the HTTP status each stands for when the envelope carries none. */
const TRANSIENT_TYPE_STATUS: Readonly<Record<string, number>> = { overloaded_error: 529, api_error: 500, rate_limit_error: 429, timeout_error: 504 };

/**
 * An error envelope in a stream or a plain-JSON reply. Classified like the OpenAI-compatible provider's
 * (`classifyEnvelope`: a retryable status in the envelope or a transient kind), plus the transient types above;
 * the status is the envelope's own when it carries one, else the type's.
 */
function streamError(data: unknown, apiKey: string): RunwrightError {
  const error = isJsonObject(data) ? data["error"] : undefined;
  const type = stringField(error, "type") ?? "error";
  const message = cleanProviderText(providerErrorMessage(data) ?? type, apiKey);
  const envelope = isJsonObject(data) ? classifyEnvelope(data) : { status: null, kinds: [], transient: false };
  const typeStatus = Object.hasOwn(TRANSIENT_TYPE_STATUS, type) ? TRANSIENT_TYPE_STATUS[type] : undefined;
  if (typeStatus !== undefined || envelope.transient) {
    return new RunwrightError("model_transient", `anthropic stream error (${type}): ${message}`, {
      details: { status: envelope.status ?? typeStatus ?? null, retryAfterMs: null, billing: "unknown" },
    });
  }
  return new RunwrightError("model_failed", `anthropic stream error (${type}): ${message}`, {
    details: { status: envelope.status, billing: "unknown" },
  });
}

/** True when `usage` is an object whose input_tokens and output_tokens are token counts (`isTokenCount`). */
function hasUsage(usage: unknown): boolean {
  return isJsonObject(usage) && isTokenCount(usage["input_tokens"]) && isTokenCount(usage["output_tokens"]);
}

/**
 * The envelope of a plain-JSON reply: an error envelope is the provider's error (streamError's mapping); anything
 * that is not a message with content, a stop reason and usage is a provider failure with unknown billing.
 */
function checkMessageEnvelope(body: unknown, apiKey: string): JsonObject {
  if (!isJsonObject(body)) throw replyFailure(`${PROVIDER} returned a reply that is not a JSON object`);
  if (body["type"] === "error" || isJsonObject(body["error"])) throw streamError(body, apiKey);
  const type = stringField(body, "type");
  if (type !== "message" || !Array.isArray(body["content"]) || stringField(body, "stop_reason") === null) {
    const what = type === null ? "no type" : `type ${JSON.stringify(cleanProviderText(type, apiKey))}`;
    throw replyFailure(`${PROVIDER} returned a reply that is not a message (${what}, it needs content and a stop_reason)`);
  }
  if (!hasUsage(body["usage"])) throw replyFailure(`${PROVIDER} returned a message with no usage (input_tokens and output_tokens)`);
  return body;
}

/** One reading for streamed and plain-JSON replies alike: the first output-tool call decides the output (plan 3.1). */
function finish(request: ModelRequest, blocks: PartialBlock[], stopReason: string | null, acc: UsageAccumulator): ModelResponse {
  let text = "";
  const toolCalls: ToolCall[] = [];
  let outputCall: OutputArgs | null = null;
  for (const block of blocks) {
    if (block.type === "text") text += block.text;
    if (block.type !== "tool_use") continue;
    const raw = blockArgs(block);
    if (request.output !== null && block.name === request.output.name && outputCall === null) {
      outputCall = raw;
    } else {
      const args = "text" in raw ? parseToolArgs(raw.text, PROVIDER, block.name) : toolArgsObject(raw.value, PROVIDER, block.name);
      toolCalls.push({ id: block.id, name: block.name, args });
    }
  }
  const structured: StructuredResult = request.output === null ? { output: null } : structuredResult(request.output, PROVIDER, outputCall, text);
  let stop = mapStopReason(stopReason);
  if (stop === "tool_use" && toolCalls.length === 0 && outputCall !== null) stop = "end";
  const usage: Usage = { inputTokens: acc.input, outputTokens: acc.output, cacheReadTokens: acc.cacheRead, cacheWriteTokens: acc.cacheWrite };
  return { text, toolCalls, ...structured, stopReason: stop, usage };
}

/**
 * A content block, checked: an object with a string `type`; a `text` block's `text` a string when present (absent is
 * ""); a `tool_use` block with a non-empty string `id` and `name`. Blocks of other types (thinking, redacted
 * thinking and any type added later) are kept with their type and read past by `finish`.
 */
function readBlock(item: unknown): PartialBlock {
  const type = isJsonObject(item) ? item["type"] : undefined;
  if (!isJsonObject(item) || typeof type !== "string") throw replyFailure(`${PROVIDER} sent a content block that is not an object with a type`);
  const text = item["text"];
  if (type === "text" && text !== undefined && typeof text !== "string") throw replyFailure(`${PROVIDER} sent a text block whose text is not a string`);
  const id = item["id"];
  const name = item["name"];
  if (type === "tool_use" && (typeof id !== "string" || id === "" || typeof name !== "string" || name === "")) {
    throw replyFailure(`${PROVIDER} sent a tool_use block without an id and a name`);
  }
  return {
    type,
    text: typeof text === "string" ? text : "",
    id: typeof id === "string" ? id : "",
    name: typeof name === "string" ? name : "",
    json: "",
    input: item["input"],
  };
}

/** The content of a plain-JSON message (an array, checked by `checkMessageEnvelope`); every item goes through `readBlock`. */
function blocksFromMessage(message: JsonObject): PartialBlock[] {
  const content = message["content"];
  return Array.isArray(content) ? content.map(readBlock) : [];
}

/**
 * Applies one `content_block_delta`. The block at its index must have been started, and the delta must be an
 * object with a string `type`. A `text_delta` needs a string `text` and an `input_json_delta` a string
 * `partial_json`; each is applied only to a block of its own kind. Other delta types (thinking, signature,
 * citations and any type added later) are read past.
 */
function applyDelta(blocks: PartialBlock[], data: JsonObject, onDelta: ((text: string) => void) | undefined): void {
  const block = blocks[replyIndex(data, -1, PROVIDER)];
  if (block === undefined) throw replyFailure(`${PROVIDER} sent a delta for a content block that was never started`);
  const delta = data["delta"];
  const deltaType = isJsonObject(delta) ? delta["type"] : undefined;
  if (!isJsonObject(delta) || typeof deltaType !== "string") throw replyFailure(`${PROVIDER} sent a delta that is not an object with a type`);
  if (deltaType === "text_delta") {
    const piece = delta["text"];
    if (typeof piece !== "string") throw replyFailure(`${PROVIDER} sent a text_delta whose text is not a string`);
    if (block.type !== "text") return;
    block.text += piece;
    if (piece !== "" && onDelta !== undefined) onDelta(piece);
  } else if (deltaType === "input_json_delta") {
    const json = delta["partial_json"];
    if (typeof json !== "string") throw replyFailure(`${PROVIDER} sent an input_json_delta whose partial_json is not a string`);
    if (block.type === "tool_use") block.json += json;
  }
}

/** A `message_delta`'s stop reason: its `delta` must be an object, and `stop_reason` a string when present and not null. */
function messageDeltaStopReason(data: JsonObject): string | null {
  const delta = data["delta"];
  if (!isJsonObject(delta)) throw replyFailure(`${PROVIDER} sent a message_delta without a delta object`);
  const reason = delta["stop_reason"];
  if (reason === undefined || reason === null) return null;
  if (typeof reason !== "string") throw replyFailure(`${PROVIDER} sent a stop_reason that is not a string`);
  return reason;
}

/**
 * The Anthropic Messages API over fetch, streamed. Thinking blocks and other block types are read past; only text
 * and tool use count. Event types other than the message and content-block events (ping, and any added later) are
 * read past as well.
 *
 * Usage: a streamed reply is accepted only when `message_start` carries usage with both counts and a
 * `message_delta` carries the final `output_tokens` (the count in `message_start` covers only what was generated
 * before the stream began). A stream without it is a reply failure with unknown billing, so the engine charges the
 * attempt its worst case instead of the early count. A plain-JSON reply needs both counts in its usage, or it is the
 * same reply failure. So no path of this adapter reports a count it did not get (the table above `usageFrom` in
 * `openai.ts` lists every path of both adapters). `maxReplyBytes` (default MAX_REPLY_BYTES) bounds the bytes read
 * from one response body, streamed or JSON.
 */
export function createAnthropicProvider(deps: { apiKey: string; baseUrl?: string; fetch?: typeof fetch; maxReplyBytes?: number }): ModelProvider {
  const baseUrl = (deps.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const doFetch = deps.fetch ?? fetch;
  const maxReplyBytes = deps.maxReplyBytes ?? MAX_REPLY_BYTES;
  return {
    async generate(request: ModelRequest, options: GenerateOptions): Promise<ModelResponse> {
      const response = await postToProvider({
        fetch: doFetch,
        provider: PROVIDER,
        url: `${baseUrl}/v1/messages`,
        headers: { "x-api-key": deps.apiKey, "anthropic-version": API_VERSION, "content-type": "application/json", accept: "text/event-stream" },
        body: buildAnthropicBody(request),
        signal: options.signal,
        apiKey: deps.apiKey,
      });
      const acc: UsageAccumulator = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

      if (isJsonResponse(response)) {
        const message = checkMessageEnvelope(await readJsonBody(response, PROVIDER, options.signal, maxReplyBytes), deps.apiKey);
        readUsage(acc, message["usage"]);
        const blocks = blocksFromMessage(message);
        const reply = finish(request, blocks, stringField(message, "stop_reason"), acc);
        if (reply.text !== "" && options.onDelta !== undefined) options.onDelta(reply.text);
        return reply;
      }
      if (response.body === null) throw truncatedStreamError(PROVIDER);

      const blocks: PartialBlock[] = [];
      let stopReason: string | null = null;
      let stopped = false;
      let started = false;
      let startUsage = false;
      let finalOutput = false;
      for await (const event of readSse(response.body, options.signal, { provider: PROVIDER, maxBytes: maxReplyBytes })) {
        const data = parseJsonText(event.data);
        const type = stringField(data, "type") ?? event.event;
        if (type === "ping") continue;
        if (type === "error") throw streamError(data, deps.apiKey);
        if (!isJsonObject(data)) {
          throw replyFailure(`${PROVIDER} sent a stream event (${cleanProviderText(type, deps.apiKey)}) whose data is not a JSON object`);
        }
        if (type === "message_start") {
          started = true;
          const usage = isJsonObject(data["message"]) ? data["message"]["usage"] : undefined;
          startUsage = hasUsage(usage);
          readUsage(acc, usage);
        } else if (type === "content_block_start") {
          const index = replyIndex(data, blocks.length, PROVIDER);
          const block = readBlock(data["content_block"]);
          blocks[index] = block;
          if (block.type === "text" && block.text !== "" && options.onDelta !== undefined) options.onDelta(block.text);
        } else if (type === "content_block_delta") {
          applyDelta(blocks, data, options.onDelta);
        } else if (type === "message_delta") {
          stopReason = messageDeltaStopReason(data) ?? stopReason;
          readUsage(acc, data["usage"]);
          if (isJsonObject(data["usage"]) && isTokenCount(data["usage"]["output_tokens"])) finalOutput = true;
        } else if (type === "message_stop") {
          stopped = true;
          break;
        }
      }
      if (!stopped) throw truncatedStreamError(PROVIDER);
      if (!started || !startUsage || stopReason === null || !finalOutput) {
        const missing = !started
          ? "no message_start"
          : !startUsage
            ? "no usage in message_start"
            : stopReason === null ? "no stop_reason in a message_delta" : "no output_tokens in a message_delta";
        throw replyFailure(`${PROVIDER}: the stream ended without a complete message (${missing})`);
      }
      return finish(request, blocks.filter((block) => block !== undefined), stopReason, acc);
    },
  };
}
