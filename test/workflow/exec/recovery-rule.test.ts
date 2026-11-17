/**
 * Rule R (plan 2.1) inside a workflow: an unfinished call of a tool declared `idempotent` with effect "write" is
 * run again by the engine itself only when no write call of the run finished after it started. A parallel group
 * whose other branch finished a write while the idempotent call was in flight therefore waits for a person after
 * a crash; the same call with no later write is run again on its own.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ToolDefinition } from "../../../src/tools/types.ts";
import { doc, setupWorkflow, untilRecord, type WorkflowSetup } from "./helpers.ts";

/**
 * Registers `idem_write` (effect "write", idempotent): its first invocation waits until the journal holds the
 * `tool.finished` of `waitFor` (when given), then crashes the runner before its own finish is committed.
 */
function registerCrashingWrite(s: WorkflowSetup, runId: () => string, waitFor: string | null): () => number {
  let invocations = 0;
  const tool: ToolDefinition = {
    name: "idem_write", description: "an idempotent write that crashes its runner once", effect: "write", idempotent: true,
    parameters: { type: "object" },
    async handler() {
      invocations += 1;
      if (invocations === 1) {
        if (waitFor !== null) await untilRecord(s.h, runId(), (r) => r.type === "tool.finished" && r.key === waitFor);
        await s.h.crashAndReplace();
      }
      return { content: `written (${invocations})` };
    },
  };
  s.h.tools.register(tool);
  return () => invocations;
}

const TOOLS = [{ name: "idem_write" }, { name: "count" }];

test("an unfinished idempotent write after which another write finished waits as an interrupted call", async (t) => {
  const s = await setupWorkflow(t);
  let id = "";
  const invocations = registerCrashingWrite(s, () => id, "wf/other#1");
  const workflow = doc({ id: "both", kind: "parallel", branches: [
    { id: "idem", kind: "tool", tool: "idem_write", args: {} },
    { id: "other", kind: "tool", tool: "count", args: { label: "other" } },
  ] }, { $ref: "steps.idem.content" });
  const run = await s.h.start(await s.agent({ workflow, tools: TOOLS }), { data: {} });
  id = run.id;
  const waiting = await s.h.until(run.id, ["waiting", "completed", "failed"]);
  assert.equal(waiting.status, "waiting", JSON.stringify(waiting.error));
  const [pending] = await s.h.pendings(run.id);
  assert.equal(pending?.kind, "interrupted");
  assert.equal(pending?.stepKey, "wf/idem#1");
  assert.equal(invocations(), 1, "not run again by itself");
  assert.equal(s.counters.get("count", "other"), 1);
  await s.h.send(run.id, { type: "resolve_interrupted", pendingId: (pending as { id: string }).id, action: "retry", result: null });
  const done = await s.h.until(run.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(done.output, "written (2)");
  assert.equal(s.counters.get("count", "other"), 1, "the finished write is not repeated");
});

test("an unfinished idempotent write with no later finished write is run again by itself", async (t) => {
  const s = await setupWorkflow(t);
  const invocations = registerCrashingWrite(s, () => "", null);
  const workflow = doc({ id: "main", kind: "sequence", steps: [
    { id: "before", kind: "tool", tool: "count", args: { label: "before" } },
    { id: "idem", kind: "tool", tool: "idem_write", args: {} },
  ] }, { $ref: "steps.idem.content" });
  const done = await s.run(await s.agent({ workflow, tools: TOOLS }), {}, ["completed", "failed", "waiting"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(done.output, "written (2)");
  assert.equal(invocations(), 2);
  assert.deepEqual(await s.h.pendings(done.id), []);
});
