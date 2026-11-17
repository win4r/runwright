/**
 * The revision a run pins is the revision whose secrets its stored input was redacted against: the write-redaction
 * wrapper reads the revision once, redacts against it and carries it into the creating transaction. A store double
 * publishes revision 2 (naming a secret "another process" stored, through a second handle on the same file)
 * between the wrapper's getRevision and the store's create.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { generateSealKey } from "../../src/security/seal.ts";
import { createSecretsService } from "../../src/security/secrets.ts";
import { createWriteRedaction, redactingStore } from "../../src/security/write-redaction.ts";
import { openSqliteStore } from "../../src/store/sqlite.ts";
import type { RunRecord, Store, TriggerRecord } from "../../src/store/types.ts";
import { interceptStore, testAgentDefinition } from "../helpers/store.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { columnValues, formsIn } from "./at-rest.ts";

const OLD_VALUE = "old-secret-value-1111";
const NEW_VALUE = "new-secret-value-2222";
const AGENT = "agent-pin";
const REVISION_1 = testAgentDefinition({ secrets: ["OLD_KEY"] });
const REVISION_2 = testAgentDefinition({ secrets: ["OLD_KEY", "NEW_KEY"], instructions: "Do the new job." });
const SECRET_OF: Readonly<Record<string, string>> = { OLD_KEY: OLD_VALUE, NEW_KEY: NEW_VALUE };

interface Setup {
  path: string;
  /** The wrapped store (this process), whose getRevision publishes revision 2 once armed. */
  store: Store;
  /** Publishes revision 2 during the next getRevision the wrapper makes, after that read returned. */
  arm(): void;
}

async function setup(t: TestContext): Promise<Setup> {
  const dir = await makeTempDir(t, "runwright-revision-pin-");
  const path = join(dir, "runwright.db");
  const sealKey = generateSealKey();
  const raw = await openSqliteStore({ path });
  const other = await openSqliteStore({ path });
  t.after(async () => {
    await raw.close();
    await other.close();
  });
  const secrets = await createSecretsService({ store: raw, sealKey });
  await secrets.set("OLD_KEY", OLD_VALUE);
  const otherSecrets = await createSecretsService({ store: other, sealKey });
  await raw.saveAgent({ id: AGENT, definition: REVISION_1 });

  let armed = false;
  const double = interceptStore(raw, {
    async getRevision(agentId, revision) {
      const read = await raw.getRevision(agentId, revision);
      if (armed) {
        armed = false;
        // Another process stores a secret and publishes a revision that names it.
        await otherSecrets.set("NEW_KEY", NEW_VALUE);
        const published = await other.saveAgent({ id: AGENT, definition: REVISION_2 });
        assert.equal(published.revision.revision, 2);
      }
      return read;
    },
  });
  return { path, store: redactingStore(double, createWriteRedaction(secrets)), arm: () => { armed = true; } };
}

/** The stored input of the run and the data of its run.created record, as the database holds them. */
function atRest(path: string, runId: string): string {
  return [
    ...columnValues(path, "SELECT input FROM runs WHERE id = ?", runId),
    ...columnValues(path, "SELECT data FROM journal WHERE run_id = ? AND type = 'run.created'", runId),
  ].join("\n");
}

/** No form of any secret the run's pinned revision hands it is stored in plaintext. */
function assertRedactedForPinned(path: string, run: RunRecord): void {
  const definition = run.revision === 1 ? REVISION_1 : REVISION_2;
  const stored = atRest(path, run.id);
  assert.ok(stored.length > 0);
  for (const name of definition.secrets ?? []) {
    assert.deepEqual(formsIn(stored, SECRET_OF[name] as string), [], `revision ${run.revision} hands ${name}; it is not stored in plaintext`);
  }
}

const MESSAGE = `deploy with ${OLD_VALUE} and ${NEW_VALUE}`;
const DATA = { token: NEW_VALUE, old: OLD_VALUE };

const trigger: TriggerRecord = {
  id: "trg_pin", name: "deploy hook", kind: "webhook", agentId: AGENT, enabled: true, cron: null, webhook: { secretName: "HOOK_KEY" },
  message: "deploy", limits: { maxCostMicros: null, maxToolCalls: null, maxTurns: null, allowUnpriced: false },
  lastFiredAt: null, nextFireAt: null, createdAt: 1, updatedAt: 1,
};

test("(R15D-tools-02) a fire pins the revision its input was redacted against, though a revision is published in between", async (t) => {
  const { path, store, arm } = await setup(t);
  await store.saveTrigger(trigger);
  const fire = (delivery: string) => store.fireTrigger({
    trigger, kind: "webhook", idempotencyKey: `webhook:${trigger.id}:${delivery}`, firedAt: 10,
    run: { input: { message: MESSAGE, data: DATA }, limits: {} },
  });

  arm();
  const first = await fire("d-1");
  assert.equal(first.outcome, "started");
  const run1 = (first as { run: RunRecord }).run;
  assert.equal(run1.revision, 1, "the revision the wrapper read, not the one published before the insert");
  assertRedactedForPinned(path, run1);
  assert.deepEqual(formsIn(atRest(path, run1.id), OLD_VALUE), []);

  const second = await fire("d-2");
  assert.equal(second.outcome, "started");
  const run2 = (second as { run: RunRecord }).run;
  assert.equal(run2.revision, 2);
  assertRedactedForPinned(path, run2);
  const stored = atRest(path, run2.id);
  assert.deepEqual([formsIn(stored, OLD_VALUE), formsIn(stored, NEW_VALUE)], [[], []], "the new secret is redacted too");
});

test("(R15D-tools-02) createRun without a revision pins the revision its input was redacted against", async (t) => {
  const { path, store, arm } = await setup(t);
  arm();
  const first = await store.createRun({ agentId: AGENT, input: { message: MESSAGE, data: DATA } });
  assert.equal(first.run.revision, 1);
  assertRedactedForPinned(path, first.run);

  const second = await store.createRun({ agentId: AGENT, input: { message: MESSAGE, data: DATA } });
  assert.equal(second.run.revision, 2);
  assertRedactedForPinned(path, second.run);
  const stored = atRest(path, second.run.id);
  assert.deepEqual([formsIn(stored, OLD_VALUE), formsIn(stored, NEW_VALUE)], [[], []]);
});

test("(R15D-tools-02) an idempotent replay of a request without a revision returns the first run after a revision was published", async (t) => {
  const { store, arm } = await setup(t);
  const request = { agentId: AGENT, input: { message: MESSAGE, data: DATA }, idempotencyKey: "deploy-once" };
  arm();
  const first = await store.createRun(request);
  assert.deepEqual([first.created, first.run.revision], [true, 1]);
  const replay = await store.createRun(request);
  assert.deepEqual([replay.created, replay.run.id, replay.run.revision], [false, first.run.id, 1]);
  assert.equal((await store.findIdempotentRun({ idempotencyKey: "deploy-once" }))?.id, first.run.id);
});

test("(R15D-tools-02) the store compares the fingerprint of the request as sent, not one of the now explicit revision", async (t) => {
  const dir = await makeTempDir(t, "runwright-revision-pin-");
  const path = join(dir, "runwright.db");
  const raw = await openSqliteStore({ path });
  const other = await openSqliteStore({ path });
  t.after(async () => {
    await raw.close();
    await other.close();
  });
  const secrets = await createSecretsService({ store: raw, sealKey: generateSealKey() });
  await raw.saveAgent({ id: AGENT, definition: REVISION_1 });
  const request = { agentId: AGENT, input: { message: "deploy", data: null }, idempotencyKey: "race-key" };
  let raced: RunRecord | null = null;
  const double = interceptStore(raw, {
    async getRevision(agentId, revision) {
      const read = await raw.getRevision(agentId, revision);
      // After the wrapper found the key unused, another process starts the same request (no revision given).
      if (raced === null) raced = (await other.createRun(request)).run;
      return read;
    },
  });
  const store = redactingStore(double, createWriteRedaction(secrets));
  const result = await store.createRun(request);
  assert.ok(raced !== null);
  assert.deepEqual([result.created, result.run.id], [false, (raced as RunRecord).id], "the same request, not idempotency_mismatch");
});

test("(R15D-tools-02) an agent the wrapper read as missing gets no run, though it is saved before the insert", async (t) => {
  const dir = await makeTempDir(t, "runwright-revision-pin-");
  const path = join(dir, "runwright.db");
  const raw = await openSqliteStore({ path });
  const other = await openSqliteStore({ path });
  t.after(async () => {
    await raw.close();
    await other.close();
  });
  const secrets = await createSecretsService({ store: raw, sealKey: generateSealKey() });
  let armed = false;
  const double = interceptStore(raw, {
    async getRevision(agentId, revision) {
      const read = await raw.getRevision(agentId, revision);
      if (armed) {
        armed = false;
        await other.saveAgent({ id: agentId, definition: REVISION_1 });
      }
      return read;
    },
  });
  const store = redactingStore(double, createWriteRedaction(secrets));
  const late = { ...trigger, id: "trg_late", agentId: "late" };
  await store.saveTrigger(late);
  armed = true;
  const fired = await store.fireTrigger({
    trigger: late, kind: "webhook", idempotencyKey: "webhook:trg_late:d-1", firedAt: 10, run: { input: { message: "go", data: null }, limits: {} },
  });
  assert.equal(fired.outcome, "agent_missing");

  const created = await raw.saveAgent({ id: "early", definition: REVISION_1 });
  assert.equal(created.revision.revision, 1);
  armed = true;
  await assert.rejects(store.createRun({ agentId: "later", input: { message: "go", data: null } }), /agent later not found/);
  assert.equal((await raw.getAgent("later"))?.currentRevision, 1, "the agent was saved after the wrapper's read");
  await assert.rejects(store.createRun({ agentId: "early", revision: 5, input: { message: "go", data: null } }), /agent early has no revision 5/);
  assert.deepEqual((await raw.listRuns({}, { limit: 10 })).items, []);
});
