import { test } from "node:test";
import assert from "node:assert/strict";
import type { ScriptedScript } from "../../src/models/types.ts";
import { requestsFor, setupAgent } from "./setup.ts";

const threeTurns: ScriptedScript = {
  turns: [
    { toolCalls: [{ name: "write_file", args: { path: "a.txt", content: "a" } }] },
    { toolCalls: [{ name: "write_file", args: { path: "b.txt", content: "b" } }] },
    { text: "all written" },
  ],
};

test("the agent's maxTurns pauses the run and raising it lets the run finish", async (t) => {
  const s = await setupAgent(t);
  const runId = await s.run(threeTurns, { agent: { tools: [{ name: "write_file" }], limits: { maxTurns: 2 } } });

  await s.h.until(runId, "waiting");
  const [pending] = await s.h.pendings(runId);
  assert.ok(pending !== undefined);
  assert.equal(pending.kind, "turn_limit");
  assert.equal(pending.stepKey, "t3");
  assert.equal(requestsFor(s.requests, "t3").length, 0, "turn 3 was not sent");

  await s.h.send(runId, { type: "limits", limits: { maxTurns: 3 } });
  const run = await s.h.until(runId, "completed");
  assert.deepEqual(run.output, { text: "all written" });
  assert.equal(run.usage.turns, 3);
});

test("the agent's maxToolCalls pauses the run and raising it lets the run finish", async (t) => {
  const s = await setupAgent(t);
  const runId = await s.run(threeTurns, { agent: { tools: [{ name: "write_file" }], limits: { maxToolCalls: 1 } } });

  await s.h.until(runId, "waiting");
  const [pending] = await s.h.pendings(runId);
  assert.ok(pending !== undefined);
  assert.equal(pending.kind, "tool_budget");
  assert.equal(pending.stepKey, "t2.c0");
  assert.deepEqual((await s.h.records(runId, "tool.finished")).map((f) => f.outcome), ["ok"]);

  await s.h.send(runId, { type: "limits", limits: { maxToolCalls: 2 } });
  const run = await s.h.until(runId, "completed");
  assert.deepEqual(run.output, { text: "all written" });
  assert.equal(run.usage.toolCalls, 2);
});

test("a spend cap pauses between turns and raising it resumes the run", async (t) => {
  // Each turn bills 5 000 micro-dollars; a turn's worst case here is about 2 000 (one token per request byte plus
  // 1 024 framing tokens, and 10 output tokens). Under a cap of 9 000 turn 2 fits (5 000 + W2) and turn 3 does not
  // (10 000 + W3).
  const usage = { inputTokens: 5000, outputTokens: 0 };
  const s = await setupAgent(t);
  const runId = await s.run({
    turns: [
      { text: "one", toolCalls: [{ name: "write_file", args: { path: "a.txt", content: "a" } }], usage },
      { text: "two", toolCalls: [{ name: "write_file", args: { path: "b.txt", content: "b" } }], usage },
      { text: "three", usage },
    ],
  }, { model: { maxOutputTokens: 10 }, agent: { tools: [{ name: "write_file" }], limits: { maxCostMicros: 9000 } } });

  const waiting = await s.h.until(runId, "waiting");
  const [pending] = await s.h.pendings(runId);
  assert.ok(pending !== undefined);
  assert.equal(pending.kind, "spend_cap");
  assert.equal(waiting.usage.costMicros, 10_000, "two turns were spent before the pause");
  assert.equal(pending.stepKey, "t3");
  assert.equal(requestsFor(s.requests, "t3").length, 0, "turn 3 was not sent");
  const needed = pending.detail["neededMicros"];
  assert.equal(typeof needed, "number");
  assert.ok((needed as number) > 0);
  assert.equal(needed, 10_000 + (pending.detail["nextCallWorstCaseMicros"] as number) - 9000);

  await s.h.send(runId, { type: "limits", limits: { maxCostMicros: 9000 + (needed as number) } });
  const run = await s.h.until(runId, "completed");
  assert.deepEqual(run.output, { text: "three" });
  assert.equal(run.usage.costMicros, 15_000);
});
