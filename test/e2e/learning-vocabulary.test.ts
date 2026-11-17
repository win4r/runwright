/**
 * Learning's journalled step values and structured outputs keep Runwright's own field names whatever secrets
 * exist (finding R12-02): the engine continues with the value the store kept, so a renamed `promptSection`,
 * `jobFinished` or `job_finished` used to change what the next run is given and which skills are kept. Every
 * test runs the two redaction layers as `createApp` wires them (`twoLayerWiring()`): the run's redactor over the
 * secrets its agent lists, and the store wrapper over every stored secret.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { isJsonObject, type Json, type JsonObject } from "../../src/core/json.ts";
import type { Config } from "../../src/config/types.ts";
import { promotedWorkflowName } from "../../src/learning/promotion.ts";
import { SECTION_HEADING } from "../../src/learning/select.ts";
import {
  APPLIED_VALUE_FIELDS, CHECKED_VALUE_FIELDS, DRAFT_OUTPUT_FIELDS, GIVEN_VALUE_FIELDS, GRADES_OUTPUT_FIELDS, PICKED_VALUE_FIELDS,
  PROMOTION_VALUE_FIELDS, PROPOSAL_OUTPUT_FIELDS, PROVENANCE_VALUE_FIELDS,
} from "../../src/learning/value-fields.ts";
import type { ScriptedScript } from "../../src/models/types.ts";
import type { CommitBatch, JournalRecord } from "../../src/store/types.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import { twoLayerWiring, undeclaredPaths, wordSecrets } from "../helpers/two-layer.ts";
import { waitFor } from "../helpers/wait.ts";
import { itemFile, keepAll, learningHarness, type LearningHarness } from "../learning/support.ts";

const NOTE_BODY = "Run `make all` from the repository root; it takes two minutes.";
const NOTE = { path: "notes/build.md", content: itemFile("Build command", "How this project builds.", NOTE_BODY) };
const SKILL = { path: "skills/report.md", content: itemFile("Weekly report", "How to write the weekly report.", "1. Collect the numbers.\n2. Write the summary.") };

/** Secret names: one per value, in order; the even ones are handed to the run, the odd ones only stored. */
function secretTable(values: readonly string[]): { stored: Record<string, string>; handed: string[] } {
  const stored: Record<string, string> = {};
  const handed: string[] = [];
  values.forEach((value, index) => {
    const name = `WORD_${index}`;
    stored[name] = value;
    if (index % 2 === 0) handed.push(name);
  });
  return { stored, handed };
}

async function harness(
  t: TestContext, values: Readonly<Record<string, string>>, config?: Partial<Config["learning"]>, tools?: readonly ToolDefinition[],
): Promise<{ h: LearningHarness; batches: CommitBatch[] }> {
  const wiring = twoLayerWiring();
  const h = await learningHarness(t, {
    twoLayer: { wiring, values }, ...(config === undefined ? {} : { config }), ...(tools === undefined ? {} : { tools }),
  });
  return { h, batches: wiring.batches };
}

function stepValue(journal: readonly JournalRecord[], key: string): Json {
  const record = journal.find((r) => r.type === "step.finished" && r.key === key);
  assert.ok(record !== undefined, `${key} finished`);
  return record.data["value"] ?? null;
}

function modelOutput(journal: readonly JournalRecord[], key: string): Json {
  const record = journal.find((r) => r.type === "model.finished" && r.key === key);
  assert.ok(record !== undefined, `${key} finished`);
  return record.data["output"] ?? null;
}

function jobRequests(h: LearningHarness, runId: string): string[] {
  return h.requests.filter((r) => r.meta.runId === runId && r.meta.purpose === "run").map((r) => r.system);
}

/** Which of a test's two secrets the run is handed; the other one is only stored. */
const PLACEMENTS = [
  { label: "the first handed to the run, the second only stored", handedIndex: 0 },
  { label: "the second handed to the run, the first only stored", handedIndex: 1 },
] as const;

for (const placement of PLACEMENTS) {
  test(`secrets promptSection and tSection (${placement.label}): the next run is given the note, also after a crash`, async (t) => {
    const { h } = await harness(t, { PROMPT_WORD: "promptSection", PROMPT_TAIL: "tSection" });
    const agent = await h.agent({
      turns: [{ text: "done" }],
      variants: [{ when: { contains: "slowly", in: "messages" }, turns: [{ text: "done", delayMs: 700 }] }],
      steps: { "learning.propose": { output: { job_finished: true, files: [NOTE] } }, "learning.grade": keepAll([NOTE.path]) },
    }, { secrets: [placement.handedIndex === 0 ? "PROMPT_WORD" : "PROMPT_TAIL"] });

    const run1 = await h.start(agent.id, { message: "build the project" });
    await h.until(run1.id, "completed");
    assert.equal((await h.store.listLearningItems({ agentId: agent.id, status: "active" })).length, 1);

    const run2 = await h.start(agent.id, { message: "build it again" });
    await h.until(run2.id, "completed");
    const [first] = jobRequests(h, run2.id);
    assert.ok(first !== undefined, "run 2 asked its model");
    assert.ok(first.includes(SECTION_HEADING), "the section heading reaches run 2's model");
    assert.ok(first.includes(NOTE_BODY), "the note reaches run 2's model");
    const given = stepValue(await h.journal(run2.id), "learning/given");
    assert.ok(isJsonObject(given) && Object.hasOwn(given, "promptSection"), "the stored value keeps the key promptSection");
    assert.deepEqual(Object.keys(given).sort(), ["given", "promptSection", "tools"]);

    const run3 = await h.start(agent.id, { message: "build it slowly" });
    await waitFor(async () => {
      const journal = await h.journal(run3.id);
      return journal.some((r) => r.type === "step.finished" && r.key === "learning/given")
        && journal.some((r) => r.type === "model.started" && r.key === "t1");
    });
    await h.crashAndReplace();
    await h.until(run3.id, "completed", 8000);
    const requests = jobRequests(h, run3.id);
    assert.ok(requests.length >= 2, "the model call was made again after the crash");
    assert.ok(requests.every((system) => system.includes(NOTE_BODY)), "the replayed run is given the note too");
    const journal3 = await h.journal(run3.id);
    assert.equal(journal3.filter((r) => r.type === "step.finished" && r.key === "learning/given").length, 1);
  });
}

for (const placement of PLACEMENTS) {
  test(`secrets jobFinished and job_finished (${placement.label}): a finished run's skill is kept`, async (t) => {
    const { h } = await harness(t, { JOB_WORD: "jobFinished", JOB_KEY: "job_finished" });
    const agent = await h.agent({
      turns: [{ text: "report written" }],
      steps: { "learning.propose": { output: { job_finished: true, files: [SKILL] } }, "learning.grade": keepAll([SKILL.path]) },
    }, { secrets: [placement.handedIndex === 0 ? "JOB_WORD" : "JOB_KEY"] });
    const run = await h.start(agent.id, { message: "write the weekly report" });
    await h.until(run.id, "completed");
    const [skill] = await h.store.listLearningItems({ agentId: agent.id, kind: "skill" });
    assert.equal(skill?.status, "active", "the skill is kept");
    const journal = await h.journal(run.id);
    const checked = stepValue(journal, "learning/check");
    assert.ok(isJsonObject(checked) && checked["jobFinished"] === true);
    const proposal = modelOutput(journal, "learning/propose");
    assert.ok(isJsonObject(proposal) && proposal["job_finished"] === true);
    const grades = modelOutput(journal, "learning/grade");
    assert.ok(isJsonObject(grades) && grades["job_finished"] === true);
    const graded = (await h.records(run.id, "learning.graded"))[0];
    assert.deepEqual(graded?.decisions.map((d) => [d.path, d.verdict, d.by]), [[SKILL.path, "keep", "grader"]]);
  });
}

const ALL_SPECS = [
  GIVEN_VALUE_FIELDS, CHECKED_VALUE_FIELDS, PROVENANCE_VALUE_FIELDS, APPLIED_VALUE_FIELDS, PICKED_VALUE_FIELDS,
  PROMOTION_VALUE_FIELDS, PROPOSAL_OUTPUT_FIELDS, GRADES_OUTPUT_FIELDS, DRAFT_OUTPUT_FIELDS,
];
/** A proposed file's front matter has the line `description: …`: these values are secrets in every proposal. */
const IN_FRONT_MATTER = new Set(["description", "descript", "cription"]);
/** The workflow format tag of the draft holds `workflow`: with it as a secret the draft is not a workflow. */
const IN_DRAFT = new Set(["workflow"]);

const DRAFT: JsonObject = {
  format: "runwright.workflow/v1",
  name: "draft",
  schemas: { In: { type: "object" }, Out: { type: "object", required: ["summary"], properties: { summary: { type: "string" } } } },
  input: "In",
  output: "Out",
  root: { id: "main", kind: "sequence", steps: [{ id: "write", kind: "model", prompt: "Write the weekly report", output: "Out" }] },
  result: { $ref: "steps.write" },
};
const DECIDE_DRAFT: JsonObject = {
  ...DRAFT,
  root: {
    id: "main", kind: "sequence", steps: [
      { id: "ready", kind: "decide", question: "Are the numbers in?", decision: { type: "yes_no" } },
      { id: "write", kind: "model", prompt: "Write the weekly report", output: "Out" },
    ],
  },
};

/** Long enough that the note and the skill together are over the budget, so the note is given as a line. */
const LONG_BODY = Array.from({ length: 12 }, (_, i) => `Step ${i + 1}: run make all from the repository root and wait two minutes.`).join("\n");
const LONG_NOTE = { path: "notes/build.md", content: itemFile("Build command", "How this project builds.", LONG_BODY) };
const BAD = { path: "notes/Bad Name!.md", content: itemFile("Bad", "An invalid name.", "Never kept.") };
const SCENARIO_CONFIG = { budgetTokens: 120, promoteAfterRuns: 2 };

function scenarioScript(draft: Json): ScriptedScript {
  return {
    turns: [{ text: "report written; versions, problems, document and conflicts noted" }],
    steps: {
      "learning.propose": { output: { job_finished: true, files: [LONG_NOTE, SKILL, BAD] } },
      "learning.grade": keepAll([LONG_NOTE.path, SKILL.path, BAD.path]),
      "learning.promote": { output: { document: draft } },
    },
  };
}

/** The JSON shape of a value: its keys at every depth and the JSON type of every leaf. */
function shape(value: Json): Json {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.map((item) => shape(item ?? null));
  if (typeof value === "object") {
    const out: JsonObject = {};
    for (const key of Object.keys(value).sort()) out[key] = shape(value[key] ?? null);
    return out;
  }
  return typeof value;
}

/** Strips the item-id part of a promoted workflow's name (ids differ between harnesses). */
const workflowStem = (name: string | null): string | null => (name === null ? null : name.replace(/-[a-z0-9]+$/, ""));

interface ScenarioResult { decisions: Json; journalText: string; batches: CommitBatch[] }

/**
 * Run 1 learns a note and a skill (a third entry is dropped by its own check); runs 2.. are given them under a
 * budget that puts the note on one line; with promotion, run 4 drafts the skill as a workflow and keeps it.
 * Returns every decision learning made, by run, without ids, timestamps or free text.
 */
async function scenario(t: TestContext, values: readonly string[], runs: number, draft: Json = DRAFT): Promise<ScenarioResult> {
  const table = secretTable(values);
  const { h, batches } = await harness(t, table.stored, { ...SCENARIO_CONFIG, promoteAfterRuns: runs >= 4 ? 2 : 100 });
  const agent = await h.agent(scenarioScript(draft), { secrets: table.handed });
  const perRun: Json[] = [];
  let journalText = "";
  for (let i = 0; i < runs; i++) {
    const run = await h.start(agent.id, { message: "write the weekly report" });
    await h.until(run.id, "completed", 8000);
    const journal = await h.journal(run.id);
    journalText += JSON.stringify(journal.map((r) => r.data));
    const learningValues = journal.filter((r) => r.key !== null && r.key.startsWith("learning/")
      && (r.type === "step.finished" || r.type === "model.finished"));
    const checked = (await h.records(run.id, "learning.checked"))[0];
    const applied = (await h.records(run.id, "learning.applied"))[0];
    const provenance = stepValue(journal, "learning/provenance");
    const skill = (await h.store.listLearningItems({ agentId: agent.id, kind: "skill" }))[0];
    perRun.push({
      given: (await h.records(run.id, "learning.given")).flatMap((g) => g.items.map((item) => [item.kind, item.name, item.version, item.mode])),
      dropAll: checked?.dropAll !== null,
      dropped: checked?.dropped.map((d) => d.path) ?? [],
      surviving: checked?.surviving ?? [],
      provenance: Array.isArray(provenance) ? provenance.filter(isJsonObject).map((p) => [p["path"] ?? null, p["verdict"] ?? null, p["field"] ?? null]) : null,
      graded: (await h.records(run.id, "learning.graded")).flatMap((g) => g.decisions.map((d) => [d.path, d.verdict, d.by])),
      applied: applied === undefined ? null : {
        kept: applied.kept.map((k) => [k.path, k.version]), held: applied.held.map((k) => [k.path, k.version]),
        conflicts: (applied.conflicts ?? []).map((c) => c.path),
      },
      promotion: (await h.records(run.id, "learning.promotion")).map((p) => {
        if (p.workflow !== null) assert.equal(p.workflow, promotedWorkflowName(skill ?? { id: "", name: "" }), "the workflow is the skill's own");
        return [p.outcome, workflowStem(p.workflow)];
      }),
      shapes: learningValues.map((r) => [r.key, r.type, shape((r.type === "step.finished" ? r.data["value"] : r.data["output"]) ?? null)]),
    });
  }
  const items = (await h.store.listLearningItems({ agentId: agent.id }))
    .map((item) => [item.kind, item.name, item.status, item.version, workflowStem(item.promotedWorkflow)])
    .sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  return { decisions: { items, perRun }, journalText, batches };
}

const GENERATED = wordSecrets(...ALL_SPECS).filter((value) => !IN_FRONT_MATTER.has(value));

test("the class, generated: every name of the nine specifications as a secret changes no decision of learning or promotion", async (t) => {
  const values = GENERATED.filter((value) => !IN_DRAFT.has(value));
  assert.ok(values.length >= 30, `the generated set has ${values.length} values`);
  const plain = await scenario(t, [], 4);
  const perRun = (plain.decisions as { perRun: JsonObject[] }).perRun;
  assert.deepEqual(perRun[1]?.["given"], [["skill", "report", 1, "full"], ["note", "build", 1, "line"]], "run 2: one item in full, one as a line");
  assert.deepEqual(perRun[0]?.["dropped"], [BAD.path], "run 1: one entry dropped by its own check");
  assert.deepEqual(perRun[3]?.["promotion"], [["kept", "skill-report"]], "run 4 promotes the skill");

  const secret = await scenario(t, values, 4);
  assert.match(secret.journalText, /\[redacted:WORD_\d+\]/, "handed secrets were redacted by the run");
  assert.match(secret.journalText, /\[redacted\]/, "stored secrets were redacted by the store wrapper");
  assert.deepEqual(secret.decisions, plain.decisions);
});

test("the class, generated, without promotion: workflow-format words as secrets change nothing either", async (t) => {
  const plain = await scenario(t, [], 2);
  const secret = await scenario(t, GENERATED, 2);
  assert.match(secret.journalText, /\[redacted:WORD_\d+\]/);
  assert.deepEqual(secret.decisions, plain.decisions);
});

test("a draft is model text: with the handed secret decision a decide node, with workflow the format tag, rejects it", async (t) => {
  const promotionOf = async (values: Record<string, string>, handed: string[], draft: Json): Promise<{ outcome: Json; value: Json; status: string | undefined }> => {
    const { h } = await harness(t, values, SCENARIO_CONFIG);
    const agent = await h.agent(scenarioScript(draft), { secrets: handed });
    let last = "";
    for (let i = 0; i < 4; i++) {
      const run = await h.start(agent.id, { message: "write the weekly report" });
      await h.until(run.id, "completed", 8000);
      last = run.id;
    }
    const promotion = (await h.records(last, "learning.promotion"))[0];
    const skill = (await h.store.listLearningItems({ agentId: agent.id, kind: "skill" }))[0];
    return { outcome: promotion?.outcome ?? null, value: stepValue(await h.journal(last), "learning/promote/apply"), status: skill?.status };
  };
  assert.equal((await promotionOf({}, [], DECIDE_DRAFT)).outcome, "kept", "without a secret the decide draft is kept");
  for (const [word, draft] of [["decision", DECIDE_DRAFT], ["workflow", DRAFT]] as const) {
    const got = await promotionOf({ FORMAT_WORD: word }, ["FORMAT_WORD"], draft);
    assert.equal(got.outcome, "rejected", `${word}: the draft is rejected`);
    assert.equal(got.status, "active", `${word}: the skill stays active`);
    assert.ok(isJsonObject(got.value));
    assert.deepEqual(Object.keys(got.value).sort(), ["outcome", "problems", "workflow"], `${word}: the stored value keeps its field names`);
    assert.ok(Array.isArray(got.value["problems"]) && got.value["problems"].length > 0);
  }
});

for (const word of IN_FRONT_MATTER) {
  test(`a proposal is model text: the handed secret ${word} drops it whole; stored only, its marker drops it whole too`, async (t) => {
    const outcome = async (handed: boolean): Promise<{ dropAll: string | null; dropped: string[]; items: number; status: string }> => {
      const { h } = await harness(t, { FRONT_WORD: word });
      const agent = await h.agent({
        turns: [{ text: "done" }],
        steps: { "learning.propose": { output: { job_finished: true, files: [NOTE, SKILL] } }, "learning.grade": keepAll([NOTE.path, SKILL.path]) },
      }, { secrets: handed ? ["FRONT_WORD"] : [] });
      const run = await h.start(agent.id);
      const done = await h.until(run.id, ["completed", "failed"]);
      const checked = (await h.records(run.id, "learning.checked"))[0];
      return {
        dropAll: checked?.dropAll ?? null, dropped: checked?.dropped.map((d) => `${d.path}: ${d.reason}`) ?? [],
        items: (await h.store.listLearningItems({ agentId: agent.id })).length, status: done.status,
      };
    };
    const handed = await outcome(true);
    assert.equal(handed.status, "completed");
    assert.match(handed.dropAll ?? "", /handed secret FRONT_WORD/);
    assert.equal(handed.items, 0);

    // Not handed, the stored value is still replaced by the process-wide `[redacted]` before the check sees the
    // proposal, and that marker is itself a secret finding (R14D-spec-02): the whole proposal is dropped.
    const stored = await outcome(false);
    assert.equal(stored.status, "completed");
    assert.equal(stored.dropAll, "a redacted secret was found in files[0].content");
    assert.deepEqual(stored.dropped, []);
    assert.equal(stored.items, 0);
  });
}

test("text inside is still redacted: a handed secret in a body drops the proposal; a stored one in a title drops it as a marker", async (t) => {
  const BODY_WORD = "zebra-quartz-7731";
  const TITLE_WORD = "Saffron";
  const TITLE_SECRET = "SaffronLedger";
  const { h } = await harness(t, { BODY_SECRET: BODY_WORD, TITLE_SECRET });
  const inBody = { path: "notes/body.md", content: itemFile("Body", "A body with a secret.", `Use ${BODY_WORD} here.`) };
  const handedAgent = await h.agent({
    turns: [{ text: "done" }],
    steps: { "learning.propose": { output: { job_finished: true, files: [NOTE, inBody] } }, "learning.grade": keepAll([NOTE.path, inBody.path]) },
  }, { secrets: ["BODY_SECRET"] });
  const run1 = await h.start(handedAgent.id);
  await h.until(run1.id, "completed");
  const checked1 = (await h.records(run1.id, "learning.checked"))[0];
  assert.match(checked1?.dropAll ?? "", /handed secret BODY_SECRET/);
  assert.equal((await h.store.listLearningItems({ agentId: handedAgent.id })).length, 0);

  const inTitle = { path: "notes/ledger.md", content: itemFile(`${TITLE_SECRET} totals`, `Where the ${TITLE_WORD} totals are.`, "In the shared sheet.") };
  const storedAgent = await h.agent({
    turns: [{ text: "done" }],
    steps: { "learning.propose": { output: { job_finished: true, files: [inTitle] } }, "learning.grade": keepAll([inTitle.path]) },
  });
  const run2 = await h.start(storedAgent.id);
  await h.until(run2.id, "completed");
  const proposed = (await h.journal(run2.id)).find((r) => r.type === "model.finished" && r.key === "learning/propose");
  const files = (proposed?.data["output"] as { files?: { content?: string }[] } | undefined)?.files;
  assert.ok(files?.[0]?.content?.includes("title: [redacted] totals"), "the stored proposal holds the placeholder");
  assert.ok(files?.[0]?.content?.includes(`Where the ${TITLE_WORD} totals are.`), "a word that only starts a secret is kept");
  const checked2 = stepValue(await h.journal(run2.id), "learning/check");
  assert.ok(isJsonObject(checked2));
  assert.equal(checked2["dropAll"], "a redacted secret was found in files[0].content");
  assert.deepEqual(checked2["items"], []);
  assert.ok(!JSON.stringify(await h.journal(run2.id)).includes(TITLE_SECRET));
  assert.deepEqual(await h.store.listLearningItems({ agentId: storedAgent.id }), [], "nothing is kept");
});

test("host values are not affected: a host tool's memoised value without a specification is a payload, keys included", async (t) => {
  const memoTool: ToolDefinition = {
    name: "host_memo", description: "Memoises a host value.", parameters: { type: "object" }, effect: "write", resumable: true,
    async handler(_args, context) {
      const value = await context.steps.memo("host/value", { recordType: "step", name: "host.value" }, async () => ({ promptSection: "x", jobFinished: true }));
      return { content: JSON.stringify(value) };
    },
  };
  const { h } = await harness(t, { PROMPT_WORD: "promptSection", JOB_WORD: "jobFinished" }, undefined, [memoTool]);
  for (const handed of [["PROMPT_WORD"], ["JOB_WORD"]]) {
    const agent = await h.saveAgent({
      tools: [{ name: "host_memo", policy: "allow" }], secrets: handed,
      model: { provider: "scripted", name: "scripted-1", script: { turns: [{ toolCalls: [{ name: "host_memo", args: {} }] }, { text: "done" }] } },
    });
    const run = await h.start(agent.id);
    await h.until(run.id, "completed");
    const record = (await h.journal(run.id)).find((r) => r.type === "step.finished" && r.data["name"] === "host.value");
    assert.ok(record !== undefined, "the host step finished");
    const value = record.data["value"];
    assert.ok(isJsonObject(value));
    const keys = Object.keys(value);
    assert.ok(!keys.includes("promptSection") && !keys.includes("jobFinished"), `both keys are placeholders: ${keys.join(", ")}`);
    assert.equal(keys.length, 2);
    for (const key of keys) assert.match(key, /^\[redacted(:[A-Z_]+)?\]$/);
  }
});

test("completeness: every field the six steps and the three structured outputs write is named by its specification", async (t) => {
  const plain = await scenario(t, [], 4);
  const learningBatches = plain.batches.map((batch) => ({
    ...batch, records: batch.records.filter((r) => r.key !== undefined && r.key.startsWith("learning/")),
  }));
  const declared = learningBatches.flatMap((b) => b.records).filter((r) => r.fields !== undefined).map((r) => `${r.type} ${r.key ?? ""}`);
  for (const expected of [
    "step.finished learning/given", "step.finished learning/check", "step.finished learning/provenance", "step.finished learning/apply",
    "step.finished learning/promote/pick", "step.finished learning/promote/apply",
    "model.finished learning/propose", "model.finished learning/grade", "model.finished learning/promote/draft",
  ]) {
    assert.ok(declared.includes(expected), `${expected} carries its specification`);
  }
  assert.deepEqual(undeclaredPaths(learningBatches), []);
  assert.deepEqual(undeclaredPaths(plain.batches), [], "and so is every other record of the scenario");
});
