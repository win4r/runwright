import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { openSqliteStore } from "../../src/store/sqlite.ts";
import type { JournalRecord, Lease, Store } from "../../src/store/types.ts";
import { createServer as createHttpServer } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { createLogger } from "../../src/log/logger.ts";
import { createSseHub, type SseHub } from "../../src/server/sse.ts";
import { SseParser, type RawSseEvent } from "../../src/client/sse.ts";
import type { TimelineEvent } from "../../src/client/index.ts";
import { waitFor } from "../helpers/wait.ts";
import { claim, errorOf, seedRun, startTestServer, type TestServer } from "./support.ts";
import { openTestStore } from "../helpers/store.ts";
import { createRedactor } from "../../src/core/redact.ts";

interface Stream { events: RawSseEvent[]; text: () => string; ended: Promise<void>; close: () => void }

/** Reads an SSE response in the background, keeping the raw text and the parsed events. */
async function openStream(s: TestServer, runId: string, headers?: Record<string, string>, query = ""): Promise<Stream> {
  const controller = new AbortController();
  const response = await fetch(`${s.url}/v1/runs/${runId}/events${query}`, {
    headers: { Authorization: `Bearer ${s.token}`, ...headers }, signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const events: RawSseEvent[] = [];
  let raw = "";
  const parser = new SseParser();
  const decoder = new TextDecoder();
  const ended = (async () => {
    try {
      for await (const chunk of response.body as ReadableStream<Uint8Array>) {
        const text = decoder.decode(chunk, { stream: true });
        raw += text;
        events.push(...parser.push(text));
      }
    } catch {
      // Aborted by close().
    }
  })();
  await waitFor(() => raw.includes(": connected"));
  return { events, text: () => raw, ended, close: () => controller.abort() };
}

async function append(store: Store, lease: Lease, count: number, prefix: string): Promise<JournalRecord[]> {
  const result = await store.commit(lease, { records: Array.from({ length: count }, (_, i) => ({ type: "step.finished", key: `${prefix}${i}`, data: { i } })) });
  return result.records;
}

async function finish(store: Store, lease: Lease): Promise<void> {
  await store.commit(lease, { records: [{ type: "run.completed", data: {} }], transition: { to: "completed", output: "done" } });
}

function journalEvents(events: readonly RawSseEvent[]): RawSseEvent[] {
  return events.filter((e) => e.event !== "delta" && e.event !== "end");
}

test("a stream delivers the backlog, then live records, in order with ids, then end", async (t) => {
  const s = await startTestServer(t);
  const run = await seedRun(s.store);
  const { lease } = await claim(s.store, run.id);
  await append(s.store, lease, 3, "a");
  const collected: TimelineEvent[] = [];
  const reading = (async () => {
    for await (const event of s.client.followTimeline(run.id)) collected.push(event);
  })();
  await waitFor(() => collected.length >= 4);
  await append(s.store, lease, 2, "b");
  await waitFor(() => collected.length >= 6);
  await finish(s.store, lease);
  await reading;
  assert.deepEqual(collected.slice(0, -1).map((e) => e.id), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(collected.slice(0, -1).map((e) => e.event), ["run.created", "step.finished", "step.finished", "step.finished", "step.finished", "step.finished", "run.completed"]);
  const record = collected[1]?.data as unknown as JournalRecord;
  assert.equal(record.seq, 2);
  assert.equal(record.key, "a0");
  assert.deepEqual(collected[collected.length - 1], { id: null, event: "end", data: { status: "completed" } });
});

test("reconnecting with Last-Event-ID delivers exactly the records after it", async (t) => {
  const s = await startTestServer(t);
  const run = await seedRun(s.store);
  const { lease } = await claim(s.store, run.id);
  await append(s.store, lease, 5, "a");
  await finish(s.store, lease);
  const stream = await openStream(s, run.id, { "Last-Event-ID": "3" });
  await stream.ended;
  assert.deepEqual(journalEvents(stream.events).map((e) => e.id), ["4", "5", "6", "7"]);
  assert.equal(stream.events[stream.events.length - 1]?.event, "end");

  const viaQuery = await openStream(s, run.id, {}, "?after=6");
  await viaQuery.ended;
  assert.deepEqual(journalEvents(viaQuery.events).map((e) => e.id), ["7"]);

  const headerWins = await openStream(s, run.id, { "Last-Event-ID": "5" }, "?after=1");
  await headerWins.ended;
  assert.deepEqual(journalEvents(headerWins.events).map((e) => e.id), ["6", "7"]);

  const followed: (number | null)[] = [];
  for await (const event of s.client.followTimeline(run.id, { after: 5 })) followed.push(event.id);
  assert.deepEqual(followed, [6, 7, null]);
});

test("a terminal run that is fully sent ends at once; a bad start position is 400", async (t) => {
  const s = await startTestServer(t);
  const run = await seedRun(s.store);
  const { lease } = await claim(s.store, run.id);
  await finish(s.store, lease);
  const stream = await openStream(s, run.id, { "Last-Event-ID": "2" });
  await stream.ended;
  assert.deepEqual(stream.events, [{ id: null, event: "end", data: '{"status":"completed"}' }]);
  const bad = await fetch(`${s.url}/v1/runs/${run.id}/events`, { headers: { Authorization: `Bearer ${s.token}`, "Last-Event-ID": "-1" } });
  assert.equal((await errorOf(bad)).code, "bad_request");
  const missing = await fetch(`${s.url}/v1/runs/run_nope/events`, { headers: { Authorization: `Bearer ${s.token}` } });
  assert.equal(missing.status, 404);
  await missing.body?.cancel();
});

test("two subscribers of one run receive identical streams", async (t) => {
  const s = await startTestServer(t);
  const run = await seedRun(s.store);
  const { lease } = await claim(s.store, run.id);
  await append(s.store, lease, 2, "a");
  const first = await openStream(s, run.id);
  const second = await openStream(s, run.id);
  for (let i = 0; i < 5; i++) {
    await append(s.store, lease, 3, `live${i}-`);
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
  await finish(s.store, lease);
  await Promise.all([first.ended, second.ended]);
  assert.equal(journalEvents(first.events).length, 1 + 2 + 15 + 1);
  assert.deepEqual(first.events, second.events);
  const ids = journalEvents(first.events).map((e) => Number(e.id));
  assert.deepEqual(ids, Array.from({ length: ids.length }, (_, i) => i + 1));
});

test("records committed through another store handle arrive through polling", async (t) => {
  const s = await startTestServer(t);
  const run = await seedRun(s.store);
  const other = await openSqliteStore({ path: join(s.dir, "runwright.db") });
  t.after(() => other.close());
  const stream = await openStream(s, run.id);
  const claimed = await other.claimRuns({ runnerId: "elsewhere", limit: 1, leaseMs: 60_000 });
  const lease = (claimed[0] as (typeof claimed)[number]).lease;
  await append(other, lease, 2, "x");
  await waitFor(() => journalEvents(stream.events).length === 3, { timeoutMs: 3000 });
  await finish(other, lease);
  await stream.ended;
  assert.deepEqual(journalEvents(stream.events).map((e) => e.id), ["1", "2", "3", "4"]);
  assert.equal(stream.events[stream.events.length - 1]?.data, '{"status":"completed"}');
});

test("model deltas are sent as event: delta with no id", async (t) => {
  const s = await startTestServer(t);
  const run = await seedRun(s.store);
  const stream = await openStream(s, run.id);
  await waitFor(() => stream.events.length >= 1);
  s.events.publish({ runId: run.id, type: "model.delta", key: "t1", text: "Hel" });
  s.events.publish({ runId: "run_other", type: "model.delta", key: "t1", text: "not mine" });
  s.events.publish({ runId: run.id, type: "model.delta", key: "t1", text: "lo" });
  await waitFor(() => stream.events.filter((e) => e.event === "delta").length === 2);
  const deltas = stream.events.filter((e) => e.event === "delta");
  assert.deepEqual(deltas.map((e) => e.id), [null, null]);
  assert.deepEqual(deltas.map((e) => JSON.parse(e.data).text), ["Hel", "lo"]);
  assert.ok(!/id: [^\n]*\nevent: delta/.test(stream.text()));
  stream.close();
  await stream.ended;
});

test("pings keep the stream alive and closing the server ends open streams", async (t) => {
  const s = await startTestServer(t, { configure: (c) => { c.server.ssePingMs = 20; } });
  const run = await seedRun(s.store);
  const stream = await openStream(s, run.id);
  await waitFor(() => stream.text().includes(": ping"));
  await s.server.close();
  await stream.ended;
  assert.ok(stream.text().includes("id: 1\nevent: run.created\n"));
});

test("a ping period above the longest single timer sends no ping instead of one every millisecond", async (t) => {
  const s = await startTestServer(t, { configure: (c) => { c.server.ssePingMs = 3_000_000_000; } });
  const run = await seedRun(s.store);
  const stream = await openStream(s, run.id);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((stream.text().match(/: ping/g) ?? []).length, 0);
  stream.close();
  await stream.ended;
});

interface HubServer {
  hub: SseHub; store: Store; url: string; port: number;
  /** Lines the hub logged at warn level. */
  warnings: () => string[];
  /** How many `res.write` calls of the hub returned false (the response went above its high-water mark). */
  refusals: () => number;
}

/** A bare HTTP server that streams one run through a hub; `?after=` is the start position. */
async function hubServer(t: import("node:test").TestContext, options: { drainTimeoutMs?: number } = {}): Promise<HubServer> {
  const { store } = await openTestStore(t);
  const lines: string[] = [];
  let refused = 0;
  const hub = createSseHub({
    store, events: null, logger: createLogger({ write: (line) => void lines.push(line) }), pollMs: 20, pingMs: 60_000,
    redact: (text) => text, ...options,
  });
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://hub");
    const after = Number(url.searchParams.get("after") ?? "0");
    const write = res.write.bind(res) as (chunk: string) => boolean;
    (res as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
      const accepted = write(chunk);
      if (!accepted) refused += 1;
      return accepted;
    };
    void store.getRun(url.pathname.slice(1)).then((run) => {
      if (run !== null) return hub.subscribe(req, res, "req_test", run, after);
      res.writeHead(404).end();
      return undefined;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    hub.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    hub, store, url: `http://127.0.0.1:${port}`, port,
    warnings: () => lines.filter((line) => JSON.parse(line).level === "warn"),
    refusals: () => refused,
  };
}

test("a client that disconnects is removed from the registry", async (t) => {
  const { hub, store, url } = await hubServer(t);
  const run = await seedRun(store);
  const controller = new AbortController();
  const response = await fetch(`${url}/${run.id}`, { signal: controller.signal });
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  await reader.read();
  await waitFor(() => hub.size() === 1);
  controller.abort();
  await reader.read().catch(() => undefined);
  await waitFor(() => hub.size() === 0, { message: "the subscriber was not removed" });
});

// ------------------------------------------------------------------ backpressure (finding R13D-server-01)

const PAD = "x".repeat(4000);

/** Commits `count` records of about 4 KB each in one batch. */
async function bigCommit(store: Store, lease: Lease, count: number, prefix: string): Promise<void> {
  await store.commit(lease, { records: Array.from({ length: count }, (_, i) => ({ type: "step.finished", key: `${prefix}${i}`, data: { pad: PAD } })) });
}

/** The seqs of the journal events of a stream, as numbers. */
function seqs(events: readonly RawSseEvent[]): number[] {
  return journalEvents(events).map((e) => Number(e.id));
}

function oneToN(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i + 1);
}

interface RawStream { events: () => RawSseEvent[]; closed: Promise<void>; isClosed: () => boolean; pause: () => void; resume: () => void; destroy: () => void }

/**
 * A subscriber over a bare TCP socket (HTTP/1.0, so the body is the raw event stream). It can be paused, which
 * stops reading from the socket: the server's writes then fill the socket buffers.
 */
async function rawStream(port: number, path: string): Promise<RawStream> {
  const socket = connect(port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  let raw = "";
  let closed = false;
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    raw += chunk;
  });
  socket.on("error", () => undefined);
  const ended = new Promise<void>((resolve) => socket.once("close", () => {
    closed = true;
    resolve();
  }));
  socket.write(`GET ${path} HTTP/1.0\r\nHost: hub\r\n\r\n`);
  await waitFor(() => raw.includes(": connected"));
  return {
    events: () => {
      const body = raw.slice(raw.indexOf("\r\n\r\n") + 4);
      return new SseParser().push(body);
    },
    closed: ended, isClosed: () => closed,
    pause: () => socket.pause(), resume: () => socket.resume(), destroy: () => socket.destroy(),
  };
}

test("a normally reading client receives a backlog of more than 1 MiB completely and in order, then live records, then end", async (t) => {
  const { store, url } = await hubServer(t);
  const run = await seedRun(store);
  const { lease } = await claim(store, run.id);
  await bigCommit(store, lease, 600, "backlog");
  const stream = await readHub(url, run.id, 0);
  await waitFor(() => seqs(stream.events).length === 601 || stream.isEnded(), { timeoutMs: 10_000 });
  assert.equal(stream.isEnded(), false, "the healthy client was not cut off");
  await append(store, lease, 3, "live");
  await finish(store, lease);
  await stream.ended;
  assert.deepEqual(seqs(stream.events), oneToN(605));
  assert.deepEqual(stream.events[stream.events.length - 1], { id: null, event: "end", data: '{"status":"completed"}' });
});

test("one commit of 600 records of 4 KB is delivered live, completely, to a connected healthy reader", async (t) => {
  const { store, url } = await hubServer(t);
  const run = await seedRun(store);
  const { lease } = await claim(store, run.id);
  const stream = await readHub(url, run.id, 0);
  await waitFor(() => seqs(stream.events).length === 1);
  await bigCommit(store, lease, 600, "live");
  await finish(store, lease);
  await stream.ended;
  assert.deepEqual(seqs(stream.events), oneToN(602));
  assert.equal(stream.events[stream.events.length - 1]?.event, "end");
});

test("a client that stops reading is dropped after drainTimeoutMs, once, and the other subscribers are unaffected", async (t) => {
  const { hub, store, url, port, warnings, refusals } = await hubServer(t, { drainTimeoutMs: 200 });
  const run = await seedRun(store);
  const { lease } = await claim(store, run.id);
  const healthy = await readHub(url, run.id, 0);
  const stalled = await rawStream(port, `/${run.id}`);
  stalled.pause();
  await waitFor(() => hub.size() === 2);
  let commits = 0;
  // Loopback socket buffers can hold a few MiB: keep committing until the stalled reader really blocks.
  while (warnings().length === 0 && commits < 40) {
    await bigCommit(store, lease, 200, `c${commits}-`);
    commits += 1;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  await waitFor(() => warnings().length > 0, { timeoutMs: 3000, message: "the stalled client was never dropped" });
  assert.ok(refusals() > 0, "a write went above the high-water mark");
  await waitFor(() => hub.size() === 1);
  // A paused socket does not see the end of the connection until it reads again.
  stalled.resume();
  await stalled.closed;
  assert.ok(seqs(stalled.events()).length < 1 + commits * 200, "the stalled client was cut off");
  await finish(store, lease);
  await healthy.ended;
  assert.deepEqual(seqs(healthy.events), oneToN(1 + commits * 200 + 1), "the healthy subscriber got everything");
  assert.equal(healthy.events[healthy.events.length - 1]?.event, "end");
  assert.equal(warnings().length, 1, "the warning is logged once");
  assert.match(warnings()[0] ?? "", /sse subscriber dropped: client too slow/);
});

test("a client that stalls for less than drainTimeoutMs and resumes gets every record once, with no gap", async (t) => {
  const { store, port, warnings, refusals } = await hubServer(t, { drainTimeoutMs: 5000 });
  const run = await seedRun(store);
  const { lease } = await claim(store, run.id);
  const stream = await rawStream(port, `/${run.id}`);
  stream.pause();
  let commits = 0;
  while (refusals() === 0 && commits < 40) {
    await bigCommit(store, lease, 200, `s${commits}-`);
    commits += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(refusals() > 0, "the stalled reader blocked the hub's writes");
  await bigCommit(store, lease, 600, "while-blocked-");
  await new Promise((resolve) => setTimeout(resolve, 300));
  stream.resume();
  await finish(store, lease);
  await stream.closed;
  assert.deepEqual(seqs(stream.events()), oneToN(1 + commits * 200 + 600 + 1));
  assert.equal(stream.events()[stream.events().length - 1]?.event, "end");
  assert.deepEqual(warnings(), []);
});

test("resuming from an event id in the middle of a large backlog delivers exactly the records after it", async (t) => {
  const { store, url } = await hubServer(t);
  const run = await seedRun(store);
  const { lease } = await claim(store, run.id);
  await bigCommit(store, lease, 900, "b");
  await finish(store, lease);
  const stream = await readHub(url, run.id, 300);
  await stream.ended;
  assert.deepEqual(seqs(stream.events), oneToN(902).slice(300));
  assert.equal(stream.events[stream.events.length - 1]?.event, "end");
});

test("close() with a blocked subscriber clears its drain timer and ends the stream", async (t) => {
  const DRAIN_MS = 54_321;
  const created = new Set<unknown>();
  const cleared = new Set<unknown>();
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    const handle = realSet(fn, ms);
    if (ms === DRAIN_MS) created.add(handle);
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle?: Parameters<typeof clearTimeout>[0]) => {
    if (created.has(handle)) cleared.add(handle);
    realClear(handle);
  }) as typeof clearTimeout;
  t.after(() => {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  });
  const { hub, store, port, refusals } = await hubServer(t, { drainTimeoutMs: DRAIN_MS });
  const run = await seedRun(store);
  const { lease } = await claim(store, run.id);
  const stream = await rawStream(port, `/${run.id}`);
  stream.pause();
  let commits = 0;
  const armed = (): boolean => [...created].some((handle) => !cleared.has(handle));
  while (!armed() && commits < 40) {
    await bigCommit(store, lease, 200, `k${commits}-`);
    commits += 1;
    await new Promise((resolve) => realSet(resolve, 20));
  }
  assert.ok(refusals() > 0, "the subscriber is blocked");
  assert.ok(armed(), "a drain timer is armed while the subscriber is blocked");
  hub.close();
  assert.equal(hub.size(), 0);
  assert.deepEqual([...created].filter((handle) => !cleared.has(handle)), [], "every drain timer was cleared");
  stream.destroy();
  await stream.closed;
});

test("a client that disconnects is cleaned up", async (t) => {
  const s = await startTestServer(t);
  const run = await seedRun(s.store);
  const stream = await openStream(s, run.id);
  stream.close();
  await stream.ended;
  const { lease } = await claim(s.store, run.id);
  await append(s.store, lease, 2, "after");
  const fresh = await openStream(s, run.id);
  await waitFor(() => journalEvents(fresh.events).length === 3);
  fresh.close();
  await fresh.ended;
});

// A hub over a store whose commits are never announced to it: the way a runner in another process looks to the
// server. Everything a subscriber receives comes from a poll, or from another subscriber connecting.

interface HubStream { events: RawSseEvent[]; text: () => string; ended: Promise<void>; isEnded: () => boolean; close: () => void }

async function quietHub(t: import("node:test").TestContext, pollMs: number, redact: (text: string) => string = (text) => text): Promise<{ store: Store; url: string; dir: string }> {
  const { store, dir } = await openTestStore(t);
  const quiet = new Proxy(store, {
    get(target, property) {
      if (property === "subscribe") return () => () => undefined;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const hub = createSseHub({ store: quiet, events: null, logger: createLogger({ write: () => undefined }), pollMs, pingMs: 60_000, redact });
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://hub");
    const after = Number(url.searchParams.get("after") ?? "0");
    void store.getRun(url.pathname.slice(1)).then((run) => {
      if (run !== null) return hub.subscribe(req, res, "req_test", run, after);
      res.writeHead(404).end();
      return undefined;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    hub.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { store, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, dir };
}

async function readHub(url: string, runId: string, after: number): Promise<HubStream> {
  const controller = new AbortController();
  const response = await fetch(`${url}/${runId}?after=${after}`, { signal: controller.signal });
  const events: RawSseEvent[] = [];
  let raw = "";
  let done = false;
  const parser = new SseParser();
  const decoder = new TextDecoder();
  const ended = (async () => {
    try {
      for await (const chunk of response.body as ReadableStream<Uint8Array>) {
        const text = decoder.decode(chunk, { stream: true });
        raw += text;
        events.push(...parser.push(text));
      }
    } catch {
      // Aborted by close().
    } finally {
      done = true;
    }
  })();
  await waitFor(() => raw.includes(": connected"));
  return { events, text: () => raw, ended, isEnded: () => done, close: () => controller.abort() };
}

test("a subscriber that was behind when another connected to the finished run still gets the rest and end", async (t) => {
  const { store, url } = await quietHub(t, 1000);
  const run = await seedRun(store);
  const a = await readHub(url, run.id, 0);
  await waitFor(() => journalEvents(a.events).length === 1);
  const { lease } = await claim(store, run.id);
  await finish(store, lease);
  const b = await readHub(url, run.id, 0);
  await waitFor(() => a.isEnded() && b.isEnded(), { timeoutMs: 2500, message: "a subscriber was left open" });
  for (const stream of [a, b]) {
    assert.deepEqual(journalEvents(stream.events).map((e) => e.id), ["1", "2"]);
    assert.deepEqual(stream.events[stream.events.length - 1], { id: null, event: "end", data: '{"status":"completed"}' });
  }
});

test("three staggered subscribers each receive exactly the records after their position, once, in order, then end", async (t) => {
  const { store, url } = await quietHub(t, 150);
  const run = await seedRun(store);
  const { lease } = await claim(store, run.id);
  const first = await readHub(url, run.id, 0);
  await append(store, lease, 1, "a");
  const second = await readHub(url, run.id, 1);
  await append(store, lease, 2, "b");
  await finish(store, lease);
  const third = await readHub(url, run.id, 2);
  await waitFor(() => first.isEnded() && second.isEnded() && third.isEnded(), { timeoutMs: 2500, message: "a subscriber was left open" });
  const expected: [HubStream, string[]][] = [[first, ["1", "2", "3", "4", "5"]], [second, ["2", "3", "4", "5"]], [third, ["3", "4", "5"]]];
  for (const [stream, ids] of expected) {
    assert.deepEqual(journalEvents(stream.events).map((e) => e.id), ids);
    assert.equal(stream.events[stream.events.length - 1]?.event, "end");
    assert.equal(stream.events.filter((e) => e.event === "end").length, 1);
  }
});

test("a subscriber that connects to a finished, archived run gets end at once", async (t) => {
  const { store, url, dir } = await quietHub(t, 10_000);
  const run = await seedRun(store);
  const { lease } = await claim(store, run.id);
  await append(store, lease, 2, "a");
  await finish(store, lease);
  const finished = await store.getRun(run.id);
  await store.archiveJournal(run.id, { path: join(dir, "archive.jsonl"), records: 4, lastSeq: finished!.journalSeq });
  const archived = await store.getRun(run.id);
  assert.notEqual(archived?.journalArchivedAt, null);
  const started = Date.now();
  const stream = await readHub(url, run.id, 0);
  await stream.ended;
  assert.ok(Date.now() - started < 2000, "the end came long before the first poll");
  assert.deepEqual(stream.events, [{ id: null, event: "end", data: '{"status":"completed"}' }]);
});

test("an event's data line is redacted as a value: a numeric secret and a string secret are gone and it parses", async (t) => {
  const redactor = createRedactor({ PIN: "12345678", WORD: 'secret"word', SHAPE: '"data":{' });
  const { store, url } = await quietHub(t, 50, (text) => redactor.text(text));
  const run = await seedRun(store);
  const { lease } = await claim(store, run.id);
  await store.commit(lease, { records: [{ type: "limits.changed", data: { limits: { maxCostMicros: 12345678 }, note: 'a secret"word b', other: 5 } }] });
  await finish(store, lease);
  const stream = await readHub(url, run.id, 1);
  await stream.ended;
  const event = journalEvents(stream.events)[0]!;
  assert.equal(event.event, "limits.changed");
  assert.equal(event.data.includes("12345678"), false);
  assert.equal(event.data.includes('secret\\"word'), false);
  const record = JSON.parse(event.data) as { seq: number; type: string; data: Record<string, unknown> };
  assert.equal(record.seq, 2);
  assert.deepEqual(record.data, { limits: { maxCostMicros: "[redacted:PIN]" }, note: "a [redacted:WORD] b", other: 5 });
  assert.match(stream.text(), /^id: 2\nevent: limits\.changed\ndata: \{/m);
});

test("a delta event is redacted as a value and parses", async (t) => {
  const s = await startTestServer(t);
  await s.secrets.set("PIN", "12345678");
  await s.secrets.set("WORD", 'secret"word');
  await s.secrets.set("SHAPE", '"text":"');
  const run = await seedRun(s.store);
  const stream = await openStream(s, run.id);
  await waitFor(() => stream.events.length >= 1);
  s.events.publish({ runId: run.id, type: "model.delta", key: "t1", text: 'pin 12345678 and secret"word' });
  await waitFor(() => stream.events.some((e) => e.event === "delta"));
  const delta = stream.events.find((e) => e.event === "delta")!;
  assert.equal(delta.data.includes("12345678"), false);
  assert.deepEqual(JSON.parse(delta.data), { runId: run.id, key: "t1", text: "pin [redacted] and [redacted]" });
  stream.close();
  await stream.ended;
});
