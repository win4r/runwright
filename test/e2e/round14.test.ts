/**
 * Round 14 across package borders, through the real app, server and CLI:
 * - R13D-engine-01 / R13D-spec-02: an agent's explicit `recall` policy outranks the learning grant, and the
 *   learning prompt follows the engine's answer (C1, C2);
 * - R13D-docs-03: `runs approve <run>` sees every open pending of the run, also beyond the first 200 (C8);
 * - R13D-docs-04: `runs files <run>` lists every file of a workspace of more than 2 000 files (C8);
 * - R13D-store-01: usage totals saturate at 2^53 − 1 in the run row, the replayed state and the usage summary (C9);
 * - R13D-spec-01: promotion rejects a drafted workflow whose only reachable branch fails (rule D, C4);
 * - R13D-engine-03: `runwright serve` that fails after binding exits 1 promptly and leaves no process (C6);
 *
 * - R13D-spec-03: the reviewer's Paris paraphrase of an untrusted page is stored `held`, not `active`, though the
 *   grader says keep, and the next run is not given it (rule T);
 *
 * Not repeated here, because an earlier package's end-to-end test already covers it: the nested `run_workflow`
 * case of a hand-off's `tools` (`test/e2e/handoff-tools.test.ts`).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { AgentToolEntry } from "../../src/agents/definition.ts";
import type { Json, JsonObject } from "../../src/core/json.ts";
import { replayJournal } from "../../src/engine/state.ts";
import type { ScriptedScript } from "../../src/models/types.ts";
import type { JournalRecord, NewPending, PendingKind } from "../../src/store/types.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import type { WorkflowDocument } from "../../src/workflow/types.ts";
import { BIN, ROOT, cli, cliServer, parsed, seed } from "../cli/support.ts";
import { startTestApp, type TestApp } from "../fixtures/app.ts";
import { callTurn, fullTimeline, scriptedAgent, waitForStatus } from "../fixtures/runs.ts";
import { claim } from "../server/support.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { waitFor } from "../helpers/wait.ts";

const MAX = Number.MAX_SAFE_INTEGER;

function finishedCalls(records: readonly JournalRecord[], tool: string): JsonObject[] {
  return records.filter((r) => r.type === "tool.finished" && r.data["tool"] === tool).map((r) => r.data);
}

// ---------------------------------------------------------------- R13D-engine-01 / R13D-spec-02: policy end to end

const itemFile = (title: string, body: string): string => `---\ntitle: ${title}\ndescription: How ${title.toLowerCase()} works.\n---\n${body}`;
const NOTES = ["Build", "Deploy", "Release", "Backup", "Rollback"].map((title) => ({
  path: `notes/${title.toLowerCase()}.md`,
  content: itemFile(title, `${title}: ${"this detail matters for the job and is long enough to need a line. ".repeat(20)}`),
}));
const GRADE_ALL = { output: { job_finished: true, decisions: NOTES.map((n) => ({ path: n.path, verdict: "keep", reason: "useful" })) } };

/**
 * A learning agent whose first run keeps five long notes (more than the 150-token budget holds whole). A later run
 * calls `recall` whatever its prompt says; with `probe`, a prompt that mentions `recall` makes it answer
 * "offered recall" instead, so the journal shows whether the prompt offered the tool.
 */
async function learnedAgent(app: TestApp, recall: AgentToolEntry, probe: boolean): Promise<string> {
  const callRecall: ScriptedScript["variants"] = [
    { when: { contains: "Learned from earlier runs", in: "system" }, turns: [callTurn("recall", { name: "note/build" }), { text: "done" }] },
  ];
  const script: ScriptedScript = {
    turns: [{ text: "done" }],
    variants: probe ? [{ when: { contains: "recall", in: "system" }, turns: [{ text: "offered recall" }] }, ...callRecall] : callRecall,
    steps: { "learning.propose": { output: { job_finished: true, files: NOTES } }, "learning.grade": GRADE_ALL },
  };
  const { agent } = await app.client.saveAgent(scriptedAgent({ name: "Learner", learning: true, tools: [recall], script }), "learner");
  const { run } = await app.client.startRun({ agentId: agent.id, message: "first" });
  const { run: done } = await waitForStatus(app.client, run.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  const active = await app.client.listLearning({ agentId: agent.id, status: "active" });
  assert.equal(active.length, NOTES.length, "the first run kept every note");
  return agent.id;
}

async function learningApp(t: TestContext): Promise<TestApp> {
  return startTestApp(t, { configure: (config) => {
    config.learning.budgetTokens = 150;
  } });
}

test("R13D-engine-01: recall \"deny\" with listed lines: the prompt does not offer recall, a call anyway is denied", { timeout: 60_000 }, async (t) => {
  const app = await learningApp(t);
  const agentId = await learnedAgent(app, { name: "recall", policy: "deny" }, true);
  const { run } = await app.client.startRun({ agentId, message: "deploy the build" });
  const { run: done } = await waitForStatus(app.client, run.id, ["completed", "failed", "waiting"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  const records = await fullTimeline(app.client, run.id);
  const given = records.find((r) => r.type === "learning.given")?.data["items"] as { mode: string }[] | undefined;
  assert.ok(given?.some((g) => g.mode === "line"), `some items are lines: ${JSON.stringify(given)}`);
  const [recalled] = finishedCalls(records, "recall");
  assert.ok(recalled !== undefined, "the model called recall, so the prompt did not offer it");
  assert.equal(recalled["outcome"], "denied");
  assert.equal(records.some((r) => r.type === "pending.opened"), false);
});

test("R13D-spec-02: recall \"ask\": the call waits on an approval although the learning context grants recall", { timeout: 60_000 }, async (t) => {
  const app = await learningApp(t);
  const agentId = await learnedAgent(app, { name: "recall", policy: "ask" }, false);
  const { run } = await app.client.startRun({ agentId, message: "deploy the build" });
  const { run: waiting, pendings } = await waitForStatus(app.client, run.id, ["completed", "failed", "waiting"]);
  assert.equal(waiting.status, "waiting");
  assert.deepEqual(pendings.map((p) => p.kind), ["approval"]);
  assert.equal(finishedCalls(await fullTimeline(app.client, run.id), "recall").length, 0, "recall did not run before the approval");
  await app.client.approve(pendings[0]?.id as string);
  const { run: done } = await waitForStatus(app.client, run.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  const [recalled] = finishedCalls(await fullTimeline(app.client, run.id), "recall");
  assert.equal(recalled?.["outcome"], "ok");
});

// ---------------------------------------------------------------- R13D-docs-03: CLI pending selection

test("R13D-docs-03: runs approve on a run with 199 questions and then two approvals refuses and lists both", { timeout: 30_000 }, async (t) => {
  const s = await cliServer(t);
  const run = await seed(s.store, "pending-agent");
  const { lease } = await claim(s.store, run.id);
  const pending = (id: string, kind: PendingKind): NewPending => ({ id, kind, stepKey: `t1.${id}`, title: `Please handle ${id}`, detail: {} });
  // One commit: one created_at, so the listing order is the id order — the questions, then the two approvals.
  const pendings = [
    ...Array.from({ length: 199 }, (_, i) => pending(`pnd_r14_q${String(i).padStart(3, "0")}`, "question")),
    pending("pnd_r14_z0", "approval"), pending("pnd_r14_z1", "approval"),
  ];
  await s.store.commit(lease, {
    records: pendings.map((p) => ({ type: "pending.opened", key: p.stepKey, data: { pending: p as unknown as JsonObject } })),
    openPendings: pendings,
    transition: { to: "waiting" },
  });
  // The precondition that makes this a probe: a first page of 200 holds exactly one of the approvals.
  const firstPage = await s.store.listPendings({ runId: run.id, status: "open" }, { limit: 200 });
  assert.deepEqual(firstPage.items.filter((p) => p.kind === "approval").map((p) => p.id), ["pnd_r14_z0"]);

  const result = await cli(["runs", "approve", run.id], { dataDir: s.dir });
  assert.notEqual(result.code, 0, result.stdout);
  assert.match(result.stderr, new RegExp(`run ${run.id} has 2 open approval pendings; choose one with --pending:`));
  assert.match(result.stderr, /pnd_r14_z0/);
  assert.match(result.stderr, /pnd_r14_z1/);
  const open = await s.store.listPendings({ runId: run.id, status: "open", kind: "approval" }, { limit: 10 });
  assert.equal(open.items.length, 2, "nothing was approved");

  const chosen = await cli(["runs", "approve", run.id, "--pending", "pnd_r14_z1", "--json"], { dataDir: s.dir });
  assert.equal(chosen.code, 0, chosen.stderr);
});

// ---------------------------------------------------------------- R13D-docs-04: file listing through the CLI

test("R13D-docs-04: runs files --json lists every file of a workspace of 2 001 files", { timeout: 30_000 }, async (t) => {
  const s = await cliServer(t);
  const run = await seed(s.store, "files-agent");
  const workspace = join(s.dir, "workspaces", run.id);
  await mkdir(workspace, { recursive: true });
  const names = Array.from({ length: 2001 }, (_, i) => `f${String(i).padStart(4, "0")}.txt`);
  for (let i = 0; i < names.length; i += 200) {
    await Promise.all(names.slice(i, i + 200).map((name) => writeFile(join(workspace, name), "x")));
  }
  const result = await cli(["runs", "files", run.id, "--json"], { dataDir: s.dir });
  assert.equal(result.code, 0, result.stderr);
  const { files } = parsed<{ files: { path: string }[] }>(result);
  assert.equal(files.length, 2001);
  assert.deepEqual(files.map((f) => f.path), names);
});

// ---------------------------------------------------------------- R13D-store-01: totals agree (C9)

test("R13D-store-01: input tokens of 2^53 − 1 and 1 saturate in the run, after a second claim, and in the usage summary", { timeout: 30_000 }, async (t) => {
  const app = await startTestApp(t);
  const { agent } = await app.client.saveAgent(scriptedAgent({
    name: "Counter", tools: [{ name: "ask_person" }],
    script: { turns: [
      callTurn("ask_person", { question: "Go on?" }, { usage: { inputTokens: MAX } }),
      { text: "done", usage: { inputTokens: 1 } },
    ] },
  }), "counter");
  const { run } = await app.client.startRun({ agentId: agent.id, message: "count" });
  const { run: waiting, pendings } = await waitForStatus(app.client, run.id, ["waiting", "failed", "completed"]);
  assert.equal(waiting.status, "waiting", JSON.stringify(waiting.error));
  assert.equal(waiting.usage.inputTokens, MAX);
  // Answering wakes the run: a second claim rebuilds its state from the journal before the second call.
  await app.client.answer(pendings[0]?.id as string, "yes");
  const { run: done } = await waitForStatus(app.client, run.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(done.usage.inputTokens, MAX, "the run row saturates");
  assert.equal(done.usage.turns, 2);
  const records = await fullTimeline(app.client, run.id);
  assert.ok(records.filter((r) => r.type === "run.claimed").length >= 2, "the run was claimed again after the answer");
  // The state a runner rebuilds from the journal agrees with the run row.
  const replayed = replayJournal(await app.app.store.readJournal(run.id, { limit: 10_000 }), done.limits);
  assert.equal(replayed.usage.inputTokens, MAX, "the replayed state saturates");
  assert.deepEqual(replayed.usage, done.usage);
  for (const groupBy of ["day", "agent", "model"] as const) {
    const { rows } = await app.client.usage({ groupBy, agentId: agent.id });
    assert.equal(rows.length, 1, groupBy);
    assert.equal(rows[0]?.inputTokens, MAX, `the ${groupBy} summary saturates`);
  }
});

// ---------------------------------------------------------------- R13D-spec-01: promotion gate

const SKILL_PATH = "skills/route.md";
const SKILL = { path: SKILL_PATH, content: "---\ntitle: Route\ndescription: How to route a request.\n---\n1. Read the request.\n2. Route it." };

/** The reviewer's document: the input can only be `true`, the case for `true` fails, the default waits. */
function onlyFails(): WorkflowDocument {
  return {
    format: "runwright.workflow/v1", name: "probe", input: "In", output: "Out",
    schemas: { In: { type: "boolean", const: true }, Out: { type: "object" } },
    root: {
      id: "route", kind: "branch", on: { $ref: "input" },
      cases: [{ when: true, run: { id: "f", kind: "fail", message: "stopped at f" } }],
      default: { id: "w", kind: "wait", question: "q" },
    },
    result: {},
  } as unknown as WorkflowDocument;
}

test("R13D-spec-01: a skill drafted as a workflow whose reachable branch can only fail is not promoted", { timeout: 60_000 }, async (t) => {
  const app = await startTestApp(t, { configure: (config) => {
    config.learning.promoteAfterRuns = 1;
    config.learning.graderModel = {
      provider: "scripted", name: "scripted-1",
      script: { turns: [], steps: { "learning.grade": { output: { job_finished: true, decisions: [{ path: SKILL_PATH, verdict: "keep", reason: "reusable" }] } } } },
    };
  } });
  const { agent } = await app.client.saveAgent(scriptedAgent({
    name: "Router", learning: true,
    script: { turns: [{ text: "routed" }], steps: {
      "learning.propose": { output: { job_finished: true, files: [SKILL] } },
      "learning.promote": { output: { document: onlyFails() as unknown as Json } },
    } },
  }), "router");
  let promotion: JsonObject | undefined;
  for (let i = 0; i < 3 && promotion === undefined; i += 1) {
    const { run } = await app.client.startRun({ agentId: agent.id, message: "route the request" });
    const { run: done } = await waitForStatus(app.client, run.id, ["completed", "failed"]);
    assert.equal(done.status, "completed", JSON.stringify(done.error));
    promotion = (await fullTimeline(app.client, run.id)).find((r) => r.type === "learning.promotion")?.data;
  }
  assert.ok(promotion !== undefined, "a promotion was attempted");
  assert.notEqual(promotion["outcome"], "kept");
  const problems = promotion["problems"] as string[];
  assert.ok(problems.some((p) => /would fail: stopped at f/.test(p)), JSON.stringify(problems));
  const [skill] = await app.client.listLearning({ agentId: agent.id, kind: "skill" });
  assert.equal(skill?.status, "active");
  assert.equal(skill?.promotedWorkflow, null, "the skill stays unpromoted");
  assert.deepEqual(await app.client.listWorkflows(), [], "no workflow was saved for it");
});

// ---------------------------------------------------------------- R13D-engine-03: startup cleanup through the CLI

test("R13D-engine-03: runwright serve on a data dir whose server.json is a directory exits 1 promptly with the error", { timeout: 30_000 }, async (t) => {
  const dataDir = join(await makeTempDir(t, "runwright-e2e-serve-"), "data");
  await mkdir(join(dataDir, "server.json"), { recursive: true });
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("RUNWRIGHT_") && !key.startsWith("NODE_TEST")) env[key] = value;
  Object.assign(env, { HOME: dataDir, RUNWRIGHT_DATA_DIR: dataDir, RUNWRIGHT_PORT: "0", RUNWRIGHT_LOG_LEVEL: "error" });
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", BIN, "serve"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", (code, signal) => {
      exit = { code, signal };
      resolve();
    });
  });
  t.after(async () => {
    if (exit === null) {
      child.kill("SIGKILL");
      await exited;
    }
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  const started = Date.now();
  await waitFor(async () => (exit !== null ? true : null), { timeoutMs: 10_000, intervalMs: 20, message: "serve did not exit" });
  assert.ok(Date.now() - started < 10_000);
  assert.deepEqual(exit, { code: 1, signal: null }, stderr);
  assert.match(stderr, /EISDIR|illegal operation on a directory/);
  assert.doesNotMatch(stdout, /"url"/, "no URL was published");
});

// ---------------------------------------------------------------- R13D-spec-03: provenance end to end

const PAGE = "Our corporate headquarters are located in the French capital, Paris.";
const PARIS_NOTE = { path: "notes/location.md", content: "---\ntitle: Location\ndescription: Where the company is.\n---\nThe company is based in Paris." };

test("R13D-spec-03: a paraphrase of an untrusted page is held though the grader says keep, and the next run is not given it", { timeout: 60_000 }, async (t) => {
  const fetchPage: ToolDefinition = {
    name: "fetch_page", description: "Fetches the company page.", parameters: { type: "object", properties: {} }, effect: "read",
    untrustedOutput: true, handler: async () => ({ content: PAGE }),
  };
  const app = await startTestApp(t, {
    configure: (config) => {
      config.learning.graderModel = {
        provider: "scripted", name: "scripted-1",
        script: { turns: [], steps: { "learning.grade": { output: { job_finished: true, decisions: [{ path: PARIS_NOTE.path, verdict: "keep", reason: "useful" }] } } } },
      };
    },
    app: { tools: [fetchPage] },
  });
  const { agent } = await app.client.saveAgent(scriptedAgent({
    name: "Researcher", learning: true, tools: [{ name: "fetch_page" }],
    script: { turns: [callTurn("fetch_page", {}), { text: "found it" }], steps: { "learning.propose": { output: { job_finished: true, files: [PARIS_NOTE] } } } },
  }), "researcher");
  const runOnce = async (): Promise<JournalRecord[]> => {
    const { run } = await app.client.startRun({ agentId: agent.id, message: "Where is the company based?" });
    const { run: done } = await waitForStatus(app.client, run.id, ["completed", "failed"]);
    assert.equal(done.status, "completed", JSON.stringify(done.error));
    return fullTimeline(app.client, run.id);
  };
  const first = await runOnce();
  const provenance = first.find((r) => r.type === "step.finished" && r.key === "learning/provenance")?.data["value"] as { path: string; verdict: string; field: string }[];
  assert.deepEqual(provenance.map((v) => [v.path, v.verdict, v.field]), [[PARIS_NOTE.path, "hold", "origin"]]);
  const [item] = await app.client.listLearning({ agentId: agent.id });
  assert.equal(item?.name, "location");
  assert.equal(item?.status, "held", "stored held, not active");

  const second = await runOnce();
  const given = second.find((r) => r.type === "step.finished" && r.key === "learning/given")?.data["value"] as { given: unknown[]; promptSection: string } | undefined;
  assert.ok(given !== undefined, "the second run prepared its learning section");
  assert.deepEqual(given.given, [], "the held note is not given to the next run");
  assert.ok(!given.promptSection.includes("Paris"));
});
