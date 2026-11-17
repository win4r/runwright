import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isJsonObject, type Json, type JsonObject } from "../../src/core/json.ts";
import { runBench } from "../../src/bench/bench.ts";

const run = promisify(execFile);
const MAIN = fileURLToPath(new URL("../../src/bench/main.ts", import.meta.url));

function object(value: Json | undefined, what: string): JsonObject {
  assert.ok(value !== undefined && isJsonObject(value), `${what} is an object`);
  return value;
}

function positive(source: JsonObject, field: string): number {
  const value = source[field];
  assert.equal(typeof value, "number", `${field} is a number`);
  assert.ok(Number.isFinite(value) && (value as number) > 0, `${field} = ${String(value)} is finite and positive`);
  return value as number;
}

/** Bench worker processes whose parent is this test process. */
async function workerChildren(): Promise<string[]> {
  const { stdout } = await run("ps", ["-A", "-o", "pid=,ppid=,command="]);
  return stdout.split("\n").filter((line) => {
    const [, ppid] = line.trim().split(/\s+/);
    return ppid === String(process.pid) && line.includes("src/bench/worker.ts");
  });
}

test("runBench({quick: true}) reports every figure, finite and positive", { timeout: 60_000 }, async () => {
  const started = performance.now();
  const report = await runBench({ quick: true });
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 20_000, `quick bench took ${Math.round(elapsed)} ms`);

  assert.equal(report.quick, true);
  assert.ok(!Number.isNaN(Date.parse(report.startedAt)));
  for (const field of ["platform", "arch", "cpuModel", "node"]) assert.equal(typeof report.machine[field], "string");
  positive(report.machine, "cpus");
  positive(report.machine, "totalMemGb");

  const results = report.results;
  const rps = results["runsPerSecond"];
  assert.ok(Array.isArray(rps));
  assert.deepEqual(rps.map((entry) => object(entry, "runsPerSecond entry")["concurrency"]), [1, 8]);
  for (const entry of rps) {
    const e = object(entry, "runsPerSecond entry");
    assert.equal(e["runs"], 40);
    const seconds = positive(e, "seconds");
    const perSecond = positive(e, "runsPerSecond");
    assert.ok(Math.abs(perSecond - 40 / seconds) / perSecond < 0.05, "runsPerSecond = runs / seconds");
  }

  const journal = object(results["journalAppendsPerSecond"], "journalAppendsPerSecond");
  positive(journal, "singleRecordCommits");
  positive(journal, "batchedRecords");

  const claim = object(results["enqueueToClaimMs"], "enqueueToClaimMs");
  assert.equal(claim["samples"], 50);
  const p50 = positive(claim, "p50");
  const p99 = positive(claim, "p99");
  assert.ok(p50 <= p99);

  const recovery = object(results["recovery"], "recovery");
  assert.equal(recovery["runs"], 8);
  const leaseMs = positive(recovery, "leaseMs");
  const delayMs = positive(recovery, "modelDelayMs");
  const reclaimed = positive(recovery, "killToAllReclaimedMs");
  const completed = positive(recovery, "killToAllCompletedMs");
  const heartbeatMs = Math.floor(leaseMs / 3);
  assert.ok(reclaimed >= leaseMs - heartbeatMs, `reclaimed after ${reclaimed} ms, lease ${leaseMs} ms`);
  assert.ok(completed >= reclaimed + delayMs * 0.9, `completed ${completed} ms includes one ${delayMs} ms model delay`);

  const sse = object(results["sseFanout"], "sseFanout");
  assert.equal(sse["subscribers"], 5);
  assert.equal(sse["events"], 20);
  const sseP50 = positive(sse, "p50Ms");
  const sseP99 = positive(sse, "p99Ms");
  assert.ok(sseP50 <= sseP99);

  assert.deepEqual(await workerChildren(), [], "no bench worker is left running");
});

test("src/bench/main.ts --quick prints exactly one JSON document on stdout", { timeout: 60_000 }, async () => {
  const { stdout, stderr } = await run(process.execPath, ["--disable-warning=ExperimentalWarning", MAIN, "--quick"], {
    maxBuffer: 4 * 1024 * 1024,
    timeout: 50_000,
  });
  const parsed: unknown = JSON.parse(stdout);
  assert.ok(isJsonObject(parsed as Json));
  const report = parsed as JsonObject;
  assert.equal(report["quick"], true);
  for (const field of ["runsPerSecond", "journalAppendsPerSecond", "enqueueToClaimMs", "recovery", "sseFanout"]) {
    assert.ok(field in object(report["results"], "results"), `results.${field} present`);
  }
  assert.match(stderr, /bench: recovery/);
  assert.doesNotMatch(stderr, /ExperimentalWarning/);
});
