import { test } from "node:test";
import assert from "node:assert/strict";
import { openTestStore, testAgentDefinition } from "../helpers/store.ts";
import type { StoreEvent } from "../../src/store/types.ts";

test("events are emitted after commit, in registration order, and a throwing listener is ignored", async (t) => {
  const { store } = await openTestStore(t);
  await store.saveAgent({ id: "a", definition: testAgentDefinition() });
  const seen: string[] = [];
  const events: StoreEvent[] = [];
  store.subscribe(() => {
    seen.push("first");
    throw new Error("listener failure");
  });
  const off = store.subscribe((event) => {
    seen.push("second");
    events.push(event);
  });

  let visibleInListener: string | null = null;
  const offProbe = store.subscribe((event) => {
    if (event.type === "run.queued" && visibleInListener === null) {
      void store.getRun(event.runId).then((run) => {
        visibleInListener = run?.status ?? "missing";
      });
    }
  });

  const { run } = await store.createRun({ agentId: "a", input: { message: "", data: null } });
  assert.deepEqual(events, [{ type: "run.queued", runId: run.id }]);
  assert.deepEqual(seen, ["first", "second"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(visibleInListener, "queued", "the row is committed when the event fires");
  offProbe();

  const [claim] = await store.claimRuns({ runnerId: "r", limit: 1, leaseMs: 1000 });
  assert.equal(events.length, 1, "claiming emits nothing");
  const first = await store.enqueueCommand(run.id, { type: "message", text: "x" });
  assert.deepEqual(events.at(-1), { type: "command", runId: run.id });

  const result = await store.commit(claim!.lease, {
    records: [{ type: "run.waiting", data: { pendingIds: [] } }], consumeCommands: [first.id], transition: { to: "waiting" },
  });
  assert.deepEqual(events.at(-1), { type: "journal", runId: run.id, status: "waiting", records: result.records });

  const before = events.length;
  await store.enqueueCommand(run.id, { type: "message", text: "y" });
  assert.deepEqual(events.slice(before), [{ type: "command", runId: run.id }, { type: "run.queued", runId: run.id }]);

  const [again] = await store.claimRuns({ runnerId: "r", limit: 1, leaseMs: 1000 });
  const mark = events.length;
  await store.commit(again!.lease, { records: [{ type: "run.released", data: { reason: "shutdown" } }], transition: { to: "queued" } });
  assert.deepEqual(events.slice(mark).map((e) => e.type), ["journal", "run.queued"]);

  const failedAt = events.length;
  await assert.rejects(store.commit(again!.lease, { records: [] }));
  assert.equal(events.length, failedAt, "a failed commit emits nothing");

  off();
  await store.createRun({ agentId: "a", input: { message: "", data: null } });
  assert.equal(events.length, failedAt);
});
