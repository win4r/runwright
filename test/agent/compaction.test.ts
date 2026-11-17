import { test } from "node:test";
import assert from "node:assert/strict";
import { renderTranscript, splitTurns, SUMMARY_PREFIX } from "../../src/agent/compaction.ts";
import type { Message, ModelRequest, ScriptedScript } from "../../src/models/types.ts";
import { waitFor } from "../helpers/wait.ts";
import { countByKey, modelGate, requestBytesOf, requestsFor, setupAgent } from "./setup.ts";

const TURNS = 7;

function longScript(): ScriptedScript {
  const turns: NonNullable<ScriptedScript["turns"]> = [];
  for (let i = 1; i < TURNS; i++) {
    turns.push({ text: `writing part ${i}`, toolCalls: [{ name: "write_file", args: { path: `part-${i}.txt`, content: `${i}:`.padEnd(400, "x") } }] });
  }
  turns.push({ text: "all parts written" });
  return { turns, steps: { compaction: { text: "Wrote the earlier parts; each holds 400 characters." } } };
}

const RUN = { model: { contextTokens: 700 }, agent: { tools: [{ name: "write_file" }] }, message: "Write the parts." };

/** Every tool message directly follows the assistant message that called it, or another of its results. */
function assertPaired(messages: readonly Message[]): void {
  let calls = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") calls = new Set(message.toolCalls.map((c) => c.id));
    else if (message.role === "tool") assert.ok(calls.has(message.toolCallId), `tool result ${message.toolCallId} is paired`);
    else calls = new Set();
  }
}

function compactionRequests(requests: readonly ModelRequest[]): ModelRequest[] {
  return requests.filter((r) => r.meta.purpose === "compaction");
}

test("a long run compacts older turns into a journalled summary and completes", async (t) => {
  const s = await setupAgent(t);
  const runId = await s.run(longScript(), RUN);
  const run = await s.h.until(runId, "completed");
  assert.deepEqual(run.output, { text: "all parts written" });

  const compacted = await s.h.records(runId, "context.compacted");
  assert.ok(compacted.length >= 1, "at least one compaction happened");
  for (const record of compacted) {
    const data = record as unknown as { throughTurn: number; tokensBefore: number; tokensAfter: number };
    assert.ok(data.tokensAfter < data.tokensBefore);
    assert.ok(data.throughTurn >= 1);
  }
  const started = await s.h.records(runId, "model.started");
  const compactionSteps = started.filter((r) => r.purpose === "compaction");
  assert.equal(compactionSteps.length, compacted.length);
  for (const step of compactionSteps) {
    assert.equal(step.step, "compaction");
    assert.equal(step.countsAsTurn, false);
  }
  assert.equal(run.usage.turns, TURNS, "compaction calls do not count as turns");

  const summaryRequest = compactionRequests(s.requests)[0];
  assert.ok(summaryRequest !== undefined);
  assert.equal(summaryRequest.messages.length, 1);
  assert.match(summaryRequest.messages[0]?.content ?? "", /Assistant called tool write_file \(call_t1_0\)/);
  assert.deepEqual(summaryRequest.tools, []);

  const last = requestsFor(s.requests, `t${TURNS}`)[0];
  assert.ok(last !== undefined);
  assert.deepEqual(last.messages[0], { role: "user", content: "Write the parts." }, "the first user message is kept");
  const summary = last.messages[1];
  assert.equal(summary?.role, "user");
  assert.ok(summary?.content.startsWith(SUMMARY_PREFIX + "Wrote the earlier parts"));
  const assistantCalls = last.messages.flatMap((m) => (m.role === "assistant" ? m.toolCalls.map((c) => c.id) : []));
  assert.deepEqual(assistantCalls, [`call_t${TURNS - 2}_0`, `call_t${TURNS - 1}_0`], "the two most recent turns are kept");
  assert.deepEqual(last.messages.slice(2).map((m) => m.role), ["assistant", "tool", "assistant", "tool"]);
  for (const request of s.requests) assertPaired(request.messages);
});

test("after a crash the journalled summary is reused, not requested again", async (t) => {
  const gate = modelGate([`t${TURNS}`]);
  const s = await setupAgent(t, { gate: gate.gate });
  const runId = await s.run(longScript(), RUN);
  await waitFor(() => requestsFor(s.requests, `t${TURNS}`).length === 1);
  const before = compactionRequests(s.requests).length;
  assert.ok(before >= 1);
  await s.h.crashAndReplace();
  gate.open();

  const run = await s.h.until(runId, "completed", 8000);
  assert.deepEqual(run.output, { text: "all parts written" });
  const after = compactionRequests(s.requests);
  assert.equal(after.length, before, "no compaction was requested again after the crash");
  assert.equal(new Set(after.map((r) => r.meta.key)).size, after.length);
  const journal = await s.h.journal(runId);
  for (const [key, count] of countByKey(journal, "model.finished")) assert.equal(count, 1, key);
  for (const [key, count] of countByKey(journal, "context.compacted")) assert.equal(count, 1, key);
  const finals = requestsFor(s.requests, `t${TURNS}`);
  assert.equal(finals.length, 2);
  assert.equal(requestBytesOf(finals[0] as ModelRequest), requestBytesOf(finals[1] as ModelRequest), "the resumed request is identical");
});

test("no compaction happens while the conversation fits", async (t) => {
  const s = await setupAgent(t);
  const runId = await s.run(longScript(), { ...RUN, model: {} });
  await s.h.until(runId, "completed");
  assert.equal((await s.h.records(runId, "context.compacted")).length, 0);
  assert.equal(compactionRequests(s.requests).length, 0);
});

test("splitTurns keeps each assistant message with its tool results", () => {
  const messages: Message[] = [
    { role: "user", content: "summary" },
    { role: "assistant", content: "a", toolCalls: [{ id: "1", name: "x", args: {} }, { id: "2", name: "x", args: {} }] },
    { role: "tool", toolCallId: "1", name: "x", content: "r1", isError: false },
    { role: "tool", toolCallId: "2", name: "x", content: "r2", isError: true },
    { role: "user", content: "a message" },
    { role: "assistant", content: "b", toolCalls: [] },
    { role: "user", content: "late" },
  ];
  const { groups, tail } = splitTurns(messages);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0]?.messages.map((m) => m.content), ["summary", "a", "r1", "r2"]);
  assert.deepEqual(groups[1]?.messages.map((m) => m.content), ["a message", "b"]);
  assert.deepEqual(tail.map((m) => m.content), ["late"]);
  assert.equal(
    renderTranscript(messages.slice(1, 4)),
    "Assistant: a\nAssistant called tool x (1) with arguments {}\nAssistant called tool x (2) with arguments {}\n" +
      "Tool result from x (1): r1\nTool result (error) from x (2): r2",
  );
});
