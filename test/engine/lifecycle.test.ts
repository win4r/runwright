import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelRequest } from "../../src/models/types.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import type { WorkflowDocument } from "../../src/workflow/types.ts";
import type { Driver, LearningHooks } from "../../src/engine/types.ts";
import { createRunner } from "../../src/engine/runner.ts";
import { createHarness, fakeModels, reply, toolReply } from "../helpers/engine.ts";

const recall: ToolDefinition = {
  name: "recall", description: "Opens a learned item.", parameters: { type: "object", properties: {} }, effect: "read",
  handler: async () => ({ content: "the note body" }),
};

test("learning hooks: prepare grants tools and a prompt section, afterRun sees the output", async (t) => {
  const seen: ModelRequest[] = [];
  const models = fakeModels((request) => {
    seen.push(request);
    return request.meta.turn === 1 ? toolReply("recall", {}) : reply({ text: "used the note" });
  });
  const outcomes: unknown[] = [];
  const learning: LearningHooks = {
    prepare: async (ctx) => ctx.memo("learning/given", { recordType: "step", name: "learning.given" }, async () => ({ prepared: true }))
      .then(() => ({ promptSection: "Notes: be brief.", given: [], tools: ["recall"] })),
    afterRun: async (_ctx, outcome) => {
      outcomes.push(outcome.output);
    },
  };
  const h = await createHarness(t, { models, tools: [recall], learning });
  const agent = await h.saveAgent({ learning: true });
  const run = await h.start(agent.id);
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, { text: "used the note" });
  assert.match(seen[0]?.system ?? "", /Notes: be brief\./);
  assert.deepEqual(seen[0]?.tools.map((s) => s.name), ["recall"]);
  assert.equal((await h.records(run.id, "tool.finished"))[0]?.outcome, "ok");
  assert.deepEqual(outcomes, [{ text: "used the note" }]);

  const withoutLearning = await h.saveAgent({ learning: false }, "plain");
  const plain = await h.start(withoutLearning.id);
  await h.until(plain.id, "completed");
  assert.equal(outcomes.length, 1, "hooks only run for agents with learning on");
});

test("a failing afterRun is journalled as learning.skipped and the run still completes", async (t) => {
  const learning: LearningHooks = {
    prepare: async () => null,
    afterRun: async () => {
      throw new Error("grader unavailable");
    },
  };
  const h = await createHarness(t, { models: fakeModels(() => reply({ text: "ok" })), learning });
  const agent = await h.saveAgent({ learning: true });
  const run = await h.start(agent.id);
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, { text: "ok" });
  assert.deepEqual(await h.records(run.id, "learning.skipped"), [{ reason: "grader unavailable" }]);
});

test("a learning turn that waits resumes after run.output without running the driver again", async (t) => {
  let driverRuns = 0;
  let prepares = 0;
  const driver: Driver = async () => {
    driverRuns++;
    return { answer: 42 };
  };
  const learning: LearningHooks = {
    prepare: async () => {
      prepares++;
      return null;
    },
    afterRun: async (ctx) => {
      await ctx.ask("learning/hold", { question: "Keep this note?" });
    },
  };
  const h = await createHarness(t, { models: fakeModels(() => reply({})), drivers: { agent: driver }, learning });
  const agent = await h.saveAgent({ learning: true });
  const run = await h.start(agent.id);
  await h.until(run.id, "waiting");
  const [pending] = await h.pendings(run.id);
  await h.send(run.id, { type: "answer", pendingId: (pending as { id: string }).id, answer: "yes" });
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, { answer: 42 });
  assert.equal(driverRuns, 1);
  assert.equal(prepares, 2);
  assert.equal((await h.records(run.id, "run.output")).length, 1);
});

test("an agent with a workflow document runs the workflow driver", async (t) => {
  const used: string[] = [];
  const agentDriver: Driver = async () => {
    used.push("agent");
    return "agent";
  };
  const workflowDriver: Driver = async (ctx) => {
    used.push("workflow");
    return { workflow: ctx.definition.workflow?.name ?? null };
  };
  const h = await createHarness(t, { models: fakeModels(() => reply({})), drivers: { agent: agentDriver, workflow: workflowDriver } });
  const workflow = {
    format: "runwright.workflow/v1", name: "flow", schemas: {}, input: "In", output: "Out",
    root: { id: "fail", kind: "fail", message: "unused" }, result: null,
  } as unknown as WorkflowDocument;
  const agent = await h.saveAgent({ workflow });
  const run = await h.start(agent.id);
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, { workflow: "flow" });
  assert.deepEqual(used, ["workflow"]);
});

test("a run whose driver throws fails with the error's code", async (t) => {
  const driver: Driver = async () => {
    throw new Error("driver broke");
  };
  const h = await createHarness(t, { models: fakeModels(() => reply({})), drivers: { agent: driver } });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id);
  const failed = await h.until(run.id, "failed");
  assert.deepEqual(failed.error, { code: "internal", message: "driver broke" });
  assert.deepEqual(await h.records(run.id, "run.failed"), [{ error: { code: "internal", message: "driver broke" } }]);
  assert.ok(h.logLines.some((line) => JSON.parse(line).msg === "run.failed"));
});

test("a runner started after its stop() (or after abandon()) claims nothing: a queued run stays queued", async (t) => {
  const h = await createHarness(t, { models: fakeModels(() => reply({ text: "ran" })), autoStart: false });
  const agent = await h.saveAgent();
  await h.runner.stop({ graceMs: 50 });
  h.runner.start();
  const abandoned = createRunner(h.deps());
  await abandoned.abandon();
  abandoned.start();
  const run = await h.start(agent.id);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal((await h.store.getRun(run.id))?.status, "queued");
  assert.deepEqual(h.runner.activeRunIds(), []);
  assert.deepEqual(await h.store.listRunners(), [], "neither runner registered itself again");
  h.newRunner();
  assert.deepEqual((await h.until(run.id, "completed")).output, { text: "ran" }, "the run was claimable all along");
});
