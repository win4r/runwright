import { test } from "node:test";
import assert from "node:assert/strict";
import type { ToolDefinition } from "../../src/tools/types.ts";
import { itemFile, keepAll, learningHarness } from "./support.ts";

const lookAround: ToolDefinition = {
  name: "look_around", description: "Looks at the project.", parameters: { type: "object", properties: {} }, effect: "read",
  handler: async () => ({ content: "the project builds with make all" }),
};

test("learningMetrics splits completed runs into before and after; the learned variant costs less", async (t) => {
  const h = await learningHarness(t, { tools: [lookAround] });
  const note = { path: "notes/build.md", content: itemFile("Build command", "How this project builds.", "BUILD-WITH-MAKE-ALL: run make all.") };
  const agent = await h.agent({
    // Without the note the agent explores for three turns; with it, it answers at once.
    turns: [
      { toolCalls: [{ name: "look_around", args: {} }] },
      { toolCalls: [{ name: "look_around", args: {} }] },
      { text: "built with make all" },
    ],
    variants: [{ when: { contains: "BUILD-WITH-MAKE-ALL", in: "system" }, turns: [{ text: "built with make all" }] }],
    steps: { "learning.propose": { output: { job_finished: true, files: [note] } }, "learning.grade": keepAll([note.path]) },
  }, { tools: [{ name: "look_around" }] });

  const run1 = await h.start(agent.id, { message: "build the project" });
  await h.until(run1.id, "completed");
  const run2 = await h.start(agent.id, { message: "build the project" });
  await h.until(run2.id, "completed");

  const metrics = await h.store.learningMetrics(agent.id);
  assert.equal(metrics.before.runs, 1);
  assert.equal(metrics.after.runs, 1);
  const before = metrics.before.avgCostMicros;
  const after = metrics.after.avgCostMicros;
  assert.ok(before !== null && after !== null && after < before, `after ${String(after)} < before ${String(before)}`);
  assert.ok((metrics.after.avgInputTokens ?? Infinity) < (metrics.before.avgInputTokens ?? 0));
  assert.equal((await h.store.getRun(run2.id))?.usage.turns, 1);
  assert.equal((await h.store.getRun(run1.id))?.usage.turns, 3);
});
