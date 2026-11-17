import { test } from "node:test";
import assert from "node:assert/strict";
import { createRecallTool } from "../../src/learning/recall-tool.ts";
import type { LearningHistoryEntry, LearningItem } from "../../src/store/types.ts";
import type { ToolContext } from "../../src/tools/types.ts";
import type { WorkflowDocument } from "../../src/workflow/types.ts";
import { promoteSkill, seedLearningItems } from "../helpers/learning.ts";
import { openTestStore, testAgentDefinition } from "../helpers/store.ts";

const SKILL: LearningItem = {
  id: "li_r", agentId: "a", kind: "skill", name: "report", title: "Weekly report", description: "How to write it.",
  body: "1. Collect.\n2. Write.", status: "active", version: 2, etag: "2-0", sourceRunId: null,
  promotedWorkflow: "skill-report-r", promotedWorkflowVersion: 4, promotionAttempts: 1, createdAt: 1, updatedAt: 1,
};
const HISTORY: LearningHistoryEntry[] = [
  { itemId: "li_r", version: 1, action: "created", title: SKILL.title, description: SKILL.description, body: SKILL.body, status: "active", actor: "learning", note: null, at: 1 },
  { itemId: "li_r", version: 2, action: "promoted", title: SKILL.title, description: SKILL.description, body: SKILL.body, status: "active", actor: "learning", note: null, at: 2 },
];

test("recall of a promoted skill names its workflow and version", async () => {
  const tool = createRecallTool({
    learningUses: async (runId) => [{ runId, itemId: SKILL.id, version: 2, mode: "line", opened: false }],
    getLearningItem: async (id) => (id === SKILL.id ? SKILL : null),
    learningHistory: async () => HISTORY,
  });
  const output = await tool.handler({ name: "skill/report" }, { runId: "run_1" } as unknown as ToolContext);
  assert.equal(output.isError, undefined);
  assert.ok(output.content.includes(
    "Saved as workflow `skill-report-r` version 4: run it with the `run_workflow` tool, passing this name and version.",
  ));
  assert.deepEqual(output.learningOpened, [SKILL.id]);
});

const DOC = {
  format: "runwright.workflow/v1", name: "draft",
  schemas: { In: { type: "object" }, Out: { type: "object", required: ["summary"], properties: { summary: { type: "string" } } } },
  input: "In", output: "Out",
  root: { id: "main", kind: "sequence", steps: [{ id: "write", kind: "model", prompt: "Write the weekly report", output: "Out" }] },
  result: { $ref: "steps.write" },
} as unknown as WorkflowDocument;

test("recall shows the workflow pointer only for a version at or after the promotion", async (t) => {
  const { store } = await openTestStore(t);
  const agent = (await store.saveAgent({ definition: testAgentDefinition({ learning: true }) })).agent;
  const [v1] = await seedLearningItems(store, agent.id, [
    { kind: "skill", name: "report", title: "Weekly report", description: "How to write it.", body: "1. Collect.\n2. Write.", status: "active" },
  ]);
  const skill = v1 as LearningItem;
  assert.equal(skill.version, 1);
  const v2 = await store.changeLearningItem(skill.id, {
    expectedEtag: skill.etag, action: "edit", patch: { body: "1. Collect the numbers.\n2. Write the summary." }, actor: "person",
  });
  assert.equal(v2.version, 2);
  const v3 = await promoteSkill(store, v2, "skill-report-flow", DOC);
  assert.equal(v3.version, 3);
  assert.equal(v3.promotedWorkflow, "skill-report-flow");

  const givenVersion: Record<string, number> = { runA: 1, runEdited: 2, runB: 3 };
  const tool = createRecallTool({
    learningUses: async (runId) => [{ runId, itemId: skill.id, version: givenVersion[runId] as number, mode: "line", opened: false }],
    getLearningItem: (id) => store.getLearningItem(id),
    learningHistory: (id) => store.learningHistory(id),
  });
  const recall = (runId: string) => tool.handler({ name: "report" }, { runId } as unknown as ToolContext);

  const a = await recall("runA");
  assert.equal(a.isError, undefined);
  assert.ok(a.content.includes("1. Collect.\n2. Write."), "run A sees the text of version 1");
  assert.ok(!a.content.includes("Collect the numbers"));
  assert.ok(!a.content.includes("Saved as workflow"), "no workflow sentence for a version drafted before the promotion");
  assert.ok(!a.content.includes("skill-report-flow"));
  assert.deepEqual(a.data, { itemId: skill.id, version: 1, kind: "skill", name: "report", promoted: false });

  const edited = await recall("runEdited");
  assert.ok(edited.content.includes("1. Collect the numbers.\n2. Write the summary."));
  assert.ok(!edited.content.includes("Saved as workflow"), "an edited, not yet promoted version has no pointer");
  assert.equal((edited.data as { promoted: boolean }).promoted, false);

  const b = await recall("runB");
  assert.ok(b.content.includes("1. Collect the numbers.\n2. Write the summary."));
  assert.ok(b.content.includes(
    "Saved as workflow `skill-report-flow` version 1: run it with the `run_workflow` tool, passing this name and version.",
  ));
  assert.deepEqual(b.data, { itemId: skill.id, version: 3, kind: "skill", name: "report", promoted: true });

  const v4 = await store.changeLearningItem(skill.id, { expectedEtag: v3.etag, action: "edit", patch: { title: "Weekly report v2" }, actor: "person" });
  givenVersion["runLater"] = v4.version;
  const later = await recall("runLater");
  assert.ok(later.content.includes("Weekly report v2"));
  assert.ok(later.content.includes("Saved as workflow `skill-report-flow` version 1"), "a version after the promotion keeps the pointer");
});
