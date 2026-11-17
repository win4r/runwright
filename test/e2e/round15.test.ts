/**
 * Round 15 across package borders, through the real app:
 * - R14D-spec-03 (rule S2): in a real run, every learned item is given at least as a line when the lines fit:
 *   the round-14 probe (two notes, budget 226, first message "alpha"), where rule S gave alpha whole and left beta
 *   out, now gives both, and the model's system prompt carries exactly what the `learning.given` record says.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentDefinition } from "../../src/agents/definition.ts";
import { renderItem, renderLine } from "../../src/learning/proposal.ts";
import { fakeOpenAi, forcedFunction, type FakeOpenAiRequest } from "../fixtures/fake-openai.ts";
import { startTestApp } from "../fixtures/app.ts";
import { fullTimeline, waitForStatus } from "../fixtures/runs.ts";
import { seedLearningItems } from "../helpers/learning.ts";

const AGENT: AgentDefinition = {
  name: "Learner", instructions: "Do the job.",
  model: { provider: "openai-compatible", name: "learner-1", baseUrl: "http://agent.test/v1" },
  tools: [], limits: {}, learning: true,
};

test("R14D-spec-03: a real run whose learned lines all fit is given every item, and its prompt holds exactly those", { timeout: 30_000 }, async (t) => {
  const model = fakeOpenAi((request) => {
    const forced = forcedFunction(request);
    return forced === null ? { deltas: ["done"] } : { calls: [{ name: forced, args: { job_finished: true, files: [] } }] };
  });
  const app = await startTestApp(t, { app: { fetch: model.fetch }, configure: (config) => {
    config.learning.budgetTokens = 226;
  } });
  const { agent } = await app.client.saveAgent(AGENT, "learner");
  const [alpha, beta] = await seedLearningItems(app.app.store, agent.id, [
    { kind: "note", name: "alpha", title: "Alpha", description: "About alpha.", body: "useful alpha ".repeat(50), status: "active" },
    { kind: "note", name: "beta", title: "Beta", description: "About beta.", body: "useful beta ".repeat(50), status: "active" },
  ]);
  assert.ok(alpha !== undefined && beta !== undefined);

  const { run } = await app.client.startRun({ agentId: agent.id, message: "alpha" });
  const { run: done } = await waitForStatus(app.client, run.id, ["completed", "failed", "waiting"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));

  const given = (await fullTimeline(app.client, run.id)).find((r) => r.type === "learning.given")?.data["items"] as
    { itemId: string; mode: string }[] | undefined;
  assert.deepEqual(given?.map((g) => [g.itemId, g.mode]), [[beta.id, "full"], [alpha.id, "line"]],
    "neither note is left out: beta is whole, alpha (costlier to upgrade) is a line");

  const first = model.requests.find((request: FakeOpenAiRequest) => forcedFunction(request) === null);
  const system = first?.body.messages?.find((message) => message.role === "system")?.content ?? "";
  assert.ok(system.includes(renderItem(beta)), "beta is in the prompt whole");
  assert.ok(system.includes(renderLine(alpha)), "alpha is in the prompt as its line");
  assert.ok(!system.includes(alpha.body), "alpha's body is not");
  assert.deepEqual((await app.app.store.learningUses(run.id)).map((u) => [u.itemId, u.mode]).sort(),
    [[alpha.id, "line"], [beta.id, "full"]].sort());
});
