/**
 * `RunContext.deadline(deadlineMs, body)` (plan 3.2 E3, the engine half of R09D-spec-02): a deadline that covers
 * every step started through the scoped context, at any depth, nests with other scopes and with tool calls (the
 * earliest deadline wins), journals nothing itself and measures one execution.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { delay, systemClock } from "../../src/core/clock.ts";
import { createIdSource } from "../../src/core/ids.ts";
import { isRunwrightError } from "../../src/core/errors.ts";
import type { Json } from "../../src/core/json.ts";
import { createGrowingRedactor } from "../../src/core/redact.ts";
import { createLogger } from "../../src/log/logger.ts";
import type { GenerateOptions, ModelRegistry, ModelRequest } from "../../src/models/types.ts";
import type { JournalRecord, RunRecord } from "../../src/store/types.ts";
import { createToolRegistry } from "../../src/tools/registry.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import { createRunContext, type CallHandle, type SessionCore } from "../../src/engine/context.ts";
import { createReplayState } from "../../src/engine/state.ts";
import type { Driver, EngineDeps, RunContext } from "../../src/engine/types.ts";
import { createHarness, fakeModels, reply, type Harness } from "../helpers/engine.ts";
import { testAgentDefinition } from "../helpers/store.ts";
import { waitFor } from "../helpers/wait.ts";

const SHORT = 80;
const LONG = 5_000;

interface Seen { slow: number; slowAborted: number; late: number; fast: number }

/**
 * `slow` waits 3 s unless its signal aborts it first; `late` ignores its signal and returns after 300 ms; `fast`
 * returns at once. All read-only, so a pause leaves them to run again.
 */
function tools(seen: Seen): ToolDefinition[] {
  const parameters = { type: "object", properties: {} };
  return [
    {
      name: "slow", description: "slow", effect: "read", parameters,
      async handler(_args, context) {
        seen.slow++;
        try {
          await delay(3_000, context.signal);
        } catch (error) {
          seen.slowAborted++;
          throw error;
        }
        return { content: "slow done" };
      },
    },
    {
      name: "late", description: "late", effect: "read", parameters,
      async handler() {
        seen.late++;
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { content: "late done" };
      },
    },
    {
      name: "fast", description: "fast", effect: "read", parameters,
      async handler() {
        seen.fast++;
        return { content: "fast done" };
      },
    },
  ];
}

/** A model that answers after 3 s unless aborted first. */
const slowModels: ModelRegistry = fakeModels(async (_request: ModelRequest, options: GenerateOptions) => {
  await delay(3_000, options.signal);
  return reply({ text: "late reply" });
});

/** The code and message of what `promise` rejected with, or `{value}` when it resolved. */
async function settle(promise: Promise<unknown>): Promise<Json> {
  try {
    return { value: (await promise) as Json };
  } catch (error) {
    if (isRunwrightError(error)) return { code: error.code, message: error.message };
    throw error;
  }
}

async function setup(t: TestContext, driver: Driver, models: ModelRegistry = fakeModels(() => reply({ text: "hi" }))) {
  const seen: Seen = { slow: 0, slowAborted: 0, late: 0, fast: 0 };
  const h = await createHarness(t, { models, tools: tools(seen), drivers: { agent: driver } });
  const agent = await h.saveAgent({ tools: [{ name: "slow" }, { name: "late" }, { name: "fast" }] });
  return { h, seen, agentId: agent.id };
}

async function runToEnd(h: Harness, agentId: string) {
  const started = Date.now();
  const run = await h.start(agentId);
  const done = await h.until(run.id, ["completed", "failed", "cancelled"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  return { run, done, elapsed: Date.now() - started, journal: await h.journal(run.id) };
}

const keyed = (journal: readonly JournalRecord[], key: string): string[] => journal.filter((r) => r.key === key).map((r) => r.type);

test("a slow tool in the scope is journalled timeout, deadline rejects, and the next step never starts", async (t) => {
  const { h, seen, agentId } = await setup(t, async (ctx) => settle(ctx.deadline(SHORT, async (s) => {
    await s.tool("first", { name: "slow", args: {} });
    await s.tool("second", { name: "fast", args: {} });
    return "unreachable";
  })));
  const { done, elapsed, journal } = await runToEnd(h, agentId);
  assert.deepEqual(done.output, { code: "deadline_exceeded", message: `the deadline of ${SHORT} ms passed` });
  assert.ok(elapsed < 2_500, `the scope stopped the slow tool (${elapsed} ms)`);
  assert.equal(seen.slowAborted, 1);
  assert.equal(seen.fast, 0);
  const finished = journal.find((r) => r.type === "tool.finished" && r.key === "first");
  assert.equal(finished?.data["outcome"], "timeout");
  assert.equal(finished?.data["content"], 'tool "slow" was stopped: the deadline of the enclosing call passed');
  assert.deepEqual(keyed(journal, "second"), [], "no tool.started for the step after the deadline");
});

test("a body that finishes in time returns its value and leaves nothing behind for later steps", async (t) => {
  const { h, agentId } = await setup(t, async (ctx) => {
    const value = await ctx.deadline(150, async (s) => (await s.tool("quick", { name: "fast", args: {} })).content);
    const after = await ctx.tool("after", { name: "late", args: {} });
    await ctx.sleep(200);
    return { value, after: after.outcome };
  });
  const { done, elapsed } = await runToEnd(h, agentId);
  assert.deepEqual(done.output, { value: "fast done", after: "ok" });
  assert.ok(elapsed >= 450, `the later steps ran to the end (${elapsed} ms)`);
});

test("a tool that ignores its signal and returns late: deadline still rejects", async (t) => {
  const { h, seen, agentId } = await setup(t, async (ctx) => settle(ctx.deadline(SHORT, async (s) => (await s.tool("l", { name: "late", args: {} })).content)));
  const { done, journal } = await runToEnd(h, agentId);
  assert.deepEqual(done.output, { code: "deadline_exceeded", message: `the deadline of ${SHORT} ms passed` });
  assert.equal(seen.late, 1);
  assert.deepEqual(keyed(journal, "l"), ["tool.started", "tool.finished"]);
});

test("a model call in flight at the scope's deadline is journalled model.interrupted {reason: deadline} and charged", async (t) => {
  const { h, agentId } = await setup(t, async (ctx) => settle(ctx.deadline(SHORT, async (s) => {
    await s.model("m", { purpose: "run", system: "s", messages: [{ role: "user", content: "hi" }], maxOutputTokens: 50 });
    return "unreachable";
  })), slowModels);
  const { run, done, elapsed } = await runToEnd(h, agentId);
  assert.ok(elapsed < 2_500, `the model call was aborted (${elapsed} ms)`);
  const output = done.output as { code: string };
  assert.equal(output.code, "deadline_exceeded");
  const started = (await h.records(run.id, "model.started"))[0];
  assert.ok(started !== undefined);
  assert.deepEqual(await h.records(run.id, "model.interrupted"), [
    { model: started.model, reason: "deadline", assumedCostMicros: started.worstCaseMicros, attempt: 1 },
  ]);
  assert.equal(done.usage.costMicros, started.worstCaseMicros);
});

test("nesting: a long scope inside a short one rejects at the outer deadline without swallowing the inner error", async (t) => {
  let inner: Json = null;
  const { h, agentId } = await setup(t, async (ctx) => settle(ctx.deadline(SHORT, async (outer) => {
    inner = await settle(outer.deadline(LONG, async (s) => {
      await s.tool("slow", { name: "slow", args: {} });
      await s.tool("next", { name: "fast", args: {} });
      return "unreachable";
    }));
    return inner;
  })));
  const { done, elapsed, journal } = await runToEnd(h, agentId);
  assert.ok(elapsed < 2_500, `${elapsed} ms`);
  assert.deepEqual(done.output, { code: "deadline_exceeded", message: `the deadline of ${SHORT} ms passed` });
  assert.deepEqual(inner, { code: "deadline_exceeded", message: "the step's deadline passed" }, "the inner scope rethrew its body's error");
  assert.deepEqual(keyed(journal, "next"), []);
});

test("nesting: a short scope inside a long one rejects alone, and the outer body continues", async (t) => {
  const { h, agentId } = await setup(t, async (ctx) => ctx.deadline(LONG, async (outer) => {
    const inner = await settle(outer.deadline(SHORT, async (s) => (await s.tool("slow", { name: "slow", args: {} })).content));
    const next = await outer.tool("next", { name: "fast", args: {} });
    return { inner, next: next.content };
  }));
  const { done, elapsed } = await runToEnd(h, agentId);
  assert.ok(elapsed < 2_500, `${elapsed} ms`);
  assert.deepEqual(done.output, { inner: { code: "deadline_exceeded", message: `the deadline of ${SHORT} ms passed` }, next: "fast done" });
});

test("a scope inside a resumable tool's steps, and a tool call inside a scope: the earliest deadline wins", async (t) => {
  const seen: Seen = { slow: 0, slowAborted: 0, late: 0, fast: 0 };
  const host: ToolDefinition = {
    name: "host", description: "host", effect: "write", resumable: true, parameters: { type: "object", properties: {} },
    async handler(_args, context) {
      const result = await settle(context.steps.deadline(SHORT, (s) => s.tool("inner", { name: "slow", args: {} })));
      return { content: JSON.stringify(result) };
    },
  };
  const driver: Driver = async (ctx) => {
    const hosted = await ctx.tool("host", { name: "host", args: {}, deadlineMs: LONG });
    const own = await ctx.deadline(LONG, (s) => s.tool("own", { name: "slow", args: {}, deadlineMs: SHORT }));
    const scoped = await settle(ctx.deadline(SHORT, (s) => s.tool("scoped", { name: "slow", args: {}, deadlineMs: LONG })));
    return { hosted: hosted.content, own: own.outcome, scoped };
  };
  const h = await createHarness(t, { models: fakeModels(() => reply({})), tools: [...tools(seen), host], drivers: { agent: driver } });
  const agent = await h.saveAgent({ tools: [{ name: "slow" }, { name: "host" }] });
  const { done, elapsed, journal } = await runToEnd(h, agent.id);
  assert.ok(elapsed < 2_500, `every slow call was cut short (${elapsed} ms)`);
  const output = done.output as { hosted: string; own: string; scoped: Json };
  assert.deepEqual(JSON.parse(output.hosted), { code: "deadline_exceeded", message: `the deadline of ${SHORT} ms passed` });
  assert.equal(output.own, "timeout");
  assert.deepEqual(output.scoped, { code: "deadline_exceeded", message: `the deadline of ${SHORT} ms passed` });
  assert.equal(journal.find((r) => r.type === "tool.finished" && r.key === "host/inner")?.data["outcome"], "timeout");
  assert.equal(journal.find((r) => r.type === "tool.finished" && r.key === "own")?.data["content"], `tool "slow" timed out after ${SHORT} ms`);
  assert.equal(journal.find((r) => r.type === "tool.finished" && r.key === "scoped")?.data["outcome"], "timeout");
  assert.equal(seen.slowAborted, 3);
});

test("child contexts of the scoped context are covered and keep the keys they have without the scope", async (t) => {
  const steps = async (base: RunContext): Promise<string> => {
    const x = base.child("x");
    await x.memo("m", { recordType: "step", name: "m" }, async () => 1);
    await x.child("y").tool("t", { name: "fast", args: {} });
    await x.child("y").sleep(3_000);
    return "slept";
  };
  const keysOf = (journal: readonly JournalRecord[]): string[] => journal.filter((r) => r.key !== null).map((r) => `${r.type} ${r.key as string}`);
  const plain = await setup(t, async (ctx) => {
    await ctx.child("x").memo("m", { recordType: "step", name: "m" }, async () => 1);
    await ctx.child("x").child("y").tool("t", { name: "fast", args: {} });
    return "done";
  });
  const without = await runToEnd(plain.h, plain.agentId);
  const scoped = await setup(t, async (ctx) => settle(ctx.deadline(SHORT, steps)));
  const within = await runToEnd(scoped.h, scoped.agentId);
  assert.ok(within.elapsed < 2_500, `the nested sleep stopped at the deadline (${within.elapsed} ms)`);
  assert.deepEqual(within.done.output, { code: "deadline_exceeded", message: `the deadline of ${SHORT} ms passed` });
  assert.deepEqual(keysOf(within.journal), keysOf(without.journal));
  assert.deepEqual(keysOf(within.journal), ["step.started x/m", "step.finished x/m", "tool.started x/y/t", "tool.finished x/y/t"]);
});

test("a pause inside the scope pauses the run, and after resume the body runs under a fresh deadline", async (t) => {
  let sessions = 0;
  const { h, agentId } = await setup(t, async (ctx) => ctx.deadline(600, async (s) => {
    sessions++;
    await s.sleep(sessions === 1 ? 3_000 : 20);
    return (await s.tool("after", { name: "fast", args: {} })).content;
  }));
  const started = Date.now();
  const run = await h.start(agentId);
  await waitFor(() => sessions === 1);
  await h.send(run.id, { type: "pause" });
  await h.until(run.id, "paused");
  await delay(700);
  await h.send(run.id, { type: "resume" });
  const done = await h.until(run.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(done.output, "fast done");
  assert.equal(sessions, 2);
  assert.ok(Date.now() - started >= 700, "the run took longer than its 600 ms deadline across both sessions");
});

test("a body that asks a person: the run waits, the scope journals nothing, and the answer completes the run", async (t) => {
  const { h, agentId } = await setup(t, async (ctx) => ctx.deadline(LONG, async (s) => (await s.ask("q", { question: "name?" })).answer));
  const run = await h.start(agentId);
  await h.until(run.id, "waiting");
  const [pending] = await h.pendings(run.id);
  assert.equal(pending?.stepKey, "q");
  await h.send(run.id, { type: "answer", pendingId: (pending as { id: string }).id, answer: "Ada" });
  const done = await h.until(run.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(done.output, "Ada");
  const journal = await h.journal(run.id);
  assert.deepEqual([...new Set(journal.filter((r) => r.key !== null).map((r) => r.key))], ["q"], "only the question's records are keyed");
});

test("an invalid deadlineMs is bad_request and registers nothing", async () => {
  let registered = 0;
  const state = createReplayState({ maxCostMicros: null, maxToolCalls: null, maxTurns: null, allowUnpriced: false });
  const deps = {
    clock: systemClock, ids: createIdSource(), logger: createLogger({ write: () => undefined }), tools: createToolRegistry([]),
    config: { denyTools: [], toolResultBytes: 16_384 },
  } as unknown as EngineDeps;
  const core: SessionCore = {
    deps, run: { id: "run_1", agentId: "agent_1" } as RunRecord, definition: testAgentDefinition(), workspace: "/nonexistent",
    signal: new AbortController().signal, logger: deps.logger, redactor: createGrowingRedactor(), toolSecrets: {}, state,
    learning: null, inflight: new Map(), reserved: { micros: 0, turns: 0, toolStarts: 0 }, repairTurns: new Map(),
    checkControl: () => undefined,
    commit: async () => [],
    register(): CallHandle {
      registered++;
      return { signal: new AbortController().signal, cause: () => null, dispose: () => undefined };
    },
    deadlineAt: () => null,
    expirePendings: async () => undefined,
    toolScope: () => null,
  };
  const ctx = createRunContext(core, "");
  let bodies = 0;
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "100" as unknown as number]) {
    await assert.rejects(ctx.deadline(bad, async () => {
      bodies++;
      return null;
    }), (e: unknown) => isRunwrightError(e) && e.code === "bad_request"
      && e.message === "a deadline must be a finite number of milliseconds greater than 0");
  }
  assert.equal(bodies, 0);
  assert.equal(registered, 0);
  assert.equal(await ctx.deadline(1_000, async () => "ok"), "ok");
  assert.equal(registered, 1, "a valid deadline registers one handle");
});

test("a tool or model step with an invalid deadlineMs is bad_request and journals nothing", async (t) => {
  const { h, seen, agentId } = await setup(t, async (ctx) => {
    const codes: Json[] = [];
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      codes.push(await settle(ctx.tool(`t${codes.length}`, { name: "fast", args: {}, deadlineMs: bad })));
      codes.push(await settle(ctx.model(`m${codes.length}`, { purpose: "run", system: "s", messages: [], deadlineMs: bad })));
    }
    return codes;
  });
  const { done, journal } = await runToEnd(h, agentId);
  const bad = { code: "bad_request", message: "a deadline must be a finite number of milliseconds greater than 0" };
  assert.deepEqual(done.output, Array.from({ length: 8 }, () => bad));
  assert.equal(seen.fast, 0);
  assert.deepEqual(journal.filter((r) => r.key !== null), []);
});
