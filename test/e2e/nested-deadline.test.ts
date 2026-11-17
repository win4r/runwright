/**
 * Finding R02-06 through a real app and its HTTP API: a workflow agent calls a saved workflow (a slow model step,
 * then `write_file`) through a `run_workflow` tool node with a short `deadlineMs`. The deadline stops the nested
 * work: the nested model call is journalled interrupted, the nested `write_file` never runs (the run has no
 * files), the call ends `timeout`, and nothing under the call's key is journalled after the call ended, even
 * though the run stays alive past the moment the nested model reply would have arrived.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Json } from "../../src/core/json.ts";
import type { JournalRecord } from "../../src/store/types.ts";
import type { WorkflowDocument } from "../../src/workflow/types.ts";
import { startTestApp } from "../fixtures/app.ts";
import { effectLines, fullTimeline, scriptedAgent, waitForStatus } from "../fixtures/runs.ts";

const NESTED_DELAY_MS = 900;
const DEADLINE_MS = 200;

const nested = {
  format: "runwright.workflow/v1",
  name: "slow_writer",
  schemas: { In: { type: "object" }, Out: {}, Summary: { type: "object", required: ["text"], properties: { text: { type: "string" } } } },
  input: "In",
  output: "Out",
  root: { id: "inner", kind: "sequence", steps: [
    { id: "slow", kind: "model", prompt: "Summarise the week", output: "Summary" },
    { id: "write", kind: "tool", tool: "write_file", args: { path: "late.txt", content: { $ref: "steps.slow.text" } } },
  ] },
  result: "done",
};

const outer = {
  format: "runwright.workflow/v1",
  name: "caller",
  schemas: { In: { type: "object" }, Out: {} },
  input: "In",
  output: "Out",
  root: { id: "main", kind: "sequence", steps: [
    { id: "call", kind: "tool", tool: "run_workflow", args: { name: "slow_writer", input: {} }, deadlineMs: DEADLINE_MS, onError: "continue" },
    { id: "linger", kind: "tool", tool: "slow_effect", args: { label: "linger", ms: NESTED_DELAY_MS + 400 } },
  ] },
  result: { $ref: "steps.call" },
};

function one(records: readonly JournalRecord[], type: string, key: string): JournalRecord {
  const found = records.filter((r) => r.type === type && r.key === key);
  assert.equal(found.length, 1, `exactly one ${type} at ${key}`);
  return found[0] as JournalRecord;
}

test("a run_workflow deadline stops the nested workflow: no nested write, no nested record after the call", { timeout: 30_000 }, async (t) => {
  const { client, effects } = await startTestApp(t);
  const saved = await client.saveWorkflow("slow_writer", nested as unknown as Json);
  assert.equal(saved.workflow.version, 1);
  const { agent } = await client.saveAgent({
    ...scriptedAgent({
      name: "Caller",
      tools: [{ name: "run_workflow" }, { name: "write_file" }, { name: "slow_effect" }],
      script: { steps: { slow: { output: { text: "too late" }, delayMs: NESTED_DELAY_MS, usage: { inputTokens: 10, outputTokens: 10 } } } },
    }),
    workflow: outer as unknown as WorkflowDocument,
  }, "caller");

  const { run } = await client.startRun({ agentId: agent.id, data: {} });
  const { run: done } = await waitForStatus(client, run.id, ["completed", "failed", "cancelled", "waiting"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal((done.output as { ok?: unknown } | null)?.ok, false, "the call's error result was continued past");

  const records = await fullTimeline(client, run.id);
  const call = records.find((r) => r.type === "tool.started" && r.data["tool"] === "run_workflow");
  assert.ok(call !== undefined && call.key !== null, "the run_workflow call was journalled");
  const callKey = call.key;
  const ended = one(records, "tool.finished", callKey);
  assert.equal(ended.data["outcome"], "timeout");

  const under = (r: JournalRecord): boolean => r.key?.startsWith(`${callKey}/`) === true;
  const interrupted = records.filter((r) => r.type === "model.interrupted" && under(r));
  assert.deepEqual(interrupted.map((r) => r.data["reason"]), ["deadline"]);
  assert.equal(records.some((r) => r.type === "model.finished" && under(r)), false, "the nested reply was never taken");
  assert.equal(records.some((r) => r.type === "tool.started" && r.data["tool"] === "write_file"), false, "the nested write never started");
  assert.deepEqual(records.filter((r) => under(r) && r.seq > ended.seq).map((r) => `${r.seq} ${r.type} ${r.key ?? ""}`), [],
    "nothing under the call's key after the call ended");

  const linger = records.find((r) => r.type === "tool.finished" && r.data["tool"] === "slow_effect");
  assert.ok(linger !== undefined && linger.ts - ended.ts >= NESTED_DELAY_MS, "the run outlived the nested model's delay");
  assert.deepEqual(await client.listFiles(run.id), [], "the run wrote no file");
  assert.deepEqual(await effectLines(effects), ["start:linger", "end:linger"]);
});
