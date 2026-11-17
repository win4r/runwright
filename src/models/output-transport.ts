/**
 * How a structured output travels through a network provider (plan 3.1, invariant O1). The output is carried
 * as the arguments of a forced "output tool", and a tool's arguments are always a JSON object. An object schema
 * is sent as the tool's argument schema as it is; any other schema (array, scalar, null, a union, a reference)
 * is wrapped in an object with one "value" property, and the answer is unwrapped again when it comes back.
 */
import { isJsonObject, type Json, type JsonObject } from "../core/json.ts";
import type { JsonSchema } from "../schema/validate.ts";
import { parseJsonText, parseToolArgsJson, replyFailure } from "./sse-parse.ts";
import type { StructuredOutputSpec } from "./types.ts";

/** The one property of the wrapper object a structured output travels in when its schema is not an object schema. */
export const OUTPUT_VALUE_KEY = "value";

/** The sentence appended to the output tool's description when its schema is wrapped. */
export const WRAPPED_TOOL_SENTENCE = ` Put the result in the "${OUTPUT_VALUE_KEY}" argument.`;

/** The sentence appended to an instruction to call the output tool when its schema is wrapped. */
export const WRAPPED_INSTRUCTION_SENTENCE = ` Put the answer in its "${OUTPUT_VALUE_KEY}" argument.`;

/** True when the declared schema can be a tool's argument schema as it is: its top-level "type" is exactly the string "object". */
export function isObjectOutputSchema(schema: JsonSchema): boolean {
  return schema["type"] === "object";
}

const DEFINITION_KEYWORDS = ["$defs", "definitions"] as const;

/**
 * The argument schema of the output tool. An object schema is returned as it is (the same reference). Any other
 * schema S is wrapped:
 *   { type: "object", additionalProperties: false, required: ["value"], properties: { value: S' } }
 * where S' is S without its top-level "$defs" and "definitions"; those two keywords, when S has them, are put on
 * the wrapper itself, so "#/$defs/N" and "#/definitions/N" inside S' still resolve.
 */
export function outputToolSchema(schema: JsonSchema): JsonSchema {
  if (isObjectOutputSchema(schema)) return schema;
  const inner: JsonObject = {};
  for (const [key, item] of Object.entries(schema)) {
    if ((DEFINITION_KEYWORDS as readonly string[]).includes(key)) continue;
    Object.defineProperty(inner, key, { value: item, enumerable: true, writable: true, configurable: true });
  }
  const wrapper: JsonObject = {
    type: "object",
    additionalProperties: false,
    required: [OUTPUT_VALUE_KEY],
    properties: { [OUTPUT_VALUE_KEY]: inner },
  };
  for (const key of DEFINITION_KEYWORDS) {
    if (Object.hasOwn(schema, key)) wrapper[key] = schema[key] ?? null;
  }
  return wrapper;
}

export type OutputReading = { kind: "value"; value: Json } | { kind: "missing" } | { kind: "not_object" };

/**
 * What the parsed arguments of the output tool's call mean.
 * Object schema: an object is the value; anything else is "not_object".
 * Wrapped schema: an object with an own "value" property → that property; an object without one → "missing";
 * an array, string, number, boolean or null → the value itself (a model that left the wrapper out).
 */
export function readOutputArgs(schema: JsonSchema, args: Json): OutputReading {
  if (isObjectOutputSchema(schema)) return isJsonObject(args) ? { kind: "value", value: args } : { kind: "not_object" };
  if (isJsonObject(args)) {
    return Object.hasOwn(args, OUTPUT_VALUE_KEY) ? { kind: "value", value: args[OUTPUT_VALUE_KEY] ?? null } : { kind: "missing" };
  }
  return { kind: "value", value: args };
}

/** What a text reply means when the output tool was not called: the trimmed text parsed as JSON is the value itself (never the wrapper); empty or non-JSON text is "missing". */
export function readOutputText(text: string): { kind: "value"; value: Json } | { kind: "missing" } {
  const trimmed = text.trim();
  if (trimmed === "") return { kind: "missing" };
  const parsed = parseJsonText(trimmed);
  return parsed === undefined ? { kind: "missing" } : { kind: "value", value: parsed as Json };
}

/** The output tool's description as sent: the given or default text, plus the wrapper sentence for a wrapped schema. */
export function outputToolDescription(spec: StructuredOutputSpec, defaultText: string): string {
  const base = spec.description ?? defaultText;
  return isObjectOutputSchema(spec.schema) ? base : base + WRAPPED_TOOL_SENTENCE;
}

/** The structured part of a reply: `outputMissing` is present only when it is true. */
export type StructuredResult = { output: Json; outputMissing?: true };

/** The arguments of the output tool's first call, as the provider sent them. */
export type OutputArgs = { text: string } | { value: Json };

/**
 * The output of a structured reply, shared by both network adapters and by their streaming and non-streaming
 * paths. `call` is the first call of the output tool, or null when the tool was not called; the text is then
 * read with `readOutputText`. Arguments that are not JSON, and non-object arguments under an object schema, are
 * the reply failure (`model_failed`, billing "unknown").
 */
export function structuredResult(spec: StructuredOutputSpec, provider: string, call: OutputArgs | null, text: string): StructuredResult {
  if (call === null) {
    const reading = readOutputText(text);
    return reading.kind === "value" ? { output: reading.value } : { output: null, outputMissing: true };
  }
  const expect = isObjectOutputSchema(spec.schema) ? "object" : "json";
  const args = "text" in call ? parseToolArgsJson(call.text, provider, spec.name, expect) : call.value;
  const reading = readOutputArgs(spec.schema, args);
  if (reading.kind === "value") return { output: reading.value };
  if (reading.kind === "missing") return { output: null, outputMissing: true };
  throw replyFailure(`${provider} returned arguments for tool "${spec.name}" that are not a JSON object`);
}
