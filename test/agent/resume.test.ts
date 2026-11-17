import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { ModelRequest, ScriptedScript } from "../../src/models/types.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import { waitFor } from "../helpers/wait.ts";
import { countByKey, modelGate, requestBytesOf, requestsFor, setupAgent, type AgentSetup } from "./setup.ts";

/** A write tool that counts how often its handler ran for each label. */
function recordTool(): { tool: ToolDefinition; calls: Map<string, number> } {
  const calls = new Map<string, number>();
  return {
    calls,
    tool: {
      name: "record", description: "Records a label.", effect: "write",
      parameters: { type: "object", required: ["label"], properties: { label: { type: "string" } } },
      handler: async (args) => {
        const label = String(args["label"]);
        calls.set(label, (calls.get(label) ?? 0) + 1);
        return { content: `recorded ${label}` };
      },
    },
  };
}

function script(delayTurn2Ms: number): ScriptedScript {
  return {
    turns: [
      { text: "step one", toolCalls: [{ name: "record", args: { label: "a" } }] },
      { text: "step two", delayMs: delayTurn2Ms, toolCalls: [{ name: "record", args: { label: "b" } }] },
      { text: "finished after {{last_result}}" },
    ],
  };
}

const AGENT = { tools: [{ name: "record" }] };

/** The same script run without interruption, for comparing requests. */
async function baseline(t: TestContext, scripted: ScriptedScript): Promise<Map<string, string>> {
  const { tool } = recordTool();
  const s = await setupAgent(t, { tools: [tool] });
  const runId = await s.run(scripted, { agent: AGENT });
  await s.h.until(runId, "completed");
  return new Map(s.requests.map((r) => [r.meta.key, requestBytesOf(r)]));
}

async function assertResumedCleanly(s: AgentSetup, runId: string, calls: Map<string, number>, expected: Map<string, string>): Promise<void> {
  const run = await s.h.until(runId, "completed", 8000);
  assert.deepEqual(run.output, { text: "finished after recorded b" });
  const journal = await s.h.journal(runId);
  assert.ok(new Set(journal.map((r) => r.epoch)).size >= 2, "a second runner took the run over");
  assert.deepEqual([...countByKey(journal, "model.finished")].sort(), [["t1", 1], ["t2", 1], ["t3", 1]]);
  assert.deepEqual([...countByKey(journal, "tool.finished")].sort(), [["t1.c0", 1], ["t2.c0", 1]]);
  assert.deepEqual([...calls].sort(), [["a", 1], ["b", 1]], "each finished tool call ran its handler once");
  for (const request of s.requests) {
    assert.equal(requestBytesOf(request), expected.get(request.meta.key), `request ${request.meta.key} matches the uninterrupted run`);
  }
}

test("a crash after two finished turns resumes without repeating them", async (t) => {
  const scripted = script(0);
  const expected = await baseline(t, scripted);

  const gate = modelGate(["t3"]);
  const { tool, calls } = recordTool();
  const s = await setupAgent(t, { tools: [tool], gate: gate.gate });
  const runId = await s.run(scripted, { agent: AGENT });
  await waitFor(() => requestsFor(s.requests, "t3").length === 1);
  await s.h.crashAndReplace();
  gate.open();

  await assertResumedCleanly(s, runId, calls, expected);
  assert.equal(requestsFor(s.requests, "t1").length, 1, "finished turn 1 was not requested again");
  assert.equal(requestsFor(s.requests, "t2").length, 1, "finished turn 2 was not requested again");
  assert.equal(requestsFor(s.requests, "t3").length, 2, "the unfinished turn was issued again");
});

test("a crash during a delayed model call re-issues only that call", async (t) => {
  const scripted = script(400);
  const expected = await baseline(t, scripted);

  const { tool, calls } = recordTool();
  const s = await setupAgent(t, { tools: [tool] });
  const runId = await s.run(scripted, { agent: AGENT });
  await waitFor(() => requestsFor(s.requests, "t2").length === 1);
  await s.h.crashAndReplace();

  await assertResumedCleanly(s, runId, calls, expected);
  assert.equal(requestsFor(s.requests, "t1").length, 1);
  assert.equal(requestsFor(s.requests, "t2").length, 2);
  const interrupted = (await s.h.journal(runId)).filter((r) => r.type === "model.interrupted").map((r) => r.key);
  assert.deepEqual(interrupted, ["t2"]);
});

test("a run that waits on a person resumes on a fresh runner from the journal", async (t) => {
  const scripted: ScriptedScript = {
    turns: [
      { toolCalls: [{ name: "record", args: { label: "a" } }] },
      { toolCalls: [{ name: "ask_person", args: { question: "Continue?" } }] },
      { text: "answer was {{last_result}}" },
    ],
  };
  const { tool, calls } = recordTool();
  const s = await setupAgent(t, { tools: [tool] });
  const runId = await s.run(scripted, { agent: { tools: [{ name: "record" }, { name: "ask_person" }] } });
  await s.h.until(runId, "waiting");
  await s.h.crashAndReplace();
  const [pending] = await s.h.pendings(runId);
  assert.ok(pending !== undefined);
  await s.h.send(runId, { type: "answer", pendingId: pending.id, answer: "yes" });

  const run = await s.h.until(runId, "completed");
  assert.deepEqual(run.output, { text: "answer was yes" });
  assert.deepEqual([...calls], [["a", 1]]);
  const byKey = (key: string): ModelRequest[] => requestsFor(s.requests, key);
  assert.equal(byKey("t1").length, 1);
  assert.equal(byKey("t2").length, 1);
  assert.equal(byKey("t3").length, 1);
});
