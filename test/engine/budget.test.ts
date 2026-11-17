/**
 * R15D-engine-03: a count limit says what it needs. For every limit pending, raising the limit by exactly `needed`
 * admits the step that opened it, and raising it by less does not; the same holds for the spend cap's
 * `neededMicros`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ToolDefinition } from "../../src/tools/types.ts";
import { MAX_TOTAL, checkCount, checkSpend } from "../../src/engine/budget.ts";
import { createHarness, fakeModels, reply, toolReply } from "../helpers/engine.ts";

/** A small deterministic generator (mulberry32), so a failing case can be reproduced from its seed. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function neededOf(check: ReturnType<typeof checkCount>): number {
  assert.equal(check.ok, false);
  const needed = check.ok ? null : check.detail["needed"];
  assert.equal(typeof needed, "number");
  return needed as number;
}

test("(R15D-engine-03) checkCount reports what the limit needs to admit one more", () => {
  assert.deepEqual(checkCount(2, 5), { ok: false, detail: { limit: 2, used: 5, needed: 4 } });
  assert.deepEqual(checkCount(2, 2), { ok: false, detail: { limit: 2, used: 2, needed: 1 } });
  assert.deepEqual(checkCount(0, 0), { ok: false, detail: { limit: 0, used: 0, needed: 1 } });
  assert.deepEqual(checkCount(0, 7), { ok: false, detail: { limit: 0, used: 7, needed: 8 } });
  assert.deepEqual(checkCount(5, 4), { ok: true });
  assert.equal(neededOf(checkCount(0, MAX_TOTAL)), MAX_TOTAL, "saturates at MAX_TOTAL");
});

test("(R15D-engine-03) property: limit + needed admits, limit + needed - 1 does not", () => {
  const next = random(1603);
  for (let i = 0; i < 2000; i++) {
    const scale = i % 2 === 0 ? 50 : 1_000_000_000;
    const limit = Math.floor(next() * scale);
    const used = limit + Math.floor(next() * scale);
    const needed = neededOf(checkCount(limit, used));
    assert.ok(needed >= 1, `needed >= 1 for (${limit}, ${used})`);
    assert.deepEqual(checkCount(limit + needed, used), { ok: true }, `limit + needed admits (${limit}, ${used})`);
    assert.equal(checkCount(limit + needed - 1, used).ok, false, `limit + needed - 1 does not (${limit}, ${used})`);
  }
});

test("property: the spend cap raised by neededMicros admits the call, by one less it does not", () => {
  const next = random(1604);
  for (let i = 0; i < 2000; i++) {
    const scale = i % 2 === 0 ? 1000 : 10 ** 12;
    const base = {
      capMicros: Math.floor(next() * scale), spentMicros: Math.floor(next() * scale), reservedMicros: Math.floor(next() * scale),
      worstCaseMicros: Math.floor(next() * scale), costUnknown: false, allowUnpriced: false, model: "m",
    };
    const check = checkSpend(base);
    if (check.ok) continue;
    const needed = check.detail["neededMicros"];
    assert.equal(typeof needed, "number");
    const n = needed as number;
    assert.ok(n >= 1);
    assert.deepEqual(checkSpend({ ...base, capMicros: base.capMicros + n }), { ok: true }, JSON.stringify(base));
    assert.equal(checkSpend({ ...base, capMicros: base.capMicros + n - 1 }).ok, false, JSON.stringify(base));
  }
});

const noop: ToolDefinition = {
  name: "noop", description: "Does nothing.", parameters: { type: "object", properties: {} }, effect: "read",
  handler: async () => ({ content: "ok" }),
};

test("(R15D-engine-03) five tool calls, the budget lowered to 2: the pending needs 4 and a limit of 6 completes the run", async (t) => {
  let ran = 0;
  const counted: ToolDefinition = { ...noop, handler: async () => { ran++; return { content: "ok" }; } };
  const models = fakeModels((request) => (request.meta.turn <= 6 ? toolReply("noop", {}) : reply({ text: "done" })));
  const h = await createHarness(t, { models, tools: [counted] });
  const agent = await h.saveAgent({ tools: [{ name: "noop" }] });
  const run = await h.start(agent.id, {}, { maxToolCalls: 5 });
  await h.until(run.id, "waiting");
  assert.equal(ran, 5);
  assert.deepEqual((await h.pendings(run.id))[0]?.detail, { limit: 5, used: 5, needed: 1 });

  await h.send(run.id, { type: "limits", limits: { maxToolCalls: 2 } });
  await h.until(run.id, "waiting");
  const [lowered] = await h.pendings(run.id);
  assert.equal(lowered?.kind, "tool_budget");
  assert.equal(lowered?.title, "Tool-call budget reached (5 of 2)");
  assert.deepEqual(lowered?.detail, { limit: 2, used: 5, needed: 4 });

  // One less than needed pauses again, with the remainder as the new need.
  await h.send(run.id, { type: "limits", limits: { maxToolCalls: 5 } });
  await h.until(run.id, "waiting");
  assert.deepEqual((await h.pendings(run.id))[0]?.detail, { limit: 5, used: 5, needed: 1 });

  await h.send(run.id, { type: "limits", limits: { maxToolCalls: 2 + 4 } });
  const done = await h.until(run.id, "completed");
  assert.equal(ran, 6);
  assert.equal(done.usage.toolCalls, 6);
});

test("(R15D-engine-03) three turns, the turn limit lowered to 1: the pending needs 3 and a limit of 4 completes the run", async (t) => {
  const models = fakeModels((request) => (request.meta.turn <= 3 ? toolReply("noop", {}) : reply({ text: "done" })));
  const h = await createHarness(t, { models, tools: [noop] });
  const agent = await h.saveAgent({ tools: [{ name: "noop" }] });
  const run = await h.start(agent.id, {}, { maxTurns: 3 });
  await h.until(run.id, "waiting");
  assert.deepEqual((await h.pendings(run.id))[0]?.detail, { limit: 3, used: 3, needed: 1 });

  await h.send(run.id, { type: "limits", limits: { maxTurns: 1 } });
  await h.until(run.id, "waiting");
  const [lowered] = await h.pendings(run.id);
  assert.equal(lowered?.kind, "turn_limit");
  assert.deepEqual(lowered?.detail, { limit: 1, used: 3, needed: 3 });

  await h.send(run.id, { type: "limits", limits: { maxTurns: 1 + 3 } });
  const done = await h.until(run.id, "completed");
  assert.equal(done.usage.turns, 4);
});
