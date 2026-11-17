/**
 * The engine's half of rule F (finding R15D-tools-01): a session claims its workspace stage before its first step,
 * a saved tool result is published through that stage (so a session whose stage was taken over writes no result
 * file and ends as fenced), and a file mutation that waited in the per-workspace queue while its call was aborted
 * never starts and is journalled the way the cause of the abort says.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Driver, ToolStepResult } from "../../src/engine/types.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import { createFileTools } from "../../src/tools/fs.ts";
import { claimWorkspaceStage, STAGE_DIR } from "../../src/tools/workspace-stage.ts";
import { startSession } from "../../src/engine/session.ts";
import { createHarness, fakeModels, reply } from "../helpers/engine.ts";
import { holdingSeams } from "../helpers/tool-context.ts";
import { waitFor } from "../helpers/wait.ts";

const noModels = fakeModels(() => reply({ text: "unused" }));
const BIG = "r".repeat(40_000);

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

/** A read tool whose result is over the size limit; `before` runs first, with the call's workspace and epoch. */
function bigResultTool(before: (workspace: string, epoch: number) => Promise<void>): ToolDefinition {
  return {
    name: "big", description: "Returns a long text.", parameters: { type: "object", properties: {} }, effect: "read",
    handler: async (_args, context) => {
      await before(context.workspace, context.steps.run.epoch);
      return { content: BIG };
    },
  };
}

const callBig: Driver = async (ctx) => (await ctx.tool("big", { name: "big", args: {} })).content.slice(0, 10);

test("(R15D-tools-01) a session claims its workspace stage before its first step", async (t) => {
  const seen: string[][] = [];
  const h = await createHarness(t, {
    models: noModels, tools: [bigResultTool(async (workspace) => void seen.push(await readdir(join(workspace, STAGE_DIR))))],
    drivers: { agent: callBig },
  });
  const agent = await h.saveAgent({ tools: [{ name: "big" }] });
  const run = await h.start(agent.id);
  await h.until(run.id, "completed");
  assert.deepEqual(seen, [["1"]], "the epoch-1 folder exists when the first step runs");
});

test("(R15D-tools-01) a result over the limit is not saved by a session whose stage a later epoch claimed; the session ends fenced", async (t) => {
  const h = await createHarness(t, {
    models: noModels, tools: [bigResultTool((workspace, epoch) => claimWorkspaceStage(workspace, epoch + 1))],
    drivers: { agent: callBig }, autoStart: false,
  });
  const agent = await h.saveAgent({ tools: [{ name: "big" }] });
  const run = await h.start(agent.id);
  const manual = await h.claimSession();
  await manual.session.done;
  assert.equal(manual.session.ended(), true);
  assert.ok(h.logLines.some((line) => line.includes('"runner.fenced"')), "the session reports that it was fenced");
  const workspace = join(h.dir, "workspaces", run.id);
  assert.equal(await exists(join(workspace, ".runwright", "tool-results")), false, "no result file and no result folder");
  const journal = await h.journal(run.id);
  assert.deepEqual(journal.filter((r) => r.key === "big").map((r) => r.type), ["tool.started"], "no tool.finished was journalled");
  assert.equal(journal.filter((r) => r.type === "run.failed" || r.type === "run.completed").length, 0);
  assert.equal((await h.store.getRun(run.id))?.status, "running", "the run is left to the epoch that claimed it");
});

test("(R15D-tools-01) a result over the limit saved at the current epoch is written, and its journalled digest matches the file", async (t) => {
  const h = await createHarness(t, { models: noModels, tools: [bigResultTool(async () => undefined)], drivers: { agent: callBig } });
  const agent = await h.saveAgent({ tools: [{ name: "big" }] });
  const run = await h.start(agent.id);
  await h.until(run.id, "completed");
  const [finished] = await h.records(run.id, "tool.finished");
  assert.ok(finished !== undefined && finished.fullResultPath !== null);
  const bytes = await readFile(join(h.dir, "workspaces", run.id, finished.fullResultPath));
  assert.equal(bytes.toString("utf8"), BIG);
  assert.equal(finished.fullResultSha256, createHash("sha256").update(bytes).digest("hex"));
  assert.deepEqual(await readdir(join(h.dir, "workspaces", run.id, STAGE_DIR, "1")), [], "no temp file is left in the stage");
});

// ------------------------------------------------------------------ queued mutations aborted while they wait

type Cause = "pause" | "cancel" | "deadline" | "lease_lost";

/**
 * Starts a session whose driver runs two file calls at once: "a" writes `first.txt` and is held at its rename,
 * "b" edits `shared.txt` and waits behind "a" in the workspace queue. The cause aborts "b" while it waits; then
 * "a" is released. Returns the run, the session's end, and the results the driver saw.
 */
async function queuedEdit(t: TestContext, cause: Cause) {
  const held = holdingSeams();
  const real = createFileTools({ maxReadBytes: 4096, maxWriteBytes: 4096, stage: held.seams });
  const signals: AbortSignal[] = [];
  const edits: Promise<unknown>[] = [];
  const tools = real.map((tool): ToolDefinition => (tool.name !== "edit_file" ? tool : {
    ...tool,
    handler: (args, context) => {
      signals.push(context.signal);
      const call = tool.handler(args, context);
      edits.push(call);
      return call;
    },
  }));
  const results: ToolStepResult[] = [];
  const driver: Driver = async (ctx) => {
    const first = ctx.tool("a", { name: "write_file", args: { path: "first.txt", content: "first" } });
    // "b" starts only once "a" holds the queue at its rename, so "b" is the one that waits behind it.
    await held.reached;
    const settled = await Promise.all([
      first,
      ctx.tool("b", {
        name: "edit_file", args: { path: "shared.txt", old_text: "base", new_text: "edited" },
        ...(cause === "deadline" ? { deadlineMs: 50 } : {}),
      }),
    ]);
    results.push(...settled);
    return { a: settled[0].outcome, b: settled[1].outcome };
  };
  const h = await createHarness(t, { models: noModels, tools, drivers: { agent: driver }, autoStart: false });
  t.after(() => held.release());
  const agent = await h.saveAgent({ tools: [{ name: "write_file" }, { name: "edit_file" }] });
  const run = await h.start(agent.id);
  const workspace = join(h.dir, "workspaces", run.id);
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "shared.txt"), "base");
  const { session } = await h.claimSession();
  await held.reached;
  await waitFor(() => signals.length === 1, { timeoutMs: 5000, intervalMs: 5, message: "edit_file was never invoked" });
  if (cause === "pause") await h.send(run.id, { type: "pause" });
  if (cause === "cancel") await h.send(run.id, { type: "cancel", reason: "stop" });
  if (cause === "lease_lost") session.fence("lease_lost");
  await waitFor(() => signals[0]?.aborted === true, { timeoutMs: 5000, intervalMs: 5, message: "the queued edit was never aborted" });
  held.release();
  await session.done;
  // A fenced session stops waiting for its calls; the queued edit's own handler is awaited here.
  await Promise.allSettled(edits);
  assert.equal(held.calls(), 1, "only the first write reached a rename");
  assert.equal(await readFile(join(workspace, "shared.txt"), "utf8"), "base", "the queued edit never touched the file");
  const journal = await h.journal(run.id);
  return { h, run, journal, results, b: journal.filter((r) => r.key === "b") };
}

test("(R15D-tools-01) a queued edit aborted by a pause does not start and is journalled interrupted", async (t) => {
  const { h, run, b } = await queuedEdit(t, "pause");
  assert.deepEqual(b.map((r) => r.type), ["tool.started", "tool.interrupted", "pending.opened"]);
  assert.equal((await h.store.getRun(run.id))?.status, "paused");
});

test("(R15D-tools-01) a queued edit aborted by a cancel does not start and is journalled aborted", async (t) => {
  const { h, run, b } = await queuedEdit(t, "cancel");
  assert.deepEqual(b.map((r) => r.type), ["tool.started", "tool.finished"]);
  assert.equal(b[1]?.data["outcome"], "aborted");
  assert.equal((await h.store.getRun(run.id))?.status, "cancelled");
});

test("(R15D-tools-01) a queued edit stopped by its deadline does not start and returns a timeout", async (t) => {
  const { h, run, b, results } = await queuedEdit(t, "deadline");
  assert.deepEqual(b.map((r) => r.type), ["tool.started", "tool.finished"]);
  assert.equal(b[1]?.data["outcome"], "timeout");
  assert.deepEqual(results.map((r) => r.outcome), ["ok", "timeout"]);
  assert.equal((await h.store.getRun(run.id))?.status, "completed");
});

test("(R15D-tools-01) a queued edit of a session that lost its lease does not start and journals nothing", async (t) => {
  const { h, run, b } = await queuedEdit(t, "lease_lost");
  assert.deepEqual(b.map((r) => r.type), ["tool.started"]);
  assert.equal((await h.store.getRun(run.id))?.status, "running");
});

// ------------------------------------------------------------------ the claim of the stage

test("(R15D-tools-01) a session whose run was taken over before it claimed the stage ends fenced and writes nothing", async (t) => {
  let invoked = 0;
  const h = await createHarness(t, {
    models: noModels, tools: [bigResultTool(async () => void (invoked += 1))], drivers: { agent: callBig }, autoStart: false,
  });
  const agent = await h.saveAgent({ tools: [{ name: "big" }] });
  const run = await h.start(agent.id);
  const [stale] = await h.store.claimRuns({ runnerId: "stale-runner", limit: 1, leaseMs: 1 });
  assert.ok(stale !== undefined);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const [successor] = await h.store.claimRuns({ runnerId: "successor", limit: 1, leaseMs: 30_000 });
  assert.equal(successor?.lease.epoch, 2);
  const workspace = join(h.dir, "workspaces", run.id);
  await mkdir(workspace, { recursive: true });
  await claimWorkspaceStage(workspace, 2);

  const session = startSession(h.deps(), stale, "stale-runner", () => undefined);
  await session.done;
  assert.equal(session.ended(), true);
  assert.equal(invoked, 0, "no step ran");
  assert.ok(h.logLines.some((line) => line.includes('"runner.fenced"')));
  assert.deepEqual((await h.journal(run.id)).map((r) => r.type), ["run.created"], "the stale session wrote no record");
  assert.deepEqual(await readdir(join(workspace, STAGE_DIR)), ["2"], "the successor's folder is untouched");
});

test("(R15D-tools-01) a stage folder of a later epoch that no claim made fails the run instead of fencing it again and again", async (t) => {
  let invoked = 0;
  const h = await createHarness(t, {
    models: noModels, tools: [bigResultTool(async () => void (invoked += 1))], drivers: { agent: callBig }, autoStart: false,
  });
  const agent = await h.saveAgent({ tools: [{ name: "big" }] });
  const run = await h.start(agent.id);
  const workspace = join(h.dir, "workspaces", run.id);
  await mkdir(join(workspace, STAGE_DIR, "999"), { recursive: true });
  h.runner.start();
  const failed = await h.until(run.id, ["failed", "completed"]);
  assert.equal(failed.status, "failed");
  assert.match(failed.error?.message ?? "", /holds a folder of a later epoch than this run's lease \(1\) that no claim made/);
  assert.equal(invoked, 0, "no step ran");
});
