import { test } from "node:test";
import assert from "node:assert/strict";
import { openTestStore, testAgentDefinition } from "../helpers/store.ts";
import { createFakeClock } from "../../src/core/clock.ts";
import { isRunwrightError } from "../../src/core/errors.ts";
import type { PendingRecord } from "../../src/store/types.ts";

const code = (c: string) => (e: unknown): boolean => isRunwrightError(e) && e.code === c;

test("pendings open and resolve in commits, keep open_pendings, and list with filters", async (t) => {
  const clock = createFakeClock(2_000);
  const { store } = await openTestStore(t, { clock });
  await store.saveAgent({ id: "a", definition: testAgentDefinition() });
  await store.saveAgent({ id: "b", definition: testAgentDefinition() });
  await store.createRun({ agentId: "a", input: { message: "", data: null } });
  await store.createRun({ agentId: "b", input: { message: "", data: null } });
  const claims = await store.claimRuns({ runnerId: "r", limit: 2, leaseMs: 10_000 });
  const [ca, cb] = claims as [typeof claims[0], typeof claims[0]];
  const opened = await store.commit(ca.lease, {
    records: [{ type: "pending.opened", key: "t1", data: {} }],
    openPendings: [
      { id: "pnd_q", kind: "question", stepKey: "t1", title: "Which colour?", detail: { question: "Which colour?", choices: ["red"] } },
      { id: "pnd_a", kind: "approval", stepKey: "t1.c0", title: "Approve shell: ls", detail: { tool: "shell", args: { cmd: "ls" } } },
    ],
  });
  assert.equal(opened.run.openPendings, 2);
  clock.advance(1);
  await store.commit(cb.lease, { records: [], openPendings: [{ id: "pnd_c", kind: "spend_cap", stepKey: "t2", title: "Cap",
    detail: { capMicros: 1, spentMicros: 1, neededMicros: 5, nextCallWorstCaseMicros: 5, reason: "cap", model: "m" } }] });

  const q = await store.getPending("pnd_q");
  assert.deepEqual(q, { id: "pnd_q", runId: ca.run.id, agentId: "a", kind: "question", stepKey: "t1", title: "Which colour?",
    detail: { question: "Which colour?", choices: ["red"] }, status: "open", resolution: null, createdAt: 2_000, resolvedAt: null } satisfies PendingRecord);
  assert.equal(await store.getPending("pnd_none"), null);

  clock.advance(1);
  const resolved = await store.commit(ca.lease, { records: [], resolvePendings: [{ id: "pnd_q", resolution: { answer: "red" } }] });
  assert.equal(resolved.run.openPendings, 1);
  const after = await store.getPending("pnd_q");
  assert.equal(after?.status, "resolved");
  assert.deepEqual(after?.resolution, { answer: "red" });
  assert.equal(after?.resolvedAt, 2_002);
  await assert.rejects(store.commit(ca.lease, { records: [], resolvePendings: [{ id: "pnd_q", resolution: {} }] }), code("conflict"));
  await assert.rejects(store.commit(cb.lease, { records: [], resolvePendings: [{ id: "pnd_a", resolution: {} }] }), code("conflict"),
    "a run cannot resolve another run's pending");

  const ids = async (filter: Parameters<typeof store.listPendings>[0]) => (await store.listPendings(filter, { limit: 50 })).items.map((p) => p.id);
  assert.deepEqual(await ids({}), ["pnd_a", "pnd_q", "pnd_c"]);
  assert.deepEqual(await ids({ status: "open" }), ["pnd_a", "pnd_c"]);
  assert.deepEqual(await ids({ status: "resolved" }), ["pnd_q"]);
  assert.deepEqual(await ids({ runId: cb.run.id }), ["pnd_c"]);
  assert.deepEqual(await ids({ agentId: "a" }), ["pnd_a", "pnd_q"]);
  assert.deepEqual(await ids({ kind: "spend_cap" }), ["pnd_c"]);

  const p1 = await store.listPendings({}, { limit: 2 });
  assert.deepEqual(p1.items.map((p) => p.id), ["pnd_a", "pnd_q"]);
  assert.ok(p1.nextCursor !== null);
  const p2 = await store.listPendings({}, { limit: 2, cursor: p1.nextCursor! });
  assert.deepEqual(p2.items.map((p) => p.id), ["pnd_c"]);
  assert.equal(p2.nextCursor, null);
  await assert.rejects(store.listPendings({}, { limit: 2, cursor: "%%%" }), code("bad_request"));
  for (const limit of [0, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(store.listPendings({}, { limit }), code("bad_request"), `limit ${limit}`);
  }
  assert.equal((await store.listPendings({}, { limit: 1000 })).items.length, 3);
});
