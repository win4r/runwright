import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentDefinition } from "../../src/agents/definition.ts";
import type { PendingKind, PendingRecord, RunCommand, RunLimits } from "../../src/store/types.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import { createHarness, fakeModels, reply, toolReply } from "../helpers/engine.ts";
import { waitFor } from "../helpers/wait.ts";

const PENDING_FIELDS = ["agentId", "createdAt", "detail", "id", "kind", "resolution", "resolvedAt", "runId", "status", "stepKey", "title"];

function makeTools(): { tools: ToolDefinition[]; hangingCalls: () => number } {
  let hanging = 0;
  const noArgs = { type: "object", properties: {} };
  return {
    hangingCalls: () => hanging,
    tools: [
      {
        name: "ask_someone", description: "Asks.", parameters: noArgs, effect: "write", resumable: true,
        handler: async (_args, context) => ({ content: (await context.steps.ask("q", { question: "Which way?" })).answer }),
      },
      { name: "danger", description: "Dangerous.", parameters: noArgs, effect: "write", handler: async () => ({ content: "did the dangerous thing" }) },
      {
        name: "hang", description: "Hangs once.", parameters: noArgs, effect: "write",
        handler: async (_args, context) => {
          hanging++;
          if (hanging === 1) await new Promise((_r, reject) => context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true }));
          return { content: "finished hanging" };
        },
      },
    ],
  };
}

/** The first user message names the tool to call on turn 1 ("none" for no tool). */
const models = fakeModels((request) => {
  const first = request.messages[0];
  const tool = first !== undefined && first.role === "user" ? first.content : "none";
  if (request.meta.turn === 1 && tool !== "none") return toolReply(tool, {});
  const results = request.messages.filter((m) => m.role === "tool");
  const last = results[results.length - 1];
  return reply({ text: last !== undefined && last.role === "tool" ? last.content : "no tools", usage: { inputTokens: 5, outputTokens: 1 } });
});

interface Scenario {
  kind: PendingKind;
  tool: string;
  agent: Partial<AgentDefinition>;
  limits?: Partial<RunLimits>;
  crashFirst?: boolean;
  resolve: (pending: PendingRecord) => RunCommand;
  output: string;
}

const scenarios: Scenario[] = [
  {
    kind: "question", tool: "ask_someone", agent: { tools: [{ name: "ask_someone" }] },
    resolve: (p) => ({ type: "answer", pendingId: p.id, answer: "left" }), output: "left",
  },
  {
    kind: "approval", tool: "danger", agent: { tools: [{ name: "danger", policy: "ask" }] },
    resolve: (p) => ({ type: "approve", pendingId: p.id, always: false }), output: "did the dangerous thing",
  },
  {
    kind: "spend_cap", tool: "none", agent: {}, limits: { maxCostMicros: 1000 },
    resolve: () => ({ type: "limits", limits: { maxCostMicros: 1_000_000 } }), output: "no tools",
  },
  {
    kind: "tool_budget", tool: "danger", agent: { tools: [{ name: "danger" }] }, limits: { maxToolCalls: 0 },
    resolve: () => ({ type: "limits", limits: { maxToolCalls: 1 } }), output: "did the dangerous thing",
  },
  {
    kind: "turn_limit", tool: "none", agent: {}, limits: { maxTurns: 0 },
    resolve: () => ({ type: "limits", limits: { maxTurns: 3 } }), output: "no tools",
  },
  {
    kind: "interrupted", tool: "hang", agent: { tools: [{ name: "hang" }] }, crashFirst: true,
    resolve: (p) => ({ type: "resolve_interrupted", pendingId: p.id, action: "retry", result: null }), output: "finished hanging",
  },
];

for (const scenario of scenarios) {
  test(`a run waiting on ${scenario.kind} survives a crash and a full runner restart, then continues`, async (t) => {
    const { tools, hangingCalls } = makeTools();
    const h = await createHarness(t, { models, tools });
    const agent = await h.saveAgent(scenario.agent);
    const run = await h.start(agent.id, { message: scenario.tool }, scenario.limits);
    if (scenario.crashFirst === true) {
      await waitFor(() => hangingCalls() === 1);
      await h.crashAndReplace();
    }
    await h.until(run.id, "waiting");
    const [pending] = await h.pendings(run.id);
    assert.ok(pending !== undefined);
    assert.equal(pending.kind, scenario.kind);
    assert.deepEqual(Object.keys(pending).sort(), PENDING_FIELDS);
    assert.equal(pending.status, "open");
    assert.ok(pending.title.length > 0);

    await h.crashAndReplace();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await h.store.getRun(run.id))?.status, "waiting");
    await h.runner.stop();
    const listed = await h.store.listPendings({ status: "open" }, { limit: 50 });
    assert.deepEqual(listed.items.map((p) => p.id), [pending.id]);

    await h.send(run.id, scenario.resolve(pending));
    assert.equal((await h.store.getRun(run.id))?.status, "queued");
    h.runner = h.newRunner();
    const done = await h.until(run.id, "completed");
    assert.deepEqual(done.output, { text: scenario.output });
    const resolved = await h.store.getPending(pending.id);
    assert.equal(resolved?.status, "resolved");
    assert.ok(resolved?.resolution !== null);
    assert.equal(done.openPendings, 0);
  });
}

test("a command for a pending that is not open, or of the wrong kind, is rejected and changes nothing", async (t) => {
  const { tools } = makeTools();
  const h = await createHarness(t, { models, tools });
  const agent = await h.saveAgent({ tools: [{ name: "ask_someone" }] });
  const run = await h.start(agent.id, { message: "ask_someone" });
  await h.until(run.id, "waiting");
  const [pending] = await h.pendings(run.id);
  assert.ok(pending !== undefined);
  await h.send(run.id, { type: "approve", pendingId: pending.id, always: false });
  await h.send(run.id, { type: "answer", pendingId: "pend_unknown", answer: "x" });
  await waitFor(async () => (await h.records(run.id, "command.rejected")).length === 2);
  await h.until(run.id, "waiting");
  const rejected = await h.records(run.id, "command.rejected");
  assert.match(rejected[0]?.reason ?? "", /has kind question; this command resolves approval pendings/);
  assert.match(rejected[1]?.reason ?? "", /does not belong/);
  assert.equal((await h.pendings(run.id)).length, 1);
  await h.send(run.id, { type: "answer", pendingId: pending.id, answer: "right" });
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, { text: "right" });
});
