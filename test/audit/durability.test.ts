/**
 * Brief, section 4, "Lease takeover and fencing", checked against two wrong implementations the existing tests
 * would let through (finding class R09D-tests-01):
 * - a second runner that takes a run over before the first one's lease expired;
 * - fencing that is never exercised, because the zombie never actually tries to write after the takeover (the
 *   existing tests infer the late write from a log line). Here every commit is recorded at the store boundary,
 *   so the zombie's late commit is seen being attempted and refused, and its records are absent from the journal.
 * Kill and resume, interrupted effects and pauses across a restart are already pinned by the e2e tests (see the
 * package handover); nothing is duplicated here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeClock } from "../../src/core/clock.ts";
import { isRunwrightError } from "../../src/core/errors.ts";
import { openSqliteStore } from "../../src/store/sqlite.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import { createHarness, fakeModels, reply, toolReply } from "../helpers/engine.ts";
import { openTestStore, testAgentDefinition } from "../helpers/store.ts";
import { waitFor } from "../helpers/wait.ts";
import { recordingStore } from "./support.ts";

const leaseLost = (error: unknown): boolean => isRunwrightError(error) && error.code === "lease_lost";

test("a second store handle cannot take a run over one millisecond before the lease expires, and can just after", async (t) => {
  const clock = createFakeClock(5_000_000);
  const { store: first, path } = await openTestStore(t, { clock });
  const second = await openSqliteStore({ path, clock });
  t.after(() => second.close());
  await first.saveAgent({ id: "a", definition: testAgentDefinition() });
  const { run } = await first.createRun({ agentId: "a", input: { message: "go", data: null } });

  const [held] = await first.claimRuns({ runnerId: "runner-a", limit: 1, leaseMs: 1_000 });
  assert.ok(held !== undefined);
  const expiresAt = held.run.leaseExpiresAt ?? Number.NaN;
  assert.equal(expiresAt, clock.now() + 1_000);

  for (const at of [clock.now() + 1, clock.now() + 500, expiresAt - 1]) {
    clock.set(at);
    assert.deepEqual(await second.claimRuns({ runnerId: "runner-b", limit: 5, leaseMs: 1_000 }), [], `claimed at expiry - ${expiresAt - at} ms`);
  }
  assert.equal((await first.getRun(run.id))?.leaseOwner, "runner-a");

  clock.set(expiresAt + 1);
  const [taken] = await second.claimRuns({ runnerId: "runner-b", limit: 5, leaseMs: 1_000 });
  assert.equal(taken?.run.id, run.id);
  assert.equal(taken?.lease.epoch, held.lease.epoch + 1);

  const journalBefore = await first.readJournal(run.id);
  await assert.rejects(first.commit(held.lease, {
    records: [{ type: "tool.finished", key: "t1.c0", data: { late: true } }], transition: { to: "completed", output: "late" },
  }), leaseLost);
  assert.deepEqual(await first.readJournal(run.id), journalBefore, "the zombie's records are not in the journal");
  assert.equal((await first.getRun(run.id))?.status, "running");
  assert.deepEqual(await first.heartbeat({ runnerId: "runner-a", runIds: [run.id], leaseMs: 1_000 }), [run.id]);
});

test("a frozen runner's late commit is attempted after the takeover, refused by the store, and absent from the journal", async (t) => {
  let calls = 0;
  let releaseZombie!: () => void;
  const zombieReleased = new Promise<void>((resolve) => {
    releaseZombie = resolve;
  });
  // The first call ignores its abort signal, like a process that was frozen in the middle of the handler.
  const stuck: ToolDefinition = {
    name: "stuck_read", description: "Reads; the first call hangs until the test lets it go.",
    parameters: { type: "object", properties: {} }, effect: "read",
    handler: async () => {
      calls++;
      if (calls === 1) await zombieReleased;
      return { content: `read #${calls}` };
    },
  };
  const recorder = recordingStore();
  const models = fakeModels((request) => (request.meta.turn === 1 ? toolReply("stuck_read", {}) : reply({ text: "done" })));
  // The zombie never heartbeats (it is "frozen"), and with concurrency 1 it cannot re-claim its own run.
  const h = await createHarness(t, {
    models, tools: [stuck], wrapStore: recorder.wrap, engine: { leaseMs: 300, heartbeatMs: 60_000, concurrency: 1 },
  });
  const agent = await h.saveAgent({ tools: [{ name: "stuck_read" }] });
  const run = await h.start(agent.id);
  await waitFor(() => calls === 1, { timeoutMs: 3000, message: "the zombie never started the tool" });
  const zombie = h.runner;
  const zombieClaim = recorder.claims.find((c) => c.runnerId === zombie.id && c.runId === run.id);
  assert.ok(zombieClaim !== undefined);

  const other = h.newRunner({ heartbeatMs: 100, concurrency: 4 });
  const done = await h.until(run.id, "completed", 5000);
  assert.deepEqual(done.output, { text: "done" });
  const takeover = recorder.claims.find((c) => c.runnerId === other.id && c.runId === run.id);
  assert.ok(takeover !== undefined, "the other runner claimed the run");
  assert.equal(takeover.epoch, zombieClaim.epoch + 1);
  assert.ok(takeover.claimedAt >= zombieClaim.expiresAt,
    `taken over at ${takeover.claimedAt}, ${zombieClaim.expiresAt - takeover.claimedAt} ms before the lease expired`);

  const commitsBefore = recorder.commits.length;
  releaseZombie();
  const late = await waitFor(() => recorder.commits.slice(commitsBefore).find((c) => c.lease.runnerId === zombie.id && c.lease.runId === run.id), {
    timeoutMs: 3000, message: "the zombie never tried to commit after the takeover",
  });
  assert.equal(late.lease.epoch, zombieClaim.epoch);
  const outcome = await late.outcome;
  assert.equal(outcome, "lease_lost", "the store refused the zombie's late commit");
  assert.ok(late.types.length > 0, "the refused batch carried records");

  const journal = await h.journal(run.id);
  const takeoverSeq = journal.find((r) => r.type === "run.claimed" && r.epoch === takeover.epoch)?.seq ?? Infinity;
  assert.deepEqual(journal.filter((r) => r.seq > takeoverSeq && r.epoch === zombieClaim.epoch), [], "no record of the zombie's epoch after the takeover");
  assert.equal(journal.filter((r) => r.type === "run.completed").length, 1);
  assert.equal((await h.store.getRun(run.id))?.status, "completed", "the late write changed nothing");
  for (const attempt of recorder.commits.filter((c) => c.lease.epoch === zombieClaim.epoch && c.lease.runId === run.id)) {
    const result = await attempt.outcome;
    if (result === "ok") assert.ok(attempt.at < takeover.claimedAt, "an epoch-1 commit succeeded only before the takeover");
  }
});
