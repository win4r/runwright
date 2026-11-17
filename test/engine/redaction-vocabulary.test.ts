/**
 * Finding R11-02 through the engine: a run handed secrets whose values are Runwright's own words (`toolCalls`,
 * `stopReason`, `tool_use`, `approval`, `decision`) and a numeric secret still calls its tool, asks for and gets
 * its approval, and completes, before and after a crash; every record it writes is named by RECORD_FIELDS, the
 * engine's words are stored as written and the digits are in no database cell. The two layers are wired as the
 * app wires them: the run's redactor in the session, then a store wrapper over a real secrets service.
 * Also: the documented limit for a secret equal to a tool's name, and a promoted workflow draft that held a handed
 * secret (journalled with the placeholder, then rejected: a redaction marker in a draft is the trace of a secret).
 */
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { Json, JsonObject } from "../../src/core/json.ts";
import type { ModelRequest } from "../../src/models/types.ts";
import { checkDraft } from "../../src/learning/promotion.ts";
import { generateSealKey } from "../../src/security/seal.ts";
import { createSecretsService } from "../../src/security/secrets.ts";
import type { SecretsService } from "../../src/security/types.ts";
import { createWriteRedaction, type WriteRedaction } from "../../src/security/write-redaction.ts";
import { isEngineRecordType, RECORD_FIELDS, unlistedPaths } from "../../src/store/record-fields.ts";
import type { JournalRecord } from "../../src/store/types.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import { createHarness, fakeModels, reply, storeWith, type Harness } from "../helpers/engine.ts";
import { scanDatabase } from "../security/at-rest.ts";
import { waitFor } from "../helpers/wait.ts";
import { itemFile, keepAll, learningHarness } from "../learning/support.ts";

const DIGITS = "12345678";
const PIN = 12345678;
const WORDS: Record<string, string> = {
  W_TOOLCALLS: "toolCalls", W_STOPREASON: "stopReason", W_TOOL_USE: "tool_use", W_APPROVAL: "approval", W_DECISION: "decision",
  PIN: DIGITS,
};

interface Wired { h: Harness; secrets: SecretsService }

/**
 * A harness whose runners reveal secrets through a real secrets service and whose store commits through the
 * write-redaction layer over that service, as `createApp` wires them. The runner starts once the secrets are set.
 */
async function wired(t: TestContext, options: { models: ReturnType<typeof fakeModels>; tools: ToolDefinition[]; values: Record<string, string> }): Promise<Wired> {
  let layer: WriteRedaction | null = null;
  let service: SecretsService | null = null;
  const h = await createHarness(t, {
    models: options.models, tools: options.tools, autoStart: false,
    secretsReader: { reveal: (names) => (service as SecretsService).reveal(names) },
    wrapStore: (store) => storeWith(store, { commit: (lease, batch) => store.commit(lease, (layer as WriteRedaction).batch(batch)) }),
  });
  service = await createSecretsService({ store: h.store, sealKey: generateSealKey() });
  for (const [name, value] of Object.entries(options.values)) await service.set(name, value);
  layer = createWriteRedaction(service);
  h.runner.start();
  return { h, secrets: service };
}

const executed: Json[] = [];
const storePin: ToolDefinition = {
  name: "store_pin", description: "Stores a pin.", effect: "write",
  parameters: { type: "object", properties: { pin: {} }, required: ["pin"] },
  handler: async (args) => {
    executed.push(args["pin"] ?? null);
    return { content: "stored" };
  },
};

const pinModels = (): ReturnType<typeof fakeModels> => fakeModels((request: ModelRequest) => (request.meta.turn === 1
  ? reply({ toolCalls: [{ id: "c1", name: "store_pin", args: { pin: PIN } }] })
  : reply({ text: "done" })));

async function pinRun(t: TestContext): Promise<{ h: Harness; runId: string; agentSecrets: string[] }> {
  const { h } = await wired(t, { models: pinModels(), tools: [storePin], values: WORDS });
  const agent = await h.saveAgent({ secrets: Object.keys(WORDS), tools: [{ name: "store_pin", policy: "ask" }] });
  const run = await h.start(agent.id);
  return { h, runId: run.id, agentSecrets: Object.keys(WORDS) };
}

async function approveAndFinish(h: Harness, runId: string): Promise<void> {
  const approval = await waitFor(async () => (await h.pendings(runId)).find((p) => p.kind === "approval") ?? null, {
    timeoutMs: 5000, intervalMs: 10, message: "the approval never opened",
  });
  await h.send(runId, { type: "approve", pendingId: approval.id, always: false });
  await h.until(runId, "completed");
}

function assertJournal(journal: JournalRecord[]): void {
  const unnamed = journal.filter((r) => isEngineRecordType(r.type))
    .flatMap((r) => unlistedPaths(r.data, RECORD_FIELDS[r.type] as never).map((path) => `${r.type} ${path}`));
  assert.deepEqual(unnamed, [], "every engine record is named by RECORD_FIELDS");
  assert.deepEqual(journal.filter((r) => !isEngineRecordType(r.type)).map((r) => r.type), []);
  const finished = journal.filter((r) => r.type === "model.finished").map((r) => r.data);
  assert.equal(finished[0]?.["stopReason"], "tool_use");
  assert.deepEqual(finished[0]?.["toolCalls"], [{ id: "c1", name: "store_pin", args: { pin: "[redacted:PIN]" } }]);
  const opened = journal.find((r) => r.type === "pending.opened")?.data["pending"] as JsonObject;
  assert.equal(opened["kind"], "approval");
  const resolved = journal.find((r) => r.type === "pending.resolved")?.data as JsonObject;
  assert.equal(resolved["kind"], "approval");
  assert.deepEqual(resolved["resolution"], { decision: "approve", always: false, reason: null });
  const tool = journal.filter((r) => r.type === "tool.finished").map((r) => [r.data["tool"], r.data["outcome"]]);
  assert.deepEqual(tool, [["store_pin", "ok"]]);
}

test("secrets equal to the engine's own words: the tool is called, approved and run once, and the run completes", async (t) => {
  executed.length = 0;
  const { h, runId } = await pinRun(t);
  await approveAndFinish(h, runId);
  assert.deepEqual(executed, ["[redacted:PIN]"], "the tool ran once, on the stored placeholder");
  const journal = await h.journal(runId);
  assertJournal(journal);
  assert.deepEqual(scanDatabase(join(h.dir, "runwright.db"), DIGITS), [], "no cell holds a form of the digits");
});

test("the same run interrupted while its approval is open and resumed by another runner completes with one execution", async (t) => {
  executed.length = 0;
  const { h, runId } = await pinRun(t);
  await waitFor(async () => (await h.pendings(runId)).some((p) => p.kind === "approval"), { timeoutMs: 5000, intervalMs: 10 });
  await h.crashAndReplace();
  await approveAndFinish(h, runId);
  assert.deepEqual(executed, ["[redacted:PIN]"], "executed exactly once");
  const journal = await h.journal(runId);
  assertJournal(journal);
  assert.ok(journal.filter((r) => r.type === "run.claimed").length >= 2, "a second runner claimed the run");
  assert.deepEqual(scanDatabase(join(h.dir, "runwright.db"), DIGITS), []);
});

test("the documented limit: a secret equal to a tool's name is journalled as the placeholder and answered as an unknown tool", async (t) => {
  let ran = 0;
  const lookup: ToolDefinition = {
    name: "lookup_records", description: "Looks records up.", parameters: { type: "object", properties: {} }, effect: "read",
    handler: async () => {
      ran++;
      return { content: "found" };
    },
  };
  const models = fakeModels((request: ModelRequest) => (request.meta.turn === 1
    ? reply({ toolCalls: [{ id: "c1", name: "lookup_records", args: {} }] })
    : reply({ text: "finished" })));
  const { h } = await wired(t, { models, tools: [lookup], values: { TOOL_NAME: "lookup_records" } });
  const agent = await h.saveAgent({ secrets: ["TOOL_NAME"], tools: [{ name: "lookup_records" }] });
  const run = await h.start(agent.id);
  const done = await h.until(run.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(ran, 0);
  const [finished] = await h.records(run.id, "model.finished");
  assert.equal(finished?.toolCalls[0]?.name, "[redacted:TOOL_NAME]");
  const [result] = await h.records(run.id, "tool.finished");
  assert.equal(result?.outcome, "unknown_tool");
  assert.equal(result?.tool, "[redacted:TOOL_NAME]");
  assert.deepEqual(scanDatabase(join(h.dir, "runwright.db"), "lookup_records", ["agents", "agent_revisions"]), []);
});

// ---------------------------------------------------------------- the promoted workflow document

const HANDED = "handed-REPORT-key-77";
const SKILL = { path: "skills/report.md", content: itemFile("Weekly report", "How to write the weekly report.", "1. Collect the numbers.\n2. Write the summary.") };
const DRAFT = {
  format: "runwright.workflow/v1", name: "draft",
  schemas: { In: { type: "object" }, Out: { type: "object", required: ["summary"], properties: { summary: { type: "string" } } } },
  input: "In", output: "Out",
  root: { id: "main", kind: "sequence", steps: [{ id: "write", kind: "model", prompt: `Write the weekly report for ${HANDED}`, output: "Out" }] },
  result: { $ref: "steps.write" },
};

test("a promoted draft holding a handed secret is journalled with the placeholder and rejected, exactly as checkDraft judges it", async (t) => {
  const h = await learningHarness(t, { config: { promoteAfterRuns: 2 }, secrets: { REPORT_KEY: HANDED } });
  const agent = await h.agent({
    turns: [{ text: "report written" }],
    steps: {
      "learning.propose": { output: { job_finished: true, files: [SKILL] } },
      "learning.grade": keepAll([SKILL.path]),
      "learning.promote": { output: { document: DRAFT } },
    },
  }, { secrets: ["REPORT_KEY"] });
  let attempted: string | null = null;
  for (let i = 0; i < 6 && attempted === null; i++) {
    const run = await h.start(agent.id, { message: "write this week's report" });
    await h.until(run.id, "completed");
    const [promotion] = await h.records(run.id, "learning.promotion");
    if (promotion !== undefined) {
      // A redaction marker in the stored draft is the trace of a secret: the draft is not kept (R14D-spec-02).
      assert.equal(promotion.outcome, "rejected");
      assert.equal(promotion.workflow, null);
      assert.ok(promotion.problems.some((p) => /^\$\.document\.root\.steps\[0\]\.prompt: .*handed secret REPORT_KEY/.test(p)), JSON.stringify(promotion.problems));
      attempted = run.id;
    }
  }
  assert.ok(attempted !== null, "a run tried to promote the skill");
  const [item] = await h.store.listLearningItems({ agentId: agent.id, kind: "skill" });
  assert.equal(item?.promotedWorkflow, null, "no workflow was saved from the draft");
  const journal = await h.journal(attempted);
  const draft = journal.find((r) => r.type === "model.finished" && r.key === "learning/promote/draft");
  assert.ok(draft !== undefined, "the draft's model step is journalled");
  const unnamed = journal.filter((r) => isEngineRecordType(r.type))
    .flatMap((r) => unlistedPaths(r.data, RECORD_FIELDS[r.type] as never).map((path) => `${r.type} ${path}`));
  assert.deepEqual(unnamed, [], "the promotion run's records (learning.promotion included) are named by RECORD_FIELDS");
  const steps = ((draft.data["output"] as JsonObject)["document"] as unknown as { root: { steps: { prompt: string }[] } }).root.steps;
  assert.equal(steps[0]?.prompt, "Write the weekly report for [redacted:REPORT_KEY]", "the draft is stored with the placeholder");
  const check = checkDraft(draft.data["output"] as Json, { name: "draft", tools: [], resolveWorkflow: () => null });
  assert.equal(check.ok, false);
  assert.ok(!JSON.stringify(journal).includes(HANDED), "the secret value is in no record of the run");
});
