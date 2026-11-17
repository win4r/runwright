import { test } from "node:test";
import assert from "node:assert/strict";
import { openTestStore, testAgentDefinition } from "../helpers/store.ts";
import { createFakeClock } from "../../src/core/clock.ts";
import { isRunwrightError } from "../../src/core/errors.ts";
import { slugifyAgentName } from "../../src/store/sqlite.ts";
import type { WorkflowDocument } from "../../src/workflow/types.ts";

test("saving creates revision 1; an unchanged definition creates nothing", async (t) => {
  const clock = createFakeClock(1000);
  const { store } = await openTestStore(t, { clock });
  const first = await store.saveAgent({ definition: testAgentDefinition({ name: "My Writer!" }) });
  assert.equal(first.created, true);
  assert.equal(first.agent.id, "my-writer");
  assert.equal(first.agent.currentRevision, 1);
  assert.equal(first.revision.revision, 1);
  assert.match(first.revision.definitionHash, /^[0-9a-f]{64}$/);
  clock.advance(10);
  const again = await store.saveAgent({ id: "my-writer", definition: testAgentDefinition({ name: "My Writer!" }) });
  assert.equal(again.created, false);
  assert.equal(again.revision.revision, 1);
  assert.equal(again.agent.updatedAt, 1000);
  assert.equal((await store.listRevisions("my-writer")).length, 1);
});

test("a changed definition creates an immutable new revision", async (t) => {
  const { store } = await openTestStore(t);
  await store.saveAgent({ id: "a1", definition: testAgentDefinition({ instructions: "v1" }) });
  const second = await store.saveAgent({ id: "a1", definition: testAgentDefinition({ instructions: "v2", name: "Renamed" }) });
  assert.equal(second.created, true);
  assert.equal(second.revision.revision, 2);
  assert.equal(second.agent.name, "Renamed");
  assert.equal((await store.getRevision("a1", 1))?.definition.instructions, "v1");
  assert.equal((await store.getRevision("a1"))?.definition.instructions, "v2");
  assert.deepEqual((await store.listRevisions("a1")).map((r) => r.revision), [2, 1]);
  assert.equal(await store.getRevision("a1", 9), null);
  assert.equal(await store.getRevision("nope"), null);
  assert.equal(await store.getAgent("nope"), null);
  const back = await store.saveAgent({ id: "a1", definition: testAgentDefinition({ instructions: "v1" }) });
  assert.equal(back.revision.revision, 3, "returning to an old definition is still a new revision");
});

test("key order does not change the definition hash", async (t) => {
  const { store } = await openTestStore(t);
  const def = testAgentDefinition();
  await store.saveAgent({ id: "k", definition: def });
  const reordered = Object.fromEntries(Object.entries(def).reverse()) as typeof def;
  assert.equal((await store.saveAgent({ id: "k", definition: reordered })).created, false);
});

test("listAgents and slugs", async (t) => {
  const clock = createFakeClock(5000);
  const { store } = await openTestStore(t, { clock });
  await store.saveAgent({ definition: testAgentDefinition({ name: "Bravo" }) });
  clock.advance(1);
  await store.saveAgent({ definition: testAgentDefinition({ name: "alpha" }) });
  clock.advance(1);
  const blank = await store.saveAgent({ definition: testAgentDefinition({ name: "!!!" }) });
  assert.match(blank.agent.id, /^agent_[0-9a-z]{26}$/);
  assert.deepEqual((await store.listAgents()).map((a) => a.id).slice(0, 2), ["bravo", "alpha"]);
  assert.equal(slugifyAgentName("  Hello,  World -- 2 "), "hello-world-2");
  assert.equal(slugifyAgentName("x".repeat(80)).length, 64);
});

test("workflows are versioned by content", async (t) => {
  const { store } = await openTestStore(t);
  const doc = (description: string) => ({ format: "runwright.workflow/v1", name: "w", description, schemas: {}, input: "I",
    output: "O", root: { id: "f", kind: "fail", message: "x" }, result: null }) as WorkflowDocument;
  const v1 = await store.saveWorkflow({ name: "w", document: doc("one"), source: "api" });
  assert.deepEqual([v1.created, v1.workflow.version, v1.workflow.source, v1.workflow.skillItemId], [true, 1, "api", null]);
  assert.equal((await store.saveWorkflow({ name: "w", document: doc("one"), source: "api" })).created, false);
  const v2 = await store.saveWorkflow({ name: "w", document: doc("two"), source: "api" });
  assert.deepEqual([v2.created, v2.workflow.version, v2.workflow.source, v2.workflow.skillItemId], [true, 2, "api", null]);
  await store.saveWorkflow({ name: "a", document: doc("other"), source: "api" });
  assert.equal((await store.getWorkflow("w"))?.document.description, "two");
  assert.equal((await store.getWorkflow("w", 1))?.document.description, "one");
  assert.equal(await store.getWorkflow("missing"), null);
  assert.deepEqual((await store.listWorkflows()).map((w) => [w.name, w.version]), [["a", 1], ["w", 2]]);
});

test("a workflow name belongs to its first owner: API names refuse promotions, promoted names refuse API saves", async (t) => {
  const { store } = await openTestStore(t);
  const doc = (name: string, description: string) => ({ format: "runwright.workflow/v1", name, description, schemas: {}, input: "I",
    output: "O", root: { id: "f", kind: "fail", message: "x" }, result: null }) as WorkflowDocument;
  const code = (c: string, reason: string) => (e: unknown): boolean =>
    isRunwrightError(e) && e.code === c && e.details?.["reason"] === reason;

  await store.saveWorkflow({ name: "ops", document: doc("ops", "one"), source: "api" });
  for (const description of ["one", "two"]) {
    await assert.rejects(
      store.saveWorkflow({ name: "ops", document: doc("ops", description), source: "promotion", skillItemId: "li_1" }),
      code("learning_conflict", "workflow_name_taken"),
    );
  }
  assert.deepEqual((await store.getWorkflow("ops"))?.version, 1);

  const p1 = await store.saveWorkflow({ name: "skill-x", document: doc("skill-x", "one"), source: "promotion", skillItemId: "li_1" });
  assert.deepEqual([p1.created, p1.workflow.version, p1.workflow.skillItemId], [true, 1, "li_1"]);
  for (const description of ["one", "two"]) {
    await assert.rejects(
      store.saveWorkflow({ name: "skill-x", document: doc("skill-x", description), source: "api" }),
      (e: unknown) => code("conflict", "promoted_workflow")(e) && isRunwrightError(e)
        && e.status === 409 && e.details?.["name"] === "skill-x" && e.details["skillItemId"] === "li_1",
    );
  }
  await assert.rejects(
    store.saveWorkflow({ name: "skill-x", document: doc("skill-x", "two"), source: "promotion", skillItemId: "li_2" }),
    code("learning_conflict", "workflow_name_taken"),
  );
  assert.equal((await store.saveWorkflow({ name: "skill-x", document: doc("skill-x", "one"), source: "promotion", skillItemId: "li_1" })).created, false);
  const p2 = await store.saveWorkflow({ name: "skill-x", document: doc("skill-x", "two"), source: "promotion", skillItemId: "li_1" });
  assert.deepEqual([p2.created, p2.workflow.version], [true, 2]);
  assert.equal((await store.getWorkflow("skill-x", 3)), null);
  assert.equal((await store.getWorkflow("ops"))?.version, 1);
});
