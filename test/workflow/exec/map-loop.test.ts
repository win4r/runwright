import { test } from "node:test";
import assert from "node:assert/strict";
import type { WorkflowNode } from "../../../src/workflow/types.ts";
import { asObject, doc, setupWorkflow } from "./helpers.ts";

test("a map over 12 items with concurrency 3 never has more than 3 calls in flight and keeps order", async (t) => {
  const s = await setupWorkflow(t);
  const items = Array.from({ length: 12 }, (_, i) => `i${i}`);
  const workflow = doc({
    id: "m", kind: "map", over: { $ref: "input.items" }, as: "item", concurrency: 3, maxItems: 20,
    run: { id: "work", kind: "tool", tool: "probe", args: { label: "{{vars.item}}", value: { $ref: "vars.item_index" }, delayMs: 30 } },
  }, { $ref: "steps.m" });
  const done = await s.run(await s.agent({ workflow }), { items });
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.deepEqual(done.output, items.map((item, i) => ({ ok: true, content: item, data: i })));
  assert.equal(s.counters.highWater.get("probe"), 3);
  assert.equal(s.counters.total("probe"), 12);
});

test("a map over more than maxItems items fails before running any item", async (t) => {
  const s = await setupWorkflow(t);
  const workflow = doc({
    id: "m", kind: "map", over: { $ref: "input.items" }, as: "item", concurrency: 2, maxItems: 3,
    run: { id: "work", kind: "tool", tool: "count", args: { label: "{{vars.item}}" } },
  }, { $ref: "steps.m" });
  const done = await s.run(await s.agent({ workflow }), { items: ["a", "b", "c", "d"] });
  assert.equal(done.status, "failed");
  assert.match(done.error?.message ?? "", /node "m" failed: "over" has 4 items, more than maxItems 3/);
  assert.equal(s.counters.total("count"), 0);
});

test("a map whose input is not an array fails", async (t) => {
  const s = await setupWorkflow(t);
  const workflow = doc({
    id: "m", kind: "map", over: { $ref: "input.items" }, as: "item", concurrency: 2, maxItems: 3,
    run: { id: "work", kind: "tool", tool: "count", args: { label: "{{vars.item}}" } },
  }, { $ref: "steps.m" });
  const done = await s.run(await s.agent({ workflow }), { items: "abc" });
  assert.equal(done.status, "failed");
  assert.match(done.error?.message ?? "", /not an array/);
});

const loopBody: WorkflowNode = {
  id: "body", kind: "tool", tool: "count",
  args: { label: "iter-{{loop.spin.index}}", value: { index: { $ref: "loop.spin.index" }, previous: { $ref: "loop.spin.last", default: null } } },
};

test("a loop stops as soon as until holds; loop index and last resolve", async (t) => {
  const s = await setupWorkflow(t);
  const workflow = doc({
    id: "spin", kind: "loop", maxIterations: 10, until: { eq: [{ $ref: "steps.body.data.index" }, 2] }, run: loopBody,
  }, { $ref: "steps.spin" });
  const done = await s.run(await s.agent({ workflow }), {});
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  const out = asObject(done.output);
  assert.equal(out["iterations"], 3);
  assert.equal(out["completed"], true);
  const last = asObject(asObject(out["last"])["data"]);
  assert.equal(last["index"], 2);
  assert.equal(asObject(asObject(last["previous"])["data"])["index"], 1);
  assert.equal(s.counters.total("count"), 3);
});

test("a loop whose condition never holds runs exactly maxIterations times, then reports or fails", async (t) => {
  const s = await setupWorkflow(t);
  const continuing = doc({ id: "spin", kind: "loop", maxIterations: 4, until: { eq: [1, 2] }, run: loopBody }, { $ref: "steps.spin" });
  const done = await s.run(await s.agent({ workflow: continuing }), {});
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(asObject(done.output)["iterations"], 4);
  assert.equal(asObject(done.output)["completed"], false);
  assert.equal(s.counters.total("count"), 4);
  for (let i = 0; i < 4; i++) assert.equal(s.counters.get("count", `iter-${i}`), 1);

  const failing = doc({ id: "spin", kind: "loop", maxIterations: 4, until: { eq: [1, 2] }, onLimit: "fail", run: loopBody }, null, { name: "failing" });
  const failed = await s.run(await s.agent({ workflow: failing }), {});
  assert.equal(failed.status, "failed");
  assert.match(failed.error?.message ?? "", /node "spin" failed: the loop reached maxIterations 4/);
  assert.equal(s.counters.total("count"), 8);
  assert.equal(s.counters.get("count", "iter-4"), 0);
});
