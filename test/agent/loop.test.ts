import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createAgentLoop } from "../../src/agent/loop.ts";
import type { Json } from "../../src/core/json.ts";
import type { Driver, RunContext } from "../../src/engine/types.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import { waitFor } from "../helpers/wait.ts";
import { LOOP_OPTIONS, modelGate, requestsFor, setupAgent } from "./setup.ts";

test("a multi-turn run writes and reads a file and returns the final text", async (t) => {
  const s = await setupAgent(t);
  const runId = await s.run({
    turns: [
      { text: "Writing the note.", toolCalls: [{ name: "write_file", args: { path: "notes/a.txt", content: "hello from the agent" } }] },
      { toolCalls: [{ name: "read_file", args: { path: "notes/a.txt" } }] },
      { text: "The file says: {{last_result}}" },
    ],
  }, { agent: { tools: [{ name: "write_file" }, { name: "read_file" }] } });

  const run = await s.h.until(runId, "completed");
  assert.deepEqual(run.output, { text: "The file says: hello from the agent" });
  assert.equal(await readFile(join(s.h.dir, "workspaces", runId, "notes", "a.txt"), "utf8"), "hello from the agent");

  const t3 = requestsFor(s.requests, "t3")[0];
  assert.ok(t3 !== undefined);
  assert.deepEqual(t3.messages.map((m) => m.role), ["user", "assistant", "tool", "assistant", "tool"]);
  assert.deepEqual(t3.tools.map((tool) => tool.name), ["read_file", "write_file"]);
  assert.equal(t3.meta.turn, 3);
  assert.equal(t3.meta.purpose, "run");
  assert.equal(run.usage.turns, 3);
  assert.equal(run.usage.toolCalls, 2);
});

test("tool errors are fed back to the model and the loop continues", async (t) => {
  const s = await setupAgent(t);
  const runId = await s.run({
    turns: [
      { toolCalls: [{ name: "no_such_tool", args: {} }] },
      { toolCalls: [{ name: "write_file", args: { path: "x.txt" } }] },
      { toolCalls: [{ name: "delete_file", args: { path: "x.txt" } }] },
      { text: "gave up: {{last_result}}" },
    ],
  }, { agent: { tools: [{ name: "write_file" }, { name: "delete_file", policy: "deny" }] } });

  const run = await s.h.until(runId, "completed");
  const finished = await s.h.records(runId, "tool.finished");
  assert.deepEqual(finished.map((f) => f.outcome), ["unknown_tool", "invalid_args", "denied"]);
  const last = requestsFor(s.requests, "t4")[0];
  assert.ok(last !== undefined);
  const toolMessages = last.messages.filter((m) => m.role === "tool");
  assert.equal(toolMessages.length, 3);
  for (const message of toolMessages) assert.equal(message.role === "tool" && message.isError, true);
  const output = run.output as { text: string };
  assert.ok(output.text.startsWith("gave up: "));
  assert.ok(output.text.length > "gave up: ".length);
  assert.deepEqual(last.tools.map((tool) => tool.name), ["write_file"], "a denied tool is not offered");
});

test("ask_person pauses the run and the answer becomes the tool result", async (t) => {
  const s = await setupAgent(t);
  const runId = await s.run({
    turns: [
      { toolCalls: [{ name: "ask_person", args: { question: "What is your name?" } }] },
      { text: "Hello, {{last_result}}!" },
    ],
  }, { agent: { tools: [{ name: "ask_person" }] } });

  await s.h.until(runId, "waiting");
  const [pending] = await s.h.pendings(runId);
  assert.ok(pending !== undefined);
  assert.equal(pending.kind, "question");
  assert.equal(pending.detail["question"], "What is your name?");
  await s.h.send(runId, { type: "answer", pendingId: pending.id, answer: "Ada" });

  const run = await s.h.until(runId, "completed");
  assert.deepEqual(run.output, { text: "Hello, Ada!" });
  assert.equal(requestsFor(s.requests, "t1").length, 1, "turn 1 is not asked again after the answer");
});

test("a message sent mid-run appears in the next turn's request exactly once", async (t) => {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gateTool: ToolDefinition = {
    name: "wait_gate", description: "Waits until the test opens the gate.", parameters: { type: "object", properties: {} },
    effect: "read", handler: async () => {
      await released;
      return { content: "gate opened" };
    },
  };
  const s = await setupAgent(t, { tools: [gateTool] });
  const runId = await s.run({
    turns: [
      { toolCalls: [{ name: "wait_gate", args: {} }] },
      { toolCalls: [{ name: "wait_gate", args: {} }] },
      { text: "done" },
    ],
  }, { agent: { tools: [{ name: "wait_gate" }] } });

  await waitFor(async () => (await s.h.records(runId, "tool.started")).length === 1);
  await s.h.send(runId, { type: "message", text: "Please also mention the weather." });
  await waitFor(async () => (await s.h.records(runId, "command.applied")).some((c) => c.command.type === "message"));
  release();
  await s.h.until(runId, "completed");

  const count = (key: string): number => {
    const request = requestsFor(s.requests, key)[0];
    assert.ok(request !== undefined, key);
    return request.messages.filter((m) => m.role === "user" && m.content === "Please also mention the weather.").length;
  };
  assert.equal(count("t1"), 0);
  assert.equal(count("t2"), 1);
  assert.equal(count("t3"), 1);
  const t2 = requestsFor(s.requests, "t2")[0];
  assert.deepEqual(t2?.messages.map((m) => m.role), ["user", "assistant", "tool", "user"]);
});

test("a message sent just after the final reply extends the run", async (t) => {
  const gate = modelGate(["t1"]);
  const s = await setupAgent(t, { gate: gate.gate });
  const runId = await s.run({ turns: [{ text: "first answer" }, { text: "second answer to {{first_message}}" }] });

  await waitFor(() => requestsFor(s.requests, "t1").length === 1);
  await s.h.send(runId, { type: "message", text: "One more thing." });
  await waitFor(async () => (await s.h.records(runId, "command.applied")).some((c) => c.command.type === "message"));
  gate.open();

  const run = await s.h.until(runId, "completed");
  assert.deepEqual(run.output, { text: "second answer to go" });
  const t2 = requestsFor(s.requests, "t2")[0];
  assert.ok(t2 !== undefined);
  assert.deepEqual(t2.messages, [
    { role: "user", content: "go" },
    { role: "assistant", content: "first answer", toolCalls: [] },
    { role: "user", content: "One more thing." },
  ]);
  const late = (await s.h.journal(runId)).find((r) => r.type === "inbox.taken" && r.key === "t1.late");
  assert.equal((late?.data["messages"] as Json[]).length, 1);
});

test("maxTurns of the loop params stops a hand-off, and a step names its scripted turns", async (t) => {
  const { loop } = createAgentLoop(LOOP_OPTIONS);
  const driver: Driver = async (ctx) => {
    const result = await loop(ctx.child("handoff"), {
      instructions: "Hand-off agent.", message: "work on it", maxTurns: 2, step: "h",
      output: { name: "summary", schema: { type: "object", required: ["files"], properties: { files: { type: "integer" } } } },
    });
    return { text: result.text, data: result.data, turns: result.turns };
  };
  const s = await setupAgent(t, { driver });
  const runId = await s.run({
    turns: [{ text: "the run-level script is not used" }],
    steps: {
      h: [
        { text: "first file", toolCalls: [{ name: "write_file", args: { path: "one.txt", content: "1" } }] },
        { text: "second file", toolCalls: [{ name: "write_file", args: { path: "two.txt", content: "2" } }] },
        { text: "never reached" },
      ],
      "h.final": { output: { files: 2 } },
    },
  }, { agent: { tools: [{ name: "write_file" }] } });

  const run = await s.h.until(runId, "completed");
  assert.deepEqual(run.output, { text: "second file", data: { files: 2 }, turns: 2 });
  const keys = s.requests.map((r) => r.meta.key);
  assert.deepEqual(keys, ["handoff/t1", "handoff/t2", "handoff/final"]);
  assert.equal(requestsFor(s.requests, "handoff/final")[0]?.meta.step, "h.final");
  assert.equal(await readFile(join(s.h.dir, "workspaces", runId, "two.txt"), "utf8"), "2");
});

test("a hand-off with maxTurns 0 returns a fixed note without calling the model", async (t) => {
  const { loop } = createAgentLoop(LOOP_OPTIONS);
  const driver: Driver = async (ctx) => {
    const result = await loop(ctx, { instructions: "x", message: "y", maxTurns: 0 });
    return { text: result.text, turns: result.turns };
  };
  const s = await setupAgent(t, { driver });
  const runId = await s.run({ turns: [{ text: "unused" }] });
  const run = await s.h.until(runId, "completed");
  const output = run.output as { text: string; turns: number };
  assert.equal(output.turns, 0);
  assert.match(output.text, /turn limit/);
  assert.equal(s.requests.length, 0);
});

test("structured final output is returned in data", async (t) => {
  const { loop } = createAgentLoop(LOOP_OPTIONS);
  const driver: Driver = async (ctx) => {
    const result = await loop(ctx, {
      instructions: ctx.definition.instructions, message: ctx.run.input.message,
      output: { name: "verdict", schema: { type: "object", required: ["ok", "reason"], properties: { ok: { type: "boolean" }, reason: { type: "string" } } } },
    });
    return { text: result.text, data: result.data };
  };
  const s = await setupAgent(t, { driver });
  const runId = await s.run({ turns: [{ text: "All checks passed." }, { output: { ok: true, reason: "{{first_message}}" } }] }, { message: "checked" });

  const run = await s.h.until(runId, "completed");
  assert.deepEqual(run.output, { text: "All checks passed.", data: { ok: true, reason: "checked" } });
  const final = requestsFor(s.requests, "final")[0];
  assert.ok(final !== undefined);
  assert.equal(final.output?.name, "verdict");
  assert.deepEqual(final.messages.at(-1), { role: "user", content: "Give the final result as structured data." });
  assert.equal(run.usage.turns, 1, "the final structured call does not count as a turn");
});

test("the driver appends input data as canonical JSON to the message", async (t) => {
  const s = await setupAgent(t);
  const runId = await s.run({ turns: [{ text: "{{first_message}}" }] }, { message: "Sort these.", data: { b: [2, 1], a: "x" } });
  const run = await s.h.until(runId, "completed");
  assert.deepEqual(run.output, { text: "Sort these.\n\nInput data (JSON):\n{\"a\":\"x\",\"b\":[2,1]}" });
});

test("a scripted transient failure is retried by the engine as a separate attempt of the same turn", async (t) => {
  const s = await setupAgent(t);
  const runId = await s.run({ turns: [{ text: "second time lucky", fail: { attempts: 2, status: 503 } }] });
  const run = await s.h.until(runId, "completed");
  assert.deepEqual(run.output, { text: "second time lucky" });
  assert.deepEqual(requestsFor(s.requests, "t1").map((request) => request.meta.attempt), [1, 2, 3]);
  const journal = await s.h.journal(runId);
  assert.deepEqual(journal.filter((r) => r.key === "t1").map((r) => r.type), [
    "model.started", "model.retry", "model.started", "model.retry", "model.started", "model.finished",
  ]);
  assert.equal(run.usage.turns, 1, "retries do not count as turns");
});

test("a hand-off's tools are enforced: a call outside them is denied, journalled and returned to the model", async (t) => {
  const { loop } = createAgentLoop(LOOP_OPTIONS);
  const driver: Driver = async (ctx) => {
    const result = await loop(ctx.child("handoff"), {
      instructions: "Hand-off agent.", message: "look around", toolNames: ["read_file"], step: "h",
    });
    return { text: result.text };
  };
  const s = await setupAgent(t, { driver });
  const runId = await s.run({
    turns: [{ text: "the run-level script is not used" }],
    steps: {
      h: [
        { toolCalls: [{ name: "write_file", args: { path: "forbidden.txt", content: "no" } }] },
        { text: "done looking" },
      ],
    },
  }, { agent: { tools: [{ name: "read_file" }, { name: "write_file" }] } });

  const run = await s.h.until(runId, "completed");
  assert.deepEqual(run.output, { text: "done looking" });
  await assert.rejects(readFile(join(s.h.dir, "workspaces", runId, "forbidden.txt")), "no file was written");
  const first = requestsFor(s.requests, "handoff/t1")[0];
  assert.deepEqual(first?.tools.map((spec) => spec.name), ["read_file"], "the model is shown only the hand-off's tools");
  const journal = await s.h.journal(runId);
  assert.equal(journal.some((r) => r.type === "tool.started"), false, "the handler was never started");
  const finished = journal.filter((r) => r.type === "tool.finished");
  assert.deepEqual(finished.map((r) => [r.key, r.data["tool"], r.data["outcome"], r.data["content"]]), [
    ["handoff/t1.c0", "write_file", "denied", 'tool "write_file" was denied: not among the tools of this hand-off'],
  ]);
  const second = requestsFor(s.requests, "handoff/t2")[0];
  const toolMessage = second?.messages.find((m) => m.role === "tool");
  assert.equal(toolMessage?.role === "tool" ? toolMessage.content : null, 'tool "write_file" was denied: not among the tools of this hand-off');
  assert.equal(run.usage.toolCalls, 0);
});

test("the loop appends an unbounded number of queued messages without spreading them into a call", async () => {
  const { loop } = createAgentLoop({ ...LOOP_OPTIONS, defaultContextTokens: Number.MAX_SAFE_INTEGER });
  const many = Array.from({ length: 200_000 }, (_, i) => ({ commandId: `cmd_${i}`, text: "m", at: i }));
  let sent = 0;
  const ctx = {
    learning: null,
    definition: { model: { provider: "scripted", name: "scripted-1" } },
    logger: { debug: () => undefined },
    toolSpecs: () => [],
    inbox: async (key: string) => (key === "t1.in" ? many : []),
    model: async (_key: string, request: { messages: unknown[] }) => {
      sent = request.messages.length;
      return { text: "read them all", toolCalls: [], output: null, stopReason: "end", usage: {}, costMicros: 0 };
    },
  } as unknown as RunContext;
  const result = await loop(ctx, { instructions: "i", message: "go" });
  assert.equal(result.text, "read them all");
  assert.equal(sent, 200_001);
});
