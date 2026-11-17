/**
 * Round 16's engine fixes through the real app (HTTP server, in-process runner, SQLite store, the
 * OpenAI-compatible adapter over a fake endpoint):
 * - R15-01 (rule U): a provider that reports no usage is charged the reserved bound, so a cap that fits one call's
 *   worst case admits exactly one call.
 * - R15D-engine-02: a cap lowered during a provider's retry-after wait stops the next attempt before it is sent.
 * - R15D-engine-01: a call denied by a person stays denied when another call of the tool is approved always in
 *   the same batch of commands.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { AgentDefinition } from "../../src/agents/definition.ts";
import type { JsonObject } from "../../src/core/json.ts";
import type { WorkflowDocument } from "../../src/workflow/types.ts";
import { startTestApp, type TestApp } from "../fixtures/app.ts";
import { fullTimeline, scriptedAgent, waitForStatus } from "../fixtures/runs.ts";
import { fragment, sse } from "../models/fake-fetch.ts";

/** A streamed Chat Completions reply that calls `record_effect` and reports no usage at all. */
function noUsageStream(label: string): Response {
  const events = [
    { data: { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_0", function: { name: "record_effect", arguments: JSON.stringify({ label }) } }] }, finish_reason: null }] } },
    { data: { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] } },
    { data: "[DONE]" },
  ];
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of fragment(sse(events), 17)) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function textStream(text: string): Response {
  const events = [
    { data: { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] } },
    { data: { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] } },
    { data: { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } } },
    { data: "[DONE]" },
  ];
  return new Response(sse(events), { status: 200, headers: { "content-type": "text/event-stream" } });
}

const MODEL = { provider: "openai-compatible", name: "metered-1", baseUrl: "http://model.test/v1" } as const;

function meteredAgent(name: string, maxOutputTokens: number): AgentDefinition {
  return {
    name, instructions: "Record effects.", model: { ...MODEL, maxOutputTokens },
    tools: [{ name: "record_effect" }], limits: {}, learning: false,
  };
}

async function startMeteredApp(t: Parameters<typeof startTestApp>[0], respond: (index: number) => Response): Promise<TestApp & { requests: () => number }> {
  let requests = 0;
  const fetch = (async () => respond(requests++)) as unknown as typeof globalThis.fetch;
  const app = await startTestApp(t, {
    app: { fetch },
    configure: (config) => {
      config.models.prices["openai-compatible/metered-1"] = { inputPerMTok: 1, outputPerMTok: 5 };
    },
  });
  return Object.assign(app, { requests: () => requests });
}

test("(R15-01) a real run whose provider reports no usage is charged its worst case and admits one call under a two-call cap", { timeout: 30_000 }, async (t) => {
  const app = await startMeteredApp(t, (index) => noUsageStream(`turn${index}`));
  const { agent } = await app.client.saveAgent(meteredAgent("No usage", 1900), "no-usage");
  const { run } = await app.client.startRun({ agentId: agent.id, message: "go", limits: { maxCostMicros: 20_000 } });
  const { run: paused } = await waitForStatus(app.client, run.id, ["waiting", "completed", "failed"]);
  assert.equal(paused.status, "waiting", JSON.stringify(paused.error));
  assert.equal(app.requests(), 1, "on round 15 the run made five requests");
  const records = await fullTimeline(app.client, run.id);
  const started = records.find((r) => r.type === "model.started")?.data as JsonObject;
  const finished = records.find((r) => r.type === "model.finished")?.data as JsonObject;
  assert.deepEqual(finished["usageAssumed"], ["input", "output"]);
  assert.deepEqual(finished["usage"], {
    inputTokens: started["inputTokensEstimate"], outputTokens: 1900, cacheReadTokens: 0, cacheWriteTokens: 0,
  });
  assert.equal(finished["costMicros"], started["worstCaseMicros"]);
  assert.equal(paused.usage.costMicros, started["worstCaseMicros"]);
  assert.ok(paused.usage.costMicros <= 20_000);
  const { pendings } = await app.client.listPendings({ runId: run.id, status: "open" });
  assert.equal(pendings[0]?.kind, "spend_cap");
});

test("(R15D-engine-02) a real run: the cap lowered during the provider's retry-after wait stops the next attempt", { timeout: 30_000 }, async (t) => {
  const app = await startMeteredApp(t, (index) => (index === 0
    ? new Response(JSON.stringify({ error: { message: "slow down", type: "rate_limit" } }), {
      status: 429, headers: { "content-type": "application/json", "retry-after": "2" },
    })
    : textStream("done")));
  const { agent } = await app.client.saveAgent(meteredAgent("Retried", 100), "retried");
  const { run } = await app.client.startRun({ agentId: agent.id, message: "go", limits: { maxCostMicros: 1_000_000 } });
  const deadline = Date.now() + 10_000;
  while (!(await fullTimeline(app.client, run.id)).some((r) => r.type === "model.retry")) {
    assert.ok(Date.now() < deadline, "the first attempt was retried");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await app.client.setLimits(run.id, { maxCostMicros: 0 });
  const { run: paused } = await waitForStatus(app.client, run.id, ["waiting", "completed", "failed"]);
  assert.equal(paused.status, "waiting", JSON.stringify(paused.error));
  assert.equal(app.requests(), 1, "the attempt after the wait was not sent");
  const { pendings } = await app.client.listPendings({ runId: run.id, status: "open" });
  assert.equal(pendings[0]?.kind, "spend_cap");
  await app.client.setLimits(run.id, { maxCostMicros: 1_000_000 });
  const { run: done } = await waitForStatus(app.client, run.id, ["completed", "failed", "waiting"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(app.requests(), 2);
});

function approvalWorkflow(): WorkflowDocument {
  const effect = (id: string): JsonObject => ({ id, kind: "tool", tool: "record_effect", args: { label: id }, onError: "continue" });
  return {
    format: "runwright.workflow/v1", name: "approvals", schemas: { In: { type: "object" }, Out: {} }, input: "In", output: "Out",
    root: { id: "main", kind: "sequence", steps: [{ id: "both", kind: "parallel", branches: [effect("first"), effect("second")] }, effect("later")] },
    result: "done",
  } as unknown as WorkflowDocument;
}

test("(R15D-engine-01) a real run: one call denied and the other approved always in one batch; the denied call never runs", { timeout: 30_000 }, async (t) => {
  const app = await startTestApp(t);
  const { agent } = await app.client.saveAgent({
    ...scriptedAgent({ name: "approvals", tools: [{ name: "record_effect", policy: "ask" }], script: { turns: [] } }),
    workflow: approvalWorkflow(),
  }, "approvals");
  const { run } = await app.client.startRun({ agentId: agent.id, data: {} });
  await waitForStatus(app.client, run.id, ["waiting"]);
  const open = async () => (await app.client.listPendings({ runId: run.id, status: "open" })).pendings;
  let pendings = await open();
  const deadline = Date.now() + 10_000;
  while (pendings.length < 2) {
    assert.ok(Date.now() < deadline, "both approvals opened");
    await new Promise((resolve) => setTimeout(resolve, 10));
    pendings = await open();
  }
  const keyOf = (label: string): string => {
    const found = pendings.find((p) => p.detail["args"] !== undefined && (p.detail["args"] as JsonObject)["label"] === label);
    assert.ok(found !== undefined, `the approval of ${label}`);
    return found.id;
  };
  // Paused, the run applies nothing until it is resumed: the deny and the approve-always land in one batch.
  await app.client.pauseRun(run.id);
  await waitForStatus(app.client, run.id, ["paused"]);
  await app.client.deny(keyOf("first"), "not this one");
  await app.client.approve(keyOf("second"), { always: true });
  await app.client.resumeRun(run.id);
  const { run: done } = await waitForStatus(app.client, run.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  const effects = (await readFile(app.effects, "utf8")).split("\n").filter((line) => line !== "");
  assert.deepEqual(effects, ["second", "later"], "the denied call's handler never ran; the later call ran without asking");
  const finished = (await fullTimeline(app.client, run.id)).filter((r) => r.type === "tool.finished").map((r) => r.data["outcome"]);
  assert.deepEqual(finished.sort(), ["denied", "ok", "ok"]);
});
