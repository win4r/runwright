import { test } from "node:test";
import assert from "node:assert/strict";
import type { NewUsage, UsageRow } from "../../src/store/types.ts";
import { authed, claim, errorOf, seedRun, startTestServer } from "./support.ts";

function usage(model: string, cost: number | null): NewUsage {
  return { model, purpose: "run", inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: cost, assumed: false };
}

test("usage is grouped by day, agent and model, with unpriced calls counted", async (t) => {
  const s = await startTestServer(t);
  const r1 = await seedRun(s.store, "alpha");
  const r2 = await seedRun(s.store, "beta");
  const before = Date.now();
  const { lease: l1 } = await claim(s.store, r1.id);
  await s.store.commit(l1, { records: [{ type: "model.finished", key: "t1", data: {} }], usage: [usage("scripted/m1", 300), usage("scripted/m1", 200)] });
  const { lease: l2 } = await claim(s.store, r2.id);
  await s.store.commit(l2, { records: [{ type: "model.finished", key: "t1", data: {} }], usage: [usage("scripted/unpriced", null)] });

  const byDay = await s.client.usage();
  assert.equal(byDay.groupBy, "day");
  assert.equal(byDay.rows.length, 1);
  assert.equal(byDay.rows[0]?.key, new Date().toISOString().slice(0, 10));
  assert.equal(byDay.rows[0]?.calls, 3);
  assert.equal(byDay.rows[0]?.costMicros, 500);
  assert.equal(byDay.rows[0]?.unknownCostCalls, 1);

  const byAgent = await s.client.usage({ groupBy: "agent" });
  assert.deepEqual(byAgent.rows.map((r: UsageRow) => [r.key, r.runs, r.calls]), [["alpha", 1, 2], ["beta", 1, 1]]);
  const byModel = await s.client.usage({ groupBy: "model", agentId: "alpha" });
  assert.deepEqual(byModel.rows.map((r) => r.key), ["scripted/m1"]);
  assert.deepEqual((await s.client.usage({ from: before + 60_000 })).rows, []);
  assert.equal((await s.client.usage({ from: before - 1000, to: Date.now() + 1000 })).rows[0]?.calls, 3);

  assert.equal((await errorOf(await authed(s, "/v1/usage?groupBy=week"))).code, "bad_request");
  assert.equal((await errorOf(await authed(s, "/v1/usage?from=yesterday"))).code, "bad_request");
});
