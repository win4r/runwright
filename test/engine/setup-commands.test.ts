/**
 * A command that arrives while a session is still setting up (claiming its workspace stage, reading the journal)
 * is planned against the replayed state, never against the empty state the session starts with: an answer to an
 * open question is applied, not rejected as "does not belong to this run".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Driver } from "../../src/engine/types.ts";
import type { Store } from "../../src/store/types.ts";
import { createHarness, fakeModels, reply, storeWith } from "../helpers/engine.ts";

test("an answer that arrives during a session's setup is applied against the replayed journal", async (t) => {
  let pendingId: string | null = null;
  let arrive: ((store: Store) => Promise<void>) | null = null;
  const wrapStore = (store: Store): Store => storeWith(store, {
    async readJournal(runId, options) {
      const page = await store.readJournal(runId, options);
      const deliver = arrive;
      if (deliver !== null) {
        arrive = null;
        await deliver(store);
        // Long enough for the store event to reach the session and any background application to run.
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      return page;
    },
  });
  const driver: Driver = async (ctx) => {
    const { answer } = await ctx.ask("q", { question: "Which?" });
    return { answer };
  };
  const h = await createHarness(t, { models: fakeModels(() => reply({})), drivers: { agent: driver }, wrapStore });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id);
  await h.until(run.id, "waiting");
  const [pending] = await h.pendings(run.id);
  assert.ok(pending !== undefined);
  pendingId = pending.id;
  const runId = run.id;
  arrive = async (store) => {
    await store.enqueueCommand(runId, { type: "answer", pendingId: pendingId as string, answer: "this one" });
  };
  // A message requeues the run; the session that claims it receives the answer while it reads the journal.
  await h.send(run.id, { type: "message", text: "wake up" });
  const done = await h.until(run.id, ["completed", "waiting", "failed"]);
  assert.deepEqual(await h.records(run.id, "command.rejected"), []);
  assert.equal(done.status, "completed");
  assert.deepEqual(done.output, { answer: "this one" });
});
