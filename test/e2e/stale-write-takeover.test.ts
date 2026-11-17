/**
 * Brief, section 4, "Lease takeover and fencing", for file effects (finding R15D-tools-01). Runner A runs a
 * scripted agent that calls `write_file` and then `edit_file` on one path. A is stopped between its temp file and
 * its rename (a held rename seam) and stops heartbeating (`abandon()`: its sessions write nothing more to the
 * store, like a frozen or killed process whose system call may still complete). Runner B takes the run over once
 * A's lease expires (epoch 2), runs the write again and the edit, and completes the run. Then A's rename is
 * released: it fails, because B's claim renamed A's staging folder away, so the file keeps B's edited content.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { isRunwrightError } from "../../src/core/errors.ts";
import { createRunner } from "../../src/engine/runner.ts";
import { createFileTools } from "../../src/tools/fs.ts";
import { createToolRegistry } from "../../src/tools/registry.ts";
import type { ToolDefinition, ToolOutput } from "../../src/tools/types.ts";
import { createHarness, fakeModels, reply, toolReply } from "../helpers/engine.ts";
import { holdingSeams } from "../helpers/tool-context.ts";
import { waitFor } from "../helpers/wait.ts";

const LIMITS = { maxReadBytes: 4096, maxWriteBytes: 4096 };

test("(R15D-tools-01) a runner frozen before its rename cannot change the file after another runner took the run over", { timeout: 30_000 }, async (t) => {
  const models = fakeModels((request) => {
    switch (request.meta.turn) {
      case 1: return toolReply("write_file", { path: "doc.txt", content: "draft" }, "w");
      case 2: return toolReply("edit_file", { path: "doc.txt", old_text: "draft", new_text: "final" }, "e");
      default: return reply({ text: "done" });
    }
  });
  const h = await createHarness(t, { models, tools: createFileTools(LIMITS), autoStart: false });

  const held = holdingSeams();
  t.after(() => held.release());
  const staleCalls: Promise<ToolOutput>[] = [];
  const staleTools = createFileTools({ ...LIMITS, stage: held.seams }).map((tool): ToolDefinition => ({
    ...tool,
    handler: (args, context) => {
      const call = tool.handler(args, context);
      staleCalls.push(call);
      return call;
    },
  }));
  const runnerA = createRunner({ ...h.deps(), tools: createToolRegistry(staleTools) });

  const agent = await h.saveAgent({ tools: [{ name: "write_file" }, { name: "edit_file" }] });
  const run = await h.start(agent.id);
  const workspace = join(h.dir, "workspaces", run.id);
  runnerA.start();
  await waitFor(() => held.calls() > 0, { timeoutMs: 5000, message: "runner A never reached the rename of its write" });
  await runnerA.abandon();

  const runnerB = h.newRunner();
  const done = await h.until(run.id, ["completed", "failed", "cancelled", "waiting"], 10_000);
  assert.equal(done.status, "completed");
  assert.deepEqual(done.output, { text: "done" });
  assert.equal(await readFile(join(workspace, "doc.txt"), "utf8"), "final", "B's edit is in place");

  held.release();
  assert.equal(staleCalls.length, 1, "runner A made one file call");
  await assert.rejects(staleCalls[0] as Promise<ToolOutput>, (error: unknown) => isRunwrightError(error) && error.code === "lease_lost");
  assert.equal(await readFile(join(workspace, "doc.txt"), "utf8"), "final", "A's late rename did not change the file");

  const journal = await h.journal(run.id);
  const claims = journal.filter((r) => r.type === "run.claimed");
  assert.deepEqual(claims.map((r) => [r.epoch, r.data["runnerId"]]), [[1, runnerA.id], [2, runnerB.id]]);
  const takeover = claims[1]?.seq ?? Infinity;
  assert.deepEqual(journal.filter((r) => r.seq > takeover && r.epoch !== 2), [], "no record of A's epoch after the takeover");
  assert.deepEqual(
    journal.filter((r) => r.type === "tool.finished").map((r) => [r.epoch, r.data["tool"], r.data["outcome"]]),
    [[2, "write_file", "ok"], [2, "edit_file", "ok"]],
  );
  const leftovers = (await readdir(workspace, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.(tmp|del)$/.test(entry.name));
  assert.deepEqual(leftovers, [], "no temp file is left anywhere in the workspace");
});
