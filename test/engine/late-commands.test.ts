/**
 * Commands that arrive while a run is finishing are never stranded (plan 4.2, finding R02-02). The runner polls
 * every 10 minutes and the commands are written through a second store handle, so the session gets no in-process
 * event and no poll: the command is unconsumed exactly when the session tries to leave `running`.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { Message } from "../../src/models/types.ts";
import { openSqliteStore } from "../../src/store/sqlite.ts";
import type { JournalRecord, RunCommand, RunRecord, Store } from "../../src/store/types.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import { ControlSignal, isControlSignal } from "../../src/engine/control.ts";
import { MESSAGE_TOO_LATE, MESSAGE_UNDELIVERED } from "../../src/engine/commands.ts";
import { replayJournal } from "../../src/engine/state.ts";
import type { Driver, Drivers, LearningHooks } from "../../src/engine/types.ts";
import { createHarness, fakeModels, reply, toolReply, type Harness, type HarnessOptions } from "../helpers/engine.ts";
import { waitFor } from "../helpers/wait.ts";

interface Gate { wait: Promise<void>; open(): void }
function gate(): Gate {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open: () => open() };
}

const QUIET = { pollMs: 600_000 };

async function setup(t: TestContext, options: Omit<HarnessOptions, "engine">): Promise<{ h: Harness; other: Store }> {
  const h = await createHarness(t, { ...options, engine: QUIET });
  const other = await openSqliteStore({ path: join(h.dir, "runwright.db") });
  t.after(() => other.close());
  return { h, other };
}

const TERMINAL: RunRecord["status"][] = ["completed", "failed", "cancelled"];

async function unconsumed(h: Harness, runId: string): Promise<number> {
  return (await h.store.listCommands(runId, { unconsumedOnly: true })).length;
}

const types = (journal: readonly JournalRecord[]): string[] => journal.map((r) => r.type);

test("a cancel written while the last step is in flight ends the run cancelled, not completed", async (t) => {
  const entered = gate();
  const release = gate();
  const models = fakeModels(async () => {
    entered.open();
    await release.wait;
    return reply({ text: "done" });
  });
  const { h, other } = await setup(t, { models });
  const run = await h.start((await h.saveAgent()).id);
  await entered.wait;
  const cancel = await other.enqueueCommand(run.id, { type: "cancel", reason: "too late?" });
  release.open();
  const done = await h.until(run.id, TERMINAL);
  assert.equal(done.status, "cancelled");
  const journal = await h.journal(run.id);
  const applied = journal.findIndex((r) => r.type === "command.applied" && r.data["commandId"] === cancel.id);
  const cancelled = journal.findIndex((r) => r.type === "run.cancelled");
  assert.ok(applied >= 0 && cancelled > applied, types(journal).join(", "));
  assert.equal(journal.some((r) => r.type === "run.completed"), false);
  assert.deepEqual(journal[cancelled]?.data, { reason: "too late?" });
  assert.equal(await unconsumed(h, run.id), 0);
});

test("a pause written while the last step is in flight leaves the run paused; resume completes it without repeating a step", async (t) => {
  const entered = gate();
  const release = gate();
  let toolCalls = 0;
  let modelCalls = 0;
  const gated: ToolDefinition = {
    name: "gated", description: "waits for the test", effect: "write", parameters: { type: "object", properties: {} },
    async handler() {
      toolCalls++;
      entered.open();
      await release.wait;
      return { content: "gated done" };
    },
  };
  const models = fakeModels((request) => {
    modelCalls++;
    return request.messages.some((m) => m.role === "tool") ? reply({ text: "final" }) : toolReply("gated", {});
  });
  const { h, other } = await setup(t, { models, tools: [gated] });
  const run = await h.start((await h.saveAgent({ tools: [{ name: "gated" }] })).id);
  await entered.wait;
  await other.enqueueCommand(run.id, { type: "pause" });
  release.open();
  const paused = await h.until(run.id, [...TERMINAL, "paused"]);
  assert.equal(paused.status, "paused");
  const before = await h.journal(run.id);
  assert.ok(types(before).includes("run.output"));
  assert.ok(types(before).includes("run.paused"));
  assert.equal(types(before).includes("run.completed"), false);
  assert.equal(await unconsumed(h, run.id), 0);

  await h.send(run.id, { type: "resume" });
  const done = await h.until(run.id, TERMINAL);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.deepEqual(done.output, { text: "final" });
  assert.equal(toolCalls, 1);
  assert.equal(modelCalls, 2);
  assert.equal((await h.records(run.id, "run.output")).length, 1);
  assert.equal(await unconsumed(h, run.id), 0);
});

test("a message written after the driver returned is rejected as too late and the run completes", async (t) => {
  const entered = gate();
  const release = gate();
  const learning: LearningHooks = {
    prepare: async () => null,
    afterRun: async () => {
      entered.open();
      await release.wait;
    },
  };
  const { h, other } = await setup(t, { models: fakeModels(() => reply({ text: "done" })), learning });
  const run = await h.start((await h.saveAgent({ learning: true })).id);
  await entered.wait;
  const message = await other.enqueueCommand(run.id, { type: "message", text: "one more thing" });
  release.open();
  const done = await h.until(run.id, TERMINAL);
  assert.equal(done.status, "completed");
  const rejected = await h.records(run.id, "command.rejected");
  assert.deepEqual(rejected.map((r) => [r.commandId, r.reason]), [[message.id, MESSAGE_TOO_LATE]]);
  assert.equal((await h.records(run.id, "command.applied")).length, 0);
  assert.equal(await unconsumed(h, run.id), 0);
});

test("a message applied before the output but never taken is journalled message.undelivered with run.output", async (t) => {
  const entered = gate();
  const release = gate();
  const neverReads: Driver = async () => {
    entered.open();
    await release.wait;
    return { text: "ignored the inbox" };
  };
  const { h } = await setup(t, { models: fakeModels(() => reply({ text: "unused" })), drivers: { agent: neverReads } });
  const run = await h.start((await h.saveAgent()).id);
  await entered.wait;
  await h.send(run.id, { type: "message", text: "are you there?" });
  await waitFor(async () => (await h.records(run.id, "command.applied")).some((r) => r.command.type === "message"));
  release.open();
  const done = await h.until(run.id, TERMINAL);
  assert.equal(done.status, "completed");
  const journal = await h.journal(run.id);
  const applied = journal.find((r) => r.type === "command.applied") as JournalRecord;
  const output = journal.find((r) => r.type === "run.output") as JournalRecord;
  const undelivered = journal.filter((r) => r.type === "message.undelivered");
  assert.equal(undelivered.length, 1);
  assert.deepEqual(undelivered[0]?.data, { commandId: applied.data["commandId"], reason: MESSAGE_UNDELIVERED });
  assert.equal(undelivered[0]?.seq, output.seq + 1, "adjacent to run.output");
  assert.equal(undelivered[0]?.ts, output.ts, "in the same commit as run.output");
  assert.deepEqual(replayJournal(journal, done.limits).messages, [], "a replay has an empty inbox");
  assert.equal(await unconsumed(h, run.id), 0);
});

test("a run that fails while an answer is unconsumed ends failed with the answer consumed", async (t) => {
  const entered = gate();
  const release = gate();
  const asksThenFails: Driver = async (ctx) => {
    try {
      await ctx.ask("q", { question: "Which one?" });
    } catch (error) {
      if (!isControlSignal(error)) throw error;
    }
    entered.open();
    await release.wait;
    throw new Error("boom");
  };
  const { h, other } = await setup(t, { models: fakeModels(() => reply({})), drivers: { agent: asksThenFails } });
  const run = await h.start((await h.saveAgent()).id);
  await entered.wait;
  const [pending] = await h.pendings(run.id);
  assert.ok(pending !== undefined);
  const answer = await other.enqueueCommand(run.id, { type: "answer", pendingId: pending.id, answer: "the blue one" });
  release.open();
  const done = await h.until(run.id, TERMINAL);
  assert.equal(done.status, "failed");
  assert.match(done.error?.message ?? "", /boom/);
  const accounted = (await h.journal(run.id)).filter((r) => (r.type === "command.applied" || r.type === "command.rejected") && r.data["commandId"] === answer.id);
  assert.equal(accounted.length, 1);
  assert.equal(await unconsumed(h, run.id), 0);
  assert.deepEqual(await h.pendings(run.id), []);
});

for (const how of ["throws", "suspends with nothing to wait for"] as const) {
  test(`a run that ${how} while a cancel is unconsumed ends cancelled`, async (t) => {
    const entered = gate();
    const release = gate();
    const fails: Driver = async () => {
      entered.open();
      await release.wait;
      if (how === "throws") throw new Error("boom");
      throw new ControlSignal("waiting");
    };
    const { h, other } = await setup(t, { models: fakeModels(() => reply({})), drivers: { agent: fails } });
    const run = await h.start((await h.saveAgent()).id);
    await entered.wait;
    await other.enqueueCommand(run.id, { type: "cancel", reason: null });
    release.open();
    const done = await h.until(run.id, TERMINAL);
    assert.equal(done.status, "cancelled");
    assert.equal((await h.records(run.id, "run.failed")).length, 0);
    assert.equal(await unconsumed(h, run.id), 0);
  });
}

// ------------------------------------------------------------------ audit

/** mulberry32: a small seeded PRNG, so a failure reproduces. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface Plan { tools: number; learning: boolean; at: string; kind: "cancel" | "pause" | "message"; via: "main" | "other"; fired: boolean }

/** The agent loop with an inbox check before every turn; messages become user messages. */
const inboxDriver: Driver = async (ctx) => {
  const messages: Message[] = [{ role: "user", content: ctx.run.input.message }];
  for (let turn = 1; ; turn++) {
    for (const m of await ctx.inbox(`i${turn}`)) messages.push({ role: "user", content: m.text });
    const result = await ctx.model(`t${turn}`, { purpose: "run", system: "s", messages: [...messages], tools: ctx.toolSpecs(), turn });
    messages.push({ role: "assistant", content: result.text, toolCalls: result.toolCalls });
    if (result.toolCalls.length === 0) return { text: result.text };
    for (const [i, call] of result.toolCalls.entries()) {
      const r = await ctx.tool(`t${turn}.c${i}`, { name: call.name, args: call.args, callId: call.id });
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: r.content, isError: r.isError });
    }
  }
};

test("audit: a command at a random step boundary never strands, repeats a step or loses a message", async (t) => {
  const random = prng(20_261_113);
  const plans = new Map<string, Plan>();
  const handlerRuns = new Map<string, number>();
  let stores: { main: Store; other: Store } | null = null;

  const boundary = async (runId: string, step: string): Promise<void> => {
    const plan = plans.get(runId);
    if (plan === undefined || plan.fired || plan.at !== step || stores === null) return;
    plan.fired = true;
    const command: RunCommand = plan.kind === "cancel" ? { type: "cancel", reason: "audit" }
      : plan.kind === "pause" ? { type: "pause" } : { type: "message", text: `note for ${step}` };
    await (plan.via === "main" ? stores.main : stores.other).enqueueCommand(runId, command);
    // Give the session's event-driven apply (a macrotask) its chance while the step is still in flight.
    await new Promise((resolve) => setTimeout(resolve, 2));
  };
  const step: ToolDefinition = {
    name: "step", description: "a step", effect: "write", parameters: { type: "object", properties: { i: { type: "integer" } } },
    async handler(args, context) {
      const slot = `${context.runId} ${String(args["i"])}`;
      handlerRuns.set(slot, (handlerRuns.get(slot) ?? 0) + 1);
      await boundary(context.runId, `tool:${String(args["i"])}`);
      return { content: `step ${String(args["i"])}` };
    },
  };
  const models = fakeModels(async (request) => {
    const runId = request.meta.runId;
    const done = request.messages.filter((m) => m.role === "tool").length;
    await boundary(runId, `model:${done}`);
    const plan = plans.get(runId);
    return done < (plan?.tools ?? 0) ? toolReply("step", { i: done }, `c${done}`) : reply({ text: "finished" });
  });
  const learning: LearningHooks = {
    prepare: async () => null,
    afterRun: async (ctx) => {
      await ctx.memo("learn", { recordType: "step", name: "learn" }, async () => {
        await boundary(ctx.run.id, "learn");
        return "kept";
      });
    },
  };
  const drivers: Partial<Drivers> = { agent: inboxDriver };
  const { h, other } = await setup(t, { models, tools: [step], learning, drivers });
  stores = { main: h.store, other };
  const plain = (await h.saveAgent({ tools: [{ name: "step" }] })).id;
  const learner = (await h.saveAgent({ tools: [{ name: "step" }], learning: true })).id;

  const kinds = ["cancel", "pause", "message"] as const;
  const runs: { run: RunRecord; plan: Plan }[] = [];
  for (let i = 0; i < 36; i++) {
    const tools = 1 + Math.floor(random() * 2);
    const withLearning = random() < 0.5;
    const steps = [...Array.from({ length: tools + 1 }, (_, n) => `model:${n}`), ...Array.from({ length: tools }, (_, n) => `tool:${n}`)];
    if (withLearning) steps.push("learn");
    const plan: Plan = {
      tools, learning: withLearning, at: steps[Math.floor(random() * steps.length)] as string,
      kind: kinds[Math.floor(random() * kinds.length)] as Plan["kind"], via: random() < 0.5 ? "main" : "other", fired: false,
    };
    const run = await h.store.createRun({ agentId: withLearning ? learner : plain, input: { message: "go", data: null } });
    plans.set(run.run.id, plan);
    runs.push({ run: run.run, plan });
  }

  const fates = { taken: 0, undelivered: 0, rejected: 0 };
  for (const { run, plan } of runs) {
    const label = `${run.id} ${JSON.stringify(plan)}`;
    let final = await h.until(run.id, [...TERMINAL, "paused"]);
    for (let resumes = 0; final.status === "paused"; resumes++) {
      assert.ok(resumes < 3, `${label} paused again and again`);
      await h.send(run.id, { type: "resume" });
      final = await h.until(run.id, [...TERMINAL, "paused"]);
    }
    assert.equal(plan.fired, true, `${label}: the command was written`);
    assert.equal(final.status, plan.kind === "cancel" ? "cancelled" : "completed", label);
    assert.equal(await unconsumed(h, run.id), 0, `${label}: a command was stranded`);

    for (let i = 0; i < plan.tools; i++) {
      const ran = handlerRuns.get(`${run.id} ${i}`) ?? 0;
      assert.ok(ran <= 1, `${label}: tool ${i} ran ${ran} times`);
      if (plan.kind !== "cancel") assert.equal(ran, 1, `${label}: tool ${i} ran`);
    }
    const journal = await h.journal(run.id);
    const finishes = journal.filter((r) => ["model.finished", "tool.finished", "step.finished"].includes(r.type)).map((r) => `${r.type} ${r.key ?? ""}`);
    assert.equal(new Set(finishes).size, finishes.length, `${label}: a step finished twice`);

    const messageIds = (await h.store.listCommands(run.id)).filter((c) => c.command.type === "message").map((c) => c.id);
    for (const id of messageIds) {
      const taken = journal.filter((r) => r.type === "inbox.taken"
        && (r.data["messages"] as { commandId: string }[]).some((m) => m.commandId === id)).length;
      const undelivered = journal.filter((r) => r.type === "message.undelivered" && r.data["commandId"] === id).length;
      const rejected = journal.filter((r) => r.type === "command.rejected" && r.data["commandId"] === id).length;
      assert.equal(taken + undelivered + rejected, 1, `${label}: message ${id} taken ${taken}, undelivered ${undelivered}, rejected ${rejected}`);
      fates.taken += taken;
      fates.undelivered += undelivered;
      fates.rejected += rejected;
    }
  }
  // The seed covers every way a message can end.
  assert.ok(fates.taken > 0 && fates.undelivered > 0 && fates.rejected > 0, JSON.stringify(fates));
  const covered = new Set(runs.map(({ plan }) => `${plan.kind}/${plan.via}/${plan.at === "learn" ? "learn" : "loop"}`));
  for (const kind of kinds) for (const via of ["main", "other"]) {
    assert.ok(covered.has(`${kind}/${via}/loop`), `the seed covers ${kind} through ${via}`);
  }
});
