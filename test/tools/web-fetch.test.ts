import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { isRunwrightError } from "../../src/core/errors.ts";
import type { JsonObject } from "../../src/core/json.ts";
import type { RunContext } from "../../src/engine/types.ts";
import { createLogger } from "../../src/log/logger.ts";
import type { ToolContext, ToolOutput } from "../../src/tools/types.ts";
import { createWebFetchTool, nodeTransport, type FetchTransport, type WebFetchDeps } from "../../src/tools/web-fetch.ts";

interface Reply { status?: number; headers?: Record<string, string>; chunks?: string[]; hang?: boolean; fail?: string }
interface Sent { url: string; address: string; family: 4 | 6; headers: Record<string, string> }

function harness(options: {
  dns?: Record<string, string[]>;
  replies?: Record<string, Reply>;
  deps?: Partial<WebFetchDeps>;
  secrets?: Record<string, string>;
  signal?: AbortSignal;
}): { sent: Sent[]; lookups: string[]; closes: number[]; fetch(args: JsonObject): Promise<ToolOutput> } {
  const sent: Sent[] = [];
  const lookups: string[] = [];
  /** How many times the response to `sent[i]` was closed. */
  const closes: number[] = [];
  const dns = options.dns ?? {};
  const replies = options.replies ?? {};
  const transport: FetchTransport = async (request) => {
    const index = sent.length;
    sent.push({ url: request.url.href, address: request.address, family: request.family, headers: request.headers });
    closes[index] = 0;
    const reply = replies[request.url.href] ?? { status: 404, headers: { "content-type": "text/plain" }, chunks: ["not found"] };
    const signal = request.signal;
    async function* body(): AsyncGenerator<Uint8Array> {
      for (const chunk of reply.chunks ?? []) yield new TextEncoder().encode(chunk);
      if (reply.fail !== undefined) throw new Error(reply.fail);
      if (reply.hang === true) {
        await new Promise((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
    }
    return {
      status: reply.status ?? 200,
      headers: reply.headers ?? { "content-type": "text/html; charset=utf-8" },
      body: body(),
      close: () => {
        closes[index] = (closes[index] ?? 0) + 1;
      },
    };
  };
  const tool = createWebFetchTool({
    timeoutMs: 2000,
    maxBytes: 1000,
    maxRedirects: 3,
    lookup: async (hostname) => {
      lookups.push(hostname);
      const addresses = dns[hostname];
      if (addresses === undefined) throw new Error(`ENOTFOUND ${hostname}`);
      return addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    },
    transport,
    ...options.deps,
  });
  const context: ToolContext = {
    runId: "run_1",
    agentId: "agent_1",
    workspace: "/nonexistent",
    signal: options.signal ?? new AbortController().signal,
    logger: createLogger({ write: () => undefined }),
    secrets: options.secrets ?? {},
    steps: { journal: () => [] } as unknown as RunContext,
  };
  return { sent, lookups, closes, fetch: (args) => tool.handler(args, context) };
}

test("the definition is a read tool with untrusted output", () => {
  const tool = createWebFetchTool({ timeoutMs: 1, maxBytes: 1, maxRedirects: 0 });
  assert.equal(tool.name, "web_fetch");
  assert.equal(tool.effect, "read");
  assert.equal(tool.untrustedOutput, true);
  assert.equal(tool.parameters["additionalProperties"], false);
});

test("fetches a public address and connects to the address that was checked", async () => {
  const h = harness({
    dns: { "example.com": ["93.184.216.34"] },
    replies: { "https://example.com/page": { headers: { "content-type": "text/html" }, chunks: ["<p>hello</p>"] } },
  });
  const result = await h.fetch({ url: "https://example.com/page" });
  assert.equal(result.isError, undefined);
  assert.equal(result.untrusted, true);
  assert.equal(result.content, "HTTP 200 https://example.com/page\n<p>hello</p>");
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0]?.address, "93.184.216.34");
  assert.equal(h.sent[0]?.family, 4);
  assert.deepEqual(h.lookups, ["example.com"]);
});

test("refuses hostnames that resolve to blocked addresses", async () => {
  const h = harness({
    dns: {
      "loop.test": ["127.0.0.1"],
      "private.test": ["10.1.2.3"],
      "cgnat.test": ["100.64.1.1"],
      "meta.test": ["169.254.169.254"],
      "mapped.test": ["::ffff:127.0.0.1"],
      "mapped-hex.test": ["::ffff:7f00:1"],
      "v6loop.test": ["::1"],
      "mixed.test": ["93.184.216.34", "192.168.0.10"],
      "mixed-order.test": ["10.0.0.1", "93.184.216.34"],
    },
  });
  for (const host of Object.keys({ "loop.test": 1, "private.test": 1, "cgnat.test": 1, "meta.test": 1, "mapped.test": 1, "mapped-hex.test": 1, "v6loop.test": 1, "mixed.test": 1, "mixed-order.test": 1 })) {
    const result = await h.fetch({ url: `http://${host}/` });
    assert.equal(result.isError, true, host);
    assert.match(result.content, /^ssrf_blocked: /, host);
  }
  assert.equal(h.sent.length, 0);
});

test("literal IP hosts are classified directly, including forms URL normalises", async () => {
  const h = harness({});
  for (const url of ["http://127.0.0.1/", "http://0x7f000001/", "http://2130706433/", "http://0177.0.0.1/", "http://[::1]/",
    "http://[::ffff:127.0.0.1]/", "http://[::ffff:a9fe:a9fe]/", "http://169.254.169.254/latest/meta-data", "http://[fd00:ec2::254]/"]) {
    const result = await h.fetch({ url });
    assert.match(result.content, /^ssrf_blocked: /, url);
  }
  assert.deepEqual(h.lookups, []);
  assert.equal(h.sent.length, 0);
  const pub = harness({ replies: { "http://8.8.8.8/": { headers: { "content-type": "text/plain" }, chunks: ["ok"] } } });
  const result = await pub.fetch({ url: "http://8.8.8.8/" });
  assert.equal(result.content, "HTTP 200 http://8.8.8.8/\nok");
  assert.equal(pub.sent[0]?.address, "8.8.8.8");
});

test("redirects are re-checked at every hop", async () => {
  const h = harness({
    dns: { "a.example": ["93.184.216.34"], "b.example": ["93.184.216.35"], "evil.example": ["10.0.0.5"] },
    replies: {
      "http://a.example/to-ip": { status: 302, headers: { location: "http://127.0.0.1/admin" } },
      "http://a.example/to-host": { status: 301, headers: { location: "http://evil.example/x" } },
      "http://a.example/to-b": { status: 307, headers: { location: "/hop" } },
      "http://a.example/hop": { status: 308, headers: { location: "http://b.example/final" } },
      "http://b.example/final": { headers: { "content-type": "application/json" }, chunks: ["{\"ok\":true}"] },
    },
  });
  const toIp = await h.fetch({ url: "http://a.example/to-ip" });
  assert.match(toIp.content, /^ssrf_blocked: 127\.0\.0\.1 is a loopback address/);
  const toHost = await h.fetch({ url: "http://a.example/to-host" });
  assert.match(toHost.content, /^ssrf_blocked: evil\.example resolves to 10\.0\.0\.5/);
  assert.ok(!h.sent.some((s) => s.url.includes("evil") || s.url.includes("127.0.0.1")));
  const ok = await h.fetch({ url: "http://a.example/to-b" });
  assert.equal(ok.isError, undefined);
  assert.equal(ok.content, "HTTP 200 http://b.example/final\n{\"ok\":true}");
  assert.equal(h.sent.at(-1)?.address, "93.184.216.35");
});

test("the redirect limit is enforced", async () => {
  const replies: Record<string, Reply> = {};
  for (let i = 0; i < 10; i += 1) replies[`http://loop.example/${i}`] = { status: 302, headers: { location: `/${i + 1}` } };
  const h = harness({ dns: { "loop.example": ["93.184.216.34"] }, replies });
  const result = await h.fetch({ url: "http://loop.example/0" });
  assert.equal(result.isError, true);
  assert.match(result.content, /^fetch_failed: too many redirects \(limit 3\)/);
  assert.equal(h.sent.length, 4);
});

test("cross-origin redirects drop caller headers, same-origin ones keep them", async () => {
  const h = harness({
    dns: { "a.example": ["93.184.216.34"], "b.example": ["93.184.216.35"] },
    replies: {
      "http://a.example/1": { status: 302, headers: { location: "/2" } },
      "http://a.example/2": { status: 302, headers: { location: "http://b.example/3" } },
      "http://b.example/3": { headers: { "content-type": "text/plain" }, chunks: ["done"] },
    },
  });
  await h.fetch({ url: "http://a.example/1", headers: { "X-Api-Key": "k1" } });
  assert.deepEqual(h.sent.map((s) => s.headers["x-api-key"]), ["k1", "k1", undefined]);
});

test("the body is capped and truncation is reported", async () => {
  const h = harness({
    dns: { "big.example": ["93.184.216.34"] },
    replies: { "http://big.example/": { headers: { "content-type": "text/plain" }, chunks: ["a".repeat(600), "b".repeat(600), "c".repeat(600)] } },
  });
  const result = await h.fetch({ url: "http://big.example/" });
  assert.equal(result.isError, undefined);
  const [first, body] = [result.content.split("\n")[0], result.content.split("\n")[1] ?? ""];
  assert.equal(first, "HTTP 200 http://big.example/");
  assert.equal(body, "a".repeat(600) + "b".repeat(400));
  assert.match(result.content, /\[truncated: the response was cut at 1000 bytes\]$/);
  assert.equal((result.data as JsonObject)["truncated"], true);
});

test("the text keeps a leading byte order mark and drops a character the size cap cut in two", async () => {
  const h = harness({
    dns: { "bom.example": ["93.184.216.34"], "cut.example": ["93.184.216.34"] },
    replies: {
      "http://bom.example/": { headers: { "content-type": "text/plain" }, chunks: ["\uFEFFhello"] },
      // 999 ASCII bytes, then a 3-byte character of which the cap at 1000 keeps one byte.
      "http://cut.example/": { headers: { "content-type": "text/plain" }, chunks: [`${"a".repeat(999)}\u20AC tail`] },
    },
  });
  const bom = await h.fetch({ url: "http://bom.example/" });
  assert.equal(bom.content, "HTTP 200 http://bom.example/\n\uFEFFhello");
  assert.equal(Buffer.byteLength(bom.content.split("\n")[1] ?? ""), (bom.data as JsonObject)["bytes"], "the text re-encodes to the reported bytes");
  const cut = await h.fetch({ url: "http://cut.example/" });
  const body = cut.content.split("\n")[1] ?? "";
  assert.equal(body, "a".repeat(999));
  assert.ok(!cut.content.includes("\uFFFD"), "no replacement character");
  assert.equal((cut.data as JsonObject)["bytes"], 1000);
  assert.equal((cut.data as JsonObject)["truncated"], true);
});

test("non-text content types are refused by name", async () => {
  const h = harness({
    dns: { "img.example": ["93.184.216.34"] },
    replies: { "http://img.example/x.png": { headers: { "content-type": "image/png" }, chunks: ["\x89PNG"] } },
  });
  const result = await h.fetch({ url: "http://img.example/x.png" });
  assert.equal(result.isError, true);
  assert.match(result.content, /^fetch_failed: unsupported content type image\/png/);
  const xml = harness({
    dns: { "x.example": ["93.184.216.34"] },
    replies: { "http://x.example/": { headers: { "content-type": "application/atom+xml" }, chunks: ["<feed/>"] } },
  });
  assert.equal((await xml.fetch({ url: "http://x.example/" })).isError, undefined);
});

test("the total time limit stops a slow response", async () => {
  const h = harness({
    dns: { "slow.example": ["93.184.216.34"] },
    replies: { "http://slow.example/": { headers: { "content-type": "text/plain" }, chunks: ["partial"], hang: true } },
    deps: { timeoutMs: 50 },
  });
  const started = Date.now();
  const result = await h.fetch({ url: "http://slow.example/" });
  assert.equal(result.isError, true);
  assert.match(result.content, /^fetch_failed: timed out after 50 ms/);
  assert.ok(Date.now() - started < 1500);
});

test("a time limit above the longest single timer does not cut a request short", async () => {
  const h = harness({
    replies: { "http://slow.example/": { headers: { "content-type": "text/plain" }, chunks: ["done"] } },
    deps: {
      timeoutMs: 3_000_000_000,
      lookup: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return [{ address: "93.184.216.34", family: 4 }];
      },
    },
  });
  const result = await h.fetch({ url: "http://slow.example/" });
  assert.equal(result.isError, undefined, result.content);
  assert.equal(result.content, "HTTP 200 http://slow.example/\ndone");
});

test("an aborted run signal ends the call with an aborted error", async () => {
  const controller = new AbortController();
  const h = harness({
    dns: { "slow.example": ["93.184.216.34"] },
    replies: { "http://slow.example/": { headers: { "content-type": "text/plain" }, hang: true } },
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(h.fetch({ url: "http://slow.example/" }), (e: unknown) => isRunwrightError(e) && e.code === "aborted");
});

test("credentials in the URL, other schemes, bad URLs and failed lookups are refused", async () => {
  const h = harness({ dns: { "example.com": ["93.184.216.34"] } });
  assert.match((await h.fetch({ url: "http://user:pass@example.com/" })).content, /^ssrf_blocked: credentials/);
  assert.match((await h.fetch({ url: "http://user@example.com/" })).content, /^ssrf_blocked: credentials/);
  assert.match((await h.fetch({ url: "file:///etc/passwd" })).content, /^ssrf_blocked: scheme file:/);
  assert.match((await h.fetch({ url: "ftp://example.com/" })).content, /^ssrf_blocked: scheme ftp:/);
  assert.match((await h.fetch({ url: "not a url" })).content, /^fetch_failed: /);
  assert.match((await h.fetch({ url: "http://unknown.example/" })).content, /^fetch_failed: could not resolve unknown\.example/);
  assert.equal(h.sent.length, 0);
});

test("secret placeholders in header values are substituted; unknown names and forbidden headers are errors", async () => {
  const h = harness({
    dns: { "api.example": ["93.184.216.34"] },
    replies: { "https://api.example/v1": { headers: { "content-type": "application/json" }, chunks: ["{}"] } },
    secrets: { API_TOKEN: "tok-123456789" },
  });
  const ok = await h.fetch({ url: "https://api.example/v1", headers: { Authorization: "Bearer {{secret:API_TOKEN}}" } });
  assert.equal(ok.isError, undefined);
  assert.equal(h.sent[0]?.headers["authorization"], "Bearer tok-123456789");
  assert.doesNotMatch(ok.content, /tok-123456789/);
  const unknown = await h.fetch({ url: "https://api.example/v1", headers: { Authorization: "Bearer {{secret:NOPE}}" } });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content, /unknown secret NOPE/);
  for (const name of ["Host", "content-length", "Connection"]) {
    const result = await h.fetch({ url: "https://api.example/v1", headers: { [name]: "x" } });
    assert.equal(result.isError, true, name);
    assert.match(result.content, /cannot be set/, name);
  }
  assert.equal(h.sent.length, 1);
});

test("the default transport connects to the pinned address and keeps the hostname in Host", async (t) => {
  let seen: { headers: IncomingHttpHeaders; url: string | undefined } | null = null;
  const server = createServer((req, res) => {
    seen = { headers: req.headers, url: req.url };
    res.writeHead(200, { "content-type": "text/plain", "x-multi": ["a", "b"] });
    res.end("pinned ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  const response = await nodeTransport({
    url: new URL(`http://pinned.invalid:${port}/path?q=1`),
    address: "127.0.0.1",
    family: 4,
    headers: { "x-test": "yes" },
    signal: AbortSignal.timeout(5000),
  });
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.body) chunks.push(chunk);
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "text/plain");
  assert.equal(Buffer.concat(chunks).toString("utf8"), "pinned ok");
  const got = seen as { headers: IncomingHttpHeaders; url: string | undefined } | null;
  assert.equal(got?.headers.host, `pinned.invalid:${port}`);
  assert.equal(got?.headers["x-test"], "yes");
  assert.equal(got?.url, "/path?q=1");
});

// ------------------------------------------------- the time limit and the run's signal cover address resolution

/** A lookup that never settles, and counts its calls. */
function stalledLookup(): { calls: string[]; lookup: NonNullable<WebFetchDeps["lookup"]> } {
  const calls: string[] = [];
  return { calls, lookup: (hostname) => { calls.push(hostname); return new Promise(() => undefined); } };
}

const isAborted = (e: unknown): boolean => isRunwrightError(e) && e.code === "aborted";

test("a lookup that never settles ends at the time limit", { timeout: 5000 }, async () => {
  const stalled = stalledLookup();
  const h = harness({ deps: { timeoutMs: 80, lookup: stalled.lookup } });
  const started = Date.now();
  const result = await h.fetch({ url: "http://stalled.example/" });
  assert.equal(result.isError, true);
  assert.equal(result.content, "fetch_failed: timed out after 80 ms");
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(stalled.calls, ["stalled.example"]);
  assert.equal(h.sent.length, 0);
});

test("a lookup that never settles ends when the run's signal aborts", { timeout: 5000 }, async () => {
  const controller = new AbortController();
  const stalled = stalledLookup();
  const h = harness({ deps: { lookup: stalled.lookup }, signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  const started = Date.now();
  await assert.rejects(h.fetch({ url: "http://stalled.example/" }), isAborted);
  assert.ok(Date.now() - started < 1500);
  assert.equal(h.sent.length, 0);
});

test("an already aborted signal ends the call before the host is resolved", { timeout: 5000 }, async () => {
  const controller = new AbortController();
  controller.abort();
  const stalled = stalledLookup();
  const h = harness({ deps: { lookup: stalled.lookup }, signal: controller.signal });
  await assert.rejects(h.fetch({ url: "http://stalled.example/" }), isAborted);
  assert.deepEqual(stalled.calls, []);
});

test("a redirect whose target never resolves ends at the time limit or on abort", { timeout: 5000 }, async () => {
  const replies: Record<string, Reply> = { "http://a.example/": { status: 302, headers: { location: "http://stalled.example/next" } } };
  const lookup: NonNullable<WebFetchDeps["lookup"]> = (hostname) =>
    hostname === "a.example" ? Promise.resolve([{ address: "93.184.216.34", family: 4 }]) : new Promise(() => undefined);
  const timed = harness({ replies, deps: { timeoutMs: 80, lookup } });
  const started = Date.now();
  assert.equal((await timed.fetch({ url: "http://a.example/" })).content, "fetch_failed: timed out after 80 ms");
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(timed.sent.map((s) => s.url), ["http://a.example/"]);

  const controller = new AbortController();
  const aborted = harness({ replies, deps: { lookup }, signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  const abortStarted = Date.now();
  await assert.rejects(aborted.fetch({ url: "http://a.example/" }), isAborted);
  assert.ok(Date.now() - abortStarted < 1500);
});

test("a lookup that rejects after the time limit fired causes no unhandled rejection", { timeout: 5000 }, async (t) => {
  const unhandled: unknown[] = [];
  const record = (reason: unknown): void => { unhandled.push(reason); };
  process.on("unhandledRejection", record);
  t.after(() => { process.off("unhandledRejection", record); });
  const h = harness({
    deps: {
      timeoutMs: 40,
      lookup: () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error("late ENOTFOUND")), 150)),
    },
  });
  assert.equal((await h.fetch({ url: "http://late.example/" })).content, "fetch_failed: timed out after 40 ms");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(unhandled, []);
});

test("response headers that never arrive end at the time limit, also from a transport that ignores the signal", { timeout: 5000 }, async () => {
  const deaf: FetchTransport = () => new Promise(() => undefined);
  const h = harness({ dns: { "deaf.example": ["93.184.216.34"] }, deps: { timeoutMs: 80, transport: deaf } });
  const started = Date.now();
  assert.equal((await h.fetch({ url: "http://deaf.example/" })).content, "fetch_failed: timed out after 80 ms");
  assert.ok(Date.now() - started < 2000);
});

test("a body that ignores the signal ends at the time limit", { timeout: 5000 }, async () => {
  const deafBody: FetchTransport = async () => ({
    status: 200,
    headers: { "content-type": "text/plain" },
    body: {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
        return: () => Promise.resolve({ done: true as const, value: undefined }),
      }),
    },
    close: () => undefined,
  });
  const h = harness({ dns: { "deaf.example": ["93.184.216.34"] }, deps: { timeoutMs: 80, transport: deafBody } });
  const started = Date.now();
  assert.equal((await h.fetch({ url: "http://deaf.example/" })).content, "fetch_failed: timed out after 80 ms");
  assert.ok(Date.now() - started < 2000);
});

test("the default transport: a server that never sends headers ends at the time limit", { timeout: 5000 }, async (t) => {
  const server = createServer(() => undefined);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const { port } = server.address() as AddressInfo;
  const h = harness({
    dns: { "hang.example": ["93.184.216.34"] },
    deps: { timeoutMs: 100, transport: (request) => nodeTransport({ ...request, address: "127.0.0.1", family: 4 }) },
  });
  const started = Date.now();
  assert.equal((await h.fetch({ url: `http://hang.example:${port}/` })).content, "fetch_failed: timed out after 100 ms");
  assert.ok(Date.now() - started < 2000);
});

// ------------------------------------------- every response the tool does not read to its end is closed (R14D-tools-01)

test("(R14D-tools-01) every response is closed exactly once, on every exit of the call", { timeout: 10_000 }, async () => {
  const dns = { "a.example": ["93.184.216.34"], "blocked.example": ["10.0.0.1"] };
  const text = { "content-type": "text/plain" };
  const cases: { name: string; replies: Record<string, Reply>; url: string; deps?: Partial<WebFetchDeps>; abortAfterMs?: number; expect: RegExp | "aborted"; responses: number }[] = [
    { name: "read to its end", replies: { "http://a.example/": { headers: text, chunks: ["ok"] } }, url: "http://a.example/", expect: /^HTTP 200 /, responses: 1 },
    { name: "a redirect hop", replies: { "http://a.example/": { status: 302, headers: { location: "/b" }, chunks: ["moved"], hang: true }, "http://a.example/b": { headers: text, chunks: ["b"] } }, url: "http://a.example/", expect: /^HTTP 200 http:\/\/a.example\/b\nb$/, responses: 2 },
    { name: "too many redirects", replies: { "http://a.example/": { status: 302, headers: { location: "/" }, hang: true } }, url: "http://a.example/", expect: /too many redirects/, responses: 4 },
    { name: "a redirect to a blocked address", replies: { "http://a.example/": { status: 301, headers: { location: "http://blocked.example/" }, hang: true } }, url: "http://a.example/", expect: /^ssrf_blocked: /, responses: 1 },
    { name: "an unsupported content type", replies: { "http://a.example/": { headers: { "content-type": "image/png" }, chunks: ["\x89PNG"], hang: true } }, url: "http://a.example/", expect: /unsupported content type image\/png/, responses: 1 },
    { name: "over the size limit", replies: { "http://a.example/": { headers: text, chunks: ["x".repeat(600), "y".repeat(600)], hang: true } }, url: "http://a.example/", expect: /\[truncated: the response was cut at 1000 bytes\]$/, responses: 1 },
    { name: "a timeout while the body is read", replies: { "http://a.example/": { headers: text, chunks: ["partial"], hang: true } }, url: "http://a.example/", deps: { timeoutMs: 80 }, expect: /^fetch_failed: timed out after 80 ms$/, responses: 1 },
    { name: "the run aborted while the body is read", replies: { "http://a.example/": { headers: text, chunks: ["partial"], hang: true } }, url: "http://a.example/", abortAfterMs: 50, expect: "aborted", responses: 1 },
    { name: "a body that fails after the headers", replies: { "http://a.example/": { headers: text, chunks: ["partial"], fail: "socket hang up" } }, url: "http://a.example/", expect: /^fetch_failed: socket hang up$/, responses: 1 },
  ];
  for (const item of cases) {
    const controller = new AbortController();
    const h = harness({ dns, replies: item.replies, signal: controller.signal, ...(item.deps === undefined ? {} : { deps: item.deps }) });
    if (item.abortAfterMs !== undefined) setTimeout(() => controller.abort(), item.abortAfterMs);
    if (item.expect === "aborted") {
      await assert.rejects(h.fetch({ url: item.url }), isAborted, item.name);
    } else {
      assert.match((await h.fetch({ url: item.url })).content, item.expect, item.name);
    }
    assert.equal(h.sent.length, item.responses, item.name);
    assert.deepEqual(h.closes, Array.from({ length: item.responses }, () => 1), `${item.name}: every response closed exactly once`);
  }
});

test("(R14D-tools-01) a response that arrives after the call gave up is closed when it arrives", { timeout: 5000 }, async () => {
  let closed = 0;
  const late: FetchTransport = () => new Promise((resolve) => {
    setTimeout(() => resolve({ status: 200, headers: { "content-type": "text/plain" }, body: (async function* () { yield new Uint8Array([1]); })(), close: () => { closed++; } }), 150);
  });
  const h = harness({ dns: { "late.example": ["93.184.216.34"] }, deps: { timeoutMs: 40, transport: late } });
  assert.equal((await h.fetch({ url: "http://late.example/" })).content, "fetch_failed: timed out after 40 ms");
  assert.equal(closed, 0);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(closed, 1);
});

/** A server on port 0 whose handler never ends the body; `closed()` resolves when the server sees the first socket close. */
async function endlessServer(t: TestContext, respond: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ port: number; closed(): Promise<boolean> }> {
  const sockets: Socket[] = [];
  const server = createServer(respond);
  server.on("connection", (socket) => sockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return {
    port: (server.address() as AddressInfo).port,
    closed: async () => {
      const socket = sockets[0];
      if (socket === undefined) return false;
      if (socket.destroyed) return true;
      return Promise.race([once(socket, "close").then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000))]);
    },
  };
}

const pinnedToLocal: FetchTransport = (request) => nodeTransport({ ...request, address: "127.0.0.1", family: 4 });

test("(R14D-tools-01) the default transport: an unread body the server never ends has its socket closed when the call returns", { timeout: 15_000 }, async (t) => {
  const responses: { name: string; respond: (req: IncomingMessage, res: ServerResponse) => void; expect: RegExp; deps?: Partial<WebFetchDeps> }[] = [
    {
      name: "a redirect to a blocked address",
      respond: (_req, res) => { res.writeHead(302, { location: "http://blocked.example/" }); res.write("moving"); },
      expect: /^ssrf_blocked: /,
    },
    {
      name: "an image",
      respond: (_req, res) => { res.writeHead(200, { "content-type": "image/png" }); res.write(Buffer.alloc(64)); },
      expect: /unsupported content type image\/png/,
    },
    {
      name: "a text body over the size limit",
      respond: (_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.write("z".repeat(4096)); },
      expect: /\[truncated: the response was cut at 1000 bytes\]$/,
    },
    {
      name: "a text body that stalls until the time limit",
      respond: (_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.write("slow"); },
      expect: /^fetch_failed: timed out after 300 ms$/,
      deps: { timeoutMs: 300 },
    },
  ];
  for (const item of responses) {
    const server = await endlessServer(t, item.respond);
    const h = harness({ dns: { "endless.example": ["93.184.216.34"], "blocked.example": ["10.0.0.1"] }, deps: { transport: pinnedToLocal, ...item.deps } });
    assert.match((await h.fetch({ url: `http://endless.example:${server.port}/` })).content, item.expect, item.name);
    assert.equal(await server.closed(), true, `${item.name}: the server saw the socket closed`);
  }
});
