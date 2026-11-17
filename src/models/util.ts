import { canonicalJson, type Json } from "../core/json.ts";
import type { ModelRef, ModelRequest } from "./types.ts";

type RequestShape = Pick<ModelRequest, "system" | "messages" | "tools" | "output">;

export function modelKey(ref: { provider: string; name: string }): string {
  return `${ref.provider}/${ref.name}`;
}

export function requestBytes(request: RequestShape): number {
  const shape = {
    system: request.system,
    messages: request.messages,
    tools: request.tools,
    output: request.output,
  } as unknown as Json;
  return Buffer.byteLength(canonicalJson(shape), "utf8");
}

export function typicalTokens(request: RequestShape): number {
  return Math.ceil(requestBytes(request) / 4);
}

/** Tokens a provider may add around the request (hidden tool-use prompt, message framing). */
export const FRAMING_ALLOWANCE_TOKENS = 1024;

/** Upper bound of billed input tokens: one token per UTF-8 byte of the serialized request, plus the framing allowance. */
export function worstCaseInputTokens(request: RequestShape): number {
  return requestBytes(request) + FRAMING_ALLOWANCE_TOKENS;
}

export function textTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

export function apiKeySecretName(ref: ModelRef): string | null {
  if (ref.apiKeySecret !== undefined) return ref.apiKeySecret;
  switch (ref.provider) {
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "openai-compatible":
      return "OPENAI_API_KEY";
    default:
      return null;
  }
}
