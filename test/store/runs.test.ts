import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { openTestStore, testAgentDefinition } from "../helpers/store.ts";
import { createFakeClock } from "../../src/core/clock.ts";
import { isRunwrightError } from "../../src/core/errors.ts";
import { sha256Hex } from "../../src/core/json.ts";
import { idempotencyDigest, requestFingerprint } from "../../src/store/idempotency.ts";
import type { RunRecord } from "../../src/store/types.ts";

/** One column of the run row, read straight from the database file. */
function rawColumn(path: string, runId: string, column: "idempotency_key" | "request_hash"): unknown {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(`SELECT ${column} AS v FROM runs WHERE id = ?`).get(runId)?.["v"];
  } finally {
    db.close();
  }
}

const code = (c: string) => (e: unknown): boolean => isRunwrightError(e) && e.code === c;

test("createRun writes run.created at seq 1 with merged limits", async (t) => {
  const clock = createFakeClock(10_000);
  const { store } = await openTestStore(t, { clock });
  await store.saveAgent({ id: "a", definition: testAgentDefinition({ limits: { maxCostMicros: 500, maxTurns: 3 } }) });
  const { run, created } = await store.createRun({
    agentId: "a", input: { message: "hi", data: { n: 1 } }, limits: { maxTurns: 9, allowUnpriced: true },
    trigger: { id: "trg_1", kind: "manual" },
  });
  assert.equal(created, true);
  assert.match(run.id, /^run_/);
  assert.equal(run.status, "queued");
  assert.equal(run.revision, 1);
  assert.deepEqual(run.limits, { maxCostMicros: 500, maxToolCalls: null, maxTurns: 9, allowUnpriced: true });
  assert.deepEqual(run.trigger, { id: "trg_1", kind: "manual" });
  assert.equal(run.journalSeq, 1);
  assert.equal(run.epoch, 0);
  assert.equal(run.output, null);
  assert.equal(run.error, null);
  assert.deepEqual(run.usage, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0,
    costUnknown: false, toolCalls: 0, turns: 0 });
  assert.equal(run.createdAt, 10_000);
  const journal = await store.readJournal(run.id);
  assert.equal(journal.length, 1);
  assert.deepEqual(journal[0], {
    runId: run.id, seq: 1, epoch: 0, ts: 10_000, type: "run.created", key: null,
    data: { agentId: "a", revision: 1, input: { message: "hi", data: { n: 1 } }, limits: run.limits, trigger: { id: "trg_1", kind: "manual" } },
  });
  assert.deepEqual(await store.getRun(run.id), run);
  assert.equal(await store.getRun("run_missing"), null);
});

test("createRun pins a revision and rejects unknown agents and revisions", async (t) => {
  const { store } = await openTestStore(t);
  await store.saveAgent({ id: "a", definition: testAgentDefinition({ instructions: "1" }) });
  await store.saveAgent({ id: "a", definition: testAgentDefinition({ instructions: "2" }) });
  assert.equal((await store.createRun({ agentId: "a", input: { message: "", data: null } })).run.revision, 2);
  assert.equal((await store.createRun({ agentId: "a", revision: 1, input: { message: "", data: null } })).run.revision, 1);
  await assert.rejects(store.createRun({ agentId: "zz", input: { message: "", data: null } }), code("not_found"));
  await assert.rejects(store.createRun({ agentId: "a", revision: 7, input: { message: "", data: null } }), code("not_found"));
});

test("the same idempotency key returns the same run; a different request is a mismatch", async (t) => {
  const { store } = await openTestStore(t);
  await store.saveAgent({ id: "a", definition: testAgentDefinition() });
  const request = { agentId: "a", input: { message: "go", data: null }, idempotencyKey: "key-1" };
  const first = await store.createRun(request);
  const second = await store.createRun({ ...request, input: { data: null, message: "go" } });
  assert.equal(second.created, false);
  assert.equal(second.run.id, first.run.id);
  await assert.rejects(store.createRun({ ...request, input: { message: "other", data: null } }), code("idempotency_mismatch"));
  await assert.rejects(store.createRun({ ...request, limits: { maxTurns: 1 } }), code("idempotency_mismatch"));
  const lax = await store.createRun({ ...request, input: { message: "other", data: null }, strictIdempotency: false });
  assert.equal(lax.run.id, first.run.id);
  assert.equal(lax.created, false);
  const page = await store.listRuns({}, { limit: 50 });
  assert.equal(page.items.length, 1);
});

test("a key is stored and reported only as its sha256 digest, never as its text", async (t) => {
  const { store, path } = await openTestStore(t);
  await store.saveAgent({ id: "a", definition: testAgentDefinition() });
  const key = "customer-key-ünïcode-42";
  const request = { agentId: "a", input: { message: "go", data: { n: 1 } }, idempotencyKey: key };
  const first = await store.createRun(request);
  const digest = `sha256:${sha256Hex(key)}`;
  assert.equal(idempotencyDigest(key), digest);
  assert.match(digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.run.idempotencyKey, digest);
  assert.equal(rawColumn(path, first.run.id, "idempotency_key"), digest);
  const db = new DatabaseSync(path, { readOnly: true });
  t.after(() => db.close());
  for (const table of ["runs", "journal"]) {
    const rows = db.prepare(`SELECT * FROM ${table}`).all();
    assert.ok(!JSON.stringify(rows).includes(key), `${table} holds no copy of the key's text`);
  }

  const again = await store.createRun(request);
  assert.deepEqual([again.created, again.run.id], [false, first.run.id]);
  await assert.rejects(store.createRun({ ...request, input: { message: "other", data: null } }), (e: unknown) =>
    isRunwrightError(e) && e.code === "idempotency_mismatch" && e.details?.["idempotencyKey"] === digest);
  const lax = await store.createRun({ ...request, input: { message: "other", data: null }, strictIdempotency: false });
  assert.deepEqual([lax.created, lax.run.id], [false, first.run.id]);
  const otherKey = await store.createRun({ ...request, idempotencyKey: `${key} ` });
  assert.equal(otherKey.created, true, "a different key is a different request");
});

test("a given requestFingerprint is what is stored and compared; a malformed one is refused", async (t) => {
  const { store, path } = await openTestStore(t);
  await store.saveAgent({ id: "a", definition: testAgentDefinition() });
  const sent = { agentId: "a", input: { message: "the original text", data: null } };
  const fingerprint = requestFingerprint(sent);
  const first = await store.createRun({ agentId: "a", input: { message: "[redacted] text", data: null }, idempotencyKey: "fp", requestFingerprint: fingerprint });
  assert.equal(first.created, true);
  assert.equal(rawColumn(path, first.run.id, "request_hash"), fingerprint);
  assert.equal(first.run.input.message, "[redacted] text", "the input is stored as given");

  const same = await store.createRun({ agentId: "a", input: { message: "anything else", data: { x: 1 } }, idempotencyKey: "fp", requestFingerprint: fingerprint });
  assert.deepEqual([same.created, same.run.id], [false, first.run.id], "the fingerprint decides, not the input");
  const bare = await store.createRun({ ...sent, idempotencyKey: "fp" });
  assert.deepEqual([bare.created, bare.run.id], [false, first.run.id], "a bare store computes the same fingerprint");
  await assert.rejects(store.createRun({ ...sent, idempotencyKey: "fp", requestFingerprint: "0".repeat(64) }), code("idempotency_mismatch"));

  for (const bad of ["", "F".repeat(64), "0".repeat(63), "0".repeat(65), `sha256:${"0".repeat(64)}`, "g".repeat(64)]) {
    await assert.rejects(store.createRun({ ...sent, requestFingerprint: bad }), code("validation_failed"), JSON.stringify(bad));
    await assert.rejects(store.createRun({ ...sent, idempotencyKey: "fp", requestFingerprint: bad }), code("validation_failed"), JSON.stringify(bad));
  }
  assert.equal((await store.listRuns({}, { limit: 50 })).items.length, 1);
});

test("a run whose request_hash is NULL is returned for its key whatever the request", async (t) => {
  const { store, path } = await openTestStore(t);
  await store.saveAgent({ id: "a", definition: testAgentDefinition() });
  const first = await store.createRun({ agentId: "a", input: { message: "one", data: null }, idempotencyKey: "nul" });
  const db = new DatabaseSync(path);
  db.prepare("UPDATE runs SET request_hash = NULL WHERE id = ?").run(first.run.id);
  db.close();
  for (const request of [
    { agentId: "a", input: { message: "two", data: { y: 2 } }, idempotencyKey: "nul" },
    { agentId: "a", input: { message: "one", data: null }, idempotencyKey: "nul", limits: { maxTurns: 1 } },
    { agentId: "a", input: { message: "three", data: null }, idempotencyKey: "nul", requestFingerprint: "a".repeat(64) },
  ]) {
    const again = await store.createRun(request);
    assert.deepEqual([again.created, again.run.id], [false, first.run.id]);
  }
  assert.equal(rawColumn(path, first.run.id, "request_hash"), null, "the lookup does not rewrite the row");
});

test("(pins) requestFingerprint is the schema 1-3 formula: literal hashes computed on the round-3 store", async (t) => {
  const pinned = [
    {
      request: { agentId: "agent-a", revision: 1, input: { message: "héllo [x]", data: { b: [1, "x"], a: null } }, limits: { maxTurns: 3, allowUnpriced: true } },
      hash: "dda8ca8dd2e5729f646ed66589c4b38923c6587a7ab761559d44ee2160a4d2da",
    },
    { request: { agentId: "agent-a", input: { message: "", data: null } }, hash: "22ff13eb6087828cd25cb77cebdeae9aa7f6b62367cc3b1d848583bb81e45b72" },
  ];
  const { store, path } = await openTestStore(t);
  await store.saveAgent({ id: "agent-a", definition: testAgentDefinition() });
  for (const [index, { request, hash }] of pinned.entries()) {
    assert.equal(requestFingerprint(request), hash);
    const { run } = await store.createRun({ ...request, idempotencyKey: `pin-${index}` });
    assert.equal(rawColumn(path, run.id, "request_hash"), hash, "what the store writes is the same value");
  }
});

test("pagination walks every run exactly once, newest first", async (t) => {
  const clock = createFakeClock(1_000_000);
  const { store } = await openTestStore(t, { clock });
  await store.saveAgent({ id: "a", definition: testAgentDefinition() });
  const ids: string[] = [];
  for (let i = 0; i < 23; i++) {
    if (i % 3 === 0) clock.advance(1);
    ids.push((await store.createRun({ agentId: "a", input: { message: String(i), data: null } })).run.id);
  }
  const seen: RunRecord[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await store.listRuns({}, cursor === undefined ? { limit: 5 } : { limit: 5, cursor });
    seen.push(...page.items);
    cursor = page.nextCursor ?? undefined;
    pages++;
  } while (cursor !== undefined);
  assert.equal(pages, 5);
  assert.deepEqual(seen.map((r) => r.id), [...ids].reverse());
  const last = await store.listRuns({}, { limit: 23 });
  assert.equal(last.nextCursor, null);
  for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1e308]) {
    await assert.rejects(store.listRuns({}, { limit }), code("bad_request"), `limit ${limit}`);
  }
  assert.equal((await store.listRuns({}, { limit: 1 })).items.length, 1);
  assert.equal((await store.listRuns({}, { limit: 1000 })).items.length, 23, "limit is clamped to at most 200");
  await assert.rejects(store.listRuns({}, { limit: 5, cursor: "not a cursor!" }), code("bad_request"));
  await assert.rejects(store.listRuns({}, { limit: 5, cursor: Buffer.from("x").toString("base64url") }), code("bad_request"));
});

test("filters: agent, statuses, trigger, finishedBefore, journalArchived", async (t) => {
  const clock = createFakeClock(5000);
  const { store } = await openTestStore(t, { clock });
  await store.saveAgent({ id: "a", definition: testAgentDefinition() });
  await store.saveAgent({ id: "b", definition: testAgentDefinition() });
  const r1 = (await store.createRun({ agentId: "a", input: { message: "", data: null }, trigger: { id: "cron1", kind: "cron" } })).run;
  const r2 = (await store.createRun({ agentId: "b", input: { message: "", data: null } })).run;
  const [claim] = await store.claimRuns({ runnerId: "r", limit: 1, leaseMs: 1000 });
  assert.equal(claim?.run.id, r1.id);
  await store.commit(claim!.lease, { records: [], transition: { to: "completed", output: "ok" } });
  clock.advance(100);
  const ids = async (filter: Parameters<typeof store.listRuns>[0]) => (await store.listRuns(filter, { limit: 50 })).items.map((r) => r.id);
  assert.deepEqual(await ids({ agentId: "b" }), [r2.id]);
  assert.deepEqual(await ids({ statuses: ["completed"] }), [r1.id]);
  assert.deepEqual((await ids({ statuses: ["completed", "queued"] })).sort(), [r1.id, r2.id].sort());
  assert.deepEqual(await ids({ triggerId: "cron1" }), [r1.id]);
  assert.deepEqual(await ids({ finishedBefore: clock.now() }), [r1.id]);
  assert.deepEqual(await ids({ finishedBefore: 5000 }), []);
  assert.deepEqual(await ids({ journalArchived: true }), []);
  await store.archiveJournal(r1.id, { path: "/x.jsonl.gz", records: 1, lastSeq: 1 });
  assert.deepEqual(await ids({ journalArchived: true }), [r1.id]);
  assert.deepEqual(await ids({ journalArchived: false }), [r2.id]);
  await assert.rejects(store.listRuns({ statuses: ["bogus" as "queued"] }, { limit: 5 }), code("bad_request"));
});

test("readJournal pages by seq", async (t) => {
  const { store } = await openTestStore(t);
  await store.saveAgent({ id: "a", definition: testAgentDefinition() });
  const { run } = await store.createRun({ agentId: "a", input: { message: "", data: null } });
  const [claim] = await store.claimRuns({ runnerId: "r", limit: 1, leaseMs: 1000 });
  await store.commit(claim!.lease, { records: Array.from({ length: 9 }, (_, i) => ({ type: "x", key: `k${i}`, data: { i } })) });
  assert.deepEqual((await store.readJournal(run.id)).map((r) => r.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual((await store.readJournal(run.id, { afterSeq: 4, limit: 3 })).map((r) => r.seq), [5, 6, 7]);
  assert.deepEqual(await store.readJournal(run.id, { afterSeq: 10 }), []);
  assert.deepEqual(await store.readJournal("run_none"), []);
  for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1e308]) {
    await assert.rejects(store.readJournal(run.id, { limit }), code("bad_request"), `limit ${limit}`);
  }
  for (const afterSeq of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(store.readJournal(run.id, { afterSeq }), code("bad_request"), `afterSeq ${afterSeq}`);
  }
  assert.equal((await store.readJournal(run.id, { limit: 5000 })).length, 10, "a large page size is not clamped");
});

test("findIdempotentRun: null for an unused key; the run for a known one; the same mismatch rule as createRun", async (t) => {
  const { store, path } = await openTestStore(t);
  await store.saveAgent({ id: "a", definition: testAgentDefinition() });
  const sent = { agentId: "a", input: { message: "go", data: { n: 1 } } };
  const fingerprint = requestFingerprint(sent);
  assert.equal(await store.findIdempotentRun({ idempotencyKey: "k" }), null);
  assert.equal(await store.findIdempotentRun({ idempotencyKey: "k", requestFingerprint: fingerprint }), null);
  const { run } = await store.createRun({ ...sent, idempotencyKey: "k" });
  const again = await store.createRun({ ...sent, idempotencyKey: "k" });
  assert.deepEqual(await store.findIdempotentRun({ idempotencyKey: "k", requestFingerprint: fingerprint }), run);
  assert.deepEqual(await store.findIdempotentRun({ idempotencyKey: "k" }), again.run, "the same RunRecord createRun returns");
  assert.equal(await store.findIdempotentRun({ idempotencyKey: "k " }), null, "the key is exact");

  const other = requestFingerprint({ agentId: "a", input: { message: "other", data: null } });
  await assert.rejects(store.findIdempotentRun({ idempotencyKey: "k", requestFingerprint: other }), (e: unknown) =>
    isRunwrightError(e) && e.code === "idempotency_mismatch" && e.message === "the idempotency key was used for a different request"
    && e.details?.["runId"] === run.id && e.details?.["idempotencyKey"] === idempotencyDigest("k"));
  await assert.rejects(store.createRun({ ...sent, idempotencyKey: "k", requestFingerprint: other }), (e: unknown) =>
    isRunwrightError(e) && e.code === "idempotency_mismatch" && e.details?.["runId"] === run.id);
  assert.deepEqual(await store.findIdempotentRun({ idempotencyKey: "k", requestFingerprint: other, strictIdempotency: false }), run);
  assert.deepEqual(await store.findIdempotentRun({ idempotencyKey: "k", requestFingerprint: fingerprint, strictIdempotency: true }), run);

  for (const bad of ["", "F".repeat(64), "0".repeat(63), `sha256:${"0".repeat(64)}`]) {
    await assert.rejects(store.findIdempotentRun({ idempotencyKey: "k", requestFingerprint: bad }), code("validation_failed"), JSON.stringify(bad));
    await assert.rejects(store.findIdempotentRun({ idempotencyKey: "unused", requestFingerprint: bad }), code("validation_failed"));
  }

  const db = new DatabaseSync(path);
  db.prepare("UPDATE runs SET request_hash = NULL WHERE id = ?").run(run.id);
  db.close();
  for (const given of [other, fingerprint, "a".repeat(64)]) {
    assert.equal((await store.findIdempotentRun({ idempotencyKey: "k", requestFingerprint: given }))?.id, run.id);
  }
  assert.equal(rawColumn(path, run.id, "request_hash"), null, "the lookup writes nothing");
  assert.equal((await store.listRuns({}, { limit: 50 })).items.length, 1, "the lookup creates nothing");
});

test("findIdempotentRun reads only the run row: it never fails on the agent or its revision", async (t) => {
  const { store, path } = await openTestStore(t);
  await store.saveAgent({ id: "a", definition: testAgentDefinition({ instructions: "1" }) });
  const sent = { agentId: "a", input: { message: "go", data: null } };
  const { run } = await store.createRun({ ...sent, idempotencyKey: "k" });
  await store.saveAgent({ id: "a", definition: testAgentDefinition({ instructions: "2" }) });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = OFF");
  db.prepare("DELETE FROM agent_revisions WHERE agent_id = ?").run("a");
  db.prepare("DELETE FROM agents WHERE id = ?").run("a");
  db.close();
  await assert.rejects(store.createRun({ ...sent, idempotencyKey: "new" }), code("not_found"), "the agent is really gone");
  const found = await store.findIdempotentRun({ idempotencyKey: "k", requestFingerprint: requestFingerprint(sent) });
  assert.deepEqual(found, run);
  assert.equal(found?.revision, 1);
});
