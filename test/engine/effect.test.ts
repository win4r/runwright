import { test } from "node:test";
import assert from "node:assert/strict";
import { isRunwrightError } from "../../src/core/errors.ts";
import type { LearningPut } from "../../src/store/types.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import type { Driver, MemoMeta, StepPlan } from "../../src/engine/types.ts";
import { createHarness, fakeModels, reply, toolReply, type Harness } from "../helpers/engine.ts";
import { seedLearningItems } from "../helpers/learning.ts";
import { waitFor } from "../helpers/wait.ts";

const meta: MemoMeta = { recordType: "step", name: "learning.apply" };
const models = fakeModels(() => reply({ text: "unused" }));

function put(overrides: Partial<LearningPut> = {}): LearningPut {
  return {
    id: "li_effect_test_1", kind: "note", name: "deploy-order", title: "Deploy order", description: "Which service goes first.",
    body: "Deploy the API before the workers.", status: "active", expectedVersion: null, ...overrides,
  };
}

/** A gate a plan can wait on; `open()` lets it through. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

const fencedBy = (h: Harness, runnerId: string, runId: string): boolean => h.logLines.some((line) => {
  const parsed = JSON.parse(line);
  return parsed.msg === "runner.fenced" && parsed.runId === runId && parsed.runnerId === runnerId;
});

test("effect: the value and the learning writes commit together as one step.finished", async (t) => {
  let seqAtPlan = -1;
  let h: Harness | null = null;
  const driver: Driver = async (ctx) => ctx.effect("learning/apply", meta, async (): Promise<StepPlan<{ kept: number }>> => {
    seqAtPlan = (await (h as Harness).store.getRun(ctx.run.id))?.journalSeq ?? -1;
    return { value: { kept: 1 }, learning: { puts: [put()] } };
  });
  h = await createHarness(t, { models, drivers: { agent: driver } });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id);
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, { kept: 1 });
  const finished = (await h.journal(run.id)).filter((r) => r.type === "step.finished" && r.key === "learning/apply");
  assert.equal(finished.length, 1);
  assert.deepEqual(finished[0]?.data, { name: "learning.apply", value: { kept: 1 } });
  assert.equal(finished[0]?.seq, seqAtPlan + 1, "the record is the only one of its commit");
  assert.equal((await h.journal(run.id)).some((r) => r.type === "step.started" && r.key === "learning/apply"), false);
  const [item] = await h.store.listLearningItems({ agentId: agent.id });
  assert.equal(item?.id, "li_effect_test_1");
  assert.equal(item?.version, 1);
  assert.equal(item?.sourceRunId, run.id);
});

test("effect: on replay the plan is not called again and no second version is written", async (t) => {
  let plans = 0;
  const driver: Driver = async (ctx) => {
    const value = await ctx.effect("learning/apply", meta, async () => {
      plans++;
      return { value: "applied", learning: { puts: [put()] } };
    });
    const { answer } = await ctx.ask("q", { question: "done?" });
    return { value, answer };
  };
  const h = await createHarness(t, { models, drivers: { agent: driver } });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id);
  await h.until(run.id, "waiting");
  await h.crashAndReplace();
  const [pending] = await h.pendings(run.id);
  await h.send(run.id, { type: "answer", pendingId: (pending as { id: string }).id, answer: "yes" });
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, { value: "applied", answer: "yes" });
  assert.equal(plans, 1);
  const [item] = await h.store.listLearningItems({ agentId: agent.id });
  assert.equal(item?.version, 1);
  assert.equal((await h.store.learningHistory(item?.id ?? "")).length, 1);
});

test("effect: a crash before the commit writes nothing; the new runner plans and commits once", async (t) => {
  let plans = 0;
  const hold = gate();
  const driver: Driver = async (ctx) => ctx.effect("learning/apply", meta, async () => {
    plans++;
    if (plans === 1) await hold.wait;
    return { value: `plan ${plans}`, learning: { puts: [put({ body: `written by plan ${plans}` })] } };
  });
  const h = await createHarness(t, { models, drivers: { agent: driver } });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id);
  await waitFor(() => plans === 1);
  await h.crashAndReplace();
  assert.deepEqual(await h.store.listLearningItems({ agentId: agent.id }), []);
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, "plan 2");
  hold.open();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const items = await h.store.listLearningItems({ agentId: agent.id });
  assert.equal(items.length, 1);
  assert.equal(items[0]?.version, 1);
  assert.equal(items[0]?.body, "written by plan 2");
  assert.equal((await h.journal(run.id)).filter((r) => r.type === "step.finished").length, 1);
});

test("effect: a learning_conflict plans again; the second, correct plan commits once", async (t) => {
  let plans = 0;
  // The first plan saw a stale version (0); the second reads the current one (1).
  const driver: Driver = async (ctx) => ctx.effect("learning/apply", meta, async () => {
    plans++;
    return { value: plans, learning: { puts: [put({ body: `version from plan ${plans}`, expectedVersion: plans === 1 ? 0 : 1 })] } };
  });
  const h = await createHarness(t, { models, drivers: { agent: driver }, autoStart: false });
  const agent = await h.saveAgent();
  const [seeded] = await seedLearningItems(h.store, agent.id, [{ ...put(), status: "active" }]);
  assert.equal(seeded?.version, 1);
  h.runner.start();
  const run = await h.start(agent.id);
  const done = await h.until(run.id, "completed");
  assert.equal(done.output, 2);
  assert.equal(plans, 2);
  const item = await h.store.getLearningItem(seeded?.id ?? "");
  assert.equal(item?.version, 2);
  assert.equal(item?.body, "version from plan 2");
  assert.equal((await h.store.learningHistory(item?.id ?? "")).length, 2, "the conflicting plan wrote nothing");
  assert.equal((await h.journal(run.id)).filter((r) => r.type === "step.finished" && r.key === "learning/apply").length, 1);
});

test("effect: a plan that always conflicts is tried three times, then learning_conflict reaches the caller", async (t) => {
  let plans = 0;
  const driver: Driver = async (ctx) => {
    try {
      await ctx.effect("learning/apply", meta, async () => {
        plans++;
        return { value: plans, learning: { puts: [put({ expectedVersion: 7 })] } };
      });
      return { code: null };
    } catch (error) {
      if (!isRunwrightError(error)) throw error;
      return { code: error.code };
    }
  };
  const h = await createHarness(t, { models, drivers: { agent: driver }, autoStart: false });
  const agent = await h.saveAgent();
  await seedLearningItems(h.store, agent.id, [{ ...put(), status: "active" }]);
  h.runner.start();
  const run = await h.start(agent.id);
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, { code: "learning_conflict" });
  assert.equal(plans, 3);
  assert.equal((await h.journal(run.id)).some((r) => r.type === "step.finished" && r.key === "learning/apply"), false);
  const [item] = await h.store.listLearningItems({ agentId: agent.id });
  assert.equal(item?.version, 1);
});

test("effect: a zombie's late commit is rejected after another runner finished the step; one version exists", async (t) => {
  let plans = 0;
  const hold = gate();
  const driver: Driver = async (ctx) => ctx.effect("learning/apply", meta, async () => {
    plans++;
    const mine = plans;
    if (mine === 1) await hold.wait;
    return { value: `plan ${mine}`, learning: { puts: [put({ body: `from plan ${mine}` })] } };
  });
  // concurrency 1: the zombie's hung session keeps its only slot, so it cannot re-claim the run itself.
  const h = await createHarness(t, { models, drivers: { agent: driver }, engine: { heartbeatMs: 60_000, leaseMs: 150, concurrency: 1 } });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id);
  await waitFor(() => plans === 1);
  const zombie = h.runner;
  h.newRunner({ heartbeatMs: 100, leaseMs: 2000, concurrency: 8 });
  const done = await h.until(run.id, "completed");
  assert.equal(done.output, "plan 2");
  hold.open();
  await waitFor(() => fencedBy(h, zombie.id, run.id), { timeoutMs: 3000 });
  const items = await h.store.listLearningItems({ agentId: agent.id });
  assert.equal(items.length, 1);
  assert.equal(items[0]?.body, "from plan 2");
  assert.equal((await h.store.learningHistory(items[0]?.id ?? "")).length, 1);
  assert.equal((await h.journal(run.id)).filter((r) => r.type === "step.finished").length, 1);
});

test("a tool's learningOpened marks the item opened in the commit of its tool.finished", async (t) => {
  let itemId = "";
  const recall: ToolDefinition = {
    name: "recall", description: "Opens a learned item.", parameters: { type: "object", properties: {} }, effect: "read",
    handler: async () => ({ content: "the note", learningOpened: [itemId] }),
  };
  const h = await createHarness(t, {
    models: fakeModels((request) => (request.meta.turn === 1 ? toolReply("recall", {}) : reply({ text: "done" }))),
    tools: [recall], autoStart: false,
  });
  const agent = await h.saveAgent({ tools: [{ name: "recall" }] });
  const [item] = await seedLearningItems(h.store, agent.id, [{ ...put(), status: "active" }]);
  itemId = item?.id ?? "";
  h.runner.start();
  const run = await h.start(agent.id);
  await h.until(run.id, "completed");
  const uses = await h.store.learningUses(run.id);
  assert.deepEqual(uses.map((u) => [u.itemId, u.opened]), [[itemId, true]]);
});

test("a fenced tool.finished commit leaves no opened mark", async (t) => {
  let itemId = "";
  let calls = 0;
  const hold = gate();
  const recall: ToolDefinition = {
    name: "recall", description: "Opens a learned item.", parameters: { type: "object", properties: {} }, effect: "read",
    handler: async () => {
      calls++;
      if (calls > 1) return { content: "nothing opened" };
      await hold.wait;
      return { content: "the note", learningOpened: [itemId] };
    },
  };
  const h = await createHarness(t, {
    models: fakeModels((request) => (request.meta.turn === 1 ? toolReply("recall", {}) : reply({ text: "done" }))),
    tools: [recall], autoStart: false, engine: { heartbeatMs: 60_000, leaseMs: 150, concurrency: 1 },
  });
  const agent = await h.saveAgent({ tools: [{ name: "recall" }] });
  const [item] = await seedLearningItems(h.store, agent.id, [{ ...put(), status: "active" }]);
  itemId = item?.id ?? "";
  h.runner.start();
  const zombie = h.runner;
  const run = await h.start(agent.id);
  await waitFor(() => calls === 1);
  h.newRunner({ heartbeatMs: 100, leaseMs: 2000, concurrency: 8 });
  await h.until(run.id, "completed");
  hold.open();
  await waitFor(() => fencedBy(h, zombie.id, run.id), { timeoutMs: 3000 });
  assert.deepEqual((await h.store.learningUses(run.id)).filter((u) => u.opened), []);
  assert.equal((await h.records(run.id, "tool.finished")).length, 1);
});

test("a secret in a learning put is stored redacted", async (t) => {
  const secret = "s3cr3t-learning-token-77";
  const driver: Driver = async (ctx) => ctx.effect("learning/apply", meta, async () => ({
    value: "ok",
    learning: { puts: [put({ title: `Use ${secret}`, body: `call the API with ${secret}`, note: `seen ${secret}` })] },
  }));
  const h = await createHarness(t, { models, drivers: { agent: driver }, secrets: { TOKEN: secret } });
  const agent = await h.saveAgent({ secrets: ["TOKEN"] });
  const run = await h.start(agent.id);
  await h.until(run.id, "completed");
  const [item] = await h.store.listLearningItems({ agentId: agent.id });
  assert.equal(item?.body, "call the API with [redacted:TOKEN]");
  assert.equal(item?.title, "Use [redacted:TOKEN]");
  const history = await h.store.learningHistory(item?.id ?? "");
  assert.ok(!JSON.stringify({ item, history }).includes(secret));
});
