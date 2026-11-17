/**
 * R15D-engine-01: a call's own approval decision is read before the run-wide grant. (a) A call whose own approval
 * pending was resolved is decided by that resolution, whatever "approve always" says: denied gives the `denied`
 * result, approved runs. (b) Approve-always resolves every other open approval pending of that tool in the run,
 * in the same commit, with `{decision: "approve", always: true}` and the command's id; none stays open. (c) The
 * server deny list still wins over everything.
 *
 * Every probe applies its commands while no session runs (the run is waiting and nothing claims it), so the steps
 * resume only once all of them are applied.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RunwrightError } from "../../src/core/errors.ts";
import type { Json } from "../../src/core/json.ts";
import { settleAll } from "../../src/engine/control.ts";
import { replayJournal } from "../../src/engine/state.ts";
import type { Driver, RunContext, ToolStepResult } from "../../src/engine/types.ts";
import type { CommitBatch, JournalRecord, Lease, PendingRecord, Store } from "../../src/store/types.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import { commandGate, createHarness, fakeModels, fakeTimers, reply, storeWith, type Harness } from "../helpers/engine.ts";

interface Acting { tool: ToolDefinition; ran: number[] }

/** A write tool; `ran` lists the `n` of every handler invocation. */
function acting(): Acting {
  const ran: number[] = [];
  return {
    ran,
    tool: {
      name: "act", description: "Acts.", effect: "write",
      parameters: { type: "object", required: ["n"], properties: { n: { type: "integer" } } },
      handler: async (args) => {
        ran.push(Number(args["n"]));
        return { content: `acted ${String(args["n"])}` };
      },
    },
  };
}

/** `count` parallel calls of `act` (keys c1…), then one later call (key later). */
function parallelDriver(count: number): Driver {
  return async (ctx) => {
    const calls: Promise<ToolStepResult>[] = [];
    for (let n = 1; n <= count; n++) calls.push(ctx.tool(`c${n}`, { name: "act", args: { n } }));
    const results = await settleAll(calls);
    const later = await ctx.tool("later", { name: "act", args: { n: count + 1 } });
    return { outcomes: results.map((r) => r.outcome), later: later.outcome } as Json;
  };
}

const noModel = fakeModels(() => reply({}));

async function setup(t: Parameters<typeof createHarness>[0], count: number, extra?: { wrapStore?: (store: Store) => Store; clock?: ReturnType<typeof fakeTimers>["clock"] }) {
  const act = acting();
  const h = await createHarness(t, {
    models: noModel, tools: [act.tool], drivers: { agent: parallelDriver(count) }, autoStart: false, ...extra,
  });
  const agent = await h.saveAgent({ tools: [{ name: "act", policy: "ask" }] });
  const run = await h.start(agent.id);
  const first = await h.claimSession();
  await first.session.done;
  assert.equal((await h.store.getRun(run.id))?.status, "waiting");
  const pendings = (await h.pendings(run.id)).sort((a, b) => a.stepKey.localeCompare(b.stepKey));
  assert.deepEqual(pendings.map((p) => [p.kind, p.stepKey]), Array.from({ length: count }, (_, i) => ["approval", `c${i + 1}`]));
  return { h, act, runId: run.id, pendings };
}

function byKey(pendings: readonly PendingRecord[], key: string): PendingRecord {
  const found = pendings.find((p) => p.stepKey === key);
  assert.ok(found !== undefined, `a pending at ${key}`);
  return found;
}

async function outcome(h: Harness, runId: string): Promise<Json> {
  const done = await h.until(runId, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  return done.output;
}

test("(R15D-engine-01) the reviewer's probe: one call denied, the other approved always; the denied call never runs", async (t) => {
  const { h, act, runId, pendings } = await setup(t, 2);
  await h.send(runId, { type: "deny", pendingId: byKey(pendings, "c1").id, reason: "not this one" });
  await h.send(runId, { type: "approve", pendingId: byKey(pendings, "c2").id, always: true });
  await h.claimSession();
  assert.deepEqual(await outcome(h, runId), { outcomes: ["denied", "ok"], later: "ok" });
  assert.deepEqual(act.ran, [2, 3], "the denied handler never ran; the later call ran without asking");
  const finished = (await h.records(runId, "tool.finished")).find((r) => r.outcome === "denied");
  assert.match(finished?.content ?? "", /denied by a person: not this one/);
  assert.equal((await h.records(runId, "pending.opened")).length, 2, "the later call opened no approval");
});

test("(R15D-engine-01) approve-always first, deny second in one batch: the deny is rejected as already resolved and both run", async (t) => {
  const { h, act, runId, pendings } = await setup(t, 2);
  await h.send(runId, { type: "approve", pendingId: byKey(pendings, "c1").id, always: true });
  await h.send(runId, { type: "deny", pendingId: byKey(pendings, "c2").id, reason: "too late" });
  await h.claimSession();
  assert.deepEqual(await outcome(h, runId), { outcomes: ["ok", "ok"], later: "ok" });
  assert.deepEqual(act.ran.sort(), [1, 2, 3]);
  const [rejected] = await h.records(runId, "command.rejected");
  assert.equal(rejected?.reason, `pending ${byKey(pendings, "c2").id} is already resolved`);
});

test("(R15D-engine-01) approve-always on one of three: the other two are resolved in the same commit and nothing stays open", async (t) => {
  const { h, act, runId, pendings } = await setup(t, 3);
  await h.send(runId, { type: "approve", pendingId: byKey(pendings, "c2").id, always: true });
  await h.claimSession();
  assert.deepEqual(await outcome(h, runId), { outcomes: ["ok", "ok", "ok"], later: "ok" });
  assert.deepEqual(act.ran.sort(), [1, 2, 3, 4]);
  const journal = await h.journal(runId);
  const applied = journal.find((r) => r.type === "command.applied");
  assert.ok(applied !== undefined);
  const commandId = applied.data["commandId"];
  const following = journal.slice(journal.indexOf(applied) + 1, journal.indexOf(applied) + 4);
  assert.deepEqual(following.map((r) => [r.type, r.key, r.data["commandId"], r.data["resolution"]]).sort(),
    ["c1", "c2", "c3"].map((key) => ["pending.resolved", key, commandId, { decision: "approve", always: true, reason: null }]),
    "the three approvals are resolved right after the command, by it");
  assert.equal(new Set(following.map((r) => r.seq - applied.seq)).size, 3);
  assert.deepEqual(await h.pendings(runId), []);
  const state = replayJournal(journal, { maxCostMicros: null, maxToolCalls: null, maxTurns: null, allowUnpriced: false });
  assert.deepEqual([...state.pendings.values()].map((p) => p.resolution?.["decision"]), ["approve", "approve", "approve"]);
});

test("(R15D-engine-01) across a restart: the session that replays the applied decisions runs only the approved call", async (t) => {
  const timers = fakeTimers();
  let crash = false;
  const wrapStore = (store: Store): Store => storeWith(store, {
    async commit(lease: Lease, batch: CommitBatch) {
      if (crash && batch.records.some((r) => r.type === "tool.started")) {
        crash = false;
        throw new RunwrightError("lease_lost", "the test crashed the session before its first tool.started");
      }
      return store.commit(lease, batch);
    },
  });
  const { h, act, runId, pendings } = await setup(t, 2, { wrapStore, clock: timers.clock });
  await h.send(runId, { type: "deny", pendingId: byKey(pendings, "c1").id, reason: null });
  await h.send(runId, { type: "approve", pendingId: byKey(pendings, "c2").id, always: true });
  crash = true;
  const second = await h.claimSession();
  await second.session.done;
  assert.deepEqual(act.ran, [], "the second session applied the commands and crashed before any handler ran");
  assert.equal((await h.records(runId, "command.applied")).length, 2);

  timers.advance(30_001);
  await h.claimSession();
  assert.deepEqual(await outcome(h, runId), { outcomes: ["denied", "ok"], later: "ok" });
  assert.deepEqual(act.ran, [2, 3]);
  assert.equal((await h.records(runId, "command.applied")).length, 2, "the commands were applied once");
});

test("(R15D-engine-01) an approve-always applied while another call of the tool is about to open its approval: it opens none and runs", async (t) => {
  const act = acting();
  const gate = commandGate();
  let store: Store | null = null;
  const firstPending = (ctx: RunContext): string | null => {
    const opened = ctx.journal().find((r: JournalRecord) => r.type === "pending.opened" && r.key === "a");
    return opened === undefined ? null : String((opened.data["pending"] as { id: string }).id);
  };
  let armed = true;
  const driver: Driver = async (ctx) => {
    const b = async (): Promise<ToolStepResult> => {
      if (armed) {
        armed = false;
        while (firstPending(ctx) === null) await new Promise((resolve) => setTimeout(resolve, 2));
        await gate.hold(store as Store, ctx.run.id, { type: "approve", pendingId: firstPending(ctx) as string, always: true });
        const call = ctx.tool("b", { name: "act", args: { n: 2 } });
        gate.releaseSoon();
        return call;
      }
      return ctx.tool("b", { name: "act", args: { n: 2 } });
    };
    const results = await settleAll([ctx.tool("a", { name: "act", args: { n: 1 } }), b()]);
    return { outcomes: results.map((r) => r.outcome) };
  };
  const h = await createHarness(t, { models: noModel, tools: [act.tool], drivers: { agent: driver }, wrapStore: gate.wrap });
  store = h.store;
  const agent = await h.saveAgent({ tools: [{ name: "act", policy: "ask" }] });
  const run = await h.start(agent.id);
  assert.deepEqual(await outcome(h, run.id), { outcomes: ["ok", "ok"] });
  assert.deepEqual(act.ran.sort(), [1, 2]);
  const opened = (await h.journal(run.id)).filter((r) => r.type === "pending.opened");
  assert.deepEqual(opened.map((r) => r.key), ["a"], "the call at b opened no approval once the tool was approved always");
});

test("the server deny list still wins: a tool on it is denied even with an approved pending", async (t) => {
  const { h, act, runId, pendings } = await setup(t, 1);
  await h.send(runId, { type: "approve", pendingId: byKey(pendings, "c1").id, always: true });
  h.newRunner({ denyTools: ["act"] });
  assert.deepEqual(await outcome(h, runId), { outcomes: ["denied"], later: "denied" });
  assert.deepEqual(act.ran, []);
  const contents = (await h.records(runId, "tool.finished")).map((r) => r.content);
  assert.ok(contents.every((c) => /denied by the server's deny list/.test(c)), contents.join(" | "));
});
