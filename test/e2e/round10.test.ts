/**
 * Behaviour that crosses package seams, through the real app (and the CLI where a person would use it):
 * - engine E2 through the real workflow executor: parallel `agent` branches and one message sent to the run;
 * - engine E3 through the real executor: a `sequence` deadline over an `agent` node and a slow `run_workflow` call;
 * - the save check of `PUT /v1/workflows/:name` (`savedAs`) through the server and `runwright workflows save`;
 * - `learning.onLimit: "pause"` (the default) as a person sees it: `pendings list`, `runs wait` (exit 8), `runs raise`;
 * - structural redaction at the output boundaries only: a stored secret whose digits are also a run's cost cap.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Json, JsonObject } from "../../src/core/json.ts";
import type { JournalRecord } from "../../src/store/types.ts";
import type { WorkflowDocument } from "../../src/workflow/types.ts";
import { cli, parsed, type CliResult } from "../cli/support.ts";
import { startTestApp, type TestApp } from "../fixtures/app.ts";
import { callTurn, effectLines, fullTimeline, scriptedAgent, waitForStatus } from "../fixtures/runs.ts";
import { waitFor } from "../helpers/wait.ts";
import { makeTempDir } from "../helpers/tmp.ts";

function cliFor(app: TestApp, dataDir: string): (argv: readonly string[]) => Promise<CliResult> {
  return (argv) => cli(argv, { dataDir, env: { RUNWRIGHT_URL: app.app.url, RUNWRIGHT_TOKEN: app.app.token } });
}

function workflow(name: string, root: JsonObject, extra?: JsonObject): WorkflowDocument {
  return {
    format: "runwright.workflow/v1", name, schemas: { In: { type: "object" }, Out: {} }, input: "In", output: "Out", root, result: "done",
    ...extra,
  } as unknown as WorkflowDocument;
}

test("parallel agent hand-offs: one message sent to the run reaches exactly one branch", { timeout: 30_000 }, async (t) => {
  const { client, effects } = await startTestApp(t);
  const hand = (id: string): JsonObject => ({ id, kind: "agent", message: `work on ${id}`, maxTurns: 4 });
  const { agent } = await client.saveAgent({
    ...scriptedAgent({
      name: "Fan out", tools: [{ name: "slow_effect" }],
      script: { turns: [callTurn("slow_effect", { label: "work", ms: 400 }), { text: "branch done" }] },
    }),
    workflow: workflow("fan_out", { id: "both", kind: "parallel", branches: [hand("left"), hand("right")] }),
  }, "fan-out");
  const { run } = await client.startRun({ agentId: agent.id, data: {} });
  await waitFor(async () => ((await effectLines(effects)).filter((line) => line === "start:work").length === 2 ? true : null),
    { timeoutMs: 10_000, intervalMs: 10, message: "both branches did not start their tool call" });
  await client.sendMessage(run.id, "only one of you should read this");
  const { run: done } = await waitForStatus(client, run.id, ["completed", "failed", "waiting"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));

  const records = await fullTimeline(client, run.id);
  const taken = records.filter((r) => r.type === "inbox.taken");
  const carriers = taken.filter((r) => ((r.data["messages"] ?? []) as unknown[]).length > 0);
  assert.equal(carriers.length, 1, "the message is in exactly one inbox.taken record");
  const messages = carriers[0]?.data["messages"] as { text: string }[];
  assert.deepEqual(messages.map((m) => m.text), ["only one of you should read this"]);
  const branch = (carriers[0] as JournalRecord).key ?? "";
  assert.ok(branch.includes("left") !== branch.includes("right"), `the take belongs to one branch: ${branch}`);
  assert.ok(taken.some((r) => r.key?.includes("left") === true) && taken.some((r) => r.key?.includes("right") === true),
    "both branches took their inbox");
});

const SLOW_MS = 1500;
const SEQUENCE_DEADLINE_MS = 600;

test("a sequence deadline over an agent hand-off and a slow run_workflow call fails the run and charges the interrupted call", { timeout: 30_000 }, async (t) => {
  const { client } = await startTestApp(t);
  const nested = {
    format: "runwright.workflow/v1", name: "slow_summary",
    schemas: { In: { type: "object" }, Out: {}, Summary: { type: "object", required: ["text"], properties: { text: { type: "string" } } } },
    input: "In", output: "Out", root: { id: "slow", kind: "model", prompt: "Summarise", output: "Summary" }, result: { $ref: "steps.slow.text" },
  };
  await client.saveWorkflow("slow_summary", nested as unknown as Json);
  const outer = workflow("bounded", { id: "main", kind: "sequence", deadlineMs: SEQUENCE_DEADLINE_MS, steps: [
    { id: "helper", kind: "agent", message: "say hello", maxTurns: 2 },
    { id: "summary", kind: "tool", tool: "run_workflow", args: { name: "slow_summary", input: {} } },
  ] });
  const { agent } = await client.saveAgent({
    ...scriptedAgent({
      name: "Bounded", tools: [{ name: "run_workflow" }],
      script: {
        turns: [{ text: "hello", usage: { inputTokens: 50, outputTokens: 5 } }],
        steps: { slow: { output: { text: "too late" }, delayMs: SLOW_MS, usage: { inputTokens: 10, outputTokens: 10 } } },
      },
    }),
    workflow: outer,
  }, "bounded");

  const { run } = await client.startRun({ agentId: agent.id, data: {} });
  const { run: done } = await waitForStatus(client, run.id, ["completed", "failed", "waiting"]);
  assert.equal(done.status, "failed");
  assert.equal(done.error?.code, "workflow_failed", JSON.stringify(done.error));
  assert.match(done.error?.message ?? "", new RegExp(`node "main" failed: deadline_exceeded: the deadline of ${SEQUENCE_DEADLINE_MS} ms passed`));

  const records = await fullTimeline(client, run.id);
  const call = records.find((r) => r.type === "tool.started" && r.data["tool"] === "run_workflow");
  assert.ok(call !== undefined && call.key !== null, "the run_workflow call started");
  const finished = records.filter((r) => r.type === "tool.finished" && r.key === call.key);
  assert.deepEqual(finished.map((r) => r.data["outcome"]), ["timeout"], "the call is journalled as a timeout");
  const interrupted = records.filter((r) => r.type === "model.interrupted");
  assert.deepEqual(interrupted.map((r) => r.data["reason"]), ["deadline"], "the nested model call is interrupted by the deadline");
  const startedSlow = records.find((r) => r.type === "model.started" && r.key === interrupted[0]?.key);
  const worst = Number(startedSlow?.data["worstCaseMicros"]);
  assert.ok(worst > 0);
  assert.equal(interrupted[0]?.data["assumedCostMicros"], worst, "the interrupted call is charged at its worst case");
  const agentCost = records.filter((r) => r.type === "model.finished").reduce((sum, r) => sum + Number(r.data["costMicros"]), 0);
  assert.ok(agentCost > 0, "the agent hand-off finished before the deadline and was charged");
  assert.equal(done.usage.costMicros, agentCost + worst, "the run's cost includes the worst case of the interrupted call");
  assert.equal(records.some((r) => r.type === "model.finished" && r.key === interrupted[0]?.key), false, "the late reply was never taken");
});

test("workflows save refuses a direct, an indirect and a renamed call cycle with exit 1 and call_cycle", { timeout: 30_000 }, async (t) => {
  const app = await startTestApp(t);
  const dir = await makeTempDir(t, "runwright-cycles-");
  const run = cliFor(app, dir);
  const save = async (name: string, document: WorkflowDocument): Promise<CliResult> => {
    const file = join(dir, `${name}-${Math.random().toString(36).slice(2)}.json`);
    await writeFile(file, JSON.stringify(document));
    return run(["workflows", "save", name, file]);
  };
  const call = (target: string): JsonObject => ({ id: "next", kind: "call", workflow: target, input: {} });
  const refused = (result: CliResult, label: string): void => {
    assert.equal(result.code, 1, `${label}: ${result.stdout}${result.stderr}`);
    const body = parsed<{ error: { code: string; details?: { problems?: { code: string }[] } } }>(result);
    assert.equal(body.error.code, "workflow_invalid", label);
    assert.ok((body.error.details?.problems ?? []).some((p) => p.code === "call_cycle"), `${label}: ${result.stdout}`);
  };

  refused(await save("loop_a", workflow("loop_a", call("loop_a"))), "direct");
  const leaf = await save("leaf_c", workflow("leaf_c", { id: "w", kind: "wait", question: "q" }));
  assert.equal(leaf.code, 0, leaf.stderr);
  const middle = await save("mid_b", workflow("mid_b", call("leaf_c")));
  assert.equal(middle.code, 0, middle.stderr);
  refused(await save("leaf_c", workflow("leaf_c", call("mid_b"))), "indirect");
  refused(await save("named_d", workflow("something_else", call("named_d"))), "renamed");

  assert.deepEqual((await app.client.listWorkflows()).map((w) => [w.name, w.version]).sort(), [["leaf_c", 1], ["mid_b", 1]],
    "nothing refused was saved");
  const leafNow = await app.client.getWorkflow("leaf_c");
  assert.equal((leafNow.document.root as unknown as JsonObject)["kind"], "wait");
});

test("learning under the default onLimit: the run waits at learning/propose, is listed and waited on, and completes after runs raise", { timeout: 30_000 }, async (t) => {
  const app = await startTestApp(t);
  const dir = await makeTempDir(t, "runwright-learn-cli-");
  const run = cliFor(app, dir);
  const note = { path: "notes/build.md", content: "---\ntitle: Build\ndescription: How it builds.\n---\nRun `make` at the root." };
  const script = { turns: [{ text: "built", usage: { inputTokens: 40, outputTokens: 4 } }], steps: { "learning.propose": { output: { job_finished: true, files: [note] } } } };
  const { agent } = await app.client.saveAgent(scriptedAgent({ name: "Learner", script, learning: true, model: { maxOutputTokens: 50 } }), "learner");

  const probe = (await app.client.startRun({ agentId: agent.id, message: "build", limits: { maxCostMicros: 1_000_000 } })).run;
  await waitForStatus(app.client, probe.id, ["completed"]);
  const firstWorst = Number((await fullTimeline(app.client, probe.id)).find((r) => r.type === "model.started")?.data["worstCaseMicros"]);
  assert.ok(firstWorst > 0);

  const started = parsed<{ run: { id: string } }>(await run(["runs", "start", "learner", "--message", "build", "--max-cost", (firstWorst / 1e6).toFixed(6)]));
  const runId = started.run.id;
  const waited = await run(["runs", "wait", runId, "--timeout", "20"]);
  assert.equal(waited.code, 8, waited.stdout + waited.stderr);
  const waiting = parsed<{ run: { status: string }; pendings: { kind: string; stepKey: string; status: string }[] }>(waited);
  assert.equal(waiting.run.status, "waiting");
  assert.deepEqual(waiting.pendings.filter((p) => p.status === "open").map((p) => [p.kind, p.stepKey]), [["spend_cap", "learning/propose"]]);

  const listed = parsed<{ pendings: { runId: string; kind: string; stepKey: string }[] }>(await run(["pendings", "list", "--run", runId]));
  assert.deepEqual(listed.pendings.map((p) => [p.runId, p.kind, p.stepKey]), [[runId, "spend_cap", "learning/propose"]]);
  const before = await fullTimeline(app.client, runId);
  assert.ok(before.some((r) => r.type === "run.output"), "the job's output is journalled before learning waits");
  assert.equal(before.some((r) => r.type === "model.started" && r.key === "learning/propose"), false, "the proposal call was not sent");

  const raised = await run(["runs", "raise", runId, "--max-cost", "1"]);
  assert.equal(raised.code, 0, raised.stdout + raised.stderr);
  const finished = await run(["runs", "wait", runId, "--timeout", "20"]);
  assert.equal(finished.code, 0, finished.stdout + finished.stderr);
  assert.equal(parsed<{ run: { status: string; output: unknown } }>(finished).run.status, "completed");
  const after = await fullTimeline(app.client, runId);
  assert.ok(after.some((r) => r.type === "learning.proposed" || r.type === "learning.graded"), "learning ran after the raise");
  assert.equal(after.filter((r) => r.type === "model.started" && r.key === "learning/propose").length, 1);
});

const DIGITS = "12345678";

async function readEvents(t: TestContext, app: TestApp, runId: string, until: (text: string) => boolean): Promise<string> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 10_000);
  t.after(() => clearTimeout(timer));
  const response = await fetch(`${app.app.url}/v1/runs/${runId}/events`, { headers: { Authorization: `Bearer ${app.app.token}` }, signal: abort.signal });
  assert.equal(response.status, 200);
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (!until(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    abort.abort();
  }
  return text;
}

function assertJsonWithout(text: string, label: string): void {
  assert.equal(text.includes(DIGITS), false, `${label} holds the digits`);
}

test("a secret whose digits are a run's cost cap: every output is valid JSON without them, and the cap still holds", { timeout: 30_000 }, async (t) => {
  const app = await startTestApp(t);
  const dir = await makeTempDir(t, "runwright-digits-");
  const run = cliFor(app, dir);
  await app.client.setSecret("NUMERIC_PIN", DIGITS);
  const script = { turns: [
    callTurn("list_files", {}, { usage: { inputTokens: 100, outputTokens: 2_000_000 } }),
    { text: "finished", usage: { inputTokens: 100, outputTokens: 10 } },
  ] };
  const { agent } = await app.client.saveAgent(scriptedAgent({
    name: "Digits", tools: [{ name: "list_files" }], model: { maxOutputTokens: 2_000_000 }, script,
  }), "digits");
  const { run: started } = await app.client.startRun({ agentId: agent.id, message: "go", limits: { maxCostMicros: Number(DIGITS) } });

  const { run: waiting, pendings } = await waitForStatus(app.client, started.id, ["waiting", "completed", "failed"]);
  assert.equal(waiting.status, "waiting", "the run pauses at its numeric cap");
  assert.deepEqual(pendings.map((p) => [p.kind, p.detail["reason"]]), [["spend_cap", "cap"]]);

  const raw = await fetch(`${app.app.url}/v1/runs/${started.id}`, { headers: { Authorization: `Bearer ${app.app.token}` } });
  const rawText = await raw.text();
  JSON.parse(rawText);
  assertJsonWithout(rawText, "GET /v1/runs/:id");
  const body = JSON.parse(rawText) as { run: { limits: JsonObject } };
  assert.equal(body.run.limits["maxCostMicros"], "[redacted]", "the cap's digits are replaced at the response boundary");

  const events = await readEvents(t, app, started.id, (text) => text.includes("pending.opened"));
  const dataLines = events.split("\n").filter((line) => line.startsWith("data: "));
  assert.ok(dataLines.length > 3);
  for (const line of dataLines) JSON.parse(line.slice("data: ".length));
  assertJsonWithout(events, "the SSE stream");

  const got = await run(["runs", "get", started.id]);
  assert.equal(got.code, 0, got.stderr);
  JSON.parse(got.stdout);
  assertJsonWithout(got.stdout, "runs get");

  const raised = await run(["runs", "raise", started.id, "--max-cost", "100"]);
  assert.equal(raised.code, 0, raised.stdout + raised.stderr);
  const { run: done } = await waitForStatus(app.client, started.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  const records = await fullTimeline(app.client, started.id);
  const changed = records.filter((r) => r.type === "limits.changed");
  assert.ok(changed.length >= 1, "the raise was applied from the journal's numbers");

  assert.ok(app.logLines.length > 0);
  for (const line of app.logLines) JSON.parse(line);
  assertJsonWithout(app.logLines.join("\n"), "the server log");
});
