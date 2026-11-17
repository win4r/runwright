// A step deadline above the longest single Node timer (2147483647 ms) is waited in full: it used to become a
// 1 ms timer, so a model step journalled a deadline abort and a tool call timed out at once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isRunwrightError } from "../../src/core/errors.ts";
import type { Driver } from "../../src/engine/types.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import { createHarness, fakeModels, reply } from "../helpers/engine.ts";
import { doc, setupWorkflow } from "../workflow/exec/helpers.ts";

const LONG = 3_000_000_000;

const pause = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => {
    clearTimeout(timer);
    reject(signal.reason);
  }, { once: true });
});

function slowTool(ms: number): ToolDefinition {
  return {
    name: "slow", description: "Answers after a pause.", parameters: { type: "object", properties: {} }, effect: "read",
    handler: async (_args, context) => {
      await pause(ms, context.signal);
      return { content: "slow done" };
    },
  };
}

const step = (deadlineMs: number) => ({ purpose: "step" as const, system: "s", messages: [{ role: "user" as const, content: "x" }], deadlineMs });

test("a model step and a tool call with a deadline above the timer limit finish normally", async (t) => {
  const models = fakeModels(async (_request, options) => {
    await pause(30, options.signal);
    return reply({ text: "answer" });
  });
  const driver: Driver = async (ctx) => {
    const model = await ctx.model("m", step(LONG));
    const tool = await ctx.tool("t", { name: "slow", args: {}, deadlineMs: LONG });
    return { model: model.text, tool: tool.outcome, content: tool.content };
  };
  const h = await createHarness(t, { models, tools: [slowTool(30)], drivers: { agent: driver } });
  const agent = await h.saveAgent({ tools: [{ name: "slow" }] });
  const run = await h.start(agent.id);
  const done = await h.until(run.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.deepEqual(done.output, { model: "answer", tool: "ok", content: "slow done" });
  assert.equal((await h.records(run.id, "model.finished")).length, 1);
  assert.deepEqual(await h.records(run.id, "model.interrupted"), []);
});

test("a short deadline still stops a slow model step and a slow tool call", async (t) => {
  const models = fakeModels(async (_request, options) => {
    await pause(300, options.signal);
    return reply({ text: "too late" });
  });
  const driver: Driver = async (ctx) => {
    let model = "ok";
    try {
      await ctx.model("m", step(20));
    } catch (error) {
      if (!isRunwrightError(error)) throw error;
      model = error.code;
    }
    const tool = await ctx.tool("t", { name: "slow", args: {}, deadlineMs: 20 });
    return { model, tool: tool.outcome };
  };
  const h = await createHarness(t, { models, tools: [slowTool(300)], drivers: { agent: driver } });
  const agent = await h.saveAgent({ tools: [{ name: "slow" }] });
  const run = await h.start(agent.id);
  const done = await h.until(run.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.deepEqual(done.output, { model: "deadline_exceeded", tool: "timeout" });
  assert.deepEqual((await h.records(run.id, "model.interrupted")).map((r) => r.reason), ["deadline"]);
});

test("a stored workflow with a deadline above the timer limit fails as workflow_invalid before any step", async (t) => {
  const s = await setupWorkflow(t);
  const workflow = doc({ id: "main", kind: "sequence", steps: [
    { id: "ask", kind: "model", prompt: "p", output: "Output", deadlineMs: 2147483648 },
  ] }, null);
  const done = await s.run(await s.agent({ workflow }), {});
  assert.equal(done.status, "failed");
  assert.equal(done.error?.code, "workflow_invalid");
  assert.match(done.error?.message ?? "", /\$\.root\.steps\[0\]\.deadlineMs/);
  const steps = (await s.h.journal(done.id)).filter((r) => /^(node|model|tool)\./.test(r.type));
  assert.deepEqual(steps.map((r) => r.type), []);
});
