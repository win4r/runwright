/**
 * Declared field specifications through the engine (rule H; finding R12-02, the mechanism): `memo` and `effect`
 * with `valueFields`, a model step with `outputFields` and a tool's `dataFields` keep the declared field names
 * and the kept values in what is stored and in what the step returns, before and after a crash, while every text
 * and payload inside is still redacted; without a declaration the value is redacted whole, as before. Every case
 * runs through both layers as `createApp` wires them, with the secrets split both ways (handed to the run, and
 * only stored).
 */
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { isRunwrightError } from "../../src/core/errors.ts";
import { canonicalJson, type Json, type JsonObject } from "../../src/core/json.ts";
import { createRedactor } from "../../src/core/redact.ts";
import type { Driver } from "../../src/engine/types.ts";
import type { ModelRequest, StructuredOutputSpec } from "../../src/models/types.ts";
import { fieldList, fieldObject, redactBySpec, type FieldSpec } from "../../src/store/record-fields.ts";
import type { JournalRecord } from "../../src/store/types.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import { createHarness, fakeModels, reply, type Harness } from "../helpers/engine.ts";
import { twoLayerWiring, undeclaredPaths, wordSecrets, type TwoLayerWiring } from "../helpers/two-layer.ts";
import { waitFor } from "../helpers/wait.ts";

const NOTE = "note-text-0042";
const PIN = 12345678;
const SPEC = fieldObject({
  promptSection: "text", given: fieldList(fieldObject({ itemId: "keep", version: "keep" })), count: "keep", pinPayload: "payload",
});
const WORDS = wordSecrets(SPEC);
const WORD_SECRETS: Record<string, string> = Object.fromEntries(WORDS.map((word, index) => [`WORD_${index}`, word]));
const OTHER_SECRETS: Record<string, string> = { NOTE, PIN: String(PIN) };
const ALL_SECRETS: Record<string, string> = { ...WORD_SECRETS, ...OTHER_SECRETS };

/** The splits: which secrets the run is handed (first layer); the rest are only stored (second layer). */
const SPLITS: Record<string, Record<string, string>> = {
  handed: ALL_SECRETS, stored: {}, "words handed": WORD_SECRETS, "words stored": OTHER_SECRETS,
};

function builtValue(text = `Notes: ${NOTE}; the promptSection word`): JsonObject {
  return { promptSection: text, given: [{ itemId: "li_1", version: 2 }], count: PIN, pinPayload: PIN };
}

const SCHEMA: StructuredOutputSpec = { name: "Probe", schema: { type: "object", required: ["promptSection"], properties: { promptSection: { type: "string" } } } };
const BAD_DATA_FIELDS = 'tool "probe_bad" returned "dataFields" that is not a field specification';

function cyclicSpec(): FieldSpec {
  const cyclic: { fields: Record<string, unknown> } = { fields: {} };
  cyclic.fields["self"] = cyclic;
  return cyclic as unknown as FieldSpec;
}

/** What one session of the driver saw, before it waited for the person. */
interface Seen {
  memo: Json; effect: Json; plain: Json; modelDeclared: Json; modelPlain: Json; modelRepaired: Json; modelRepairedPlain: Json;
  toolDeclared: { data: Json; outcome: string }; toolPlain: Json; toolBad: { content: string; data: Json; outcome: string };
  toolBig: Json; errors: Record<string, string>;
}

function codeOf(error: unknown): string {
  return isRunwrightError(error) ? `${error.code}: ${error.message}` : `other: ${String(error)}`;
}

async function failure(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return "no error";
  } catch (error) {
    return codeOf(error);
  }
}

function probeDriver(seen: Map<string, Seen[]>): Driver {
  return async (ctx) => {
    const errors: Record<string, string> = {};
    errors["memo word"] = await failure(() => ctx.memo("bad/memo-word", { recordType: "step", name: "bad", valueFields: "nope" as FieldSpec }, async () => 1));
    errors["memo cycle"] = await failure(() => ctx.memo("bad/memo-cycle", { recordType: "step", name: "bad", valueFields: cyclicSpec() }, async () => 1));
    errors["effect word"] = await failure(() => ctx.effect("bad/effect-word", { recordType: "node", name: "bad", valueFields: "nope" as FieldSpec }, async () => ({ value: 1 })));
    const step = { purpose: "run" as const, system: "probe", messages: [{ role: "user" as const, content: "go" }], output: SCHEMA };
    errors["model"] = await failure(() => ctx.model("m-bad", { ...step, outputFields: cyclicSpec() }));
    const memo = await ctx.memo("probe/memo", { recordType: "step", name: "probe", valueFields: SPEC }, async () => builtValue());
    const effect = await ctx.effect("probe/effect", { recordType: "node", name: "probe", valueFields: SPEC }, async () => ({ value: builtValue() }));
    const plain = await ctx.memo("probe/plain", { recordType: "step", name: "plain" }, async () => builtValue());
    const modelDeclared = (await ctx.model("m-declared", { ...step, outputFields: SPEC })).output;
    const modelPlain = (await ctx.model("m-plain", step)).output;
    const modelRepaired = (await ctx.model("m-invalid", { ...step, outputFields: SPEC })).output;
    const modelRepairedPlain = (await ctx.model("m-invalid-plain", step)).output;
    const declared = await ctx.tool("tool-declared", { name: "probe_data", args: {} });
    const toolPlain = (await ctx.tool("tool-plain", { name: "probe_plain", args: {} })).data;
    const bad = await ctx.tool("tool-bad", { name: "probe_bad", args: {} });
    const toolBig = (await ctx.tool("tool-big", { name: "probe_big", args: {} })).data;
    const list = seen.get(ctx.run.id) ?? [];
    list.push({
      memo, effect, plain, modelDeclared, modelPlain, modelRepaired, modelRepairedPlain, toolPlain, toolBig, errors,
      toolDeclared: { data: declared.data, outcome: declared.outcome },
      toolBad: { content: bad.content, data: bad.data, outcome: bad.outcome },
    });
    seen.set(ctx.run.id, list);
    await ctx.ask("continue", { question: "continue?" });
    return "done";
  };
}

const BIG_TEXT = `${"x".repeat(20_000)} ${NOTE} promptSection`;

function probeTools(): ToolDefinition[] {
  const tool = (name: string, output: () => Awaited<ReturnType<ToolDefinition["handler"]>>): ToolDefinition => ({
    name, description: "probe", parameters: { type: "object", properties: {} }, effect: "read", handler: async () => output(),
  });
  return [
    tool("probe_data", () => ({ content: "ok", data: builtValue(), dataFields: SPEC })),
    tool("probe_plain", () => ({ content: "ok", data: builtValue() })),
    tool("probe_bad", () => ({ content: "ok", data: builtValue(), dataFields: { fields: { a: "nope" } } as unknown as FieldSpec })),
    tool("probe_big", () => ({ content: "ok", data: builtValue(BIG_TEXT), dataFields: SPEC })),
  ];
}

function probeModels(): ReturnType<typeof fakeModels> {
  return fakeModels((request: ModelRequest) => {
    if (request.meta.key.startsWith("m-invalid") && request.messages.length === 1) {
      return reply({ output: { promptSection: 5, given: [], count: PIN, pinPayload: PIN } });
    }
    return reply({ output: builtValue() });
  });
}

interface Probe { h: Harness; wiring: TwoLayerWiring; seen: Map<string, Seen[]>; runs: Map<string, string> }

/** One harness, one run per split, each crashed while it waits for its question and then answered. */
async function probe(t: TestContext): Promise<Probe> {
  const wiring = twoLayerWiring();
  const seen = new Map<string, Seen[]>();
  const h = await createHarness(t, { models: probeModels(), tools: probeTools(), drivers: { agent: probeDriver(seen) }, ...wiring.options });
  await wiring.attach(h, ALL_SECRETS);
  const runs = new Map<string, string>();
  for (const [split, handed] of Object.entries(SPLITS)) {
    const agent = await h.saveAgent({
      secrets: Object.keys(handed),
      tools: [{ name: "probe_data" }, { name: "probe_plain" }, { name: "probe_bad" }, { name: "probe_big" }],
    });
    runs.set(split, (await h.start(agent.id)).id);
  }
  for (const runId of runs.values()) {
    await waitFor(async () => (await h.pendings(runId)).some((p) => p.kind === "question"), { timeoutMs: 5000, intervalMs: 10, message: "the question never opened" });
  }
  await h.crashAndReplace();
  for (const runId of runs.values()) {
    const question = (await h.pendings(runId)).find((p) => p.kind === "question");
    assert.ok(question !== undefined);
    await h.send(runId, { type: "answer", pendingId: question.id, answer: "yes" });
  }
  for (const runId of runs.values()) {
    const done = await h.until(runId, ["completed", "failed"]);
    assert.equal(done.status, "completed", JSON.stringify(done.error));
  }
  return { h, wiring, seen, runs };
}

/** A declared value as the engine reads it back: every declared key, kept values as they are, text redacted. */
function assertDeclared(value: Json, label: string): void {
  const object = value as JsonObject;
  assert.deepEqual(Object.keys(object), ["promptSection", "given", "count", "pinPayload"], label);
  assert.deepEqual(object["given"], [{ itemId: "li_1", version: 2 }], label);
  assert.equal(object["count"], PIN, `${label}: a kept number equal to a numeric secret stays the number`);
  assert.match(object["pinPayload"] as string, /^\[redacted(:PIN)?\]$/, `${label}: the same number as a payload is the placeholder`);
  assert.match(object["promptSection"] as string, /^Notes: \[redacted(:NOTE)?\]; the \[redacted(:WORD_\d+)?\] word$/, label);
}

/** An undeclared value: a key equal to a secret is the placeholder, the number is the placeholder. */
function assertWhole(value: Json, label: string): void {
  const object = value as JsonObject;
  const keys = Object.keys(object);
  assert.ok(!keys.includes("promptSection") && !keys.includes("pinPayload"), `${label}: ${keys.join(",")}`);
  assert.ok(keys.some((key) => /^\[redacted(:WORD_\d+)?\]$/.test(key)), `${label}: ${keys.join(",")}`);
  assert.match(object["count"] as string, /^\[redacted(:PIN)?\]$/, label);
}

/** The text secret is nowhere (the numeric one is kept where the specification says "keep", by design). */
function assertNoSecret(value: unknown, label: string): void {
  assert.ok(!JSON.stringify(value).includes(NOTE), `${label} holds the note secret`);
}

function finished(journal: JournalRecord[], type: string, key: string): JsonObject {
  const record = journal.find((r) => r.type === type && r.key === key);
  assert.ok(record !== undefined, `${type} ${key}`);
  return record.data;
}

test("memo, effect, model and tool values with a declaration keep their field names, before and after a crash, in both splits", async (t) => {
  const { h, seen, runs } = await probe(t);
  for (const [split, runId] of runs) {
    const sessions = seen.get(runId) ?? [];
    assert.equal(sessions.length, 2, `${split}: the driver ran in two sessions`);
    const [first, second] = sessions as [Seen, Seen];
    assert.deepEqual(second, first, `${split}: the replayed steps return the same values`);
    assertDeclared(first.memo, `${split} memo`);
    assertDeclared(first.effect, `${split} effect`);
    assertDeclared(first.modelDeclared, `${split} model with outputFields`);
    assertDeclared(first.modelRepaired, `${split} repaired model with outputFields`);
    assertDeclared(first.toolDeclared.data, `${split} tool with dataFields`);
    assertWhole(first.plain, `${split} memo without valueFields`);
    assertWhole(first.modelPlain, `${split} model without outputFields`);
    assertWhole(first.toolPlain, `${split} tool without dataFields`);
    assertWhole(first.modelRepairedPlain, `${split} repaired model without outputFields`);
    assertNoSecret(first, split);
    const journal = await h.journal(runId);
    assertDeclared(finished(journal, "step.finished", "probe/memo")["value"] as Json, `${split} stored memo`);
    assertDeclared(finished(journal, "node.finished", "probe/effect")["value"] as Json, `${split} stored effect`);
    assertDeclared(finished(journal, "model.finished", "m-declared")["output"] as Json, `${split} stored model output`);
    assertDeclared(finished(journal, "tool.finished", "tool-declared")["data"] as Json, `${split} stored tool data`);
    assertWhole(finished(journal, "step.finished", "probe/plain")["value"] as Json, `${split} stored plain memo`);
    assertWhole(finished(journal, "model.finished", "m-plain")["output"] as Json, `${split} stored plain output`);
    assertWhole(finished(journal, "tool.finished", "tool-plain")["data"] as Json, `${split} stored plain data`);
    for (const key of ["m-invalid", "m-invalid-plain"]) {
      const invalid = finished(journal, "model.invalid", key)["output"] as JsonObject;
      assert.ok(!Object.hasOwn(invalid, "promptSection"), `${split} ${key}: an output that did not fit its schema is a payload, declared or not`);
      assert.match(invalid["count"] as string, /^\[redacted(:PIN)?\]$/, `${split} ${key}`);
    }
    assert.equal(Object.hasOwn(finished(journal, "step.started", "probe/memo"), "value"), false, "the started record is unchanged");
    assertNoSecret(journal, `${split} journal`);
  }
});

test("an invalid declaration is bad_request before anything is journalled; a tool's is an error result with no data", async (t) => {
  const { h, seen, runs } = await probe(t);
  for (const [split, runId] of runs) {
    const [first] = seen.get(runId) ?? [];
    assert.ok(first !== undefined);
    assert.deepEqual(first.errors, {
      "memo word": 'bad_request: "valueFields" is not a field specification',
      "memo cycle": 'bad_request: "valueFields" is not a field specification',
      "effect word": 'bad_request: "valueFields" is not a field specification',
      model: 'bad_request: "outputFields" is not a field specification',
    }, split);
    assert.deepEqual(first.toolBad, { content: BAD_DATA_FIELDS, data: null, outcome: "error" }, split);
    const journal = await h.journal(runId);
    const keys = new Set(journal.map((r) => r.key));
    for (const key of ["bad/memo-word", "bad/memo-cycle", "bad/effect-word", "m-bad"]) assert.equal(keys.has(key), false, `${split}: nothing journalled for ${key}`);
    const bad = finished(journal, "tool.finished", "tool-bad");
    assert.deepEqual([bad["outcome"], bad["content"], bad["data"], bad["isError"]], ["error", BAD_DATA_FIELDS, null, true], split);
  }
});

test("data over the result limit with dataFields: data is null and the saved file holds the data redacted by the specification", async (t) => {
  const { h, seen, runs } = await probe(t);
  for (const [split, runId] of runs) {
    const [first] = seen.get(runId) ?? [];
    assert.equal(first?.toolBig, null, split);
    const big = finished(await h.journal(runId), "tool.finished", "tool-big");
    assert.equal(big["data"], null, split);
    const path = big["fullDataPath"];
    assert.equal(typeof path, "string", split);
    const saved = await readFile(join(h.dir, "workspaces", runId, path as string), "utf8");
    // The file is written by the run, before the store wrapper: the run's redactor over what it was handed.
    const expected = redactBySpec(builtValue(BIG_TEXT), SPEC, createRedactor(SPLITS[split] as Record<string, string>));
    assert.equal(saved, canonicalJson(expected), split);
    assert.deepEqual(Object.keys(JSON.parse(saved) as JsonObject).sort(), ["count", "given", "pinPayload", "promptSection"], split);
    assert.ok(!saved.includes(NOTE) || !Object.hasOwn(SPLITS[split] as object, "NOTE"), `${split}: a handed secret is not in the file`);
  }
});

test("fields are never stored, and every captured batch is named by a specification", async (t) => {
  const { h, wiring, runs } = await probe(t);
  assert.ok(wiring.batches.some((batch) => batch.records.some((record) => record.fields !== undefined)), "declared records reached the store wrapper with their fields");
  assert.deepEqual(undeclaredPaths(wiring.batches), []);
  for (const runId of runs.values()) {
    for (const record of await h.journal(runId)) assert.equal(Object.hasOwn(record, "fields"), false, `${record.type} ${record.key ?? ""}`);
  }
  const db = new DatabaseSync(join(h.dir, "runwright.db"), { readOnly: true });
  try {
    const columns = (db.prepare("PRAGMA table_info(journal)").all() as { name: string }[]).map((c) => c.name);
    assert.ok(!columns.includes("fields"));
    const rows = db.prepare("SELECT data FROM journal").all() as { data: string }[];
    assert.ok(rows.length > 0);
    for (const row of rows) assert.equal(Object.hasOwn(JSON.parse(row.data) as JsonObject, "fields"), false);
  } finally {
    db.close();
  }
});
