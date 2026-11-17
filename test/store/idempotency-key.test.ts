/**
 * An idempotency key must be well-formed Unicode: UTF-8 turns every unpaired surrogate into U+FFFD, so two
 * different ill-formed keys would share a digest. Caller text the store keeps in a TEXT column as it is must be
 * well-formed too, or the stored text would not be the text sent.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, sha256Hex } from "../../src/core/json.ts";
import { isRunwrightError } from "../../src/core/errors.ts";
import { generateSealKey } from "../../src/security/seal.ts";
import { createSecretsService } from "../../src/security/secrets.ts";
import { createWriteRedaction, redactingStore } from "../../src/security/write-redaction.ts";
import { idempotencyDigest, isWellFormedText, requestFingerprint } from "../../src/store/idempotency.ts";
import type { Store, TriggerRecord } from "../../src/store/types.ts";
import type { WorkflowDocument } from "../../src/workflow/types.ts";
import { seedLearningItems } from "../helpers/learning.ts";
import { interceptStore, openTestStore, testAgentDefinition } from "../helpers/store.ts";

const LONE_HIGH = "\ud800";
const LONE_LOW = "\udc00";
const badRequest = (e: unknown): boolean => isRunwrightError(e) && e.code === "bad_request";
const wellFormedRefusal = (e: unknown): boolean =>
  badRequest(e) && /an idempotency key must be well-formed Unicode \(no unpaired surrogate\)/.test((e as Error).message);

async function setup(t: TestContext): Promise<Store> {
  const { store } = await openTestStore(t);
  await store.saveAgent({ id: "agent-a", definition: testAgentDefinition() });
  return store;
}

const trigger: TriggerRecord = {
  id: "trg_m", name: "manual", kind: "webhook", agentId: "agent-a", enabled: true, cron: null, webhook: { secretName: "HOOK" },
  message: "go", limits: { maxCostMicros: null, maxToolCalls: null, maxTurns: null, allowUnpriced: false },
  lastFiredAt: null, nextFireAt: null, createdAt: 1, updatedAt: 1,
};

const runCount = async (store: Store): Promise<number> => (await store.listRuns({}, { limit: 200 })).items.length;

test("(R15D-store-02) idempotencyDigest refuses an unpaired surrogate and two such keys never share a digest", () => {
  for (const key of [LONE_HIGH, LONE_LOW, `a${LONE_HIGH}b`, `${LONE_LOW}😀`, `😀${LONE_HIGH}`]) {
    assert.throws(() => idempotencyDigest(key), wellFormedRefusal, JSON.stringify(key));
    assert.equal(isWellFormedText(key), false);
  }
  // U+FFFD is what UTF-8 would have made of both: as a key of its own it is accepted, and it is the only one.
  assert.equal(idempotencyDigest("�"), `sha256:${sha256Hex("�")}`);
  assert.equal(isWellFormedText("k-😀-ключ"), true);
});

test("(R15D-store-02) createRun with an ill-formed key is bad_request and creates nothing", async (t) => {
  const store = await setup(t);
  await assert.rejects(store.createRun({ agentId: "agent-a", input: { message: "x", data: null }, idempotencyKey: LONE_HIGH }), wellFormedRefusal);
  await assert.rejects(
    store.createRun({ agentId: "agent-a", input: { message: "x", data: null }, idempotencyKey: LONE_LOW, strictIdempotency: false }),
    wellFormedRefusal,
  );
  assert.equal(await runCount(store), 0);
  await assert.rejects(store.findIdempotentRun({ idempotencyKey: LONE_HIGH }), wellFormedRefusal);
  await assert.rejects(store.findIdempotentRun({ idempotencyKey: `x${LONE_LOW}`, strictIdempotency: false }), wellFormedRefusal);
});

test("(R15D-store-02) a key that differs from a used one only in its unpaired surrogate does not find that run", async (t) => {
  const store = await setup(t);
  const { run } = await store.createRun({ agentId: "agent-a", input: { message: "x", data: null }, idempotencyKey: "k-�" });
  await assert.rejects(store.findIdempotentRun({ idempotencyKey: `k-${LONE_HIGH}` }), wellFormedRefusal);
  await assert.rejects(store.createRun({ agentId: "agent-a", input: { message: "x", data: null }, idempotencyKey: `k-${LONE_HIGH}` }), wellFormedRefusal);
  assert.equal((await store.findIdempotentRun({ idempotencyKey: "k-�" }))?.id, run.id);
  assert.equal(await runCount(store), 1);
});

test("(R15D-store-02) a fire with an ill-formed key is bad_request and writes nothing", async (t) => {
  const store = await setup(t);
  await store.saveTrigger(trigger);
  const before = await store.getTrigger(trigger.id);
  await assert.rejects(store.fireTrigger({
    trigger, kind: "webhook", idempotencyKey: `webhook:trg_m:${LONE_HIGH}`, firedAt: 50,
    run: { input: { message: "go", data: null }, limits: {} },
  }), wellFormedRefusal);
  await assert.rejects(store.fireTrigger({ trigger, kind: "webhook", idempotencyKey: `webhook:trg_m:${LONE_LOW}`, firedAt: 50 }), wellFormedRefusal);
  assert.equal(await runCount(store), 0);
  assert.deepEqual(await store.getTrigger(trigger.id), before);
});

test("(R15D-store-02) the write-redaction wrapper refuses an ill-formed key before it reads a revision", async (t) => {
  const store = await setup(t);
  const secrets = await createSecretsService({ store, sealKey: generateSealKey() });
  const reads: string[] = [];
  const spied = interceptStore(store, {
    getRevision: async (agentId, revision) => {
      reads.push(agentId);
      return store.getRevision(agentId, revision);
    },
  });
  const wrapped = redactingStore(spied, createWriteRedaction(secrets));
  await wrapped.saveTrigger(trigger);
  reads.length = 0;
  await assert.rejects(wrapped.createRun({ agentId: "agent-a", input: { message: "x", data: null }, idempotencyKey: LONE_HIGH }), wellFormedRefusal);
  await assert.rejects(wrapped.findIdempotentRun({ idempotencyKey: LONE_HIGH }), wellFormedRefusal);
  await assert.rejects(wrapped.fireTrigger({
    trigger, kind: "webhook", idempotencyKey: `webhook:trg_m:${LONE_HIGH}`, firedAt: 50, run: { input: { message: "go", data: null }, limits: {} },
  }), wellFormedRefusal);
  assert.deepEqual(reads, [], "no revision was read");
  assert.equal(await runCount(store), 0);
});

test("(R15D-store-02) two requests that differ only in unpaired surrogates have different fingerprints", () => {
  const request = (text: string) => ({ agentId: "agent-a", input: { message: text, data: { [text]: [text] } } });
  const high = requestFingerprint(request(`a${LONE_HIGH}`));
  const otherHigh = requestFingerprint(request("a\ud801"));
  const low = requestFingerprint(request(`a${LONE_LOW}`));
  const replacement = requestFingerprint(request("a�"));
  assert.equal(new Set([high, otherHigh, low, replacement]).size, 4);
  // canonicalJson escapes an unpaired surrogate, so the hashed text is well-formed.
  const text = canonicalJson(request(`a${LONE_HIGH}`).input);
  assert.ok(text.includes("\\ud800"));
  assert.equal(isWellFormedText(text), true);
});

test("(R15D-store-02) a well-formed key with astral characters works and is found again", async (t) => {
  const store = await setup(t);
  const key = "deploy-🚀-\u{1F600}-密钥";
  const first = await store.createRun({ agentId: "agent-a", input: { message: "x", data: null }, idempotencyKey: key });
  assert.equal(first.created, true);
  assert.equal(first.run.idempotencyKey, idempotencyDigest(key));
  const again = await store.createRun({ agentId: "agent-a", input: { message: "x", data: null }, idempotencyKey: key });
  assert.deepEqual([again.created, again.run.id], [false, first.run.id]);
  assert.equal((await store.findIdempotentRun({ idempotencyKey: key }))?.id, first.run.id);
  await store.saveTrigger(trigger);
  const fired = await store.fireTrigger({
    trigger, kind: "webhook", idempotencyKey: `webhook:trg_m:${key}`, firedAt: 50, run: { input: { message: "go", data: null }, limits: {} },
  });
  assert.equal(fired.outcome, "started");
  const duplicate = await store.fireTrigger({ trigger, kind: "webhook", idempotencyKey: `webhook:trg_m:${key}`, firedAt: 60 });
  assert.equal(duplicate.outcome, "duplicate");
});

test("(R15D-store-02) caller text kept in a TEXT column as it is must be well-formed: agent, trigger, learning edit, secret, workflow", async (t) => {
  const store = await setup(t);
  await assert.rejects(store.saveAgent({ definition: testAgentDefinition({ name: `Agent ${LONE_HIGH}` }) }), badRequest);
  await assert.rejects(store.saveAgent({ id: `a${LONE_LOW}`, definition: testAgentDefinition() }), badRequest);
  assert.deepEqual((await store.listAgents()).map((a) => a.id), ["agent-a"]);

  await assert.rejects(store.saveTrigger({ ...trigger, message: `go ${LONE_HIGH}` }), badRequest);
  await assert.rejects(store.saveTrigger({ ...trigger, name: `n${LONE_LOW}` }), badRequest);
  assert.equal(await store.getTrigger(trigger.id), null);
  await store.saveTrigger(trigger);
  const stored = await store.getTrigger(trigger.id) as TriggerRecord;
  await assert.rejects(store.updateTrigger({ ...stored, message: `go ${LONE_HIGH}` }, stored), badRequest);
  assert.deepEqual(await store.getTrigger(trigger.id), stored);

  const [note] = await seedLearningItems(store, "agent-a", [
    { kind: "note", name: "fact", title: "Fact", description: "A fact.", body: "The body.", status: "active" },
  ]);
  for (const patch of [{ title: `T${LONE_HIGH}` }, { description: `D${LONE_LOW}` }, { body: `B${LONE_HIGH}` }]) {
    await assert.rejects(store.changeLearningItem(note!.id, { expectedEtag: note!.etag, action: "edit", patch, actor: "person" }), badRequest);
  }
  assert.deepEqual(await store.getLearningItem(note!.id), note);

  await assert.rejects(store.putSecret(`KEY${LONE_HIGH}`, new Uint8Array([1])), badRequest);
  assert.deepEqual(await store.listSecrets(), []);
  await assert.rejects(store.saveWorkflow({ name: `w${LONE_LOW}`, document: { name: "w" } as unknown as WorkflowDocument, source: "api" }), badRequest);
  assert.deepEqual(await store.listWorkflows(), []);
});
