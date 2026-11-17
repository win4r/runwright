import { test } from "node:test";
import assert from "node:assert/strict";
import { ControlSignal } from "../../src/engine/control.ts";
import type { PersonQuestion, RunContext } from "../../src/engine/types.ts";
import { createLogger } from "../../src/log/logger.ts";
import { createAskPersonTool } from "../../src/tools/ask-person.ts";
import type { ToolContext } from "../../src/tools/types.ts";

function contextWith(ask: (key: string, question: PersonQuestion) => Promise<{ answer: string }>): ToolContext {
  return {
    runId: "run_1",
    agentId: "agent_1",
    workspace: "/nonexistent",
    signal: new AbortController().signal,
    logger: createLogger({ write: () => undefined }),
    secrets: {},
    steps: { ask, journal: () => [] } as unknown as RunContext,
  };
}

test("ask_person is a resumable read tool", () => {
  const tool = createAskPersonTool();
  assert.equal(tool.name, "ask_person");
  assert.equal(tool.effect, "read");
  assert.equal(tool.resumable, true);
  assert.equal(tool.parameters["additionalProperties"], false);
});

test("forwards the question and choices to steps.ask and returns the answer", async () => {
  const calls: [string, PersonQuestion][] = [];
  const tool = createAskPersonTool();
  const context = contextWith(async (key, question) => {
    calls.push([key, question]);
    return { answer: "blue" };
  });
  const result = await tool.handler({ question: "Which colour?", choices: ["red", "blue"] }, context);
  assert.deepEqual(result, { content: "blue" });
  const plain = await tool.handler({ question: "Name?" }, context);
  assert.equal(plain.content, "blue");
  assert.deepEqual(calls, [["ask", { question: "Which colour?", choices: ["red", "blue"] }], ["ask", { question: "Name?" }]]);
});

test("rethrows the control signal that suspends the run", async () => {
  const tool = createAskPersonTool();
  const signal = new ControlSignal("waiting");
  await assert.rejects(tool.handler({ question: "Proceed?" }, contextWith(async () => {
    throw signal;
  })), (error: unknown) => error === signal);
});
