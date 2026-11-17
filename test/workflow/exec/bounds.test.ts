/**
 * Numeric inputs of the executor are bounded whatever value reaches them: a node's retry makes 1 to 10 attempts
 * (NaN and Infinity included), and `run_workflow` takes a version only when it is a positive safe integer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RunContext } from "../../../src/engine/types.ts";
import { createLogger } from "../../../src/log/logger.ts";
import type { ToolContext } from "../../../src/tools/types.ts";
import { createRunWorkflowTool } from "../../../src/workflow/exec/run-workflow-tool.ts";
import { MAX_NODE_ATTEMPTS, attemptLimit } from "../../../src/workflow/exec/nodes.ts";

test("a node's retry makes a whole number of attempts from 1 to 10, whatever maxAttempts holds", () => {
  const limit = (maxAttempts: number): number => attemptLimit({ maxAttempts, backoffMs: 0 });
  assert.equal(MAX_NODE_ATTEMPTS, 10);
  assert.equal(attemptLimit(undefined), 1);
  assert.equal(limit(3), 3);
  assert.equal(limit(3.9), 3);
  assert.equal(limit(10), 10);
  assert.equal(limit(11), 10);
  assert.equal(limit(Infinity), 10);
  assert.equal(limit(Number.NaN), 1);
  assert.equal(limit(0), 1);
  assert.equal(limit(-5), 1);
  assert.equal(limit(-Infinity), 1);
});

test("run_workflow refuses a version that is not a positive safe integer, before it resolves anything", async () => {
  let lookups = 0;
  const tool = createRunWorkflowTool({
    store: { getWorkflow: async () => { lookups++; return null; } },
    execute: async () => { throw new Error("must not run"); },
  });
  const steps = {
    memo: async () => { throw new Error("must not journal"); },
  } as unknown as RunContext;
  const context: ToolContext = {
    runId: "run_1", agentId: "agent_1", workspace: "/nonexistent", signal: new AbortController().signal,
    logger: createLogger({ write: () => undefined }), secrets: {}, steps,
  };
  for (const version of [0, -1, 1.5, 2 ** 60, Number.NaN, "2", null]) {
    const result = await tool.handler({ name: "report", version }, context);
    assert.equal(result.isError, true, String(version));
    assert.match(result.content, /^"version" must be an integer from 1 to 9007199254740991/);
  }
  assert.equal(lookups, 0);
});
