import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt, WORKSPACE_NOTE } from "../../src/agent/prompt.ts";
import type { LearningHooks } from "../../src/engine/types.ts";
import { requestsFor, setupAgent } from "./setup.ts";

const SECTION = "## What you learned before\n- The build uses `make check`.";

test("the system prompt is the instructions, the learning section and the workspace note", () => {
  assert.equal(buildSystemPrompt("Do the job."), `Do the job.\n\n${WORKSPACE_NOTE}`);
  assert.equal(buildSystemPrompt("Do the job.", SECTION), `Do the job.\n\n${SECTION}\n\n${WORKSPACE_NOTE}`);
  assert.equal(buildSystemPrompt("Do the job.", ""), buildSystemPrompt("Do the job."));
  assert.equal(buildSystemPrompt("", SECTION), `${SECTION}\n\n${WORKSPACE_NOTE}`);
  assert.match(WORKSPACE_NOTE, /workspace folder/);
  assert.match(WORKSPACE_NOTE, /relative/);
});

test("two runs of the same agent send byte-identical system prompts", async (t) => {
  const s = await setupAgent(t);
  const first = await s.run({ turns: [{ text: "ok" }] });
  await s.h.until(first, "completed");
  const second = await s.run({ turns: [{ text: "ok" }] });
  await s.h.until(second, "completed");
  const systems = requestsFor(s.requests, "t1").map((r) => r.system);
  assert.equal(systems.length, 2);
  assert.equal(systems[0], systems[1]);
  assert.equal(systems[0], buildSystemPrompt("Do the job."));
});

test("the learning section is included when the run has a learning context", async (t) => {
  let afterRuns = 0;
  const learning: LearningHooks = {
    prepare: async () => ({ promptSection: SECTION, given: [], tools: [] }),
    afterRun: async () => {
      afterRuns++;
    },
  };
  const s = await setupAgent(t, { learning });
  const withLearning = await s.run({ turns: [{ text: "ok" }] }, { agent: { learning: true, instructions: "Build it." } });
  await s.h.until(withLearning, "completed");
  const without = await s.run({ turns: [{ text: "ok" }] }, { agent: { learning: false, instructions: "Build it." } });
  await s.h.until(without, "completed");

  const [learned, plain] = requestsFor(s.requests, "t1");
  assert.equal(learned?.system, `Build it.\n\n${SECTION}\n\n${WORKSPACE_NOTE}`);
  assert.equal(plain?.system, `Build it.\n\n${WORKSPACE_NOTE}`);
  assert.equal(afterRuns, 1);
});
