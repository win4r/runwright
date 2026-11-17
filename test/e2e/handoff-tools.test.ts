/**
 * R13D-docs-01 through the real app: a hand-off's `tools` is enforced on every call made inside the hand-off, not
 * only on the list of tools its model is shown. A call outside it is journalled `tool.finished {outcome:
 * "denied"}` and returned to the model; the same holds for a workflow the hand-off starts with `run_workflow`
 * (the scope is inherited), and a replay after a crash returns the journalled denial.
 */
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { Json, JsonObject } from "../../src/core/json.ts";
import type { JournalRecord } from "../../src/store/types.ts";
import type { WorkflowDocument } from "../../src/workflow/types.ts";
import { startTestApp, type TestApp } from "../fixtures/app.ts";
import { fullTimeline, scriptedAgent, waitForStatus } from "../fixtures/runs.ts";
import { waitFor } from "../helpers/wait.ts";

const SCOPE_DENIAL = 'tool "write_file" was denied: not among the tools of this hand-off';

function workflow(name: string, root: JsonObject): WorkflowDocument {
  return {
    format: "runwright.workflow/v1", name, schemas: { In: { type: "object" }, Out: {} }, input: "In", output: "Out", root, result: "done",
  } as unknown as WorkflowDocument;
}

const AGENT_TOOLS = [{ name: "read_file" }, { name: "write_file" }, { name: "run_workflow" }];

function fileExists(app: TestApp, runId: string, path: string): Promise<boolean> {
  return access(join(app.dir, "data", "workspaces", runId, path)).then(() => true, () => false);
}

function writeCalls(records: readonly JournalRecord[]): { started: number; finished: JsonObject[] } {
  const isWrite = (r: JournalRecord): boolean => r.data["tool"] === "write_file";
  return {
    started: records.filter((r) => r.type === "tool.started" && isWrite(r)).length,
    finished: records.filter((r) => r.type === "tool.finished" && isWrite(r)).map((r) => r.data),
  };
}

test("an agent node with tools [read_file]: the model's write_file call is denied and the run completes", { timeout: 30_000 }, async (t) => {
  const app = await startTestApp(t);
  const { agent } = await app.client.saveAgent({
    ...scriptedAgent({
      name: "Scoped hand-off", tools: AGENT_TOOLS,
      script: {
        turns: [{ text: "the run-level script is not used" }],
        steps: {
          hand: [
            { toolCalls: [{ name: "write_file", args: { path: "out.txt", content: "should not exist" } }] },
            { text: "{{last_result}}" },
          ],
        },
      },
    }),
    workflow: workflow("scoped", { id: "hand", kind: "agent", message: "write something", tools: ["read_file"], maxTurns: 4 }),
  }, "scoped-handoff");
  const { run } = await app.client.startRun({ agentId: agent.id, data: {} });
  const { run: done } = await waitForStatus(app.client, run.id, ["completed", "failed", "waiting"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));

  assert.equal(await fileExists(app, run.id, "out.txt"), false, "no file was written");
  const records = await fullTimeline(app.client, run.id);
  const writes = writeCalls(records);
  assert.equal(writes.started, 0, "the write handler was never started");
  assert.deepEqual(writes.finished.map((d) => [d["outcome"], d["content"]]), [["denied", SCOPE_DENIAL]]);
  const request = records.find((r) => r.type === "model.started" && r.key?.endsWith("/t2") === true);
  assert.ok(request !== undefined, "the model was asked again with the denial as the tool result");
});

test("a hand-off with tools [run_workflow]: a write_file node of the workflow it runs is denied (nested scope)", { timeout: 30_000 }, async (t) => {
  const app = await startTestApp(t);
  const writer = workflow("writer", { id: "write", kind: "tool", tool: "write_file", args: { path: "nested.txt", content: "nested" } });
  await app.client.saveWorkflow("writer", writer as unknown as Json);
  const { agent } = await app.client.saveAgent({
    ...scriptedAgent({
      name: "Nested scope", tools: AGENT_TOOLS,
      script: {
        turns: [{ text: "the run-level script is not used" }],
        steps: {
          hand: [
            { toolCalls: [{ name: "run_workflow", args: { name: "writer", input: {} } }] },
            { text: "{{last_result}}" },
          ],
        },
      },
    }),
    workflow: workflow("outer", { id: "hand", kind: "agent", message: "run the writer", tools: ["run_workflow"], maxTurns: 4 }),
  }, "nested-scope");
  const { run } = await app.client.startRun({ agentId: agent.id, data: {} });
  const { run: done } = await waitForStatus(app.client, run.id, ["completed", "failed", "waiting"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));

  assert.equal(await fileExists(app, run.id, "nested.txt"), false, "the nested write never ran");
  const records = await fullTimeline(app.client, run.id);
  const writes = writeCalls(records);
  assert.equal(writes.started, 0);
  assert.deepEqual(writes.finished.map((d) => [d["outcome"], d["content"]]), [["denied", SCOPE_DENIAL]]);
  const call = records.find((r) => r.type === "tool.finished" && r.data["tool"] === "run_workflow");
  assert.equal(call?.data["isError"], true, "the run_workflow call reports the failed workflow");
  assert.match(String(call?.data["content"]), /not among the tools of this hand-off/);
});

test("after a crash the journalled denial is replayed: the call is never turned into a write", { timeout: 30_000 }, async (t) => {
  const first = await startTestApp(t);
  const { agent } = await first.client.saveAgent({
    ...scriptedAgent({
      name: "Scoped replay", tools: AGENT_TOOLS,
      script: {
        turns: [{ text: "the run-level script is not used" }],
        steps: {
          hand: [
            { toolCalls: [{ name: "write_file", args: { path: "late.txt", content: "should not exist" } }] },
            { text: "{{last_result}}", delayMs: 2000 },
          ],
        },
      },
    }),
    workflow: workflow("replayed", { id: "hand", kind: "agent", message: "write something", tools: ["read_file"], maxTurns: 4 }),
  }, "scoped-replay");
  const { run } = await first.client.startRun({ agentId: agent.id, data: {} });
  await waitFor(async () => {
    const records = await fullTimeline(first.client, run.id);
    const last = records.at(-1);
    return last?.type === "model.started" && last.key?.endsWith("/t2") === true;
  }, { timeoutMs: 10_000, intervalMs: 5, message: "the hand-off never reached its second turn" });
  await first.app.runner?.abandon();

  const second = await startTestApp(t, { dir: first.dir });
  const { run: done } = await waitForStatus(second.client, run.id, ["completed", "failed", "waiting"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));

  assert.equal(await fileExists(second, run.id, "late.txt"), false);
  const records = await fullTimeline(second.client, run.id);
  const reply = records.find((r) => r.type === "model.finished" && r.key?.endsWith("/t2") === true);
  assert.equal(reply?.data["text"], SCOPE_DENIAL, "the resumed turn was given the journalled denial");
  assert.equal(records.filter((r) => r.type === "run.claimed").length, 2, "a second runner took the run over");
  const writes = writeCalls(records);
  assert.equal(writes.started, 0);
  assert.deepEqual(writes.finished.map((d) => d["outcome"]), ["denied"], "the denial is journalled once and replayed");
});
