import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openTestStore, testAgentDefinition } from "../helpers/store.ts";
import { createFakeClock } from "../../src/core/clock.ts";
import { isRunwrightError } from "../../src/core/errors.ts";
import { openSqliteStore } from "../../src/store/sqlite.ts";

const leaseLost = (e: unknown): boolean => isRunwrightError(e) && e.code === "lease_lost";

test("claims orphans first, then queued runs oldest first, up to the limit", async (t) => {
  const clock = createFakeClock(100_000);
  const { store } = await openTestStore(t, { clock });
  await store.saveAgent({ id: "a", definition: testAgentDefinition() });
  const runs: string[] = [];
  for (let i = 0; i < 4; i++) {
    runs.push((await store.createRun({ agentId: "a", input: { message: String(i), data: null } })).run.id);
    clock.advance(1);
  }
  const later = (await store.createRun({ agentId: "a", input: { message: "later", data: null }, availableAt: clock.now() + 10_000 })).run.id;
  const first = await store.claimRuns({ runnerId: "r1", limit: 1, leaseMs: 500 });
  assert.deepEqual(first.map((c) => c.run.id), [runs[0]]);
  assert.equal(first[0]!.run.status, "running");
  assert.equal(first[0]!.run.startedAt, clock.now());
  assert.equal(first[0]!.run.leaseOwner, "r1");
  assert.equal(first[0]!.run.leaseExpiresAt, clock.now() + 500);
  assert.deepEqual(first[0]!.lease, { runId: runs[0], runnerId: "r1", epoch: 1 });
  clock.advance(600);
  const second = await store.claimRuns({ runnerId: "r2", limit: 3, leaseMs: 500 });
  assert.deepEqual(second.map((c) => c.run.id), [runs[0], runs[1], runs[2]], "the orphan comes first");
  assert.equal(second[0]!.lease.epoch, 2);
  assert.equal(second[0]!.run.startedAt, clock.now() - 600, "started_at is kept on re-claim");
  assert.deepEqual((await store.claimRuns({ runnerId: "r2", limit: 10, leaseMs: 500 })).map((c) => c.run.id), [runs[3]]);
  assert.deepEqual(await store.claimRuns({ runnerId: "r2", limit: 10, leaseMs: 500 }), [], "not yet available");
  clock.advance(10_000);
  assert.ok((await store.claimRuns({ runnerId: "r2", limit: 10, leaseMs: 100_000 })).some((c) => c.run.id === later));
  assert.deepEqual(await store.claimRuns({ runnerId: "r2", limit: 0, leaseMs: 500 }), []);
});

test("epoch increases on each claim and a stale epoch commit is rejected and writes nothing", async (t) => {
  const clock = createFakeClock(1_000);
  const { store } = await openTestStore(t, { clock });
  await store.saveAgent({ id: "a", definition: testAgentDefinition() });
  const { run } = await store.createRun({ agentId: "a", input: { message: "", data: null } });
  const [zombie] = await store.claimRuns({ runnerId: "old", limit: 1, leaseMs: 200 });
  await store.commit(zombie!.lease, { records: [{ type: "run.claimed", data: { runnerId: "old" } }] });
  clock.advance(201);
  const [fresh] = await store.claimRuns({ runnerId: "new", limit: 1, leaseMs: 200 });
  assert.equal(fresh!.lease.epoch, zombie!.lease.epoch + 1);
  const before = await store.getRun(run.id);
  await assert.rejects(store.commit(zombie!.lease, {
    records: [{ type: "tool.started", key: "t1.c0", data: {} }],
    transition: { to: "completed", output: "late" },
    usage: [{ model: "scripted/scripted-1", purpose: "run", inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 9, assumed: false }],
    counters: { toolCalls: 1 },
  }), leaseLost);
  assert.deepEqual(await store.getRun(run.id), before);
  assert.deepEqual((await store.readJournal(run.id)).map((r) => r.type), ["run.created", "run.claimed"]);
  assert.deepEqual(await store.usageSummary({ groupBy: "day" }), []);
  const ok = await store.commit(fresh!.lease, { records: [{ type: "run.claimed", data: { runnerId: "new" } }] });
  assert.equal(ok.records[0]!.epoch, fresh!.lease.epoch);
  await assert.rejects(store.commit({ ...fresh!.lease, runnerId: "imposter" }, { records: [] }), leaseLost);
  await assert.rejects(store.commit({ runId: "run_missing", runnerId: "new", epoch: 1 }, { records: [] }), leaseLost);
});

test("an expired lease that nobody re-claimed may still commit", async (t) => {
  const clock = createFakeClock(1_000);
  const { store } = await openTestStore(t, { clock });
  await store.saveAgent({ id: "a", definition: testAgentDefinition() });
  await store.createRun({ agentId: "a", input: { message: "", data: null } });
  const [claim] = await store.claimRuns({ runnerId: "r", limit: 1, leaseMs: 100 });
  clock.advance(500);
  const result = await store.commit(claim!.lease, { records: [{ type: "x", data: {} }] });
  assert.equal(result.run.journalSeq, 2);
});

test("heartbeat extends held leases and reports lost ones", async (t) => {
  const clock = createFakeClock(1_000);
  const { store } = await openTestStore(t, { clock });
  await store.saveAgent({ id: "a", definition: testAgentDefinition() });
  await store.createRun({ agentId: "a", input: { message: "1", data: null } });
  await store.createRun({ agentId: "a", input: { message: "2", data: null } });
  const claims = await store.claimRuns({ runnerId: "r1", limit: 2, leaseMs: 100 });
  const [a, b] = claims.map((c) => c.run.id) as [string, string];
  clock.advance(50);
  assert.deepEqual(await store.heartbeat({ runnerId: "r1", runIds: [a, b], leaseMs: 100 }), []);
  assert.equal((await store.getRun(a))?.leaseExpiresAt, clock.now() + 100);
  clock.advance(150);
  const [taken] = await store.claimRuns({ runnerId: "r2", limit: 1, leaseMs: 100 });
  const lostId = taken!.run.id;
  await store.commit(claims.find((c) => c.run.id !== lostId)!.lease, { records: [], transition: { to: "completed" } });
  const lost = await store.heartbeat({ runnerId: "r1", runIds: [a, b, "run_unknown"], leaseMs: 100 });
  assert.deepEqual(lost.sort(), [a, b, "run_unknown"].sort(), "taken over, finished and unknown runs are all lost");
  assert.deepEqual(await store.heartbeat({ runnerId: "r1", runIds: [], leaseMs: 100 }), []);
});

test("two store handles on one file never claim the same run twice", async (t) => {
  const { store, path } = await openTestStore(t);
  const other = await openSqliteStore({ path });
  t.after(() => other.close());
  await store.saveAgent({ id: "a", definition: testAgentDefinition() });
  for (let i = 0; i < 40; i++) await store.createRun({ agentId: "a", input: { message: String(i), data: null } });
  const claimed: string[] = [];
  const loop = async (handle: typeof store, name: string) => {
    for (;;) {
      const got = await handle.claimRuns({ runnerId: name, limit: 3, leaseMs: 60_000 });
      if (got.length === 0) return;
      claimed.push(...got.map((c) => c.run.id));
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  await Promise.all([loop(store, "one"), loop(other, "two")]);
  assert.equal(claimed.length, 40);
  assert.equal(new Set(claimed).size, 40);
});

test("a separate process claiming concurrently never double-claims", async (t) => {
  const { store, path } = await openTestStore(t);
  await store.saveAgent({ id: "a", definition: testAgentDefinition() });
  for (let i = 0; i < 120; i++) await store.createRun({ agentId: "a", input: { message: String(i), data: null } });
  const sqlitePath = fileURLToPath(new URL("../../src/store/sqlite.ts", import.meta.url));
  const script = `
    const { openSqliteStore } = await import(${JSON.stringify(sqlitePath)});
    const store = await openSqliteStore({ path: ${JSON.stringify(path)} });
    const ids = [];
    process.stdout.write("ready\\n");
    for (;;) {
      const got = await store.claimRuns({ runnerId: "child", limit: 2, leaseMs: 60000 });
      if (got.length === 0) break;
      ids.push(...got.map((c) => c.run.id));
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await store.close();
    process.stdout.write(JSON.stringify(ids));
  `;
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (status) => resolve(status)));
  await new Promise<void>((resolve, reject) => {
    child.stdout.on("data", () => {
      if (stdout.startsWith("ready\n")) resolve();
    });
    child.on("exit", () => reject(new Error(`child exited early: ${stderr}`)));
  });
  const mine: string[] = [];
  for (;;) {
    const got = await store.claimRuns({ runnerId: "parent", limit: 2, leaseMs: 60_000 });
    if (got.length === 0) break;
    mine.push(...got.map((c) => c.run.id));
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(await exited, 0, stderr);
  const theirs = JSON.parse(stdout.slice("ready\n".length)) as string[];
  t.diagnostic(`claimed by this process: ${mine.length}, by the child: ${theirs.length}`);
  const all = [...mine, ...theirs];
  assert.equal(all.length, 120);
  assert.equal(new Set(all).size, 120);
});

test("a lease length that is not a positive integer is bad_request; a huge claim limit is bounded", async (t) => {
  const { store } = await openTestStore(t);
  await store.saveAgent({ id: "a", definition: testAgentDefinition() });
  const { run } = await store.createRun({ agentId: "a", input: { message: "", data: null } });
  for (const leaseMs of [Number.NaN, Infinity, 0, -5, 1.5, 2 ** 60]) {
    await assert.rejects(store.claimRuns({ runnerId: "r", limit: 1, leaseMs }), (e: unknown) => isRunwrightError(e) && e.code === "bad_request", String(leaseMs));
  }
  assert.equal((await store.getRun(run.id))?.status, "queued", "nothing was claimed");
  const claimed = await store.claimRuns({ runnerId: "r", limit: Infinity, leaseMs: 1000 });
  assert.deepEqual(claimed.map((c) => c.run.id), [run.id]);
  await assert.rejects(store.heartbeat({ runnerId: "r", runIds: [run.id], leaseMs: Infinity }), (e: unknown) => isRunwrightError(e) && e.code === "bad_request");
  assert.deepEqual(await store.heartbeat({ runnerId: "r", runIds: [run.id], leaseMs: 1000 }), []);
});
