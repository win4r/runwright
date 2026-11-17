/**
 * Rule R through the real app (R14-01). E1: in a workflow's parallel group, branch A deletes x and stalls before
 * its `tool.finished` is committed; branch B then writes x and finishes; the process dies (its runner is
 * abandoned) and a second app on the same data directory takes the run over. Running the delete again would
 * remove the file a finished step wrote, so the call waits for a person instead, and x keeps B's content.
 * E2: the headline case stays true: a sequential agent run killed between `tool.started` and `tool.finished` of
 * an idempotent write, with nothing finished after it, completes by itself after the restart.
 *
 * The stall is in the tool: `stalled_delete` / `stalled_write` are the real `delete_file` / `write_file` (same
 * declaration, so idempotent with effect "write") whose handler does the real work and then, in the first app,
 * waits until its call is aborted. No engine or app seam stalls the commit of a finished call itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RunwrightError } from "../../src/core/errors.ts";
import type { JournalRecord, PendingRecord } from "../../src/store/types.ts";
import { createFileTools } from "../../src/tools/fs.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import { WORKFLOW_FORMAT, type WorkflowDocument } from "../../src/workflow/types.ts";
import { cli } from "../cli/support.ts";
import { startTestApp, type TestApp } from "../fixtures/app.ts";
import { callTurn, scriptedAgent } from "../fixtures/runs.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { waitFor } from "../helpers/wait.ts";

function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(new RunwrightError("aborted", "aborted"));
    signal.addEventListener("abort", () => reject(new RunwrightError("aborted", "aborted")), { once: true });
  });
}

/** The real file tool `name` under `as`; with `stall`, its handler waits for an abort after doing the work. */
function stalled(name: "delete_file" | "write_file", as: string, stall: boolean): ToolDefinition {
  const real = createFileTools({ maxReadBytes: 65_536, maxWriteBytes: 65_536 }).find((tool) => tool.name === name);
  assert.ok(real !== undefined);
  return {
    ...real,
    name: as,
    async handler(args, context) {
      const result = await real.handler(args, context);
      if (stall) await untilAborted(context.signal);
      return result;
    },
  };
}

/** A read-only tool that returns once `path` is absent from the workspace. */
const awaitAbsent: ToolDefinition = {
  name: "await_absent", description: "waits until a file is gone", effect: "read",
  parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
  async handler(args, context) {
    const path = join(context.workspace, String(args["path"]));
    for (;;) {
      try {
        await readFile(path);
      } catch {
        return { content: "absent" };
      }
      if (context.signal.aborted) throw new RunwrightError("aborted", "aborted");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  },
};

async function journalOf(app: TestApp, runId: string): Promise<JournalRecord[]> {
  return app.app.store.readJournal(runId, { afterSeq: 0, limit: 10_000 });
}

async function statusOf(app: TestApp, runId: string, statuses: string[], timeoutMs = 15_000) {
  return waitFor(async () => {
    const run = await app.app.store.getRun(runId);
    return run !== null && statuses.includes(run.status) ? run : null;
  }, { timeoutMs, intervalMs: 20 });
}

/** The first app dies: its runner is fenced at once (nothing more is written), then its store is closed. */
async function crash(app: TestApp): Promise<void> {
  assert.ok(app.app.runner !== null);
  await app.app.runner.abandon();
  await app.app.stop({ graceMs: 50 });
}

const workflow: WorkflowDocument = {
  format: WORKFLOW_FORMAT, name: "delete_and_write", schemas: { Input: { type: "object" }, Output: {} }, input: "Input", output: "Output",
  root: {
    id: "main", kind: "sequence", steps: [
      { id: "mk", kind: "tool", tool: "write_file", args: { path: "x.txt", content: "old" } },
      {
        id: "both", kind: "parallel", branches: [
          { id: "drop", kind: "tool", tool: "stalled_delete", args: { path: "x.txt" } },
          {
            id: "after", kind: "sequence", steps: [
              { id: "gone", kind: "tool", tool: "await_absent", args: { path: "x.txt" } },
              { id: "put", kind: "tool", tool: "write_file", args: { path: "x.txt", content: "from B" } },
            ],
          },
        ],
      },
    ],
  },
  result: null,
};

test("E1: a delete left unfinished before a parallel write finished waits for a person after a restart; skip completes the run", { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t, "runwright-e2e-order-");
  const first = await startTestApp(t, { dir, app: { tools: [stalled("delete_file", "stalled_delete", true), awaitAbsent] } });
  const { agent } = await first.app.store.saveAgent({
    id: "order",
    definition: {
      ...scriptedAgent({ name: "Order", script: {}, tools: [{ name: "write_file" }, { name: "stalled_delete" }, { name: "await_absent" }] }),
      workflow,
    },
  });
  const { run } = await first.app.store.createRun({ agentId: agent.id, input: { message: "go", data: {} } });
  const isPut = (r: JournalRecord): boolean => r.type === "tool.finished" && (r.key ?? "").includes("put");
  await waitFor(async () => (await journalOf(first, run.id)).some(isPut), { timeoutMs: 15_000, message: "B's write never finished" });
  const workspace = join(dir, "data", "workspaces", run.id);
  assert.equal(await readFile(join(workspace, "x.txt"), "utf8"), "from B");
  await crash(first);

  const second = await startTestApp(t, { dir, app: { tools: [stalled("delete_file", "stalled_delete", false), awaitAbsent] } });
  const waiting = await statusOf(second, run.id, ["waiting", "completed", "failed"]);
  assert.equal(waiting.status, "waiting", JSON.stringify(waiting.error));
  const { pendings } = await second.client.listPendings({ runId: run.id });
  assert.equal(pendings.length, 1);
  const [pending] = pendings as [PendingRecord];
  assert.equal(pending.kind, "interrupted");
  assert.equal(pending.detail["tool"], "stalled_delete");
  assert.equal(await readFile(join(workspace, "x.txt"), "utf8"), "from B", "the finished write was not undone");
  const journal = await journalOf(second, run.id);
  assert.equal(journal.filter(isPut).length, 1, "B's write finished exactly once");
  assert.equal(journal.filter((r) => r.type === "tool.started" && (r.key ?? "").includes("put")).length, 1, "and was not run again");
  assert.equal(journal.filter((r) => r.type === "tool.interrupted").length, 1);

  await second.client.resolveInterrupted(pending.id, "skip", "kept the newer file");
  const done = await statusOf(second, run.id, ["completed", "failed", "cancelled"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(await readFile(join(workspace, "x.txt"), "utf8"), "from B");
});

test("E2: a sequential agent run killed inside an idempotent write completes by itself after the restart", { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t, "runwright-e2e-order-");
  const first = await startTestApp(t, { dir, app: { tools: [stalled("write_file", "stalled_write", true)] } });
  const { agent } = await first.app.store.saveAgent({
    id: "writer",
    definition: scriptedAgent({
      name: "Writer", tools: [{ name: "stalled_write" }],
      script: { turns: [callTurn("stalled_write", { path: "note.txt", content: "hello" }), { text: "done: {{last_result}}" }] },
    }),
  });
  const { run } = await first.app.store.createRun({ agentId: agent.id, input: { message: "go", data: null } });
  const workspace = join(dir, "data", "workspaces", run.id);
  await waitFor(async () => {
    try {
      return (await readFile(join(workspace, "note.txt"), "utf8")) === "hello";
    } catch {
      return false;
    }
  }, { timeoutMs: 15_000 });
  const before = await journalOf(first, run.id);
  assert.equal(before.filter((r) => r.type === "tool.started").length, 1);
  assert.equal(before.filter((r) => r.type === "tool.finished").length, 0, "killed between tool.started and tool.finished");
  await crash(first);

  const second = await startTestApp(t, { dir, app: { tools: [stalled("write_file", "stalled_write", false)] } });
  const done = await statusOf(second, run.id, ["completed", "waiting", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  const journal = await journalOf(second, run.id);
  assert.equal(journal.filter((r) => r.type === "pending.opened").length, 0, "nothing waited for a person");
  assert.deepEqual(journal.filter((r) => r.type === "tool.started").map((r) => r.data["attempt"]), [1, 2]);
  assert.equal(await readFile(join(workspace, "note.txt"), "utf8"), "hello");
});

test("E3: the interrupted pending rule R opens has the one pending shape: `runwright runs resolve` settles it each of the three ways", { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t, "runwright-e2e-order-");
  const dataDir = join(dir, "data");
  const first = await startTestApp(t, { dir, app: { tools: [stalled("delete_file", "stalled_delete", true), awaitAbsent] } });
  const { agent } = await first.app.store.saveAgent({
    id: "order",
    definition: {
      ...scriptedAgent({ name: "Order", script: {}, tools: [{ name: "write_file" }, { name: "stalled_delete" }, { name: "await_absent" }] }),
      workflow,
    },
  });
  const runs: string[] = [];
  for (let i = 0; i < 3; i++) runs.push((await first.app.store.createRun({ agentId: agent.id, input: { message: "go", data: {} } })).run.id);
  const isPut = (r: JournalRecord): boolean => r.type === "tool.finished" && (r.key ?? "").includes("put");
  for (const runId of runs) {
    await waitFor(async () => (await journalOf(first, runId)).some(isPut), { timeoutMs: 15_000, message: `B's write of ${runId} never finished` });
  }
  await crash(first);

  const second = await startTestApp(t, { dir, app: { tools: [stalled("delete_file", "stalled_delete", false), awaitAbsent] } });
  const pendingOf = async (runId: string): Promise<PendingRecord> => {
    assert.equal((await statusOf(second, runId, ["waiting", "completed", "failed"])).status, "waiting");
    const { pendings } = await second.client.listPendings({ runId });
    assert.deepEqual(pendings.map((p) => [p.kind, p.detail["tool"]]), [["interrupted", "stalled_delete"]]);
    return pendings[0] as PendingRecord;
  };
  const [retryRun, skipRun, cancelRun] = runs as [string, string, string];
  for (const runId of runs) await pendingOf(runId);

  const retried = await cli(["runs", "resolve", retryRun, "--action", "retry", "--json"], { dataDir });
  assert.equal(retried.code, 0, retried.stderr);
  const skipped = await cli(["runs", "resolve", skipRun, "--action", "skip", "--result", "kept the newer file", "--json"], { dataDir });
  assert.equal(skipped.code, 0, skipped.stderr);
  const cancelled = await cli(["runs", "resolve", cancelRun, "--action", "cancel", "--json"], { dataDir });
  assert.equal(cancelled.code, 0, cancelled.stderr);

  const file = (runId: string): Promise<string | null> => readFile(join(dataDir, "workspaces", runId, "x.txt"), "utf8").catch(() => null);
  assert.equal((await statusOf(second, retryRun, ["completed", "failed", "cancelled"])).status, "completed");
  assert.equal(await file(retryRun), null, "retry: the person chose to run the delete again");
  assert.equal((await statusOf(second, skipRun, ["completed", "failed", "cancelled"])).status, "completed");
  assert.equal(await file(skipRun), "from B", "skip: the finished write is kept");
  assert.equal((await statusOf(second, cancelRun, ["completed", "failed", "cancelled"])).status, "cancelled");
  assert.equal(await file(cancelRun), "from B");
});
