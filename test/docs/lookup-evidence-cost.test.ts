/**
 * The docs state the round-5 rules where a reader looks for them, and each rule is checked against the module that
 * implements it: the idempotency key is looked up before anything that can change, a redelivered webhook gets its
 * run after the trigger was turned off, the untrusted corpus covers structured data and webhook payloads, the
 * result size limit covers structured data, the hidden-character rule, the spend cap with unpriced models allowed,
 * and the cron day rule.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createFakeClock } from "../../src/core/clock.ts";
import { isRunwrightError } from "../../src/core/errors.ts";
import { createIdSource } from "../../src/core/ids.ts";
import type { Json, JsonObject } from "../../src/core/json.ts";
import { checkSpend, type SpendCheckInput } from "../../src/engine/budget.ts";
import { limitToolResult, savedResultName } from "../../src/engine/results.ts";
import { buildDigest } from "../../src/learning/proposal.ts";
import { assessProvenance, structuredTexts } from "../../src/learning/provenance.ts";
import { findHiddenCharacters } from "../../src/learning/secret-scan.ts";
import { requestFingerprint } from "../../src/store/idempotency.ts";
import type { JournalRecord } from "../../src/store/types.ts";
import { createFileTools } from "../../src/tools/fs.ts";
import { claimWorkspaceStage } from "../../src/tools/workspace-stage.ts";
import { createShellTool } from "../../src/tools/shell.ts";
import type { ToolContext, ToolDefinition } from "../../src/tools/types.ts";
import { createWebFetchTool } from "../../src/tools/web-fetch.ts";
import type { RunContext } from "../../src/engine/types.ts";
import { createLogger } from "../../src/log/logger.ts";
import { nextFire, parseCron } from "../../src/triggers/cron.ts";
import { buildTrigger, fireTrigger } from "../../src/triggers/service.ts";
import { openTestStore, testAgentDefinition } from "../helpers/store.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { fileToolContext } from "../helpers/tool-context.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function doc(name: string): Promise<string> {
  return readFile(join(ROOT, name), "utf8");
}

/** The text of a `## heading` section, up to the next `## ` heading. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n## ${heading}\n`);
  assert.ok(start >= 0, `section "${heading}" exists`);
  const end = text.indexOf("\n## ", start + 1);
  return text.slice(start, end === -1 ? undefined : end);
}

/** Markdown wraps lines; compare with every run of whitespace as one space. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

function code(error: unknown): string | undefined {
  return isRunwrightError(error) ? error.code : undefined;
}

test("the docs state that the idempotency key is looked up before anything that can change", async () => {
  const api = flat(section(await doc("docs/api.md"), "Idempotency"));
  assert.match(api, /\*\*The key is looked up first\.\*\* With a key, the server computes the fingerprint from the body as sent and asks the store for the run this key already started \(`findIdempotentRun`, which reads the run's row by the key's digest and nothing else\) before it reads the agent, its revision, its workflow or the secrets/);
  assert.match(api, /A request whose key already has a run is answered with that run \(200, `created: false`\), or with 409 `idempotency_mismatch` when the fingerprints differ, and nothing else is read or checked/);
  assert.match(api, /Only a request with an unused key goes on: the revision is read \(404\), the input is redacted, `data` is validated against that revision's workflow input schema \(400\), and the run is created on that revision/);
  assert.match(api, /a repeat returns the same run whatever changed in between: secrets added, deleted or rotated, a new agent revision, another workflow input schema, a restart\. The run stays pinned to the revision it started with/);
  const notes = flat(section(await doc("docs/api.md"), "Routes"));
  assert.match(notes, /With an idempotency key the key is looked up first, and a key that already started a run is answered with that run before anything below happens/);
  assert.match(notes, /The run is pinned to the revision its data was validated against, also when no `revision` was sent/);
  const store = flat(section(await doc("docs/architecture.md"), "The store"));
  assert.match(store, /Next to `createRun` the store has `findIdempotentRun\(\{idempotencyKey, requestFingerprint\?, strictIdempotency\?\}\)`/);
  assert.match(store, /The route `POST \/v1\/runs` and the store wrapper `redactingStore` call `findIdempotentRun` before anything else, and the store's `fireTrigger` begins its transaction with the same lookup \(invariant I2\)/);
  assert.match(store, /\*\*nothing that can change between two identical requests \(which secrets exist, the agent's current revision, its workflow or schema, whether a trigger is enabled\) is read before the key lookup\*\*/);
  const security = flat(section(await doc("docs/security.md"), "Redaction"));
  assert.match(security, /`POST \/v1\/runs` looks the idempotency key up first: a request whose key already started a run is answered with that run \(or 409 `idempotency_mismatch`\) before any secret, revision or schema is read/);
  assert.match(security, /its `createRun` asks `findIdempotentRun` first/);
  // The route code asks the store first: the lookup precedes the revision read.
  const route = await readFile(join(ROOT, "src/server/routes/runs.ts"), "utf8");
  const lookup = route.indexOf("const existing = await started();");
  const revision = route.indexOf("deps.store.getRevision(agentId, revisionNumber)");
  assert.ok(lookup > 0 && revision > lookup, "POST /v1/runs looks the key up before it reads the revision");
});

test("findIdempotentRun returns the run createRun made for the key, refuses another request, and pins the revision", async (t) => {
  const { store } = await openTestStore(t);
  const saved = await store.saveAgent({ id: "docs-agent", definition: testAgentDefinition() });
  assert.equal(saved.revision.revision, 1);
  const input = { message: "go", data: { env: "prod" } };
  const fingerprint = requestFingerprint({ agentId: "docs-agent", input });
  assert.equal(await store.findIdempotentRun({ idempotencyKey: "k-docs", requestFingerprint: fingerprint }), null, "an unused key");
  const first = await store.createRun({ agentId: "docs-agent", input, idempotencyKey: "k-docs", requestFingerprint: fingerprint, revision: 1 });
  assert.equal(first.created, true);
  // A new revision is saved in between: the lookup still answers with the run, which stays on revision 1.
  await store.saveAgent({ id: "docs-agent", definition: testAgentDefinition({ instructions: "Do another job." }) });
  const found = await store.findIdempotentRun({ idempotencyKey: "k-docs", requestFingerprint: fingerprint });
  assert.equal(found?.id, first.run.id);
  assert.equal(found?.revision, 1);
  const again = await store.createRun({ agentId: "docs-agent", input, idempotencyKey: "k-docs", requestFingerprint: fingerprint, revision: 1 });
  assert.equal(again.created, false);
  assert.equal(again.run.id, first.run.id);
  // The same key with a different request: idempotency_mismatch, from the lookup and from createRun alike.
  const other = requestFingerprint({ agentId: "docs-agent", input: { message: "go", data: { env: "staging" } } });
  await assert.rejects(store.findIdempotentRun({ idempotencyKey: "k-docs", requestFingerprint: other }), (error: unknown) => code(error) === "idempotency_mismatch");
  await assert.rejects(store.createRun({ agentId: "docs-agent", input: { message: "go", data: { env: "staging" } }, idempotencyKey: "k-docs", requestFingerprint: other }),
    (error: unknown) => code(error) === "idempotency_mismatch");
  // A non-strict lookup (trigger fires) does not compare.
  assert.equal((await store.findIdempotentRun({ idempotencyKey: "k-docs", requestFingerprint: other, strictIdempotency: false }))?.id, first.run.id);
  // A new request created with the number of the revision it was validated against is pinned to it.
  const pinned = await store.createRun({ agentId: "docs-agent", input, idempotencyKey: "k-docs-2", revision: 1 });
  assert.equal(pinned.run.revision, 1);
});

test("a redelivered webhook gets its run after the trigger was turned off; a new delivery gets trigger_disabled", async (t) => {
  const api = flat(section(await doc("docs/api.md"), "Routes"));
  assert.match(api, /A webhook delivery that already started a run is answered `202 \{runId, duplicate: true\}` with that run also after the trigger was turned off/);
  assert.match(api, /A new delivery to a disabled trigger, and every `POST \/v1\/triggers\/:id\/fire` on a disabled trigger \(each such request has a key of its own\), get 409 `trigger_disabled`/);
  assert.match(flat(section(await doc("docs/api.md"), "Webhooks")), /also when the trigger was turned off after the first delivery; a new delivery to a disabled trigger gets 409 `trigger_disabled`/);
  assert.match(flat(section(await doc("docs/security.md"), "Webhooks")), /A delivery that already started a run is answered `202 \{runId, duplicate: true\}` with that run also after the trigger was turned off/);
  assert.match(flat(section(await doc("docs/architecture.md"), "Triggers")), /In order: the key is looked up first, and a fire that already started a run gets that run \(`duplicate`; a redelivered webhook is answered `202 \{runId, duplicate: true\}`\), also when the trigger has been turned off or edited since/);
  assert.match(flat(section(await doc("docs/reference.md"), "Security notes")), /a redelivery is answered with the run the first delivery started \(`duplicate: true`\), also after the trigger was turned off, and a new delivery to a disabled trigger is refused \(409\)/);
  const clock = createFakeClock(Date.UTC(2026, 10, 1));
  const { store } = await openTestStore(t, { clock });
  await store.saveAgent({ id: "hooked", definition: testAgentDefinition() });
  const trigger = buildTrigger({ name: "hook", kind: "webhook", agentId: "hooked", message: "delivered", webhook: { secretName: "HOOK" }, limits: { maxCostMicros: 1000 } },
    { ids: createIdSource({ clock }), clock });
  await store.saveTrigger(trigger);
  const fire = { dedupeKey: `webhook:${trigger.id}:d-1`, kind: "webhook" as const, data: { delivery: "d-1", body: { a: 1 } } };
  const first = await fireTrigger({ store, clock }, trigger, fire);
  assert.equal(first.created, true);
  const disabled = { ...trigger, enabled: false };
  await store.saveTrigger(disabled);
  const again = await fireTrigger({ store, clock }, disabled, fire);
  assert.equal(again.created, false);
  assert.equal(again.run.id, first.run.id);
  await assert.rejects(fireTrigger({ store, clock }, disabled, { ...fire, dedupeKey: `webhook:${trigger.id}:d-2` }), (error: unknown) => code(error) === "trigger_disabled");
});

function untrustedFinished(key: string, content: string, data: Json, extra?: JsonObject): JournalRecord {
  return {
    runId: "run_docs", seq: 2, epoch: 1, ts: 0, type: "tool.finished", key,
    data: { callId: "c1", tool: "lookup", outcome: "ok", content, data, isError: false, untrusted: true, truncated: false, fullResultPath: null, durationMs: 1, ...extra },
  };
}

const SENTENCE = "the deploy key rotates every ninety days at the central office in Lisbon";
const OWN = { path: "notes/own.md", name: "own-note", title: "Own title", description: "own words", body: "nothing copied from anywhere at all here" };
const COPY = { path: "notes/copy.md", name: "deploy-rotation", title: "Key rotation", description: "When keys rotate", body: SENTENCE };

test("the provenance docs name structured data, saved data files, webhook payloads and shell, and the code agrees", async (t) => {
  const learning = flat(section(await doc("docs/learning.md"), "Provenance"));
  assert.match(learning, /for every `tool\.finished` record marked `untrusted`: its \*\*content\*\* and its \*\*structured `data`\*\*/);
  assert.match(learning, /Untrusted results are those of tools declared `untrustedOutput` \(`web_fetch`, `shell`, and host tools that say so\), `read_file` results of files that were saved from an untrusted result \(under `\.runwright\/tool-results\/untrusted\/`\), and every other `read_file` result whose bytes the journal does not show the run itself left there/);
  assert.match(learning, /every string value on its own, all string values joined in document order, and the keys with their scalar values \(numbers and booleans as their JSON text\) in document order \(`structuredTexts`\)/);
  assert.match(learning, /the saved structured data of an untrusted result whose data was over the size limit \(`fullDataPath`/);
  assert.match(learning, /the payload of a webhook delivery: for a `run\.created` record whose trigger is a webhook, the run's input `data` \(`\{delivery, body\}`\)/);
  assert.match(learning, /Runs started through the API, by `triggers fire` or by cron contribute nothing here/);
  assert.match(learning, /\*\*What provenance does not track\.\*\*/);
  assert.match(learning, /text a caller with the API token sends: the first message, the run's `data`, later messages and answers to questions/);
  assert.match(learning, /untrusted text written back by the model: the file rule compares content by SHA-256, so a model that reads an untrusted file and writes the same text back with `write_file` produces a file that reads as trusted\. The text itself is already in the corpus from the untrusted read and is still matched there/);
  assert.match(learning, /file names: `list_files` reports names, types and sizes only and its result is trusted, so a file name chosen by a download is not tracked/);
  assert.doesNotMatch(learning, /files that `shell` or a host tool wrote into the workspace and that are later read with `read_file`/);
  assert.match(learning, /paraphrase: the comparison is lexical, so reworded untrusted text is not recognised\. The grader is the second check, and it can only make a verdict stricter, never upgrade a provenance verdict/);
  assert.match(flat(section(await doc("docs/security.md"), "`shell`")), /Its output is marked \*\*untrusted\*\* \(the tool is declared `untrustedOutput`\)/);
  assert.match(flat(section(await doc("docs/reference.md"), "How it fits together")), /the content and the structured data of results of tools declared untrusted \(`web_fetch`, `shell`, host tools that say so\) and a webhook delivery's payload/);
  const readmeSecurity = flat(section(await doc("docs/reference.md"), "Security notes"));
  assert.match(readmeSecurity, /\*\*What learning's provenance check does not track:\*\* text an API caller sends \(messages, `data`, answers\), untrusted text the model itself writes back into a file with `write_file` \(it is still matched where the run first read it\), file names, and paraphrase \(the check is lexical\); a paraphrase is still not kept automatically, because in a run that read untrusted content an item whose text the journal cannot prove is the run's own or a person's is held for a person/);
  assert.match(readmeSecurity, /A file that `shell` or a host tool wrote and that the run reads with `read_file` is tracked: its result is untrusted unless the journal shows the run itself left those bytes there/);
  assert.doesNotMatch(readmeSecurity, /files that `shell` or a host tool wrote and that are read back with `read_file`, and paraphrase/);
  assert.match(flat(section(await doc("docs/reference.md"), "How it fits together")), /every `read_file` result whose bytes the journal does not show the run itself left in the file/);

  assert.equal(createShellTool({ timeoutMs: 1000, outputBytes: 1024 }).untrustedOutput, true, "shell is declared untrustedOutput");
  // structuredTexts: each string, all strings joined, keys with scalars, in document order.
  assert.deepEqual(structuredTexts({ a: "one two", b: ["three", 4, true, null] }), ["one two", "three", "one two\nthree", "a\none two\nb\nthree\n4\ntrue"]);
  // The text in the data of an untrusted result: an item that copies it is dropped.
  const workspace = await makeTempDir(t, "runwright-docs-corpus-");
  const inData = [untrustedFinished("n1#1", "fetched", { page: { text: SENTENCE } })];
  const [copied, own] = await assessProvenance([COPY, OWN], inData, workspace);
  assert.equal(copied?.verdict, "drop");
  assert.equal(`${own?.verdict}/${own?.field}`, "hold/origin", "rule T: the run read untrusted data and nothing proves the note's text");
  // The same data from a trusted tool is not in the corpus.
  const trusted: JournalRecord = { ...inData[0] as JournalRecord, data: { ...(inData[0] as JournalRecord).data, untrusted: false } };
  assert.equal((await assessProvenance([COPY], [trusted], workspace))[0]?.verdict, "keep");
  // A webhook delivery's payload, as the store journals it: an item that copies it is not kept; cron and API runs are not tracked.
  const clock = createFakeClock(Date.UTC(2026, 10, 1));
  const { store } = await openTestStore(t, { clock });
  await store.saveAgent({ id: "hooked", definition: testAgentDefinition() });
  const verdictFor = async (trigger: { id: string; kind: "webhook" | "cron" } | null, key: string): Promise<string | undefined> => {
    const { run } = await store.createRun({
      agentId: "hooked", input: { message: "", data: { delivery: "d-1", body: { note: SENTENCE } } }, idempotencyKey: key,
      ...(trigger === null ? {} : { trigger }),
    });
    const journal = await store.readJournal(run.id);
    assert.equal(journal[0]?.type, "run.created");
    return (await assessProvenance([COPY], journal, workspace))[0]?.verdict;
  };
  assert.notEqual(await verdictFor({ id: "trg_hook", kind: "webhook" }, "w-1"), "keep");
  assert.equal(await verdictFor({ id: "trg_cron", kind: "cron" }, "c-1"), "keep");
  assert.equal(await verdictFor(null, "api-1"), "keep");
});

test("the learning digest marks the node line of a workflow tool node whose result is untrusted", async () => {
  assert.match(flat(section(await doc("docs/learning.md"), "The proposal")),
    /The node line of a workflow `tool` node whose tool result is untrusted is marked too \(`\[node <name>\] \[untrusted\] …`\)/);
  const node = (key: string, name: string): JournalRecord => ({ runId: "run_docs", seq: 3, epoch: 1, ts: 0, type: "node.finished", key, data: { name, value: { ok: true } } });
  const digest = buildDigest([untrustedFinished("wf/fetch#1", "page", null), node("wf/fetch", "fetch"), node("wf/other", "other")], "go", null);
  assert.match(digest, /\[node fetch\] \[untrusted\] /);
  assert.match(digest, /\[node other\] \{/);
});

test("the result size limit covers structured data with the note, file name and journal fields the docs give", async (t) => {
  const architecture = flat(section(await doc("docs/architecture.md"), "Tool calls: started, finished, interrupted"));
  const documented = /this note is appended to the content, after the truncation note when there is one: `(\\n\[data omitted: <bytes> bytes of structured data; saved to <path>\])`/.exec(architecture);
  assert.ok(documented !== null, "the note is documented");
  for (const phrase of [
    "**`<folder>/<label>-<key16>-<sha256>.txt`**",
    "**`<folder>/<label>-<key16>-<sha256>.data.json`**",
    "**A file's name contains the digest of its own bytes, so two results share a file only when they are byte for byte the same**",
    "**`link()`, which never replaces an existing file**",
    "**A name is at most 132 bytes long however long the step key is.**",
    "**If the file cannot be saved, the call throws an `internal` error and no cut result is journalled without its file.**",
    "**The limit applies to every `tool.finished`, also to denied, invalid, unknown and skipped calls.**",
    "**cut by the same size limit as any other result**",
    "**Declaring a tool `idempotent` is a promise about exactly this case: run again with the same arguments after it already took effect, it returns a result that is not an error and leaves the same end state.**",
    "**`delete_file` reports a file that is already absent as a success (`deleted: false`), not as an error**",
  ]) assert.ok(architecture.includes(phrase), phrase);
  assert.ok(!/<serial>-<key>\.(txt|data\.json)/.test(architecture), "the old names are not documented as current");
  const journal = flat(section(await doc("docs/architecture.md"), "Journal records"));
  assert.match(journal, /also `fullDataPath` \(the workspace-relative path of the file holding its canonical JSON\), `fullDataSha256` \(lower-case hex SHA-256 of that file's bytes\) and `fullDataBytes` \(its length\)/);
  assert.match(flat(await doc("docs/workflows.md")), /when the canonical JSON of `data` is over the limit, `data` is `null` and the content carries the note `\[data omitted: <bytes> bytes of structured data; saved to <path>\]`/);
  assert.ok(flat(await doc("docs/configuration.md")).includes(
    "holds the full text of truncated tool results (`<label>-<key16>-<sha256>.txt`) and the structured data of results whose data was over the size limit (`<label>-<key16>-<sha256>.data.json`), under `untrusted/` for untrusted results",
  ));
  const workspace = await makeTempDir(t, "runwright-docs-data-");
  await claimWorkspaceStage(workspace, 1);
  const data = { rows: Array.from({ length: 20 }, (_, i) => `row ${i}`) };
  const shaped = await limitToolResult({ workspace, epoch: 1, key: "t1.c0", limitBytes: 64, outcome: "ok", content: "short", data, isError: false, untrusted: true });
  assert.equal(shaped.data, null);
  const bytes = await readFile(join(workspace, shaped.fullDataPath ?? ""));
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.equal(shaped.fullDataPath, `.runwright/tool-results/untrusted/${savedResultName("t1.c0", digest)}.data.json`);
  assert.deepEqual(JSON.parse(bytes.toString("utf8")), data);
  assert.equal(shaped.fullDataBytes, bytes.length);
  assert.equal(shaped.fullDataSha256, digest);
  const note = (documented[1] as string).replace("\\n", "\n").replace("<bytes>", String(bytes.length)).replace("<path>", shaped.fullDataPath ?? "");
  assert.equal(shaped.content, `short${note}`);
  // Trusted results go to the folder without untrusted/.
  const plain = await limitToolResult({ workspace, epoch: 1, key: "t/2", limitBytes: 64, outcome: "ok", content: "short", data, isError: false, untrusted: false });
  assert.equal(plain.fullDataPath, `.runwright/tool-results/${savedResultName("t/2", digest)}.data.json`);
  // Two keys that read alike, finishing together, keep two files; a 400-character key gives a short name.
  const [left, right] = await Promise.all(["wf/a[0]/b#1", "wf/a_0__b#1"].map((key, i) => limitToolResult({
    workspace, epoch: 1, key, limitBytes: 16, outcome: "ok", content: String(i).repeat(100), data: null, isError: false, untrusted: false,
  })));
  assert.ok(left !== undefined && right !== undefined && left.fullResultPath !== right.fullResultPath);
  assert.equal(await readFile(join(workspace, left.fullResultPath ?? ""), "utf8"), "0".repeat(100));
  assert.equal(await readFile(join(workspace, right.fullResultPath ?? ""), "utf8"), "1".repeat(100));
  const long = await limitToolResult({
    workspace, epoch: 1, key: `${`wf/${"n".repeat(60)}[0]/`.repeat(6)}x#1`, limitBytes: 16, outcome: "ok", content: "z".repeat(100), data, isError: false, untrusted: false,
  });
  for (const path of [long.fullResultPath ?? "", long.fullDataPath ?? ""]) assert.ok(Buffer.byteLength(path.split("/").pop() ?? "") <= 132, path);
});

/** Every `U+XXXX` and `U+XXXX–U+YYYY` named in a text, as inclusive ranges. */
function namedRanges(text: string): [number, number][] {
  return [...text.matchAll(/U\+([0-9A-F]{4,6})(?:–U\+([0-9A-F]{4,6}))?/g)].map((m) => {
    const from = parseInt(m[1] as string, 16);
    return [from, m[2] === undefined ? from : parseInt(m[2], 16)];
  });
}

test("every code point the hidden-character rule names is reported, with the documented exception", async () => {
  const learning = await doc("docs/learning.md");
  const from = learning.indexOf("- **a hidden or bidirectional-control character**");
  const to = learning.indexOf("A proposal that does not have the shape");
  assert.ok(from >= 0 && to > from, "the hidden-character rule is documented");
  const rule = learning.slice(from, to);
  const exceptionAt = rule.indexOf("One exception:");
  assert.ok(exceptionAt > 0, "the exception is documented");
  const ranges = namedRanges(rule.slice(0, exceptionAt));
  assert.ok(ranges.length >= 20, "the rule names its ranges");
  for (const [low, high] of ranges) {
    for (let point = low; point <= high; point++) {
      assert.deepEqual(findHiddenCharacters(`a${String.fromCodePoint(point)}b`), [point], `U+${point.toString(16).toUpperCase()}`);
    }
  }
  for (const point of [0x061c, 0x180e, 0x2028, 0x2029, 0x2065, 0x115f, 0x1160, 0x3164, 0xffa0, 0xfff9, 0xfffb]) {
    assert.ok(ranges.some(([low, high]) => point >= low && point <= high), `the docs name U+${point.toString(16).toUpperCase()}`);
  }
  assert.deepEqual(findHiddenCharacters("tab\tline\ncarriage\r"), []);
  const flatRule = flat(rule);
  assert.match(flatRule, /One exception: U\+FE0E or U\+FE0F directly after a pictographic character \(Unicode property `Extended_Pictographic`\) is not reported/);
  assert.match(flatRule, /A variation selector anywhere else is reported, a second one after an allowed one included/);
  assert.deepEqual(findHiddenCharacters("⚠️"), []);
  assert.deepEqual(findHiddenCharacters("⚠︎"), []);
  assert.deepEqual(findHiddenCharacters("a️"), [0xfe0f]);
  assert.deepEqual(findHiddenCharacters("⚠️️"), [0xfe0f]);
});

test("the docs say allowing unpriced models does not switch off the cap, as checkSpend applies it", async () => {
  const readme = flat(section(await doc("docs/reference.md"), "Control and cost"));
  assert.match(readme, /Allowing unpriced models does not switch off the cap: it counts the unpriced calls' cost as zero, and every priced call of the run is still admitted only when `known spend \+ reservations \+ its worst case <= cap`; when that does not fit, the run pauses with `reason: "cap"`/);
  assert.match(readme, /The overshoot bound then holds for the known cost/);
  assert.match(readme, /A run that already has an unknown cost stays `unknown` \(and over a cap unless allowed\) even if a price is configured later/);
  const configuration = flat(section(await doc("docs/configuration.md"), "Prices"));
  assert.match(configuration, /Allowing unpriced models does not switch off the cap\. It lets calls to unpriced models run and counts their cost as zero/);
  assert.match(configuration, /`nextCallWorstCaseMicros` is `null` when the next call is unpriced and the known spend alone is over the cap/);
  const policy = flat(section(await doc("docs/architecture.md"), "Policy, caps and budgets"));
  assert.match(policy, /makes the unknown part of the cost count as zero and does not switch the cap off/);
  assert.match(policy, /When unpriced models are allowed, this is a bound on the known cost/);
  assert.match(flat(await doc("docs/api.md")), /`allowUnpriced: true` lets calls to unpriced models run under a cap and counts their cost as zero; it does not switch the cap off/);
  assert.match(flat(await doc("docs/cli.md")), /`--allow-unpriced` lets calls to unpriced models run under a cap, their cost counted as zero/);
  const base: SpendCheckInput = { capMicros: 100, spentMicros: 10_000, reservedMicros: 0, worstCaseMicros: 5_000, costUnknown: true, allowUnpriced: true, model: "scripted/scripted-1" };
  // The reviewer's probe: known spend and the next priced call are compared with the cap.
  assert.deepEqual(checkSpend(base), {
    ok: false, detail: { capMicros: 100, spentMicros: 10_000, neededMicros: 14_900, nextCallWorstCaseMicros: 5_000, reason: "cap", model: "scripted/scripted-1" },
  });
  // An unpriced next call, the known spend alone over the cap: cap, with no worst case.
  const unpriced = checkSpend({ ...base, worstCaseMicros: null, model: "scripted/unpriced-1" });
  assert.equal(unpriced.ok, false);
  assert.equal(!unpriced.ok && unpriced.detail["reason"], "cap");
  assert.equal(!unpriced.ok && unpriced.detail["nextCallWorstCaseMicros"], null);
  assert.equal(!unpriced.ok && unpriced.detail["neededMicros"], 9_900);
  // The unknown part counts as zero while the known part fits.
  assert.deepEqual(checkSpend({ ...base, spentMicros: 10, worstCaseMicros: 50 }), { ok: true });
  assert.deepEqual(checkSpend({ ...base, spentMicros: 10, worstCaseMicros: null }), { ok: true });
  // Sticky unknown: a priced next call of a run that already has an unknown cost is unknown_price unless allowed.
  const sticky = checkSpend({ ...base, spentMicros: 10, worstCaseMicros: 50, allowUnpriced: false });
  assert.equal(!sticky.ok && sticky.detail["reason"], "unknown_price");
  assert.equal(!sticky.ok && sticky.detail["neededMicros"], null);
});

function fires(expression: string, fromMs: number, count: number): string[] {
  const schedule = parseCron(expression);
  const out: string[] = [];
  let at = fromMs;
  for (let i = 0; i < count; i++) {
    const next = nextFire(schedule, at, "UTC");
    assert.ok(next !== null);
    out.push(new Date(next).toISOString().slice(0, 10));
    at = next;
  }
  return out;
}

test("each documented cron day example fires on the days the docs name", async () => {
  const cron = flat(section(await doc("docs/configuration.md"), "Triggers"));
  assert.match(cron, /\*\*Day rule\.\*\* A day field is \*restricted\* when its text does not start with `\*`\. When \*\*both\*\* day fields are restricted, a day matches if either field holds it; in every other case it matches only if both fields hold it/);
  assert.match(cron, /\| `0 0 \*\/2 \* \*` \| days 1, 3, 5, … 31 of every month \(the step restarts at 1 each month, so the 31st is followed by the 1st\) \|/);
  assert.match(cron, /\| `0 0 \* \* \*\/2` \| Sunday, Tuesday, Thursday and Saturday \|/);
  assert.match(cron, /\| `0 0 \*\/2 \* 1` \| Mondays that fall on an odd day of the month/);
  assert.match(cron, /\| `0 0 13 \* 5` \| the 13th of every month and every Friday \(both fields restricted: either\) \|/);
  // */2 in day-of-month: odd days; the reviewer's probe, and the 31st followed by the 1st.
  assert.deepEqual(fires("0 0 */2 * *", Date.UTC(2026, 10, 1), 2), ["2026-11-03", "2026-11-05"]);
  assert.deepEqual(fires("0 0 */2 * *", Date.UTC(2026, 11, 29), 3), ["2026-12-31", "2027-01-01", "2027-01-03"]);
  // */2 in day-of-week: Sunday, Tuesday, Thursday, Saturday (1 November 2026 is a Sunday).
  const weekdays = fires("0 0 * * */2", Date.UTC(2026, 10, 1) - 1, 8).map((d) => new Date(`${d}T00:00:00Z`).getUTCDay());
  assert.deepEqual(weekdays, [0, 2, 4, 6, 0, 2, 4, 6]);
  // */2 with a Monday: only Mondays on an odd day of the month.
  const mondays = fires("0 0 */2 * 1", Date.UTC(2026, 10, 1), 6);
  for (const day of mondays) {
    const date = new Date(`${day}T00:00:00Z`);
    assert.equal(date.getUTCDay(), 1, day);
    assert.equal(date.getUTCDate() % 2, 1, day);
  }
  assert.deepEqual(mondays.slice(0, 3), ["2026-11-09", "2026-11-23", "2026-12-07"]);
  // 13 and Friday: either. 4 December 2026 is a Friday that is not the 13th; 13 December 2026 is a Sunday.
  assert.deepEqual(fires("0 0 13 * 5", Date.UTC(2026, 11, 1), 4), ["2026-12-04", "2026-12-11", "2026-12-13", "2026-12-18"]);
  assert.equal(new Date(Date.UTC(2026, 11, 13)).getUTCDay(), 0);
  assert.equal(new Date(Date.UTC(2026, 11, 4)).getUTCDate(), 4);
});

test("the file provenance rule (Rule T) is documented where readers look, and the file tools agree", async (t) => {
  const learning = flat(section(await doc("docs/learning.md"), "Provenance"));
  assert.match(learning, /\*\*Which file reads are the run's own work\.\*\* A `read_file` result is untrusted unless the journal proves that the run itself left those bytes in the file/);
  assert.match(learning, /`write_file` and `edit_file` journal `data\.sha256`, the SHA-256 of the bytes they left in the file, and `read_file` journals `data\.sha256` of the bytes of the whole file it read \(also when `offset` and `limit` return a part\)/);
  assert.match(learning, /either is a `write_file` or `edit_file` result with that digest, or carries it as `fullResultSha256` or `fullDataSha256` \(a file the engine saved for a trusted result\)/);
  assert.match(learning, /An `edit_file` of a file that was not trusted by this rule journals its own result untrusted/);
  assert.match(learning, /A host tool cannot vouch for a file it writes: only the built-in `write_file` and `edit_file` can/);
  const security = flat(section(await doc("docs/security.md"), "Workspace confinement"));
  assert.match(security, /\*\*A file's content is the run's own work only when the journal says so\.\*\* `read_file` marks its result untrusted unless the run's journal shows that the run itself left exactly those bytes/);
  assert.match(security, /\(\[learning\.md\]\(learning\.md#provenance\) states the rule and its limits\)/);
  const shell = flat(section(await doc("docs/security.md"), "`shell`"));
  assert.match(shell, /A file a command writes into the workspace is not the run's own work either: reading it back with `read_file` gives an untrusted result/);
  assert.doesNotMatch(shell, /Files a command writes into the workspace are not marked/);

  const workspace = await makeTempDir(t, "runwright-docs-rule-t-");
  const journal: JournalRecord[] = [];
  const context = await fileToolContext(workspace, { journal: () => journal });
  const tools = new Map<string, ToolDefinition>(createFileTools({ maxReadBytes: 1024, maxWriteBytes: 1024 }).map((tool) => [tool.name, tool]));
  const call = async (name: string, args: JsonObject) => {
    const output = await (tools.get(name) as ToolDefinition).handler(args, context);
    journal.push({
      runId: "run_docs", seq: journal.length + 1, epoch: 1, ts: 0, type: "tool.finished", key: `t${journal.length}`,
      data: { callId: "c", tool: name, outcome: "ok", content: output.content, data: output.data ?? null, isError: output.isError === true, untrusted: output.untrusted === true, truncated: false, fullResultPath: null, durationMs: 1 },
    });
    return output;
  };
  await writeFile(join(workspace, "downloaded.txt"), SENTENCE);
  assert.equal((await call("read_file", { path: "downloaded.txt" })).untrusted, true, "a downloaded file reads as untrusted");
  assert.equal((await call("edit_file", { path: "downloaded.txt", old_text: "Lisbon", new_text: "Porto" })).untrusted, true, "its edit stays untrusted");
  assert.equal((await call("read_file", { path: "downloaded.txt" })).untrusted, true);
  await call("write_file", { path: "own.txt", content: "own words" });
  const own = await call("read_file", { path: "own.txt", offset: 0, limit: 1 });
  assert.equal(own.untrusted, undefined, "the run's own file reads as trusted");
  assert.equal((own.data as JsonObject)["sha256"], createHash("sha256").update("own words").digest("hex"));
  // The documented limit: the same text written back by the model reads as trusted, and the untrusted read is in the corpus.
  await call("write_file", { path: "copy.txt", content: SENTENCE.replace("Lisbon", "Porto") });
  assert.equal((await call("read_file", { path: "copy.txt" })).untrusted, undefined);
  assert.equal((await assessProvenance([{ ...COPY, body: SENTENCE.replace("Lisbon", "Porto") }], journal, workspace))[0]?.verdict, "drop");
});

test("the web_fetch time limit is documented to cover address resolution, and the tool agrees", async () => {
  const ssrf = flat(section(await doc("docs/security.md"), "SSRF guard (`web_fetch`)"));
  assert.match(ssrf, /The time limit bounds the whole call: resolving the address, connecting, waiting for the response headers, reading the body, and every redirect hop\. A call over it ends with `fetch_failed: timed out after <n> ms`/);
  assert.match(ssrf, /A pause, a cancel or a forced shutdown ends the call in any of these phases too \(a stalled DNS resolver included\), and a run that is already stopping does not resolve the address at all/);
  const lookups: string[] = [];
  const tool = createWebFetchTool({
    timeoutMs: 60, maxBytes: 100, maxRedirects: 1,
    lookup: (host) => { lookups.push(host); return new Promise(() => undefined); },
    transport: () => Promise.reject(new Error("never connects")),
  });
  const context = (signal: AbortSignal): ToolContext => ({
    runId: "run_docs", agentId: "agent_docs", workspace: "/nonexistent", signal,
    logger: createLogger({ write: () => undefined }), secrets: {}, steps: { journal: () => [] } as unknown as RunContext,
  });
  const started = Date.now();
  assert.equal((await tool.handler({ url: "http://stalled.example/" }, context(new AbortController().signal))).content, "fetch_failed: timed out after 60 ms");
  assert.ok(Date.now() - started < 2000);
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(tool.handler({ url: "http://stalled.example/" }, context(stopped.signal)), (e: unknown) => code(e) === "aborted");
  assert.deepEqual(lookups, ["stalled.example"], "a run that is already stopping does not resolve");
});
