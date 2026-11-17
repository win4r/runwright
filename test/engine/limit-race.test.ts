/**
 * A limit check reads the limits before the pending it opens is committed. A limits command applied between the
 * two found no pending to resolve; the pending is then not opened, and the step is checked again under the new
 * limits instead of leaving the run waiting on a limit that was already raised.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelRegistry } from "../../src/models/types.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import type { Driver } from "../../src/engine/types.ts";
import { commandGate, createHarness, fakeModels, reply, type Harness } from "../helpers/engine.ts";

const echo: ToolDefinition = {
  name: "echo", description: "echo", effect: "read", parameters: { type: "object", properties: {} },
  handler: async () => ({ content: "echoed" }),
};

test("a tool-call budget raised while the budget pending is being opened: no pending, the call runs", async (t) => {
  const gate = commandGate();
  let harness: Harness | null = null;
  let once = false;
  const driver: Driver = async (ctx) => {
    if (!once) {
      once = true;
      await gate.hold((harness as Harness).store, ctx.run.id, { type: "limits", limits: { maxToolCalls: 5 } });
    }
    const step = ctx.tool("c", { name: "echo", args: {} });
    gate.releaseSoon();
    return (await step).content;
  };
  const h = await createHarness(t, { models: fakeModels(() => reply({})), tools: [echo], drivers: { agent: driver }, wrapStore: gate.wrap });
  harness = h;
  const agent = await h.saveAgent({ tools: [{ name: "echo" }] });
  const run = await h.start(agent.id, {}, { maxToolCalls: 0 });
  const done = await h.until(run.id, ["completed", "failed", "waiting"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(done.output, "echoed");
  assert.deepEqual(await h.records(run.id, "pending.opened"), []);
});

test("a spend cap raised while the spend_cap pending is being opened: no pending, the model call is sent", async (t) => {
  const gate = commandGate();
  let harness: Harness | null = null;
  let once = false;
  const models: ModelRegistry = {
    resolve: async () => {
      gate.releaseSoon();
      return { generate: async () => reply({ text: "sent" }) };
    },
  };
  const driver: Driver = async (ctx) => {
    if (!once) {
      once = true;
      await gate.hold((harness as Harness).store, ctx.run.id, { type: "limits", limits: { maxCostMicros: 10_000_000 } });
    }
    return (await ctx.model("m", { purpose: "run", system: "s", messages: [{ role: "user", content: "hi" }] })).text;
  };
  const h = await createHarness(t, { models, drivers: { agent: driver }, wrapStore: gate.wrap });
  harness = h;
  const agent = await h.saveAgent();
  const run = await h.start(agent.id, {}, { maxCostMicros: 1 });
  const done = await h.until(run.id, ["completed", "failed", "waiting"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(done.output, "sent");
  assert.deepEqual(await h.records(run.id, "pending.opened"), []);
});
