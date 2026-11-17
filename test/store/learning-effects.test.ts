import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createFakeClock, type FakeClock } from "../../src/core/clock.ts";
import { isRunwrightError } from "../../src/core/errors.ts";
import { sha256Hex } from "../../src/core/json.ts";
import type { CommitBatch, Lease, LearningEffects, LearningPut, Store } from "../../src/store/types.ts";
import type { WorkflowDocument } from "../../src/workflow/types.ts";
import { seedLearningItems } from "../helpers/learning.ts";
import { openTestStore, testAgentDefinition } from "../helpers/store.ts";

const code = (c: string) => (e: unknown): boolean => isRunwrightError(e) && e.code === c;

const draft: WorkflowDocument = {
  format: "runwright.workflow/v1",
  name: "deploy",
  schemas: { In: { type: "object" }, Out: { type: "string" } },
  input: "In",
  output: "Out",
  root: { id: "run", kind: "tool", tool: "shell", args: { command: "make deploy" } },
  result: { $ref: "steps.run.content" },
};

function put(overrides?: Partial<LearningPut>): LearningPut {
  return {
    id: "li_build", kind: "note", name: "build-cmd", title: "Build", description: "How to build", body: "Run make.",
    status: "active", expectedVersion: null, ...overrides,
  };
}

async function setup(t: TestContext): Promise<{ store: Store; clock: FakeClock }> {
  const clock = createFakeClock(10_000);
  const { store } = await openTestStore(t, { clock });
  await store.saveAgent({ id: "a", definition: testAgentDefinition() });
  return { store, clock };
}

/** Creates a run of agent "a" and claims it; no other run is queued in these tests. */
async function startRun(store: Store, runnerId = "runner-1", leaseMs = 60_000): Promise<Lease> {
  const { run } = await store.createRun({ agentId: "a", input: { message: "go", data: null } });
  const claimed = await store.claimRuns({ runnerId, limit: 10, leaseMs });
  assert.deepEqual(claimed.map((c) => c.run.id), [run.id]);
  return claimed[0]!.lease;
}

/** Commits learning effects with one journal record. */
function commitLearning(store: Store, lease: Lease, learning: LearningEffects, key = "learning.apply"): ReturnType<Store["commit"]> {
  return store.commit(lease, { records: [{ type: "learning.applied", key, data: { key } }], learning });
}

/** A batch with every other kind of write, to show that a rejected batch writes none of them. */
function fullBatch(tag: string, learning: LearningEffects): CommitBatch {
  return {
    records: [{ type: "learning.applied", key: `k-${tag}`, data: { tag } }],
    openPendings: [{ id: `pnd_${tag}`, kind: "question", stepKey: `q-${tag}`, title: "A question", detail: {} }],
    usage: [{ model: "scripted/scripted-1", purpose: "learning", inputTokens: 3, outputTokens: 2, cacheReadTokens: 0,
      cacheWriteTokens: 0, costMicros: 7, assumed: false }],
    counters: { turns: 1 },
    learning,
  };
}

async function snapshot(store: Store, runId: string) {
  const items = await store.listLearningItems({});
  return {
    items,
    history: await Promise.all(items.map((item) => store.learningHistory(item.id))),
    run: await store.getRun(runId),
    journal: await store.readJournal(runId),
    pendings: (await store.listPendings({ runId }, { limit: 200 })).items,
    usage: await store.usageSummary({ groupBy: "model" }),
    uses: await store.learningUses(runId),
    workflows: await store.listWorkflows(),
  };
}

test("a commit with puts creates version 1 with the run's agent and id, an etag and one history row", async (t) => {
  const { store } = await setup(t);
  const lease = await startRun(store);
  const before = (await store.getRun(lease.runId))!.journalSeq;
  const { records } = await commitLearning(store, lease, { puts: [put({ note: "first" }), put({ id: "li_held", name: "maybe", status: "held" })] });
  const item = await store.getLearningItem("li_build");
  assert.ok(item !== null);
  assert.deepEqual(
    [item.agentId, item.kind, item.name, item.version, item.status, item.sourceRunId, item.promotedWorkflow, item.promotionAttempts],
    ["a", "note", "build-cmd", 1, "active", lease.runId, null, 0],
  );
  assert.equal(item.etag, `1-${sha256Hex("Build\nHow to build\nRun make.\nactive").slice(0, 8)}`);
  assert.deepEqual(await store.learningHistory("li_build"), [{ itemId: "li_build", version: 1, action: "created", title: "Build",
    description: "How to build", body: "Run make.", status: "active", actor: "learning", note: "first", at: 10_000 }]);
  assert.deepEqual((await store.learningHistory("li_held")).map((h) => [h.version, h.action, h.status]), [[1, "held", "held"]]);
  assert.deepEqual(records.map((r) => [r.seq, r.type]), [[before + 1, "learning.applied"]]);
  assert.deepEqual((await store.readJournal(lease.runId, { afterSeq: before })).map((r) => r.type), ["learning.applied"]);
});

test("an update at the expected version writes version n + 1 with full history; held uses the held action", async (t) => {
  const { store, clock } = await setup(t);
  const first = await startRun(store);
  await commitLearning(store, first, { puts: [put()] });
  await store.commit(first, { records: [], transition: { to: "completed", output: null } });

  const second = await startRun(store);
  clock.advance(5);
  await commitLearning(store, second, { puts: [put({ id: "li_ignored", body: "Run make all.", expectedVersion: 1, note: "better" })] });
  const v2 = await store.getLearningItem("li_build");
  assert.deepEqual([v2?.version, v2?.body, v2?.sourceRunId, v2?.status], [2, "Run make all.", second.runId, "active"]);
  assert.equal(v2?.etag, `2-${sha256Hex("Build\nHow to build\nRun make all.\nactive").slice(0, 8)}`);
  assert.equal(await store.getLearningItem("li_ignored"), null, "the put's id is only used on create");
  await commitLearning(store, second, { puts: [put({ body: "Run make all.", status: "held", expectedVersion: 2 })] }, "again");
  assert.deepEqual((await store.learningHistory("li_build")).map((h) => [h.version, h.action, h.status, h.body, h.note]), [
    [1, "created", "active", "Run make.", null],
    [2, "updated", "active", "Run make all.", "better"],
    [3, "held", "held", "Run make all.", null],
  ]);
});

test("each failed put precondition throws learning_conflict and writes nothing of the batch", async (t) => {
  const { store } = await setup(t);
  const lease = await startRun(store);
  await commitLearning(store, lease, { puts: [put(), put({ id: "li_old", name: "old" })] });
  const old = await store.getLearningItem("li_old");
  const retired = await store.changeLearningItem("li_old", { expectedEtag: old!.etag, action: "retire", actor: "person" });
  assert.equal(retired.version, 2);

  const cases: { name: string; put: LearningPut; currentVersion: number | null; currentStatus: string | null }[] = [
    { name: "create over an existing item", put: put({ id: "li_other" }), currentVersion: 1, currentStatus: "active" },
    { name: "a wrong version", put: put({ expectedVersion: 2, body: "x" }), currentVersion: 1, currentStatus: "active" },
    { name: "an update of a missing item", put: put({ name: "missing", expectedVersion: 1 }), currentVersion: null, currentStatus: null },
    { name: "a retired item with new content", put: put({ name: "old", body: "Brand new.", expectedVersion: 2 }), currentVersion: 2, currentStatus: "retired" },
    { name: "a retired item with its own content", put: put({ name: "old", expectedVersion: 2 }), currentVersion: 2, currentStatus: "retired" },
  ];
  for (const [index, c] of cases.entries()) {
    const before = await snapshot(store, lease.runId);
    const batch = fullBatch(`c${index}`, { puts: [put({ id: "li_fresh", name: `fresh-${index}` }), c.put] });
    await assert.rejects(store.commit(lease, batch), (error: unknown) => {
      assert.ok(isRunwrightError(error), c.name);
      assert.equal(error.code, "learning_conflict", c.name);
      assert.equal(error.status, 409);
      assert.deepEqual(error.details, { kind: "note", name: c.put.name, expectedVersion: c.put.expectedVersion,
        currentVersion: c.currentVersion, currentStatus: c.currentStatus }, c.name);
      return true;
    });
    assert.deepEqual(await snapshot(store, lease.runId), before, c.name);
  }
  const still = await store.getLearningItem("li_old");
  assert.deepEqual([still?.status, still?.version], ["retired", 2]);
});

test("a person's edit between check and apply wins", async (t) => {
  const { store } = await setup(t);
  const lease = await startRun(store);
  await commitLearning(store, lease, { puts: [put()] });
  const v1 = await store.getLearningItem("li_build");
  const edited = await store.changeLearningItem("li_build", { expectedEtag: v1!.etag, action: "edit", patch: { body: "Run make -j8." }, actor: "person" });
  assert.equal(edited.version, 2);
  await assert.rejects(commitLearning(store, lease, { puts: [put({ body: "Run make all.", expectedVersion: 1 })] }, "late"), code("learning_conflict"));
  assert.deepEqual(await store.getLearningItem("li_build"), edited);
});

test("a zombie runner's learning effects are rejected with lease_lost and write nothing; the live lease writes them", async (t) => {
  const { store, clock } = await setup(t);
  const [, skill] = await seedLearningItems(store, "a", [
    { kind: "note", name: "known", title: "Known", description: "A known fact", body: "Fact.", status: "active" },
    { kind: "skill", name: "deploy", title: "Deploy", description: "How to deploy", body: "Run make deploy.", status: "active" },
  ]);
  assert.ok(skill !== undefined);
  const known = (await store.listLearningItems({ agentId: "a", kind: "note" }))[0]!;

  const zombie = await startRun(store, "runner-1", 1_000);
  clock.advance(2_000);
  const [taken] = await store.claimRuns({ runnerId: "runner-2", limit: 10, leaseMs: 60_000 });
  assert.equal(taken?.run.id, zombie.runId);
  assert.equal(taken?.lease.epoch, zombie.epoch + 1);

  const effects: LearningEffects = {
    puts: [put({ id: "li_new", name: "new" })],
    given: [{ itemId: known.id, version: 1, mode: "full" }],
    opened: [skill.id],
    promotions: [{ itemId: skill.id, expectedVersion: 1, workflow: { name: "deploy", document: draft }, note: "promoted" }],
  };
  const before = await snapshot(store, zombie.runId);
  await assert.rejects(store.commit(zombie, fullBatch("zombie", effects)), code("lease_lost"));
  assert.deepEqual(await snapshot(store, zombie.runId), before);
  assert.equal(await store.getLearningItem("li_new"), null);
  assert.deepEqual(await store.learningUses(zombie.runId), []);
  assert.equal(await store.getWorkflow("deploy"), null);
  assert.equal((await store.getLearningItem(skill.id))?.promotionAttempts, 0);

  await store.commit(taken!.lease, fullBatch("live", effects));
  assert.equal((await store.getLearningItem("li_new"))?.sourceRunId, zombie.runId);
  assert.deepEqual((await store.learningUses(zombie.runId)).map((u) => [u.itemId, u.mode, u.opened]).sort(),
    [[known.id, "full", false], [skill.id, "line", true]].sort());
  assert.equal((await store.getWorkflow("deploy"))?.skillItemId, skill.id);
  assert.equal((await store.getLearningItem(skill.id))?.promotedWorkflow, "deploy");
  assert.equal((await store.getLearningItem(skill.id))?.promotedWorkflowVersion, 1);
});

test("given upserts the run's rows; opened sets the flag or inserts a line row; an unknown id rolls the batch back", async (t) => {
  const { store } = await setup(t);
  const [first, second] = await seedLearningItems(store, "a", [
    { kind: "note", name: "one", title: "One", description: "d", body: "b", status: "active" },
    { kind: "note", name: "two", title: "Two", description: "d", body: "b", status: "active" },
  ]);
  await seedLearningItems(store, "a", [{ kind: "note", name: "two", title: "Two", description: "d", body: "b2", status: "active" }]);
  const lease = await startRun(store);
  const uses = async () => (await store.learningUses(lease.runId)).map((u) => [u.itemId, u.version, u.mode, u.opened]);

  await commitLearning(store, lease, { given: [{ itemId: first!.id, version: 1, mode: "full" }] }, "g1");
  assert.deepEqual(await uses(), [[first!.id, 1, "full", false]]);
  await commitLearning(store, lease, { opened: [first!.id] }, "o1");
  assert.deepEqual(await uses(), [[first!.id, 1, "full", true]]);
  await commitLearning(store, lease, { given: [{ itemId: first!.id, version: 3, mode: "line" }] }, "g2");
  assert.deepEqual(await uses(), [[first!.id, 3, "line", true]], "version and mode replaced, opened kept");
  await commitLearning(store, lease, { opened: [second!.id] }, "o2");
  assert.deepEqual(await uses(), [[first!.id, 3, "line", true], [second!.id, 2, "line", true]].sort());

  const before = await snapshot(store, lease.runId);
  await assert.rejects(store.commit(lease, fullBatch("unknown", { given: [{ itemId: second!.id, version: 2, mode: "full" }], opened: ["li_unknown"] })),
    code("not_found"));
  assert.deepEqual(await snapshot(store, lease.runId), before);
});

test("promotions: a rejected attempt only counts; a kept one saves the workflow and a promoted version with the batch", async (t) => {
  const { store } = await setup(t);
  const [skill] = await seedLearningItems(store, "a", [
    { kind: "skill", name: "deploy", title: "Deploy", description: "How to deploy", body: "Run make deploy.", status: "active" },
  ]);
  const lease = await startRun(store);

  await commitLearning(store, lease, { promotions: [{ itemId: skill!.id, expectedVersion: 1, workflow: null, note: "draft failed" }] }, "p1");
  const counted = await store.getLearningItem(skill!.id);
  assert.deepEqual([counted?.promotionAttempts, counted?.version, counted?.promotedWorkflow, counted?.promotedWorkflowVersion], [1, 1, null, null]);
  assert.equal((await store.learningHistory(skill!.id)).length, 1);
  assert.equal(await store.getWorkflow("deploy"), null);

  const { records } = await commitLearning(store, lease, {
    promotions: [{ itemId: skill!.id, expectedVersion: 1, workflow: { name: "deploy", document: draft }, note: "draft kept" }],
  }, "p2");
  assert.deepEqual(records.map((r) => r.key), ["p2"]);
  const workflow = await store.getWorkflow("deploy");
  assert.deepEqual([workflow?.version, workflow?.source, workflow?.skillItemId], [1, "promotion", skill!.id]);
  assert.deepEqual(workflow?.document, draft);
  const promoted = await store.getLearningItem(skill!.id);
  assert.deepEqual(
    [promoted?.version, promoted?.promotedWorkflow, promoted?.promotedWorkflowVersion, promoted?.promotionAttempts, promoted?.status],
    [2, "deploy", 1, 2, "active"],
  );
  assert.deepEqual((await store.learningHistory(skill!.id)).map((h) => [h.version, h.action, h.actor, h.note]), [
    [1, "created", "learning", null],
    [2, "promoted", "learning", "draft kept"],
  ]);
});

test("a kept promotion of a retired, promoted, moved or non-skill item conflicts and leaves no workflow behind", async (t) => {
  const { store } = await setup(t);
  const [promotedSkill, retiredSkill, movedSkill, aNote] = await seedLearningItems(store, "a", [
    { kind: "skill", name: "done", title: "Done", description: "d", body: "b", status: "active" },
    { kind: "skill", name: "old", title: "Old", description: "d", body: "b", status: "active" },
    { kind: "skill", name: "moved", title: "Moved", description: "d", body: "b", status: "active" },
    { kind: "note", name: "fact", title: "Fact", description: "d", body: "b", status: "active" },
  ]);
  await store.changeLearningItem(retiredSkill!.id, { expectedEtag: retiredSkill!.etag, action: "retire", actor: "person" });
  await store.changeLearningItem(movedSkill!.id, { expectedEtag: movedSkill!.etag, action: "edit", patch: { body: "new" }, actor: "person" });
  const lease = await startRun(store);
  await commitLearning(store, lease, { promotions: [{ itemId: promotedSkill!.id, expectedVersion: 1, workflow: { name: "done-flow", document: draft }, note: "" }] });

  const cases = [
    { name: "already promoted", itemId: promotedSkill!.id, expectedVersion: 2 },
    { name: "retired", itemId: retiredSkill!.id, expectedVersion: 2 },
    { name: "not at the expected version", itemId: movedSkill!.id, expectedVersion: 1 },
    { name: "not a skill", itemId: aNote!.id, expectedVersion: 1 },
  ];
  for (const [index, c] of cases.entries()) {
    const before = await snapshot(store, lease.runId);
    await assert.rejects(
      store.commit(lease, fullBatch(`p${index}`, { promotions: [{ itemId: c.itemId, expectedVersion: c.expectedVersion, workflow: { name: `flow-${index}`, document: draft }, note: "" }] })),
      code("learning_conflict"),
      c.name,
    );
    assert.deepEqual(await snapshot(store, lease.runId), before, c.name);
    assert.equal(await store.getWorkflow(`flow-${index}`), null, c.name);
  }
  await assert.rejects(
    store.commit(lease, fullBatch("unknown", { promotions: [{ itemId: "li_unknown", expectedVersion: 1, workflow: null, note: "" }] })),
    code("not_found"),
  );
});

test("seedLearningItems creates and updates items through fenced commits and leaves no run claimed", async (t) => {
  const { store } = await setup(t);
  const { run: waiting } = await store.createRun({ agentId: "a", input: { message: "someone else's", data: null } });
  const created = await seedLearningItems(store, "a", [
    { kind: "skill", name: "s", title: "S", description: "d", body: "b", status: "active" },
    { kind: "note", name: "n", title: "N", description: "d", body: "b", status: "held" },
  ]);
  assert.deepEqual(created.map((i) => [i.kind, i.name, i.version, i.status]), [["skill", "s", 1, "active"], ["note", "n", 1, "held"]]);
  const updated = await seedLearningItems(store, "a", [
    { kind: "note", name: "n", title: "N", description: "d", body: "b2", status: "active" },
  ]);
  assert.deepEqual(updated.map((i) => [i.id, i.version, i.body, i.status]), [[created[1]!.id, 2, "b2", "active"]]);
  const seeders = new Set([created[0]!.sourceRunId, updated[0]!.sourceRunId]);
  assert.equal(seeders.size, 2);
  for (const id of seeders) assert.equal((await store.getRun(id!))?.status, "cancelled");
  const live = (await store.listRuns({ statuses: ["queued", "running"] }, { limit: 50 })).items;
  assert.deepEqual(live.map((r) => [r.id, r.status]), [[waiting.id, "queued"]], "only the other run is left, back in the queue");
  assert.deepEqual((await store.listRuns({ statuses: ["completed"] }, { limit: 50 })).items, []);
});

test("a kept promotion records the version it saved, also when the name already has the skill's own versions", async (t) => {
  const { store } = await setup(t);
  const [skill] = await seedLearningItems(store, "a", [
    { kind: "skill", name: "deploy", title: "Deploy", description: "How to deploy", body: "Run make deploy.", status: "active" },
  ]);
  await store.saveWorkflow({ name: "flow-own", document: { ...draft, description: "earlier" }, source: "promotion", skillItemId: skill!.id });
  const lease = await startRun(store);
  await commitLearning(store, lease, { promotions: [{ itemId: skill!.id, expectedVersion: 1, workflow: { name: "flow-own", document: draft }, note: "" }] });
  const promoted = await store.getLearningItem(skill!.id);
  assert.deepEqual([promoted?.promotedWorkflow, promoted?.promotedWorkflowVersion], ["flow-own", 2]);
  assert.deepEqual((await store.getWorkflow("flow-own", 2))?.document, draft);
});

test("a promotion onto a name the API or another skill owns is refused and writes nothing of the batch", async (t) => {
  const { store } = await setup(t);
  const [skill, other] = await seedLearningItems(store, "a", [
    { kind: "skill", name: "deploy", title: "Deploy", description: "How to deploy", body: "Run make deploy.", status: "active" },
    { kind: "skill", name: "release", title: "Release", description: "How to release", body: "Run make release.", status: "active" },
  ]);
  await store.saveWorkflow({ name: "ops-flow", document: { ...draft, name: "ops-flow" }, source: "api" });
  await store.saveWorkflow({ name: "theirs", document: { ...draft, name: "theirs" }, source: "promotion", skillItemId: other!.id });
  const lease = await startRun(store);
  for (const name of ["ops-flow", "theirs"]) {
    const before = await snapshot(store, lease.runId);
    await assert.rejects(
      store.commit(lease, fullBatch(name, { promotions: [{ itemId: skill!.id, expectedVersion: 1, workflow: { name, document: draft }, note: "" }] })),
      (e: unknown) => isRunwrightError(e) && e.code === "learning_conflict" && e.details?.["reason"] === "workflow_name_taken"
        && e.details["workflow"] === name,
    );
    assert.deepEqual(await snapshot(store, lease.runId), before, `nothing of the batch onto ${name} is written`);
  }
  const after = await store.getLearningItem(skill!.id);
  assert.deepEqual([after?.promotionAttempts, after?.promotedWorkflow, after?.promotedWorkflowVersion, after?.version], [0, null, null, 1]);
  const api = await store.getWorkflow("ops-flow");
  assert.deepEqual([api?.version, api?.source], [1, "api"]);
  const theirs = await store.getWorkflow("theirs");
  assert.deepEqual([theirs?.version, theirs?.skillItemId], [1, other!.id]);
});

test("saveWorkflow from the API onto a promoted name is a conflict and adds no version", async (t) => {
  const { store } = await setup(t);
  const [skill] = await seedLearningItems(store, "a", [
    { kind: "skill", name: "deploy", title: "Deploy", description: "How to deploy", body: "Run make deploy.", status: "active" },
  ]);
  const lease = await startRun(store);
  await commitLearning(store, lease, { promotions: [{ itemId: skill!.id, expectedVersion: 1, workflow: { name: "promoted-flow", document: draft }, note: "" }] });
  await assert.rejects(
    store.saveWorkflow({ name: "promoted-flow", document: { ...draft, description: "operator edit" }, source: "api" }),
    (e: unknown) => isRunwrightError(e) && e.code === "conflict" && e.details?.["reason"] === "promoted_workflow"
      && e.details["skillItemId"] === skill!.id && e.details["name"] === "promoted-flow",
  );
  const saved = await store.getWorkflow("promoted-flow");
  assert.deepEqual([saved?.version, saved?.source], [1, "promotion"]);
  assert.equal(await store.getWorkflow("promoted-flow", 2), null);
});
