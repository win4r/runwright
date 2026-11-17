/**
 * R06-02, the reviewer's probe through the real workflow executor: a `delete_file` tool node whose runner is killed
 * after the file was unlinked and before `tool.finished` was committed resumes, the engine runs the call again by
 * itself (the tool is declared idempotent), and the node gets `{ok: true}` with `deleted: false` instead of
 * failing the run. Also: the same document without a crash, and parallel deletions of one file in a map.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Json } from "../../../src/core/json.ts";
import type { ToolDefinition } from "../../../src/tools/types.ts";
import { asObject, doc, duplicateFinishes, setupWorkflow, type WorkflowSetup } from "./helpers.ts";

/** Registers `delete_then_crash`: the real `delete_file`, whose first invocation crashes the runner after the unlink. */
function registerDeleteThenCrash(s: WorkflowSetup): () => number {
  const real = s.h.tools.get("delete_file");
  assert.ok(real !== null, "delete_file is registered");
  let invocations = 0;
  const handler: ToolDefinition["handler"] = async (args, context) => {
    invocations += 1;
    const result = await real.handler(args, context);
    if (invocations === 1) await s.h.crashAndReplace();
    return result;
  };
  s.h.tools.register({ ...real, name: "delete_then_crash", handler });
  return () => invocations;
}

const probe = (tool: string) => doc({
  id: "main", kind: "sequence", steps: [
    { id: "mk", kind: "tool", tool: "write_file", args: { path: "done.txt", content: "x" } },
    { id: "del", kind: "tool", tool, args: { path: "done.txt" } },
    { id: "after", kind: "tool", tool: "count", args: { label: "after" } },
  ],
}, { deleted: { $ref: "steps.del.data.deleted" }, ok: { $ref: "steps.del.ok" } });

test("a workflow killed right after delete_file unlinked the file resumes and completes", async (t) => {
  const s = await setupWorkflow(t);
  const invocations = registerDeleteThenCrash(s);
  const agentId = await s.agent({
    workflow: probe("delete_then_crash"),
    tools: [{ name: "write_file" }, { name: "delete_then_crash" }, { name: "count" }],
  });
  const run = await s.h.start(agentId, { data: {} });
  const done = await s.h.until(run.id, ["completed", "failed", "cancelled", "waiting"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.deepEqual(done.output, { deleted: false, ok: true });
  assert.equal(invocations(), 2, "the real handler ran twice");
  assert.equal(s.counters.get("count", "after"), 1);
  await assert.rejects(stat(join(s.h.dir, "workspaces", run.id, "done.txt")));
  const journal = await s.h.journal(run.id);
  assert.deepEqual(duplicateFinishes(journal), []);
  assert.deepEqual(journal.filter((r) => r.type === "tool.started" && r.key === "wf/del#1").map((r) => r.data["attempt"]), [1, 2]);
  assert.equal(journal.filter((r) => r.type === "pending.opened").length, 0);
});

test("the same workflow without a crash deletes the file", async (t) => {
  const s = await setupWorkflow(t);
  const agentId = await s.agent({ workflow: probe("delete_file"), tools: [{ name: "write_file" }, { name: "delete_file" }, { name: "count" }] });
  const done = await s.run(agentId, {});
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.deepEqual(done.output, { deleted: true, ok: true });
  assert.equal(s.counters.get("count", "after"), 1);
});

test("parallel deletions of one file in a map all succeed and exactly one deleted it", async (t) => {
  const s = await setupWorkflow(t);
  const workflow = doc({
    id: "main", kind: "sequence", steps: [
      { id: "mk", kind: "tool", tool: "write_file", args: { path: "shared.txt", content: "x" } },
      {
        id: "m", kind: "map", over: { $ref: "input.paths" }, as: "item", concurrency: 3, maxItems: 3,
        run: { id: "rm", kind: "tool", tool: "delete_file", args: { path: "shared.txt" } },
      },
    ],
  }, { $ref: "steps.m" });
  const agentId = await s.agent({ workflow, tools: [{ name: "write_file" }, { name: "delete_file" }] });
  const done = await s.run(agentId, { paths: ["a", "b", "c"] });
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  const items = done.output as Json[];
  assert.equal(items.length, 3);
  for (const item of items) assert.equal(asObject(item)["ok"], true, JSON.stringify(item));
  const deleted = items.filter((item) => asObject(asObject(item)["data"])["deleted"] === true);
  assert.equal(deleted.length, 1, JSON.stringify(items));
  await assert.rejects(stat(join(s.h.dir, "workspaces", done.id, "shared.txt")));
});
