import { RunwrightError } from "../core/errors.ts";
import { isJsonObject, type Json, type JsonObject } from "../core/json.ts";
import { isRetryableStatus, parseRetryAfterMs } from "./retry.ts";
import type { AttemptBilling } from "./types.ts";

/** One dispatched Server-Sent Event. `event` is "message" when the stream gave no event name. */
export interface SseEvent { event: string; data: string; id: string | null }

const MAX_ERROR_TEXT = 500;

/** The most characters one SSE event may hold (its pending line and its data lines together). */
export const MAX_SSE_EVENT_CHARS = 16 * 1024 * 1024;
/**
 * The most bytes read from one provider response body, streamed or plain JSON: one size limit per reply, however it
 * arrives. A body that passes it is cancelled and the reply is a reply failure with unknown billing.
 */
export const MAX_REPLY_BYTES = 64 * 1024 * 1024;
/** The most bytes of an error reply (an HTTP error status) that are read for its message. */
export const MAX_ERROR_BODY_BYTES = 64 * 1024;

function abortedError(signal: AbortSignal): RunwrightError {
  return new RunwrightError("aborted", "the model call was aborted", { cause: signal.reason });
}

/**
 * Incremental SSE parser (the WHATWG event-stream rules): lines end in CRLF, LF or CR; `:` starts a comment;
 * `data` lines are joined with "\n"; a blank line dispatches. An event still open when the input ends is dropped.
 * An event whose data and unfinished line hold more than `maxEventChars` characters (a line that never ends
 * included) is a reply failure, so a stream cannot grow one event without bound.
 */
export class SseParser {
  private buffer = "";
  private event = "";
  private data: string[] = [];
  private dataChars = 0;
  private id: string | null = null;
  private hasData = false;
  private pendingCr = false;
  private readonly maxEventChars: number;

  constructor(maxEventChars: number = MAX_SSE_EVENT_CHARS) {
    this.maxEventChars = maxEventChars;
  }

  push(text: string): SseEvent[] {
    let input = text;
    if (this.pendingCr) {
      this.pendingCr = false;
      if (input.startsWith("\n")) input = input.slice(1);
    }
    this.buffer += input;
    const out: SseEvent[] = [];
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer);
      if (match === null) break;
      if (match[0] === "\r" && match.index === this.buffer.length - 1) {
        this.pendingCr = true;
      }
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const dispatched = this.line(line);
      if (dispatched !== null) out.push(dispatched);
    }
    if (this.buffer.length + this.dataChars > this.maxEventChars) {
      throw replyFailure(`the response stream sent an event longer than ${this.maxEventChars} characters`);
    }
    return out;
  }

  private line(line: string): SseEvent | null {
    if (line === "") {
      if (!this.hasData) {
        this.event = "";
        return null;
      }
      const event: SseEvent = { event: this.event === "" ? "message" : this.event, data: this.data.join("\n"), id: this.id };
      this.event = "";
      this.data = [];
      this.dataChars = 0;
      this.hasData = false;
      return event;
    }
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") {
      this.data.push(value);
      this.dataChars += value.length + 1;
      if (this.dataChars > this.maxEventChars) {
        throw replyFailure(`the response stream sent an event longer than ${this.maxEventChars} characters`);
      }
      this.hasData = true;
    } else if (field === "event") {
      this.event = value;
    } else if (field === "id" && !value.includes("\0")) {
      this.id = value;
    }
    return null;
  }
}

/** How much of a response body `readSse` reads, and whose body it is (for the error message). */
export interface SseLimit {
  provider: string;
  /** Default MAX_REPLY_BYTES. */
  maxBytes?: number;
}

/**
 * Yields the SSE events of a response body. Aborting the signal cancels the body and throws `aborted`; a body
 * that errors mid-stream throws `model_transient` (the caller decides whether a clean end was premature). However
 * the iteration ends (the stream's end, an error thrown here or by the caller inside its loop, a `break`), the
 * body is cancelled.
 *
 * The raw bytes of every chunk read from the body are counted before the chunk is decoded or parsed, across the
 * whole response: once they pass `limit.maxBytes` (default MAX_REPLY_BYTES) the body is cancelled and the reply is
 * a reply failure (`<provider> sent a reply larger than <n> bytes`, billing unknown); a body of exactly the limit
 * is read whole. Every caller is bounded by it: the text, tool arguments, thinking and ignored deltas a caller
 * accumulates come out of those bytes, and so does every event (one event needs at least one byte), so neither
 * what is accumulated nor the number of events (comments and empty deltas included) can grow past the limit.
 */
export async function* readSse(body: ReadableStream<Uint8Array>, signal: AbortSignal, limit: SseLimit): AsyncGenerator<SseEvent> {
  const maxBytes = limit.maxBytes ?? MAX_REPLY_BYTES;
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  const parser = new SseParser();
  let bytes = 0;
  const onAbort = (): void => {
    reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw abortedError(signal);
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (signal.aborted) throw abortedError(signal);
        throw new RunwrightError("model_transient", `the response stream failed: ${errorText(error)}`, {
          details: { status: null, retryAfterMs: null, billing: "unknown" },
          cause: error,
        });
      }
      if (signal.aborted) throw abortedError(signal);
      if (chunk.done) {
        for (const event of parser.push(decoder.decode())) yield event;
        return;
      }
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw oversizedReply(limit.provider, maxBytes);
      for (const event of parser.push(decoder.decode(chunk.value, { stream: true }))) yield event;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    // Releasing the body is best effort: the reply is already decided, and a failed cancel leaves nothing to do.
    reader.cancel().catch(() => undefined);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Removes the API key from text that came back from a provider, then trims it to a readable length. */
export function cleanProviderText(text: string, apiKey: string | null): string {
  let out = text;
  if (apiKey !== null && apiKey.length > 0) out = out.split(apiKey).join("[redacted]");
  out = out.replace(/\s+/g, " ").trim();
  return out.length > MAX_ERROR_TEXT ? `${out.slice(0, MAX_ERROR_TEXT)}...` : out;
}

/** The message inside a provider error body: `{error: {message}}`, `{error: "..."}` or `{message}`. */
export function providerErrorMessage(body: unknown): string | null {
  if (!isJsonObject(body)) return null;
  const error = body["error"];
  if (typeof error === "string") return error;
  if (isJsonObject(error) && typeof error["message"] === "string") return error["message"];
  if (typeof body["message"] === "string") return body["message"];
  return null;
}

/** Error kinds (`error.type`, or a non-numeric `error.code`, lower-cased) that mean "try again later". */
const TRANSIENT_ERROR_KINDS: ReadonlySet<string> = new Set([
  "server_error", "rate_limit_exceeded", "rate_limit_error", "overloaded", "overloaded_error", "service_unavailable", "timeout",
]);

/** An HTTP status as a provider wrote it in an error envelope: an integer from 100 to 599, or a string of one. */
function envelopeStatusValue(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\s*\d{3}\s*$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(number) && number >= 100 && number <= 599 ? number : null;
}

/** How an error envelope that came inside a successful HTTP reply classifies. */
export interface EnvelopeClass {
  /** The first status among `error.code`, `error.status`, `body.code`, `body.status`; null when none is one. */
  status: number | null;
  /** `error.type` and a non-numeric `error.code`, lower-cased. */
  kinds: string[];
  /** A retryable status (`isRetryableStatus`) or a transient kind. */
  transient: boolean;
}

/** Classifies a provider error envelope (`{error: {...}}`, `{error: "..."}`, `{code, message}`) by status and kind. */
export function classifyEnvelope(body: JsonObject): EnvelopeClass {
  const error = isJsonObject(body["error"]) ? body["error"] : {};
  let status: number | null = null;
  for (const value of [error["code"], error["status"], body["code"], body["status"]]) {
    status = envelopeStatusValue(value);
    if (status !== null) break;
  }
  const kinds: string[] = [];
  for (const value of [error["type"], error["code"]]) {
    if (typeof value === "string" && value.trim() !== "" && envelopeStatusValue(value) === null) kinds.push(value.trim().toLowerCase());
  }
  const transient = (status !== null && isRetryableStatus(status)) || kinds.some((kind) => TRANSIENT_ERROR_KINDS.has(kind));
  return { status, kinds, transient };
}

/**
 * The error a provider reported inside a successful HTTP reply. Transient ones are `model_transient`.
 * `where` picks the wording: "stream" → `<provider> stream error: <text>`, "response" → `<provider>: <text>`.
 * The attempt reached the provider, so its billing is "unknown".
 */
export function envelopeError(provider: string, body: JsonObject, apiKey: string | null, where: "stream" | "response"): RunwrightError {
  const { status, transient } = classifyEnvelope(body);
  const text = cleanProviderText(providerErrorMessage(body) ?? (where === "stream" ? "stream error" : "the response carries an error"), apiKey);
  const message = where === "stream" ? `${provider} stream error: ${text}` : `${provider}: ${text}`;
  if (transient) return new RunwrightError("model_transient", message, { details: { status, retryAfterMs: null, billing: "unknown" } });
  return new RunwrightError("model_failed", message, { details: { status, billing: "unknown" } });
}

export function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Error codes that mean no connection to the provider was made, so the request was never received. */
const NO_CONNECTION_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);
const MAX_CAUSE_DEPTH = 8;

function hasNoConnectionCode(error: unknown, depth: number): boolean {
  if (depth > MAX_CAUSE_DEPTH || typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && NO_CONNECTION_CODES.has(code)) return true;
  // Happy-eyeballs connects report one failure per address: no connection was made only if every one says so.
  const errors = (error as { errors?: unknown }).errors;
  if (Array.isArray(errors) && errors.length > 0 && errors.every((item) => hasNoConnectionCode(item, depth + 1))) return true;
  return hasNoConnectionCode((error as { cause?: unknown }).cause, depth + 1);
}

/**
 * Billing of a rejected fetch: "none" when the error's cause chain names a code that means no connection was
 * made; anything else may have reached the provider.
 */
export function fetchRejectionBilling(error: unknown): AttemptBilling {
  return hasNoConnectionCode(error, 0) ? "none" : "unknown";
}

export interface ProviderPost {
  fetch: typeof fetch;
  provider: string;
  url: string;
  headers: Record<string, string>;
  body: JsonObject;
  signal: AbortSignal;
  apiKey: string | null;
}

/**
 * POSTs a provider request and returns the successful response. Maps failures to RunwrightError:
 * an aborted signal → `aborted`; a request that cannot be built (bad URL, body) → `model_failed`, never sent;
 * a rejected fetch → `model_transient` (status null); a retryable HTTP status → `model_transient` with the
 * retry-after hint; any other status → `model_failed`. Every failure says in `details.billing` whether the
 * attempt may have been billed. No header is ever echoed.
 */
export async function postToProvider(post: ProviderPost): Promise<Response> {
  if (post.signal.aborted) throw abortedError(post.signal);
  if (!URL.canParse(post.url)) {
    throw new RunwrightError("model_failed", `the ${post.provider} request URL is not valid`, { details: { status: null, billing: "none" } });
  }
  let body: string;
  try {
    body = JSON.stringify(post.body);
  } catch (error) {
    throw new RunwrightError("model_failed", `the ${post.provider} request could not be built: ${cleanProviderText(errorText(error), post.apiKey)}`, {
      details: { status: null, billing: "none" },
      cause: error,
    });
  }
  let response: Response;
  try {
    response = await post.fetch(post.url, { method: "POST", headers: post.headers, body, signal: post.signal });
  } catch (error) {
    if (post.signal.aborted) throw abortedError(post.signal);
    throw new RunwrightError("model_transient", `network error calling ${post.provider}: ${cleanProviderText(errorText(error), post.apiKey)}`, {
      details: { status: null, retryAfterMs: null, billing: fetchRejectionBilling(error) },
      cause: error,
    });
  }
  if (response.ok) return response;

  let text = "";
  try {
    text = (await readCappedText(response, MAX_ERROR_BODY_BYTES)).text;
  } catch {
    if (post.signal.aborted) throw abortedError(post.signal);
  }
  const message = providerErrorMessage(parseJsonText(text)) ?? text;
  const detail = cleanProviderText(message, post.apiKey);
  const summary = `${post.provider} returned HTTP ${response.status}${detail === "" ? "" : `: ${detail}`}`;
  if (isRetryableStatus(response.status)) {
    throw new RunwrightError("model_transient", summary, {
      details: { status: response.status, retryAfterMs: parseRetryAfterMs(response.headers, Date.now()), billing: "none" },
    });
  }
  throw new RunwrightError("model_failed", summary, { details: { status: response.status, billing: "none" } });
}

/** True when the response is a single JSON document rather than an event stream. */
export function isJsonResponse(response: Response): boolean {
  const type = response.headers.get("content-type") ?? "";
  return type.toLowerCase().includes("application/json");
}

/**
 * Reads a response body as UTF-8 text, at most `maxBytes` of it: `over` is true when the body held more, and the
 * text is then its first `maxBytes` bytes. The body is cancelled however the read ends, so a body that is not
 * read to its end never stays open.
 */
async function readCappedText(response: Response, maxBytes: number): Promise<{ text: string; over: boolean }> {
  const body = response.body;
  if (body === null) return { text: "", over: false };
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return { text: text + decoder.decode(), over: false };
      const room = maxBytes - bytes;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) return { text: text + decoder.decode(chunk.value.subarray(0, room)), over: true };
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    // Releasing the body is best effort: the reply is already decided, and a failed cancel leaves nothing to do.
    reader.cancel().catch(() => undefined);
  }
}

/** The reply failure of a provider body larger than `maxBytes`: the provider answered, so it may have been billed. */
function oversizedReply(provider: string, maxBytes: number): RunwrightError {
  return replyFailure(`${provider} sent a reply larger than ${maxBytes} bytes`);
}

/**
 * A plain-JSON reply, read whole up to `maxBytes` (default MAX_REPLY_BYTES, the limit a streamed reply has too); a
 * larger one is cancelled and is a reply failure (it may have been billed).
 */
export async function readJsonBody(response: Response, provider: string, signal: AbortSignal, maxBytes: number = MAX_REPLY_BYTES): Promise<unknown> {
  let text: string;
  try {
    const read = await readCappedText(response, maxBytes);
    if (read.over) throw oversizedReply(provider, maxBytes);
    text = read.text;
  } catch (error) {
    if (error instanceof RunwrightError) throw error;
    if (signal.aborted) throw abortedError(signal);
    throw new RunwrightError("model_transient", `the ${provider} response body failed: ${errorText(error)}`, {
      details: { status: null, retryAfterMs: null, billing: "unknown" },
      cause: error,
    });
  }
  const parsed = parseJsonText(text);
  if (parsed === undefined) {
    throw new RunwrightError("model_failed", `${provider} returned a body that is not JSON`, { details: { status: null, billing: "unknown" } });
  }
  return parsed;
}

export function truncatedStreamError(provider: string): RunwrightError {
  return new RunwrightError("model_transient", `the ${provider} stream ended before it finished`, {
    details: { status: null, retryAfterMs: null, billing: "unknown" },
  });
}

/** A failure found in a reply the provider already sent with a 2xx status: it may have been billed. */
export function replyFailure(message: string): RunwrightError {
  return new RunwrightError("model_failed", message, { details: { status: null, billing: "unknown" } });
}

function notObjectFailure(provider: string, toolName: string): RunwrightError {
  return replyFailure(`${provider} returned arguments for tool "${toolName}" that are not a JSON object`);
}

/**
 * Parses tool-call argument text as any JSON value; empty text is `{}`. Text that is not JSON is `model_failed`,
 * worded for what the caller expects: "object" (a tool's arguments) or "json" (a wrapped structured output).
 */
export function parseToolArgsJson(text: string, provider: string, toolName: string, expect: "object" | "json"): Json {
  if (text.trim() === "") return {};
  const parsed = parseJsonText(text);
  if (parsed === undefined) {
    if (expect === "object") throw notObjectFailure(provider, toolName);
    throw replyFailure(`${provider} returned arguments for tool "${toolName}" that are not valid JSON`);
  }
  return parsed as Json;
}

/** The arguments of an ordinary tool call: anything other than a JSON object is `model_failed`, never `{}`. */
export function toolArgsObject(value: Json, provider: string, toolName: string): JsonObject {
  if (!isJsonObject(value)) throw notObjectFailure(provider, toolName);
  return value;
}

/** Parses tool-call arguments; anything other than a JSON object is `model_failed`. */
export function parseToolArgs(text: string, provider: string, toolName: string): JsonObject {
  return toolArgsObject(parseToolArgsJson(text, provider, toolName, "object"), provider, toolName);
}

/** True for a count a provider can report: a whole number >= 0 (a huge one included; the engine saturates totals). */
export function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * A token count of a provider's usage report: null when the field is absent or null (or `usage` is not an
 * object). A field that is present but not a whole number >= 0 (a string, a negative or fractional number, NaN,
 * an infinity) is a reply failure, so a malformed count can never be charged as a smaller one.
 */
export function tokenField(usage: unknown, key: string, provider: string): number | null {
  if (!isJsonObject(usage)) return null;
  const field = usage[key];
  if (field === undefined || field === null) return null;
  if (!isTokenCount(field)) {
    throw replyFailure(`${provider} sent a usage field ${key} that is not a non-negative number`);
  }
  return field;
}

/** The most content blocks or tool calls one reply may index. */
const MAX_REPLY_INDEX = 4096;

/**
 * The position a provider gave a content block or tool-call delta (`index`), or `fallback` when it gave none (or null).
 * An index that is not an integer from 0 to MAX_REPLY_INDEX - 1 is a reply failure: it would otherwise make a
 * sparse array whose later scan takes as long as the number says.
 */
export function replyIndex(value: unknown, fallback: number, provider: string): number {
  const index = isJsonObject(value) ? value["index"] : undefined;
  if (index === undefined || index === null) return fallback;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= MAX_REPLY_INDEX) {
    throw replyFailure(`${provider} sent an index that is not an integer from 0 to ${MAX_REPLY_INDEX - 1}`);
  }
  return index;
}

export function stringField(value: unknown, key: string): string | null {
  if (!isJsonObject(value)) return null;
  const field = value[key];
  return typeof field === "string" ? field : null;
}
