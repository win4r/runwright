/**
 * redactCommitBatch: every part of a commit, and journal records field by field over RECORD_FIELDS (rule F).
 * Finding R11-02: a field's mode was looked up in the output of an earlier redaction, so a secret equal to a field
 * name hid a payload path (a numeric secret below it was stored in plaintext) and rewrote the engine's own words.
 * Finding R12-02: a record that carries a declared specification (`fields`) is redacted by it in every pass, and a
 * record without one is redacted exactly as before.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { Json, JsonObject } from "../../src/core/json.ts";
import { createRedactor, type Redactor } from "../../src/core/redact.ts";
import type { JournalType } from "../../src/engine/journal-types.ts";
import { redactCommitBatch, type BatchRedactor } from "../../src/store/batch-redaction.ts";
import { RECORD_FIELDS, fieldList, fieldObject, recordFieldsWith, unlistedPaths, type FieldSpec } from "../../src/store/record-fields.ts";
import type { CommitBatch } from "../../src/store/types.ts";
import type { WorkflowDocument } from "../../src/workflow/types.ts";
import { generateSealKey } from "../../src/security/seal.ts";
import { createSecretsService } from "../../src/security/secrets.ts";
import { createWriteRedaction, type WriteRedaction } from "../../src/security/write-redaction.ts";
import { openTestStore } from "../helpers/store.ts";

const S = "SECRET-VALUE";
const R = "[gone]";

/** Replaces S in every string and object key of a JSON value (no number holds S). */
function replaceS(value: Json): Json {
  if (typeof value === "string") return value.replaceAll(S, R);
  if (Array.isArray(value)) return value.map(replaceS);
  if (value !== null && typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const [k, item] of Object.entries(value)) out[k.replaceAll(S, R)] = replaceS(item as Json);
    return out;
  }
  return value;
}

/** Replaces S in text, and in every string and object key of a JSON value, in both modes. */
const redactor: BatchRedactor = {
  text: (value) => value.replaceAll(S, R),
  json: <T extends Json>(value: T): T => replaceS(value) as T,
  payload: replaceS,
};

const document = {
  format: "runwright.workflow/v1", name: `flow-${S}`, schemas: { In: { type: "object" }, Out: { type: "string" } },
  input: "In", output: "Out", root: { id: "run", kind: "tool", tool: "shell", args: { command: `echo ${S}`, [S]: 1 } },
  result: { $ref: "steps.run.content" },
} as unknown as WorkflowDocument;

function fullBatch(): CommitBatch {
  return {
    records: [
      { type: `t-${S}`, key: `k-${S}`, data: { text: `a ${S}`, [S]: [S, { deep: S }], n: 1 } },
      { type: "tool.finished", key: `k-${S}`, data: { callId: `c-${S}`, tool: S, outcome: "ok", content: `a ${S}`, data: { [S]: S }, durationMs: 1, [S]: S } },
    ],
    transition: { to: "failed", output: { result: S }, error: { code: `code-${S}`, message: `boom ${S}` } },
    openPendings: [{ id: `pnd_${S}`, kind: "question", stepKey: `step-${S}`, title: `ask ${S}`, detail: { question: S, [S]: S } }],
    resolvePendings: [{ id: `pnd_${S}`, resolution: { answer: S, [S]: S } }],
    usage: [{ model: `m-${S}`, purpose: "run", inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 3, assumed: false }],
    counters: { turns: 1, toolCalls: 2 },
    setLimits: { maxCostMicros: 5, maxToolCalls: null, maxTurns: null, allowUnpriced: false },
    consumeCommands: [`cmd_${S}`],
    learning: {
      puts: [
        { id: `li_${S}`, kind: "note", name: `name-${S}`, title: `T ${S}`, description: `D ${S}`, body: `B ${S}`, status: "active", expectedVersion: null, note: `N ${S}` },
        { id: "li_2", kind: "skill", name: "n2", title: "t", description: "d", body: "b", status: "held", expectedVersion: 3 },
      ],
      given: [{ itemId: `li_${S}`, version: 1, mode: "full" }],
      opened: [`li_${S}`],
      promotions: [
        { itemId: `li_${S}`, expectedVersion: 1, workflow: { name: `wf-${S}`, document }, note: `P ${S}` },
        { itemId: "li_3", expectedVersion: 2, workflow: null, note: `rejected ${S}` },
      ],
    },
  };
}

test("every listed part is redacted: a host record whole, an engine record field by field, unlisted keys with their values", () => {
  const out = redactCommitBatch(fullBatch(), redactor);
  assert.deepEqual(out.records, [
    { type: `t-${S}`, key: `k-${S}`, data: { text: `a ${R}`, [R]: [R, { deep: R }], n: 1 } },
    { type: "tool.finished", key: `k-${S}`, data: { callId: `c-${R}`, tool: R, outcome: "ok", content: `a ${R}`, data: { [R]: R }, durationMs: 1, [R]: R } },
  ]);
  assert.deepEqual(out.transition, { to: "failed", output: { result: R }, error: { code: `code-${S}`, message: `boom ${R}` } });
  assert.deepEqual(out.openPendings, [{ id: `pnd_${S}`, kind: "question", stepKey: `step-${S}`, title: `ask ${R}`, detail: { question: R, [R]: R } }]);
  assert.deepEqual(out.resolvePendings, [{ id: `pnd_${S}`, resolution: { answer: R, [R]: R } }]);
  const [put, plain] = out.learning?.puts ?? [];
  assert.deepEqual(put, { id: `li_${S}`, kind: "note", name: `name-${S}`, title: `T ${R}`, description: `D ${R}`, body: `B ${R}`, status: "active", expectedVersion: null, note: `N ${R}` });
  assert.deepEqual(plain, fullBatch().learning?.puts?.[1]);
  assert.ok(!Object.hasOwn(plain as object, "note"), "an absent note stays absent");
  const [kept, rejected] = out.learning?.promotions ?? [];
  assert.equal(kept?.note, `P ${R}`);
  assert.equal(kept?.itemId, `li_${S}`);
  assert.equal(kept?.workflow?.name, `wf-${S}`, "names are not touched");
  const doc = kept?.workflow?.document as unknown as { name: string; root: { args: Record<string, unknown> } };
  assert.equal(doc.name, `flow-${R}`, "the document is JSON: every string in it");
  assert.deepEqual(doc.root.args, { command: `echo ${R}`, [R]: 1 });
  assert.deepEqual(rejected, { itemId: "li_3", expectedVersion: 2, workflow: null, note: `rejected ${R}` });
});

test("untouched parts are identical: usage, counters, setLimits, consumeCommands, given, opened", () => {
  const batch = fullBatch();
  const out = redactCommitBatch(batch, redactor);
  assert.equal(out.usage, batch.usage);
  assert.equal(out.counters, batch.counters);
  assert.equal(out.setLimits, batch.setLimits);
  assert.equal(out.consumeCommands, batch.consumeCommands);
  assert.equal(out.learning?.given, batch.learning?.given);
  assert.equal(out.learning?.opened, batch.learning?.opened);
});

test("absent optional parts stay absent", () => {
  const out = redactCommitBatch({ records: [] }, redactor);
  assert.deepEqual(out, { records: [] });
  assert.deepEqual(Object.keys(out), ["records"]);
  const transition = redactCommitBatch({ records: [], transition: { to: "running" } }, redactor).transition;
  assert.deepEqual(transition, { to: "running" });
  assert.deepEqual(Object.keys(transition ?? {}), ["to"]);
  const learning = redactCommitBatch({ records: [], learning: { opened: ["li_1"] } }, redactor).learning;
  assert.deepEqual(learning, { opened: ["li_1"] });
});

test("a null note or a null workflow coming from data is kept as it is", () => {
  const batch = {
    records: [],
    learning: {
      puts: [{ id: "li_1", kind: "note", name: "n", title: S, description: "d", body: "b", status: "active", expectedVersion: null, note: null }],
      promotions: [{ itemId: "li_1", expectedVersion: 1, note: S }],
    },
  } as unknown as CommitBatch;
  const out = redactCommitBatch(batch, redactor);
  assert.equal(out.learning?.puts?.[0]?.note, null);
  assert.equal(out.learning?.puts?.[0]?.title, R);
  assert.ok(!Object.hasOwn(out.learning?.promotions?.[0] as object, "workflow"));
  assert.equal(out.learning?.promotions?.[0]?.note, R);
});

test("the input batch is not mutated", () => {
  const batch = fullBatch();
  const copy = structuredClone(batch);
  const out = redactCommitBatch(batch, redactor);
  assert.deepEqual(batch, copy);
  assert.notEqual(out, batch);
  assert.notEqual(out.records[0], batch.records[0]);
  assert.notEqual(out.records[1]?.data, batch.records[1]?.data);
  assert.notEqual(out.transition, batch.transition);
  assert.notEqual(out.learning, batch.learning);
});

async function secretsWith(t: TestContext, values: Record<string, string>): Promise<WriteRedaction> {
  const { store } = await openTestStore(t);
  const secrets = await createSecretsService({ store, sealKey: generateSealKey() });
  for (const [name, value] of Object.entries(values)) await secrets.set(name, value);
  return createWriteRedaction(secrets);
}

test("with the secrets service's redaction a numeric secret in a payload field is the placeholder; engine numbers stay numbers", async (t) => {
  const out = (await secretsWith(t, { PIN: "12345678" })).batch({
    records: [
      { type: "limits.changed", data: { limits: { maxCostMicros: 12345678 }, why: "raised to 12345678" } },
      { type: "tool.started", key: "t1.c1", data: { args: { pin: 12345678, "12345678": "x" } } },
    ],
    setLimits: { maxCostMicros: 12345678, maxToolCalls: null, maxTurns: null, allowUnpriced: false },
    transition: { to: "completed", output: { total: 12345678, label: "12345678" } },
  });
  assert.deepEqual(out.records.map((r) => r.data), [
    { limits: { maxCostMicros: 12345678 }, why: "raised to [redacted]" },
    { args: { pin: "[redacted]", "[redacted]": "x" } },
  ]);
  assert.equal(out.setLimits?.maxCostMicros, 12345678);
  assert.deepEqual(out.transition?.output, { total: "[redacted]", label: "[redacted]" });
});

// ---------------------------------------------------------------- the reviewer's probe (R11-02)

const N = 12345678;
const DIGITS = "12345678";
const P = "[redacted:PIN]";

function probeBatch(): CommitBatch {
  return {
    records: [
      {
        type: "model.finished", data: {
          model: "m", purpose: "run", text: "", toolCalls: [{ id: "1", name: "x", args: { credential: N } }],
          output: null, stopReason: "tool_use", usage: {}, costMicros: 1, durationMs: 1,
        },
      },
      { type: "pending.opened", data: { pending: { id: "p", kind: "question", stepKey: "k", title: "t", detail: { question: "q", choices: [] } } } },
    ],
  };
}

test("the reviewer's probe: a secret named like a field hides nothing and rewrites no engine word", () => {
  const r = createRedactor({ A: "toolCalls", B: DIGITS, C: "tool_use", D: "question" });
  const [finished, opened] = redactCommitBatch(probeBatch(), r).records.map((record) => record.data as Record<string, unknown>);
  assert.ok(finished !== undefined && opened !== undefined);
  assert.ok(Object.hasOwn(finished, "toolCalls"), "the key toolCalls is still there");
  assert.ok(!Object.hasOwn(finished, "[redacted:A]"));
  assert.deepEqual(finished["toolCalls"], [{ id: "1", name: "x", args: { credential: "[redacted:B]" } }]);
  assert.equal(finished["stopReason"], "tool_use");
  assert.equal(finished["costMicros"], 1);
  assert.deepEqual(opened["pending"], { id: "p", kind: "question", stepKey: "k", title: "t", detail: { question: "q", choices: [] } });
  assert.ok(!JSON.stringify(finished).includes(DIGITS));
});

test("two layers through the real wiring, both splits: the number is a placeholder and the listed keys are intact", async (t) => {
  for (const [runSecrets, processSecrets] of [
    [{ NAME: "toolCalls" }, { PIN: DIGITS }],
    [{ PIN: DIGITS }, { NAME: "toolCalls" }],
  ] as const) {
    const first: Redactor = createRedactor(runSecrets);
    const second = await secretsWith(t, processSecrets);
    const out = second.batch(redactCommitBatch(probeBatch(), first));
    const finished = out.records[0]?.data as Record<string, Json>;
    const label = JSON.stringify(runSecrets);
    assert.deepEqual(Object.keys(finished), ["model", "purpose", "text", "toolCalls", "output", "stopReason", "usage", "costMicros", "durationMs"], label);
    const credential = ((finished["toolCalls"] as JsonObject[])[0]?.["args"] as JsonObject)["credential"];
    assert.equal(typeof credential, "string", label);
    assert.match(credential as string, /^\[redacted(:PIN)?\]$/, label);
    assert.equal(finished["costMicros"], 1, label);
    assert.ok(!JSON.stringify(out).includes(DIGITS), label);
  }
});

// ---------------------------------------------------------------- samples of every record type

/** A well-formed record of every type, each with an engine number where the type has one. */
const SAMPLES: Record<JournalType, JsonObject> = {
  "run.created": {
    agentId: "agent-1", revision: 3, input: { message: "go", data: { a: 1 } },
    limits: { maxCostMicros: 900, maxToolCalls: null, maxTurns: 4, allowUnpriced: false }, trigger: { id: "trg_1", kind: "cron" },
  },
  "run.claimed": { runnerId: "runner-1" },
  "command.applied": { commandId: "cmd_1", command: { type: "approve", pendingId: "pend_1", always: false } },
  "command.rejected": { commandId: "cmd_2", command: { type: "limits", limits: { maxTurns: 9 } }, reason: "no" },
  "limits.changed": { limits: { maxCostMicros: 901, maxToolCalls: 2, maxTurns: null, allowUnpriced: true } },
  "inbox.taken": { messages: [{ commandId: "cmd_3", text: "hello", at: 1700000000001 }] },
  "model.started": {
    model: "scripted/m", purpose: "run", step: "s", turn: 2, countsAsTurn: true, inputTokensEstimate: 10, maxOutputTokens: 20,
    worstCaseMicros: 30, repair: false, attempt: 1,
  },
  "model.invalid": {
    model: "scripted/m", purpose: "step", text: "t", toolCalls: [{ id: "c1", name: "x", args: { a: 1 } }], output: { o: 1 },
    problems: [{ path: "$.o", message: "bad" }], usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
    costMicros: 5, durationMs: 6,
  },
  "model.finished": {
    model: "scripted/m", purpose: "run", text: "t", toolCalls: [{ id: "c1", name: "x", args: { a: 1 } }], output: { o: 1 },
    stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }, costMicros: 5, durationMs: 6,
  },
  "model.interrupted": { model: "scripted/m", reason: "crash", assumedCostMicros: 7, attempt: 2 },
  "model.failed": {
    model: "scripted/m", error: { code: "model_transient", message: "m" }, usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
    costMicros: 8, attempts: 3, assumedCostMicros: 9, retryAfterMs: 10, retryAfterOverLimit: true,
  },
  "model.retry": { attempt: 1, delayMs: 11, code: "model_transient", message: "m", status: 503, billing: "unknown", assumedCostMicros: 12, retryAfterMs: 13 },
  "tool.started": { callId: "c1", tool: "x", args: { a: 1 }, effect: "write", attempt: 1 },
  "tool.finished": {
    callId: "c1", tool: "x", outcome: "ok", content: "c", data: { d: 1 }, isError: false, untrusted: false, truncated: true,
    fullResultPath: ".runwright/r.txt", durationMs: 14, fullResultSha256: "ab", fullResultBytes: 15, fullDataPath: ".runwright/d.json",
    fullDataSha256: "cd", fullDataBytes: 16,
  },
  "tool.interrupted": { tool: "x", args: { a: 1 }, attempt: 2, reason: "crash" },
  "pending.opened": { pending: { id: "pend_1", kind: "approval", stepKey: "t1.c0", title: "Approve x", detail: { tool: "x", args: { a: 1 }, expiresAt: 1700000000002 } } },
  "pending.resolved": { pendingId: "pend_1", kind: "approval", resolution: { decision: "approve", always: false, reason: null }, commandId: "cmd_1" },
  "step.started": { name: "workflow.scope", nodeId: "n1", scope: "root" },
  "step.finished": { name: "workflow.resolve", workflow: "w", value: { v: 1 } },
  "node.started": { name: "n1", kind: "map", scope: "root" },
  "node.finished": { name: "n1", kind: "map", scope: "root", value: [1] },
  "node.retry": { nodeId: "n1", attempt: 1, delayMs: 17, error: { code: "internal", message: "m" } },
  "context.compacted": { throughTurn: 3, tokensBefore: 18, tokensAfter: 19 },
  "learning.given": { items: [{ itemId: "li_1", version: 2, kind: "note", name: "n", mode: "full" }] },
  "learning.checked": { dropAll: null, dropped: [{ path: "notes/a.md", reason: "r" }], surviving: ["notes/b.md"] },
  "learning.graded": { decisions: [{ path: "notes/b.md", verdict: "keep", reason: "r", by: "grader" }] },
  "learning.applied": { kept: [{ itemId: "li_1", path: "notes/b.md", version: 3 }], held: [], conflicts: [{ path: "notes/c.md", reason: "r" }] },
  "learning.skipped": { reason: "limit" },
  "learning.promotion": { itemId: "li_1", outcome: "kept", workflow: "w", problems: [] },
  "run.output": { output: { o: 1 } },
  "message.undelivered": { commandId: "cmd_3", reason: "r" },
  "run.waiting": { pendingIds: ["pend_1"] },
  "run.paused": { commandId: "cmd_4" },
  "run.released": { reason: "shutdown" },
  "run.completed": { output: { o: 1 } },
  "run.failed": { error: { code: "internal", message: "m" } },
  "run.cancelled": { reason: "r" },
};

type Segment = string | number;

/** Every leaf path of a spec (an array's items at index 0), with the leaf's mode. */
function leaves(spec: FieldSpec, path: Segment[] = []): { path: Segment[]; mode: "keep" | "text" | "payload" }[] {
  if (typeof spec === "string") return [{ path, mode: spec }];
  if ("items" in spec) return leaves(spec.items, [...path, 0]);
  if ("values" in spec) return leaves(spec.values, [...path, "entry"]);
  return Object.entries(spec.fields).flatMap(([key, inner]) => leaves(inner, [...path, key]));
}

/** `data` with `value` at `path`, creating objects and one-element arrays on the way. */
function setAt(data: Json, path: Segment[], value: Json): Json {
  if (path.length === 0) return value;
  const [head, ...rest] = path as [Segment, ...Segment[]];
  if (typeof head === "number") {
    const array = Array.isArray(data) && data.length > 0 ? [...data] : [null];
    array[0] = setAt(array[0] ?? null, rest, value);
    return array;
  }
  const object: JsonObject = data !== null && typeof data === "object" && !Array.isArray(data) ? { ...data } : {};
  object[head] = setAt(object[head] ?? null, rest, value);
  return object;
}

function getAt(data: Json, path: Segment[]): Json | undefined {
  let current: Json | undefined = data;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = Array.isArray(current) ? current[segment as number] : (current as JsonObject)[segment as string];
  }
  return current;
}

/** Every listed key of `spec` present in `data`, as dotted paths (`a.b[0].c`). */
function listedKeys(data: Json, spec: FieldSpec, prefix = ""): string[] {
  if (typeof spec === "string" || data === null || typeof data !== "object") return [];
  if ("items" in spec) return Array.isArray(data) ? data.flatMap((item, i) => listedKeys(item, spec.items, `${prefix}[${i}]`)) : [];
  if (Array.isArray(data)) return [];
  if ("values" in spec) return Object.entries(data).flatMap(([key, item]) => listedKeys(item, spec.values, `${prefix}[${JSON.stringify(key)}]`));
  return Object.entries(spec.fields).flatMap(([key, inner]) =>
    Object.hasOwn(data, key) ? [`${prefix}.${key}`, ...listedKeys((data as JsonObject)[key] as Json, inner, `${prefix}.${key}`)] : []);
}

/** Engine numbers (numbers at "keep" leaves) of a record, by path. */
function engineNumbers(data: Json, spec: FieldSpec): Record<string, number> {
  const out: Record<string, number> = {};
  for (const leaf of leaves(spec)) {
    const value = getAt(data, leaf.path);
    if (leaf.mode === "keep" && typeof value === "number") out[leaf.path.join(".")] = value;
  }
  return out;
}

function redactOne(type: string, data: JsonObject, r: Redactor): JsonObject {
  return redactCommitBatch({ records: [{ type, data }] }, r).records[0]?.data as JsonObject;
}

test("the samples are well formed and every type with a number has an engine number in its sample", () => {
  for (const [type, data] of Object.entries(SAMPLES)) {
    const spec = RECORD_FIELDS[type] as FieldSpec;
    assert.ok(listedKeys(data, spec).length > 0, type);
    assert.deepEqual(unlistedPaths(data, spec), [], type);
    assert.deepEqual(redactOne(type, data, createRedactor({})), data, `${type}: nothing to redact, nothing changes`);
  }
});

test("generated from the table: a field name used as a secret never hides a payload path or changes a listed key", () => {
  const value: Json = { credential: N, list: [N] };
  let cases = 0;
  let nameCases = 0;
  for (const [type, spec] of Object.entries(RECORD_FIELDS)) {
    for (const leaf of leaves(spec).filter((l) => l.mode === "payload")) {
      const data = setAt(SAMPLES[type as JournalType], leaf.path, value) as JsonObject;
      // Names on the path first, then every other listed name of the record (stricter than the path alone).
      const names = new Set<string>([...leaf.path.filter((s): s is string => typeof s === "string"), ...listedKeys(data, spec).map((k) => k.split(/[.[\]]/).filter(Boolean).pop() as string)]);
      const secrets: (string | null)[] = [null];
      for (const name of names) {
        if (Buffer.byteLength(name) >= 8) secrets.push(name);
        if (Buffer.byteLength(name) >= 9) secrets.push(name.slice(0, 8), name.slice(name.length - 8));
      }
      for (const secret of secrets) {
        const r = createRedactor(secret === null ? { PIN: DIGITS } : { NAME: secret, PIN: DIGITS });
        const out = redactOne(type, data, r);
        const label = `${type} ${leaf.path.join(".")} secret ${String(secret)}`;
        assert.deepEqual(listedKeys(out, spec), listedKeys(data, spec), `${label}: no listed key changed`);
        const at = getAt(out, leaf.path) as JsonObject;
        assert.equal(at["credential"], P, label);
        assert.deepEqual(at["list"], [P], label);
        assert.deepEqual(engineNumbers(out, spec), engineNumbers(data, spec), `${label}: engine numbers unchanged`);
        cases++;
        if (secret !== null) nameCases++;
      }
    }
  }
  assert.ok(cases >= 14, `${cases} cases`);
  assert.ok(nameCases >= 20, `${nameCases} cases with a field name as the secret`);
});

test("vocabulary is kept: a secret equal to a keep value leaves that value; the same value in a text field is redacted", () => {
  let cases = 0;
  for (const [type, spec] of Object.entries(RECORD_FIELDS)) {
    const textLeaf = leaves(spec).find((l) => l.mode === "text");
    for (const [index, leaf] of leaves(spec).filter((l) => l.mode === "keep").entries()) {
      const word = `vocab-${type}-${index}`;
      let data = setAt(SAMPLES[type as JournalType], leaf.path, word) as JsonObject;
      if (textLeaf !== undefined && textLeaf.path.join(".") !== leaf.path.join(".")) data = setAt(data, textLeaf.path, `say ${word}`) as JsonObject;
      // Every record also carries the word in a field the table does not name, which fails closed.
      data = { ...data, unnamedField: word };
      const out = redactOne(type, data, createRedactor({ WORD: word }));
      const label = `${type} ${leaf.path.join(".")}`;
      assert.equal(getAt(out, leaf.path), word, `${label}: kept`);
      if (textLeaf !== undefined) assert.equal(getAt(out, textLeaf.path), "say [redacted:WORD]", `${label}: text redacted`);
      assert.equal(out["unnamedField"], "[redacted:WORD]", `${label}: an unnamed field redacted`);
      cases++;
    }
  }
  assert.ok(cases > 100, `${cases} keep leaves`);
});

test("fails closed: an extra field of an engine record is redacted whole; a type outside the table is redacted whole", () => {
  const r = createRedactor({ PIN: DIGITS, WORD: "surprise" });
  const out = redactOne("tool.started", { callId: "c", tool: "t", args: {}, effect: "read", attempt: 2, surprise: { n: N } }, r);
  assert.deepEqual(out, { callId: "c", tool: "t", args: {}, effect: "read", attempt: 2, "[redacted:WORD]": { n: P } });
  assert.deepEqual(redactOne("host.note", { n: N, list: [N, { deep: N }], text: DIGITS, [DIGITS]: true }, r),
    { n: P, list: [P, { deep: P }], text: P, [P]: true });
  // An object of engine numbers fails closed too: an unexpected key in limits or usage.
  assert.deepEqual(redactOne("limits.changed", { limits: { maxCostMicros: N, odd: N } }, r), { limits: { maxCostMicros: N, odd: P } });
});

// ---------------------------------------------------------------- the field map, one row at a time

const pin = createRedactor({ PIN: DIGITS });
const usage = { inputTokens: N, outputTokens: N, cacheReadTokens: 0, cacheWriteTokens: 0 };

function one(type: string, data: Record<string, unknown>): Record<string, unknown> {
  return redactOne(type, data as JsonObject, pin) as Record<string, unknown>;
}

test("run.created: input.data is payload; the limits, the revision and the message's text mode are not", () => {
  const data = one("run.created", {
    agentId: "a", revision: N, input: { message: "use 12345678", data: { credential: N, nested: [N, 7] } },
    limits: { maxCostMicros: N, maxToolCalls: null, maxTurns: null, allowUnpriced: false }, trigger: null,
  });
  assert.deepEqual(data["input"], { message: `use ${P}`, data: { credential: P, nested: [P, 7] } });
  assert.deepEqual(data["limits"], { maxCostMicros: N, maxToolCalls: null, maxTurns: null, allowUnpriced: false });
  assert.equal(data["revision"], N);
  assert.equal(data["trigger"], null);
  const top = one("run.created", { agentId: "a", revision: 1, input: { message: "m", data: N }, limits: {} });
  assert.deepEqual(top["input"], { message: "m", data: P }, "a run's data that is a number itself");
});

for (const type of ["model.invalid", "model.finished"]) {
  test(`${type}: output and each tool call's args are payload; usage and cost are not`, () => {
    const data = one(type, {
      model: "m", purpose: "run", text: "t 12345678", output: { n: N },
      toolCalls: [{ id: "c1", name: "x", args: { code: N } }, { id: "c2", name: "y", args: { list: [N] } }],
      usage, costMicros: N, stopReason: "tool_use",
    });
    assert.deepEqual(data["output"], { n: P });
    assert.deepEqual(data["toolCalls"], [{ id: "c1", name: "x", args: { code: P } }, { id: "c2", name: "y", args: { list: [P] } }]);
    assert.equal(data["text"], `t ${P}`);
    assert.deepEqual(data["usage"], usage);
    assert.equal(data["costMicros"], N);
  });
}

for (const type of ["tool.started", "tool.interrupted"]) {
  test(`${type}: args are payload; the attempt is not`, () => {
    const data = one(type, { callId: "c", tool: "t", args: { pin: N, deep: { list: [N] } }, effect: "read", attempt: N, reason: "crash" });
    assert.deepEqual(data["args"], { pin: P, deep: { list: [P] } });
    assert.equal(data["attempt"], N);
  });
}

test("tool.finished: data is payload; durations and byte counts are not", () => {
  const data = one("tool.finished", {
    callId: "c", tool: "t", outcome: "ok", content: "c 12345678", data: { pin: N }, isError: false, untrusted: false,
    durationMs: N, fullResultBytes: N, fullDataBytes: null,
  });
  assert.deepEqual(data["data"], { pin: P });
  assert.equal(data["content"], `c ${P}`);
  assert.equal(data["durationMs"], N);
  assert.equal(data["fullResultBytes"], N);
});

test("pending.opened: the detail's args are payload; expiresAt, a spend cap and every other detail field are not", () => {
  const approval = one("pending.opened", {
    pending: { id: "p", kind: "approval", stepKey: "s", title: "Approve x: {\"pin\":12345678}", detail: { tool: "x", args: { pin: N }, expiresAt: 1789012345678 } },
  });
  assert.deepEqual(approval["pending"], {
    id: "p", kind: "approval", stepKey: "s", title: `Approve x: {"pin":${P}}`, detail: { tool: "x", args: { pin: P }, expiresAt: 1789012345678 },
  });
  const cap = one("pending.opened", { pending: { id: "q", kind: "spend_cap", stepKey: "s", title: "cap", detail: { capMicros: N, spentMicros: N } } });
  assert.deepEqual((cap["pending"] as Record<string, unknown>)["detail"], { capMicros: N, spentMicros: N });
});

for (const type of ["step.finished", "node.finished"]) {
  test(`${type}: the value is payload; a field the table does not name is redacted with it`, () => {
    const data = one(type, { name: "s", value: { total: N }, attempt: N });
    assert.deepEqual(data, { name: "s", value: { total: P }, attempt: P });
    assert.deepEqual(one(type, { name: "s", value: N }), { name: "s", value: P });
    assert.deepEqual(one(type, { name: "s", kind: "map", scope: "root", value: N }), { name: "s", kind: "map", scope: "root", value: P });
  });
}

for (const type of ["run.output", "run.completed"]) {
  test(`${type}: the output is payload`, () => {
    assert.deepEqual(one(type, { output: { total: N, list: [N] } }), { output: { total: P, list: [P] } });
    assert.deepEqual(one(type, { output: N }), { output: P });
  });
}

test("engine records keep their numbers: limits, commands, inbox times, learning versions, retries", () => {
  assert.deepEqual(one("limits.changed", { limits: { maxCostMicros: N } }), { limits: { maxCostMicros: N } });
  assert.deepEqual(one("command.applied", { commandId: "c", command: { type: "limits", limits: { maxCostMicros: N } } }),
    { commandId: "c", command: { type: "limits", limits: { maxCostMicros: N } } });
  assert.deepEqual(one("inbox.taken", { messages: [{ commandId: "c", text: "hi 12345678", at: 1712345678901 }] }),
    { messages: [{ commandId: "c", text: `hi ${P}`, at: 1712345678901 }] });
  assert.deepEqual(one("learning.given", { items: [{ itemId: "li", version: N, mode: "full" }] }), { items: [{ itemId: "li", version: N, mode: "full" }] });
  assert.deepEqual(one("node.retry", { nodeId: "n", attempt: 2, delayMs: N, error: { code: "x", message: "12345678" } }),
    { nodeId: "n", attempt: 2, delayMs: N, error: { code: "x", message: P } });
  assert.deepEqual(one("model.started", { model: "m", turn: N }), { model: "m", turn: N });
});

test("a record of a type the engine does not write is payload as a whole", () => {
  assert.deepEqual(one("host.note", { n: N, list: [N, { deep: N }], text: "12345678", "12345678": true }),
    { n: P, list: [P, { deep: P }], text: P, [P]: true });
});

test("odd shapes: a value of the wrong JSON type is redacted whole; null stays; nothing is created", () => {
  assert.deepEqual(one("model.finished", { toolCalls: "12345678", output: N, costMicros: N }), { toolCalls: P, output: P, costMicros: N });
  assert.deepEqual(one("model.finished", { toolCalls: { 0: { args: { n: N }, id: "12345678" } } }), { toolCalls: { 0: { args: { n: P }, id: P } } },
    "an object where an array belongs is redacted whole");
  assert.deepEqual(one("model.finished", { toolCalls: [null, 5, { id: "c" }, { args: N }] }), { toolCalls: [null, 5, { id: "c" }, { args: P }] });
  assert.deepEqual(one("run.created", { agentId: "a", limits: { maxCostMicros: N } }), { agentId: "a", limits: { maxCostMicros: N } });
  assert.deepEqual(one("run.created", { input: "12345678" }), { input: P }, "an input that is not an object is redacted whole");
  assert.deepEqual(one("pending.opened", { pending: { detail: null } }), { pending: { detail: null } });
  assert.deepEqual(one("pending.opened", { pending: [{ detail: { args: { n: N }, capMicros: N } }] }), { pending: [{ detail: { args: { n: P }, capMicros: P } }] },
    "an array where an object belongs is redacted whole");
  assert.deepEqual(one("tool.finished", { durationMs: N }), { durationMs: N });
  assert.deepEqual(one("model.finished", { costMicros: { n: N }, stopReason: ["12345678"] }), { costMicros: { n: P }, stopReason: [P] },
    "a keep field holding an object or an array is redacted whole");
  assert.deepEqual(one("tool.finished", { content: N }), { content: P }, "a text field holding a number is redacted whole");
  const inherited = Object.create({ args: { n: N } }) as Record<string, unknown>;
  inherited["tool"] = "t";
  assert.deepEqual(one("tool.started", inherited), { tool: "t" }, "an inherited property is not a field");
});

test("each part is redacted from the original value, once, and the input is not changed", () => {
  const seen: Json[] = [];
  const marking: BatchRedactor = {
    text: (value) => `J:${value}`,
    json: <T extends Json>(value: T): T => value,
    payload: (value) => {
      seen.push(value);
      return "P";
    },
  };
  const batch: CommitBatch = {
    records: [{ type: "tool.started", key: "k", data: { tool: "t", args: { a: "x" } } }],
    openPendings: [{ id: "p", kind: "approval", stepKey: "s", title: "t", detail: { tool: "t", args: { a: "y" } } }],
    transition: { to: "completed", output: { o: 1 } },
  };
  const copy = structuredClone(batch);
  const out = redactCommitBatch(batch, marking);
  assert.deepEqual(batch, copy);
  assert.deepEqual(out.records[0]?.data, { tool: "J:t", args: "P" });
  assert.deepEqual(out.openPendings?.[0], { id: "p", kind: "approval", stepKey: "s", title: "J:t", detail: { tool: "J:t", args: "P" } });
  assert.equal(out.transition?.output, "P");
  assert.deepEqual(seen, [{ a: "x" }, { a: "y" }, { o: 1 }]);
});

test("pendings in a batch: detail and resolution by their specs", () => {
  const r = createRedactor({ PIN: DIGITS, A: "approve-it", K: "question", D: "decision" });
  const out = redactCommitBatch({
    records: [],
    openPendings: [
      { id: "p1", kind: "approval", stepKey: "s", title: "approve 12345678", detail: { tool: "x", args: { pin: N, decision: "question" }, expiresAt: 1789012345678 } },
      { id: "p2", kind: "spend_cap", stepKey: "s", title: "cap", detail: { capMicros: N, spentMicros: 1, neededMicros: N, nextCallWorstCaseMicros: N, reason: "cap", model: "m" } },
      { id: "p3", kind: "question", stepKey: "s", title: "q", detail: { question: "a question? 12345678", choices: ["question", "approve-it"] } },
      { id: "p4", kind: "tool_budget", stepKey: "s", title: "b", detail: { limit: N, used: N, needed: 1 } },
    ],
    resolvePendings: [
      { id: "p0", resolution: { approved: true, amount: N } },
      { id: "p1", resolution: { decision: "approve", always: true, reason: "question" } },
      { id: "p5", resolution: { action: "skip", result: "approve-it 12345678" } },
      { id: "p2", resolution: { limits: { maxCostMicros: N, maxToolCalls: null, maxTurns: null, allowUnpriced: false } } },
      { id: "p6", resolution: { expired: true, expiresAt: 1712345678000 } },
      { id: "p7", resolution: { closed: "completed" } },
    ],
    transition: { to: "completed", output: N },
  }, r);
  assert.deepEqual(out.openPendings?.map((p) => [p.title, p.detail]), [
    [`approve ${P}`, { tool: "x", args: { pin: P, "[redacted:D]": "[redacted:K]" }, expiresAt: 1789012345678 }],
    ["cap", { capMicros: N, spentMicros: 1, neededMicros: N, nextCallWorstCaseMicros: N, reason: "cap", model: "m" }],
    ["q", { question: `a [redacted:K]? ${P}`, choices: ["[redacted:K]", "[redacted:A]"] }],
    ["b", { limit: N, used: N, needed: 1 }],
  ]);
  assert.deepEqual(out.resolvePendings, [
    { id: "p0", resolution: { approved: true, amount: P } },
    { id: "p1", resolution: { decision: "approve", always: true, reason: "[redacted:K]" } },
    { id: "p5", resolution: { action: "skip", result: `[redacted:A] ${P}` } },
    { id: "p2", resolution: { limits: { maxCostMicros: N, maxToolCalls: null, maxTurns: null, allowUnpriced: false } } },
    { id: "p6", resolution: { expired: true, expiresAt: 1712345678000 } },
    { id: "p7", resolution: { closed: "completed" } },
  ]);
  assert.equal(out.transition?.output, P);
});

test("a redactor that turns a whole object into another value leaves a record's data an object", () => {
  const flattening: BatchRedactor = { text: (value) => value, json: <T extends Json>(value: T): T => value, payload: () => "[all]" };
  const out = redactCommitBatch({ records: [{ type: "host.note", data: { a: 1 } }] }, flattening);
  assert.deepEqual(out.records[0]?.data, { value: "[all]" });
});

test("a promoted workflow document keeps its numbers: they are structure", () => {
  const doc = { ...document, root: { id: "run", kind: "tool", tool: "shell", args: { command: "x" }, deadlineMs: N } } as unknown as WorkflowDocument;
  const out = redactCommitBatch({ records: [], learning: { promotions: [{ itemId: "li", expectedVersion: 1, note: "n", workflow: { name: "w", document: doc } }] } }, pin);
  const root = (out.learning?.promotions?.[0]?.workflow?.document as unknown as { root: { deadlineMs: unknown } }).root;
  assert.equal(root.deadlineMs, N);
});

test("every record type of the table is redacted field by field: a listed key holding a secret's text is written as it is", () => {
  for (const [type, spec] of Object.entries(RECORD_FIELDS)) {
    const [first] = Object.keys(spec.fields);
    assert.ok(first !== undefined, type);
    const r = createRedactor({ NAME: first.length >= 8 ? first : `${first}-padding` });
    const out = redactOne(type, { [first]: null, [`${first}-padding`]: 1 }, r);
    assert.ok(Object.hasOwn(out, first), `${type}: ${first} is kept as a key`);
    assert.equal(Object.keys(out).length, 2, type);
  }
});

// ---------------------------------------------------------------- declared specifications (R12-02)

const GIVEN_SPEC = fieldObject({ promptSection: "text", given: fieldList(fieldObject({ itemId: "keep", version: "keep" })), tools: fieldList("text") });
const PROMPT_WORD = "promptSection";
const NOTE_TEXT = "note-text-0042";

function givenRecord(withFields: boolean): CommitBatch["records"][number] {
  return {
    type: "step.finished", key: "learning/given",
    data: {
      name: "learning.given",
      value: { promptSection: `Known notes: ${NOTE_TEXT} and the promptSection word`, given: [{ itemId: "li_1", version: 2 }], tools: [] },
    },
    ...(withFields ? { fields: recordFieldsWith("step.finished", "value", GIVEN_SPEC) } : {}),
  };
}

test("a step.finished record with fields is redacted by them, and the returned record carries the same fields object", () => {
  const record = givenRecord(true);
  const out = redactCommitBatch({ records: [record] }, createRedactor({ WORD: PROMPT_WORD, NOTE: NOTE_TEXT })).records[0];
  assert.ok(out !== undefined);
  assert.equal(out.fields, record.fields, "the same object, for the next pass");
  assert.deepEqual(out.data, {
    name: "learning.given",
    value: { promptSection: "Known notes: [redacted:NOTE] and the [redacted:WORD] word", given: [{ itemId: "li_1", version: 2 }], tools: [] },
  });
});

test("the reviewer's value at the store level: the declared key stays and its text is redacted, through two passes split both ways", async (t) => {
  for (const [runSecrets, processSecrets] of [
    [{ WORD: PROMPT_WORD }, { NOTE: NOTE_TEXT }],
    [{ NOTE: NOTE_TEXT }, { WORD: PROMPT_WORD }],
    [{ WORD: PROMPT_WORD, NOTE: NOTE_TEXT }, { WORD: PROMPT_WORD, NOTE: NOTE_TEXT }],
  ] as const) {
    const label = JSON.stringify(runSecrets);
    const second = await secretsWith(t, processSecrets);
    const firstPass = redactCommitBatch({ records: [givenRecord(true)] }, createRedactor(runSecrets));
    assert.ok(firstPass.records[0]?.fields !== undefined, `${label}: the first pass keeps fields`);
    const out = second.batch(firstPass);
    const value = (out.records[0]?.data as JsonObject)["value"] as JsonObject;
    assert.deepEqual(Object.keys(value), ["promptSection", "given", "tools"], label);
    assert.deepEqual(value["given"], [{ itemId: "li_1", version: 2 }], label);
    const text = value["promptSection"] as string;
    assert.ok(!text.includes(PROMPT_WORD) && !text.includes(NOTE_TEXT), `${label}: ${text}`);
    assert.match(text, /^Known notes: \[redacted(:NOTE)?\] and the \[redacted(:WORD)?\] word$/, label);
  }
});

test("host values stay fully redacted: the same record without fields has its key replaced by the placeholder", () => {
  const out = redactCommitBatch({ records: [givenRecord(false)] }, createRedactor({ WORD: PROMPT_WORD })).records[0];
  assert.ok(out !== undefined);
  assert.equal(Object.hasOwn(out, "fields"), false);
  const value = (out.data as JsonObject)["value"] as JsonObject;
  assert.deepEqual(Object.keys(value), ["[redacted:WORD]", "given", "tools"]);
  assert.equal(value["[redacted:WORD]"], "Known notes: note-text-0042 and the [redacted:WORD] word");
});

test("a record of a type outside RECORD_FIELDS is redacted by its fields when it has them, and whole without", () => {
  const r = createRedactor({ WORD: PROMPT_WORD, PIN: "12345678" });
  const data = { promptSection: "a promptSection", count: 12345678 };
  const declared = fieldObject({ promptSection: "text", count: "keep" });
  const [withFields, whole] = redactCommitBatch({
    records: [{ type: "host.note", data, fields: declared }, { type: "host.note", data }],
  }, r).records;
  assert.deepEqual(withFields?.data, { promptSection: "a [redacted:WORD]", count: 12345678 });
  assert.equal(withFields?.fields, declared);
  assert.deepEqual(whole?.data, { "[redacted:WORD]": "a [redacted:WORD]", count: "[redacted:PIN]" });
});
