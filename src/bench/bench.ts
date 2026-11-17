/**
 * `npm run bench` / `runwright bench`: measures this build on this machine and returns one report. Every
 * measurement uses its own fresh temporary data directory, removed afterwards. Sizes are full / quick:
 *
 * - runsPerSecond: N (400 / 40) runs of a two-turn scripted agent (turn 1 calls write_file, turn 2 ends) through
 *   one in-process runner at concurrency 1, 4, 16, 64 (quick: 1, 8); wall time from the first createRun until
 *   the store's journal events report every run completed.
 * - journalAppendsPerSecond: store.commit on a claimed run, one record per commit (20 000 / 1 000 commits) and
 *   eight records per commit (the same number of records).
 * - enqueueToClaimMs: an idle in-process runner; for each of 500 / 50 runs, from just before createRun to the
 *   run.claimed record arriving through store.subscribe. Each run completes before the next sample starts.
 * - recovery: a child runner process (src/bench/worker.ts, lease 1000 ms) claims N (50 / 8) runs whose first
 *   model turn sleeps 1500 ms, is SIGKILLed, and an in-process runner takes the runs over once the leases
 *   expire. The re-issued first turn sleeps again, so killToAllCompletedMs includes one modelDelayMs.
 * - sseFanout: a real server on port 0 and K (50 / 5) raw HTTP subscribers on one run's event stream; E
 *   (200 / 20) records committed one at a time, each stamped with process.hrtime.bigint(); latency from the
 *   stamp to the moment a subscriber's socket delivers the event. The next record is committed once every
 *   subscriber has received the previous one, so the figure is per-event fan-out latency, not queueing.
 *
 * Only numbers this code measured go into the report; it makes no comparison with anything else.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { request, type ClientRequest, type IncomingMessage } from "node:http";
import { cpus, platform, arch, tmpdir, totalmem } from "node:os";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { systemClock } from "../core/clock.ts";
import { RunwrightError } from "../core/errors.ts";
import { isJsonObject, type JsonObject } from "../core/json.ts";
import { createSecretsService } from "../security/secrets.ts";
import { generateSealKey } from "../security/seal.ts";
import { generateToken } from "../security/token.ts";
import { createServer } from "../server/index.ts";
import type { Lease, RunStatus, Store, StoreEvent } from "../store/types.ts";
import { openBenchEnv, oneTurnAgent, writeFileAgent, type BenchEnv } from "./compose.ts";
import { nsToMs, round3, summarize } from "./stats.ts";

export interface BenchReport { machine: JsonObject; startedAt: string; quick: boolean; results: JsonObject }
export interface BenchOptions {
  quick: boolean;
  /** Progress lines (one measurement each); the CLI and main.ts send them to stderr. Default: silent. */
  progress?: (line: string) => void;
}

interface Sizes {
  concurrencies: number[]; runs: number; appends: number; claimSamples: number;
  recoveryRuns: number; subscribers: number; events: number;
}

const FULL: Sizes = { concurrencies: [1, 4, 16, 64], runs: 400, appends: 20_000, claimSamples: 500, recoveryRuns: 50, subscribers: 50, events: 200 };
const QUICK: Sizes = { concurrencies: [1, 8], runs: 40, appends: 1_000, claimSamples: 50, recoveryRuns: 8, subscribers: 5, events: 20 };

const BATCH = 8;
const RECOVERY_LEASE_MS = 1000;
const RECOVERY_MODEL_DELAY_MS = 1500;
const BENCH_POLL_MS = 20;
const IDLE_LEASE_MS = 30_000;
const WAIT_MS = 120_000;

const WORKER_PATH = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url));
const CONSOLE_PATH = fileURLToPath(new URL("../console/index.html", import.meta.url));

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RunwrightError("unavailable", `bench: timed out after ${ms} ms waiting for ${what}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function inBenchEnv<T>(fn: (env: BenchEnv) => Promise<T>): Promise<T> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "runwright-bench-")));
  try {
    const env = await openBenchEnv(dir);
    try {
      return await fn(env);
    } finally {
      await env.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

const UNEXPECTED: readonly RunStatus[] = ["failed", "cancelled", "waiting", "paused"];

/**
 * Resolves once `count` distinct runs reached `completed` according to the store's journal events; rejects as
 * soon as a run ends any other way the benchmark did not plan for.
 */
function awaitCompletions(store: Store, count: number): { done: Promise<void>; dispose: () => void } {
  const completed = new Set<string>();
  let resolve: () => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const done = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const unsubscribe = store.subscribe((event: StoreEvent) => {
    if (event.type !== "journal") return;
    if (event.status === "completed") {
      completed.add(event.runId);
      if (completed.size >= count) resolve();
    } else if (UNEXPECTED.includes(event.status)) {
      reject(new RunwrightError("internal", `bench: run ${event.runId} ended ${event.status}`, { details: { runId: event.runId } }));
    }
  });
  return { done, dispose: unsubscribe };
}

/** Guards the measurement: a measured run really took two model turns and made its one write_file call. */
async function assertRunShape(store: Store, agentId: string): Promise<void> {
  const page = await store.listRuns({ agentId }, { limit: 1 });
  const run = page.items[0];
  if (run === undefined || run.usage.turns !== 2 || run.usage.toolCalls !== 1) {
    throw new RunwrightError("internal", "bench: a measured run did not take the scripted two-turn path", {
      details: { runId: run?.id ?? null, turns: run?.usage.turns ?? null, toolCalls: run?.usage.toolCalls ?? null },
    });
  }
}

async function measureRunsPerSecond(concurrency: number, runs: number): Promise<JsonObject> {
  return inBenchEnv(async (env) => {
    const { agent } = await env.store.saveAgent({ id: "bench-writer", definition: writeFileAgent() });
    const runner = env.makeRunner({ concurrency, leaseMs: IDLE_LEASE_MS, pollMs: env.config.runner.pollMs });
    runner.start();
    const watch = awaitCompletions(env.store, runs);
    try {
      const started = performance.now();
      for (let i = 0; i < runs; i++) {
        await env.store.createRun({ agentId: agent.id, input: { message: `bench run ${i}`, data: null } });
      }
      await withTimeout(watch.done, WAIT_MS, `${runs} runs at concurrency ${concurrency}`);
      const seconds = (performance.now() - started) / 1000;
      await assertRunShape(env.store, agent.id);
      return { concurrency, runs, seconds: round3(seconds), runsPerSecond: round3(runs / seconds) };
    } finally {
      watch.dispose();
    }
  });
}

async function claimForBench(env: BenchEnv, runnerId: string): Promise<Lease> {
  const { agent } = await env.store.saveAgent({ id: "bench-target", definition: oneTurnAgent() });
  await env.store.createRun({ agentId: agent.id, input: { message: "bench target", data: null } });
  const [claimed] = await env.store.claimRuns({ runnerId, limit: 1, leaseMs: 3_600_000 });
  if (claimed === undefined) throw new RunwrightError("internal", "bench: could not claim the target run");
  return claimed.lease;
}

async function measureJournalAppends(records: number): Promise<JsonObject> {
  return inBenchEnv(async (env) => {
    const lease = await claimForBench(env, "bench-appender");
    let started = performance.now();
    for (let i = 0; i < records; i++) {
      await env.store.commit(lease, { records: [{ type: "bench.append", key: `single.${i}`, data: { i } }] });
    }
    const singleSeconds = (performance.now() - started) / 1000;

    const commits = Math.ceil(records / BATCH);
    started = performance.now();
    for (let c = 0; c < commits; c++) {
      const batch = Array.from({ length: BATCH }, (_, j) => ({ type: "bench.append", key: `batch.${c}.${j}`, data: { c, j } }));
      await env.store.commit(lease, { records: batch });
    }
    const batchSeconds = (performance.now() - started) / 1000;
    return {
      singleRecordCommits: round3(records / singleSeconds),
      batchedRecords: round3((commits * BATCH) / batchSeconds),
      recordsPerBatch: BATCH,
      records,
    };
  });
}

async function measureEnqueueToClaim(samples: number): Promise<JsonObject> {
  return inBenchEnv(async (env) => {
    const { agent } = await env.store.saveAgent({ id: "bench-one-turn", definition: oneTurnAgent() });
    const runner = env.makeRunner({ concurrency: 4, leaseMs: IDLE_LEASE_MS, pollMs: env.config.runner.pollMs });
    const claimedAt = new Map<string, number>();
    const completed = new Set<string>();
    const waiters = new Map<string, () => void>();
    const unsubscribe = env.store.subscribe((event) => {
      if (event.type !== "journal") return;
      const now = performance.now();
      if (!claimedAt.has(event.runId) && event.records.some((r) => r.type === "run.claimed")) claimedAt.set(event.runId, now);
      if (event.status === "completed") completed.add(event.runId);
      waiters.get(event.runId)?.();
    });
    const until = (runId: string, ready: () => boolean, what: string): Promise<void> => {
      if (ready()) return Promise.resolve();
      return withTimeout(new Promise<void>((resolve) => {
        waiters.set(runId, () => {
          if (ready()) {
            waiters.delete(runId);
            resolve();
          }
        });
      }), WAIT_MS, what);
    };
    runner.start();
    try {
      const latencies: number[] = [];
      for (let i = 0; i < samples; i++) {
        const before = performance.now();
        const { run } = await env.store.createRun({ agentId: agent.id, input: { message: `claim ${i}`, data: null } });
        await until(run.id, () => claimedAt.has(run.id), `run ${run.id} to be claimed`);
        latencies.push((claimedAt.get(run.id) as number) - before);
        await until(run.id, () => completed.has(run.id), `run ${run.id} to complete`);
      }
      return { ...summarize(latencies) };
    } finally {
      unsubscribe();
    }
  });
}

interface WorkerHandle { child: ChildProcess; exited: Promise<void>; stderr: () => string }

function spawnWorker(dataDir: string, runnerId: string, concurrency: number): WorkerHandle {
  const child = spawn(process.execPath, [
    "--disable-warning=ExperimentalWarning", WORKER_PATH,
    "--data-dir", dataDir, "--runner-id", runnerId, "--lease-ms", String(RECOVERY_LEASE_MS),
    "--concurrency", String(concurrency), "--poll-ms", String(BENCH_POLL_MS),
  ], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-8192);
  });
  child.stdout?.resume();
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
  return { child, exited, stderr: () => stderr };
}

async function killWorker(worker: WorkerHandle): Promise<void> {
  if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill("SIGKILL");
  await worker.exited;
}

async function measureRecovery(runs: number): Promise<JsonObject> {
  return inBenchEnv(async (env) => {
    const { agent } = await env.store.saveAgent({ id: "bench-slow-writer", definition: writeFileAgent(RECOVERY_MODEL_DELAY_MS) });
    const runIds: string[] = [];
    for (let i = 0; i < runs; i++) {
      const { run } = await env.store.createRun({ agentId: agent.id, input: { message: `recover ${i}`, data: null } });
      runIds.push(run.id);
    }
    const childRunnerId = `bench-worker-${process.pid}-${Date.now().toString(36)}`;
    const worker = spawnWorker(env.dataDir, childRunnerId, runs);
    const reclaimed = new Set<string>();
    const completed = new Set<string>();
    let unsubscribe: (() => void) | null = null;
    try {
      await withTimeout((async () => {
        for (;;) {
          if (worker.child.exitCode !== null) throw new RunwrightError("internal", `bench worker exited early: ${worker.stderr()}`);
          const held = await Promise.all(runIds.map(async (id) => (await env.store.getRun(id))?.leaseOwner === childRunnerId));
          if (held.every(Boolean)) return;
          await new Promise((resolve) => setTimeout(resolve, BENCH_POLL_MS));
        }
      })(), 30_000, "the worker to claim every run");

      let reclaimedAt = 0;
      let completedAt = 0;
      let allReclaimed: () => void = () => undefined;
      let allCompleted: () => void = () => undefined;
      const reclaimedDone = new Promise<void>((resolve) => {
        allReclaimed = resolve;
      });
      const completedDone = new Promise<void>((resolve) => {
        allCompleted = resolve;
      });
      unsubscribe = env.store.subscribe((event) => {
        if (event.type !== "journal") return;
        const now = performance.now();
        if (event.records.some((r) => r.type === "run.claimed" && r.epoch >= 2)) {
          reclaimed.add(event.runId);
          if (reclaimed.size === runs) {
            reclaimedAt = now;
            allReclaimed();
          }
        }
        if (event.status === "completed") {
          completed.add(event.runId);
          if (completed.size === runs) {
            completedAt = now;
            allCompleted();
          }
        }
      });

      worker.child.kill("SIGKILL");
      const killedAt = performance.now();
      await worker.exited;
      const runner = env.makeRunner({ concurrency: runs, leaseMs: RECOVERY_LEASE_MS, pollMs: BENCH_POLL_MS });
      runner.start();
      await withTimeout(reclaimedDone, WAIT_MS, "every orphaned run to be reclaimed");
      await withTimeout(completedDone, WAIT_MS, "every recovered run to complete");
      return {
        runs,
        leaseMs: RECOVERY_LEASE_MS,
        modelDelayMs: RECOVERY_MODEL_DELAY_MS,
        pollMs: BENCH_POLL_MS,
        killToAllReclaimedMs: round3(reclaimedAt - killedAt),
        killToAllCompletedMs: round3(completedAt - killedAt),
      };
    } finally {
      unsubscribe?.();
      await killWorker(worker);
    }
  });
}

interface SseSubscriber { req: ClientRequest; ready: Promise<void> }

/**
 * A raw node:http SSE client. Calls `onTick(index, latencyMs)` for every `bench.tick` event, timing it from the
 * record's send stamp to the moment the chunk that completed the event arrived. `ready` resolves once a record
 * with seq ≥ `readySeq` has arrived, which proves the stream is live.
 */
function subscribe(url: string, token: string, readySeq: number, onTick: (index: number, latencyMs: number) => void): SseSubscriber {
  let markReady: () => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    fail = reject;
  });
  const req = request(url, { headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" } }, (res: IncomingMessage) => {
    if (res.statusCode !== 200) {
      fail(new RunwrightError("internal", `bench: SSE subscribe answered ${res.statusCode ?? "?"}`));
      res.resume();
      return;
    }
    res.setEncoding("utf8");
    let buffer = "";
    res.on("data", (chunk: string) => {
      const receivedAt = process.hrtime.bigint();
      buffer += chunk;
      let end = buffer.indexOf("\n\n");
      while (end !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        end = buffer.indexOf("\n\n");
        const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
        if (dataLine === undefined) continue;
        const record: unknown = JSON.parse(dataLine.slice(6));
        if (!isJsonObject(record) || typeof record["seq"] !== "number") continue;
        if (record["seq"] >= readySeq) markReady();
        const data = record["data"];
        if (record["type"] === "bench.tick" && isJsonObject(data) && typeof data["sentNs"] === "string" && typeof data["index"] === "number") {
          onTick(data["index"], nsToMs(BigInt(data["sentNs"]), receivedAt));
        }
      }
    });
  });
  req.on("error", (error) => fail(error));
  req.end();
  return { req, ready };
}

async function measureSseFanout(subscribers: number, events: number): Promise<JsonObject> {
  return inBenchEnv(async (env) => {
    const lease = await claimForBench(env, "bench-sse-writer");
    const target = await env.store.getRun(lease.runId);
    if (target === null) throw new RunwrightError("internal", "bench: the SSE target run vanished");
    const token = generateToken();
    const secrets = await createSecretsService({ store: env.store, sealKey: generateSealKey() });
    const server = createServer({
      config: env.config, store: env.store, clock: systemClock, ids: env.ids, logger: env.logger, token,
      tools: env.tools, secrets, events: null, consolePath: CONSOLE_PATH, version: "bench", runnerInfo: () => null,
    });
    const { url } = await server.listen();
    const clients: SseSubscriber[] = [];
    try {
      const latencies: number[] = [];
      const counts = new Map<number, number>();
      let waiting: { index: number; resolve: () => void } | null = null;
      const onTick = (index: number, latencyMs: number): void => {
        latencies.push(latencyMs);
        const count = (counts.get(index) ?? 0) + 1;
        counts.set(index, count);
        if (waiting !== null && waiting.index === index && count === subscribers) waiting.resolve();
      };
      const streamUrl = `${url}/v1/runs/${encodeURIComponent(target.id)}/events?after=0`;
      for (let k = 0; k < subscribers; k++) clients.push(subscribe(streamUrl, token, target.journalSeq, onTick));
      await withTimeout(Promise.all(clients.map((c) => c.ready)), 30_000, "every SSE subscriber to connect");

      for (let index = 0; index < events; index++) {
        const delivered = new Promise<void>((resolve) => {
          waiting = { index, resolve };
        });
        await env.store.commit(lease, {
          records: [{ type: "bench.tick", key: `tick.${index}`, data: { index, sentNs: process.hrtime.bigint().toString() } }],
        });
        await withTimeout(delivered, 30_000, `event ${index} to reach every subscriber`);
      }
      const summary = summarize(latencies);
      return { subscribers, events, p50Ms: summary.p50, p99Ms: summary.p99 };
    } finally {
      for (const client of clients) client.req.destroy();
      await server.close();
    }
  });
}

function machineInfo(): JsonObject {
  const list = cpus();
  return {
    platform: platform(),
    arch: arch(),
    cpus: list.length,
    cpuModel: list[0]?.model.trim() ?? "unknown",
    totalMemGb: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    node: process.version,
  };
}

export async function runBench(options: BenchOptions): Promise<BenchReport> {
  const sizes = options.quick ? QUICK : FULL;
  const progress = options.progress ?? (() => undefined);
  const startedAt = new Date().toISOString();

  const runsPerSecond: JsonObject[] = [];
  for (const concurrency of sizes.concurrencies) {
    progress(`runsPerSecond: ${sizes.runs} runs at concurrency ${concurrency}`);
    runsPerSecond.push(await measureRunsPerSecond(concurrency, sizes.runs));
  }
  progress(`journalAppendsPerSecond: ${sizes.appends} records`);
  const journalAppendsPerSecond = await measureJournalAppends(sizes.appends);
  progress(`enqueueToClaimMs: ${sizes.claimSamples} samples`);
  const enqueueToClaimMs = await measureEnqueueToClaim(sizes.claimSamples);
  progress(`recovery: ${sizes.recoveryRuns} runs, child runner killed with SIGKILL`);
  const recovery = await measureRecovery(sizes.recoveryRuns);
  progress(`sseFanout: ${sizes.subscribers} subscribers x ${sizes.events} events`);
  const sseFanout = await measureSseFanout(sizes.subscribers, sizes.events);

  return {
    machine: machineInfo(),
    startedAt,
    quick: options.quick,
    results: { runsPerSecond, journalAppendsPerSecond, enqueueToClaimMs, recovery, sseFanout },
  };
}
