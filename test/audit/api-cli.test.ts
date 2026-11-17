/**
 * Brief, section 4, "API/CLI: pagination", checked against a wrong implementation the existing test lets through
 * (finding class R09D-tests-01): a cursor on the creation time alone repeats or skips runs at a page edge when
 * several runs share a timestamp. The existing test sleeps between runs so every timestamp differs; here the
 * store's clock is frozen, so all runs share one creation time.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createFakeClock } from "../../src/core/clock.ts";
import type { RunwrightClient } from "../../src/client/index.ts";
import type { RunRecord } from "../../src/store/types.ts";
import { openTestStore } from "../helpers/store.ts";
import { startTestServer, testAgentDefinition, type TestServer } from "../server/support.ts";

async function frozenServer(t: TestContext): Promise<{ s: TestServer; created: string[] }> {
  const clock = createFakeClock(Date.UTC(2026, 5, 1, 12));
  const { store, dir } = await openTestStore(t, { clock });
  const s = await startTestServer(t, { store, dir });
  await s.client.saveAgent(testAgentDefinition({ name: "A" }));
  await s.client.saveAgent(testAgentDefinition({ name: "B" }));
  const created: string[] = [];
  for (let i = 0; i < 11; i++) {
    created.push((await s.client.startRun({ agentId: i % 3 === 0 ? "b" : "a", message: `m${i}` })).run.id);
  }
  return { s, created };
}

async function walk(client: RunwrightClient, limit: number, agentId?: string): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const page = await client.listRuns({ limit, ...(agentId === undefined ? {} : { agentId }), ...(cursor === undefined ? {} : { cursor }) });
    pages += 1;
    assert.ok(page.runs.length <= limit);
    ids.push(...page.runs.map((r: RunRecord) => r.id));
    if (page.nextCursor === null) return { ids, pages };
    assert.ok(pages < 100, "the cursor never ends");
    cursor = page.nextCursor;
  }
}

test("runs that share one creation time are each listed exactly once at every page size", async (t) => {
  const { s, created } = await frozenServer(t);
  const all = (await s.client.listRuns({ limit: 100 })).runs;
  assert.equal(new Set(all.map((r) => r.createdAt)).size, 1, "the runs share one creation time");
  const reference = all.map((r) => r.id);
  assert.deepEqual([...reference].sort(), [...created].sort());
  for (const limit of [1, 2, 3, 4, 10, 11]) {
    const { ids, pages } = await walk(s.client, limit);
    assert.deepEqual(ids, reference, `limit ${limit}: the pages, joined, are the single large page`);
    assert.equal(new Set(ids).size, created.length, `limit ${limit}: no run twice`);
    assert.ok(pages >= Math.ceil(created.length / limit), `limit ${limit}: ${pages} pages`);
  }
});

test("a filtered listing over runs that share one creation time repeats and skips nothing", async (t) => {
  const { s, created } = await frozenServer(t);
  const ofA = created.filter((_, i) => i % 3 !== 0);
  const reference = (await s.client.listRuns({ limit: 100, agentId: "a" })).runs.map((r) => r.id);
  assert.deepEqual([...reference].sort(), [...ofA].sort());
  for (const limit of [1, 2, 3]) {
    const { ids } = await walk(s.client, limit, "a");
    assert.deepEqual(ids, reference, `limit ${limit}`);
  }
});
