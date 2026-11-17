/**
 * R15D-engine-02: an attempt is admitted against the limits in force when its start record is written. The commit
 * that writes a `model.started` or a counted `tool.started` record checks the spend cap, the turn limit and the
 * tool-call budget inside itself, against the limits and usage as they are then, so a `limits` command applied
 * during a backoff, a resumed provider wait or the wait for the commit lock is seen before anything is sent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RunwrightError } from "../../src/core/errors.ts";
import { settleAll } from "../../src/engine/control.ts";
import type { Driver, ModelStepRequest, RunContext } from "../../src/engine/types.ts";
import type { ModelRequest, ModelRetry } from "../../src/models/types.ts";
import type { RunCommand } from "../../src/store/types.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import { commandGate, createHarness, fakeModels, fakeTimers, reply, type FakeTimers, type Harness } from "../helpers/engine.ts";

const BACKOFF = 1000;
const CAP = 1_000_000;

function unavailable(retryAfterMs?: number): RunwrightError {
  return new RunwrightError("model_transient", `HTTP ${retryAfterMs === undefined ? 503 : 429}`, {
    details: { status: retryAfterMs === undefined ? 503 : 429, billing: "none", ...(retryAfterMs === undefined ? {} : { retryAfterMs }) },
  });
}

function retryOn(timers: FakeTimers): ModelRetry {
  return { policy: { maxAttempts: 3, baseMs: BACKOFF, maxMs: BACKOFF }, random: () => 1, sleep: timers.sleep };
}

/** A provider whose first request for each step key fails with `failure`; it counts every request it gets. */
function failingFirst(failure: () => RunwrightError): { respond: (request: ModelRequest) => ReturnType<typeof reply>; requests: string[] } {
  const requests: string[] = [];
  const failed = new Set<string>();
  return {
    requests,
    respond(request) {
      requests.push(request.meta.key);
      if (!failed.has(request.meta.key)) {
        failed.add(request.meta.key);
        throw failure();
      }
      return reply({ text: "done", usage: { inputTokens: 1, outputTokens: 1 } });
    },
  };
}

async function untilApplied(h: Harness, runId: string, count: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while ((await h.records(runId, "limits.changed")).length < count) {
    if (Date.now() >= deadline) throw new Error(`${count} limits.changed records did not appear`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const step = (extra?: Partial<ModelStepRequest>): ModelStepRequest => ({
  purpose: "step", system: "s", messages: [{ role: "user", content: "x" }], ...extra,
});

test("(R15D-engine-02) the reviewer's probe: the cap lowered to 0 during a backoff stops attempt 2, and raising it sends it", async (t) => {
  const timers = fakeTimers();
  const provider = failingFirst(() => unavailable());
  const h = await createHarness(t, { models: fakeModels(provider.respond, retryOn(timers)) });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id, {}, { maxCostMicros: CAP });
  await timers.untilWaiting();
  await h.send(run.id, { type: "limits", limits: { maxCostMicros: 0 } });
  await untilApplied(h, run.id, 1);
  timers.advance(BACKOFF);
  await h.until(run.id, "waiting");
  assert.equal(provider.requests.length, 1, "attempt 2 was never sent");
  const [pending] = await h.pendings(run.id);
  assert.equal(pending?.kind, "spend_cap");
  assert.equal(pending?.detail["capMicros"], 0);
  assert.equal(pending?.detail["reason"], "cap");
  assert.deepEqual((await h.records(run.id, "model.started")).map((r) => r.attempt), [1]);

  await h.send(run.id, { type: "limits", limits: { maxCostMicros: CAP } });
  const done = await h.until(run.id, "completed");
  assert.equal(provider.requests.length, 2);
  assert.deepEqual((await h.records(run.id, "model.started")).map((r) => r.attempt), [1, 2], "the next attempt keeps its number");
  assert.ok(done.usage.costMicros <= CAP);
});

test("(R15D-engine-02) allowUnpriced revoked during the backoff of an unpriced model pauses with unknown_price", async (t) => {
  const timers = fakeTimers();
  const provider = failingFirst(() => unavailable());
  const h = await createHarness(t, { models: fakeModels(provider.respond, retryOn(timers)) });
  const agent = await h.saveAgent({ model: { provider: "scripted", name: "unpriced-1" } });
  const run = await h.start(agent.id, {}, { maxCostMicros: CAP, allowUnpriced: true });
  await timers.untilWaiting();
  await h.send(run.id, { type: "limits", limits: { allowUnpriced: false } });
  await untilApplied(h, run.id, 1);
  timers.advance(BACKOFF);
  await h.until(run.id, "waiting");
  assert.equal(provider.requests.length, 1);
  const [pending] = await h.pendings(run.id);
  assert.equal(pending?.kind, "spend_cap");
  assert.equal(pending?.detail["reason"], "unknown_price");
});

test("(R15D-engine-02) the cap lowered during a resumed provider Retry-After wait stops the attempt in the second session", async (t) => {
  const timers = fakeTimers();
  const provider = failingFirst(() => unavailable(5000));
  const h = await createHarness(t, { models: fakeModels(provider.respond, retryOn(timers)), clock: timers.clock });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id, {}, { maxCostMicros: CAP });
  await timers.untilWaiting();
  assert.deepEqual(timers.requested, [5000]);
  timers.advance(1000);
  await h.send(run.id, { type: "pause" });
  await h.until(run.id, "paused");
  await h.send(run.id, { type: "resume" });
  await timers.untilWaiting();
  assert.deepEqual(timers.requested, [5000, 4000], "the second session waits what is left of the provider's wait");
  await h.send(run.id, { type: "limits", limits: { maxCostMicros: 0 } });
  await untilApplied(h, run.id, 1);
  timers.advance(4000);
  await h.until(run.id, "waiting");
  assert.equal(provider.requests.length, 1);
  assert.equal((await h.pendings(run.id))[0]?.kind, "spend_cap");
  await h.send(run.id, { type: "limits", limits: { maxCostMicros: CAP } });
  await h.until(run.id, "completed");
  assert.equal(provider.requests.length, 2);
});

/** A driver that lands `command` between its step's entry checks and the step's start commit, once. */
function gatedDriver(gate: ReturnType<typeof commandGate>, h: () => Harness, command: RunCommand, act: (ctx: RunContext) => Promise<unknown>): Driver {
  let armed = true;
  return async (ctx) => {
    if (armed) {
      armed = false;
      await gate.hold(h().store, ctx.run.id, command);
      const pending = act(ctx);
      gate.releaseSoon();
      await pending;
    } else {
      await act(ctx);
    }
    return { done: true };
  };
}

test("(R15D-engine-02) the cap lowered between the entry check and the first model.started: nothing is sent", async (t) => {
  const gate = commandGate();
  let requests = 0;
  let harness: Harness | null = null;
  const driver = gatedDriver(gate, () => harness as Harness, { type: "limits", limits: { maxCostMicros: 0 } }, (ctx) => ctx.model("m", step()));
  const h = await createHarness(t, {
    models: fakeModels(() => { requests++; return reply({ text: "ok" }); }), drivers: { agent: driver }, wrapStore: gate.wrap,
  });
  harness = h;
  const agent = await h.saveAgent();
  const run = await h.start(agent.id, {}, { maxCostMicros: CAP });
  await h.until(run.id, "waiting");
  assert.equal(requests, 0);
  assert.deepEqual(await h.records(run.id, "model.started"), []);
  assert.equal((await h.pendings(run.id))[0]?.kind, "spend_cap");
  await h.send(run.id, { type: "limits", limits: { maxCostMicros: CAP } });
  await h.until(run.id, "completed");
  assert.equal(requests, 1);
});

test("(R15D-engine-02) the turn limit lowered between the entry check and the first model.started: nothing is sent", async (t) => {
  const gate = commandGate();
  let requests = 0;
  let harness: Harness | null = null;
  const driver = gatedDriver(gate, () => harness as Harness, { type: "limits", limits: { maxTurns: 0 } },
    (ctx) => ctx.model("m", step({ purpose: "run" })));
  const h = await createHarness(t, {
    models: fakeModels(() => { requests++; return reply({ text: "ok" }); }), drivers: { agent: driver }, wrapStore: gate.wrap,
  });
  harness = h;
  const agent = await h.saveAgent();
  const run = await h.start(agent.id, {}, { maxTurns: 5 });
  await h.until(run.id, "waiting");
  assert.equal(requests, 0);
  const [pending] = await h.pendings(run.id);
  assert.equal(pending?.kind, "turn_limit");
  assert.deepEqual(pending?.detail, { limit: 0, used: 0, needed: 1 });
  await h.send(run.id, { type: "limits", limits: { maxTurns: 1 } });
  const done = await h.until(run.id, "completed");
  assert.equal(requests, 1);
  assert.equal(done.usage.turns, 1);
});

test("(R15D-engine-02) two parallel branches in backoff when the cap drops: neither sends", async (t) => {
  const timers = fakeTimers();
  const provider = failingFirst(() => unavailable());
  const driver: Driver = async (ctx) => {
    await settleAll([ctx.model("a", step()), ctx.model("b", step())]);
    return { done: true };
  };
  const h = await createHarness(t, { models: fakeModels(provider.respond, retryOn(timers)), drivers: { agent: driver } });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id, {}, { maxCostMicros: CAP });
  await timers.untilWaiting(2);
  await h.send(run.id, { type: "limits", limits: { maxCostMicros: 0 } });
  await untilApplied(h, run.id, 1);
  timers.advance(BACKOFF);
  await h.until(run.id, "waiting");
  assert.deepEqual(provider.requests.sort(), ["a", "b"], "one request per branch: the failed first attempts");
  assert.deepEqual((await h.pendings(run.id)).map((p) => [p.kind, p.stepKey]).sort(), [["spend_cap", "a"], ["spend_cap", "b"]]);
  await h.send(run.id, { type: "limits", limits: { maxCostMicros: CAP } });
  await h.until(run.id, "completed");
  assert.equal(provider.requests.length, 4);
});

test("(R15D-engine-02) the tool budget lowered between runTool's check and tool.started: the handler does not run", async (t) => {
  const gate = commandGate();
  let ran = 0;
  const tool: ToolDefinition = {
    name: "act", description: "Acts.", effect: "write", parameters: { type: "object", properties: {} },
    handler: async () => { ran++; return { content: "ok" }; },
  };
  let harness: Harness | null = null;
  const driver = gatedDriver(gate, () => harness as Harness, { type: "limits", limits: { maxToolCalls: 0 } },
    (ctx) => ctx.tool("c", { name: "act", args: {} }));
  const h = await createHarness(t, { models: fakeModels(() => reply({})), tools: [tool], drivers: { agent: driver }, wrapStore: gate.wrap });
  harness = h;
  const agent = await h.saveAgent({ tools: [{ name: "act" }] });
  const run = await h.start(agent.id, {}, { maxToolCalls: 5 });
  await h.until(run.id, "waiting");
  assert.equal(ran, 0);
  assert.deepEqual(await h.records(run.id, "tool.started"), []);
  const [pending] = await h.pendings(run.id);
  assert.equal(pending?.kind, "tool_budget");
  assert.deepEqual(pending?.detail, { limit: 0, used: 0, needed: 1 });
  await h.send(run.id, { type: "limits", limits: { maxToolCalls: 1 } });
  const done = await h.until(run.id, "completed");
  assert.equal(ran, 1);
  assert.equal(done.usage.toolCalls, 1);
});
