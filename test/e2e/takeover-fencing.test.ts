/**
 * Brief, section 4, "Lease takeover and fencing": runner A holds a run inside a slow read-only tool and is
 * frozen with SIGSTOP (a zombie). Runner C takes the run over once A's lease expires (epoch 2), retries the
 * read tool and completes the run. When A is thawed its late writes are rejected by the store.
 *
 * SQLite has one writer at a time, so a process frozen inside a write transaction holds the write lock and blocks
 * every runner (docs/architecture.md, "One writer at a time"). The zombie of this test is a runner frozen between
 * transactions: when the database cannot be locked for writing right after the freeze, A is thawed for a moment
 * and frozen again, so it is frozen while it holds its lease and no database lock.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { delay } from "../../src/core/clock.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { waitFor } from "../helpers/wait.ts";
import { clientOf, startHost, type HostProcess } from "../fixtures/process.ts";
import { callTurn, effectLines, fullTimeline, scriptedAgent, waitForStatus } from "../fixtures/runs.ts";

/** True when another connection can take the write lock now (a frozen process holds none). */
function writable(dbPath: string): boolean {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");
    return true;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

async function freezeBetweenTransactions(host: HostProcess, dbPath: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    host.kill("SIGSTOP");
    if (writable(dbPath)) return;
    host.kill("SIGCONT");
    await delay(5 + attempt);
  }
  throw new Error("the runner was never frozen between transactions");
}

test("a frozen runner loses its run to another runner and its late writes are fenced off", { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t, "runwright-e2e-fence-");
  const dataDir = join(dir, "data");
  const effects = join(dir, "effects.txt");
  const common = { RUNWRIGHT_DATA_DIR: dataDir, HOST_EFFECTS_FILE: effects, HOST_LEASE_MS: "500", HOST_POLL_MS: "40" };

  const server = await startHost(t, { ...common, HOST_ROLE: "server", RUNWRIGHT_NO_RUNNER: "1" });
  const client = clientOf(server);
  const runnerA = await startHost(t, { ...common, HOST_ROLE: "runner" });
  assert.equal(runnerA.url, "");
  assert.ok(runnerA.runnerId !== null);

  const { agent } = await client.saveAgent(scriptedAgent({
    name: "Fencing",
    tools: [{ name: "slow_read" }],
    script: { turns: [callTurn("slow_read", { label: "r", ms: 1500 }), { text: "read finished" }] },
  }), "fencing");
  const { run } = await client.startRun({ agentId: agent.id, message: "read slowly" });

  await waitFor(async () => (await fullTimeline(client, run.id)).some((r) => r.type === "tool.started"), {
    timeoutMs: 15_000, intervalMs: 10, message: "runner A never started the tool",
  });
  await freezeBetweenTransactions(runnerA, join(dataDir, "runwright.db"));
  const frozenAt = await fullTimeline(client, run.id);
  assert.deepEqual(frozenAt.filter((r) => r.type === "run.claimed").map((r) => r.epoch), [1]);

  const runnerC = await startHost(t, { ...common, HOST_ROLE: "runner" });
  const { run: done } = await waitForStatus(client, run.id, ["completed", "failed", "cancelled", "waiting"], 30_000).catch((error: unknown) => {
    throw new Error(`${(error as Error).message}\nrunner C stderr:\n${runnerC.stderr()}`);
  });
  assert.equal(done.status, "completed");
  assert.deepEqual(done.output, { text: "read finished" });

  runnerA.kill("SIGCONT");
  await waitFor(() => runnerA.stderr().includes("runner.fenced"), {
    timeoutMs: 15_000, intervalMs: 20, message: "runner A never reported that it was fenced",
  });

  const records = await fullTimeline(client, run.id);
  const claims = records.filter((r) => r.type === "run.claimed");
  assert.deepEqual(claims.map((r) => r.epoch), [1, 2]);
  assert.equal(claims[0]?.data["runnerId"], runnerA.runnerId);
  assert.equal(claims[1]?.data["runnerId"], runnerC.runnerId);
  const takeover = claims[1]?.seq ?? Infinity;
  const late = records.filter((r) => r.seq > takeover && r.epoch !== 2);
  assert.deepEqual(late, [], "every record after the takeover carries epoch 2");
  assert.equal(records.filter((r) => r.type === "run.completed").length, 1);
  const starts = records.filter((r) => r.type === "tool.started");
  assert.deepEqual(starts.map((r) => [r.epoch, r.data["attempt"]]), [[1, 1], [2, 2]], "the read tool was retried by C");
  assert.equal(records.filter((r) => r.type === "tool.finished").length, 1);
  assert.equal((await client.getRun(run.id)).run.status, "completed", "A's late writes changed nothing");

  const lines = await effectLines(effects);
  assert.equal(lines.filter((line) => line === "start:r").length, 2, "A and C each ran the read handler");
});
