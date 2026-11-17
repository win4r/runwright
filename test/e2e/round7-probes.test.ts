/**
 * Saved tool results and the idempotent `delete_file`, end to end through `createApp`, the HTTP API (the client),
 * the real workflow runtime and the real agent loop.
 *
 * Finding R06-01: a map `a` whose body is the tool node `b`, beside a tool node named `a_0__b`, gives the step
 * keys `wf/a[0]/b#1` and `wf/a_0__b#1`, which read alike once sanitized. Both over-long results finish in the
 * same tick (a barrier); each keeps its own text and data files, and every file has its journalled digest.
 * A skipped call whose supplied result is over the limit is cut like any other result, and its file is saved.
 *
 * Finding R06-02: a workflow's `delete_file` call (the real handler under another name) unlinks the file, and the
 * hosting runner dies before `tool.finished` is committed. A second app on the same data directory takes the run
 * over, runs the call again by itself, gets `deleted: false` (not an error) and completes the run.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentDefinition } from "../../src/agents/definition.ts";
import type { App } from "../../src/app/app.ts";
import type { RunwrightClient } from "../../src/client/index.ts";
import { canonicalJson } from "../../src/core/json.ts";
import type { JournalDataMap } from "../../src/engine/journal-types.ts";
import { savedResultName } from "../../src/engine/results.ts";
import { createFileTools } from "../../src/tools/fs.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import { WORKFLOW_FORMAT, type WorkflowDocument, type WorkflowNode } from "../../src/workflow/types.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { waitFor } from "../helpers/wait.ts";
import { startTestApp } from "../fixtures/app.ts";
import { createHostTools } from "../fixtures/host-tools.ts";
import { callTurn, effectLines, fullTimeline, scriptedAgent, waitForStatus } from "../fixtures/runs.ts";

type Finished = JournalDataMap["tool.finished"];

const FILL = 40_000;
const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

function workflowAgent(name: string, root: WorkflowNode, result: WorkflowDocument["result"], tools: string[]): AgentDefinition {
  const definition = scriptedAgent({ name, script: { turns: [] }, tools: tools.map((tool) => ({ name: tool })) });
  definition.workflow = {
    format: WORKFLOW_FORMAT, name: "probe_flow", schemas: { Input: { type: "object" }, Output: {} },
    input: "Input", output: "Output", root, result,
  };
  return definition;
}

/** A read tool `big` with args `{fill}` whose invocations return only once two of them have arrived. */
function barrierTool(): ToolDefinition {
  let arrived = 0;
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    name: "big", description: "Returns a long result once two calls are in flight.", effect: "read",
    parameters: { type: "object", required: ["fill"], additionalProperties: false, properties: { fill: { type: "string" } } },
    async handler(args) {
      arrived += 1;
      if (arrived === 2) open();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([gate, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("the second call of big never arrived")), 10_000);
        })]);
      } finally {
        clearTimeout(timer);
      }
      const fill = String(args["fill"]);
      return { content: fill.repeat(FILL), data: { blob: fill.repeat(FILL) } };
    },
  };
}

/** The bytes of a saved result file, through the run-files API. */
async function savedFile(client: RunwrightClient, runId: string, path: string): Promise<Buffer> {
  return Buffer.from((await client.readFile(runId, path)).body);
}

async function verifySaved(
  client: RunwrightClient, runId: string, path: string | null | undefined, digest: string | undefined, bytes: number | undefined, expected: string,
): Promise<void> {
  assert.ok(typeof path === "string", "a saved path is journalled");
  const onDisk = await savedFile(client, runId, path);
  assert.equal(sha256(onDisk), digest, `${path} has its journalled digest`);
  assert.equal(onDisk.length, bytes, `${path} has its journalled length`);
  assert.equal(onDisk.toString("utf8"), expected, `${path} holds its own result`);
}

test("R06-01: two over-long results under keys that sanitize alike, finishing together, keep four intact files", { timeout: 30_000 }, async (t) => {
  const { client } = await startTestApp(t, { app: { tools: [barrierTool()] } });
  const root: WorkflowNode = {
    id: "root", kind: "parallel", branches: [
      {
        id: "a", kind: "map", over: { $ref: "input.items" }, as: "item", concurrency: 1, maxItems: 1,
        run: { id: "b", kind: "tool", tool: "big", args: { fill: "A" } },
      },
      { id: "a_0__b", kind: "tool", tool: "big", args: { fill: "B" } },
    ],
  } as WorkflowNode;
  const { agent } = await client.saveAgent(workflowAgent("Collide", root, null, ["big"]), "collide");
  const { run } = await client.startRun({ agentId: agent.id, data: { items: [0] } });
  const { run: done } = await waitForStatus(client, run.id, ["completed", "failed", "cancelled", "waiting"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));

  const finishes = (await fullTimeline(client, run.id)).filter((r) => r.type === "tool.finished");
  assert.deepEqual(finishes.map((r) => r.key).sort(), ["wf/a[0]/b#1", "wf/a_0__b#1"], "the two keys of the finding");
  const paths = new Set<string>();
  for (const record of finishes) {
    const finished = record.data as unknown as Finished;
    const key = record.key ?? "";
    const fill = key === "wf/a_0__b#1" ? "B" : "A";
    const text = fill.repeat(FILL);
    const json = canonicalJson({ blob: fill.repeat(FILL) });
    assert.equal(finished.truncated, true);
    assert.equal(finished.data, null);
    assert.equal(finished.fullResultPath, `.runwright/tool-results/${savedResultName(key, sha256(text))}.txt`);
    assert.equal(finished.fullDataPath, `.runwright/tool-results/${savedResultName(key, sha256(json))}.data.json`);
    await verifySaved(client, run.id, finished.fullResultPath, finished.fullResultSha256, finished.fullResultBytes, text);
    await verifySaved(client, run.id, finished.fullDataPath, finished.fullDataSha256, finished.fullDataBytes, json);
    paths.add(finished.fullResultPath ?? "");
    paths.add(finished.fullDataPath ?? "");
  }
  assert.equal(paths.size, 4, "four different saved paths");
});

test("R06-01: a skipped call with a 100 000-character supplied result is cut, and the saved file holds all of it", { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t, "runwright-e2e-skip-limit-");
  const first = await startTestApp(t, { dir });
  const { agent } = await first.client.saveAgent(scriptedAgent({
    name: "Skipper", tools: [{ name: "slow_effect" }],
    script: { turns: [callTurn("slow_effect", { label: "w", ms: 20_000 }), { text: "done" }] },
  }), "skipper");
  const { run } = await first.client.startRun({ agentId: agent.id, message: "go" });
  await waitFor(async () => (await effectLines(first.effects)).includes("start:w"), {
    timeoutMs: 10_000, intervalMs: 5, message: "the write call never started",
  });
  assert.ok(first.app.runner !== null);
  await first.app.runner.abandon();

  const second = await startTestApp(t, { dir });
  const { run: waiting } = await waitForStatus(second.client, run.id, ["waiting", "completed", "failed", "cancelled"]);
  assert.equal(waiting.status, "waiting");
  const { pendings } = await second.client.listPendings({ runId: run.id });
  assert.equal(pendings.length, 1);
  assert.equal(pendings[0]?.kind, "interrupted");
  const supplied = "s".repeat(100_000);
  await second.client.resolveInterrupted(pendings[0]?.id ?? "", "skip", supplied);
  const { run: done } = await waitForStatus(second.client, run.id, ["completed", "failed", "cancelled"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));

  const finishes = (await fullTimeline(second.client, run.id)).filter((r) => r.type === "tool.finished");
  assert.equal(finishes.length, 1);
  const finished = finishes[0]?.data as unknown as Finished;
  assert.equal(finished.outcome, "skipped");
  assert.equal(finished.truncated, true);
  const limit = second.app.config.tools.resultBytes;
  assert.equal(finished.content, `${"s".repeat(limit)}\n[truncated: ${limit} of 100000 bytes; full result saved to ${finished.fullResultPath}]`);
  await verifySaved(second.client, run.id, finished.fullResultPath, finished.fullResultSha256, finished.fullResultBytes, supplied);
  assert.equal((await effectLines(second.effects)).filter((line) => line === "start:w").length, 1, "skip did not run the handler");
});

test("R06-02: a workflow whose runner died right after delete_file unlinked the file is taken over and completes", { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t, "runwright-e2e-delete-crash-");
  const real = createFileTools({ maxReadBytes: 1024, maxWriteBytes: 1024 }).find((tool) => tool.name === "delete_file");
  assert.ok(real !== undefined);
  let firstApp: App | null = null;
  let invocations = 0;
  let crashed = false;
  const deleteThenCrash: ToolDefinition = {
    ...real,
    name: "delete_then_crash",
    async handler(args, context) {
      invocations += 1;
      const result = await real.handler(args, context);
      if (invocations === 1) {
        assert.ok(firstApp?.runner != null);
        await firstApp.runner.abandon();
        crashed = true;
      }
      return result;
    },
  };
  const tools = [...createHostTools(join(dir, "effects.txt")), deleteThenCrash];
  const first = await startTestApp(t, { dir, app: { tools } });
  firstApp = first.app;

  const root = {
    id: "main", kind: "sequence", steps: [
      { id: "mk", kind: "tool", tool: "write_file", args: { path: "done.txt", content: "x" } },
      { id: "del", kind: "tool", tool: "delete_then_crash", args: { path: "done.txt" } },
      { id: "after", kind: "tool", tool: "record_effect", args: { label: "after" } },
    ],
  } as WorkflowNode;
  const result = { deleted: { $ref: "steps.del.data.deleted" }, ok: { $ref: "steps.del.ok" } };
  const { agent } = await first.client.saveAgent(workflowAgent("Deleter", root, result, ["write_file", "delete_then_crash", "record_effect"]), "deleter");
  const { run } = await first.client.startRun({ agentId: agent.id, data: {} });
  await waitFor(() => crashed, { timeoutMs: 10_000, intervalMs: 5, message: "the first deletion never ran" });
  await assert.rejects(stat(join(first.app.config.dataDir, "workspaces", run.id, "done.txt")), "the first invocation deleted the file");

  const second = await startTestApp(t, { dir, app: { tools } });
  const { run: done } = await waitForStatus(second.client, run.id, ["completed", "failed", "cancelled", "waiting"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.deepEqual(done.output, { deleted: false, ok: true });
  assert.equal(invocations, 2, "the engine ran the deletion again by itself");

  const records = await fullTimeline(second.client, run.id);
  const claims = records.filter((r) => r.type === "run.claimed").map((r) => r.epoch);
  assert.deepEqual(claims, [1, 2], "the second app took the run over");
  assert.deepEqual(records.filter((r) => r.type === "tool.started" && r.key === "wf/del#1").map((r) => r.data["attempt"]), [1, 2]);
  const finishes = records.filter((r) => r.type === "tool.finished" && r.key === "wf/del#1");
  assert.equal(finishes.length, 1);
  const finished = finishes[0]?.data as unknown as Finished;
  assert.equal(finished.isError, false);
  assert.equal(finished.outcome, "ok");
  assert.equal(finished.content, "done.txt: already absent, nothing to delete");
  assert.deepEqual(finished.data, { path: "done.txt", deleted: false });
  assert.equal(records.filter((r) => r.type === "pending.opened").length, 0, "no pending was opened");
  assert.deepEqual((await second.client.listPendings({ runId: run.id })).pendings, []);
  assert.deepEqual(await effectLines(second.effects), ["after"], "the step after the deletion ran once");
  assert.equal(await readFile(join(second.app.config.dataDir, "workspaces", run.id, "done.txt"), "utf8").catch(() => null), null);
});
