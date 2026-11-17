/**
 * Finding R11-02, completeness against the real writers: one app per configuration, the scripted model, and the
 * scenarios an operator runs (an agent loop with a tool call, a question, an approval, a spend-cap pause and raise,
 * a failed provider attempt that is retried, a large tool result, a message while running, a pause and a cancel;
 * a workflow with a model step, a decision, a map, a retried node and a wait; a learning run that keeps a note).
 * Every journal record of every run whose type is in RECORD_FIELDS must be named by it field for field
 * (`unlistedPaths` is empty): a field a writer emits and the table lacks fails here. The same scenarios run on a
 * second app that holds the numeric secret PIN = 12345678 (handed to every run, passed in as run data and
 * returned by a tool): the runs reach the same statuses, and no database cell holds any form of the digits.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp, type App } from "../../src/app/app.ts";
import { createClient, type RunwrightClient } from "../../src/client/index.ts";
import { loadConfig } from "../../src/config/load.ts";
import type { Json } from "../../src/core/json.ts";
import { isEngineRecordType, RECORD_FIELDS, unlistedPaths } from "../../src/store/record-fields.ts";
import type { JournalRecord, PendingRecord, RunStatus } from "../../src/store/types.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import type { WorkflowDocument } from "../../src/workflow/types.ts";
import { scanDatabase } from "../security/at-rest.ts";
import { itemFile, keepAll } from "../learning/support.ts";
import { callTurn, scriptedAgent, waitForStatus } from "../fixtures/runs.ts";
import { waitFor } from "../helpers/wait.ts";

const DIGITS = "12345678";
const PIN = 12345678;
const FINISHED: RunStatus[] = ["completed", "failed", "cancelled"];

/** Record types seen in the scenarios (both apps). */
const seen = new Set<string>();
/** Run statuses by scenario label, per app. */
const statuses: Record<"plain" | "secret", Record<string, RunStatus>> = { plain: {}, secret: {} };

const flakyCalls = new Map<string, number>();
const tools: ToolDefinition[] = [
  {
    name: "echo_pin", description: "Returns a number it holds.", parameters: { type: "object", properties: {} }, effect: "read",
    handler: async () => ({ content: `pin ${PIN}`, data: { pin: PIN, list: [PIN, 7] } }),
  },
  {
    name: "big_result", description: "Returns a result over the size limit.", parameters: { type: "object", properties: {} }, effect: "read",
    handler: async () => ({ content: `${"x".repeat(600)} ${PIN}`, data: { pad: "y".repeat(600), pin: PIN } }),
  },
  {
    name: "guarded", description: "Needs approval.", parameters: { type: "object", properties: { note: { type: "string" } } }, effect: "write",
    handler: async (args) => ({ content: `guarded ${String(args["note"])}` }),
  },
  {
    name: "flaky", description: "Fails on its first call in a run.", parameters: { type: "object", properties: {} }, effect: "read",
    handler: async (_args, context) => {
      const calls = (flakyCalls.get(context.runId) ?? 0) + 1;
      flakyCalls.set(context.runId, calls);
      if (calls === 1) throw new Error("flaky upstream");
      return { content: "steady" };
    },
  },
];

interface Host { app: App; client: RunwrightClient; dir: string; kind: "plain" | "secret" }
const hosts: Host[] = [];

async function startHost(kind: "plain" | "secret"): Promise<Host> {
  const dir = await mkdtemp(join(tmpdir(), `runwright-vocab-${kind}-`));
  const config = await loadConfig({ env: {}, overrides: { dataDir: join(dir, "data"), port: 0, leaseMs: 400, pollMs: 20 } });
  config.tools.resultBytes = 256;
  config.models.retry = { maxAttempts: 3, baseMs: 1, maxMs: 5, maxRetryAfterMs: 1000 };
  const consolePath = join(dir, "console.html");
  await writeFile(consolePath, "<!doctype html><title>Runwright</title>\n");
  const app = await createApp({ config, env: {}, consolePath, tools, logWrite: () => undefined });
  await app.start();
  const client = createClient({ baseUrl: app.url, token: app.token });
  // Both apps hand every run a secret named PIN; only the second one's value is the digits.
  await client.setSecret("PIN", kind === "secret" ? DIGITS : "unrelated-value-0");
  return { app, client, dir, kind };
}

before(async () => {
  hosts.push(await startHost("plain"));
  hosts.push(await startHost("secret"));
});

after(async () => {
  for (const host of hosts) {
    await host.app.stop({ graceMs: 200 });
    await rm(host.dir, { recursive: true, force: true });
  }
});

async function journalOf(host: Host, runId: string): Promise<JournalRecord[]> {
  const out: JournalRecord[] = [];
  for (;;) {
    const page = await host.app.store.readJournal(runId, { afterSeq: out.length === 0 ? 0 : (out[out.length - 1] as JournalRecord).seq, limit: 1000 });
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

/** Every engine record of the run is named by RECORD_FIELDS; the types are added to `seen`. */
async function checkRun(host: Host, label: string, runId: string): Promise<void> {
  const journal = await journalOf(host, runId);
  const unnamed: string[] = [];
  for (const record of journal) {
    seen.add(record.type);
    if (!isEngineRecordType(record.type)) continue;
    for (const path of unlistedPaths(record.data, RECORD_FIELDS[record.type] as never)) unnamed.push(`${record.type} ${path} = ${JSON.stringify(atPath(record.data, path))}`);
  }
  assert.deepEqual(unnamed, [], `${host.kind} ${label}: every field a writer emitted is in RECORD_FIELDS`);
  statuses[host.kind][label] = (await host.client.getRun(runId)).run.status;
}

/** The value at a `$.a.b[0]` path (for the failure message). */
function atPath(value: Json, path: string): Json | undefined {
  let current: Json | undefined = value;
  for (const part of path.slice(1).match(/\.[A-Za-z_$][\w$]*|\[\d+\]|\["(?:[^"\\]|\\.)*"\]/g) ?? []) {
    if (current === null || typeof current !== "object") return undefined;
    const key: string | number = part.startsWith(".") ? part.slice(1) : part.startsWith('["') ? JSON.parse(part.slice(1, -1)) as string : Number(part.slice(1, -1));
    current = Array.isArray(current) ? current[key as number] : (current as Record<string, Json>)[key as string];
  }
  return current;
}

async function openPending(client: RunwrightClient, runId: string, kind: PendingRecord["kind"], notIds: readonly string[] = []): Promise<PendingRecord> {
  return waitFor(async () => {
    const { run, pendings } = await client.getRun(runId);
    if (FINISHED.includes(run.status)) throw new Error(`run ${runId} ended ${run.status} waiting for a ${kind} pending: ${JSON.stringify(run.error)}`);
    return pendings.find((p) => p.kind === kind && !notIds.includes(p.id)) ?? null;
  }, { timeoutMs: 6000, intervalMs: 15, message: `no open ${kind} pending on ${runId}` });
}

/** Runs `scenario` on both apps at once. */
async function onBoth(scenario: (host: Host) => Promise<void>): Promise<void> {
  await Promise.all(hosts.map(scenario));
}

test("an agent loop: tool call, retried provider attempt, large result, cap pause and raise, approval, question, message", { timeout: 30_000 }, async () => {
  await onBoth(async (host) => {
    const { client } = host;
    const { agent } = await client.saveAgent(scriptedAgent({
      name: "Loop", secrets: ["PIN"], model: { maxOutputTokens: 100 },
      tools: [{ name: "echo_pin" }, { name: "big_result" }, { name: "guarded", policy: "ask" }, { name: "ask_person" }],
      script: {
        turns: [
          callTurn("echo_pin", {}, { fail: { attempts: 1, status: 503 } }),
          callTurn("big_result", {}),
          callTurn("guarded", { note: "careful" }),
          callTurn("ask_person", { question: "Go on?" }),
          { text: "all done" },
        ],
      },
    }), "loop");
    const { run } = await client.startRun({ agentId: agent.id, message: "go", data: { credential: PIN, nested: [PIN] }, limits: { maxCostMicros: 1 } });
    await openPending(client, run.id, "spend_cap");
    await client.setLimits(run.id, { maxCostMicros: 5_000_000 });
    const approval = await openPending(client, run.id, "approval");
    await client.approve(approval.id);
    const question = await openPending(client, run.id, "question");
    await client.sendMessage(run.id, `please also remember ${DIGITS}`);
    await client.answer(question.id, `yes, ${DIGITS}`);
    const { run: done } = await waitForStatus(client, run.id, FINISHED, 8000);
    assert.equal(done.status, "completed", JSON.stringify(done.error));
    await checkRun(host, "loop", run.id);
  });
});

test("an agent loop that is paused while it waits, resumed and cancelled; one whose provider keeps failing", { timeout: 30_000 }, async () => {
  await onBoth(async (host) => {
    const { client } = host;
    const { agent } = await client.saveAgent(scriptedAgent({
      name: "Asker", secrets: ["PIN"], tools: [{ name: "ask_person" }],
      script: { turns: [callTurn("ask_person", { question: "Shall I?" }), { text: "never reached" }] },
    }), "asker");
    const { run } = await client.startRun({ agentId: agent.id, message: "ask", data: { pin: PIN } });
    const question = await openPending(client, run.id, "question");
    await client.pauseRun(run.id);
    await waitForStatus(client, run.id, ["paused"], 6000);
    await client.resumeRun(run.id);
    await waitForStatus(client, run.id, ["waiting"], 6000);
    await client.answer(question.id, "first");
    await client.answer(question.id, "second, too late").catch(() => undefined);
    await waitForStatus(client, run.id, FINISHED, 6000);
    await checkRun(host, "asker", run.id);

    const { run: cancelled } = await client.startRun({ agentId: agent.id, message: "ask again" });
    await openPending(client, cancelled.id, "question");
    await client.cancelRun(cancelled.id, `no longer needed ${DIGITS}`);
    const { run: gone } = await waitForStatus(client, cancelled.id, FINISHED, 6000);
    assert.equal(gone.status, "cancelled");
    await checkRun(host, "cancelled", cancelled.id);

    const { agent: broken } = await client.saveAgent(scriptedAgent({
      name: "Broken", secrets: ["PIN"], script: { turns: [{ text: "x", fail: { attempts: 99, status: 400, message: "bad request" } }] },
    }), "broken");
    const { run: failing } = await client.startRun({ agentId: broken.id, message: "fail" });
    const { run: failed } = await waitForStatus(client, failing.id, FINISHED, 6000);
    assert.equal(failed.status, "failed");
    await checkRun(host, "failed", failing.id);
  });
});

const WORKFLOW: WorkflowDocument = {
  format: "runwright.workflow/v1",
  name: "vocab",
  schemas: {
    In: { type: "object" },
    Summary: { type: "object", required: ["summary"], properties: { summary: { type: "string" } } },
    Out: { type: "string" },
  },
  input: "In",
  output: "Out",
  root: {
    id: "main", kind: "sequence", steps: [
      { id: "summarize", kind: "model", prompt: "Summarize {{input.topic}}", output: "Summary" },
      { id: "check", kind: "decide", question: "Is {{input.topic}} fine?", decision: { type: "yes_no" } },
      {
        id: "each", kind: "map", over: { $ref: "input.items" }, as: "item", concurrency: 2, maxItems: 5,
        run: { id: "echo", kind: "tool", tool: "echo_pin", args: {} },
      },
      { id: "shaky", kind: "tool", tool: "flaky", args: {}, retry: { maxAttempts: 3, backoffMs: 1 } },
      { id: "confirm", kind: "wait", question: "Ship it?", choices: ["yes", "no"] },
    ],
  },
  result: { $ref: "steps.confirm.answer" },
} as unknown as WorkflowDocument;

test("a workflow: model step, decision, map, a retried node and a wait", { timeout: 30_000 }, async () => {
  await onBoth(async (host) => {
    const { client } = host;
    const { agent } = await client.saveAgent({
      ...scriptedAgent({
        name: "Flow", secrets: ["PIN"], tools: [{ name: "echo_pin" }, { name: "flaky" }],
        script: {
          steps: {
            summarize: { output: { summary: "short" } },
            check: { output: { value: true, confidence: 0.9, reason: "looks fine" } },
          },
        },
      }),
      workflow: WORKFLOW,
    }, "flow");
    const { run } = await client.startRun({ agentId: agent.id, data: { topic: `topic ${DIGITS}`, items: [PIN, "b"] } });
    const question = await openPending(client, run.id, "question");
    await client.sendMessage(run.id, "a message no step reads");
    await client.answer(question.id, "yes");
    const { run: done } = await waitForStatus(client, run.id, FINISHED, 8000);
    assert.equal(done.status, "completed", JSON.stringify(done.error));
    await checkRun(host, "workflow", run.id);
  });
});

const NOTE = { path: "notes/style.md", content: itemFile("House style", "How reports are written here.", "Write short sentences.") };

test("learning: a run keeps a note and the next run is given it", { timeout: 30_000 }, async () => {
  await onBoth(async (host) => {
    const { client } = host;
    const { agent } = await client.saveAgent(scriptedAgent({
      name: "Learner", secrets: ["PIN"], learning: true, tools: [{ name: "echo_pin" }],
      script: {
        turns: [callTurn("echo_pin", {}), { text: "report written" }],
        steps: { "learning.propose": { output: { job_finished: true, files: [NOTE] } }, "learning.grade": keepAll([NOTE.path]) },
      },
    }), "learner");
    for (const label of ["learn-1", "learn-2"]) {
      const { run } = await client.startRun({ agentId: agent.id, message: "write the report", data: { pin: PIN } });
      const { run: done } = await waitForStatus(client, run.id, FINISHED, 8000);
      assert.equal(done.status, "completed", JSON.stringify(done.error));
      await checkRun(host, label, run.id);
    }
    const items = await client.listLearning({ agentId: agent.id });
    assert.equal(items.length, 1, "the note was kept");
  });
});

test("with the numeric secret set the runs reach the same statuses and no database cell holds a form of it", () => {
  assert.ok(Object.keys(statuses.plain).length >= 7, JSON.stringify(statuses));
  assert.deepEqual(statuses.secret, statuses.plain);
  const secret = hosts.find((host) => host.kind === "secret") as Host;
  assert.deepEqual(scanDatabase(join(secret.app.config.dataDir, "runwright.db"), DIGITS), []);
  const plain = hosts.find((host) => host.kind === "plain") as Host;
  assert.ok(scanDatabase(join(plain.app.config.dataDir, "runwright.db"), DIGITS).length > 0, "without the secret the digits are stored: the scan sees them");
});

test("the scenarios wrote at least 25 of the table's record types", () => {
  // The scenarios write 30 types. Not reached here, and why: model.invalid (a structured step whose first reply
  // misses its schema), model.interrupted and tool.interrupted (a crash or forced shutdown mid-call),
  // run.released (a shutdown while a run is claimed), context.compacted (a conversation near the context
  // budget), learning.skipped (a learning turn that could not run) and learning.promotion (a skill that served
  // enough runs). Each needs a crash, a shutdown or many runs; for them the table follows JournalDataMap, and the
  // samples of test/store/batch-redaction.test.ts hold every field it declares.
  const covered = Object.keys(RECORD_FIELDS).filter((type) => seen.has(type));
  assert.ok(covered.length >= 25, `${covered.length} types: ${covered.join(", ")}; missing: ${Object.keys(RECORD_FIELDS).filter((type) => !seen.has(type)).join(", ")}`);
});
