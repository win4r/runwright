/**
 * R13D-tools-01 through the real app: parallel workflow branches and a `map` that edit one file never lose an
 * edit. Every `edit_file` reads, replaces and renames inside one queue per workspace, so each reported success
 * is in the final file.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject } from "../../src/core/json.ts";
import type { WorkflowDocument } from "../../src/workflow/types.ts";
import { startTestApp, type TestApp } from "../fixtures/app.ts";
import { fullTimeline, scriptedAgent, waitForStatus } from "../fixtures/runs.ts";

function workflow(name: string, root: JsonObject): WorkflowDocument {
  return {
    format: "runwright.workflow/v1", name, schemas: { In: { type: "object" }, Out: {} }, input: "In", output: "Out", root, result: "done",
  } as unknown as WorkflowDocument;
}

const write = (id: string, content: string): JsonObject => ({ id, kind: "tool", tool: "write_file", args: { path: "shared.txt", content } });
const edit = (id: string, from: JsonObject | string, to: JsonObject | string): JsonObject => ({
  id, kind: "tool", tool: "edit_file", args: { path: "shared.txt", old_text: from, new_text: to },
});

async function saveWorkflowAgent(app: TestApp, id: string, root: JsonObject): Promise<string> {
  const { agent } = await app.client.saveAgent({
    ...scriptedAgent({ name: id, tools: [{ name: "write_file" }, { name: "edit_file" }], script: { turns: [] } }),
    workflow: workflow(id.replaceAll("-", "_"), root),
  }, id);
  return agent.id;
}

/** Runs the agent's workflow to completion; returns the final file and the value of every edit node. */
async function runOnce(app: TestApp, agentId: string, data: JsonObject): Promise<{ text: string; edits: JsonObject[] }> {
  const { run } = await app.client.startRun({ agentId, data });
  const { run: done } = await waitForStatus(app.client, run.id, ["completed", "failed", "waiting", "cancelled"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  const records = await fullTimeline(app.client, run.id);
  const edits = records
    .filter((record) => record.type === "tool.finished" && record.data["tool"] === "edit_file")
    .map((record) => record.data);
  const file = await app.client.readFile(run.id, "shared.txt");
  return { text: new TextDecoder().decode(file.body), edits };
}

test("two parallel edit_file branches on one file both take effect, every time", { timeout: 60_000 }, async (t) => {
  const app = await startTestApp(t);
  const agentId = await saveWorkflowAgent(app, "parallel-edits", {
    id: "main", kind: "sequence", steps: [
      write("seed", "cat dog"),
      { id: "both", kind: "parallel", branches: [edit("cow", "cat", "cow"), edit("bird", "dog", "bird")] },
    ],
  });
  for (let round = 0; round < 10; round += 1) {
    const { text, edits } = await runOnce(app, agentId, {});
    assert.equal(text, "cow bird", `round ${round}`);
    assert.equal(edits.length, 2);
    for (const finished of edits) assert.equal(finished["isError"], false, JSON.stringify(finished));
  }
});

test("a map with concurrency 8 over 20 replacements in one file keeps every replacement", { timeout: 60_000 }, async (t) => {
  const app = await startTestApp(t);
  const tokens = Array.from({ length: 20 }, (_, i) => `word${String(i).padStart(2, "0")}`);
  const agentId = await saveWorkflowAgent(app, "map-edits", {
    id: "main", kind: "sequence", steps: [
      write("seed", tokens.join(" ")),
      {
        id: "each", kind: "map", over: { $ref: "input.pairs" }, as: "pair", concurrency: 8, maxItems: 20,
        run: edit("one", { $ref: "vars.pair.from" }, { $ref: "vars.pair.to" }),
      },
    ],
  });
  const pairs = tokens.map((token) => ({ from: token, to: token.toUpperCase() }));
  const { text, edits } = await runOnce(app, agentId, { pairs });
  assert.equal(text, tokens.map((token) => token.toUpperCase()).join(" "));
  assert.equal(edits.length, 20);
  for (const finished of edits) assert.equal(finished["isError"], false, JSON.stringify(finished));
});
