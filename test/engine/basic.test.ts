import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { openSqliteStore } from "../../src/store/sqlite.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import type { Driver } from "../../src/engine/types.ts";
import { createHarness, fakeModels, reply, toolReply } from "../helpers/engine.ts";

const echo: ToolDefinition = {
  name: "echo",
  description: "Echoes its text.",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
  effect: "read",
  handler: async (args) => ({ content: `echo: ${String(args["text"])}` }),
};

test("a run completes with the driver's output and a dense, ordered journal", async (t) => {
  const models = fakeModels((request) =>
    request.meta.turn === 1 ? toolReply("echo", { text: "hello" }) : reply({ text: "all done", usage: { inputTokens: 10, outputTokens: 2 } }));
  const h = await createHarness(t, { models, tools: [echo] });
  const agent = await h.saveAgent({ tools: [{ name: "echo" }] });
  const run = await h.start(agent.id);
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, { text: "all done" });
  assert.equal(done.usage.turns, 2);
  assert.equal(done.usage.toolCalls, 1);
  assert.equal(done.usage.costMicros, 10 + 2 * 5);

  const journal = await h.journal(run.id);
  assert.deepEqual(journal.map((r) => r.seq), journal.map((_, i) => i + 1));
  assert.deepEqual(journal.map((r) => r.type), [
    "run.created", "run.claimed", "model.started", "model.finished", "tool.started", "tool.finished",
    "model.started", "model.finished", "run.output", "run.completed",
  ]);
  const finished = await h.records(run.id, "tool.finished");
  assert.equal(finished[0]?.content, "echo: hello");
  assert.equal(finished[0]?.outcome, "ok");
  assert.ok(h.logLines.some((line) => JSON.parse(line).msg === "run.claimed"));
  assert.ok(h.logLines.some((line) => {
    const parsed = JSON.parse(line);
    return parsed.msg === "run.completed" && parsed.runId === run.id;
  }));
});

test("the runner never runs more sessions than its concurrency", async (t) => {
  let active = 0;
  let peak = 0;
  const driver: Driver = async (ctx) => {
    active++;
    peak = Math.max(peak, active);
    try {
      await ctx.sleep(40);
    } finally {
      active--;
    }
    return { ok: true };
  };
  const h = await createHarness(t, { models: fakeModels(() => reply({})), drivers: { agent: driver }, engine: { concurrency: 2 } });
  const agent = await h.saveAgent();
  const runs = await Promise.all([1, 2, 3, 4, 5, 6].map(() => h.start(agent.id)));
  for (const run of runs) await h.until(run.id, "completed");
  assert.equal(peak, 2);
});

test("a queued run is claimed at once in-process, without waiting for the poll", async (t) => {
  const h = await createHarness(t, { models: fakeModels(() => reply({ text: "ok" })), engine: { pollMs: 10_000 } });
  const agent = await h.saveAgent();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const began = Date.now();
  const run = await h.start(agent.id);
  const claimed = await h.until(run.id, ["running", "completed"], 2000);
  assert.ok(claimed.startedAt !== null);
  assert.ok(Date.now() - began < 200, `claimed after ${Date.now() - began} ms`);
  await h.until(run.id, "completed", 2000);
});

test("a run created through another store handle is picked up by polling", async (t) => {
  const h = await createHarness(t, { models: fakeModels(() => reply({ text: "ok" })) });
  const agent = await h.saveAgent();
  const other = await openSqliteStore({ path: join(h.dir, "runwright.db") });
  t.after(() => other.close());
  const created = await other.createRun({ agentId: agent.id, input: { message: "from elsewhere", data: null } });
  const done = await h.until(created.run.id, "completed");
  assert.deepEqual(done.output, { text: "ok" });
});

test("runners register themselves and unregister on stop", async (t) => {
  const h = await createHarness(t, { models: fakeModels(() => reply({})) });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok((await h.store.listRunners()).some((r) => r.id === h.runner.id));
  await h.runner.stop();
  assert.ok(!(await h.store.listRunners()).some((r) => r.id === h.runner.id));
});
