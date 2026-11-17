import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { openSqliteStore } from "../../src/store/sqlite.ts";
import type { LearningItem, PendingRecord, RunRecord, Store } from "../../src/store/types.ts";
import type { WorkflowDocument } from "../../src/workflow/types.ts";
import { idempotencyDigest, requestFingerprint } from "../../src/store/idempotency.ts";
import { seedLearningItems } from "../helpers/learning.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { columnValues, formsIn, scanDatabase } from "../security/at-rest.ts";
import { authed, claim, commitAs, errorOf, openPending, seedRun, startTestServer, testAgentDefinition, type TestServer } from "./support.ts";

test("the same idempotency key returns the same run with 200", async (t) => {
  const s = await startTestServer(t);
  await s.client.saveAgent(testAgentDefinition({ name: "A" }));
  const first = await authed(s, "/v1/runs", { method: "POST", json: { agentId: "a", message: "hi" }, headers: { "Idempotency-Key": "k-1" } });
  assert.equal(first.status, 201);
  const created = (await first.json()) as { run: RunRecord; created: boolean };
  assert.equal(created.created, true);
  assert.equal(created.run.idempotencyKey, idempotencyDigest("k-1"), "reported as the digest, never the key's text");
  assert.equal(created.run.status, "queued");

  const second = await authed(s, "/v1/runs", { method: "POST", json: { agentId: "a", message: "hi" }, headers: { "Idempotency-Key": "k-1" } });
  assert.equal(second.status, 200);
  const again = (await second.json()) as { run: RunRecord; created: boolean };
  assert.equal(again.created, false);
  assert.equal(again.run.id, created.run.id);

  const viaBody = await s.client.startRun({ agentId: "a", message: "hi", idempotencyKey: "k-1" });
  assert.equal(viaBody.run.id, created.run.id);
  assert.equal((await s.client.listRuns()).runs.length, 1);
});

test("(R15D-store-02) over HTTP a body key with an unpaired surrogate is 400 bad_request and starts no run", async (t) => {
  const s = await startTestServer(t);
  await s.client.saveAgent(testAgentDefinition({ name: "A" }));
  const body = JSON.stringify({ agentId: "a", message: "hi", idempotencyKey: "k-\ud800" });
  assert.ok(body.includes("\\ud800"), "the key travels as the JSON escape of a lone surrogate");
  const refused = await errorOf(await authed(s, "/v1/runs", { method: "POST", body, headers: { "Content-Type": "application/json" } }));
  assert.equal(refused.status, 400);
  assert.equal(refused.code, "bad_request");
  assert.match(refused.message, /well-formed Unicode/);
  assert.equal((await s.client.listRuns()).runs.length, 0);
  const astral = await s.client.startRun({ agentId: "a", message: "hi", idempotencyKey: "k-\ud83d\ude00" });
  assert.equal(astral.created, true, "a paired surrogate is one code point and is accepted");
});

test("the same key with a different request is 409; header and body keys must agree", async (t) => {
  const s = await startTestServer(t);
  await s.client.saveAgent(testAgentDefinition({ name: "A" }));
  await s.client.startRun({ agentId: "a", message: "one", idempotencyKey: "k" });
  const mismatch = await errorOf(await authed(s, "/v1/runs", { method: "POST", json: { agentId: "a", message: "two", idempotencyKey: "k" } }));
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.code, "idempotency_mismatch");
  const disagree = await errorOf(await authed(s, "/v1/runs", {
    method: "POST", json: { agentId: "a", idempotencyKey: "x" }, headers: { "Idempotency-Key": "y" },
  }));
  assert.equal(disagree.status, 400);
  assert.equal(disagree.code, "bad_request");
});

const LATER_SECRET = "route-secret-value-0042";

async function postRun(s: TestServer, json: Record<string, unknown>, key: string): Promise<{ status: number; body: { run: RunRecord; created: boolean } }> {
  const response = await authed(s, "/v1/runs", { method: "POST", json, headers: { "Idempotency-Key": key } });
  return { status: response.status, body: (await response.json()) as { run: RunRecord; created: boolean } };
}

test("a value in the message that becomes a secret afterwards: the identical request is still the same run (200)", async (t) => {
  const s = await startTestServer(t);
  await s.client.saveAgent(testAgentDefinition({ name: "A" }));
  const request = { agentId: "a", message: `deploy with ${LATER_SECRET}`, data: { token: LATER_SECRET }, limits: { maxTurns: 4 } };
  const first = await postRun(s, request, "k-message");
  assert.equal(first.status, 201);
  assert.equal(first.body.run.input.message, `deploy with ${LATER_SECRET}`);
  await s.client.setSecret("LATER_KEY", LATER_SECRET);
  const second = await postRun(s, request, "k-message");
  assert.equal(second.status, 200);
  assert.deepEqual([second.body.created, second.body.run.id], [false, first.body.run.id]);
  const different = await errorOf(await authed(s, "/v1/runs", {
    method: "POST", json: { ...request, message: "another request" }, headers: { "Idempotency-Key": "k-message" },
  }));
  assert.equal(different.status, 409);
  assert.equal(different.code, "idempotency_mismatch");
  assert.equal(different.details?.["idempotencyKey"], idempotencyDigest("k-message"));
  const fresh = await postRun(s, { ...request, message: `again ${LATER_SECRET}` }, "k-fresh");
  assert.equal(fresh.body.run.input.message, "again [redacted]", "new input is redacted once the value is a secret");
  assert.equal((await s.client.listRuns()).runs.length, 2);
});

test("a key that holds a value which becomes a secret afterwards is still the same run, and is never stored as text", async (t) => {
  const s = await startTestServer(t);
  await s.client.saveAgent(testAgentDefinition({ name: "A" }));
  const key = `delivery-${LATER_SECRET}`;
  const first = await postRun(s, { agentId: "a", message: "hi" }, key);
  assert.equal(first.status, 201);
  await s.client.setSecret("LATER_KEY", LATER_SECRET);
  const second = await postRun(s, { agentId: "a", message: "hi" }, key);
  assert.equal(second.status, 200);
  assert.deepEqual([second.body.created, second.body.run.id], [false, first.body.run.id]);
  const viaBody = await s.client.startRun({ agentId: "a", message: "hi", idempotencyKey: key });
  assert.equal(viaBody.run.id, first.body.run.id);
  assert.equal(viaBody.run.idempotencyKey, idempotencyDigest(key));
  assert.equal((await s.client.listRuns()).runs.length, 1);
  assert.deepEqual(scanDatabase(join(s.dir, "runwright.db"), key), []);
});

test("the route fingerprints the request as sent: a bare createRun of the unredacted request finds the same run", async (t) => {
  const s = await startTestServer(t);
  await s.client.saveAgent(testAgentDefinition({ name: "A" }));
  await s.client.setSecret("LATER_KEY", LATER_SECRET);
  const sent = { message: `use ${LATER_SECRET}`, data: { [LATER_SECRET]: [1, LATER_SECRET] } };
  const created = await postRun(s, { agentId: "a", ...sent, revision: 1, limits: { maxCostMicros: 9 } }, "k-fp");
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.run.input, { message: "use [redacted]", data: { "[redacted]": [1, "[redacted]"] } });
  const request = { agentId: "a", revision: 1, input: sent, limits: { maxCostMicros: 9 } };
  assert.deepEqual(columnValues(join(s.dir, "runwright.db"), "SELECT request_hash FROM runs WHERE id = ?", created.body.run.id),
    [requestFingerprint(request)]);
  const direct = await s.store.createRun({ ...request, idempotencyKey: "k-fp" });
  assert.deepEqual([direct.created, direct.run.id], [false, created.body.run.id]);

  const defaults = await postRun(s, { agentId: "a" }, "k-defaults");
  const bare = await s.store.createRun({ agentId: "a", input: { message: "", data: null }, idempotencyKey: "k-defaults" });
  assert.deepEqual([bare.created, bare.run.id], [false, defaults.body.run.id], "defaults are part of what was sent");
});

test("a workflow agent's data is validated after redaction and stored redacted", async (t) => {
  const s = await startTestServer(t);
  const workflow = {
    format: "runwright.workflow/v1", name: "w",
    schemas: { in: { type: "object", required: ["path"], additionalProperties: false, properties: { path: { type: "string", maxLength: 20 } } }, out: { type: "string" } },
    input: "in", output: "out",
    root: { id: "read", kind: "tool", tool: "read_file", args: { path: { $ref: "input.path" } } },
    result: { $ref: "steps.read.content" },
  } as unknown as WorkflowDocument;
  await s.client.saveAgent(testAgentDefinition({ name: "Wf", workflow }));
  const long = "a-very-long-secret-value-over-twenty";
  await s.client.setSecret("LONG_KEY", long);
  const { run } = await s.client.startRun({ agentId: "wf", data: { path: long }, idempotencyKey: "wf-1" });
  assert.deepEqual(run.input.data, { path: "[redacted]" }, "the redacted value is what was validated (the raw one is too long)");
  const again = await s.client.startRun({ agentId: "wf", data: { path: long }, idempotencyKey: "wf-1" });
  assert.equal(again.run.id, run.id);
  const keyed = await errorOf(await authed(s, "/v1/runs", { method: "POST", json: { agentId: "wf", data: { [long]: "x" } } }));
  assert.equal(keyed.code, "validation_failed");
  assert.ok(!JSON.stringify(keyed).includes(long), "the error names the redacted key");
});

test("a run defaults message and data, takes limits, and needs an existing agent", async (t) => {
  const s = await startTestServer(t);
  await s.client.saveAgent(testAgentDefinition({ name: "A", limits: { maxTurns: 9 } }));
  const { run } = await s.client.startRun({ agentId: "a", limits: { maxCostMicros: 5000 } });
  assert.deepEqual(run.input, { message: "", data: null });
  assert.equal(run.limits.maxCostMicros, 5000);
  assert.equal(run.limits.maxTurns, 9);
  const missing = await errorOf(await authed(s, "/v1/runs", { method: "POST", json: { agentId: "ghost" } }));
  assert.equal(missing.status, 404);
  const badRevision = await errorOf(await authed(s, "/v1/runs", { method: "POST", json: { agentId: "a", revision: 4 } }));
  assert.equal(badRevision.status, 404);
  const negative = await errorOf(await authed(s, "/v1/runs", { method: "POST", json: { agentId: "a", limits: { maxCostMicros: 1.5 } } }));
  assert.equal(negative.code, "validation_failed");
});

test("a workflow agent's run data is checked against the workflow input schema", async (t) => {
  const s = await startTestServer(t);
  const workflow = {
    format: "runwright.workflow/v1", name: "w",
    schemas: { in: { type: "object", required: ["path"], additionalProperties: false, properties: { path: { type: "string" } } }, out: { type: "string" } },
    input: "in", output: "out",
    root: { id: "read", kind: "tool", tool: "read_file", args: { path: { $ref: "input.path" } } },
    result: { $ref: "steps.read.content" },
  } as unknown as WorkflowDocument;
  await s.client.saveAgent(testAgentDefinition({ name: "Wf", workflow }));
  const bad = await errorOf(await authed(s, "/v1/runs", { method: "POST", json: { agentId: "wf", data: { nope: 1 } } }));
  assert.equal(bad.code, "validation_failed");
  const paths = (bad.details?.["problems"] as { path: string }[]).map((p) => p.path);
  assert.ok(paths.every((p) => p.startsWith("$.data")), paths.join(","));
  const good = await s.client.startRun({ agentId: "wf", data: { path: "a.txt" } });
  assert.deepEqual(good.run.input.data, { path: "a.txt" });
});

test("walking pages with limit=3 over 10 runs yields each run once, newest first", async (t) => {
  const s = await startTestServer(t);
  await s.client.saveAgent(testAgentDefinition({ name: "A" }));
  const ids: string[] = [];
  for (let i = 0; i < 10; i++) {
    ids.push((await s.client.startRun({ agentId: "a", message: `m${i}` })).run.id);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const page = await s.client.listRuns({ limit: 3, ...(cursor === undefined ? {} : { cursor }) });
    pages += 1;
    assert.ok(page.runs.length <= 3);
    seen.push(...page.runs.map((r) => r.id));
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  assert.equal(pages, 4);
  assert.deepEqual(seen, [...ids].reverse());
  const badLimit = await errorOf(await authed(s, "/v1/runs?limit=0"));
  assert.equal(badLimit.code, "bad_request");
  const badCursor = await errorOf(await authed(s, "/v1/runs?cursor=%%%"));
  assert.equal(badCursor.code, "bad_request");
});

test("runs filter by agent and by a comma list of statuses", async (t) => {
  const s = await startTestServer(t);
  await s.client.saveAgent(testAgentDefinition({ name: "A" }));
  await s.client.saveAgent(testAgentDefinition({ name: "B" }));
  const a1 = (await s.client.startRun({ agentId: "a" })).run;
  const a2 = (await s.client.startRun({ agentId: "a" })).run;
  const b1 = (await s.client.startRun({ agentId: "b" })).run;
  await commitAs(s.store, a1.id, { records: [{ type: "run.completed", data: {} }], transition: { to: "completed", output: "ok" } });
  await openPending(s.store, b1.id, "question", { question: "?", choices: [] });
  assert.deepEqual((await s.client.listRuns({ agentId: "b" })).runs.map((r) => r.id), [b1.id]);
  assert.deepEqual((await s.client.listRuns({ status: ["completed"] })).runs.map((r) => r.id), [a1.id]);
  assert.deepEqual(new Set((await s.client.listRuns({ status: ["queued", "waiting"] })).runs.map((r) => r.id)), new Set([a2.id, b1.id]));
  const bad = await errorOf(await authed(s, "/v1/runs?status=queued,sleeping"));
  assert.equal(bad.code, "bad_request");
});

test("GET /v1/runs/:id includes the open pendings", async (t) => {
  const s = await startTestServer(t);
  await s.client.saveAgent(testAgentDefinition({ name: "A" }));
  const { run } = await s.client.startRun({ agentId: "a" });
  const pending = await openPending(s.store, run.id, "question", { question: "Name?", choices: [] });
  const got = await s.client.getRun(run.id);
  assert.equal(got.run.status, "waiting");
  assert.deepEqual(got.pendings.map((p) => p.id), [pending.id]);
  assert.equal((await errorOf(await authed(s, "/v1/runs/run_nope"))).status, 404);
});

test("commands queue with 202, and on a finished run they are 409 run_terminal", async (t) => {
  const s = await startTestServer(t);
  await s.client.saveAgent(testAgentDefinition({ name: "A" }));
  const { run } = await s.client.startRun({ agentId: "a" });
  const message = await s.client.sendMessage(run.id, "hello");
  assert.deepEqual(message.command, { type: "message", text: "hello" });
  assert.deepEqual((await s.client.pauseRun(run.id)).command, { type: "pause" });
  assert.deepEqual((await s.client.resumeRun(run.id)).command, { type: "resume" });
  assert.deepEqual((await s.client.setLimits(run.id, { maxCostMicros: 10 })).command, { type: "limits", limits: { maxCostMicros: 10 } });
  assert.deepEqual((await s.client.cancelRun(run.id, "enough")).command, { type: "cancel", reason: "enough" });
  const raw = await authed(s, `/v1/runs/${run.id}/pause`, { method: "POST" });
  assert.equal(raw.status, 202);
  const queued = await s.store.listCommands(run.id);
  assert.deepEqual(queued.map((c) => c.command.type), ["message", "pause", "resume", "limits", "cancel", "pause"]);

  const noLimits = await errorOf(await authed(s, `/v1/runs/${run.id}/limits`, { method: "POST", json: {} }));
  assert.equal(noLimits.code, "validation_failed");
  const emptyText = await errorOf(await authed(s, `/v1/runs/${run.id}/messages`, { method: "POST", json: { text: "" } }));
  assert.equal(emptyText.code, "validation_failed");

  await commitAs(s.store, run.id, { records: [{ type: "run.cancelled", data: {} }], consumeCommands: queued.map((c) => c.id), transition: { to: "cancelled" } });
  for (const [path, json] of [["cancel", {}], ["pause", {}], ["resume", {}], ["messages", { text: "x" }], ["limits", { maxTurns: 3 }]] as const) {
    const error = await errorOf(await authed(s, `/v1/runs/${run.id}/${path}`, { method: "POST", json }));
    assert.equal(error.status, 409, path);
    assert.equal(error.code, "run_terminal", path);
  }
  const missing = await errorOf(await authed(s, "/v1/runs/run_nope/cancel", { method: "POST", json: {} }));
  assert.equal(missing.status, 404);
});

test("the timeline pages through the journal and reports archived journals", async (t) => {
  const s = await startTestServer(t);
  await s.client.saveAgent(testAgentDefinition({ name: "A" }));
  const { run } = await s.client.startRun({ agentId: "a" });
  await commitAs(s.store, run.id, {
    records: Array.from({ length: 6 }, (_, i) => ({ type: "step.finished", key: `s${i}`, data: { i } })),
  });
  const first = await s.client.timeline(run.id, { limit: 4 });
  assert.deepEqual(first.records.map((r) => r.seq), [1, 2, 3, 4]);
  assert.equal(first.nextAfter, 4);
  assert.equal(first.archived, false);
  const rest = await s.client.timeline(run.id, { after: 4, limit: 4 });
  assert.deepEqual(rest.records.map((r) => r.seq), [5, 6, 7]);
  assert.equal(rest.nextAfter, null);
  assert.equal((await errorOf(await authed(s, `/v1/runs/${run.id}/timeline?limit=2000`))).code, "bad_request");

  const done = await s.client.startRun({ agentId: "a", message: "second" });
  await commitAs(s.store, done.run.id, { records: [{ type: "run.completed", data: {} }], transition: { to: "completed", output: null } });
  const finished = (await s.store.readJournal(done.run.id)).length;
  await s.store.archiveJournal(done.run.id, { path: "archive/x.jsonl.gz", records: finished, lastSeq: finished });
  const archived = await s.client.timeline(done.run.id);
  assert.deepEqual(archived, { records: [], nextAfter: null, archived: true });
});

test("a run's learning uses are listed", async (t) => {
  const s = await startTestServer(t);
  await s.client.saveAgent(testAgentDefinition({ name: "A" }));
  const [item] = await seedLearningItems(s.store, "a", [
    { kind: "note", name: "fact", title: "Fact", description: "A fact", body: "Body", status: "active" },
  ]) as [LearningItem];
  const { run } = await s.client.startRun({ agentId: "a" });
  await commitAs(s.store, run.id, { records: [], learning: { given: [{ itemId: item.id, version: 1, mode: "full" }] } });
  const uses = await s.client.runLearning(run.id);
  assert.equal(uses.length, 1);
  assert.equal(uses[0]?.itemId, item.id);
  assert.equal(uses[0]?.opened, false);
});

const RUN_SECRET = "run-secret-value/with+plus?and=";

function assertNoSecret(text: string, value: string, label: string): void {
  assert.deepEqual(formsIn(text, value), [], `${label} holds no form of the secret`);
}

test("POST /v1/runs stores a named secret in message and data as the placeholder", async (t) => {
  const s = await startTestServer(t);
  await s.client.setSecret("TOOL_KEY", RUN_SECRET);
  await s.client.saveAgent(testAgentDefinition({ name: "A", secrets: ["TOOL_KEY"] }));
  const response = await authed(s, "/v1/runs", {
    method: "POST",
    json: { agentId: "a", message: `use ${RUN_SECRET}`, data: { token: RUN_SECRET, [RUN_SECRET]: [encodeURIComponent(RUN_SECRET)] } },
  });
  assert.equal(response.status, 201);
  const { run } = (await response.json()) as { run: RunRecord };
  assert.deepEqual(run.input, { message: "use [redacted]", data: { token: "[redacted]", "[redacted]": ["[redacted]"] } });
  assertNoSecret(JSON.stringify(await s.client.getRun(run.id)), RUN_SECRET, "GET /v1/runs/:id");
  const timeline = await s.client.timeline(run.id);
  assert.ok(JSON.stringify(timeline.records[0]?.data).includes("[redacted]"));
  assertNoSecret(JSON.stringify(timeline), RUN_SECRET, "the timeline");
  const path = join(s.dir, "runwright.db");
  for (const text of [
    ...columnValues(path, "SELECT input FROM runs"), ...columnValues(path, "SELECT data FROM journal"),
  ]) assertNoSecret(text, RUN_SECRET, "a raw row");
});

test("POST /v1/runs redacts, then validates: a redacted value that breaks the input schema is refused", async (t) => {
  const s = await startTestServer(t);
  const short = "pin-8chr";
  assert.equal(short.length, 8);
  await s.client.setSecret("PIN", short);
  const workflow = {
    format: "runwright.workflow/v1", name: "w",
    schemas: { in: { type: "object", required: ["path"], additionalProperties: false, properties: { path: { type: "string", maxLength: 9 } } }, out: { type: "string" } },
    input: "in", output: "out",
    root: { id: "read", kind: "tool", tool: "read_file", args: { path: { $ref: "input.path" } } },
    result: { $ref: "steps.read.content" },
  } as unknown as WorkflowDocument;
  await s.client.saveAgent(testAgentDefinition({ name: "Wf", workflow, secrets: ["PIN"] }));
  const refused = await authed(s, "/v1/runs", { method: "POST", json: { agentId: "wf", data: { path: short } } });
  const error = await errorOf(refused);
  assert.equal(error.code, "validation_failed");
  assert.equal(error.status, 400, "validation_failed maps to 400 (src/core/errors.ts)");
  assert.deepEqual((error.details?.["problems"] as { path: string }[]).map((p) => p.path), ["$.data.path"]);
  assertNoSecret(JSON.stringify(error), short, "the error");
  assert.deepEqual((await s.client.listRuns()).runs, [], "no run row exists");
  assert.deepEqual(columnValues(join(s.dir, "runwright.db"), "SELECT COUNT(*) FROM runs"), ["0"]);

  const accepted = await s.client.startRun({ agentId: "wf", data: { path: "plain-8ch" } });
  assert.deepEqual(accepted.run.input.data, { path: "plain-8ch" });
});

test("message and cancel commands are returned and stored with the placeholder", async (t) => {
  const s = await startTestServer(t);
  await s.client.setSecret("TOOL_KEY", RUN_SECRET);
  await s.client.saveAgent(testAgentDefinition({ name: "A", secrets: ["TOOL_KEY"] }));
  const { run } = await s.client.startRun({ agentId: "a" });
  const message = await s.client.sendMessage(run.id, `here: ${RUN_SECRET}`);
  assert.deepEqual(message.command, { type: "message", text: "here: [redacted]" });
  const cancel = await s.client.cancelRun(run.id, `because ${Buffer.from(RUN_SECRET).toString("base64")}`);
  assert.deepEqual(cancel.command, { type: "cancel", reason: "because [redacted]" });
  const payloads = columnValues(join(s.dir, "runwright.db"), "SELECT payload FROM commands WHERE run_id = ?", run.id);
  assert.equal(payloads.length, 2);
  for (const payload of payloads) {
    assert.ok(payload.includes("[redacted]"));
    assertNoSecret(payload, RUN_SECRET, "commands.payload");
  }
});

// ---------------------------------------------------------------- invariant I2: the key is looked up first

const ENUM_VALUE = "production-eu-west";

/** A workflow whose input `env` must be one of `values` (and, with `extra`, must also hold that property). */
function enumWorkflow(values: string[], extra?: string): WorkflowDocument {
  return {
    format: "runwright.workflow/v1", name: "w",
    schemas: {
      in: {
        type: "object", required: ["env", ...(extra === undefined ? [] : [extra])], additionalProperties: false,
        properties: { env: { type: "string", enum: values }, ...(extra === undefined ? {} : { [extra]: { type: "string" } }) },
      },
      out: { type: "string" },
    },
    input: "in", output: "out",
    root: { id: "read", kind: "tool", tool: "read_file", args: { path: { $ref: "input.env" } } },
    result: { $ref: "steps.read.content" },
  } as unknown as WorkflowDocument;
}

async function runCount(s: TestServer): Promise<number> {
  return (await s.client.listRuns()).runs.length;
}

test("I2 (the reviewer's probe): a data value that becomes a secret afterwards does not refuse the identical retry", async (t) => {
  const s = await startTestServer(t);
  await s.client.saveAgent(testAgentDefinition({ name: "Wf", workflow: enumWorkflow([ENUM_VALUE, "staging"]) }));
  const request = { agentId: "wf", message: "deploy", data: { env: ENUM_VALUE } };
  const first = await postRun(s, request, "k");
  assert.equal(first.status, 201);
  assert.deepEqual(first.body.run.input.data, { env: ENUM_VALUE });

  await s.client.setSecret("ENV_NAME", ENUM_VALUE);
  const second = await postRun(s, request, "k");
  assert.equal(second.status, 200);
  assert.deepEqual([second.body.created, second.body.run.id], [false, first.body.run.id]);
  const viaBody = await authed(s, "/v1/runs", { method: "POST", json: { ...request, idempotencyKey: "k" } });
  assert.equal(viaBody.status, 200);
  assert.equal(((await viaBody.json()) as { run: RunRecord }).run.id, first.body.run.id);

  const fresh = await errorOf(await authed(s, "/v1/runs", { method: "POST", json: request, headers: { "Idempotency-Key": "k-new" } }));
  assert.equal(fresh.status, 400, "the secret really bites: the redacted value is not in the enum");
  assert.equal(fresh.code, "validation_failed");
  assert.ok(!JSON.stringify(fresh).includes(ENUM_VALUE));
  assert.equal(await runCount(s), 1, "no run for the refused request");
});

test("I2: a new revision whose input schema refuses the data does not refuse the identical retry; the run stays on revision 1", async (t) => {
  const s = await startTestServer(t);
  await s.client.saveAgent(testAgentDefinition({ name: "Wf", workflow: enumWorkflow([ENUM_VALUE]) }));
  const request = { agentId: "wf", data: { env: ENUM_VALUE } };
  const first = await postRun(s, request, "k-rev");
  assert.equal(first.status, 201);
  assert.equal(first.body.run.revision, 1);

  const saved = await s.client.saveAgent(testAgentDefinition({ name: "Wf", workflow: enumWorkflow(["only-this"], "region") }));
  assert.equal(saved.revision.revision, 2);
  const second = await postRun(s, request, "k-rev");
  assert.equal(second.status, 200);
  assert.deepEqual([second.body.created, second.body.run.id, second.body.run.revision], [false, first.body.run.id, 1]);

  const fresh = await errorOf(await authed(s, "/v1/runs", { method: "POST", json: request, headers: { "Idempotency-Key": "k-rev-new" } }));
  assert.equal(fresh.status, 400);
  assert.equal(fresh.code, "validation_failed");
  assert.equal(await runCount(s), 1);
});

test("I2: after a secret is added and a revision saved, the same key with a different request is still 409 (header and body key alike)", async (t) => {
  const s = await startTestServer(t);
  await s.client.saveAgent(testAgentDefinition({ name: "Wf", workflow: enumWorkflow([ENUM_VALUE]) }));
  const request = { agentId: "wf", message: "one", data: { env: ENUM_VALUE } };
  const first = await postRun(s, request, "k-strict");
  assert.equal(first.status, 201);
  await s.client.setSecret("ENV_NAME", ENUM_VALUE);
  await s.client.saveAgent(testAgentDefinition({ name: "Wf", workflow: enumWorkflow(["only-this"]) }));
  for (const init of [
    { json: { ...request, message: "two" }, headers: { "Idempotency-Key": "k-strict" } },
    { json: { ...request, message: "two", idempotencyKey: "k-strict" } },
    { json: { ...request, revision: 1 }, headers: { "Idempotency-Key": "k-strict" } },
  ]) {
    const error = await errorOf(await authed(s, "/v1/runs", { method: "POST", ...init }));
    assert.equal(error.status, 409, JSON.stringify(init));
    assert.equal(error.code, "idempotency_mismatch");
    assert.equal(error.details?.["runId"], first.body.run.id);
    assert.equal(error.details?.["idempotencyKey"], idempotencyDigest("k-strict"));
  }
  assert.equal(await runCount(s), 1);
});

test("I2: without a key, or with a new key, a request is checked as before and nothing is created when it fails", async (t) => {
  const s = await startTestServer(t);
  await s.client.saveAgent(testAgentDefinition({ name: "Wf", workflow: enumWorkflow([ENUM_VALUE]) }));
  for (const key of [undefined, "never-used"]) {
    const headers: Record<string, string> = key === undefined ? {} : { "Idempotency-Key": key };
    const post = async (json: Record<string, unknown>) => errorOf(await authed(s, "/v1/runs", { method: "POST", json, headers }));
    const invalid = await post({ agentId: "wf", data: { env: "nope" } });
    assert.deepEqual([invalid.status, invalid.code], [400, "validation_failed"], `invalid data, key ${key}`);
    const ghost = await post({ agentId: "ghost", data: { env: ENUM_VALUE } });
    assert.deepEqual([ghost.status, ghost.code], [404, "not_found"], `unknown agent, key ${key}`);
    const revision = await post({ agentId: "wf", revision: 9, data: { env: ENUM_VALUE } });
    assert.deepEqual([revision.status, revision.code], [404, "not_found"], `unknown revision, key ${key}`);
  }
  assert.equal(await runCount(s), 0);
  const accepted = await postRun(s, { agentId: "wf", data: { env: ENUM_VALUE } }, "never-used");
  assert.equal(accepted.status, 201, "a refused request does not use up its key");
});

/** A real store whose methods can be intercepted per call; everything else is the store's own. */
async function interceptedStore(
  t: TestContext,
  dir: string,
  intercept: (inner: Store) => Partial<Pick<Store, "getRevision" | "findIdempotentRun">>,
): Promise<Store> {
  const inner = await openSqliteStore({ path: join(dir, "runwright.db") });
  t.after(() => inner.close());
  const overrides = intercept(inner);
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "getRevision" && overrides.getRevision !== undefined) return overrides.getRevision;
      if (prop === "findIdempotentRun" && overrides.findIdempotentRun !== undefined) return overrides.findIdempotentRun;
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Store;
}

test("I2: the run is pinned to the revision its data was validated against, even when the agent is saved in between", async (t) => {
  const dir = await makeTempDir(t, "runwright-pin-");
  let armed = false;
  let interfered = false;
  const store = await interceptedStore(t, dir, (inner) => ({
    async getRevision(agentId, revision) {
      const result = await inner.getRevision(agentId, revision);
      if (armed && !interfered && agentId === "wf" && revision === undefined) {
        interfered = true;
        await inner.saveAgent({ id: "wf", definition: testAgentDefinition({ name: "Wf", workflow: enumWorkflow(["only-this"]) }) });
      }
      return result;
    },
  }));
  const s = await startTestServer(t, { dir, store });
  await s.client.saveAgent(testAgentDefinition({ name: "Wf", workflow: enumWorkflow([ENUM_VALUE]) }));
  armed = true;
  const created = await postRun(s, { agentId: "wf", data: { env: ENUM_VALUE } }, "k-pin");
  assert.equal(interfered, true, "a revision was saved between validation and insert");
  assert.equal((await s.client.getAgent("wf")).agent.currentRevision, 2);
  assert.equal(created.status, 201);
  assert.equal(created.body.run.revision, 1, "the revision the data was validated against");
  assert.equal((await s.store.readJournal(created.body.run.id))[0]?.data["revision"], 1);
});

test("I2: the repeat of a keyed request reads no revision and reveals no secret", async (t) => {
  const dir = await makeTempDir(t, "runwright-reads-");
  let revisionReads = 0;
  const store = await interceptedStore(t, dir, (inner) => ({
    getRevision(agentId, revision) {
      revisionReads += 1;
      return inner.getRevision(agentId, revision);
    },
  }));
  const s = await startTestServer(t, { dir, store });
  await s.client.setSecret("TOOL_KEY", RUN_SECRET);
  await s.client.saveAgent(testAgentDefinition({ name: "Wf", workflow: enumWorkflow([ENUM_VALUE]), secrets: ["TOOL_KEY"] }));
  let reveals = 0;
  const reveal = s.secrets.reveal.bind(s.secrets);
  s.secrets.reveal = (names) => {
    reveals += 1;
    return reveal(names);
  };
  const request = { agentId: "wf", message: `with ${RUN_SECRET}`, data: { env: ENUM_VALUE } };
  const first = await postRun(s, request, "k-reads");
  assert.equal(first.status, 201);
  assert.ok(revisionReads > 0 && reveals > 0, "a new request does read the revision and reveal the named secrets");
  revisionReads = 0;
  reveals = 0;
  const again = await postRun(s, request, "k-reads");
  assert.deepEqual([again.status, again.body.run.id], [200, first.body.run.id]);
  assert.deepEqual({ revisionReads, reveals }, { revisionReads: 0, reveals: 0 });
});

test("I2: a request refused by a check is answered with the run an identical request started meanwhile", async (t) => {
  const dir = await makeTempDir(t, "runwright-race-");
  let lookups = 0;
  let raced: RunRecord | null = null;
  const store = await interceptedStore(t, dir, (inner) => ({
    async findIdempotentRun(query) {
      lookups += 1;
      const found = await inner.findIdempotentRun(query);
      // The first lookup finds nothing; an identical request then starts the run, and the agent changes so that
      // this request's own checks refuse it.
      if (lookups === 1 && found === null) {
        raced = (await inner.createRun({
          agentId: "wf", input: { message: "", data: { env: ENUM_VALUE } }, idempotencyKey: query.idempotencyKey,
          ...(query.requestFingerprint === undefined ? {} : { requestFingerprint: query.requestFingerprint }),
        })).run;
        await inner.saveAgent({ id: "wf", definition: testAgentDefinition({ name: "Wf", workflow: enumWorkflow(["only-this"]) }) });
      }
      return found;
    },
  }));
  const s = await startTestServer(t, { dir, store });
  await s.client.saveAgent(testAgentDefinition({ name: "Wf", workflow: enumWorkflow([ENUM_VALUE]) }));
  const answer = await postRun(s, { agentId: "wf", data: { env: ENUM_VALUE } }, "k-race");
  assert.ok(raced !== null);
  assert.equal(answer.status, 200, "not the 400 of the checks");
  assert.deepEqual([answer.body.created, answer.body.run.id], [false, (raced as RunRecord).id]);
  assert.equal(lookups, 2);
  assert.equal(await runCount(s), 1);
});

/** The problem paths of a 400 validation_failed answer. */
async function rejectedPaths(response: Response): Promise<string[]> {
  const error = await errorOf(response);
  assert.equal(error.status, 400, JSON.stringify(error));
  assert.equal(error.code, "validation_failed", JSON.stringify(error));
  return ((error.details?.["problems"] ?? []) as { path: string }[]).map((p) => p.path);
}

test("integer fields of run requests have a maximum: 1e308 and one above it are 400 with the path", async (t) => {
  const s = await startTestServer(t);
  await s.client.saveAgent(testAgentDefinition({ name: "A" }));
  const { run } = await s.client.startRun({ agentId: "a", message: "hi" });
  for (const value of [1e308, Number.MAX_SAFE_INTEGER + 1]) {
    for (const field of ["maxCostMicros", "maxToolCalls", "maxTurns"]) {
      const create = await authed(s, "/v1/runs", { method: "POST", json: { agentId: "a", limits: { [field]: value } } });
      assert.ok((await rejectedPaths(create)).includes(`$.limits.${field}`), `${field} ${value}`);
      const change = await authed(s, `/v1/runs/${run.id}/limits`, { method: "POST", json: { [field]: value } });
      assert.ok((await rejectedPaths(change)).includes(`$.${field}`), `${field} ${value}`);
    }
    const revision = await authed(s, "/v1/runs", { method: "POST", json: { agentId: "a", revision: value } });
    assert.ok((await rejectedPaths(revision)).includes("$.revision"), `revision ${value}`);
  }
  const atBound = await authed(s, `/v1/runs/${run.id}/limits`, { method: "POST", json: { maxCostMicros: Number.MAX_SAFE_INTEGER } });
  assert.equal(atBound.status, 202);
  await atBound.body?.cancel();
  assert.equal((await s.client.listRuns()).runs.length, 1, "no rejected request started a run");
});

test("an events position above the largest safe integer is 400, not an empty stream", async (t) => {
  const s = await startTestServer(t);
  await s.client.saveAgent(testAgentDefinition({ name: "A" }));
  const { run } = await s.client.startRun({ agentId: "a", message: "hi" });
  const response = await errorOf(await authed(s, `/v1/runs/${run.id}/events?after=9999999999999999`));
  assert.equal(response.status, 400);
  assert.equal(response.code, "bad_request");
});

// ------------------------------------------------------------------ a run's detail lists all of its open pendings
// (finding R13D-docs-03: one page of 200 was presented as the complete set)

/** Opens `total` pendings on one run, in commits of `batch` (questions, then approvals), and resolves `resolved` of them. */
async function manyPendings(store: Store, runId: string, total: number, resolved: number): Promise<void> {
  const { lease } = await claim(store, runId);
  const batch = 150;
  for (let start = 0; start < total; start += batch) {
    const openPendings = [];
    for (let i = start; i < Math.min(total, start + batch); i++) {
      openPendings.push({ id: `pnd_many_${String(i).padStart(4, "0")}`, kind: i < total - 2 ? "question" as const : "approval" as const, stepKey: `t1.c${i}`, title: `P ${i}`, detail: {} });
    }
    await store.commit(lease, { records: [{ type: "step.finished", key: `open${start}`, data: {} }], openPendings });
  }
  const resolvePendings = Array.from({ length: resolved }, (_, i) => ({ id: `pnd_many_${String(i * 7).padStart(4, "0")}`, resolution: { answer: "done" } }));
  await store.commit(lease, { records: [{ type: "step.finished", key: "resolve", data: {} }], resolvePendings, transition: { to: "waiting" } });
}

/** Every open pending of the run in the store's own order, read page by page straight from the store. */
async function storeOrder(store: Store, runId: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await store.listPendings({ runId, status: "open" }, { limit: 37, ...(cursor === undefined ? {} : { cursor }) });
    ids.push(...page.items.map((p) => p.id));
    if (page.nextCursor === null) return ids;
    cursor = page.nextCursor;
  }
}

test("GET /v1/runs/:id returns every open pending of the run, oldest first, and no resolved one", async (t) => {
  const s = await startTestServer(t);
  const run = await seedRun(s.store);
  await manyPendings(s.store, run.id, 460, 10);
  const other = await seedRun(s.store, "other-agent");
  await openPending(s.store, other.id, "question");
  const response = await authed(s, `/v1/runs/${run.id}`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { run: RunRecord; pendings: PendingRecord[] };
  assert.equal(body.pendings.length, 450);
  assert.deepEqual(body.pendings.map((p) => p.id), await storeOrder(s.store, run.id));
  assert.ok(body.pendings.every((p) => p.status === "open" && p.runId === run.id));
  assert.equal(body.pendings.filter((p) => p.kind === "approval").length, 2, "both approvals past the first 200 are there");
  const viaClient = await s.client.getRun(run.id);
  assert.equal(viaClient.pendings.length, 450);
  assert.deepEqual(viaClient.pendings.map((p) => p.id), body.pendings.map((p) => p.id));
});
