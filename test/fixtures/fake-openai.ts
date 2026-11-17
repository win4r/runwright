/**
 * A fake OpenAI-compatible endpoint for the end-to-end tests (not a test file): a `fetch` to hand to
 * `createApp({ fetch })`. Every request is captured (URL, bearer key, parsed body) and answered by `respond` with
 * a streamed Chat Completions reply: text deltas (each its own SSE event, the byte stream cut into small pieces),
 * then tool calls, then usage. No network is used.
 */
import { fragment, sse } from "../models/fake-fetch.ts";

export interface FakeOpenAiRequest {
  url: string;
  /** The key the provider sent ("" without an Authorization header). */
  bearer: string;
  body: {
    model?: string;
    messages?: { role: string; content: string | null }[];
    tools?: { function: { name: string } }[];
    tool_choice?: { function?: { name?: string } };
  };
  /** The raw request body, as sent. */
  raw: string;
}

export interface FakeOpenAiReply {
  /** Text, one SSE event per entry. */
  deltas?: readonly string[];
  /** Tool calls (also how a structured output is returned: a call of the forced function). */
  calls?: readonly { name: string; args: object }[];
}

export interface FakeOpenAi { fetch: typeof fetch; requests: FakeOpenAiRequest[] }

/** The function the request forces (a structured-output step), or null for an ordinary turn. */
export function forcedFunction(request: FakeOpenAiRequest): string | null {
  return request.body.tool_choice?.function?.name ?? null;
}

/** The content of the last tool message of the request, or null. */
export function lastToolResult(request: FakeOpenAiRequest): string | null {
  const tools = (request.body.messages ?? []).filter((message) => message.role === "tool");
  const last = tools[tools.length - 1];
  return last === undefined ? null : last.content ?? "";
}

function streamOf(reply: FakeOpenAiReply): string[] {
  const events: { data: unknown }[] = (reply.deltas ?? []).map((content) => ({
    data: { choices: [{ index: 0, delta: { content }, finish_reason: null }] },
  }));
  const calls = reply.calls ?? [];
  calls.forEach((call, index) => {
    events.push({
      data: { choices: [{ index: 0, delta: { tool_calls: [{ index, id: `call_${index}`, function: { name: call.name, arguments: JSON.stringify(call.args) } }] }, finish_reason: null }] },
    });
  });
  events.push({ data: { choices: [{ index: 0, delta: {}, finish_reason: calls.length > 0 ? "tool_calls" : "stop" }] } });
  events.push({ data: { choices: [], usage: { prompt_tokens: 12, completion_tokens: 8 } } });
  events.push({ data: "[DONE]" });
  return fragment(sse(events), 11);
}

export function fakeOpenAi(respond: (request: FakeOpenAiRequest, index: number) => FakeOpenAiReply | Promise<FakeOpenAiReply>): FakeOpenAi {
  const requests: FakeOpenAiRequest[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const raw = String(init?.body ?? "");
    const request: FakeOpenAiRequest = {
      url: String(input),
      bearer: (headers.get("authorization") ?? "").replace(/^Bearer /, ""),
      body: JSON.parse(raw) as FakeOpenAiRequest["body"],
      raw,
    };
    requests.push(request);
    const reply = await respond(request, requests.length - 1);
    const encoder = new TextEncoder();
    const chunks = streamOf(reply);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { fetch: impl as typeof fetch, requests };
}
