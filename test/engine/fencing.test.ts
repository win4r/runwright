import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createFakeClock, delay } from "../../src/core/clock.ts";
import { RunwrightError } from "../../src/core/errors.ts";
import { openSqliteStore } from "../../src/store/sqlite.ts";
import type { JournalRecord } from "../../src/store/types.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import { createHarness, fakeModels, reply, toolReply } from "../helpers/engine.ts";
import { waitFor } from "../helpers/wait.ts";

/** A read tool whose first call takes `slowMs` and ignores aborts, like a frozen process. */
function slowRead(slowMs: number): { tool: ToolDefinition; calls: () => number } {
  let calls = 0;
  const tool: ToolDefinition = {
    name: "slow_read",
    description: "Reads slowly.",
    parameters: { type: "object", properties: {} },
    effect: "read",
    handler: async () => {
      calls++;
      if (calls === 1) await new Promise((resolve) => setTimeout(resolve, slowMs));
      return { content: `read #${calls}` };
    },
  };
  return { tool, calls: () => calls };
}

const models = fakeModels((request) => (request.meta.turn === 1 ? toolReply("slow_read", {}) : reply({ text: "done" })));

function assertNoStaleWrites(journal: JournalRecord[], staleEpoch: number): void {
  const takeover = journal.find((r) => r.epoch > staleEpoch);
  assert.ok(takeover !== undefined, "another epoch wrote to the journal");
  const late = journal.filter((r) => r.seq > takeover.seq && r.epoch === staleEpoch);
  assert.deepEqual(late, [], "the stale epoch wrote after the takeover");
}

test("lease takeover: a dead runner's run is finished by another runner and its old lease is rejected", async (t) => {
  const slow = slowRead(500);
  const h = await createHarness(t, { models, tools: [slow.tool] });
  const agent = await h.saveAgent({ tools: [{ name: "slow_read" }] });
  const run = await h.start(agent.id);
  await waitFor(async () => (await h.journal(run.id)).some((r) => r.type === "tool.started"));
  const holder = h.runner.id;
  const claimedA = (await h.journal(run.id)).find((r) => r.type === "run.claimed");
  assert.ok(claimedA !== undefined);
  const epochA = claimedA.epoch;

  await h.crashAndReplace();
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, { text: "done" });
  assert.ok(done.epoch > epochA);
  assert.equal(slow.calls(), 2, "the read tool is retried by the new runner");

  await assert.rejects(
    h.store.commit({ runId: run.id, runnerId: holder, epoch: epochA }, { records: [{ type: "test.late", data: {} }] }),
    (error: unknown) => error instanceof RunwrightError && error.code === "lease_lost",
  );
  await new Promise((resolve) => setTimeout(resolve, 600));
  assertNoStaleWrites(await h.journal(run.id), epochA);
});

test("a zombie that missed its lease expiry has its late commit rejected and stops writing", async (t) => {
  const slow = slowRead(700);
  // concurrency 1: the zombie's session keeps its only slot, so it cannot re-claim its own run; another runner must.
  const h = await createHarness(t, { models, tools: [slow.tool], engine: { heartbeatMs: 60_000, concurrency: 1 } });
  const agent = await h.saveAgent({ tools: [{ name: "slow_read" }] });
  const run = await h.start(agent.id);
  await waitFor(async () => (await h.journal(run.id)).some((r) => r.type === "tool.started"));
  const epochA = (await h.store.getRun(run.id))?.epoch ?? 0;
  const zombie = h.runner;

  const other = h.newRunner({ heartbeatMs: 100, concurrency: 8 });
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, { text: "done" });
  await waitFor(() => h.logLines.some((line) => {
    const parsed = JSON.parse(line);
    return parsed.msg === "runner.fenced" && parsed.runId === run.id && parsed.runnerId === zombie.id;
  }), { timeoutMs: 3000 });
  assertNoStaleWrites(await h.journal(run.id), epochA);
  const claimers = (await h.records(run.id, "run.claimed")).map((r) => r.runnerId);
  assert.deepEqual(claimers, [zombie.id, other.id], "the run was taken over by the other runner");
});

test("a runner that re-claims its own expired run fences the old session at once", async (t) => {
  let calls = 0;
  let firstAbortedAfter: number | null = null;
  const read: ToolDefinition = {
    name: "slow_read", description: "Reads slowly the first time.", parameters: { type: "object", properties: {} }, effect: "read",
    handler: async (_args, context) => {
      calls++;
      if (calls === 1) {
        const startedAt = Date.now();
        try {
          await delay(2000, context.signal);
        } catch (error) {
          firstAbortedAfter = Date.now() - startedAt;
          throw error;
        }
      }
      return { content: `read #${calls}` };
    },
  };
  const h = await createHarness(t, { models, tools: [read], engine: { leaseMs: 150, heartbeatMs: 60_000 } });
  const agent = await h.saveAgent({ tools: [{ name: "slow_read" }] });
  const run = await h.start(agent.id);
  const done = await h.until(run.id, "completed", 4000);
  assert.deepEqual(done.output, { text: "done" });
  assert.ok(firstAbortedAfter !== null && firstAbortedAfter < 1500, `the first handler saw its abort after ${String(firstAbortedAfter)} ms`);
  const attempts = (await h.records(run.id, "tool.started")).map((r) => r.attempt);
  assert.ok(attempts.length >= 2 && (attempts[attempts.length - 1] ?? 0) > 1, `attempts ${attempts.join(",")}`);
  const claimers = new Set((await h.records(run.id, "run.claimed")).map((r) => r.runnerId));
  assert.deepEqual([...claimers], [h.runner.id], "the same runner claimed the run again");
});

test("a live runner whose heartbeat reports a lost lease stops writing", async (t) => {
  const slow = slowRead(400);
  const h = await createHarness(t, { models, tools: [slow.tool], engine: { heartbeatMs: 40 } });
  const agent = await h.saveAgent({ tools: [{ name: "slow_read" }] });
  const run = await h.start(agent.id);
  await waitFor(async () => (await h.journal(run.id)).some((r) => r.type === "tool.started"));
  const epochA = (await h.store.getRun(run.id))?.epoch ?? 0;

  const skewed = createFakeClock(Date.now() + 3_600_000);
  const thief = await openSqliteStore({ path: join(h.dir, "runwright.db"), clock: skewed });
  t.after(() => thief.close());
  const [stolen] = await thief.claimRuns({ runnerId: "thief", limit: 1, leaseMs: 3_600_000 });
  assert.ok(stolen !== undefined);
  assert.equal(stolen.lease.epoch, epochA + 1);
  await thief.commit(stolen.lease, { records: [{ type: "run.claimed", data: { runnerId: "thief" } }] });

  await waitFor(() => h.logLines.some((line) => {
    const parsed = JSON.parse(line);
    return parsed.msg === "runner.fenced" && parsed.runId === run.id;
  }), { timeoutMs: 2000 });
  await waitFor(() => slow.calls() === 1 && h.runner.activeRunIds().length === 0, { timeoutMs: 2000 });
  const journal = await h.journal(run.id);
  assertNoStaleWrites(journal, epochA);
  assert.equal(journal[journal.length - 1]?.epoch, epochA + 1);
  assert.equal((await h.store.getRun(run.id))?.status, "running");
});
