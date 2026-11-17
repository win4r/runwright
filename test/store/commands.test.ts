import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { openTestStore, testAgentDefinition } from "../helpers/store.ts";
import { createFakeClock } from "../../src/core/clock.ts";
import { isRunwrightError } from "../../src/core/errors.ts";
import type { RunStatus, Store } from "../../src/store/types.ts";

const code = (c: string) => (e: unknown): boolean => isRunwrightError(e) && e.code === c;

async function runIn(t: TestContext, status: RunStatus): Promise<{ store: Store; runId: string; clock: ReturnType<typeof createFakeClock> }> {
  const clock = createFakeClock(1_000);
  const { store } = await openTestStore(t, { clock });
  await store.saveAgent({ id: "a", definition: testAgentDefinition() });
  const { run } = await store.createRun({ agentId: "a", input: { message: "", data: null }, availableAt: 500 });
  if (status !== "queued") {
    const [claim] = await store.claimRuns({ runnerId: "r", limit: 1, leaseMs: 1000 });
    if (status !== "running") await store.commit(claim!.lease, { records: [], transition: { to: status } });
  }
  clock.advance(100);
  return { store, runId: run.id, clock };
}

test("waiting → queued on any command, with available_at = now", async (t) => {
  for (const command of [{ type: "message", text: "x" }, { type: "pause" }, { type: "answer", pendingId: "p", answer: "a" }] as const) {
    const { store, runId, clock } = await runIn(t, "waiting");
    await store.enqueueCommand(runId, command);
    assert.equal((await store.getRun(runId))?.status, "queued", command.type);
    const [claim] = await store.claimRuns({ runnerId: "r2", limit: 1, leaseMs: 1000 });
    assert.equal(claim?.run.id, runId);
    assert.ok(clock.now() >= 1_100);
  }
});

test("paused → queued only on resume or cancel", async (t) => {
  const { store, runId } = await runIn(t, "paused");
  await store.enqueueCommand(runId, { type: "message", text: "x" });
  await store.enqueueCommand(runId, { type: "limits", limits: { maxTurns: 3 } });
  assert.equal((await store.getRun(runId))?.status, "paused");
  await store.enqueueCommand(runId, { type: "resume" });
  assert.equal((await store.getRun(runId))?.status, "queued");
  const other = await runIn(t, "paused");
  await other.store.enqueueCommand(other.runId, { type: "cancel", reason: null });
  assert.equal((await other.store.getRun(other.runId))?.status, "queued");
});

test("queued and running runs keep their status", async (t) => {
  for (const status of ["queued", "running"] as const) {
    const { store, runId } = await runIn(t, status);
    await store.enqueueCommand(runId, { type: "cancel", reason: "stop" });
    assert.equal((await store.getRun(runId))?.status, status);
  }
});

test("terminal runs reject commands; unknown runs are not_found", async (t) => {
  for (const status of ["completed", "failed", "cancelled"] as const) {
    const { store, runId } = await runIn(t, status);
    await assert.rejects(store.enqueueCommand(runId, { type: "message", text: "x" }), code("run_terminal"));
    assert.deepEqual(await store.listCommands(runId), []);
  }
  const { store } = await runIn(t, "queued");
  await assert.rejects(store.enqueueCommand("run_nope", { type: "resume" }), code("not_found"));
});

test("commands are listed oldest first and consumed by commit", async (t) => {
  const { store, runId, clock } = await runIn(t, "running");
  const first = await store.enqueueCommand(runId, { type: "message", text: "one" });
  const second = await store.enqueueCommand(runId, { type: "deny", pendingId: "p1", reason: null });
  assert.match(first.id, /^cmd_/);
  assert.deepEqual(first, { id: first.id, runId, command: { type: "message", text: "one" }, createdAt: clock.now(), consumedAt: null });
  assert.deepEqual((await store.listCommands(runId)).map((c) => c.id), [first.id, second.id]);
  const lease = { runId, runnerId: "r", epoch: 1 };
  clock.advance(5);
  await store.commit(lease, { records: [{ type: "command.applied", data: { commandId: first.id, command: first.command as never } }], consumeCommands: [first.id] });
  const all = await store.listCommands(runId);
  assert.equal(all[0]!.consumedAt, clock.now());
  assert.equal(all[1]!.consumedAt, null);
  assert.deepEqual((await store.listCommands(runId, { unconsumedOnly: true })).map((c) => c.id), [second.id]);
  await store.commit(lease, { records: [], consumeCommands: [first.id] });
  assert.equal((await store.listCommands(runId))[0]!.consumedAt, clock.now(), "consuming twice keeps the first time");
});
