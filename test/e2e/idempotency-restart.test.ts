/**
 * Finding R03-02 through `createApp` and a real restart on the same data directory (invariant I1): whether two
 * create-run requests are the same request depends only on the two requests, never on which secrets exist.
 * A key is stored only as its digest, and the request's fingerprint is taken before redaction. Covers the API,
 * a webhook redelivery, and a database file written by the round-3 code path (schema version 3).
 *
 * Finding R04-01 (invariant I2): the key is looked up before anything that can change is read, so an identical
 * keyed request is answered with its run after its data became a secret, a new revision refused that data and
 * the app restarted.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { sha256Hex } from "../../src/core/json.ts";
import { idempotencyDigest, requestFingerprint } from "../../src/store/idempotency.ts";
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from "../../src/store/migrations.ts";
import type { RunRecord } from "../../src/store/types.ts";
import { signWebhook } from "../../src/triggers/webhook.ts";
import { startTestApp, type TestApp } from "../fixtures/app.ts";
import { scriptedAgent, waitForStatus } from "../fixtures/runs.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { columnValues, scanDatabase } from "../security/at-rest.ts";

const SECRET_NAME = "ORDER_SECRET";
const HOOK_SECRET = "webhook-signing-secret-idem-1";

/** A header-safe value long enough to be a secret. */
const makeValue = (): string => `ordv${randomBytes(10).toString("hex")}`;

interface Posted { status: number; body: { run?: RunRecord; created?: boolean; error?: { code: string } } }

async function postRun(app: TestApp, key: string, body: Record<string, unknown>): Promise<Posted> {
  const response = await fetch(`${app.app.url}/v1/runs`, {
    method: "POST",
    headers: { Authorization: `Bearer ${app.app.token}`, "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Posted["body"] };
}

async function restart(t: TestContext, app: TestApp): Promise<TestApp> {
  await app.app.stop({ graceMs: 200 });
  return startTestApp(t, { dir: app.dir });
}

async function runsOf(app: TestApp, agentId: string): Promise<RunRecord[]> {
  return (await app.client.listRuns({ agentId, limit: 200 })).runs;
}

const database = (app: TestApp): string => join(app.app.config.dataDir, "runwright.db");

test("a request whose key and message hold a secret is the same request after the secret is deleted and the app restarted", { timeout: 60_000 }, async (t) => {
  const value = makeValue();
  let app = await startTestApp(t);
  await app.client.setSecret(SECRET_NAME, value);
  const { agent } = await app.client.saveAgent(scriptedAgent({ name: "Orders", secrets: [SECRET_NAME], script: { turns: [{ text: "shipped" }] } }), "orders");
  const key = `order-${value}`;
  const request = { agentId: agent.id, message: `ship order ${value} today` };

  const first = await postRun(app, key, request);
  assert.equal(first.status, 201);
  const runId = first.body.run?.id as string;
  assert.equal(first.body.run?.idempotencyKey, idempotencyDigest(key));
  await waitForStatus(app.client, runId, "completed");
  const mismatch = await postRun(app, key, { ...request, message: "ship a different order" });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.error?.code, "idempotency_mismatch");

  await app.client.deleteSecret(SECRET_NAME);
  app = await restart(t, app);
  const again = await postRun(app, key, request);
  assert.equal(again.status, 200);
  assert.equal(again.body.created, false);
  assert.equal(again.body.run?.id, runId);
  assert.deepEqual((await runsOf(app, agent.id)).map((r) => r.id), [runId], "exactly one run exists");
  const after = await postRun(app, key, { ...request, message: "ship a different order" });
  assert.equal(after.status, 409, "a really different request is still refused after the restart");
  assert.equal(after.body.error?.code, "idempotency_mismatch");

  assert.deepEqual(scanDatabase(database(app), value, ["secrets"]), [], "the key column holds a digest, the input the placeholder");
  assert.deepEqual(columnValues(database(app), "SELECT idempotency_key FROM runs WHERE id = ?", runId), [idempotencyDigest(key)]);
});

test("a request sent before a secret matched it is the same request after the secret is set and the app restarted", { timeout: 60_000 }, async (t) => {
  const value = makeValue();
  let app = await startTestApp(t);
  const { agent } = await app.client.saveAgent(scriptedAgent({ name: "Orders", script: { turns: [{ text: "shipped" }] } }), "orders");
  const key = `order-${value}`;
  const request = { agentId: agent.id, message: `ship order ${value} today` };

  const first = await postRun(app, key, request);
  assert.equal(first.status, 201);
  const runId = first.body.run?.id as string;
  await waitForStatus(app.client, runId, "completed");

  await app.client.setSecret("LATER_SECRET", value);
  const sameProcess = await postRun(app, key, request);
  assert.deepEqual([sameProcess.status, sameProcess.body.run?.id], [200, runId], "same run while the new secret is known");
  app = await restart(t, app);
  const again = await postRun(app, key, request);
  assert.equal(again.status, 200, "not 409: the fingerprint is of the request as sent");
  assert.equal(again.body.created, false);
  assert.equal(again.body.run?.id, runId);
  assert.equal((await runsOf(app, agent.id)).length, 1);
  const different = await postRun(app, key, { ...request, message: "something else" });
  assert.equal(different.status, 409);
});

async function deliver(app: TestApp, triggerId: string, delivery: string, payload: object): Promise<{ status: number; runId: string; duplicate: boolean }> {
  const body = Buffer.from(JSON.stringify({ delivery, ...payload }));
  const timestamp = Math.floor(Date.now() / 1000);
  const response = await fetch(`${app.app.url}/v1/hooks/${triggerId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json", "X-Runwright-Timestamp": String(timestamp),
      "X-Runwright-Signature": signWebhook(HOOK_SECRET, timestamp, body),
    },
    body,
  });
  const parsed = (await response.json()) as { runId: string; duplicate: boolean };
  return { status: response.status, ...parsed };
}

test("a webhook redelivery whose delivery id holds a secret reports the same run across a secret change and a restart", { timeout: 60_000 }, async (t) => {
  const value = makeValue();
  let app = await startTestApp(t);
  await app.client.setSecret(SECRET_NAME, value);
  await app.client.setSecret("HOOK_SECRET", HOOK_SECRET);
  const { agent } = await app.client.saveAgent(scriptedAgent({ name: "Hooked", script: { turns: [{ text: "deployed" }] } }), "hooked");
  const trigger = await app.client.createTrigger({
    name: "deploys", kind: "webhook", agentId: agent.id, webhook: { secretName: "HOOK_SECRET" }, message: "deploy", limits: { maxCostMicros: 50_000 },
  });
  const delivery = `d-${value}`;
  const first = await deliver(app, trigger.id, delivery, { ref: "main" });
  assert.deepEqual([first.status, first.duplicate], [202, false]);
  await waitForStatus(app.client, first.runId, "completed");

  await app.client.deleteSecret(SECRET_NAME);
  app = await restart(t, app);
  const again = await deliver(app, trigger.id, delivery, { ref: "main" });
  assert.deepEqual([again.status, again.runId, again.duplicate], [202, first.runId, true]);
  const runs = (await app.client.listRuns({ triggerId: trigger.id })).runs;
  assert.deepEqual(runs.map((r) => r.id), [first.runId], "no second run");
  assert.deepEqual(columnValues(database(app), "SELECT idempotency_key FROM runs WHERE id = ?", first.runId),
    [idempotencyDigest(`webhook:${trigger.id}:${delivery}`)]);
});

const LIMITS = '{"maxCostMicros":null,"maxToolCalls":null,"maxTurns":null,"allowUnpriced":false}';

test("a database written by the round-3 code path is upgraded to the current schema and each original key still returns its run", { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t, "runwright-v3-");
  await mkdir(join(dir, "data"), { recursive: true });
  const db = new DatabaseSync(join(dir, "data", "runwright.db"));
  for (const migration of MIGRATIONS.filter((m) => m.version <= 3)) for (const statement of migration.statements) db.exec(statement);
  db.prepare("INSERT INTO agents (id, name, current_revision, created_at, updated_at) VALUES ('old', 'Old', 1, 1, 1)").run();
  db.prepare(`INSERT INTO agent_revisions (agent_id, revision, definition, definition_hash, created_at)
    VALUES ('old', 1, '{"name":"Old","instructions":"","model":{"provider":"scripted","name":"scripted-1"},"tools":[],"limits":{},"learning":false}', 'h', 1)`).run();
  const insert = db.prepare(`INSERT INTO runs (id, agent_id, revision, status, input, limits, idempotency_key, request_hash,
    available_at, journal_seq, created_at, updated_at) VALUES (?, 'old', 1, 'completed', ?, ?, ?, ?, 1, 0, ?, ?)`);
  const literalInput = { message: "plain order", data: null };
  insert.run("run_literal", JSON.stringify(literalInput), LIMITS, "k-literal", requestFingerprint({ agentId: "old", input: literalInput }), 10, 10);
  const secretKey = `k-${makeValue()}`;
  const redactedInput = { message: "order [redacted]", data: null };
  insert.run("run_digest", JSON.stringify(redactedInput), LIMITS, `redacted-sha256:${sha256Hex(secretKey)}`,
    requestFingerprint({ agentId: "old", input: redactedInput }), 20, 20);
  db.close();

  const app = await startTestApp(t, { dir });
  const ready = await app.client.ready();
  assert.equal(ready["schemaVersion"], LATEST_SCHEMA_VERSION);

  const literal = await postRun(app, "k-literal", { agentId: "old", message: "plain order" });
  assert.deepEqual([literal.status, literal.body.run?.id, literal.body.created], [200, "run_literal", false]);
  assert.equal(literal.body.run?.idempotencyKey, idempotencyDigest("k-literal"));
  const changed = await postRun(app, "k-literal", { agentId: "old", message: "another order" });
  assert.equal(changed.status, 409, "a kept request hash is still compared");

  const digest = await postRun(app, secretKey, { agentId: "old", message: `order ${secretKey.slice(2)}` });
  assert.deepEqual([digest.status, digest.body.run?.id, digest.body.created], [200, "run_digest", false],
    "a run whose stored input was redacted has no request hash: its key returns it without comparing");
  assert.equal(digest.body.run?.idempotencyKey, idempotencyDigest(secretKey));
  assert.equal((await runsOf(app, "old")).length, 2);
});

const ENV_VALUE = "production-eu-west";

/** A workflow agent whose input `env` must be one of `values` (with `extra`, that property is required too). */
function enumAgent(values: string[], extra?: string) {
  return {
    ...scriptedAgent({ name: "Deployer", script: { turns: [] } }),
    workflow: {
      format: "runwright.workflow/v1", name: "deploy",
      schemas: {
        in: {
          type: "object", required: ["env", ...(extra === undefined ? [] : [extra])], additionalProperties: false,
          properties: { env: { type: "string", enum: values }, ...(extra === undefined ? {} : { [extra]: { type: "string" } }) },
        },
        out: { type: "boolean" },
      },
      input: "in", output: "out",
      root: { id: "note", kind: "tool", tool: "write_file", args: { path: "env.txt", content: { $ref: "input.env" } } },
      result: { $ref: "steps.note.ok" },
    },
  } as unknown as Parameters<TestApp["client"]["saveAgent"]>[0];
}

test("R04-01: an identical keyed request is answered with its run after its data became a secret, a revision refused the data and the app restarted", { timeout: 60_000 }, async (t) => {
  let app = await startTestApp(t);
  const { agent } = await app.client.saveAgent(enumAgent([ENV_VALUE, "staging"]), "deployer");
  const key = "deploy-2026-11-13";
  const request = { agentId: agent.id, message: "deploy", data: { env: ENV_VALUE } };

  const first = await postRun(app, key, request);
  assert.equal(first.status, 201);
  assert.equal(first.body.created, true);
  const runId = first.body.run?.id as string;
  assert.equal(first.body.run?.revision, 1);
  await waitForStatus(app.client, runId, ["completed", "failed"]);

  await app.client.setSecret("ENV_NAME", ENV_VALUE);
  const saved = await app.client.saveAgent(enumAgent(["only-this"], "region"), "deployer");
  assert.equal(saved.revision.revision, 2, "the current revision now refuses the data");
  app = await restart(t, app);

  const again = await postRun(app, key, request);
  assert.equal(again.status, 200);
  assert.equal(again.body.created, false);
  assert.equal(again.body.run?.id, runId);
  assert.equal(again.body.run?.revision, 1, "still pinned to the revision it started with");
  assert.deepEqual((await runsOf(app, agent.id)).map((r) => r.id), [runId], "exactly one run exists");

  const fresh = await postRun(app, "deploy-new-key", request);
  assert.equal(fresh.status, 400, "a new request is validated against the current revision");
  assert.equal(fresh.body.error?.code, "validation_failed");
  const different = await postRun(app, key, { ...request, message: "deploy twice" });
  assert.equal(different.status, 409);
  assert.equal(different.body.error?.code, "idempotency_mismatch");
  assert.deepEqual((await runsOf(app, agent.id)).map((r) => r.id), [runId], "neither refused request created a run");
});
