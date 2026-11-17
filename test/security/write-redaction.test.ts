import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { AgentDefinition } from "../../src/agents/definition.ts";
import { RunwrightError } from "../../src/core/errors.ts";
import type { Json } from "../../src/core/json.ts";
import { secretForms } from "../../src/core/redact.ts";
import { generateSealKey } from "../../src/security/seal.ts";
import { createSecretsService } from "../../src/security/secrets.ts";
import type { SecretsService } from "../../src/security/types.ts";
import { createWriteRedaction, redactingStore, type WriteRedaction } from "../../src/security/write-redaction.ts";
import { idempotencyDigest, requestFingerprint } from "../../src/store/idempotency.ts";
import type { CommitBatch, CreateRunInput, Lease, RunCommand, Store, TriggerFireInput, TriggerRecord } from "../../src/store/types.ts";
import type { WorkflowDocument } from "../../src/workflow/types.ts";
import { fieldList, fieldObject, recordFieldsWith } from "../../src/store/record-fields.ts";
import { seedLearningItems } from "../helpers/learning.ts";
import { openTestStore, testAgentDefinition } from "../helpers/store.ts";
import { columnValues, formsIn, scanDatabase } from "./at-rest.ts";

/** Has a quote and a backslash (so its JSON-escaped form differs), a space and a slash (percent form differs), "?>" (base64url differs). */
const VALUE = 'tool-key "q" \\ 0123/xyz?>';
const MULTIBYTE = "pässwörd-ü-ключ-密码";
const PLACEHOLDER = "[redacted]";

interface Setup {
  raw: Store; path: string; sealKey: Uint8Array; secrets: SecretsService; redaction: WriteRedaction; store: Store;
  definition: AgentDefinition;
}

async function setup(t: TestContext): Promise<Setup> {
  const { store: raw, path } = await openTestStore(t);
  const sealKey = generateSealKey();
  const secrets = await createSecretsService({ store: raw, sealKey });
  await secrets.set("TOOL_KEY", VALUE);
  await secrets.set("WIDE_KEY", MULTIBYTE);
  const redaction = createWriteRedaction(secrets);
  const definition = testAgentDefinition({ secrets: ["TOOL_KEY", "WIDE_KEY"] });
  await raw.saveAgent({ id: "agent-a", definition });
  return { raw, path, sealKey, secrets, redaction, store: redactingStore(raw, redaction), definition };
}

function assertClean(text: string, label: string): void {
  for (const value of [VALUE, MULTIBYTE]) assert.deepEqual(formsIn(text, value), [], `${label} holds no form of a secret`);
}

/** Text that carries every form of both secrets. */
function everyForm(): string[] {
  return [...secretForms(VALUE), ...secretForms(MULTIBYTE)];
}

test("the probe values cover every encoding: six distinct forms, and a multibyte value", () => {
  assert.equal(secretForms(VALUE).length, 6);
  assert.equal(secretForms(MULTIBYTE).length, 4, "plain, padded and unpadded base64 (= base64url), percent (= JSON-escaped)");
});

test("runInput redacts every form in the message, in data strings and in data keys", async (t) => {
  const { redaction, definition } = await setup(t);
  for (const form of everyForm()) {
    const data: Json = { [form]: form, list: [form, { nested: `before ${form} after` }], n: 3, flag: true, none: null };
    const out = await redaction.runInput(definition, { message: `say ${form} now`, data });
    assertClean(JSON.stringify(out), `form ${JSON.stringify(form)}`);
    assert.equal(out.message, `say ${PLACEHOLDER} now`);
    assert.deepEqual(out.data, {
      [PLACEHOLDER]: PLACEHOLDER, list: [PLACEHOLDER, { nested: `before ${PLACEHOLDER} after` }], n: 3, flag: true, none: null,
    });
  }
});

test("runInput keeps a __proto__ key an own property and leaves clean input equal", async (t) => {
  const { redaction, definition } = await setup(t);
  const data = JSON.parse(`{"__proto__": ${JSON.stringify(VALUE)}, "ok": "plain"}`) as Json;
  const out = await redaction.runInput(definition, { message: "hello", data });
  assert.ok(Object.hasOwn(out.data as object, "__proto__"));
  assert.equal(Object.getOwnPropertyDescriptor(out.data, "__proto__")?.value, PLACEHOLDER);
  assert.equal((out.data as { ok: string }).ok, "plain");
  assert.deepEqual(await redaction.runInput(definition, { message: "hello", data: { a: [1, "b"] } }), { message: "hello", data: { a: [1, "b"] } });
});

test("command redacts only the free text of each type; type and pendingId never change", async (t) => {
  const { redaction, definition } = await setup(t);
  const secret = `x ${VALUE} y ${MULTIBYTE}`;
  const clean = `x ${PLACEHOLDER} y ${PLACEHOLDER}`;
  const cases: [RunCommand, RunCommand][] = [
    [{ type: "message", text: secret }, { type: "message", text: clean }],
    [{ type: "answer", pendingId: "pnd_1", answer: secret }, { type: "answer", pendingId: "pnd_1", answer: clean }],
    [{ type: "deny", pendingId: "pnd_2", reason: secret }, { type: "deny", pendingId: "pnd_2", reason: clean }],
    [{ type: "deny", pendingId: "pnd_3", reason: null }, { type: "deny", pendingId: "pnd_3", reason: null }],
    [{ type: "cancel", reason: secret }, { type: "cancel", reason: clean }],
    [{ type: "cancel", reason: null }, { type: "cancel", reason: null }],
    [{ type: "resolve_interrupted", pendingId: "pnd_4", action: "skip", result: secret },
      { type: "resolve_interrupted", pendingId: "pnd_4", action: "skip", result: clean }],
    [{ type: "resolve_interrupted", pendingId: "pnd_5", action: "retry", result: null },
      { type: "resolve_interrupted", pendingId: "pnd_5", action: "retry", result: null }],
  ];
  for (const [command, expected] of cases) assert.deepEqual(await redaction.command(definition, command), expected);

  const untouched: RunCommand[] = [
    { type: "approve", pendingId: VALUE, always: true },
    { type: "limits", limits: { maxCostMicros: 5 } },
    { type: "pause" },
    { type: "resume" },
  ];
  for (const command of untouched) assert.equal(await redaction.command(definition, command), command, `${command.type} is returned as it is`);

  const tricky: RunCommand = { type: "answer", pendingId: VALUE, answer: "fine" };
  assert.equal((await redaction.command(definition, tricky) as { pendingId: string }).pendingId, VALUE, "pendingId is never touched");
});

test("a secret another process stored is redacted once the definition names it", async (t) => {
  const { raw, sealKey, redaction } = await setup(t);
  const other = await createSecretsService({ store: raw, sealKey });
  const fresh = "fresh-secret-from-elsewhere-42";
  const apiKey = "sk-ant-other-process-key-0000000000";
  await other.set("LATE_KEY", fresh);
  await other.set("ANTHROPIC_API_KEY", apiKey);

  assert.equal(await redaction.text(`a ${fresh}`), `a ${fresh}`, "unknown to this process until something names it");
  const naming = testAgentDefinition({ secrets: ["LATE_KEY"] });
  assert.equal(await redaction.text(`a ${fresh}`, naming), `a ${PLACEHOLDER}`);

  const anthropic = testAgentDefinition({ model: { provider: "anthropic", name: "claude-test-1" } });
  const out = await redaction.runInput(anthropic, { message: apiKey, data: { [apiKey]: 1 } });
  assert.deepEqual(out, { message: PLACEHOLDER, data: { [PLACEHOLDER]: 1 } }, "the model's API-key secret is revealed too");
});

test("a named secret this process cannot unseal is skipped; the readable ones are still revealed", async (t) => {
  const { raw, sealKey, redaction } = await setup(t);
  const foreign = await createSecretsService({ store: raw, sealKey: generateSealKey() });
  await foreign.set("AA_FOREIGN", "sealed-with-another-key");
  const sameKey = await createSecretsService({ store: raw, sealKey });
  const late = "readable-late-secret-77";
  await sameKey.set("ZZ_READABLE", late);
  const definition = testAgentDefinition({ secrets: ["AA_FOREIGN", "ZZ_READABLE"] });
  assert.equal(await redaction.text(`v ${late} w ${VALUE}`, definition), `v ${PLACEHOLDER} w ${PLACEHOLDER}`);
  const command = await redaction.command(definition, { type: "cancel", reason: late });
  assert.deepEqual(command, { type: "cancel", reason: PLACEHOLDER });
});

test("redactingStore: runs.input, run.created and commands.payload hold no form of the secret", async (t) => {
  const { store, path } = await setup(t);
  const forms = everyForm();
  const message = `start ${forms.join(" | ")}`;
  const data: Json = Object.fromEntries(forms.map((form, i) => [form, [form, i]]));
  const { run, created } = await store.createRun({ agentId: "agent-a", input: { message, data } });
  assert.equal(created, true);
  assert.ok(run.input.message.startsWith(`start ${PLACEHOLDER}`));
  assertClean(JSON.stringify(run), "the returned run");

  const secret = `the value is ${VALUE} and ${MULTIBYTE}`;
  const commands: RunCommand[] = [
    { type: "message", text: secret },
    { type: "answer", pendingId: "pnd_a", answer: secret },
    { type: "approve", pendingId: "pnd_b", always: false },
    { type: "deny", pendingId: "pnd_c", reason: secret },
    { type: "limits", limits: { maxTurns: 4 } },
    { type: "resolve_interrupted", pendingId: "pnd_d", action: "skip", result: secret },
    { type: "pause" },
    { type: "resume" },
    { type: "cancel", reason: secret },
  ];
  for (const command of commands) {
    const record = await store.enqueueCommand(run.id, command);
    assertClean(JSON.stringify(record), `the returned ${command.type} command`);
    assert.equal(record.command.type, command.type);
  }

  for (const input of columnValues(path, "SELECT input FROM runs WHERE id = ?", run.id)) assertClean(input, "runs.input");
  const created1 = columnValues(path, "SELECT data FROM journal WHERE run_id = ? AND type = 'run.created'", run.id);
  assert.equal(created1.length, 1);
  assertClean(created1[0] as string, "the run.created row");
  const payloads = columnValues(path, "SELECT payload FROM commands WHERE run_id = ? ORDER BY created_at, id", run.id);
  assert.equal(payloads.length, commands.length);
  for (const payload of payloads) assertClean(payload, "commands.payload");
  assert.ok(payloads.filter((payload) => payload.includes(PLACEHOLDER)).length >= 5);

  const journal = await store.readJournal(run.id);
  const createdRecord = journal.find((record) => record.type === "run.created");
  assert.ok(JSON.stringify(createdRecord?.data).includes(PLACEHOLDER));
  assertClean(JSON.stringify(journal), "readJournal()");
});

test("redactingStore: the same idempotent request twice returns the same run", async (t) => {
  const { store } = await setup(t);
  const request = { agentId: "agent-a", idempotencyKey: "idem-1", input: { message: `m ${VALUE}`, data: { k: VALUE } } };
  const first = await store.createRun(request);
  const second = await store.createRun(request);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.run.id, first.run.id);
  await assert.rejects(store.createRun({ ...request, input: { message: "different", data: null } }), (error: unknown) =>
    error instanceof RunwrightError && error.code === "idempotency_mismatch");
});

test("redactingStore: every key, with or without a secret, is reported as its digest and never stored as text", async (t) => {
  const { store, path } = await setup(t);
  const key = `delivery-${VALUE}`;
  const first = await store.createRun({ agentId: "agent-a", idempotencyKey: key, input: { message: "a", data: null } });
  assert.equal(first.run.idempotencyKey, idempotencyDigest(key));
  const again = await store.createRun({ agentId: "agent-a", idempotencyKey: key, input: { message: "a", data: null } });
  assert.equal(again.created, false);
  assert.equal(again.run.id, first.run.id);
  const other = await store.createRun({ agentId: "agent-a", idempotencyKey: `other-${VALUE}`, input: { message: "a", data: null } });
  assert.equal(other.created, true, "keys that differ only around a secret stay different");
  assert.equal(other.run.idempotencyKey, idempotencyDigest(`other-${VALUE}`));
  const plain = await store.createRun({ agentId: "agent-a", idempotencyKey: "plain-key", input: { message: "a", data: null } });
  assert.equal(plain.run.idempotencyKey, idempotencyDigest("plain-key"));
  const stored = columnValues(path, "SELECT idempotency_key FROM runs WHERE idempotency_key IS NOT NULL");
  assert.equal(stored.length, 3);
  for (const value of stored) {
    assertClean(value, "runs.idempotency_key");
    assert.match(value, /^sha256:[0-9a-f]{64}$/);
  }
  for (const text of [key, `other-${VALUE}`, "plain-key"]) {
    assert.deepEqual(scanDatabase(path, text).filter((hit) => hit.table !== "secrets"), [], `no copy of ${JSON.stringify(text)}`);
  }
});

/** The same store and seal key, seen by a new process: a new secrets service, a new write redaction, a new wrapper. */
async function restart(setupState: Setup): Promise<Store> {
  const secrets = await createSecretsService({ store: setupState.raw, sealKey: setupState.sealKey });
  return redactingStore(setupState.raw, createWriteRedaction(secrets));
}

const sameRun = async (store: Store, request: CreateRunInput, expectedId: string): Promise<void> => {
  const result = await store.createRun(request);
  assert.deepEqual([result.created, result.run.id], [false, expectedId]);
};

test("idempotency: the reviewer's probe — a key holding a secret, the secret deleted, a restart: the same run", async (t) => {
  const state = await setup(t);
  const request = { agentId: "agent-a", idempotencyKey: `delivery-${VALUE}`, input: { message: "a", data: null } };
  const first = await state.store.createRun(request);
  assert.equal(await state.secrets.delete("TOOL_KEY"), true);
  const restarted = await restart(state);
  assert.equal(await createWriteRedaction(await createSecretsService({ store: state.raw, sealKey: state.sealKey })).text(VALUE), "[redacted]",
    "after the restart the deleted value is still known as a retired value: the run created before the delete is unfinished");
  await sameRun(restarted, request, first.run.id);
  await sameRun(state.store, request, first.run.id);
});

test("idempotency: a key that holds a value which later becomes a secret is still the same request", async (t) => {
  const state = await setup(t);
  const late = "becomes-a-secret-later-9081";
  const request = { agentId: "agent-a", idempotencyKey: `k-${late}`, input: { message: "a", data: null } };
  const first = await state.store.createRun(request);
  await state.secrets.set("LATE_KEY", late);
  await sameRun(state.store, request, first.run.id);
  await sameRun(await restart(state), request, first.run.id);
});

test("idempotency: rotating the secret a key holds keeps the same run", async (t) => {
  const state = await setup(t);
  const v1 = "rotating-secret-value-one-1";
  await state.secrets.set("ROTATING", v1);
  const request = { agentId: "agent-a", idempotencyKey: `k-${v1}`, input: { message: "a", data: null } };
  const first = await state.store.createRun(request);
  await state.secrets.set("ROTATING", "rotating-secret-value-two-2");
  await sameRun(state.store, request, first.run.id);
  await sameRun(await restart(state), request, first.run.id);
});

test("idempotency: a secret in the message and data is the same request across delete + restart and across set", async (t) => {
  const state = await setup(t);
  const request = { agentId: "agent-a", idempotencyKey: "msg-key", input: { message: `use ${VALUE}`, data: { token: VALUE, [VALUE]: 1 } } };
  const first = await state.store.createRun(request);
  assert.equal(first.run.input.message, `use ${PLACEHOLDER}`);
  await state.secrets.delete("TOOL_KEY");
  const restarted = await restart(state);
  await sameRun(restarted, request, first.run.id);
  await assert.rejects(restarted.createRun({ ...request, input: { message: "a different request", data: null } }), (error: unknown) =>
    error instanceof RunwrightError && error.code === "idempotency_mismatch");

  const late = "message-secret-set-later-55";
  const lateRequest = { agentId: "agent-a", idempotencyKey: "late-key", input: { message: `use ${late}`, data: { v: late } } };
  const lateFirst = await state.store.createRun(lateRequest);
  assert.equal(lateFirst.run.input.message, `use ${late}`, "not a secret yet");
  await state.secrets.set("LATE", late);
  await sameRun(state.store, lateRequest, lateFirst.run.id);
  await sameRun(await restart(state), lateRequest, lateFirst.run.id);
  await assert.rejects(state.store.createRun({ ...lateRequest, input: { message: `use ${late}!`, data: { v: late } } }), (error: unknown) =>
    error instanceof RunwrightError && error.code === "idempotency_mismatch");
});

test("idempotency: the fingerprint is taken before redaction; a given one is passed on unchanged", async (t) => {
  const { store, path } = await setup(t);
  const input = { message: `m ${VALUE}`, data: { k: VALUE } };
  const computed = await store.createRun({ agentId: "agent-a", idempotencyKey: "computed", input });
  assert.deepEqual(columnValues(path, "SELECT request_hash FROM runs WHERE id = ?", computed.run.id),
    [requestFingerprint({ agentId: "agent-a", input })]);
  const given = "0123456789abcdef".repeat(4);
  const passed = await store.createRun({ agentId: "agent-a", idempotencyKey: "given", input, requestFingerprint: given });
  assert.deepEqual(columnValues(path, "SELECT request_hash FROM runs WHERE id = ?", passed.run.id), [given]);
  await assert.rejects(store.createRun({ agentId: "agent-a", input, requestFingerprint: "not-hex" }), (error: unknown) =>
    error instanceof RunwrightError && error.code === "validation_failed");
});

/** Creates a run of agent-a through the bare store and claims it. */
async function claimNewRun(raw: Store): Promise<Lease> {
  const { run } = await raw.createRun({ agentId: "agent-a", input: { message: "go", data: null } });
  const claimed = await raw.claimRuns({ runnerId: "r1", limit: 50, leaseMs: 60_000 });
  const mine = claimed.find((c) => c.run.id === run.id);
  assert.ok(mine !== undefined);
  return mine.lease;
}

const workflowDocument = (text: string): WorkflowDocument => ({
  format: "runwright.workflow/v1", name: "deploy", schemas: { In: { type: "object" }, Out: { type: "string" } },
  input: "In", output: "Out", root: { id: "run", kind: "tool", tool: "shell", args: { command: `deploy ${text}` } },
  result: { $ref: "steps.run.content" },
}) as unknown as WorkflowDocument;

test("redactingStore: every text of a commit is stored without a form of a secret the process knows", async (t) => {
  const { store, raw, path } = await setup(t);
  const [skill] = await seedLearningItems(raw, "agent-a", [
    { kind: "skill", name: "deploy", title: "Deploy", description: "How", body: "Steps.", status: "active" },
  ]);
  const lease = await claimNewRun(raw);
  const forms = everyForm();
  const secret = `x ${forms.join(" | ")} y`;
  const kept = "already [redacted:TOOL_KEY] here";
  const first: CommitBatch = {
    records: [
      { type: "note", key: "n1", data: { text: secret, [VALUE]: [MULTIBYTE], kept } },
    ],
    openPendings: [{ id: "pnd_w", kind: "question", stepKey: "q1", title: `ask ${secret}`, detail: { question: secret, [MULTIBYTE]: 1 } }],
    learning: {
      puts: [{ id: "li_w", kind: "note", name: "w-note", title: `t ${VALUE}`, description: `d ${MULTIBYTE}`, body: `b ${secret}`,
        status: "active", expectedVersion: null, note: `n ${VALUE}` }],
      promotions: [{ itemId: skill!.id, expectedVersion: 1, workflow: { name: "deploy", document: workflowDocument(secret) }, note: `p ${VALUE}` }],
    },
  };
  const copy = structuredClone(first);
  await store.commit(lease, first);
  assert.deepEqual(first, copy, "the batch passed in is not mutated");
  await store.commit(lease, {
    records: [{ type: "answered", key: "n2", data: { answer: secret } }],
    resolvePendings: [{ id: "pnd_w", resolution: { answer: secret, [VALUE]: true } }],
  });
  await store.commit(lease, {
    records: [{ type: "run.failed", key: "n3", data: {} }],
    transition: { to: "failed", output: { partial: secret }, error: { code: "boom", message: `failed with ${secret}` } },
  });

  for (const value of [VALUE, MULTIBYTE]) {
    assert.deepEqual(scanDatabase(path, value, ["secrets"]), [], "no table holds a form of the value");
  }
  for (const [table, sql] of [
    ["journal", "SELECT data FROM journal WHERE run_id = ?"],
    ["pendings", "SELECT title || detail || resolution FROM pendings WHERE run_id = ?"],
    ["runs", "SELECT output || error FROM runs WHERE id = ?"],
  ] as const) {
    const rows = columnValues(path, sql, lease.runId);
    assert.ok(rows.length > 0 && rows.some((row) => row.includes(PLACEHOLDER)), `${table} rows were written, redacted`);
  }
  for (const sql of [
    "SELECT title || description || body FROM learning_items WHERE id = 'li_w'",
    "SELECT note FROM learning_history WHERE item_id = 'li_w'",
    `SELECT note FROM learning_history WHERE item_id = '${skill!.id}' AND action = 'promoted'`,
    "SELECT document FROM workflows WHERE name = 'deploy'",
  ]) {
    const rows = columnValues(path, sql);
    assert.equal(rows.length, 1, sql);
    assert.ok(rows[0]!.includes(PLACEHOLDER), sql);
  }
  const journal = await raw.readJournal(lease.runId);
  assert.equal(journal.find((record) => record.key === "n1")?.data["kept"], kept, "text already holding [redacted:NAME] is left as it is");
});

test("redactingStore: with no secrets known a commit is stored unchanged", async (t) => {
  const { store: raw, path } = await openTestStore(t);
  await raw.saveAgent({ id: "agent-a", definition: testAgentDefinition() });
  const store = redactingStore(raw, createWriteRedaction(await createSecretsService({ store: raw, sealKey: generateSealKey() })));
  const lease = await claimNewRun(raw);
  const data = { text: VALUE, [MULTIBYTE]: [1, "two"], nested: { kept: "[redacted:X]" } };
  await store.commit(lease, {
    records: [{ type: "note", key: "n1", data }],
    openPendings: [{ id: "pnd_1", kind: "question", stepKey: "q", title: VALUE, detail: { q: MULTIBYTE } }],
  });
  assert.deepEqual((await raw.readJournal(lease.runId)).find((record) => record.key === "n1")?.data, data);
  assert.deepEqual(columnValues(path, "SELECT title FROM pendings WHERE id = 'pnd_1'"), [VALUE]);
});

function trigger(id: string, message: string, agentId = "agent-a"): TriggerRecord {
  return {
    id, name: `trigger ${id}`, kind: "cron", agentId, enabled: true, cron: { expression: "0 * * * *", timeZone: "UTC" },
    webhook: null, message,
    limits: { maxCostMicros: 1000, maxToolCalls: null, maxTurns: null, allowUnpriced: false },
    lastFiredAt: null, nextFireAt: null, createdAt: 1, updatedAt: 1,
  };
}

test("redactingStore: saveTrigger and updateTrigger store the message redacted and report changed / missing", async (t) => {
  const { store, raw, path } = await setup(t);
  await store.saveTrigger({ ...trigger("trg_1", `fire ${VALUE}`), name: `named ${VALUE}` });
  const saved = await store.getTrigger("trg_1");
  assert.equal(saved?.message, `fire ${PLACEHOLDER}`);
  assert.equal(saved?.name, `named ${PLACEHOLDER}`, "the name is caller text too");

  assert.ok(saved !== null);
  const updated = { ...saved, message: `again ${MULTIBYTE}`, updatedAt: 2 };
  assert.equal(await store.updateTrigger(updated, saved), "updated");
  assert.equal((await store.getTrigger("trg_1"))?.message, `again ${PLACEHOLDER}`);
  assert.equal(await store.updateTrigger({ ...saved, message: "stale" }, saved), "changed", "expected is passed on unchanged");
  assert.equal(await store.updateTrigger(trigger("trg_none", VALUE), trigger("trg_none", VALUE)), "missing");
  assert.equal(await raw.getTrigger("trg_none"), null);

  await store.saveTrigger(trigger("trg_2", `orphan ${VALUE}`, "no-such-agent"));
  assert.equal((await store.getTrigger("trg_2"))?.message, `orphan ${PLACEHOLDER}`, "known values are redacted without an agent");
  for (const message of columnValues(path, "SELECT message FROM triggers")) assertClean(message, "triggers.message");
  for (const name of columnValues(path, "SELECT name FROM triggers")) assertClean(name, "triggers.name");
});

test("redactingStore: unknown agent, unknown run and terminal run keep the inner store's errors", async (t) => {
  const { store, raw } = await setup(t);
  const code = (expected: string) => (error: unknown): boolean => error instanceof RunwrightError && error.code === expected;
  await assert.rejects(store.createRun({ agentId: "nobody", input: { message: VALUE, data: null } }), code("not_found"));
  await assert.rejects(store.createRun({ agentId: "agent-a", revision: 9, input: { message: VALUE, data: null } }), code("not_found"));
  await assert.rejects(store.enqueueCommand("run_missing", { type: "message", text: VALUE }), code("not_found"));

  const { run } = await store.createRun({ agentId: "agent-a", input: { message: "go", data: null } });
  const [claimed] = await raw.claimRuns({ runnerId: "r1", limit: 10, leaseMs: 60_000 });
  assert.ok(claimed !== undefined);
  await raw.commit(claimed.lease, { records: [], transition: { to: "completed", output: null } });
  await assert.rejects(store.enqueueCommand(run.id, { type: "message", text: VALUE }), code("run_terminal"));
});

test("redactingStore delegates every other member to the inner store", async (t) => {
  const { store, raw } = await setup(t);
  assert.equal(store.schemaVersion, raw.schemaVersion);
  const events: string[] = [];
  const unsubscribe = store.subscribe((event) => events.push(event.type));
  await store.createRun({ agentId: "agent-a", input: { message: "go", data: null } });
  unsubscribe();
  assert.deepEqual(events, ["run.queued"]);
  assert.deepEqual(await store.listAgents(), await raw.listAgents());
  assert.deepEqual(await store.listSecrets(), await raw.listSecrets());
});

/** A store over `raw` that counts getRevision calls, and a secrets service over `secrets` that counts reveal calls. */
function counting(raw: Store, secrets: SecretsService): { store: Store; counts: { getRevision: number; reveal: number } } {
  const counts = { getRevision: 0, reveal: 0 };
  const inner = new Proxy(raw, {
    get(target, prop, receiver) {
      if (prop === "getRevision") {
        return (agentId: string, revision?: number) => {
          counts.getRevision += 1;
          return target.getRevision(agentId, revision);
        };
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Store;
  const countingSecrets: SecretsService = {
    ...secrets,
    reveal: (names) => {
      counts.reveal += 1;
      return secrets.reveal(names);
    },
  };
  return { store: redactingStore(inner, createWriteRedaction(countingSecrets)), counts };
}

test("redactingStore: findIdempotentRun is the inner store's", async (t) => {
  const { store, raw } = await setup(t);
  const request = { agentId: "agent-a", idempotencyKey: "pass-through", input: { message: "go", data: null } };
  assert.equal(await store.findIdempotentRun({ idempotencyKey: "pass-through" }), null);
  const { run } = await store.createRun(request);
  const fingerprint = requestFingerprint(request);
  assert.deepEqual(await store.findIdempotentRun({ idempotencyKey: "pass-through", requestFingerprint: fingerprint }),
    await raw.findIdempotentRun({ idempotencyKey: "pass-through", requestFingerprint: fingerprint }));
  assert.equal((await store.findIdempotentRun({ idempotencyKey: "pass-through" }))?.id, run.id);
  const other = requestFingerprint({ agentId: "agent-a", input: { message: "other", data: null } });
  await assert.rejects(store.findIdempotentRun({ idempotencyKey: "pass-through", requestFingerprint: other }), (error: unknown) =>
    error instanceof RunwrightError && error.code === "idempotency_mismatch");
  assert.equal((await store.findIdempotentRun({ idempotencyKey: "pass-through", requestFingerprint: other, strictIdempotency: false }))?.id, run.id);
});

test("redactingStore: createRun with a key that has a run reads no revision and reveals no secret (I2)", async (t) => {
  const state = await setup(t);
  const { store, counts } = counting(state.raw, state.secrets);
  const late = "joins-the-secrets-later-3141";
  const request = { agentId: "agent-a", idempotencyKey: "first-key", input: { message: `use ${late}`, data: { v: late } } };
  const first = await store.createRun(request);
  assert.equal(first.created, true);
  assert.ok(counts.getRevision > 0 && counts.reveal > 0, "a new run reads its revision and reveals the named secrets");

  counts.getRevision = 0;
  counts.reveal = 0;
  await sameRun(store, request, first.run.id);
  assert.deepEqual(counts, { getRevision: 0, reveal: 0 });

  await state.secrets.set("LATE_KEY", late);
  await sameRun(store, request, first.run.id);
  assert.deepEqual(counts, { getRevision: 0, reveal: 0 });
  await assert.rejects(store.createRun({ ...request, input: { message: "changed", data: null } }), (error: unknown) =>
    error instanceof RunwrightError && error.code === "idempotency_mismatch");
  const lax = await store.createRun({ ...request, input: { message: "changed", data: null }, strictIdempotency: false });
  assert.deepEqual([lax.created, lax.run.id], [false, first.run.id]);
  assert.deepEqual(counts, { getRevision: 0, reveal: 0 }, "a mismatch is decided before anything else, too");

  const fresh = await store.createRun({ ...request, idempotencyKey: "second-key" });
  assert.equal(fresh.created, true);
  assert.equal(fresh.run.input.message, `use ${PLACEHOLDER}`, "a new request is still redacted");
});

test("redactingStore: a fire's message and data are stored redacted; its request hash is taken before redaction", async (t) => {
  const { store, raw, path } = await setup(t);
  await raw.saveTrigger(trigger("trg_fire", "fire"));
  const record = await raw.getTrigger("trg_fire");
  assert.ok(record !== null);
  const input = { message: `fire ${VALUE}`, data: { v: VALUE, [MULTIBYTE]: [MULTIBYTE] } };
  const limits = { maxCostMicros: 1000 };
  const result = await store.fireTrigger({ trigger: record, kind: "manual", idempotencyKey: "manual:trg_fire:1", firedAt: 5, run: { input, limits } });
  assert.ok(result.outcome === "started");
  assert.deepEqual(result.run.input, { message: `fire ${PLACEHOLDER}`, data: { v: PLACEHOLDER, [PLACEHOLDER]: [PLACEHOLDER] } });
  for (const stored of columnValues(path, "SELECT input FROM runs WHERE id = ?", result.run.id)) assertClean(stored, "runs.input");
  const created = columnValues(path, "SELECT data FROM journal WHERE run_id = ? AND type = 'run.created'", result.run.id);
  assert.equal(created.length, 1);
  assertClean(created[0] as string, "the run.created row");
  assert.ok((created[0] as string).includes(PLACEHOLDER));
  assert.deepEqual(columnValues(path, "SELECT request_hash FROM runs WHERE id = ?", result.run.id),
    [requestFingerprint({ agentId: "agent-a", input, limits })]);
});

test("redactingStore: a fire whose key has a run reaches the inner store without its run and reads no revision (I2)", async (t) => {
  const state = await setup(t);
  const calls: TriggerFireInput[] = [];
  let revisions = 0;
  const inner = new Proxy(state.raw, {
    get(target, prop, receiver) {
      if (prop === "fireTrigger") {
        return (input: TriggerFireInput) => {
          calls.push(input);
          return target.fireTrigger(input);
        };
      }
      if (prop === "getRevision") {
        return (agentId: string, revision?: number) => {
          revisions += 1;
          return target.getRevision(agentId, revision);
        };
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Store;
  const store = redactingStore(inner, state.redaction);
  await state.raw.saveTrigger({ ...trigger("trg_dup", "fire"), nextFireAt: 60_000 });
  const record = await state.raw.getTrigger("trg_dup");
  assert.ok(record !== null);
  const fire: TriggerFireInput = {
    trigger: record, kind: "cron", idempotencyKey: "cron:trg_dup:60000", firedAt: 5,
    run: { input: { message: `go ${VALUE}`, data: null }, limits: { maxCostMicros: 1000 } }, cron: { slot: 60_000, nextFireAt: 120_000 },
  };
  const first = await store.fireTrigger(fire);
  assert.ok(first.outcome === "started");
  assert.ok(revisions > 0 && calls[0]?.run !== undefined, "a new fire reads the revision and hands the store its run");
  revisions = 0;
  calls.length = 0;
  const again = await store.fireTrigger({ ...fire, run: { input: { message: "something else", data: { v: VALUE } }, limits: { maxCostMicros: 1 } } });
  assert.deepEqual([again.outcome, again.outcome === "duplicate" ? again.run.id : ""], ["duplicate", first.run.id]);
  assert.equal(calls.length, 1);
  assert.equal("run" in (calls[0] as object), false, "no caller text reaches the store");
  assert.deepEqual(calls[0], { trigger: record, kind: "cron", idempotencyKey: fire.idempotencyKey, firedAt: 5, cron: fire.cron });
  assert.equal(revisions, 0);

  const { run: _omitted, ...answerOnly } = fire;
  assert.equal((await store.fireTrigger({ ...answerOnly, idempotencyKey: "cron:trg_dup:fresh" })).outcome, "no_run");
  assert.equal(revisions, 0, "a fire without a run reads no revision either");
});

test("at rest a numeric secret in a payload field is stored as the placeholder; engine numbers stay numbers", async (t) => {
  const { store: raw } = await openTestStore(t);
  const secrets = await createSecretsService({ store: raw, sealKey: generateSealKey() });
  await secrets.set("PIN", "12345678");
  const store = redactingStore(raw, createWriteRedaction(secrets));
  await raw.saveAgent({ id: "agent-n", definition: testAgentDefinition({ secrets: ["PIN"] }) });
  const { run } = await store.createRun({
    agentId: "agent-n", input: { message: "go 12345678", data: { credential: 12345678, nested: [12345678, 42] } },
    limits: { maxCostMicros: 12345678 },
  });
  assert.deepEqual(run.input, { message: "go [redacted]", data: { credential: "[redacted]", nested: ["[redacted]", 42] } });
  assert.equal(run.limits.maxCostMicros, 12345678, "a limit is an engine number");
  const [claimed] = await store.claimRuns({ runnerId: "r1", limit: 1, leaseMs: 60_000 });
  await store.commit(claimed!.lease, {
    records: [
      { type: "limits.changed", data: { limits: { maxCostMicros: 12345678 }, note: "cap 12345678" } },
      { type: "tool.started", key: "t1.c1", data: { args: { pin: 12345678, "12345678": "pin 12345678" } } },
      { type: "tool.finished", key: "t1.c1", data: { data: { echo: 12345678 }, durationMs: 12345678 } },
      { type: "host.note", key: "n1", data: { total: 12345678 } },
    ],
    setLimits: { maxCostMicros: 12345678, maxToolCalls: null, maxTurns: null, allowUnpriced: false },
  });
  const records = await raw.readJournal(run.id, { afterSeq: 1 });
  assert.deepEqual(records.map((r) => r.data), [
    { limits: { maxCostMicros: 12345678 }, note: "cap [redacted]" },
    { args: { pin: "[redacted]", "[redacted]": "pin [redacted]" } },
    { data: { echo: "[redacted]" }, durationMs: 12345678 },
    { total: "[redacted]" },
  ]);
  assert.equal(typeof (records[0]!.data["limits"] as Record<string, unknown>)["maxCostMicros"], "number");
  assert.equal((await raw.getRun(run.id))?.limits.maxCostMicros, 12345678);
  const created = (await raw.readJournal(run.id)).find((r) => r.type === "run.created");
  assert.deepEqual((created?.data["input"] as Record<string, unknown>)["data"], { credential: "[redacted]", nested: ["[redacted]", 42] });
  assert.equal((created?.data["limits"] as Record<string, unknown>)["maxCostMicros"], 12345678);
});

test("a pending's expiresAt and the run's wakeAt stay numbers at rest although their digits hold a numeric secret", async (t) => {
  const { store: raw, path } = await openTestStore(t);
  const secrets = await createSecretsService({ store: raw, sealKey: generateSealKey() });
  await secrets.set("PIN", "89012345");
  const store = redactingStore(raw, createWriteRedaction(secrets));
  await raw.saveAgent({ id: "agent-d", definition: testAgentDefinition({ secrets: ["PIN"] }) });
  const expiresAt = 1789012345678;
  assert.ok(String(expiresAt).includes("89012345"), "the instant's digits contain the secret");
  const { run } = await store.createRun({ agentId: "agent-d", input: { message: "go", data: {} } });
  const [claimed] = await store.claimRuns({ runnerId: "r1", limit: 1, leaseMs: 60_000 });
  const detail = { tool: "write_file", args: { pin: 89012345 }, expiresAt };
  await store.commit(claimed!.lease, {
    records: [{ type: "pending.opened", key: "t1.c1", data: { pending: { id: "pnd_d", kind: "approval", stepKey: "t1.c1", title: "Approve", detail } } }],
    openPendings: [{ id: "pnd_d", kind: "approval", stepKey: "t1.c1", title: "Approve", detail }],
    transition: { to: "waiting", wakeAt: expiresAt },
  });

  const opened = (await raw.readJournal(run.id)).find((record) => record.type === "pending.opened");
  const journalled = (opened?.data["pending"] as { detail: Record<string, unknown> }).detail;
  assert.deepEqual(journalled, { tool: "write_file", args: { pin: "[redacted]" }, expiresAt }, "the journal keeps the instant a number");
  const pending = await raw.getPending("pnd_d");
  assert.deepEqual(pending?.detail, { tool: "write_file", args: { pin: "[redacted]" }, expiresAt }, "the pendings table keeps it a number");
  assert.equal(typeof pending?.detail["expiresAt"], "number");
  assert.deepEqual(columnValues(path, "SELECT wake_at FROM runs WHERE id = ?", run.id), [String(expiresAt)], "wakeAt reached the store");
});

test("a limits command keeps its numbers; its free text is redacted elsewhere", async (t) => {
  const { store: raw } = await openTestStore(t);
  const secrets = await createSecretsService({ store: raw, sealKey: generateSealKey() });
  await secrets.set("PIN", "12345678");
  const redaction = createWriteRedaction(secrets);
  const definition = testAgentDefinition({ secrets: ["PIN"] });
  const command: RunCommand = { type: "limits", limits: { maxCostMicros: 12345678 } };
  assert.deepEqual(await redaction.command(definition, command), command);
  assert.deepEqual(secrets.redactPayload({ n: 12345678, s: "12345678", k: 42 }), { n: "[redacted]", s: "[redacted]", k: 42 });
  assert.deepEqual(secrets.redactJson({ n: 12345678, s: "12345678" }), { n: 12345678, s: "[redacted]" });
});

test("batch() walks a record by its declared fields: a secret equal to a declared name keeps the key; without fields it does not", async (t) => {
  const { redaction, secrets } = await setup(t);
  await secrets.set("WORD", "promptSection");
  const value = { promptSection: `the promptSection holds ${VALUE}`, given: [{ itemId: "li_1", version: 3 }] };
  const spec = fieldObject({ promptSection: "text", given: fieldList(fieldObject({ itemId: "keep", version: "keep" })) });
  const fields = recordFieldsWith("step.finished", "value", spec);
  const out = redaction.batch({
    records: [
      { type: "step.finished", key: "learning/given", data: { name: "learning.given", value }, fields },
      { type: "step.finished", key: "host", data: { name: "host.step", value } },
    ],
  });
  const [declared, host] = out.records;
  assert.equal(declared?.fields, fields, "the record keeps its fields");
  assert.deepEqual(declared?.data["value"], { promptSection: `the ${PLACEHOLDER} holds ${PLACEHOLDER}`, given: [{ itemId: "li_1", version: 3 }] });
  assert.equal(Object.hasOwn(host ?? {}, "fields"), false);
  assert.deepEqual(host?.data["value"], { [PLACEHOLDER]: `the ${PLACEHOLDER} holds ${PLACEHOLDER}`, given: [{ itemId: "li_1", version: 3 }] });
  assertClean(JSON.stringify(out), "the batch");
});
