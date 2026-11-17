import type { ModelRequest, ModelRef } from "../../src/models/types.ts";

export interface CapturedRequest { url: string; headers: Record<string, string>; body: Record<string, unknown> }

export interface FakeReply {
  status?: number;
  headers?: Record<string, string>;
  /** SSE chunks, sent as-is (split points are kept, so tests can fragment events). */
  chunks?: string[];
  /** A plain body (used for errors and non-streaming JSON). */
  text?: string;
  /** Keep the stream open after the chunks (to test abort). */
  hang?: boolean;
  /** Reject the fetch call itself. */
  reject?: Error;
}

export interface FakeFetch { fetch: typeof fetch; calls: CapturedRequest[] }

export function fakeFetch(replies: FakeReply[] | ((call: number) => FakeReply)): FakeFetch {
  const calls: CapturedRequest[] = [];
  const pick = (index: number): FakeReply => {
    if (typeof replies === "function") return replies(index);
    const reply = replies[Math.min(index, replies.length - 1)];
    if (reply === undefined) throw new Error("no fake reply");
    return reply;
  };
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({ url: String(input), headers, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const reply = pick(calls.length - 1);
    if (reply.reject !== undefined) throw reply.reject;
    const signal = init?.signal ?? undefined;
    if (reply.chunks !== undefined) {
      const encoder = new TextEncoder();
      const chunks = reply.chunks;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          if (reply.hang !== true) controller.close();
          else signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
        },
      });
      return new Response(stream, { status: reply.status ?? 200, headers: { "content-type": "text/event-stream", ...reply.headers } });
    }
    return new Response(reply.text ?? "", { status: reply.status ?? 200, headers: { "content-type": "application/json", ...reply.headers } });
  };
  return { fetch: impl as typeof fetch, calls };
}

export function sse(events: { event?: string; data: unknown }[]): string {
  return events
    .map((e) => `${e.event === undefined ? "" : `event: ${e.event}\n`}data: ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}\n\n`)
    .join("");
}

/** Splits text into pieces of `size` characters so events arrive fragmented across reads. */
export function fragment(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

export function makeRequest(model: ModelRef, overrides?: Partial<ModelRequest>): ModelRequest {
  return {
    model,
    system: "You are terse.",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    output: null,
    maxOutputTokens: 256,
    meta: { runId: "run_1", key: "t1", purpose: "run", turn: 1, step: null, attempt: 1 },
    ...overrides,
  };
}

export const signal = (): AbortSignal => new AbortController().signal;
