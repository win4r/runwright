/**
 * Learning wired through `createApp` and the HTTP API: the configured grader model judges proposals (the agent's
 * own script has no grading step, so without that wiring nothing would be kept), the next run is given the kept
 * skill, and after `learning.promoteAfterRuns` served runs the skill is promoted to a saved, validated workflow.
 * Same-named skills of two agents get two workflows, each pointer names its version, and the API cannot write
 * under a promoted name (finding R02-05). A proposal quoting a stored secret the agent was not handed, which the
 * check sees only as the generic marker `[redacted]`, is dropped whole (finding R14D-spec-02).
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { RunwrightClient } from "../../src/client/index.ts";
import { RunwrightError } from "../../src/core/errors.ts";
import { secretForms } from "../../src/core/redact.ts";
import type { Json } from "../../src/core/json.ts";
import { promotedWorkflowName } from "../../src/learning/promotion.ts";
import type { ScriptedScript } from "../../src/models/types.ts";
import type { LearningItem } from "../../src/store/types.ts";
import { startTestApp } from "../fixtures/app.ts";
import { scriptedAgent, waitForStatus } from "../fixtures/runs.ts";

const SKILL_PATH = "skills/weekly-report.md";
const SKILL = {
  path: SKILL_PATH,
  content: "---\ntitle: Weekly report\ndescription: How to write the weekly report.\n---\n1. Collect the numbers.\n2. Write the summary.",
};
const DRAFT = {
  format: "runwright.workflow/v1",
  name: "draft",
  schemas: {
    In: { type: "object" },
    Out: { type: "object", required: ["summary"], properties: { summary: { type: "string" } } },
  },
  input: "In",
  output: "Out",
  root: { id: "main", kind: "sequence", steps: [{ id: "write", kind: "model", prompt: "Write the weekly report", output: "Out" }] },
  result: { $ref: "steps.write" },
};

const AGENT_SCRIPT: ScriptedScript = {
  turns: [{ text: "report written" }],
  steps: {
    "learning.propose": { output: { job_finished: true, files: [SKILL] } },
    "learning.promote": { output: { document: DRAFT } },
  },
};
const GRADER_SCRIPT: ScriptedScript = {
  turns: [],
  steps: { "learning.grade": { output: { job_finished: true, decisions: [{ path: SKILL_PATH, verdict: "keep", reason: "reusable" }] } } },
};

test("through createApp the grader model keeps a skill, the next run gets it and it is promoted to a workflow", { timeout: 30_000 }, async (t) => {
  const { client } = await startTestApp(t, {
    configure: (config) => {
      config.learning.promoteAfterRuns = 1;
      config.learning.graderModel = { provider: "scripted", name: "scripted-1", script: GRADER_SCRIPT };
    },
  });
  const definition = scriptedAgent({ name: "Reporter", script: AGENT_SCRIPT, learning: true });
  const { agent } = await client.saveAgent(definition, "reporter");

  const runIds: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    const { run } = await client.startRun({ agentId: agent.id, message: "write this week's report" });
    const { run: done } = await waitForStatus(client, run.id, ["completed", "failed"]);
    assert.equal(done.status, "completed");
    runIds.push(run.id);
  }

  const [skill] = await client.listLearning({ agentId: agent.id, kind: "skill" });
  assert.equal(skill?.name, "weekly-report");
  assert.equal(skill?.status, "active", "kept by the configured grader model");
  const graderCall = (await client.timeline(runIds[0] as string, { limit: 1000 })).records
    .find((record) => record.type === "model.started" && (record.data as { step?: string }).step === "learning.grade");
  assert.equal((graderCall?.data as { purpose?: string } | undefined)?.purpose, "grader");

  const uses = await client.runLearning(runIds[1] as string);
  assert.deepEqual(uses.map((use) => [use.itemId, use.mode]), [[skill?.id, "full"]], "run 2 is given the skill");

  assert.ok(skill !== undefined);
  const name = promotedWorkflowName(skill);
  assert.equal(skill.promotedWorkflow, name);
  assert.equal(skill.promotedWorkflowVersion, 1);
  const saved = await client.getWorkflow(name, 1);
  assert.equal(saved.name, name);
  assert.equal(saved.source, "promotion");
  assert.equal(saved.skillItemId, skill?.id);
  assert.deepEqual((await client.validateWorkflow(saved.document as unknown as Json)).problems, []);
});

async function runUntilPromoted(client: RunwrightClient, agentId: string): Promise<LearningItem> {
  for (let i = 0; i < 6; i += 1) {
    const { run } = await client.startRun({ agentId, message: "write this week's report" });
    const { run: done } = await waitForStatus(client, run.id, ["completed", "failed"]);
    assert.equal(done.status, "completed");
    const [skill] = await client.listLearning({ agentId, kind: "skill" });
    if (skill?.promotedWorkflow !== null && skill?.promotedWorkflow !== undefined) return skill;
  }
  throw new Error(`the skill of ${agentId} was never promoted`);
}

test("two agents' same-named skills are promoted to two workflows, each pinned by version and owned by its skill", { timeout: 60_000 }, async (t) => {
  const { client } = await startTestApp(t, {
    configure: (config) => {
      config.learning.promoteAfterRuns = 1;
      config.learning.graderModel = { provider: "scripted", name: "scripted-1", script: GRADER_SCRIPT };
    },
  });
  const first = (await client.saveAgent(scriptedAgent({ name: "Reporter A", script: AGENT_SCRIPT, learning: true }), "reporter-a")).agent;
  const second = (await client.saveAgent(scriptedAgent({ name: "Reporter B", script: AGENT_SCRIPT, learning: true }), "reporter-b")).agent;
  const skills = [await runUntilPromoted(client, first.id), await runUntilPromoted(client, second.id)];
  assert.deepEqual(skills.map((skill) => skill.name), ["weekly-report", "weekly-report"]);

  const names = skills.map((skill) => skill.promotedWorkflow as string);
  assert.notEqual(names[0], names[1]);
  assert.deepEqual(names, skills.map((skill) => promotedWorkflowName(skill)));
  const listed = (await client.listWorkflows()).filter((w) => w.source === "promotion").map((w) => w.name).sort();
  assert.deepEqual(listed, [...names].sort());

  for (const skill of skills) {
    assert.equal(typeof skill.promotedWorkflowVersion, "number");
    const saved = await client.getWorkflow(skill.promotedWorkflow as string, skill.promotedWorkflowVersion as number);
    assert.equal(saved.name, skill.promotedWorkflow);
    assert.equal(saved.version, skill.promotedWorkflowVersion);
    assert.equal(saved.skillItemId, skill.id, "each pointer fetches its own skill's document");

    const refused = await client.saveWorkflow(skill.promotedWorkflow as string, saved.document as unknown as Json).then(
      () => null, (error: unknown) => error,
    );
    assert.ok(refused instanceof RunwrightError, "a PUT on a promoted name is refused");
    assert.equal(refused.code, "conflict");
    assert.equal(refused.details?.["reason"], "promoted_workflow");
    assert.equal(refused.details?.["skillItemId"], skill.id);
    const unchanged = await client.getWorkflow(skill.promotedWorkflow as string);
    assert.equal(unchanged.version, skill.promotedWorkflowVersion, "nothing was saved");
  }
});

test("a proposal quoting a stored secret the agent was not handed, already [redacted], is dropped whole and the secret is nowhere stored", { timeout: 30_000 }, async (t) => {
  const { app, client, logLines } = await startTestApp(t);
  const value = `other-agents-key-${randomBytes(8).toString("hex")}`;
  await client.setSecret("OTHER_AGENT_KEY", value);
  // The learning turn quotes the run's account (its first message, which held the value) in one of two notes.
  const quoting = { path: "notes/login.md", content: "---\ntitle: Login\ndescription: How the run logged in.\n---\nWhat was asked: {{first_message}}" };
  const harmless = { path: "notes/sky.md", content: "---\ntitle: Sky\ndescription: A harmless fact.\n---\nThe sky is blue today." };
  const { agent } = await client.saveAgent(scriptedAgent({
    name: "Quoting learner", learning: true,
    script: {
      turns: [{ text: "logged in" }],
      steps: {
        "learning.propose": { output: { job_finished: true, files: [quoting, harmless] } },
        "learning.grade": { output: { job_finished: true, decisions: [quoting.path, harmless.path].map((path) => ({ path, verdict: "keep", reason: "useful" })) } },
      },
    },
  }), "quoting-learner");
  const { run } = await client.startRun({ agentId: agent.id, message: `log in with ${value}` });
  const { run: done } = await waitForStatus(client, run.id, ["completed", "failed", "waiting"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));

  const records = (await client.timeline(run.id, { limit: 1000 })).records;
  const proposed = records.find((r) => r.type === "model.finished" && r.key === "learning/propose");
  assert.ok(JSON.stringify(proposed?.data).includes("[redacted]"), "the proposal the check saw held the generic marker");
  const checked = records.find((r) => r.type === "learning.checked");
  assert.equal(checked?.data["dropAll"], "a redacted secret was found in files[0].content");
  assert.deepEqual(checked?.data["surviving"], []);
  assert.equal(records.some((r) => r.type === "learning.graded" || r.type === "learning.applied"), false, "nothing is graded or applied");
  assert.deepEqual(await client.listLearning({ agentId: agent.id }), [], "nothing is kept, the harmless note included");

  const forms = secretForms(value);
  const dbPath = join(app.config.dataDir, "runwright.db");
  for (const suffix of ["", "-wal"]) {
    let bytes: Buffer;
    try {
      bytes = await readFile(dbPath + suffix);
    } catch {
      continue;
    }
    for (const form of forms) assert.equal(bytes.includes(Buffer.from(form, "utf8")), false, `runwright.db${suffix} holds the secret`);
  }
  for (const form of forms) assert.equal(logLines.join("\n").includes(form), false, "a log line holds the secret");
});
