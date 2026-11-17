/**
 * Steps nested in a tool call through `ToolContext.steps` belong to that call (plan 4.6): once the enclosing call
 * is aborted no further nested step starts, and the nested steps in flight are aborted with the same cause and
 * journalled as if it had hit them directly.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { delay } from "../../src/core/clock.ts";
import { isRunwrightError } from "../../src/core/errors.ts";
import type { JsonObject } from "../../src/core/json.ts";
import type { GenerateOptions, ModelRequest, ModelResponse } from "../../src/models/types.ts";
import type { JournalRecord } from "../../src/store/types.ts";
import type { ToolContext, ToolDefinition } from "../../src/tools/types.ts";
import type { Driver } from "../../src/engine/types.ts";
import { createHarness, fakeModels, reply, type Harness } from "../helpers/engine.ts";
import { waitFor } from "../helpers/wait.ts";

const DEADLINE_MS = 40;

/** One tool call `call` of the resumable `host` tool, with the deadline given in the run input data. */
const hostDriver: Driver = async (ctx) => {
  const data = ctx.run.input.data as JsonObject;
  const deadline = typeof data["deadlineMs"] === "number" ? { deadlineMs: data["deadlineMs"] } : {};
  const result = await ctx.tool("call", { name: "host", args: { mode: String(data["mode"]) }, ...deadline });
  return { outcome: result.outcome, content: result.content };
};

interface Seen {
  hostCalls: number;
  sameSignal: boolean | null;
  lateStepError: string | null;
  slowCalls: number;
  slowAborted: boolean;
}

function tools(seen: Seen): ToolDefinition[] {
  const nestedModel = (steps: ToolContext["steps"]) => steps.model("m", { purpose: "step", system: "s", messages: [{ role: "user", content: "hi" }] });
  const host: ToolDefinition = {
    name: "host", description: "host", effect: "write", resumable: true,
    parameters: { type: "object", required: ["mode"], properties: { mode: { type: "string" } } },
    async handler(args, context) {
      seen.hostCalls++;
      seen.sameSignal = context.steps.signal === context.signal;
      switch (args["mode"]) {
        case "late-step": {
          await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
          try {
            await context.steps.memo("after", { recordType: "step", name: "after" }, async () => "never");
          } catch (error) {
            seen.lateStepError = isRunwrightError(error) ? error.code : String(error);
            throw error;
          }
          return { content: "unreachable" };
        }
        case "sleep":
          await context.steps.sleep(5_000);
          return { content: "slept" };
        case "model": {
          const result = await nestedModel(context.steps);
          return { content: result.text };
        }
        case "tool": {
          const result = await context.steps.tool("inner", { name: "slow", args: {} });
          await context.steps.memo("after", { recordType: "step", name: "after" }, async () => "next");
          return { content: result.content };
        }
        default:
          return { content: "unknown mode" };
      }
    },
  };
  const slow: ToolDefinition = {
    name: "slow", description: "slow", effect: "write", parameters: { type: "object", properties: {} },
    async handler(_args, context) {
      seen.slowCalls++;
      try {
        await delay(5_000, context.signal);
      } catch (error) {
        seen.slowAborted = context.signal.aborted;
        throw error;
      }
      return { content: "slow done" };
    },
  };
  return [host, slow];
}

/** A model that answers after `ms` unless aborted first (the abort is honoured). */
function delayedModels(ms: () => number) {
  let calls = 0;
  const models = fakeModels(async (_request: ModelRequest, options: GenerateOptions): Promise<ModelResponse> => {
    calls++;
    await delay(ms(), options.signal);
    return reply({ text: "nested reply", usage: { inputTokens: 3, outputTokens: 2 } });
  });
  return { models, calls: () => calls };
}

async function setup(t: TestContext, modelMs: () => number = () => 5_000) {
  const seen: Seen = { hostCalls: 0, sameSignal: null, lateStepError: null, slowCalls: 0, slowAborted: false };
  const { models, calls } = delayedModels(modelMs);
  const h = await createHarness(t, { models, tools: tools(seen), drivers: { agent: hostDriver } });
  const agent = await h.saveAgent({ tools: [{ name: "host" }, { name: "slow" }] });
  return { h, seen, agentId: agent.id, modelCalls: calls };
}

const under = (journal: readonly JournalRecord[], prefix: string): JournalRecord[] => journal.filter((r) => r.key?.startsWith(prefix) === true);

function outer(journal: readonly JournalRecord[]): JournalRecord {
  const finished = journal.find((r) => r.type === "tool.finished" && r.key === "call");
  assert.ok(finished !== undefined, "the enclosing call is finished");
  return finished;
}

async function runMode(h: Harness, agentId: string, mode: string, deadlineMs: number | null = DEADLINE_MS) {
  const started = Date.now();
  const run = await h.start(agentId, { data: deadlineMs === null ? { mode } : { mode, deadlineMs } });
  const done = await h.until(run.id, ["completed", "failed", "cancelled"]);
  return { done, elapsed: Date.now() - started, journal: await h.journal(run.id) };
}

test("steps.signal is the call's signal; a nested step requested after the deadline throws deadline_exceeded and journals nothing", async (t) => {
  const { h, seen, agentId } = await setup(t);
  const { done, journal } = await runMode(h, agentId, "late-step");
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(seen.sameSignal, true);
  assert.equal(seen.lateStepError, "deadline_exceeded");
  assert.equal(outer(journal).data["outcome"], "timeout");
  assert.deepEqual(under(journal, "call/"), [], "no nested record was written");
});

test("a nested sleep stops at the enclosing call's deadline", async (t) => {
  const { h, agentId } = await setup(t);
  const { done, elapsed, journal } = await runMode(h, agentId, "sleep");
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(outer(journal).data["outcome"], "timeout");
  assert.ok(elapsed < 2_000, `the sleep was cut short (${elapsed} ms)`);
});

test("a nested model call in flight at the deadline is journalled model.interrupted {reason: deadline} and charged", async (t) => {
  const { h, agentId } = await setup(t);
  const { done, elapsed, journal } = await runMode(h, agentId, "model");
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  const interrupted = journal.filter((r) => r.type === "model.interrupted" && r.key === "call/m");
  assert.equal(interrupted.length, 1);
  assert.equal(interrupted[0]?.data["reason"], "deadline");
  const assumed = interrupted[0]?.data["assumedCostMicros"];
  assert.ok(typeof assumed === "number" && assumed > 0);
  assert.equal(done.usage.costMicros, assumed, "the assumed cost is the run's spend");
  const finished = outer(journal);
  assert.equal(finished.data["outcome"], "timeout");
  assert.ok((interrupted[0] as JournalRecord).seq < finished.seq);
  assert.ok(elapsed < 2_000, `the model call was cut short (${elapsed} ms)`);
});

test("a nested cooperative tool call is journalled timeout, and the next nested step does not start", async (t) => {
  const { h, seen, agentId } = await setup(t);
  const { done, journal } = await runMode(h, agentId, "tool");
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(seen.slowCalls, 1);
  assert.equal(seen.slowAborted, true, "the nested handler saw its signal abort");
  const nested = journal.find((r) => r.type === "tool.finished" && r.key === "call/inner");
  assert.equal(nested?.data["outcome"], "timeout");
  assert.match(String(nested?.data["content"]), /deadline of the enclosing call/);
  assert.equal(outer(journal).data["outcome"], "timeout");
  assert.equal(journal.some((r) => r.key === "call/after"), false);
});

test("without a deadline nested steps run as before", async (t) => {
  const { h, agentId } = await setup(t, () => 1);
  const { done, journal } = await runMode(h, agentId, "model", null);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(outer(journal).data["outcome"], "ok");
  assert.deepEqual(done.output, { outcome: "ok", content: "nested reply" });
});

test("a pause during a nested model call leaves the resumable call unfinished; resume completes it once", async (t) => {
  let delayMs = 5_000;
  const { h, seen, agentId, modelCalls } = await setup(t, () => delayMs);
  const run = await h.start(agentId, { data: { mode: "model" } });
  await waitFor(async () => (await h.journal(run.id)).some((r) => r.type === "model.started" && r.key === "call/m"));
  await h.send(run.id, { type: "pause" });
  await h.until(run.id, "paused");
  let journal = await h.journal(run.id);
  assert.deepEqual(journal.filter((r) => r.type === "model.interrupted").map((r) => [r.key, r.data["reason"]]), [["call/m", "pause"]]);
  assert.equal(journal.some((r) => r.type === "tool.finished"), false, "the enclosing call stays unfinished");
  assert.equal(journal.some((r) => r.type === "tool.interrupted"), false, "a resumable call needs no person");
  delayMs = 1;
  await h.send(run.id, { type: "resume" });
  const done = await h.until(run.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  journal = await h.journal(run.id);
  assert.equal(journal.filter((r) => r.type === "model.finished" && r.key === "call/m").length, 1);
  assert.equal(journal.filter((r) => r.type === "tool.finished" && r.key === "call").length, 1);
  assert.equal(outer(journal).data["outcome"], "ok");
  assert.equal(seen.hostCalls, 2, "the resumable handler ran again after the resume");
  assert.equal(modelCalls(), 2, "the interrupted nested call was sent again exactly once");
});
