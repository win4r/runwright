/**
 * The inbox is taken under the session's commit lock (plan 3.2 E2, R09D-engine-02): `SessionCore.commit` accepts a
 * builder that runs inside the lock after every earlier commit was applied, and `ctx.inbox` builds its
 * `inbox.taken` record that way, so concurrent takes under different keys never hand one message out twice.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Json, JsonObject } from "../../src/core/json.ts";
import type { JournalRecord } from "../../src/store/types.ts";
import type { SessionCore } from "../../src/engine/context.ts";
import { newRecord } from "../../src/engine/journal-types.ts";
import { startSession } from "../../src/engine/session.ts";
import type { Driver, InboxMessage } from "../../src/engine/types.ts";
import { createHarness, fakeModels, reply } from "../helpers/engine.ts";
import { waitFor } from "../helpers/wait.ts";

const models = fakeModels(() => reply({}));

const texts = (messages: readonly InboxMessage[]): string[] => messages.map((m) => m.text);

test("two child contexts take the inbox at the same time: the message goes to exactly one key, and replay agrees", async (t) => {
  const seen: { a: string[]; b: string[] }[] = [];
  const driver: Driver = async (ctx) => {
    await ctx.ask("q1", { question: "ready?" });
    const [a, b] = await Promise.all([ctx.child("x").inbox("a"), ctx.child("y").inbox("b")]);
    seen.push({ a: texts(a), b: texts(b) });
    await ctx.ask("q2", { question: "again?" });
    return { a: texts(a), b: texts(b) };
  };
  const h = await createHarness(t, { models, drivers: { agent: driver } });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id);
  await h.until(run.id, "waiting");
  const [q1] = await h.pendings(run.id);
  await h.send(run.id, { type: "message", text: "hello" });
  await h.send(run.id, { type: "answer", pendingId: (q1 as { id: string }).id, answer: "yes" });
  await waitFor(async () => (await h.pendings(run.id)).some((p) => p.stepKey === "q2"));
  await h.until(run.id, "waiting");

  assert.equal(seen.length, 1);
  const first = seen[0] as { a: string[]; b: string[] };
  assert.deepEqual([...first.a, ...first.b], ["hello"], "exactly one key got the message");
  const taken = await h.records(run.id, "inbox.taken");
  assert.equal(taken.length, 2);
  assert.equal(taken.flatMap((x) => x.messages).length, 1, "the message is in exactly one inbox.taken record");

  await h.crashAndReplace();
  const [q2] = await h.pendings(run.id);
  await h.send(run.id, { type: "answer", pendingId: (q2 as { id: string }).id, answer: "yes" });
  const done = await h.until(run.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.deepEqual(done.output, first as unknown as Json, "the replayed run gives each key the same answer");
  assert.equal((await h.records(run.id, "inbox.taken")).length, 2, "replay journals no further take");
});

test("twenty concurrent inbox takes with five messages: every message is in exactly one record", async (t) => {
  const driver: Driver = async (ctx) => {
    await ctx.ask("q", { question: "ready?" });
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => ctx.child(`c${i}`).inbox("in")));
    return results.map(texts);
  };
  const h = await createHarness(t, { models, drivers: { agent: driver } });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id);
  await h.until(run.id, "waiting");
  const [q] = await h.pendings(run.id);
  for (let i = 1; i <= 5; i++) await h.send(run.id, { type: "message", text: `m${i}` });
  await h.send(run.id, { type: "answer", pendingId: (q as { id: string }).id, answer: "go" });
  const done = await h.until(run.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  const delivered = (done.output as string[][]).flat();
  assert.deepEqual([...delivered].sort(), ["m1", "m2", "m3", "m4", "m5"]);
  const taken = await h.records(run.id, "inbox.taken");
  assert.equal(taken.length, 20);
  const ids = taken.flatMap((x) => x.messages.map((m) => m.commandId));
  assert.equal(ids.length, 5);
  assert.equal(new Set(ids).size, 5);
  assert.deepEqual(await h.records(run.id, "message.undelivered"), []);
});

test("SessionCore.commit runs a builder inside the lock after earlier commits; a null batch writes nothing", async (t) => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  let entered = false;
  const driver: Driver = async () => {
    entered = true;
    await hold;
    return null;
  };
  const h = await createHarness(t, { models, drivers: { agent: driver }, autoStart: false });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id);
  const [claimed] = await h.store.claimRuns({ runnerId: "test-runner", limit: 1, leaseMs: 5_000 });
  assert.ok(claimed !== undefined);
  const session = startSession(h.deps(), claimed, "test-runner", () => undefined);
  const core = session as unknown as SessionCore;
  await waitFor(() => entered);
  const before = (await h.journal(run.id)).length;

  const empty = await core.commit(() => null);
  assert.deepEqual(empty, []);
  assert.equal((await h.journal(run.id)).length, before, "a null batch writes no record");

  let seenCount = -1;
  const first = core.commit({ records: [newRecord("run.claimed", { runnerId: "marker" })] });
  const built = core.commit(() => {
    seenCount = core.state.records.length;
    return { records: [{ type: "test.built", key: "b", data: { saw: seenCount } as JsonObject }] };
  });
  const [firstStored] = await first;
  const [builtStored] = await built;
  assert.equal(seenCount, (firstStored as JournalRecord).seq, "the builder saw the earlier commit applied");
  assert.equal((builtStored as JournalRecord).type, "test.built");
  assert.equal((await h.journal(run.id)).length, before + 2);

  release();
  await session.done;
  assert.equal((await h.store.getRun(run.id))?.status, "completed");
});
