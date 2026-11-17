import { test } from "node:test";
import assert from "node:assert/strict";
import type { ToolDefinition } from "../../src/tools/types.ts";
import type { Driver } from "../../src/engine/types.ts";
import { createHarness, fakeModels, reply, toolReply } from "../helpers/engine.ts";
import { waitFor } from "../helpers/wait.ts";

test("after a crash mid-run the run completes and no finished tool step runs twice", async (t) => {
  const invocations: string[] = [];
  const record: ToolDefinition = {
    name: "record",
    description: "Records a value (a side effect).",
    parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    effect: "write",
    handler: async (args) => {
      invocations.push(String(args["value"]));
      return { content: "recorded" };
    },
  };
  let slowCalls = 0;
  const models = fakeModels(async (request, options) => {
    if (request.meta.turn === 1) return toolReply("record", { value: "a" });
    if (request.meta.turn === 2) return toolReply("record", { value: "b" });
    slowCalls++;
    if (slowCalls === 1) {
      await new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    }
    return reply({ text: "finished", usage: { inputTokens: 3, outputTokens: 1 } });
  });
  const h = await createHarness(t, { models, tools: [record] });
  const agent = await h.saveAgent({ tools: [{ name: "record" }] });
  const run = await h.start(agent.id);
  await waitFor(async () => (await h.journal(run.id)).some((r) => r.type === "model.started" && r.key === "t3"));
  await h.crashAndReplace();
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, { text: "finished" });
  assert.deepEqual(invocations, ["a", "b"]);
  assert.equal(slowCalls, 2);

  const journal = await h.journal(run.id);
  const epochs = journal.filter((r) => r.type === "run.claimed").map((r) => r.epoch);
  assert.equal(epochs.length, 2);
  assert.ok((epochs[1] as number) > (epochs[0] as number));
  const interrupted = await h.records(run.id, "model.interrupted");
  assert.equal(interrupted.length, 1);
  assert.equal(interrupted[0]?.reason, "crash");
  assert.equal((await h.records(run.id, "tool.started")).length, 2);
  assert.equal((await h.records(run.id, "tool.finished")).length, 2);
});

test("memo and emit are recorded once, even across a crash and inside a suspended step", async (t) => {
  let memoRuns = 0;
  let innerRuns = 0;
  let passes = 0;
  const driver: Driver = async (ctx) => {
    passes++;
    const first = await ctx.memo("count", { recordType: "step", name: "count", info: { purpose: "test" } }, async () => {
      memoRuns++;
      return { n: memoRuns };
    });
    await ctx.emit("note", "test.note", { said: "hello" });
    if (passes === 1) await ctx.sleep(60_000);
    const inner = await ctx.memo("asks", { recordType: "node", name: "asks" }, async () => {
      innerRuns++;
      const { answer } = await ctx.ask("asks/q", { question: "Proceed?\nSay yes or no.", choices: ["yes", "no"] });
      return { answer };
    });
    return { first, inner };
  };
  const h = await createHarness(t, { models: fakeModels(() => reply({})), drivers: { agent: driver } });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id);
  await waitFor(async () => (await h.journal(run.id)).some((r) => r.type === "test.note"));
  await h.crashAndReplace();
  await h.until(run.id, "waiting");
  const [pending] = await h.pendings(run.id);
  assert.ok(pending !== undefined);
  assert.equal(pending.kind, "question");
  assert.equal(pending.title, "Proceed?");
  assert.deepEqual(pending.detail, { question: "Proceed?\nSay yes or no.", choices: ["yes", "no"] });
  await h.send(run.id, { type: "answer", pendingId: pending.id, answer: "yes" });
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, { first: { n: 1 }, inner: { answer: "yes" } });
  assert.equal(memoRuns, 1);
  assert.equal(innerRuns, 2);
  assert.equal((await h.records(run.id, "step.started")).length, 1);
  assert.deepEqual(await h.records(run.id, "step.finished"), [{ purpose: "test", name: "count", value: { n: 1 } }]);
  assert.equal((await h.records(run.id, "node.started")).length, 1);
  assert.equal((await h.records(run.id, "node.finished")).length, 1);
  assert.equal((await h.journal(run.id)).filter((r) => r.type === "test.note").length, 1);
});

test("emit refuses record types the engine owns", async (t) => {
  const driver: Driver = async (ctx) => {
    await ctx.emit("x", "tool.finished", {});
    return null;
  };
  const h = await createHarness(t, { models: fakeModels(() => reply({})), drivers: { agent: driver } });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id);
  const failed = await h.until(run.id, "failed");
  assert.equal(failed.error?.code, "bad_request");
});

test("inbox hands over messages in arrival order, each exactly once", async (t) => {
  const driver: Driver = async (ctx) => {
    await ctx.ask("q0", { question: "first?" });
    const a = await ctx.inbox("i1");
    await ctx.ask("q1", { question: "second?" });
    const b = await ctx.inbox("i2");
    const c = await ctx.inbox("i3");
    return { a: a.map((m) => m.text), b: b.map((m) => m.text), c: c.map((m) => m.text) };
  };
  const h = await createHarness(t, { models: fakeModels(() => reply({})), drivers: { agent: driver } });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id);
  await h.until(run.id, "waiting");
  const [q0] = await h.pendings(run.id);
  await h.send(run.id, { type: "message", text: "one" });
  await h.send(run.id, { type: "message", text: "two" });
  await h.send(run.id, { type: "answer", pendingId: (q0 as { id: string }).id, answer: "ok" });
  await waitFor(async () => (await h.pendings(run.id)).some((p) => p.stepKey === "q1"));
  await h.until(run.id, "waiting");
  const [q1] = await h.pendings(run.id);
  await h.send(run.id, { type: "message", text: "three" });
  await h.send(run.id, { type: "answer", pendingId: (q1 as { id: string }).id, answer: "ok" });
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, { a: ["one", "two"], b: ["three"], c: [] });
  const taken = await h.records(run.id, "inbox.taken");
  assert.equal(taken.length, 3);
  const ids = taken.flatMap((x) => x.messages.map((m) => m.commandId));
  assert.equal(new Set(ids).size, 3);
});
