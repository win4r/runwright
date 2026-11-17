/**
 * The docs say what the code does about the things a run must keep fixed for its whole life: which secrets its
 * redactor knows, what identifies an idempotent request, and what counts as evidence for a learning verdict.
 * Each documented rule is checked against the module that implements it.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalJson, sha256Hex, type Json, type JsonObject } from "../../src/core/json.ts";
import { createGrowingRedactor } from "../../src/core/redact.ts";
import { limitToolResult } from "../../src/engine/results.ts";
import { assessProvenance } from "../../src/learning/provenance.ts";
import { redactCommitBatch } from "../../src/store/batch-redaction.ts";
import { idempotencyDigest, requestFingerprint } from "../../src/store/idempotency.ts";
import type { CommitBatch, JournalRecord } from "../../src/store/types.ts";
import { createFileTools } from "../../src/tools/fs.ts";
import { claimWorkspaceStage } from "../../src/tools/workspace-stage.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import type { WorkflowDocument } from "../../src/workflow/types.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { fileToolContext } from "../helpers/tool-context.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function doc(name: string): Promise<string> {
  return readFile(join(ROOT, name), "utf8");
}

async function allDocs(): Promise<{ name: string; text: string }[]> {
  const names = ["README.md", ...(await readdir(join(ROOT, "docs"))).filter((n) => n.endsWith(".md")).map((n) => `docs/${n}`)];
  return Promise.all(names.map(async (name) => ({ name, text: await doc(name) })));
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

test("the idempotency docs give the digest form the store uses and compare the request as sent", async () => {
  const api = flat(section(await doc("docs/api.md"), "Idempotency"));
  assert.match(api, /A key is stored, and returned in `run\.idempotencyKey`, only as `sha256:<hex digest of the key>`/);
  assert.match(api, /The key's text is never stored/);
  const sample = /the key `k-1` is reported as `(sha256:[0-9a-f]{64})`/.exec(api);
  assert.ok(sample !== null, "the docs show a sample digest");
  assert.equal(sample[1], idempotencyDigest("k-1"));
  assert.equal(idempotencyDigest("k-1"), `sha256:${createHash("sha256").update("k-1", "utf8").digest("hex")}`);
  assert.match(api, /the fingerprint of the request \*\*as sent\*\* is equal/);
  assert.match(api, /taken before the input is redacted \(`requestFingerprint`\)/);
  assert.match(api, /Adding, deleting or rotating a secret, or restarting the server, never changes whether two requests are the same/);
  assert.match(api, /`cron:<trigger>:<time>`, `webhook:<trigger>:<delivery>`/);
  // The documented formula is the code's: defaults included, and independent of anything but the request.
  const sent = { agentId: "a1", input: { message: "", data: null } };
  assert.equal(requestFingerprint(sent), sha256Hex(canonicalJson({ agentId: "a1", revision: null, input: { message: "", data: null }, limits: null })));
  assert.notEqual(requestFingerprint(sent), requestFingerprint({ ...sent, input: { message: "[redacted]", data: null } }));
  const records = flat(section(await doc("docs/api.md"), "Records"));
  assert.match(records, /idempotencyKey \(`"sha256:<64 hex>"`, the digest of the key the run was created with, never its text; `null` without a key\)/);
  const store = flat(section(await doc("docs/architecture.md"), "The store"));
  assert.match(store, /`idempotencyDigest\(key\)` = `sha256:<hex SHA-256 of the key>`/);
  assert.match(store, /the fingerprint of the request as the caller sent it, before any redaction/);
  assert.match(store, /adding, deleting or rotating a secret, or a restart, never changes the outcome/);
  assert.match(flat(await doc("docs/cli.md")), /in JSON output `run\.idempotencyKey` is the key's digest \(`sha256:<hex>`\), never the key itself/);
  const stale: string[] = [];
  for (const { name, text } of await allDocs()) {
    for (const phrase of [/after its input is redacted/, /over the redacted input/]) if (phrase.test(flat(text))) stale.push(`${name}: ${phrase.source}`);
  }
  assert.deepEqual(stale, []);
});

test("only the migration paragraph mentions the old redacted-sha256 key form, with every step of migration 4", async () => {
  const hits: string[] = [];
  for (const { name, text } of await allDocs()) {
    const count = text.split("redacted-sha256").length - 1;
    if (count > 0) hits.push(`${name}: ${count}`);
  }
  assert.deepEqual(hits, ["docs/architecture.md: 2"]);
  const architecture = await doc("docs/architecture.md");
  const from = architecture.indexOf("**Migrations.**");
  const to = architecture.indexOf("**Idempotent run creation.**");
  assert.ok(from >= 0 && to > from, "the migrations paragraph exists");
  const paragraph = flat(architecture.slice(from, to));
  assert.equal(paragraph.split("redacted-sha256").length - 1, 2, "both mentions are in the migrations paragraph");
  for (const step of [
    /a stored key of the form `redacted-sha256:<64 lower-case hex>` .* becomes `sha256:<the same hex>`/,
    /every other stored key \(the key's literal text\) becomes `sha256:<hex SHA-256 of that text>`/,
    /the run created first \(by `created_at`, then `id`\) keeps it and the others get no key/,
    /the request hash is cleared for every run whose stored input contains the text `\[redacted\]`/,
    /a repeat of such a run's key returns the run without comparing the request/,
    /the unique index `runs_idempotency` is rebuilt/,
    /Known limit: a caller's own key that literally had the form `redacted-sha256:<64 hex>` is read as a digest written by schema version 3/,
  ]) {
    assert.match(paragraph, step);
  }
});

test("the redaction docs name the grader's credential, rotation, the second layer and the restart limit", async () => {
  const security = flat(section(await doc("docs/security.md"), "Redaction"));
  assert.match(security, /learns the credential of \*\*every model the run actually calls\*\*/);
  assert.match(security, /This covers the learning grader's model when `learning\.graderModel` is set and any other model a workflow step names/);
  assert.match(security, /All of this happens before the step's first provider request/);
  assert.match(security, /A key rotated while a run is in progress is registered when the next model step resolves it, and the old value stays registered for the rest of that session/);
  assert.match(security, /replacing each form with `\[redacted:NAME\]`/);
  assert.match(security, /The store wrapper `redactingStore` \(`src\/security\/write-redaction\.ts`\) passes every commit of a run through the process-wide set/);
  assert.match(security, /with the placeholder `\[redacted\]`, after the run's own redactor has run/);
  assert.match(security, /The helper is `redactCommitBatch` \(`src\/store\/batch-redaction\.ts`\)/);
  assert.match(security, /The run session applies its own redactor through the same helper \(`redactCommitBatch\(batch, <the run's redactor>\)`\), so the field list exists once/);
  const session = await readFile(join(ROOT, "src/engine/session.ts"), "utf8");
  assert.match(session, /redactCommitBatch\(batch, this\.redactor\)/, "the session commits through the one field list");
  assert.doesNotMatch(session, /transition\.error\.message|learning\.puts/, "the session keeps no second copy of the field list");
  assert.match(security, /A replaced or deleted secret value is kept sealed as a \*retired value\*/);
  assert.match(security, /for as long as a run that started before the change is unfinished/);
  assert.match(security, /It is loaded into the process-wide set at start-up and whenever a secret of that name is revealed/);
  assert.match(security, /and it appears as `\[redacted\]`/);
  assert.match(security, /It is deleted once every such run has finished: the next `set`, `delete` or start-up prunes it/);
  assert.match(security, /once it is deleted, a process that starts later no longer recognises text containing the old value\. That is the remaining limit/);
  assert.doesNotMatch(security, /nothing knows the old value|keeps no copy/);
  assert.match(security, /A session that starts after the rotation \(the run resumed after a restart, or taken over by another runner\) knows only the current value/);
  // The run's redactor behaves as documented: a rotated value joins the old one under the same name.
  const redactor = createGrowingRedactor({ AGENT_KEY: "agent-key-0001" });
  assert.equal(redactor.add("GRADER_KEY", "grader-key-0001"), true);
  assert.equal(redactor.add("GRADER_KEY", "grader-key-0002"), true);
  assert.deepEqual(redactor.names, ["AGENT_KEY", "GRADER_KEY"]);
  assert.equal(redactor.text("agent-key-0001 grader-key-0001 grader-key-0002"), "[redacted:AGENT_KEY] [redacted:GRADER_KEY] [redacted:GRADER_KEY]");
  const readme = flat(section(await doc("docs/reference.md"), "Security notes"));
  assert.match(readme, /the credential of every model the run actually calls \(the grader's model when `learning\.graderModel` is set, any other model a step names\)/);
  assert.match(readme, /a key rotated during a run is registered when the next model step resolves it/);
  assert.match(readme, /The store wrapper then passes every commit .* through a second, process-wide layer/);
  assert.match(readme, /a replaced or deleted secret value is kept sealed as a retired value for as long as a run that started before the change is unfinished, and is loaded again at start-up, so text containing the old value stays redacted \(`\[redacted\]`\) across a rotation and a restart; once every such run has finished the retired value is deleted/i);
  assert.doesNotMatch(readme, /keeps no copy|nothing knows the old value/);
  assert.match(flat(section(await doc("docs/learning.md"), "The grader")), /The grader model's key is registered with the run's redactor before the grader is called/);
  assert.match(flat(await doc("docs/configuration.md")), /\| `learning\.graderModel` \| .* its key is redacted from the run's records like the agent's own \|/);
});

test("redactCommitBatch redacts exactly the fields the security docs list, records field by field", async () => {
  const security = flat(section(await doc("docs/security.md"), "Redaction"));
  for (const field of [
    "`records[].data`", "`openPendings[].title` and `.detail`", "`resolvePendings[].resolution`",
    "`transition.output` and `transition.error.message`", "`learning.puts[].title`, `.description`, `.body` and `.note`",
    "`learning.promotions[].note` and `.workflow.document`",
  ]) {
    assert.ok(security.includes(field), field);
  }
  assert.match(security, /Record types and keys, usage, counters, limits, consumed commands, pending ids and kinds, item ids and names and workflow names are not touched/);
  assert.doesNotMatch(security, /Record types and keys, usage, counters, limits, consumed commands, ids and names are not touched/);
  assert.match(security, /the field list exists once \(it is `RECORD_FIELDS` in `src\/store\/record-fields\.ts`\)/);
  assert.match(security, /A journal record is redacted by what each field is \(`RECORD_FIELDS` in `src\/store\/record-fields\.ts`, one entry per record type the engine writes\), in one walk over the record as the engine built it/);
  assert.match(security, /\*Runwright's own words\* are written as they are: the field names of a record, enumerated values \(a pending's `kind`, a command's `type`, a stop reason, an outcome, an error code\), ids Runwright generated/);
  assert.match(security, /So a secret whose value happens to be `toolCalls`, `question` or the digits of a limit does not change a record/);
  assert.match(security, /A field the table does not name, and every record of a type the engine does not write \(a host tool's or driver's own record\), is redacted whole/);
  assert.match(security, /never by a name a redaction produced, so the second layer treats every field as the first did/);
  assert.match(security, /so the document that was validated and dry-run is the redacted one and this pass changes nothing/);
  assert.match(security, /If a secret became known between the draft's commit and this one, secrecy wins and the stored document carries the placeholder/);
  assert.match(security, /A name a model must repeat is text: with a secret whose value is, or is contained in, a tool's name, a tool-call id or the name of a tool argument, the journalled call carries the placeholder in place of the name .* answered as an unknown tool \(or as invalid arguments\)/);
  assert.match(security, /At an output boundary \(API responses, SSE events, log lines\) everything is redacted, Runwright's own words included/);
  assert.doesNotMatch(security, /Numbers at rest/);
  const S = "TOPSECRET-0123";
  const W = "question-words";
  const document = { format: "runwright.workflow/v1", name: "w", description: S } as unknown as WorkflowDocument;
  const batch: CommitBatch = {
    records: [
      { type: "note.x", key: `k-${S}`, data: { text: S, [W]: 1 } },
      { type: "pending.opened", key: `k-${S}`, data: { pending: { id: "p", kind: W, stepKey: "s", title: S, detail: { question: S, [S]: W } } } },
    ],
    openPendings: [{ id: `p-${S}`, kind: "question", stepKey: "s", title: S, detail: { question: S, [W]: S } }],
    resolvePendings: [{ id: "p2", resolution: { answer: S, decision: W } }],
    transition: { to: "failed", output: { o: S }, error: { code: "boom", message: S } },
    learning: {
      puts: [{ id: "li_1", kind: "note", name: `n-${S}`, title: S, description: S, body: S, note: S, status: "active", expectedVersion: null }],
      promotions: [{ itemId: "li_1", expectedVersion: 1, note: S, workflow: { name: `w-${S}`, document } }],
    },
  };
  const before = JSON.stringify(batch);
  const redact = (value: string): string => value.split(S).join("[x]").split(W).join("[w]");
  const whole = (value: Json): Json => JSON.parse(JSON.stringify(value).split(S).join("[x]").split(W).join("[w]")) as Json;
  const out = redactCommitBatch(batch, { text: redact, json: <T extends Json>(value: T): T => whole(value) as T, payload: whole });
  assert.equal(JSON.stringify(batch), before, "the input batch is not changed");
  const left = (JSON.stringify(out).match(new RegExp(S, "g")) ?? []).length;
  // Only the untouched record keys, pending id, item name and workflow name still carry the text.
  assert.equal(left, 5);
  assert.equal(out.records[0]?.key, `k-${S}`);
  assert.equal(out.openPendings?.[0]?.id, `p-${S}`);
  assert.equal(out.learning?.puts?.[0]?.name, `n-${S}`);
  assert.equal(out.learning?.promotions?.[0]?.workflow?.name, `w-${S}`);
  // A host record is redacted whole, keys included; an engine record keeps its field names and its kind.
  assert.deepEqual(out.records[0]?.data, { text: "[x]", "[w]": 1 });
  assert.deepEqual(out.records[1]?.data, { pending: { id: "p", kind: W, stepKey: "s", title: "[x]", detail: { question: "[x]", "[x]": "[w]" } } });
  assert.deepEqual(out.openPendings?.[0]?.detail, { question: "[x]", "[w]": "[x]" });
  assert.deepEqual(out.resolvePendings?.[0]?.resolution, { answer: "[x]", decision: W });
});

function truncatedUntrusted(data: JsonObject): JournalRecord {
  return {
    runId: "run_docs", seq: 1, epoch: 1, ts: 0, type: "tool.finished", key: "t1.c0",
    data: { callId: "c1", tool: "web_fetch", outcome: "ok", content: "a fetched page", data: null, isError: false, untrusted: true, truncated: true, durationMs: 1, ...data },
  };
}

test("provenance evidence: the saved file counts only with the journalled digest, otherwise items are held", async (t) => {
  const learning = flat(section(await doc("docs/learning.md"), "Provenance"));
  assert.match(learning, /The journalled content and data of every untrusted result are always in the corpus, also when they were cut or omitted/);
  assert.match(learning, /the journalled path \(`fullResultPath` or `fullDataPath`\) is inside the workspace, the file is opened without following a symbolic link, is a regular file, has exactly `fullResultBytes` \(or `fullDataBytes`\) bytes, and its SHA-256 equals `fullResultSha256` \(or `fullDataSha256`\)/);
  assert.match(learning, /every item whose own verdict would be `keep` is \*\*held\*\* for a person instead, with `field: "evidence"`/);
  assert.match(learning, /no digest in the record, as in journals written before this version/);
  assert.match(learning, /`whole` for a keep; `evidence` for an item held because a saved result could not be verified/);
  assert.match(flat(section(await doc("docs/reference.md"), "How it fits together")), /a saved full result \(or saved over-long structured data\) counts only when its file still matches the SHA-256 journalled with it/);
  const workspace = await makeTempDir(t, "runwright-docs-evidence-");
  const item = { path: "notes/own.md", name: "own-note", title: "Own title", description: "own words", body: "nothing copied from anywhere at all here" };
  // A record from before this version: a saved path but no digest.
  const [old] = await assessProvenance([item], [truncatedUntrusted({ fullResultPath: ".runwright/tool-results/untrusted/1-t1.txt" })], workspace);
  assert.equal(old?.verdict, "hold");
  assert.equal(old?.field, "evidence");
  assert.match(old?.reason ?? "", /^the saved full text of 1 truncated untrusted result is missing or was changed \(\.runwright\/tool-results\/untrusted\/1-t1\.txt: no digest was journalled\); a person decides$/);
  // A record written now, whose file is intact, is verified: the evidence passes, and rule T decides the item.
  await claimWorkspaceStage(workspace, 1);
  const shaped = await limitToolResult({
    workspace, epoch: 1, key: "t1.c0", limitBytes: 16, outcome: "ok", content: "x".repeat(64), data: null, isError: false, untrusted: true,
  });
  assert.equal(shaped.fullResultSha256, createHash("sha256").update(await readFile(join(workspace, shaped.fullResultPath ?? ""))).digest("hex"));
  assert.equal(shaped.fullResultBytes, 64);
  const record = truncatedUntrusted({ fullResultPath: shaped.fullResultPath, fullResultSha256: shaped.fullResultSha256, fullResultBytes: shaped.fullResultBytes });
  assert.equal((await assessProvenance([item], [record], workspace))[0]?.field, "origin");
  const earlier: JournalRecord = {
    runId: "run_docs", seq: 0, epoch: 1, ts: 0, type: "model.finished", key: "m0",
    data: { texts: [item.name, item.title, item.description, item.body] },
  };
  assert.equal((await assessProvenance([item], [earlier, record], workspace))[0]?.verdict, "keep");
  // The same record after the file was rewritten: held for the evidence, proven or not.
  await writeFile(join(workspace, shaped.fullResultPath ?? ""), "y".repeat(64));
  assert.equal((await assessProvenance([item], [record], workspace))[0]?.field, "evidence");
  assert.equal((await assessProvenance([item], [earlier, record], workspace))[0]?.field, "evidence");
  const journal = flat(section(await doc("docs/architecture.md"), "Journal records"));
  assert.match(journal, /also `fullResultSha256` \(lower-case hex SHA-256 of the saved file's bytes\) and `fullResultBytes` \(its length\), absent in older records/);
});

test("the reserved .runwright folder is documented with its error text and as no sandbox", async (t) => {
  const security = flat(section(await doc("docs/security.md"), "Workspace confinement"));
  assert.match(security, /`write_file`, `edit_file` and `delete_file` refuse a path in it with an error result `<path>: \.runwright\/ is reserved for Runwright's own files`; `read_file` and `list_files` still work there/);
  assert.match(security, /decided by which directory it is, not by how the path is spelled/);
  assert.match(security, /\*\*This is not a sandbox:\*\* .* `shell` and host tools can still write there/);
  assert.match(security, /What protects learning is the digest check of saved results/);
  assert.match(flat(section(await doc("docs/architecture.md"), "Tool calls: started, finished, interrupted")), /`read_file` marks what it reads from that folder as untrusted, whatever the spelling of the path/);
  assert.match(flat(await doc("docs/configuration.md")), /`write_file`, `edit_file` and `delete_file` refuse paths in `\.runwright\/` .* this is not a sandbox: `shell` and host tools can still write there/);
  assert.match(flat(section(await doc("docs/reference.md"), "Security notes")), /this is not a sandbox, since `shell` and host tools can still write there/);
  for (const { name, text } of await allDocs()) {
    assert.doesNotMatch(flat(text), /\.runwright\/?`? (folder )?(cannot be written|is immutable)/, name);
  }
  // The tools answer with the documented text.
  const workspace = await makeTempDir(t, "runwright-docs-reserved-");
  await mkdir(join(workspace, ".runwright"));
  await writeFile(join(workspace, ".runwright", "kept.txt"), "kept");
  const tools = new Map<string, ToolDefinition>(createFileTools({ maxReadBytes: 1024, maxWriteBytes: 1024 }).map((tool) => [tool.name, tool]));
  const context = await fileToolContext(workspace);
  const call = (name: string, args: JsonObject) => (tools.get(name) as ToolDefinition).handler(args, context);
  for (const path of [".runwright/kept.txt", ".RUNWRIGHT/new.txt"]) {
    const result = await call("write_file", { path, content: "changed" });
    assert.equal(result.isError, true, path);
    assert.equal(result.content, `${path}: .runwright/ is reserved for Runwright's own files`);
  }
  const read = await call("read_file", { path: ".runwright/kept.txt" });
  assert.notEqual(read.isError, true);
  assert.match(read.content, /kept/);
});
