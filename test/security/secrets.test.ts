import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { RunwrightError } from "../../src/core/errors.ts";
import { secretForms } from "../../src/core/redact.ts";
import { createLogger } from "../../src/log/logger.ts";
import { generateSealKey, seal } from "../../src/security/seal.ts";
import { createSecretsService, REDACTED_MARKER } from "../../src/security/secrets.ts";
import type { SecretsService } from "../../src/security/types.ts";
import { createWriteRedaction, redactingStore } from "../../src/security/write-redaction.ts";
import type { CommitBatch, Store } from "../../src/store/types.ts";
import { openTestStore, testAgentDefinition } from "../helpers/store.ts";

const VALUE = "sk-live-0123456789abcdef";

test("set, status, list, reveal and delete; values never appear in status or list", async (t) => {
  const { store } = await openTestStore(t);
  const secrets = await createSecretsService({ store, sealKey: generateSealKey() });

  assert.deepEqual(await secrets.status("API_KEY"), { name: "API_KEY", set: false, updatedAt: null });
  const status = await secrets.set("API_KEY", VALUE);
  assert.equal(status.name, "API_KEY");
  assert.equal(status.set, true);
  assert.equal(typeof status.updatedAt, "number");
  await secrets.set("OTHER_ONE", "another-secret-value");

  const listed = await secrets.list();
  assert.deepEqual(listed.map((s) => s.name), ["API_KEY", "OTHER_ONE"]);
  assert.ok(listed.every((s) => s.set && typeof s.updatedAt === "number"));
  const shown = JSON.stringify([listed, await secrets.status("API_KEY"), status]);
  assert.ok(!shown.includes(VALUE));
  assert.ok(!shown.includes("another-secret-value"));

  const stored = await store.getSecret("API_KEY");
  assert.ok(stored !== null);
  assert.ok(!Buffer.from(stored.sealed).toString("latin1").includes(VALUE), "the store holds only sealed bytes");

  assert.deepEqual(await secrets.reveal(["API_KEY", "MISSING", "API_KEY"]), { API_KEY: VALUE });
  assert.equal(await secrets.delete("API_KEY"), true);
  assert.equal(await secrets.delete("API_KEY"), false);
  assert.deepEqual(await secrets.reveal(["API_KEY"]), {});
  assert.equal((await secrets.status("API_KEY")).set, false);
});

test("validation rejects bad names and sizes without echoing the value", async (t) => {
  const { store } = await openTestStore(t);
  const secrets = await createSecretsService({ store, sealKey: generateSealKey() });
  const cases: [string, string][] = [
    ["lower_case", VALUE], ["1STARTS_WITH_DIGIT", VALUE], ["", VALUE], ["A".repeat(65), VALUE], ["HAS-DASH", VALUE],
    ["SHORT", "1234567"], ["HUGE", "x".repeat(16_385)],
  ];
  for (const [name, value] of cases) {
    await assert.rejects(secrets.set(name, value), (error: unknown) => {
      assert.ok(error instanceof RunwrightError);
      assert.equal(error.code, "validation_failed");
      assert.ok(!error.message.includes(value));
      assert.ok(!JSON.stringify(error.details).includes(value));
      return true;
    });
  }
  await secrets.set("EXACTLY_MIN", "12345678");
  await secrets.set("EXACTLY_MAX", "y".repeat(16_384));
  assert.equal((await secrets.list()).length, 2);
});

test("redactText covers set, revealed, deleted, preloaded and extra values in every encoding", async (t) => {
  const { store } = await openTestStore(t);
  const sealKey = generateSealKey();
  await store.putSecret("PRELOADED", seal(sealKey, "PRELOADED", "preloaded-secret/value+="));
  const token = "api-token-abcdefghijklmnop";
  const secrets = await createSecretsService({ store, sealKey, alsoRedact: [token] });

  const preloaded = "preloaded-secret/value+=";
  assert.equal(secrets.redactText(`a ${preloaded} b`), "a [redacted] b");
  assert.equal(secrets.redactText(`Bearer ${token}`), "Bearer [redacted]");

  await secrets.set("SET_ONE", VALUE);
  const forms = [
    VALUE,
    Buffer.from(VALUE).toString("base64"),
    Buffer.from(VALUE).toString("base64url"),
    encodeURIComponent(preloaded),
    Buffer.from(preloaded).toString("base64").replace(/=+$/, ""),
  ];
  for (const form of forms) {
    const out = secrets.redactText(`x=${form};`);
    assert.ok(!out.includes(form), `form ${form} leaked`);
    assert.match(out, /\[redacted\]/);
  }

  await secrets.delete("SET_ONE");
  assert.equal(secrets.redactText(`still ${VALUE}`), "still [redacted]");

  const other = await createSecretsService({ store, sealKey });
  await store.putSecret("LATER", seal(sealKey, "LATER", "added-by-another-process"));
  assert.equal(other.redactText("added-by-another-process"), "added-by-another-process");
  await other.reveal(["LATER"]);
  assert.equal(other.redactText("added-by-another-process"), "[redacted]");
  assert.equal(other.redactText("nothing to hide here"), "nothing to hide here");
});

test("an unreadable blob does not stop start-up; it is listed as set and reveal names it", async (t) => {
  const { store } = await openTestStore(t);
  const sealKey = generateSealKey();
  await store.putSecret("BROKEN", seal(generateSealKey(), "BROKEN", "sealed-under-another-key"));
  await store.putSecret("GOOD", seal(sealKey, "GOOD", "good-secret-value"));
  const secrets = await createSecretsService({ store, sealKey });
  assert.deepEqual((await secrets.list()).map((s) => [s.name, s.set]), [["BROKEN", true], ["GOOD", true]]);
  assert.equal(secrets.redactText("good-secret-value"), "[redacted]");
  await assert.rejects(secrets.reveal(["BROKEN"]), (error: unknown) => {
    assert.ok(error instanceof RunwrightError);
    assert.equal(error.code, "seal_failed");
    assert.match(error.message, /BROKEN/);
    assert.ok(!error.message.includes("sealed-under-another-key"));
    return true;
  });
});

function everyForm(value: string): string[] {
  const bytes = Buffer.from(value, "utf8");
  const base64 = bytes.toString("base64");
  return [value, base64, base64.replace(/=+$/, ""), bytes.toString("base64url"), encodeURIComponent(value), JSON.stringify(value).slice(1, -1)];
}

test("a multibyte secret of 4 characters and 12 bytes is accepted and hidden in every form; 7 bytes is rejected", async (t) => {
  const { store } = await openTestStore(t);
  const secrets = await createSecretsService({ store, sealKey: generateSealKey() });
  const value = "秘密口令";
  assert.equal(value.length, 4);
  await secrets.set("PASSPHRASE", value);
  for (const form of everyForm(value)) {
    assert.equal(secrets.redactText(`<${form}>`), "<[redacted]>", `form ${form}`);
  }
  assert.equal(secrets.redactText(value), "[redacted]");
  await secrets.set("EIGHT_BYTES", "é".repeat(4));
  assert.equal(secrets.redactText("x éééé y"), "x [redacted] y");
  for (const short of ["ééé" + "a", "秘密" + "a"]) {
    assert.equal(Buffer.byteLength(short, "utf8"), 7);
    await assert.rejects(secrets.set("SEVEN_BYTES", short), (error: unknown) => {
      assert.ok(error instanceof RunwrightError);
      assert.equal(error.code, "validation_failed");
      return true;
    });
  }
  assert.equal((await secrets.status("SEVEN_BYTES")).set, false);
});

test("a multi-line secret is hidden inside serialized JSON", async (t) => {
  const { store } = await openTestStore(t);
  const secrets = await createSecretsService({ store, sealKey: generateSealKey() });
  const pem = "-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBgkqhkiG9w0BAQEFAASC\n\"quoted\" \\ back\n-----END PRIVATE KEY-----\n";
  await secrets.set("PEM_KEY", pem);
  const line = secrets.redactText(JSON.stringify({ level: "info", message: `loaded ${pem} ok`, nested: { pem } }));
  assert.equal(line.includes(pem), false);
  assert.equal(line.includes(JSON.stringify(pem).slice(1, -1)), false);
  assert.deepEqual(JSON.parse(line), { level: "info", message: "loaded [redacted] ok", nested: { pem: "[redacted]" } });
});

test("secrets present before start-up and extra values follow the same byte rule", async (t) => {
  const { store } = await openTestStore(t);
  const sealKey = generateSealKey();
  await store.putSecret("PRELOADED", seal(sealKey, "PRELOADED", "秘密口令"));
  await store.putSecret("QUOTED", seal(sealKey, "QUOTED", 'a"b\\c\nd-value'));
  const secrets = await createSecretsService({ store, sealKey, alsoRedact: ["éééé", "ééé" + "a"] });
  assert.equal(secrets.redactText("[秘密口令]"), "[[redacted]]");
  assert.equal(secrets.redactText(Buffer.from("秘密口令").toString("base64")), "[redacted]");
  assert.equal(secrets.redactText(JSON.stringify({ v: 'a"b\\c\nd-value' })), '{"v":"[redacted]"}');
  assert.equal(secrets.redactText("token éééé"), "token [redacted]");
  assert.equal(secrets.redactText("short ééé" + "a"), "short ééé" + "a");
});

test("redactPayload: a number holding a secret becomes the placeholder; redactJson keeps numbers; nothing known changes nothing", async (t) => {
  const { store } = await openTestStore(t);
  const secrets = await createSecretsService({ store, sealKey: generateSealKey() });
  const value = { pin: 12345678, list: [912345678, 7], text: "12345678" };
  assert.equal(secrets.redactPayload(value), value, "with no secret known the value itself comes back");
  await secrets.set("PIN", "12345678");
  assert.deepEqual(secrets.redactPayload(value), { pin: "[redacted]", list: ["9[redacted]", 7], text: "[redacted]" });
  assert.deepEqual(secrets.redactJson(value), { pin: 12345678, list: [912345678, 7], text: "[redacted]" });
  assert.equal(secrets.redactPayload(12345678), "[redacted]");
});

// ---------------------------------------------------------------- retired values (R14D-spec-01)

const OLD = "rotated/away value+0001";
const NEW = "rotated~in/value=0002";
const NEWER = "rotated-in-value-0003";

/** A store with agent "a" and one run of it left `waiting` (unfinished), created at the store clock's now. */
async function storeWithUnfinishedRun(t: TestContext): Promise<{ store: Store; runId: string; finish: () => Promise<void> }> {
  const { store } = await openTestStore(t);
  await store.saveAgent({ id: "a", definition: testAgentDefinition() });
  const { run } = await store.createRun({ agentId: "a", input: { message: "go", data: null } });
  const [claimed] = await store.claimRuns({ runnerId: "r", limit: 1, leaseMs: 600_000 });
  assert.equal(claimed?.run.id, run.id);
  await store.commit((claimed as NonNullable<typeof claimed>).lease, { records: [{ type: "run.note", data: {} }], transition: { to: "waiting" } });
  const finish = async (): Promise<void> => {
    await store.enqueueCommand(run.id, { type: "cancel", reason: null });
    const [again] = await store.claimRuns({ runnerId: "r", limit: 1, leaseMs: 600_000 });
    assert.equal(again?.run.id, run.id);
    const commands = (await store.listCommands(run.id, { unconsumedOnly: true })).map((c) => c.id);
    await store.commit((again as NonNullable<typeof again>).lease, {
      records: [{ type: "run.cancelled", data: {} }], transition: { to: "cancelled" }, consumeCommands: commands,
    });
  };
  return { store, runId: run.id, finish };
}

/** Each form `secretForms` lists, inside other text, must come out as the generic marker. */
function assertHidden(secrets: SecretsService, value: string, label: string): void {
  const forms = secretForms(value);
  assert.ok(forms.length >= 3, `${label}: the vocabulary lists the encodings`);
  for (const form of forms) {
    const out = secrets.redactText(`before ${form} after`);
    assert.equal(out, `before ${REDACTED_MARKER} after`, `${label}: form ${form}`);
  }
}

/** Sets OLD under K a moment before the run is created, so the run may have been handed it. */
async function rotatedBeforeRestart(t: TestContext, sealKey: Uint8Array) {
  const { store } = await openTestStore(t);
  await store.saveAgent({ id: "a", definition: testAgentDefinition() });
  const first = await createSecretsService({ store, sealKey });
  await first.set("K", OLD);
  const { run } = await store.createRun({ agentId: "a", input: { message: "go", data: null } });
  return { store, first, runId: run.id };
}

test("S1: after set A, set B and a restart, A and B are both hidden in every form while an older run is unfinished", async (t) => {
  const sealKey = generateSealKey();
  const { store, first } = await rotatedBeforeRestart(t, sealKey);
  await first.set("K", NEW);
  const restarted = await createSecretsService({ store, sealKey });
  assertHidden(restarted, OLD, "the replaced value");
  assertHidden(restarted, NEW, "the current value");
  assert.equal(restarted.redactText(`${OLD}/${NEW}`), "[redacted]/[redacted]");
  assert.deepEqual(restarted.redactPayload({ [OLD]: [OLD] }), { "[redacted]": ["[redacted]"] });
});

test("S2: setting the same value again creates no retired value", async (t) => {
  const { store } = await storeWithUnfinishedRun(t);
  const secrets = await createSecretsService({ store, sealKey: generateSealKey() });
  await secrets.set("K", OLD);
  const before = await store.getSecret("K");
  await secrets.set("K", OLD);
  assert.deepEqual(await store.listRetiredSecrets(), [], "no history row for an unchanged value");
  assert.deepEqual((await store.getSecret("K"))?.sealed, before?.sealed, "the sealed bytes are kept");
  await secrets.set("K", NEW);
  assert.equal((await store.listRetiredSecrets("K")).length, 1, "a different value is retired");
});

test("S2b: a current blob this process cannot unseal counts as different and is retired by a set", async (t) => {
  const { store } = await storeWithUnfinishedRun(t);
  await store.putSecret("K", seal(generateSealKey(), "K", OLD));
  const secrets = await createSecretsService({ store, sealKey: generateSealKey() });
  await secrets.set("K", OLD);
  assert.equal((await store.listRetiredSecrets("K")).length, 1);
  assert.deepEqual(await secrets.reveal(["K"]), { K: OLD });
});

test("S3: a second process that started before the rotation learns the retired value when it reveals the name", async (t) => {
  const sealKey = generateSealKey();
  const { store } = await openTestStore(t);
  await store.saveAgent({ id: "a", definition: testAgentDefinition() });
  const second = await createSecretsService({ store, sealKey });
  const first = await createSecretsService({ store, sealKey });
  await first.set("K", OLD);
  await store.createRun({ agentId: "a", input: { message: "go", data: null } });
  await first.set("K", NEW);
  assert.equal(second.redactText(OLD), OLD, "the second process has not read K yet");
  assert.deepEqual(await second.reveal(["K"]), { K: NEW }, "reveal returns only the current value");
  assertHidden(second, OLD, "the retired value");
  assertHidden(second, NEW, "the current value");

  await first.delete("K");
  const third = await createSecretsService({ store, sealKey: generateSealKey() });
  assert.deepEqual(await third.reveal(["K"]), {}, "a deleted name reveals nothing");
  assert.equal(third.redactText(NEW), NEW, "another seal key cannot read the retired values");
  const fourth = await createSecretsService({ store, sealKey });
  assert.deepEqual(await fourth.list(), [], "K is deleted");
  assert.equal(fourth.redactText(`${OLD} ${NEW}`), "[redacted] [redacted]", "start-up loads the values the set and the delete retired");
  const late = await createSecretsService({ store, sealKey });
  await store.putSecret("K", seal(sealKey, "K", NEWER));
  await late.reveal(["K"]);
  assert.equal(late.redactText(`${OLD} ${NEW} ${NEWER}`), "[redacted] [redacted] [redacted]");
});

test("S3b: reveal learns the retired values of a name even when its current blob does not unseal", async (t) => {
  const sealKey = generateSealKey();
  const { store } = await openTestStore(t);
  await store.saveAgent({ id: "a", definition: testAgentDefinition() });
  const other = await createSecretsService({ store, sealKey });
  const first = await createSecretsService({ store, sealKey });
  await first.set("K", OLD);
  await store.createRun({ agentId: "a", input: { message: "go", data: null } });
  await store.putSecret("K", seal(generateSealKey(), "K", NEW));
  await assert.rejects(other.reveal(["K"]), (error: unknown) => error instanceof RunwrightError && error.code === "seal_failed");
  assert.equal(other.redactText(OLD), "[redacted]");
});

test("S4: a logger built on the restarted service does not print the replaced value", async (t) => {
  const sealKey = generateSealKey();
  const { store, first } = await rotatedBeforeRestart(t, sealKey);
  await first.set("K", NEW);
  const restarted = await createSecretsService({ store, sealKey });
  const lines: string[] = [];
  const logger = createLogger({ level: "debug", write: (line) => lines.push(line), redact: (text) => restarted.redactText(text) });
  logger.info(`tool said ${OLD}`, { result: OLD, nested: { [OLD]: Buffer.from(OLD).toString("base64") } });
  logger.error("failed", { error: { message: `bad ${encodeURIComponent(OLD)}` } });
  assert.equal(lines.length, 2);
  for (const line of lines) for (const form of secretForms(OLD)) assert.ok(!line.includes(form), `log line holds ${form}: ${line}`);
  assert.match(lines[0] as string, /tool said \[redacted\]/);
});

test("S5: intake redaction over the restarted service hides the replaced value in text and commands", async (t) => {
  const sealKey = generateSealKey();
  const { store, first, runId } = await rotatedBeforeRestart(t, sealKey);
  await first.set("K", NEW);
  const restarted = await createSecretsService({ store, sealKey });
  const intake = createWriteRedaction(restarted);
  const definition = testAgentDefinition({ secrets: ["K"] });
  assert.equal(await intake.text(`it is ${OLD}`), "it is [redacted]");
  assert.equal(await intake.text(`it is ${OLD}`, definition), "it is [redacted]");
  assert.deepEqual(await intake.command(definition, { type: "answer", pendingId: "p", answer: `the old one: ${OLD}` }),
    { type: "answer", pendingId: "p", answer: "the old one: [redacted]" });
  assert.deepEqual(await intake.command(definition, { type: "message", text: Buffer.from(OLD).toString("base64url") }),
    { type: "message", text: "[redacted]" });
  const wrapped = redactingStore(store, intake);
  await wrapped.enqueueCommand(runId, { type: "message", text: `remember ${OLD}` });
  const [stored] = await store.listCommands(runId);
  assert.deepEqual(stored?.command, { type: "message", text: "remember [redacted]" });
});

test("S6: list and status are unchanged and no method returns a retired value", async (t) => {
  const sealKey = generateSealKey();
  const { store, first } = await rotatedBeforeRestart(t, sealKey);
  await first.set("K", NEW);
  await first.set("GONE", NEWER);
  await first.delete("GONE");
  const restarted = await createSecretsService({ store, sealKey });
  const listed = await restarted.list();
  assert.deepEqual(listed.map((s) => [s.name, s.set]), [["K", true]]);
  assert.deepEqual(Object.keys(listed[0] as object).sort(), ["name", "set", "updatedAt"]);
  assert.deepEqual(await restarted.status("GONE"), { name: "GONE", set: false, updatedAt: null });
  const revealed = await restarted.reveal(["K", "GONE"]);
  assert.deepEqual(revealed, { K: NEW });
  const shown = JSON.stringify([listed, await restarted.status("K"), await restarted.status("GONE"), revealed]);
  assert.ok(!shown.includes(OLD) && !shown.includes(NEWER), "no retired value is returned");
  for (const retired of await store.listRetiredSecrets()) {
    assert.ok(!Buffer.from(retired.sealed).toString("latin1").includes(OLD), "retired values are stored sealed");
  }
});

test("S7: once the older run finishes, the next set, delete or start-up prunes the row; the running process keeps redacting", async (t) => {
  const sealKey = generateSealKey();
  for (const next of ["set", "delete", "start-up"] as const) {
    const { store, finish } = await storeWithUnfinishedRun(t);
    const secrets = await createSecretsService({ store, sealKey });
    await secrets.set("K", OLD);
    // The unfinished run was created before OLD existed: OLD's retirement must still be kept for it.
    await secrets.set("K", NEW);
    assert.equal((await store.listRetiredSecrets()).length, 1, `${next}: kept while the run is unfinished`);
    await createSecretsService({ store, sealKey });
    assert.equal((await store.listRetiredSecrets()).length, 1, `${next}: a start-up keeps it too`);
    await finish();
    assert.equal((await store.listRetiredSecrets()).length, 1, `${next}: nothing prunes by itself`);
    if (next === "set") await secrets.set("OTHER", NEWER);
    else if (next === "delete") await secrets.delete("OTHER");
    else await createSecretsService({ store, sealKey });
    assert.deepEqual(await store.listRetiredSecrets(), [], `${next}: pruned`);
    assert.equal(secrets.redactText(OLD), "[redacted]", `${next}: this process's set only grows`);
    const fresh = await createSecretsService({ store, sealKey });
    assert.equal(fresh.redactText(OLD), OLD, `${next}: after pruning a new process no longer knows the value`);
  }
});

test("S8: every part of a commit batch written after the restart hides the replaced value: records, output, error, pendings, learning", async (t) => {
  const sealKey = generateSealKey();
  const { store, first } = await rotatedBeforeRestart(t, sealKey);
  await first.set("K", NEW);
  const restarted = await createSecretsService({ store, sealKey });
  const b64 = Buffer.from(OLD).toString("base64");
  const batch = createWriteRedaction(restarted).batch({
    records: [
      { type: "tool.finished", key: "turn/1/tool/0", data: { callId: "c", tool: "t", outcome: "ok", content: `read ${OLD}`, data: { v: OLD }, isError: false } },
      { type: "model.finished", key: "turn/2", data: { text: `said ${b64}`, output: { [OLD]: OLD } } },
      { type: "host.custom", data: { anything: encodeURIComponent(OLD) } },
    ],
    openPendings: [{ kind: "question", stepKey: "q", title: `about ${OLD}`, detail: { question: `is it ${OLD}?` } }],
    resolvePendings: [{ id: "p_1", resolution: { answer: OLD } }],
    transition: { to: "failed", output: { result: OLD }, error: { code: "tool_failed", message: `failed with ${OLD}` } },
    learning: {
      puts: [{ id: "li_1", kind: "note", name: "n", title: `T ${OLD}`, description: `D ${OLD}`, body: `B ${OLD}`, status: "active", expectedVersion: null, note: `N ${OLD}` }],
      promotions: [{ itemId: "li_2", expectedVersion: 1, workflow: null, note: `rejected: ${OLD}` }],
    },
  } as unknown as CommitBatch);
  const text = JSON.stringify(batch);
  for (const form of secretForms(OLD)) assert.ok(!text.includes(form), `the batch holds ${form}: ${text}`);
  assert.equal(batch.transition?.error?.message, "failed with [redacted]");
  assert.equal(batch.openPendings?.[0]?.title, "about [redacted]");
  assert.equal(batch.learning?.puts?.[0]?.body, "B [redacted]");
  assert.equal(batch.learning?.promotions?.[0]?.note, "rejected: [redacted]");
});
