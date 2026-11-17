import { test, type TestContext } from "node:test";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import { RunwrightError } from "../../src/core/errors.ts";
import { createClient, encodeFilePath, type RunLimitsInput, type RunwrightClient, type TimelineEvent } from "../../src/client/index.ts";
import { SseParser, type RawSseEvent } from "../../src/client/sse.ts";
import { claim, seedRun, startTestServer, testAgentDefinition } from "../server/support.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): { fetch: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return { fetch: impl, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function rejection(promise: Promise<unknown>): Promise<RunwrightError> {
  const error = await promise.then(() => null, (e: unknown) => e);
  assert.ok(error instanceof RunwrightError, `expected a RunwrightError, got ${String(error)}`);
  return error;
}

test("server errors map to RunwrightError with code, message, details and status", async (t) => {
  const s = await startTestServer(t);
  const notFound = await rejection(s.client.getRun("run_missing"));
  assert.equal(notFound.code, "not_found");
  assert.equal(notFound.status, 404);
  assert.match(notFound.message, /run_missing/);
  const invalid = await rejection(s.client.startRun({ agentId: "" }));
  assert.equal(invalid.code, "validation_failed");
  assert.ok(Array.isArray(invalid.details?.["problems"]));
  const wrongToken = await rejection(createClient({ baseUrl: s.url, token: "nope" }).listAgents());
  assert.equal(wrongToken.code, "unauthorized");
  assert.equal(wrongToken.status, 401);
});

test("an unparsable error body is internal, an unknown code is internal, a network failure is unavailable", async () => {
  const html = createClient({ baseUrl: "http://example.invalid", token: "t", fetch: fakeFetch(() => new Response("<html>bad gateway</html>", { status: 502 })).fetch });
  const htmlError = await rejection(html.health());
  assert.equal(htmlError.code, "internal");
  assert.equal(htmlError.status, 502);
  const odd = createClient({ baseUrl: "http://example.invalid", token: "t", fetch: fakeFetch(() => jsonResponse(418, { error: { code: "teapot", message: "short and stout" } })).fetch });
  const oddError = await rejection(odd.health());
  assert.equal(oddError.code, "internal");
  assert.equal(oddError.message, "short and stout");
  assert.equal(oddError.status, 418);
  const down = createClient({ baseUrl: "http://example.invalid", token: "t", fetch: fakeFetch(() => { throw new TypeError("fetch failed"); }).fetch });
  assert.equal((await rejection(down.health())).code, "unavailable");
});

test("every request carries the token; path parameters are encoded, file paths per segment", async () => {
  const fake = fakeFetch((url) => {
    if (url.includes("/files/")) return new Response("x", { status: 200, headers: { "Content-Type": "text/plain" } });
    return jsonResponse(200, { run: {}, pendings: [], item: {}, command: {}, files: [] });
  });
  const client = createClient({ baseUrl: "http://h:1/", token: "tok", fetch: fake.fetch });
  await client.getRun("a/b?c#d");
  await client.readFile("run 1", "dir one/file#2.txt");
  await client.answer("p&q", "yes");
  await client.retireLearning("lrn 1", "3-abc");
  await client.listRuns({ status: ["queued", "waiting"], limit: 5 });
  assert.deepEqual(fake.calls.map((c) => c.url), [
    "http://h:1/v1/runs/a%2Fb%3Fc%23d",
    "http://h:1/v1/runs/run%201/files/dir%20one/file%232.txt",
    "http://h:1/v1/pendings/p%26q/answer",
    "http://h:1/v1/learning/lrn%201/retire",
    "http://h:1/v1/runs?status=queued%2Cwaiting&limit=5",
  ]);
  for (const call of fake.calls) assert.equal((call.init.headers as Record<string, string>)["Authorization"], "Bearer tok");
  assert.equal((fake.calls[3]?.init.headers as Record<string, string>)["If-Match"], '"3-abc"');
  assert.equal(fake.calls[2]?.init.body, '{"answer":"yes"}');
  assert.equal(encodeFilePath("a b/c"), "a%20b/c");
});

test("waitForRun resolves on completed, failed, waiting and paused, and times out with unavailable", async (t) => {
  const s = await startTestServer(t);
  const outcomes: [string, () => Promise<void>][] = [];
  const completed = await seedRun(s.store, "c");
  const failed = await seedRun(s.store, "f");
  const paused = await seedRun(s.store, "p");
  const queued = await seedRun(s.store, "q");
  outcomes.push(["completed", async () => {
    const { lease } = await claim(s.store, completed.id);
    await s.store.commit(lease, { records: [{ type: "run.completed", data: {} }], transition: { to: "completed", output: 1 } });
  }]);
  outcomes.push(["failed", async () => {
    const { lease } = await claim(s.store, failed.id);
    await s.store.commit(lease, { records: [{ type: "run.failed", data: {} }], transition: { to: "failed", error: { code: "x", message: "boom" } } });
  }]);
  outcomes.push(["paused", async () => {
    const { lease } = await claim(s.store, paused.id);
    await s.store.commit(lease, { records: [{ type: "run.paused", data: {} }], transition: { to: "paused" } });
  }]);
  const runs = [completed, failed, paused];
  for (const [index, [status, act]] of outcomes.entries()) {
    const waiting = s.client.waitForRun((runs[index] as { id: string }).id, { pollMs: 5, timeoutMs: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await act();
    assert.equal((await waiting).run.status, status);
  }
  const started = Date.now();
  const timeout = await rejection(s.client.waitForRun(queued.id, { timeoutMs: 80, pollMs: 10 }));
  assert.equal(timeout.code, "unavailable");
  assert.ok(Date.now() - started >= 70);
  const controller = new AbortController();
  const aborted = s.client.waitForRun(queued.id, { pollMs: 10, signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  assert.equal((await rejection(aborted)).code, "aborted");
});

test("the SSE parser handles any chunking, CRLF, comments, multi-line data and missing ids", () => {
  const stream = ": hello\r\nid: 1\r\nevent: run.created\r\ndata: {\"a\":\r\ndata: 1}\r\n\r\n: ping\n\nevent: delta\ndata: x\n\nid: 2\ndata:no-space\n\nretry: 10\nevent: end\ndata\n\n";
  const expected: RawSseEvent[] = [
    { id: "1", event: "run.created", data: '{"a":\n1}' },
    { id: null, event: "delta", data: "x" },
    { id: "2", event: "message", data: "no-space" },
    { id: null, event: "end", data: "" },
  ];
  const whole = new SseParser();
  assert.deepEqual(whole.push(stream), expected);
  assert.equal(whole.lastEventId, "2");
  for (const size of [1, 2, 3, 7]) {
    const parser = new SseParser();
    const events: RawSseEvent[] = [];
    for (let i = 0; i < stream.length; i += size) events.push(...parser.push(stream.slice(i, i + size)));
    assert.deepEqual(events, expected, `chunk size ${size}`);
  }
  const cr = new SseParser();
  assert.deepEqual([...cr.push("data: a\r"), ...cr.push("\r"), ...cr.push("data: b\r\n\r\n")], [{ id: null, event: "message", data: "a" }, { id: null, event: "message", data: "b" }]);
});

test("followTimeline reconnects once with Last-Event-ID after a dropped connection", async () => {
  const encoder = new TextEncoder();
  const seen: (string | null)[] = [];
  let attempt = 0;
  const fake = fakeFetch((_url, init) => {
    attempt += 1;
    seen.push((init.headers as Record<string, string>)["Last-Event-ID"] ?? null);
    const first = attempt === 1;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (first && pulls === 1) {
          controller.enqueue(encoder.encode('id: 1\nevent: run.created\ndata: {"seq":1}\n\nid: 2\nevent: step.finished\ndata: {"seq":2}\n\nid: 3\nevent: step'));
        } else if (first) {
          controller.error(new TypeError("terminated"));
        } else {
          controller.enqueue(encoder.encode('id: 3\nevent: run.completed\ndata: {"seq":3}\n\nevent: end\ndata: {"status":"completed"}\n\n'));
          controller.close();
        }
      },
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  });
  const client = createClient({ baseUrl: "http://h", token: "t", fetch: fake.fetch });
  const events: TimelineEvent[] = [];
  for await (const event of client.followTimeline("run_1")) events.push(event);
  assert.deepEqual(events.map((e) => [e.id, e.event]), [[1, "run.created"], [2, "step.finished"], [3, "run.completed"], [null, "end"]]);
  assert.deepEqual(seen, [null, "2"]);
});

test("followTimeline gives up when the reconnect brings nothing", async () => {
  const fake = fakeFetch(() => new Response(new ReadableStream<Uint8Array>({ start(c) { c.close(); } }), { status: 200 }));
  const client = createClient({ baseUrl: "http://h", token: "t", fetch: fake.fetch });
  const error = await rejection((async () => {
    for await (const event of client.followTimeline("run_1", { after: 4 })) assert.fail(`unexpected ${event.event}`);
  })());
  assert.equal(error.code, "unavailable");
  assert.equal(fake.calls.length, 2);
  assert.equal((fake.calls[0]?.init.headers as Record<string, string>)["Last-Event-ID"], "4");
});

test("followTimeline stops quietly when its signal aborts", async (t) => {
  const s = await startTestServer(t);
  const run = await seedRun(s.store);
  const controller = new AbortController();
  const events: TimelineEvent[] = [];
  const reading = (async () => {
    for await (const event of s.client.followTimeline(run.id, { signal: controller.signal })) {
      events.push(event);
      controller.abort();
    }
  })();
  await reading;
  assert.deepEqual(events.map((e) => e.event), ["run.created"]);
});

// Every request but the event stream has a time limit that covers its body; a wait is bounded by its signal and
// its deadline even while a request is in flight.

type Behaviour = (req: IncomingMessage, res: ServerResponse) => void;

/** A local server on port 0 with the given behaviour; open connections are cut when the test ends. */
async function localServer(t: TestContext, behaviour: Behaviour): Promise<string> {
  const server = createHttpServer(behaviour);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Accepts the request and never answers. */
const neverAnswers: Behaviour = () => undefined;

/** Sends the headers and part of a JSON body, then stalls. */
const stallsBody: Behaviour = (_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.write('{"run":');
};

function runBody(status: string): string {
  return JSON.stringify({ run: { id: "run_1", status }, pendings: [] });
}

async function timed<T>(work: Promise<T>): Promise<{ error: RunwrightError; ms: number }> {
  const started = performance.now();
  const error = await rejection(work);
  return { error, ms: performance.now() - started };
}

test("waitForRun against a server that never answers rejects with unavailable at its deadline", { timeout: 5000 }, async (t) => {
  const url = await localServer(t, neverAnswers);
  const client = createClient({ baseUrl: url, token: "t" });
  const { error, ms } = await timed(client.waitForRun("run_1", { timeoutMs: 150 }));
  assert.equal(error.code, "unavailable");
  assert.equal(error.message, "run run_1 did not answer within 150 ms");
  assert.ok(ms >= 140 && ms < 2000, `took ${ms} ms`);
});

test("waitForRun with a signal aborted during a stalled request rejects with aborted at once", { timeout: 5000 }, async (t) => {
  const url = await localServer(t, neverAnswers);
  const client = createClient({ baseUrl: url, token: "t" });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const { error, ms } = await timed(client.waitForRun("run_1", { signal: controller.signal }));
  assert.equal(error.code, "aborted");
  assert.ok(ms < 2000, `took ${ms} ms`);
});

test("a settled run that arrives after the deadline is not returned as success", { timeout: 5000 }, async (t) => {
  let requests = 0;
  const url = await localServer(t, (_req, res) => {
    requests += 1;
    setTimeout(() => {
      if (!res.destroyed) res.writeHead(200, { "Content-Type": "application/json" }).end(runBody("completed"));
    }, 1500).unref();
  });
  const client = createClient({ baseUrl: url, token: "t" });
  const { error, ms } = await timed(client.waitForRun("run_1", { timeoutMs: 100 }));
  assert.equal(error.code, "unavailable");
  assert.ok(ms < 1000, `gave up at the deadline, not when the answer came (${ms} ms)`);
  assert.equal(requests, 1);
});

test("a response that an injected fetch delays past the deadline is not waited for", { timeout: 5000 }, async () => {
  const fake = fakeFetch(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1500).unref());
    return jsonResponse(200, { run: { id: "run_1", status: "completed" }, pendings: [] });
  });
  const client = createClient({ baseUrl: "http://h", token: "t", fetch: fake.fetch });
  const { error, ms } = await timed(client.waitForRun("run_1", { timeoutMs: 60 }));
  assert.equal(error.code, "unavailable");
  assert.ok(ms < 1000, `the injected fetch was not waited for (${ms} ms)`);
});

test("waitForRun reports the last status it saw when the deadline passes", async (t) => {
  const url = await localServer(t, (_req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end(runBody("running")));
  const client = createClient({ baseUrl: url, token: "t" });
  const { error } = await timed(client.waitForRun("run_1", { timeoutMs: 120, pollMs: 20 }));
  assert.equal(error.code, "unavailable");
  assert.equal(error.message, "run run_1 is still running after 120 ms");
  assert.deepEqual(error.details, { runId: "run_1", status: "running" });
});

test("waitForRun with timeoutMs 0 has no time left: unavailable without a request", async () => {
  const fake = fakeFetch(() => jsonResponse(200, { run: { id: "run_1", status: "completed" }, pendings: [] }));
  const client = createClient({ baseUrl: "http://h", token: "t", fetch: fake.fetch });
  const error = await rejection(client.waitForRun("run_1", { timeoutMs: 0 }));
  assert.equal(error.code, "unavailable");
  assert.equal(error.message, "run run_1 did not answer within 0 ms");
  assert.equal(fake.calls.length, 0);
});

test("a plain call has a time limit: a server that never answers, or stalls the body, is unavailable", { timeout: 5000 }, async (t) => {
  for (const behaviour of [neverAnswers, stallsBody]) {
    const url = await localServer(t, behaviour);
    const client = createClient({ baseUrl: url, token: "t", requestTimeoutMs: 150 });
    const { error, ms } = await timed(client.getRun("run_1"));
    assert.equal(error.code, "unavailable");
    assert.equal(error.message, `the Runwright server at ${url} did not answer within 150 ms`);
    assert.ok(ms >= 140 && ms < 2000, `took ${ms} ms`);
  }
  const files = await localServer(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.write("partial");
  });
  const error = await rejection(createClient({ baseUrl: files, token: "t", requestTimeoutMs: 150 }).readFile("run_1", "a.txt"));
  assert.equal(error.code, "unavailable");
});

test("an error answer whose body stalls is still the time limit, not an unreadable body", { timeout: 5000 }, async (t) => {
  const url = await localServer(t, (_req, res) => {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.write('{"error":');
  });
  const error = await rejection(createClient({ baseUrl: url, token: "t", requestTimeoutMs: 100 }).health());
  assert.equal(error.code, "unavailable");
  assert.match(error.message, /did not answer within 100 ms/);
});

test("the caller's signal aborts a stalled plain call with aborted", { timeout: 5000 }, async (t) => {
  const url = await localServer(t, stallsBody);
  const fake = fakeFetch((input, init) => fetch(input, init));
  const client = createClient({ baseUrl: url, token: "t", fetch: fake.fetch });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const { error, ms } = await timed(client.waitForRun("run_1", { signal: controller.signal, timeoutMs: 5000 }));
  assert.equal(error.code, "aborted");
  assert.ok(ms < 2000);
  assert.ok(fake.calls[0]?.init.signal instanceof AbortSignal, "the request carries a signal");
});

test("invalid time options are bad_request", async () => {
  const client = createClient({ baseUrl: "http://h", token: "t", fetch: fakeFetch(() => jsonResponse(200, { run: { status: "completed" }, pendings: [] })).fetch });
  for (const timeoutMs of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    assert.equal((await rejection(client.waitForRun("r", { timeoutMs }))).code, "bad_request", `timeoutMs ${timeoutMs}`);
  }
  for (const pollMs of [Number.NaN, -1, Number.POSITIVE_INFINITY, 0]) {
    assert.equal((await rejection(client.waitForRun("r", { pollMs }))).code, "bad_request", `pollMs ${pollMs}`);
  }
  for (const requestTimeoutMs of [Number.NaN, -1, Number.POSITIVE_INFINITY, 0, 2_147_483_648]) {
    assert.throws(() => createClient({ baseUrl: "http://h", token: "t", requestTimeoutMs }), (error: unknown) => {
      return error instanceof RunwrightError && error.code === "bad_request";
    }, `requestTimeoutMs ${requestTimeoutMs}`);
  }
  assert.doesNotThrow(() => createClient({ baseUrl: "http://h", token: "t", requestTimeoutMs: 2_147_483_647 }));
});

test("followTimeline is not cut by requestTimeoutMs", async (t) => {
  const url = await localServer(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(": connected\n\nid: 1\nevent: run.created\ndata: {\"seq\":1}\n\n");
    setTimeout(() => {
      if (res.destroyed) return;
      res.write("id: 2\nevent: run.completed\ndata: {\"seq\":2}\n\n");
      setTimeout(() => {
        if (!res.destroyed) res.end('event: end\ndata: {"status":"completed"}\n\n');
      }, 150);
    }, 350);
  });
  const client = createClient({ baseUrl: url, token: "t", requestTimeoutMs: 100 });
  const events: TimelineEvent[] = [];
  for await (const event of client.followTimeline("run_1")) events.push(event);
  assert.deepEqual(events.map((e) => [e.id, e.event]), [[1, "run.created"], [2, "run.completed"], [null, "end"]]);
});

test("the SSE parser fails the stream on a line or an event longer than its limit", () => {
  const line = new SseParser({ maxEventChars: 64 });
  assert.deepEqual(line.push(`data: ${"x".repeat(40)}\n\n`), [{ id: null, event: "message", data: "x".repeat(40) }]);
  assert.throws(() => line.push("data: " + "y".repeat(100)), (error: unknown) => error instanceof RunwrightError && error.code === "unavailable");
  const many = new SseParser({ maxEventChars: 64 });
  assert.throws(() => {
    for (let i = 0; i < 10; i++) many.push(`data: ${"z".repeat(20)}\n`);
  }, (error: unknown) => error instanceof RunwrightError && error.code === "unavailable");
  assert.throws(() => new SseParser({ maxEventChars: Number.NaN }), (error: unknown) => error instanceof RunwrightError && error.code === "bad_request");
});

test("followTimeline fails with unavailable when the server sends a line with no end", { timeout: 5000 }, async () => {
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(1024 * 1024)));
    },
  });
  const client = createClient({ baseUrl: "http://h", token: "t", fetch: fakeFetch(() => new Response(body, { status: 200 })).fetch });
  const error = await rejection((async () => {
    for await (const event of client.followTimeline("run_1")) assert.fail(`unexpected ${event.event}`);
  })());
  assert.equal(error.code, "unavailable");
  assert.match(error.message, /longer than/);
});

// ------------------------------------------------------------------ complete listings (contract C8)

test("listFiles follows nextCursor and returns all 2 001 files in path order", async (t) => {
  const s = await startTestServer(t);
  const run = await seedRun(s.store);
  const workspace = join(s.dir, "workspaces", run.id);
  await mkdir(join(workspace, "sub"), { recursive: true });
  const names: string[] = [];
  for (let i = 0; i < 2000; i++) names.push(`f${String(i).padStart(4, "0")}.txt`);
  names.push("sub/z-last.txt");
  for (let i = 0; i < names.length; i += 250) await Promise.all(names.slice(i, i + 250).map((name) => writeFile(join(workspace, name), "x")));
  const files = await s.client.listFiles(run.id);
  assert.equal(files.length, 2001);
  assert.deepEqual(files.map((f) => f.path), names);
});

test("listFiles sends each page's cursor and stops at a null nextCursor; a cursor that does not advance is an error", async () => {
  const pages: Record<string, { files: { path: string; size: number; modifiedAt: number }[]; nextCursor: string | null }> = {
    "": { files: [{ path: "a", size: 1, modifiedAt: 1 }], nextCursor: "YQ" },
    YQ: { files: [{ path: "b", size: 1, modifiedAt: 1 }], nextCursor: null },
  };
  const { fetch, calls } = fakeFetch((url) => jsonResponse(200, pages[new URL(url).searchParams.get("cursor") ?? ""]));
  const client = createClient({ baseUrl: "http://runwright.test", token: "t", fetch });
  assert.deepEqual((await client.listFiles("run_1")).map((f) => f.path), ["a", "b"]);
  assert.deepEqual(calls.map((c) => new URL(c.url).search), ["?limit=1000", "?limit=1000&cursor=YQ"]);
  const stuck = fakeFetch(() => jsonResponse(200, { files: [{ path: "a", size: 1, modifiedAt: 1 }], nextCursor: "YQ" }));
  const looping = createClient({ baseUrl: "http://runwright.test", token: "t", fetch: stuck.fetch });
  assert.equal((await rejection(looping.listFiles("run_1"))).code, "internal");
});

test("getRun returns every one of 450 open pendings", async (t) => {
  const s = await startTestServer(t);
  const run = await seedRun(s.store);
  const { lease } = await claim(s.store, run.id);
  for (let start = 0; start < 451; start += 150) {
    const openPendings = Array.from({ length: Math.min(150, 451 - start) }, (_, i) => ({ id: `pnd_c${String(start + i).padStart(4, "0")}`, kind: "question" as const, stepKey: `t1.c${start + i}`, title: "Q", detail: {} }));
    await s.store.commit(lease, { records: [{ type: "step.finished", key: `p${start}`, data: {} }], openPendings });
  }
  await s.store.commit(lease, { records: [{ type: "step.finished", key: "r", data: {} }], resolvePendings: [{ id: "pnd_c0003", resolution: { answer: "x" } }], transition: { to: "waiting" } });
  const { pendings } = await s.client.getRun(run.id);
  assert.equal(pendings.length, 450);
  assert.equal(pendings.some((p) => p.id === "pnd_c0003"), false, "a resolved pending is not listed");
  assert.equal(new Set(pendings.map((p) => p.id)).size, 450);
});

/**
 * Type-level checks of R15D-server-03 (compiled by `npm run typecheck`, never called): a limit cannot be removed
 * over the API, so `null` is not a value the client's limit types allow.
 */
export function limitTypesRefuseNull(client: RunwrightClient): void {
  // @ts-expect-error a limit cannot be removed, only changed
  void client.setLimits("run_x", { maxCostMicros: null });
  // @ts-expect-error a limit cannot be removed, only changed
  void client.startRun({ agentId: "a", limits: { maxTurns: null } });
  // @ts-expect-error allowUnpriced is a boolean
  void client.setLimits("run_x", { allowUnpriced: null });
}

test("(R15D-server-03) every key of RunLimitsInput round-trips through the real server, on run creation and on a limits change", async (t) => {
  const s = await startTestServer(t);
  await s.store.saveAgent({ id: "limits-agent", definition: testAgentDefinition() });
  // Required<>: a key added to RunLimitsInput must be added here, so this test sends every key the type allows.
  const created: Required<RunLimitsInput> = { maxCostMicros: 250_000, maxToolCalls: 7, maxTurns: 3, allowUnpriced: true };
  const { run } = await s.client.startRun({ agentId: "limits-agent", limits: created });
  assert.deepEqual(run.limits, created);
  const changed: Required<RunLimitsInput> = { maxCostMicros: Number.MAX_SAFE_INTEGER, maxToolCalls: 0, maxTurns: 40, allowUnpriced: false };
  const command = await s.client.setLimits(run.id, changed);
  assert.deepEqual(command.command, { type: "limits", limits: changed });
  for (const key of Object.keys(changed) as (keyof RunLimitsInput)[]) {
    const one = await s.client.setLimits(run.id, { [key]: changed[key] });
    assert.deepEqual(one.command, { type: "limits", limits: { [key]: changed[key] } }, key);
  }
  // What the types cannot say, the server checks: a limit is a whole number.
  assert.equal((await rejection(s.client.setLimits(run.id, { maxTurns: 1.5 }))).code, "validation_failed");
  assert.equal((await rejection(s.client.startRun({ agentId: "limits-agent", limits: { maxToolCalls: -1 } }))).code, "validation_failed");
});
