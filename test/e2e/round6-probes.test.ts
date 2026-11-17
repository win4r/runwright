/**
 * Structured outputs of any JSON type and dry runs over made-up values, end to end through `createApp`.
 *
 * Finding R05-01 (invariants O1, O2): a workflow's model step whose output schema is an array, a string or
 * `null`-able runs on an OpenAI-compatible model served by a fake endpoint (no network). The schema is sent
 * wrapped as `{value: S}`, the wrapped and the bare answer both give the value, and a text reply with no output
 * is an invalid reply that gets the one repair call instead of being read as `null`. A `decide` node (an object
 * schema with its own `value` property) is sent and read as before.
 *
 * Finding R05-02 (invariants G1, D1): the reviewer's document (a model output `code` with a pattern and a
 * length) dry-runs ok through the API and the CLI; a look-ahead pattern no placeholder can be made for is a
 * `placeholder_dependent` warning, not an error; a `minLength` of a billion answers promptly; and a learned skill
 * whose drafted workflow is the reviewer's document is promoted and can be run with `run_workflow`.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { AgentDefinition } from "../../src/agents/definition.ts";
import { main } from "../../src/cli/main.ts";
import type { Json, JsonObject } from "../../src/core/json.ts";
import type { JsonSchema } from "../../src/schema/validate.ts";
import { promotedWorkflowName } from "../../src/learning/promotion.ts";
import type { ScriptedScript } from "../../src/models/types.ts";
import type { JournalRecord, LearningItem } from "../../src/store/types.ts";
import type { WorkflowDocument, WorkflowNode } from "../../src/workflow/types.ts";
import { startTestApp, type TestApp } from "../fixtures/app.ts";
import { fakeOpenAi, forcedFunction, type FakeOpenAi, type FakeOpenAiReply, type FakeOpenAiRequest } from "../fixtures/fake-openai.ts";
import { fullTimeline, scriptedAgent, waitForStatus } from "../fixtures/runs.ts";

const INTEGERS: JsonSchema = { type: "array", items: { type: "integer" } };
const CODE: JsonSchema = { type: "string", pattern: "^[A-Z]{2}$", minLength: 2, maxLength: 2 };
const LOOKAHEAD: JsonSchema = { type: "string", pattern: "^(?=[A-Z]{2}$)[A-Z]+$" };

function modelWorkflow(out: JsonSchema): WorkflowDocument {
  return {
    format: "runwright.workflow/v1", name: "numbers", input: "In", output: "Out",
    schemas: { In: { type: "object" }, Out: out },
    root: { id: "m", kind: "model", prompt: "List the numbers", output: "Out" },
    result: { $ref: "steps.m" },
  };
}

function networkAgent(workflow: WorkflowDocument): AgentDefinition {
  return {
    name: "Numbers", instructions: "You answer with numbers.",
    model: { provider: "openai-compatible", name: "numbers-1", baseUrl: "http://agent.test/v1" },
    tools: [], limits: {}, learning: false, workflow,
  };
}

/** The arguments schema of the forced function, as the request carried it. */
function forcedParameters(request: FakeOpenAiRequest): Json {
  const body = JSON.parse(request.raw) as { tools?: { function: { name: string; parameters: Json } }[] };
  const name = forcedFunction(request);
  const tool = body.tools?.find((t) => t.function.name === name);
  assert.ok(tool !== undefined, `the request has the forced function ${String(name)}`);
  return tool.function.parameters;
}

interface Outcome { app: TestApp; model: FakeOpenAi; status: string; output: Json; records: JournalRecord[] }

async function runOn(t: TestContext, workflow: WorkflowDocument, reply: (request: FakeOpenAiRequest, index: number) => FakeOpenAiReply): Promise<Outcome> {
  const model = fakeOpenAi(reply);
  const app = await startTestApp(t, { app: { fetch: model.fetch } });
  const { agent } = await app.client.saveAgent(networkAgent(workflow), "numbers");
  const { run } = await app.client.startRun({ agentId: agent.id, data: {} });
  const { run: done } = await waitForStatus(app.client, run.id, ["completed", "failed", "cancelled", "waiting"]);
  return { app, model, status: done.status, output: done.output, records: await fullTimeline(app.client, run.id) };
}

const wrapperOf = (schema: JsonSchema): Json => ({ type: "object", additionalProperties: false, required: ["value"], properties: { value: schema } });

test("R05-01: a model step with an array output completes with the wrapped answer, and the wrapper is what was sent", { timeout: 30_000 }, async (t) => {
  const { model, status, output, records } = await runOn(t, modelWorkflow(INTEGERS), (request) => ({
    calls: [{ name: forcedFunction(request) ?? "", args: { value: [1, 2] } }],
  }));
  assert.equal(status, "completed", JSON.stringify(records.filter((r) => r.type.startsWith("model.")).map((r) => r.data)));
  assert.deepEqual(output, [1, 2]);
  assert.equal(model.requests.length, 1);
  assert.deepEqual(forcedParameters(model.requests[0] as FakeOpenAiRequest), wrapperOf(INTEGERS));
  assert.equal(records.some((r) => r.type === "model.invalid"), false);
});

test("R05-01: a model that sends the bare array as the function's arguments gives the same output", { timeout: 30_000 }, async (t) => {
  const { model, status, output } = await runOn(t, modelWorkflow(INTEGERS), (request) => ({
    calls: [{ name: forcedFunction(request) ?? "", args: [1, 2] }],
  }));
  assert.equal(status, "completed");
  assert.deepEqual(output, [1, 2]);
  assert.equal(model.requests.length, 1);
});

test("R05-01: a text refusal under a null-able schema is no output: model.invalid, one repair, the answered null is the output", { timeout: 30_000 }, async (t) => {
  const nullable: JsonSchema = { type: ["array", "null"] };
  const { model, status, output, records } = await runOn(t, modelWorkflow(nullable), (request, index) =>
    index === 0 ? { deltas: ["I cannot say"] } : { calls: [{ name: forcedFunction(request) ?? "", args: { value: null } }] });
  assert.equal(status, "completed");
  assert.equal(output, null);
  assert.equal(model.requests.length, 2, "the first reply and its repair");
  const invalid = records.filter((r) => r.type === "model.invalid");
  assert.equal(invalid.length, 1);
  assert.match(JSON.stringify(invalid[0]?.data), /the reply carried no structured output/);
  assert.deepEqual(forcedParameters(model.requests[1] as FakeOpenAiRequest), wrapperOf(nullable));
});

test("R05-01: a string output is wrapped and unwrapped", { timeout: 30_000 }, async (t) => {
  const text: JsonSchema = { type: "string", minLength: 1 };
  const { model, status, output } = await runOn(t, modelWorkflow(text), (request) => ({
    calls: [{ name: forcedFunction(request) ?? "", args: { value: "forty-two" } }],
  }));
  assert.equal(status, "completed");
  assert.equal(output, "forty-two");
  assert.deepEqual(forcedParameters(model.requests[0] as FakeOpenAiRequest), wrapperOf(text));
});

test("R05-01: a decide node's object schema is sent as it is and its own value property is not unwrapped", { timeout: 30_000 }, async (t) => {
  const workflow: WorkflowDocument = {
    format: "runwright.workflow/v1", name: "triage", input: "In", output: "Out",
    schemas: { In: { type: "object" }, Out: {} },
    root: { id: "urgent", kind: "decide", question: "Is this urgent?", decision: { type: "yes_no" } } as WorkflowNode,
    result: { $ref: "steps.urgent" },
  };
  const { model, status, output } = await runOn(t, workflow, (request) => ({
    calls: [{ name: forcedFunction(request) ?? "", args: { value: true, confidence: 0.9, reason: "the server is down" } }],
  }));
  assert.equal(status, "completed");
  assert.equal((output as JsonObject)["value"], true);
  assert.equal((output as JsonObject)["confidence"], 0.9);
  const parameters = forcedParameters(model.requests[0] as FakeOpenAiRequest) as JsonObject;
  assert.equal(parameters["type"], "object");
  assert.equal(Object.hasOwn(parameters["properties"] as JsonObject, "confidence"), true, "the decision schema itself, not a wrapper");
});

function reviewerDocument(code: JsonSchema = CODE): WorkflowDocument {
  return {
    format: "runwright.workflow/v1", name: "country", input: "In", output: "Out",
    schemas: { In: { type: "object" }, Out: { type: "object", required: ["code"], properties: { code } } },
    root: { id: "m", kind: "model", prompt: "Give a country code", output: "Out" },
    result: { $ref: "steps.m" },
  };
}

async function cliIn(app: TestApp, argv: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const dataDir = join(app.dir, "data");
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    stdin: async () => "",
    env: { HOME: app.dir, RUNWRIGHT_DATA_DIR: dataDir, RUNWRIGHT_URL: app.app.url, RUNWRIGHT_TOKEN: app.app.token },
    isTTY: true,
  });
  return { code, stdout, stderr };
}

test("R05-02: the reviewer's document dry-runs ok through the API; a look-ahead pattern is a warning", { timeout: 30_000 }, async (t) => {
  const { client } = await startTestApp(t);
  const report = await client.dryRunWorkflow(reviewerDocument() as unknown as Json);
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.deepEqual(report.problems.filter((p) => p.severity === "error"), []);
  assert.match(String((report.output as JsonObject)["code"]), /^[A-Z]{2}$/);

  const look = await client.dryRunWorkflow(reviewerDocument(LOOKAHEAD) as unknown as Json);
  assert.equal(look.ok, true, JSON.stringify(look.problems));
  assert.ok(look.problems.length > 0);
  assert.ok(look.problems.every((p) => p.code === "placeholder_dependent" && p.severity === "warning"), JSON.stringify(look.problems));
  assert.ok(look.problems.some((p) => p.path === "output.code" && p.message.startsWith("not checked against a real value: ")));
});

test("R05-02: runwright workflows dry-run prints the warning and exits 0 with Dry run OK.", { timeout: 30_000 }, async (t) => {
  const app = await startTestApp(t);
  const file = join(app.dir, "country.json");
  await writeFile(file, JSON.stringify(reviewerDocument(LOOKAHEAD)));
  const result = await cliIn(app, ["workflows", "dry-run", file]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^Problems:$/m);
  assert.match(result.stdout, /^ {2}warning output\.code placeholder_dependent: not checked against a real value: /m);
  assert.match(result.stdout, /Dry run OK\.\s*$/);

  await writeFile(file, JSON.stringify(reviewerDocument()));
  const clean = await cliIn(app, ["workflows", "dry-run", file]);
  assert.equal(clean.code, 0, clean.stderr);
  assert.doesNotMatch(clean.stdout, /Problems:/);
  assert.match(clean.stdout, /Dry run OK\.\s*$/);
});

test("R05-02: a model schema with minLength 1000000000 answers promptly and the server stays up", { timeout: 30_000 }, async (t) => {
  const { client } = await startTestApp(t);
  const started = Date.now();
  const report = await client.dryRunWorkflow(reviewerDocument({ type: "string", minLength: 1_000_000_000 }) as unknown as Json);
  assert.ok(Date.now() - started < 5_000, `answered in ${Date.now() - started} ms`);
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.ok(report.problems.some((p) => p.code === "placeholder_dependent" && p.path === "$.root"));
  assert.ok(String((report.output as JsonObject)["code"]).length <= 4096);
  const again = await client.dryRunWorkflow(reviewerDocument() as unknown as Json);
  assert.equal(again.ok, true);
});

const SKILL_PATH = "skills/country-code.md";
const SKILL = {
  path: SKILL_PATH,
  content: "---\ntitle: Country code\ndescription: How to give a country code.\n---\n1. Read the address.\n2. Give its two-letter code.",
};
const GRADER_SCRIPT: ScriptedScript = {
  turns: [],
  steps: { "learning.grade": { output: { job_finished: true, decisions: [{ path: SKILL_PATH, verdict: "keep", reason: "reusable" }] } } },
};

async function promoted(app: TestApp, agentId: string): Promise<{ skill: LearningItem; records: JournalRecord[] }> {
  for (let i = 0; i < 4; i += 1) {
    const { run } = await app.client.startRun({ agentId, message: "give the country code" });
    const { run: done } = await waitForStatus(app.client, run.id, ["completed", "failed"]);
    assert.equal(done.status, "completed");
    const records = await fullTimeline(app.client, run.id);
    const [skill] = await app.client.listLearning({ agentId, kind: "skill" });
    if (records.some((r) => r.type === "learning.promotion")) {
      assert.ok(skill !== undefined);
      return { skill, records };
    }
  }
  throw new Error("the skill was never promoted");
}

for (const variant of ["scripted answer", "placeholder answer"] as const) {
  test(`R05-02: a skill drafted as the reviewer's document is promoted in one attempt and runs with run_workflow (${variant})`, { timeout: 60_000 }, async (t) => {
    const app = await startTestApp(t, {
      configure: (config) => {
        config.learning.promoteAfterRuns = 1;
        config.learning.graderModel = { provider: "scripted", name: "scripted-1", script: GRADER_SCRIPT };
      },
    });
    const learner = scriptedAgent({
      name: "Coder", learning: true,
      script: {
        turns: [{ text: "code given" }],
        steps: {
          "learning.propose": { output: { job_finished: true, files: [SKILL] } },
          "learning.promote": { output: { document: reviewerDocument() as unknown as Json } },
        },
      },
    });
    const { agent } = await app.client.saveAgent(learner, "coder");
    const { skill, records } = await promoted(app, agent.id);
    const promotion = records.filter((r) => r.type === "learning.promotion");
    assert.equal(promotion.length, 1);
    const name = promotedWorkflowName(skill);
    assert.deepEqual(promotion[0]?.data, { itemId: skill.id, outcome: "kept", workflow: name, problems: [] });
    assert.equal(skill.promotionAttempts, 1);
    assert.equal(skill.promotedWorkflow, name);
    const saved = await app.client.getWorkflow(name);
    assert.deepEqual(saved.document.schemas, reviewerDocument().schemas);

    const caller: WorkflowDocument = {
      format: "runwright.workflow/v1", name: "caller", input: "In", output: "Out",
      schemas: { In: { type: "object" }, Out: {} },
      root: { id: "call", kind: "tool", tool: "run_workflow", args: { name, input: {} } },
      result: { $ref: "steps.call.data" },
    };
    const steps: ScriptedScript["steps"] = variant === "scripted answer" ? { m: { output: { code: "AB" } } } : {};
    const { agent: callerAgent } = await app.client.saveAgent({
      ...scriptedAgent({ name: "Caller", tools: [{ name: "run_workflow" }], script: { steps } }),
      workflow: caller,
    }, "caller");
    const { run } = await app.client.startRun({ agentId: callerAgent.id, data: {} });
    const { run: done } = await waitForStatus(app.client, run.id, ["completed", "failed", "cancelled", "waiting"]);
    assert.equal(done.status, "completed", JSON.stringify(done.error));
    const code = (done.output as JsonObject)["code"];
    if (variant === "scripted answer") assert.equal(code, "AB");
    else assert.match(String(code), /^[A-Z]{2}$/, "the scripted model's placeholder validates");
    const callRecords = await fullTimeline(app.client, run.id);
    assert.equal(callRecords.some((r) => r.type === "model.invalid"), false);
  });
}
