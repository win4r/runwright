import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { openTestStore, testAgentDefinition } from "../helpers/store.ts";
import { createFakeClock } from "../../src/core/clock.ts";
import { isRunwrightError } from "../../src/core/errors.ts";
import type { LearningItem, NewUsage, Store } from "../../src/store/types.ts";
import { seedLearningItems } from "../helpers/learning.ts";

const code = (c: string) => (e: unknown): boolean => isRunwrightError(e) && e.code === c;

type Seed = Parameters<typeof seedLearningItems>[2][number];

const note = (overrides?: Partial<Seed>): Seed => ({
  kind: "note", name: "build-cmd", title: "Build", description: "How to build", body: "Run make.", status: "active", ...overrides,
});

/** Stores one item through a fenced commit (see seedLearningItems). */
async function seed(store: Store, overrides?: Partial<Seed>): Promise<LearningItem> {
  const [item] = await seedLearningItems(store, "a", [note(overrides)]);
  return item as LearningItem;
}

async function setup(t: TestContext) {
  const clock = createFakeClock(10_000);
  const { store } = await openTestStore(t, { clock });
  await store.saveAgent({ id: "a", definition: testAgentDefinition() });
  return { store, clock };
}

test("retire, restore, approve and edit require the current etag and the right status", async (t) => {
  const { store } = await setup(t);
  const active = await seed(store);
  await assert.rejects(store.changeLearningItem(active.id, { expectedEtag: "1-deadbeef", action: "retire", actor: "p" }), code("etag_mismatch"));
  await assert.rejects(store.changeLearningItem("li_missing", { expectedEtag: "x", action: "retire", actor: "p" }), code("not_found"));
  await assert.rejects(store.changeLearningItem(active.id, { expectedEtag: active.etag, action: "restore", actor: "p" }), code("conflict"));
  await assert.rejects(store.changeLearningItem(active.id, { expectedEtag: active.etag, action: "approve", actor: "p" }), code("conflict"));

  const retired = await store.changeLearningItem(active.id, { expectedEtag: active.etag, action: "retire", actor: "alice", note: "stale" });
  assert.deepEqual([retired.status, retired.version], ["retired", 2]);
  await assert.rejects(store.changeLearningItem(active.id, { expectedEtag: active.etag, action: "restore", actor: "p" }), code("etag_mismatch"),
    "the old etag no longer works");
  await assert.rejects(store.changeLearningItem(active.id, { expectedEtag: retired.etag, action: "retire", actor: "p" }), code("conflict"));
  const restored = await store.changeLearningItem(active.id, { expectedEtag: retired.etag, action: "restore", actor: "bob" });
  assert.deepEqual([restored.status, restored.version], ["active", 3]);

  const edited = await store.changeLearningItem(active.id, { expectedEtag: restored.etag, action: "edit", actor: "carol",
    patch: { title: "Build it", body: "Run make -j." } });
  assert.deepEqual([edited.title, edited.description, edited.body, edited.status, edited.version], ["Build it", "How to build", "Run make -j.", "active", 4]);
  const noop = await store.changeLearningItem(active.id, { expectedEtag: edited.etag, action: "edit", actor: "carol", patch: {} });
  assert.deepEqual(noop, edited);

  const held = await seed(store, { name: "held-one", status: "held" });
  const approved = await store.changeLearningItem(held.id, { expectedEtag: held.etag, action: "approve", actor: "dave" });
  assert.equal(approved.status, "active");
  const heldAgain = await seed(store, { name: "held-two", status: "held" });
  const retiredHeld = await store.changeLearningItem(heldAgain.id, { expectedEtag: heldAgain.etag, action: "retire", actor: "p" });
  assert.equal(retiredHeld.status, "retired");
  const retiredEdit = await store.changeLearningItem(heldAgain.id, { expectedEtag: retiredHeld.etag, action: "edit", actor: "p", patch: { body: "x" } });
  assert.equal(retiredEdit.status, "retired", "edit changes content only");

  const history = await store.learningHistory(active.id);
  assert.deepEqual(history.map((h) => [h.version, h.action, h.actor, h.status]), [
    [1, "created", "learning", "active"], [2, "retired", "alice", "retired"], [3, "restored", "bob", "active"], [4, "edited", "carol", "active"],
  ]);
  assert.equal(history[1]!.note, "stale");
  assert.equal(history[3]!.title, "Build it", "history rows hold the full snapshot");
});

test("listing filters by agent, kind and status, oldest first", async (t) => {
  const { store, clock } = await setup(t);
  const n = await seed(store);
  clock.advance(5);
  const s = await seed(store, { kind: "skill", name: "deploy", status: "held" });
  assert.deepEqual((await store.listLearningItems({ agentId: "a" })).map((i) => i.id), [n.id, s.id]);
  assert.deepEqual((await store.listLearningItems({ kind: "skill" })).map((i) => i.id), [s.id]);
  assert.deepEqual((await store.listLearningItems({ status: "active" })).map((i) => i.id), [n.id]);
  assert.deepEqual((await store.listLearningItems({ status: "held", kind: "skill", agentId: "a" })).map((i) => i.id), [s.id]);
  assert.deepEqual(await store.listLearningItems({ agentId: "zzz" }), []);
  assert.equal(await store.getLearningItem("li_none"), null);
  assert.deepEqual(await store.getLearningItem(n.id), n);
  assert.deepEqual((await store.learningHistory(s.id)).map((h) => [h.version, h.action, h.status]), [[1, "held", "held"]]);
  assert.deepEqual(await store.learningHistory("li_none"), []);
});

async function finishRun(store: Store, clock: ReturnType<typeof createFakeClock>, options: {
  durationMs: number; usage: NewUsage[]; given?: { itemId: string; mode: "full" | "line"; opened?: boolean }[]; status?: "completed" | "failed";
}): Promise<string> {
  const { run } = await store.createRun({ agentId: "a", input: { message: "", data: null } });
  const [claim] = await store.claimRuns({ runnerId: "r", limit: 1, leaseMs: 1e9 });
  assert.equal(claim?.run.id, run.id);
  const learning = options.given === undefined ? {} : {
    learning: {
      given: options.given.map((g) => ({ itemId: g.itemId, version: 1, mode: g.mode })),
      opened: options.given.filter((g) => g.opened === true).map((g) => g.itemId),
    },
  };
  clock.advance(options.durationMs);
  await store.commit(claim!.lease, { records: [], usage: options.usage, transition: { to: options.status ?? "completed" }, ...learning });
  return run.id;
}

const use = (purpose: NewUsage["purpose"], costMicros: number | null, inputTokens: number): NewUsage => ({
  model: "scripted/scripted-1", purpose, inputTokens, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros, assumed: false,
});

test("skillServeCounts counts completed runs given the skill in full or that opened it", async (t) => {
  const { store, clock } = await setup(t);
  const [skill, other, n] = await seedLearningItems(store, "a", [
    note({ kind: "skill", name: "deploy" }), note({ kind: "skill", name: "unused" }), note(),
  ]) as [LearningItem, LearningItem, LearningItem];
  await finishRun(store, clock, { durationMs: 1, usage: [], given: [{ itemId: skill.id, mode: "full" }] });
  await finishRun(store, clock, { durationMs: 1, usage: [], given: [{ itemId: skill.id, mode: "line", opened: true }] });
  await finishRun(store, clock, { durationMs: 1, usage: [], given: [{ itemId: skill.id, mode: "line" }] });
  await finishRun(store, clock, { durationMs: 1, usage: [], given: [{ itemId: skill.id, mode: "full" }], status: "failed" });
  await finishRun(store, clock, { durationMs: 1, usage: [], given: [{ itemId: n.id, mode: "full" }] });
  assert.deepEqual(await store.skillServeCounts("a"), { [skill.id]: 2, [other.id]: 0 });
  assert.deepEqual(await store.skillServeCounts("nobody"), {});
});

test("learningMetrics compares job cost, tokens and duration before and after learning", async (t) => {
  const { store, clock } = await setup(t);
  const n = await seed(store);
  const empty = await store.learningMetrics("a");
  assert.deepEqual(empty, { agentId: "a", before: { runs: 0, avgCostMicros: null, avgInputTokens: null, avgOutputTokens: null, avgDurationMs: null },
    after: { runs: 0, avgCostMicros: null, avgInputTokens: null, avgOutputTokens: null, avgDurationMs: null } });
  await finishRun(store, clock, { durationMs: 100, usage: [use("run", 1000, 400), use("learning", 999, 999)] });
  await finishRun(store, clock, { durationMs: 300, usage: [use("run", 2000, 600), use("grader", 5, 5)] });
  await finishRun(store, clock, { durationMs: 50, usage: [use("run", 400, 100), use("promotion", 77, 77)], given: [{ itemId: n.id, mode: "full" }] });
  await finishRun(store, clock, { durationMs: 70, usage: [use("run", null, 300)], given: [{ itemId: n.id, mode: "line" }] });
  await finishRun(store, clock, { durationMs: 9999, usage: [use("run", 1, 1)], status: "failed" });
  const metrics = await store.learningMetrics("a");
  assert.deepEqual(metrics.before, { runs: 2, avgCostMicros: 1500, avgInputTokens: 500, avgOutputTokens: 10, avgDurationMs: 200 });
  assert.deepEqual(metrics.after, { runs: 2, avgCostMicros: 400, avgInputTokens: 200, avgOutputTokens: 10, avgDurationMs: 60 },
    "the run with an unknown job cost is left out of the cost average only");
});

test("learningMetrics over runs whose usage saturates returns finite, safe numbers", async (t) => {
  const { store, clock } = await setup(t);
  const MAX = Number.MAX_SAFE_INTEGER;
  await finishRun(store, clock, { durationMs: 10, usage: [use("run", MAX, MAX), use("run", MAX, MAX)] });
  await finishRun(store, clock, { durationMs: 10, usage: [use("run", MAX, MAX)] });
  await finishRun(store, clock, { durationMs: 10, usage: [use("run", 1, 1)] });
  const { before } = await store.learningMetrics("a");
  assert.equal(before.runs, 3);
  for (const value of [before.avgCostMicros, before.avgInputTokens, before.avgOutputTokens]) {
    assert.ok(typeof value === "number" && Number.isFinite(value) && value <= MAX && value > 0, String(value));
  }
});

test("the items one commit writes share the commit's instant, however the clock moves while it is applied", async (t) => {
  // A clock that advances on every read: before, each item read it on its own, so two notes kept together could
  // differ by a millisecond and the selection's tie order (newest first) depended on timing.
  let now = 50_000;
  const { store } = await openTestStore(t, { clock: { now: () => now++ } });
  await store.saveAgent({ id: "a", definition: testAgentDefinition() });
  const items = await seedLearningItems(store, "a", ["alpha", "beta", "gamma"].map((name) => note({ name, title: name })));
  assert.equal(new Set(items.map((item) => item.updatedAt)).size, 1, JSON.stringify(items.map((item) => [item.name, item.updatedAt])));
  assert.equal(new Set(items.map((item) => item.createdAt)).size, 1);
  const histories = await Promise.all(items.map((item) => store.learningHistory(item.id)));
  assert.equal(new Set(histories.flat().map((entry) => entry.at)).size, 1, "their history rows carry the same instant");
});
