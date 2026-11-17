/**
 * R06-02 through the real engine and the agent-style driver: a `delete_file` call whose runner died after the file
 * was unlinked and before `tool.finished` was committed is run again by itself (the tool is declared idempotent),
 * and the second invocation reports the absent file as a success, so the model is not told that the deletion
 * failed. The contrast test pins that the automatic re-run follows the tool's declaration: a tool that is not
 * declared idempotent still waits for a person.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonObject } from "../../src/core/json.ts";
import type { ModelRequest } from "../../src/models/types.ts";
import { newRecord } from "../../src/engine/journal-types.ts";
import { createFileTools } from "../../src/tools/fs.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import { createHarness, fakeModels, reply, toolReply, type Harness } from "../helpers/engine.ts";

const fileTools = (): ToolDefinition[] => createFileTools({ maxReadBytes: 65_536, maxWriteBytes: 65_536 });

interface SeenToolMessage { content: string; isError: boolean }

function lastToolMessage(request: ModelRequest): SeenToolMessage | null {
  const tools = request.messages.filter((m) => m.role === "tool");
  const last = tools[tools.length - 1];
  return last !== undefined && last.role === "tool" ? { content: last.content, isError: last.isError } : null;
}

/** Turn n < calls.length + 1 calls `calls[n - 1]`; the next turn answers with the last tool message it received. */
function modelsCalling(calls: readonly { name: string; args: JsonObject }[], seen: SeenToolMessage[]) {
  return fakeModels((request) => {
    const turn = request.meta.turn;
    const call = calls[turn - 1];
    if (call !== undefined) return toolReply(call.name, call.args);
    const last = lastToolMessage(request);
    if (last !== null) seen.push(last);
    return reply({ text: last?.content ?? "" });
  });
}

/**
 * The journal of a runner that died between tool.started and tool.finished: claimed by a dead runner with a short
 * lease, turn 1 finished with one call of `tool` with `args`, the call journalled as started.
 */
async function crashedRun(h: Harness, agentId: string, tool: string, args: JsonObject): Promise<string> {
  const run = await h.start(agentId);
  const [claimed] = await h.store.claimRuns({ runnerId: "runner_dead", limit: 1, leaseMs: 50 });
  assert.ok(claimed !== undefined && claimed.run.id === run.id);
  const model = "scripted/scripted-1";
  await h.store.commit(claimed.lease, {
    records: [
      newRecord("run.claimed", { runnerId: "runner_dead" }),
      newRecord("model.started", {
        model, purpose: "run", step: null, turn: 1, countsAsTurn: true, inputTokensEstimate: 10, maxOutputTokens: 100, worstCaseMicros: 510,
      }, "t1"),
      newRecord("model.finished", {
        model, purpose: "run", text: "", toolCalls: [{ id: "call_1", name: tool, args }], output: null, stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, costMicros: 35, durationMs: 1,
      }, "t1"),
      newRecord("tool.started", { callId: "call_1", tool, args, effect: "write", attempt: 1 }, "t1.c0"),
    ],
    counters: { toolCalls: 1, turns: 1 },
  });
  return run.id;
}

test("a delete_file call left started by a dead runner after the unlink is run again and succeeds", async (t) => {
  const seen: SeenToolMessage[] = [];
  const h = await createHarness(t, { models: modelsCalling([], seen), tools: fileTools(), autoStart: false });
  const agent = await h.saveAgent({ tools: [{ name: "delete_file" }] });
  const runId = await crashedRun(h, agent.id, "delete_file", { path: "done.txt" });
  h.runner.start();
  const done = await h.until(runId, ["completed", "failed", "waiting"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal((await h.records(runId, "pending.opened")).length, 0, "no pending was opened");
  const journal = await h.journal(runId);
  assert.deepEqual(journal.filter((r) => r.type === "tool.started" && r.key === "t1.c0").map((r) => r.data["attempt"]), [1, 2]);
  const finished = journal.filter((r) => r.type === "tool.finished");
  assert.equal(finished.length, 1);
  const [record] = finished;
  assert.ok(record !== undefined);
  assert.equal(record.key, "t1.c0");
  assert.equal(record.data["outcome"], "ok");
  assert.equal(record.data["isError"], false);
  assert.deepEqual(record.data["data"], { path: "done.txt", deleted: false });
  assert.equal(record.data["content"], "done.txt: already absent, nothing to delete");
  assert.deepEqual(seen, [{ content: "done.txt: already absent, nothing to delete", isError: false }]);
  assert.deepEqual(done.output, { text: "done.txt: already absent, nothing to delete" });
});

test("a runner that crashes right after delete_file unlinked the file: the new runner re-runs it and the run completes", async (t) => {
  const seen: SeenToolMessage[] = [];
  const h = await createHarness(t, {
    models: modelsCalling([
      { name: "write_file", args: { path: "done.txt", content: "x" } },
      { name: "delete_then_crash", args: { path: "done.txt" } },
    ], seen),
    tools: fileTools(),
  });
  const real = h.tools.get("delete_file");
  assert.ok(real !== null, "delete_file is registered");
  let invocations = 0;
  const handler: ToolDefinition["handler"] = async (args, context) => {
    invocations += 1;
    const result = await real.handler(args, context);
    if (invocations === 1) await h.crashAndReplace();
    return result;
  };
  h.tools.register({ ...real, name: "delete_then_crash", handler });
  const agent = await h.saveAgent({ tools: [{ name: "write_file" }, { name: "delete_then_crash" }] });
  const run = await h.start(agent.id);
  const done = await h.until(run.id, ["completed", "failed", "waiting"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(invocations, 2, "the real handler ran twice");
  await assert.rejects(stat(join(h.dir, "workspaces", run.id, "done.txt")), "the file is gone");
  const journal = await h.journal(run.id);
  assert.equal(journal.filter((r) => r.type === "pending.opened").length, 0, "no interrupted pending was opened");
  assert.deepEqual(journal.filter((r) => r.type === "tool.started" && r.key === "t2.c0").map((r) => r.data["attempt"]), [1, 2]);
  const deletion = journal.filter((r) => r.type === "tool.finished" && r.key === "t2.c0");
  assert.equal(deletion.length, 1);
  assert.equal(deletion[0]?.data["isError"], false);
  assert.equal(deletion[0]?.data["outcome"], "ok");
  assert.deepEqual(deletion[0]?.data["data"], { path: "done.txt", deleted: false });
  assert.deepEqual(seen, [{ content: "done.txt: already absent, nothing to delete", isError: false }]);
});

test("contrast: an edit_file call left started by a dead runner waits for a person and is not run", async (t) => {
  const seen: SeenToolMessage[] = [];
  const h = await createHarness(t, { models: modelsCalling([], seen), tools: fileTools(), autoStart: false });
  const agent = await h.saveAgent({ tools: [{ name: "edit_file" }] });
  const runId = await crashedRun(h, agent.id, "edit_file", { path: "a.txt", old_text: "x", new_text: "y" });
  const workspace = join(h.dir, "workspaces", runId);
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "a.txt"), "x");
  h.runner.start();
  await h.until(runId, "waiting");
  const pendings = await h.pendings(runId);
  assert.equal(pendings.length, 1);
  assert.equal(pendings[0]?.kind, "interrupted");
  assert.equal(pendings[0]?.stepKey, "t1.c0");
  assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "x", "the handler did not run");
  assert.equal((await h.records(runId, "tool.finished")).length, 0);
  assert.deepEqual((await h.records(runId, "tool.started")).map((r) => r.attempt), [1]);
  assert.deepEqual(seen, []);
});
