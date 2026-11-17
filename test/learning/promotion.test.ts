import { test } from "node:test";
import assert from "node:assert/strict";
import type { Json } from "../../src/core/json.ts";
import type { ScriptedScript } from "../../src/models/types.ts";
import { createIdSource } from "../../src/core/ids.ts";
import type { LearningItem } from "../../src/store/types.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import type { WorkflowDocument } from "../../src/workflow/types.ts";
import { pickPromotionCandidate, promotedWorkflowName } from "../../src/learning/promotion.ts";
import { isRunwrightError } from "../../src/core/errors.ts";
import { seedLearningItems } from "../helpers/learning.ts";
import { openTestStore, testAgentDefinition } from "../helpers/store.ts";
import { waitFor } from "../helpers/wait.ts";
import { itemFile, keepAll, learningHarness, type LearningHarness } from "./support.ts";

const SKILL = { path: "skills/report.md", content: itemFile("Weekly report", "How to write the weekly report.", "1. Collect the numbers.\n2. Write the summary.") };

const BASE = {
  format: "runwright.workflow/v1",
  name: "draft",
  schemas: { In: { type: "object" }, Out: { type: "object", required: ["summary"], properties: { summary: { type: "string" } } } },
  input: "In",
  output: "Out",
};
const VALID = { ...BASE, root: { id: "main", kind: "sequence", steps: [{ id: "write", kind: "model", prompt: "Write the weekly report", output: "Out" }] }, result: { $ref: "steps.write" } };
const INVALID = { ...BASE, root: { id: "main", kind: "teleport" }, result: { summary: "x" } };
const FAILS_DRY_RUN = { ...BASE, root: { id: "stop", kind: "fail", message: "cannot write reports" }, result: { summary: "x" } };

function script(document: Json): ScriptedScript {
  return {
    turns: [{ text: "report written" }],
    steps: {
      "learning.propose": { output: { job_finished: true, files: [SKILL] } },
      "learning.grade": keepAll([SKILL.path]),
      "learning.promote": { output: { document } },
    },
  };
}

async function runOnce(h: LearningHarness, agentId: string): Promise<string> {
  const run = await h.start(agentId, { message: "write this week's report" });
  await h.until(run.id, "completed");
  return run.id;
}

async function theSkill(h: LearningHarness, agentId: string): Promise<LearningItem> {
  const [item] = await h.store.listLearningItems({ agentId, kind: "skill" });
  assert.ok(item !== undefined, `agent ${agentId} has a skill`);
  return item;
}

const asked = async (h: LearningHarness, runId: string): Promise<boolean> =>
  (await h.journal(runId)).some((r) => r.type === "model.started" && r.key === "learning/promote/draft");

test("after enough served runs a valid draft is saved under the skill's own workflow name and linked with its version", async (t) => {
  const h = await learningHarness(t, { config: { promoteAfterRuns: 2 } });
  const agent = await h.agent(script(VALID));
  // Run 1 learns the skill; runs 2 and 3 are served by it but fewer than 2 completed served runs precede them.
  const early = [await runOnce(h, agent.id), await runOnce(h, agent.id), await runOnce(h, agent.id)];
  for (const runId of early) assert.equal(await asked(h, runId), false, `run ${runId} must not be asked`);
  const name = promotedWorkflowName(await theSkill(h, agent.id));
  assert.match(name, /^skill-report-[a-z0-9]{26}$/);
  assert.equal(await h.store.getWorkflow(name), null);

  const run4 = await runOnce(h, agent.id);
  assert.equal(await asked(h, run4), true);
  const started = (await h.records(run4, "model.started")).find((m) => m.step === "learning.promote");
  assert.equal(started?.purpose, "promotion");
  const promotion = (await h.records(run4, "learning.promotion"))[0];
  const [item] = await h.store.listLearningItems({ agentId: agent.id, kind: "skill" });
  assert.deepEqual(promotion, { itemId: item?.id, outcome: "kept", workflow: name, problems: [] });
  assert.equal(item?.promotedWorkflow, name);
  assert.equal(item?.promotedWorkflowVersion, 1);
  assert.equal(item?.promotionAttempts, 1);
  const draftRequest = h.requests.find((r) => r.meta.runId === run4 && r.meta.step === "learning.promote");
  assert.ok(draftRequest?.messages[0]?.content.includes(`saved as the workflow "${name}"`));
  const history = await h.store.learningHistory(item?.id as string);
  assert.equal(history[history.length - 1]?.action, "promoted");
  const saved = await h.store.getWorkflow(name);
  assert.equal(saved?.version, 1);
  assert.equal(saved?.source, "promotion");
  assert.equal(saved?.skillItemId, item?.id);
  assert.equal(saved?.document.name, name);

  // The next run is told about the workflow and is not asked again.
  const before = h.requests.length;
  const run5 = await runOnce(h, agent.id);
  assert.equal(await asked(h, run5), false);
  const job = h.requests.slice(before).find((r) => r.meta.runId === run5 && r.meta.purpose === "run");
  assert.ok(job?.system.includes(`Saved as workflow \`${name}\` version 1: run it with the \`run_workflow\` tool, passing this name and version.`));
});

const OTHER_VALID = {
  ...BASE,
  root: { id: "main", kind: "sequence", steps: [{ id: "write", kind: "model", prompt: "Write the monthly report for finance", output: "Out" }] },
  result: { $ref: "steps.write" },
};

test("the reviewer's probe: same-named skills of two agents are promoted to two workflows, each its own", async (t) => {
  const h = await learningHarness(t, { config: { promoteAfterRuns: 1 } });
  const alpha = await h.agent(script(VALID), { name: "Alpha" });
  const beta = await h.agent(script(OTHER_VALID), { name: "Beta" });
  assert.notEqual(alpha.id, beta.id);
  for (let i = 0; i < 3; i++) {
    await runOnce(h, alpha.id);
    await runOnce(h, beta.id);
  }
  const skills = [await theSkill(h, alpha.id), await theSkill(h, beta.id)];
  assert.deepEqual(skills.map((s) => s.name), ["report", "report"]);
  assert.notEqual(skills[0]?.promotedWorkflow, skills[1]?.promotedWorkflow);
  const prompts = [VALID, OTHER_VALID].map((d) => (d.root.steps[0] as { prompt: string }).prompt);
  for (const [index, skill] of skills.entries()) {
    assert.equal(skill.promotedWorkflow, promotedWorkflowName(skill));
    assert.equal(skill.promotedWorkflowVersion, 1);
    const saved = await h.store.getWorkflow(skill.promotedWorkflow as string, skill.promotedWorkflowVersion as number);
    assert.equal(saved?.skillItemId, skill.id);
    const root = saved?.document.root as unknown as { steps: { prompt: string }[] };
    assert.equal(root.steps[0]?.prompt, prompts[index], "each skill resolves to its own document");
    assert.equal(await h.store.getWorkflow(skill.promotedWorkflow as string, 2), null, "no second version under either name");
  }
});

test("a name an operator already saved is not touched: the attempt is rejected and counted", async (t) => {
  const h = await learningHarness(t, { config: { promoteAfterRuns: 2 } });
  const agent = await h.agent(script(VALID));
  await runOnce(h, agent.id);
  const skill = await theSkill(h, agent.id);
  const name = promotedWorkflowName(skill);
  const operator = { ...OTHER_VALID, name } as unknown as WorkflowDocument;
  await h.store.saveWorkflow({ name, document: operator, source: "api" });
  await runOnce(h, agent.id);
  await runOnce(h, agent.id);
  const run = await runOnce(h, agent.id);

  assert.equal(await asked(h, run), true);
  const promotion = (await h.records(run, "learning.promotion"))[0];
  assert.deepEqual(promotion, {
    itemId: skill.id, outcome: "rejected", workflow: null,
    problems: [`the workflow name ${name} is already used by a workflow this skill does not own`],
  });
  const after = await h.store.getLearningItem(skill.id);
  assert.deepEqual([after?.promotedWorkflow, after?.promotedWorkflowVersion, after?.promotionAttempts], [null, null, 1]);
  const saved = await h.store.getWorkflow(name);
  assert.deepEqual([saved?.version, saved?.source, saved?.skillItemId], [1, "api", null]);
  assert.deepEqual(saved?.document, operator);
});

test("promotedWorkflowName: always a valid workflow name, different for different items", () => {
  const ids = createIdSource();
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789-";
  let seed = 7;
  const random = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const seen = new Map<string, string>();
  for (let i = 0; i < 500; i++) {
    const length = 1 + random(64);
    let name = alphabet[random(36)] as string;
    while (name.length < length) name += alphabet[random(alphabet.length)];
    const id = ids.next("li");
    const workflow = promotedWorkflowName({ id, name });
    assert.match(workflow, /^[a-z][a-z0-9_-]{0,63}$/, `${name} / ${id}`);
    assert.ok(workflow.length <= 63);
    const other = seen.get(workflow);
    assert.equal(other, undefined, `${id} and ${other} share ${workflow}`);
    seen.set(workflow, id);
    assert.notEqual(promotedWorkflowName({ id: ids.next("li"), name }), workflow);
  }
  assert.equal(promotedWorkflowName({ id: "li_01JABCDEFGHJKMNPQRSTVWXYZ0", name: "report" }), "skill-report-01jabcdefghjkmnpqrstvwxyz0");
  assert.equal(
    promotedWorkflowName({ id: "li_01JABCDEFGHJKMNPQRSTVWXYZ0", name: `${"a".repeat(29)}-tail` }),
    `skill-${"a".repeat(29)}-01jabcdefghjkmnpqrstvwxyz0`,
  );
});

for (const [label, document, pattern] of [
  ["a draft with a validator error", INVALID, /unknown node kind/],
  ["a draft that fails the dry run", FAILS_DRY_RUN, /dry run .*would fail/],
] as const) {
  test(`${label} is rejected with its problems; after two attempts it is not asked again`, async (t) => {
    const h = await learningHarness(t, { config: { promoteAfterRuns: 2 } });
    const agent = await h.agent(script(document));
    for (let i = 0; i < 3; i++) await runOnce(h, agent.id);
    const attempts: string[] = [await runOnce(h, agent.id), await runOnce(h, agent.id)];
    for (const runId of attempts) {
      assert.equal(await asked(h, runId), true);
      const promotion = (await h.records(runId, "learning.promotion"))[0];
      assert.equal(promotion?.outcome, "rejected");
      assert.equal(promotion?.workflow, null);
      assert.match(promotion?.problems.join("\n") ?? "", pattern);
    }
    const [item] = await h.store.listLearningItems({ agentId: agent.id, kind: "skill" });
    assert.equal(item?.promotionAttempts, 2);
    assert.equal(item?.promotedWorkflow, null);
    assert.equal(item?.promotedWorkflowVersion, null);
    assert.equal(await h.store.getWorkflow(promotedWorkflowName(item as LearningItem)), null);
    const after = await runOnce(h, agent.id);
    assert.equal(await asked(h, after), false);
  });
}

test("pickPromotionCandidate: active skills only, unpromoted, under two attempts, served enough", () => {
  const skill = (id: string, patch: Partial<LearningItem>): LearningItem => ({
    id, agentId: "a", kind: "skill", name: id, title: id, description: id, body: id, status: "active", version: 1, etag: "1-0",
    sourceRunId: null, promotedWorkflow: null, promotedWorkflowVersion: null, promotionAttempts: 0, createdAt: 1, updatedAt: 1, ...patch,
  });
  const items = [
    skill("note", { kind: "note" }), skill("retired", { status: "retired" }), skill("promoted", { promotedWorkflow: "skill-promoted-01j", promotedWorkflowVersion: 1 }),
    skill("tried", { promotionAttempts: 2 }), skill("young", {}), skill("ready", {}),
  ];
  const counts = { note: 9, retired: 9, promoted: 9, tried: 9, young: 2, ready: 3 };
  assert.equal(pickPromotionCandidate(items, counts, 3)?.id, "ready");
  assert.equal(pickPromotionCandidate(items, counts, 4), null);
});

/** Like `script`, but the draft turn is slow, so a test can act while it is in flight. */
function slowDraft(document: Json): ScriptedScript {
  const base = script(document);
  return { ...base, steps: { ...base.steps, "learning.promote": { output: { document }, delayMs: 500 } } };
}

test("a rejected attempt is counted once across a crash during the draft", async (t) => {
  const h = await learningHarness(t, { config: { promoteAfterRuns: 2 } });
  const agent = await h.agent(slowDraft(INVALID));
  for (let i = 0; i < 3; i++) await runOnce(h, agent.id);
  const run = await h.start(agent.id, { message: "write this week's report" });
  await waitFor(() => asked(h, run.id), { timeoutMs: 8000 });
  await h.crashAndReplace();
  await h.until(run.id, "completed", 8000);

  const journal = await h.journal(run.id);
  assert.equal(journal.filter((r) => r.type === "model.interrupted" && r.key === "learning/promote/draft").length, 1);
  assert.equal(journal.filter((r) => r.type === "step.finished" && r.key === "learning/promote/apply").length, 1);
  const promotions = await h.records(run.id, "learning.promotion");
  assert.equal(promotions.length, 1);
  assert.equal(promotions[0]?.outcome, "rejected");
  const [item] = await h.store.listLearningItems({ agentId: agent.id, kind: "skill" });
  assert.equal(item?.promotionAttempts, 1);
  assert.equal(item?.promotedWorkflow, null);
});

test("a skill edited while its workflow is drafted is not promoted and its attempt is not counted", async (t) => {
  const h = await learningHarness(t, { config: { promoteAfterRuns: 2 } });
  const agent = await h.agent(slowDraft(VALID));
  for (let i = 0; i < 3; i++) await runOnce(h, agent.id);
  const run = await h.start(agent.id, { message: "write this week's report" });
  await waitFor(() => asked(h, run.id), { timeoutMs: 8000 });
  const [skill] = await h.store.listLearningItems({ agentId: agent.id, kind: "skill" });
  const edited = await h.store.changeLearningItem(skill?.id as string, {
    expectedEtag: skill?.etag as string, action: "edit", patch: { body: "1. Collect the numbers.\n2. Ask finance.\n3. Write the summary." }, actor: "person",
  });
  await h.until(run.id, "completed", 8000);

  assert.equal(await h.store.getWorkflow(promotedWorkflowName(skill as LearningItem)), null);
  const promotion = (await h.records(run.id, "learning.promotion"))[0];
  assert.deepEqual(promotion, {
    itemId: skill?.id, outcome: "rejected", workflow: null, problems: ["the skill changed while its workflow was being drafted"],
  });
  const after = await h.store.getLearningItem(skill?.id as string);
  assert.equal(after?.version, edited.version);
  assert.equal(after?.body, edited.body);
  assert.equal(after?.promotedWorkflow, null);
  assert.equal(after?.promotionAttempts, skill?.promotionAttempts);
  assert.equal((await h.store.learningHistory(skill?.id as string)).some((e) => e.action === "promoted"), false);
});

const REVIEWER = {
  ...BASE,
  schemas: { In: { type: "object" }, Out: { type: "object", required: ["code"], properties: { code: { type: "string", pattern: "^[A-Z]{2}$", minLength: 2, maxLength: 2 } } } },
  root: { id: "main", kind: "sequence", steps: [{ id: "write", kind: "model", prompt: "Give the report's country code", output: "Out" }] },
  result: { $ref: "steps.write" },
};

test("the reviewer's probe: a draft whose output has a pattern-constrained code is promoted on its first attempt", async (t) => {
  const h = await learningHarness(t, { config: { promoteAfterRuns: 2 } });
  const agent = await h.agent(script(REVIEWER));
  for (let i = 0; i < 3; i++) assert.equal(await asked(h, await runOnce(h, agent.id)), false);
  const name = promotedWorkflowName(await theSkill(h, agent.id));

  const first = await runOnce(h, agent.id);
  assert.equal(await asked(h, first), true);
  const promotion = (await h.records(first, "learning.promotion"))[0];
  const item = await theSkill(h, agent.id);
  assert.deepEqual(promotion, { itemId: item.id, outcome: "kept", workflow: name, problems: [] });
  assert.equal(item.promotedWorkflow, name);
  assert.equal(item.promotedWorkflowVersion, 1);
  assert.equal(item.promotionAttempts, 1);
  const saved = await h.store.getWorkflow(name);
  assert.equal(saved?.version, 1);
  assert.equal(saved?.source, "promotion");
  assert.deepEqual(saved?.document.schemas, REVIEWER.schemas);

  const next = await runOnce(h, agent.id);
  assert.equal(await asked(h, next), false);
});

// ---------------------------------------------------------------- R13D-engine-01 class: the catalogue is the engine's answer

const hostTool = (name: string, extra?: Partial<ToolDefinition>): ToolDefinition => ({
  name, description: `The ${name} tool.`, parameters: { type: "object", properties: {} }, effect: "read", handler: async () => ({ content: "ok" }), ...extra,
});

test("a tool the server deny list names, or whose default policy is deny, is not offered to the draft, and a draft using it is rejected", async (t) => {
  const h = await learningHarness(t, {
    config: { promoteAfterRuns: 1 },
    tools: [hostTool("shell", { effect: "write" }), hostTool("lookup"), hostTool("locked", { defaultPolicy: "deny" })],
    engine: { denyTools: ["shell"] },
  });
  const usesShell = { ...BASE, root: { id: "run", kind: "tool", tool: "shell", args: {} }, result: { summary: "x" } };
  const agent = await h.agent(script(usesShell), { tools: [{ name: "shell" }, { name: "lookup" }, { name: "locked" }] });
  let drafted: string | null = null;
  for (let i = 0; i < 3 && drafted === null; i++) {
    const runId = await runOnce(h, agent.id);
    if (await asked(h, runId)) drafted = runId;
  }
  assert.ok(drafted !== null, "a run was asked to draft the skill");
  const request = h.requests.find((r) => r.meta.runId === drafted && r.meta.step === "learning.promote");
  const message = request?.messages[0]?.content ?? "";
  assert.ok(message.includes("- lookup: The lookup tool."), "an allowed listed tool is offered");
  assert.ok(!message.includes("- shell:"), "a tool on the server deny list is not offered");
  assert.ok(!message.includes("- locked:"), "a tool whose default policy is deny is not offered");
  const promotion = (await h.records(drafted, "learning.promotion"))[0];
  assert.equal(promotion?.outcome, "rejected");
  assert.match(promotion?.problems.join("\n") ?? "", /shell/);
});

// ---------------------------------------------------------------- R15D-learning-02: an attempt counts only against the version it was drafted from

/** A person's change to the skill, made while its draft request is in flight. */
type Change = (h: LearningHarness, skill: LearningItem) => Promise<void>;
const editBody: Change = async (h, skill) => {
  await h.store.changeLearningItem(skill.id, {
    expectedEtag: skill.etag, action: "edit", patch: { body: "1. Collect the numbers.\n2. Ask finance.\n3. Write the summary." }, actor: "person",
  });
};
const retire: Change = async (h, skill) => {
  await h.store.changeLearningItem(skill.id, { expectedEtag: skill.etag, action: "retire", actor: "person" });
};

/**
 * Runs the agent until a run is asked to draft its skill; `change` is applied when the draft request is made,
 * before the model answers (`beforeModel`). Returns the run and the skill as it was picked.
 */
async function changedDuringDraft(
  t: import("node:test").TestContext, draftTurn: ScriptedScript["steps"], change: Change, before?: (h: LearningHarness, skill: LearningItem) => Promise<void>,
): Promise<{ h: LearningHarness; runId: string; picked: LearningItem }> {
  let h: LearningHarness | null = null;
  let agentId: string | null = null;
  let picked: LearningItem | null = null;
  const harness = await learningHarness(t, {
    config: { promoteAfterRuns: 2 },
    beforeModel: async (request) => {
      // Once, at the first attempt of the draft request.
      if (request.meta.step !== "learning.promote" || h === null || agentId === null || picked !== null) return;
      picked = await theSkill(h, agentId);
      await change(h, picked);
    },
  });
  h = harness;
  const base = script(INVALID);
  const agent = await harness.agent({ ...base, steps: { ...base.steps, ...draftTurn } });
  agentId = agent.id;
  for (let i = 0; i < 3; i++) assert.equal(await asked(harness, await runOnce(harness, agent.id)), false);
  if (before !== undefined) await before(harness, await theSkill(harness, agent.id));
  const runId = await runOnce(harness, agent.id);
  assert.equal(await asked(harness, runId), true);
  assert.ok(picked !== null, "the skill was changed during the draft");
  return { h: harness, runId, picked };
}

async function assertNotCounted(h: LearningHarness, runId: string, picked: LearningItem): Promise<void> {
  const promotions = await h.records(runId, "learning.promotion");
  assert.deepEqual(promotions, [{ itemId: picked.id, outcome: "rejected", workflow: null, problems: ["the skill changed while its workflow was being drafted"] }]);
  const after = await h.store.getLearningItem(picked.id);
  assert.equal(after?.promotionAttempts, picked.promotionAttempts, "the changed skill keeps its attempts");
  assert.equal(after?.version, picked.version + 1);
  assert.equal(after?.promotedWorkflow, null);
}

test("(R15D-learning-02) an invalid draft of a skill edited meanwhile is not counted against the edited skill", async (t) => {
  const { h, runId, picked } = await changedDuringDraft(t, { "learning.promote": { output: { document: INVALID }, delayMs: 50 } }, editBody);
  await assertNotCounted(h, runId, picked);
});

test("(R15D-learning-02) a provider failure while the skill was edited is not counted against the edited skill", async (t) => {
  const { h, runId, picked } = await changedDuringDraft(t, { "learning.promote": { fail: { attempts: Infinity, status: 400 } } }, editBody);
  const journal = await h.journal(runId);
  assert.ok(journal.some((r) => r.key === "learning/promote/draft" && r.type === "model.failed"), "the draft request failed");
  await assertNotCounted(h, runId, picked);
});

test("(R15D-learning-02) an invalid draft of a skill retired meanwhile is not counted", async (t) => {
  const { h, runId, picked } = await changedDuringDraft(t, { "learning.promote": { output: { document: INVALID } } }, retire);
  await assertNotCounted(h, runId, picked);
  assert.equal((await h.store.getLearningItem(picked.id))?.status, "retired");
});

test("(R15D-learning-02) a draft whose workflow name is taken, of a skill edited meanwhile, is not counted", async (t) => {
  const takeName = async (h: LearningHarness, skill: LearningItem): Promise<void> => {
    const name = promotedWorkflowName(skill);
    await h.store.saveWorkflow({ name, document: { ...OTHER_VALID, name } as unknown as WorkflowDocument, source: "api" });
  };
  const { h, runId, picked } = await changedDuringDraft(t, { "learning.promote": { output: { document: VALID } } }, editBody, takeName);
  await assertNotCounted(h, runId, picked);
  assert.equal((await h.store.getWorkflow(promotedWorkflowName(picked)))?.source, "api");
});

test("(R15D-learning-02) store: a rejected promotion of a stale version conflicts and changes nothing; of the current version it counts once", async (t) => {
  const { store } = await openTestStore(t);
  await store.saveAgent({ id: "a", definition: testAgentDefinition() });
  const [skill, aNote] = await seedLearningItems(store, "a", [
    { kind: "skill", name: "deploy", title: "Deploy", description: "How to deploy", body: "Run make deploy.", status: "active" },
    { kind: "note", name: "fact", title: "Fact", description: "A fact.", body: "The body.", status: "active" },
  ]);
  const edited = await store.changeLearningItem(skill!.id, {
    expectedEtag: skill!.etag, action: "edit", patch: { body: "Run make deploy-all." }, actor: "person",
  });
  const { run } = await store.createRun({ agentId: "a", input: { message: "go", data: null } });
  const [claim] = await store.claimRuns({ runnerId: "r", limit: 1, leaseMs: 60_000 });
  assert.equal(claim?.run.id, run.id);
  const lease = claim!.lease;
  const commit = (itemId: string, expectedVersion: number, key: string) => store.commit(lease, {
    records: [{ type: "learning.promotion", key, data: { key } }],
    learning: { promotions: [{ itemId, expectedVersion, workflow: null, note: "draft rejected" }] },
  });
  const conflict = (e: unknown): boolean => isRunwrightError(e) && e.code === "learning_conflict";
  const journalLength = (await store.readJournal(run.id)).length;

  await assert.rejects(commit(skill!.id, skill!.version, "stale"), conflict);
  assert.deepEqual(await store.getLearningItem(skill!.id), edited, "nothing changed");
  assert.equal((await store.readJournal(run.id)).length, journalLength, "the batch was not written");

  await store.changeLearningItem(aNote!.id, { expectedEtag: aNote!.etag, action: "retire", actor: "person" });
  await assert.rejects(commit(aNote!.id, aNote!.version, "note"), conflict, "a note is never promoted");

  const retiredSkill = (await seedLearningItems(store, "a", [
    { kind: "skill", name: "old", title: "Old", description: "Old way", body: "Do it the old way.", status: "active" },
  ]))[0]!;
  const retired = await store.changeLearningItem(retiredSkill.id, { expectedEtag: retiredSkill.etag, action: "retire", actor: "person" });
  await assert.rejects(commit(retired.id, retired.version, "retired"), conflict, "a retired skill");
  assert.equal((await store.getLearningItem(retired.id))?.promotionAttempts, 0);

  await commit(skill!.id, edited.version, "current");
  const counted = await store.getLearningItem(skill!.id);
  assert.deepEqual([counted?.promotionAttempts, counted?.version, counted?.etag], [edited.promotionAttempts + 1, edited.version, edited.etag]);
});
