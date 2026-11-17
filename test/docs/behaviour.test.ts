/**
 * The README and docs state the behaviour the code has, in the places a reader looks for it: the numbers they
 * quote come from the code, every journal record type and error code is documented, and sentences that describe
 * behaviour the code no longer has are gone.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HTTP_STATUS } from "../../src/core/errors.ts";
import type { JsonObject } from "../../src/core/json.ts";
import { MIN_SECRET_BYTES, secretForms } from "../../src/core/redact.ts";
import { promotedWorkflowName } from "../../src/learning/promotion.ts";
import { renderItem, renderLine } from "../../src/learning/proposal.ts";
import { assessProvenance } from "../../src/learning/provenance.ts";
import { isRetryableStatus } from "../../src/models/retry.ts";
import { fetchRejectionBilling } from "../../src/models/sse-parse.ts";
import { FRAMING_ALLOWANCE_TOKENS } from "../../src/models/util.ts";
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from "../../src/store/migrations.ts";
import type { JournalRecord } from "../../src/store/types.ts";

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

test("no README or docs sentence describes the superseded behaviour", async () => {
  const stale = [
    /twice its estimate/, /lets an in-flight tool/, /shorter than 8/, /idempotent on identical/, /renamed into place/,
    /worstCase\(last/, /per 2 UTF-8 bytes/, /graceful-shutdown timeout/,
    // Round 3: providers no longer retry inside one call; promoted workflows are not named after the skill alone;
    // provenance looks at every retained field; the store, not a flag, refuses stranded commands.
    /retry wrapper/, /retried inside the call/, /for each retry of it/, /`skill-<name>`/, /body and the corpus/,
    /requireNoUnconsumed/, /at the start of its next turn/, /`run_workflow` tool \(`\{name, input\}`\)/,
    // Round 4: the idempotency fingerprint is taken from the request as sent; the saved full result is not read
    // on its own word.
    /after its input is redacted/, /over the redacted input/, /the full saved text is read from the workspace/,
    // Round 5: the idempotency key is looked up before anything that can change; allowing unpriced models does
    // not switch off the cap; a stepped star day field constrains the days; the untrusted corpus covers data,
    // shell and webhook payloads; a redelivery to a disabled trigger gets its run.
    /validated before the key is looked up/, /instead of returning the run/, /One limit: the input is redacted/,
    /when both day fields are restricted, a day matches if either matches\./, /lets an unpriced model run under a cap\./,
    /Firing a disabled trigger \(manually or by webhook\) gets 409/, /A disabled trigger starts nothing \(409\)\./,
    /declared `untrustedOutput` \(`web_fetch`\),/, /The untrusted corpus is the content of every `tool\.finished`/,
    /U\+200B–U\+200F, U\+202A–U\+202E, U\+2060–U\+2064/,
    // A provider's retry-after hint is never shortened.
    /capped at ten times/,
  ];
  const hits: string[] = [];
  for (const { name, text } of await allDocs()) {
    for (const pattern of stale) if (pattern.test(flat(text))) hits.push(`${name}: ${pattern.source}`);
  }
  assert.deepEqual(hits, []);
});

test("the worst-case formula quotes the framing allowance the code uses", async () => {
  assert.equal(FRAMING_ALLOWANCE_TOKENS, 1024);
  const readme = flat(section(await doc("docs/reference.md"), "Control and cost"));
  assert.match(readme, /One input token per UTF-8 byte of the serialized request/);
  assert.match(readme, /plus 1 024 framing tokens/);
  assert.match(readme, /`spent \+ reserved \+ worstCase <= cap`/);
  assert.match(readme, /a run's spend never exceeds its cap\*\*, with sequential and with parallel calls/);
  assert.match(readme, /repair call is admitted against the cap on its own/);
  const architecture = flat(await doc("docs/architecture.md"));
  assert.ok(architecture.includes(`FRAMING_ALLOWANCE_TOKENS = ${FRAMING_ALLOWANCE_TOKENS}`));
  assert.match(architecture, /UTF-8 bytes of the serialized request \+ 1 024/);
});

test("the redaction docs quote the byte threshold and every form the redactor replaces", async () => {
  const security = flat(section(await doc("docs/security.md"), "Redaction"));
  assert.ok(security.includes(`MIN_SECRET_BYTES = ${MIN_SECRET_BYTES}`));
  assert.ok(security.includes(`${MIN_SECRET_BYTES} to 16 384 bytes`));
  // A value with every form distinct, so the count of forms is the number the docs must name.
  assert.equal(secretForms("a\"b/c d+?é").length, 6);
  for (const form of ["base64 (padded and unpadded)", "base64url", "percent-encoded", "JSON-string-escaped"]) {
    assert.ok(security.includes(form), form);
  }
  assert.match(security, /secret split across deltas is never sent/);
  const readme = flat(section(await doc("docs/reference.md"), "Security notes"));
  for (const form of ["base64 (padded and unpadded)", "base64url", "percent-encoded", "JSON-string-escaped"]) {
    assert.ok(readme.includes(form), `README: ${form}`);
  }
});

test("every journal record type of the engine is in the journal table of docs/architecture.md", async () => {
  const types = await readFile(join(ROOT, "src/engine/journal-types.ts"), "utf8");
  const map = types.slice(types.indexOf("export interface JournalDataMap"), types.indexOf("export type JournalType"));
  const names = [...map.matchAll(/^ {2}"([a-z_]+\.[a-z_]+)":/gm)].map((m) => m[1] as string);
  assert.ok(names.includes("model.invalid") && names.includes("tool.interrupted"), "the record types were read");
  const table = section(await doc("docs/architecture.md"), "Journal records");
  assert.deepEqual(names.filter((name) => !table.includes(`\`${name}\``)), []);
  const flatTable = flat(table);
  assert.match(flatTable, /`repair: true`/);
  assert.match(flatTable, /`reason` `crash` .*`pause` or `shutdown`/);
  assert.match(flatTable, /`conflicts`/);
});

test("every error code is in the error table of docs/api.md", async () => {
  const api = await doc("docs/api.md");
  assert.deepEqual(Object.keys(HTTP_STATUS).filter((code) => !api.includes(`\`${code}\``)), []);
});

test("the interrupted pending's reason, the deny list recheck and the abort rules are documented", async () => {
  const architecture = flat(await doc("docs/architecture.md"));
  assert.match(architecture, /`\{tool, args, attempt, reason: "crash" \\\| "pause" \\\| "shutdown"\}`/);
  assert.match(architecture, /checks the server deny list .*first attempts, automatic retries .*resumed resumable calls and a person's retry/);
  assert.match(architecture, /\| pause, forced shutdown \| \*\*no `tool\.finished`\*\*/);
  assert.match(flat(await doc("docs/api.md")), /`\{tool, args, attempt, reason\}`/);
  assert.match(flat(await doc("docs/security.md")), /checked again immediately before every handler invocation/);
  assert.match(flat(await doc("docs/configuration.md")), /calls run again or retried after a crash, a pause or a shutdown/);
});

test("learning, retention and trigger rules are documented where readers look for them", async () => {
  const learning = flat(section(await doc("docs/learning.md"), "Versions, history and ETags"));
  assert.match(learning, /fenced commit that journals its `learning\/apply` step/);
  assert.match(learning, /`learning\.applied\.conflicts`/);
  assert.match(learning, /A retired item is never reactivated by a run/);
  assert.match(learning, /Identical content writes nothing/);
  const retention = flat(section(await doc("docs/architecture.md"), "Retention and archival"));
  for (const step of [/`fsync`/, /`link\(\)`, which never replaces an existing file/, /conditional `archiveJournal`/, /`skipped`/, /overlapping `retention archive` processes are safe/]) {
    assert.match(retention, step);
  }
  assert.match(flat(await doc("docs/cli.md")), /may be run while another copy of it runs/);
  assert.match(flat(await doc("docs/configuration.md")), /a deleted trigger is not recreated/);
});

test("retries are documented as attempts the engine admits and charges one by one, with the bound that covers them", async () => {
  const readme = flat(section(await doc("docs/reference.md"), "Control and cost"));
  assert.match(readme, /Every request Runwright sends to a model provider \(a provider \*attempt\*\) is admitted against the cap on its own/);
  assert.match(readme, /charged \*\*nothing\*\* when the provider answered with an HTTP error status or no connection was ever made/);
  assert.match(readme, /its \*\*worst case as an assumed cost\*\* otherwise/);
  assert.match(readme, /the run pauses between attempts with a `spend_cap` pending/);
  assert.match(readme, /bills nothing for a request it refused with an HTTP error status, \*\*a run's spend never exceeds its cap\*\*, with sequential and with parallel calls, retries included/);
  const architecture = flat(section(await doc("docs/architecture.md"), "Model calls: reservations, interruption and repair"));
  for (const rule of [
    /\| `model\.retry \{attempt: n\}` \| attempt `n \+ 1` is admitted and sent \|/,
    /\| `model\.started \{attempt: n\}` with no end \(a crash\) \| .*attempt `n` is sent again \|/,
    /\| `model\.interrupted \{attempt: n\}` with reason `pause` or `shutdown` \| attempt `n` is sent again \|/,
    /\*\*Between attempts nothing is in flight\.\*\* .*nothing charged and nothing written/,
    /deadline that passes during the wait is journalled `model\.failed` with code `deadline_exceeded`/,
    /never makes more than `maxAttempts` failed attempts/,
  ]) {
    assert.match(architecture, rule);
  }
  // The exhausted-retries message the docs quote is the one the engine builds.
  const context = await readFile(join(ROOT, "src/engine/context.ts"), "utf8");
  assert.ok(context.includes("`model call failed after ${attempts} attempt"), "the engine's message");
  assert.ok(context.includes("(last error: ${statusText})"), "the engine's message");
  assert.ok(context.includes(`"no status"`) && context.includes("`status ${status}`"), "the engine's status text");
  assert.match(architecture, /`model call failed after N attempts \(last error: status S \| no status\): <last message>`/);
  const journal = flat(section(await doc("docs/architecture.md"), "Journal records"));
  assert.match(journal, /`attempt`, the 1-based attempt of this call/);
  assert.match(journal, /`\{attempt, delayMs, code, message, status, billing, assumedCostMicros\?\}`, written when the attempt fails, in one commit with its charge/);
  assert.match(journal, /carries `attempts` .* `assumedCostMicros`/);
});

test("the billing table names exactly the failures the providers mark as never sent, and the retryable statuses", async () => {
  const models = flat(section(await doc("docs/configuration.md"), "Models and keys"));
  const codes = ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"];
  for (const code of codes) {
    assert.equal(fetchRejectionBilling(new TypeError("fetch failed", { cause: { code } })), "none", code);
    assert.ok(models.includes(`\`${code}\``), code);
  }
  for (const code of ["ECONNRESET", "UND_ERR_SOCKET", undefined]) {
    assert.equal(fetchRejectionBilling(new TypeError("fetch failed", { cause: { code } })), "unknown", String(code));
  }
  assert.match(models, /\| `fetch` rejected for any other reason \| `model_transient` \| `"unknown"` \|/);
  for (const status of [408, 409, 425, 429, 500, 503, 599]) assert.equal(isRetryableStatus(status), true, String(status));
  for (const status of [400, 401, 403, 404, 422, 600]) assert.equal(isRetryableStatus(status), false, String(status));
  assert.match(models, /\| HTTP 408, 409, 425, 429 or 5xx \| `model_transient` \| `"none"` \|/);
  assert.match(models, /\| any other non-2xx HTTP status \| `model_failed` \| `"none"` \|/);
  assert.match(models, /`models\.retry` is applied by the engine, per attempt/);
  assert.match(flat(await doc("docs/reference.md")), /HTTP 408, 409, 425, 429 and 5xx/);
});

test("redaction at intake, its one choke point and its limits are documented", async () => {
  const security = flat(section(await doc("docs/security.md"), "Redaction"));
  assert.match(security, /\*\*At intake\.\*\* Text that a person or a caller supplies is redacted for every known secret before it is stored/);
  for (const field of ["`message.text`", "`answer.answer`", "trigger messages", "webhook payloads"]) {
    assert.ok(security.includes(field), field);
  }
  // Keys are not redacted at intake: every key is kept only as its digest.
  assert.match(security, /the store keeps every key only as `sha256:<hex digest of the key>`, and the key's text is never stored/);
  assert.match(security, /the store wrapper `redactingStore` \(`src\/security\/write-redaction\.ts`\)/);
  assert.match(security, /re-read from the store for every write/);
  assert.match(security, /placeholder `\[redacted\]`/);
  assert.match(security, /The model therefore sees the placeholder, not the value/);
  assert.match(security, /redacts first, then validates `data` against the workflow's input schema, then creates the run/);
  assert.match(security, /Agent definitions and workflow documents are stored as given/);
  assert.match(security, /a secret first stored \*after\* a text was written/);
  assert.match(security, /rows written by an earlier version of Runwright are not rewritten/);
  const readme = flat(section(await doc("docs/reference.md"), "Security notes"));
  assert.match(readme, /\*\*At intake\*\*, text a caller supplies .* is redacted for every known secret \(`\[redacted\]`\) before it is stored/);
  assert.match(readme, /agent definitions and workflow documents are stored as given/);
  // A refused learning edit is validation_failed, whose status the docs quote.
  assert.equal(HTTP_STATUS.validation_failed, 400);
  assert.match(security, /get 400 `validation_failed` when the text contains a stored secret, a credential-shaped string/);
  const learning = flat(section(await doc("docs/learning.md"), "Versions, history and ETags"));
  assert.match(learning, /are \*\*refused\*\* with 400 `validation_failed`, and nothing is stored/);
  const api = flat(await doc("docs/api.md"));
  assert.match(api, /is refused with 400 `validation_failed`, `details\.problems: \[\{path, keyword, message\}\]` with the field's path/);
  assert.match(api, /The idempotency fingerprint is taken from the request as sent, before redaction/);
  assert.match(api, /The trigger's `message` and `name` are redacted for every known secret when the trigger is saved/);
});

function untrusted(content: string): JournalRecord {
  const data: JsonObject = {
    callId: "c1", tool: "web_fetch", outcome: "ok", content, data: null, isError: false, untrusted: true, truncated: false,
    fullResultPath: null, durationMs: 1,
  };
  return { runId: "run_docs", seq: 1, epoch: 1, ts: 0, type: "tool.finished", key: "t1.c0", data };
}

test("the provenance rules per field are the rules the code applies, at the documented thresholds", async () => {
  const text = flat(section(await doc("docs/learning.md"), "Provenance"));
  for (const rule of [
    /the \*\*name\*\* \(its hyphens separate words\), the \*\*title\*\*, the \*\*description\*\* and the \*\*body\*\*, plus the \*\*whole\*\*/,
    /the \*\*strictest wins\*\* \(`drop` > `hold` > `keep`\)/,
    /\| body \| `overlap >= 0\.5` → \*\*drop\*\* \(`untrusted_origin`\); `overlap >= 0\.2`, or any run of \*\*12 or more consecutive words\*\* found verbatim → \*\*hold\*\* for a person \| found verbatim → \*\*drop\*\* \|/,
    /\| title, description, name \(each on its own\) \| `overlap >= 0\.5` → \*\*drop\*\*; \*\*any\*\* shared 5-word shingle → \*\*hold\*\* \| 2 to 4 words found verbatim → \*\*hold\*\*; 1 word: not assessed \|/,
    /\| whole \| the body rule \| not assessed \|/,
    /`field` names the assessment that decided it/,
  ]) {
    assert.match(text, rule);
  }
  const corpus = "alpha beta gamma delta epsilon zeta eta";
  const journal = [untrusted(corpus)];
  const junk = (n: number): string => Array.from({ length: n }, (_, i) => `junk${i}`).join(" ");
  const item = (path: string, fields: Partial<{ name: string; title: string; description: string; body: string }>) => ({
    path, name: "misc", title: "Own title", description: "own", body: "own words here", ...fields,
  });
  const items = [
    // body: 1 of 5 shingles shared (0.2) → hold; 1 of 6 (below 0.2) → keep; 1 of 2 (0.5) → drop; 3 words found → drop.
    item("notes/b-hold.md", { body: `${corpus.split(" ").slice(0, 5).join(" ")} ${junk(4)}` }),
    item("notes/b-keep.md", { body: `${corpus.split(" ").slice(0, 5).join(" ")} ${junk(5)}` }),
    item("notes/b-drop.md", { body: `${corpus.split(" ").slice(0, 5).join(" ")} ${junk(1)}` }),
    item("notes/b-short.md", { body: "gamma delta epsilon" }),
    // description of 5+ words: one shared shingle (overlap 1/6) is enough to hold it.
    item("notes/d-hold.md", { description: `${corpus.split(" ").slice(0, 5).join(" ")} ${junk(5)}` }),
    // title of 2 words found verbatim → hold; of 1 word → not assessed.
    item("notes/t-hold.md", { title: "Beta Gamma" }),
    item("notes/t-one.md", { title: "Gamma" }),
    // the name's hyphens separate words.
    item("notes/n-hold.md", { name: "delta-epsilon-zeta" }),
    // split across fields: each part alone is at most hold, the whole (3 of 5 shingles) is drop.
    item("notes/w-drop.md", { title: "Alpha", description: "beta", body: "gamma delta epsilon zeta eta qqq rrr" }),
  ];
  const lexical = {
    "notes/b-hold.md": "hold/body", "notes/b-drop.md": "drop/body", "notes/b-short.md": "drop/body",
    "notes/d-hold.md": "hold/description", "notes/t-hold.md": "hold/title", "notes/n-hold.md": "hold/name", "notes/w-drop.md": "drop/whole",
  };
  // Rule T: in a tainted run an item the lexical checks pass is held unless the journal proves its text.
  const unproven = await assessProvenance(items, journal, "/nonexistent-workspace");
  assert.deepEqual(Object.fromEntries(unproven.map((v) => [v.path, `${v.verdict}/${v.field}`])),
    { ...lexical, "notes/b-keep.md": "hold/origin", "notes/t-one.md": "hold/origin" });
  // The same items, every text of which the run journalled before it read the page: the lexical thresholds alone decide.
  const texts = items.flatMap((i) => [i.name, i.title, i.description, i.body]);
  const earlier: JournalRecord = { runId: "run_docs", seq: 0, epoch: 1, ts: 0, type: "model.finished", key: "m0", data: { texts } };
  const proven = await assessProvenance(items, [earlier, ...journal], "/nonexistent-workspace");
  assert.deepEqual(Object.fromEntries(proven.map((v) => [v.path, `${v.verdict}/${v.field}`])),
    { ...lexical, "notes/b-keep.md": "keep/whole", "notes/t-one.md": "keep/whole" });
});

test("the promotion name rule, its ownership and the versioned pointer are documented as the code has them", async () => {
  const text = flat(section(await doc("docs/learning.md"), "Skill promotion"));
  const example = promotedWorkflowName({ id: "li_01JC3M8Z4QF6Y2N7T5W9XKD0AB", name: "deploy-the-static-site" });
  assert.ok(text.includes(`For the skill \`deploy-the-static-site\` with the id \`li_01JC3M8Z4QF6Y2N7T5W9XKD0AB\` it is \`${example}\``), example);
  assert.match(text, /`skill-`, the first 30 characters of the skill name with trailing hyphens removed, `-`, and the last 26 characters of the item id without its `li_` prefix/);
  const long = promotedWorkflowName({ id: "li_01JC3M8Z4QF6Y2N7T5W9XKD0AB", name: "a".repeat(64) });
  assert.equal(long, `skill-${"a".repeat(30)}-01jc3m8z4qf6y2n7t5w9xkd0ab`, "30 characters of the name, 26 of the id");
  assert.ok(long.length <= 63);
  assert.notEqual(promotedWorkflowName({ id: "li_01JC3M8Z4QF6Y2N7T5W9XKD0AB", name: "deploy" }), promotedWorkflowName({ id: "li_01JC3M8Z4QF6Y2N7T5W9XKD0AC", name: "deploy" }));
  assert.match(text, /409 `conflict` with `details\.reason: "promoted_workflow"`/);
  assert.match(text, /`learning_conflict` \(`details\.reason: "workflow_name_taken"`\)/);
  const hooks = await readFile(join(ROOT, "src/learning/hooks.ts"), "utf8");
  assert.ok(hooks.includes("`the workflow name ${name} is already used by a workflow this skill does not own`"), "the code's problem text");
  assert.ok(text.includes("`the workflow name <name> is already used by a workflow this skill does not own`"));
  // The prompt lines the docs quote are the ones a run is given.
  const pointer = { kind: "skill" as const, name: "deploy", title: "T", description: "D", body: "B", promotedWorkflow: "<name>", promotedWorkflowVersion: 7 };
  const full = renderItem(pointer).split("\n").find((line) => line.startsWith("Saved as workflow")) ?? "";
  assert.ok(text.includes(full.replace(" version 7:", " version <n>:")), full);
  const line = renderLine(pointer);
  const suffix = line.slice(line.indexOf(" (workflow"));
  assert.ok(text.includes(suffix.replace(" version 7,", " version <n>,")), suffix);
  assert.match(text, /\*\*Older databases\.\*\* Schema migration 3 \(`promotion-pointer`\)/);
  const migration = MIGRATIONS.find((m) => m.version === 3);
  assert.equal(migration?.name, "promotion-pointer");
  const store = flat(section(await doc("docs/architecture.md"), "The store"));
  assert.match(store, /`3 promotion-pointer`/);
  assert.match(store, /Migration 3 adds `learning_items\.promoted_workflow_version`/);
  assert.equal(MIGRATIONS.find((m) => m.version === 4)?.name, "idempotency-digest");
  assert.equal(MIGRATIONS.find((m) => m.version === 5)?.name, "wake-at");
  assert.equal(MIGRATIONS.find((m) => m.version === 6)?.name, "usage-saturation");
  assert.equal(MIGRATIONS.find((m) => m.version === 7)?.name, "secret-history");
  assert.equal(MIGRATIONS.find((m) => m.version === 8)?.name, "command-seq");
  assert.equal(LATEST_SCHEMA_VERSION, 8);
  assert.match(store, /`4 idempotency-digest`, `5 wake-at`, `6 usage-saturation`, `7 secret-history` and `8 command-seq` \(the current schema version is 8\)/);
  assert.match(store, /Migration 8 adds `commands\.seq`.* a new command gets `MAX\(seq\) \+ 1` inside the write transaction that inserts it/);
  assert.match(store, /Migration 7 adds the table `secret_history` \(`id`, `name`, `sealed`, `retired_at`\) with an index on `name`/);
  assert.match(store, /Migration 6 clamps every usage counter of `runs` \(tokens, cost micros, tool calls, turns\) and of `usage`/);
  const workflows = flat(section(await doc("docs/workflows.md"), "Saved workflows and `run_workflow`"));
  assert.match(workflows, /The `run_workflow` tool \(`\{name, version\?, input\}`\)/);
  assert.match(workflows, /an unknown one is an error result `unknown workflow "<name>" version <n>`/);
  assert.match(workflows, /`PUT \/v1\/workflows\/:name` on it answers 409 `conflict`/);
  const tool = await readFile(join(ROOT, "src/workflow/exec/run-workflow-tool.ts"), "utf8");
  assert.ok(tool.includes("`unknown workflow ${JSON.stringify(name)} version ${wanted}`"), "the tool's error text");
  assert.match(flat(await doc("docs/api.md")), /promotedWorkflow, promotedWorkflowVersion, promotionAttempts/);
});

test("a deadline on a call stops its nested steps, as the workflow and architecture docs say", async () => {
  const workflows = flat(section(await doc("docs/workflows.md"), "Retry and deadlines"));
  for (const rule of [
    /\*\*A deadline stops nested work\.\*\* On a `tool` node that calls `run_workflow`, or any tool built from durable steps/,
    /no further nested step starts \(the nested primitive throws `deadline_exceeded` before it journals anything\)/,
    /journalled `model\.interrupted \{reason: "deadline"\}` with its worst case as an assumed cost/,
    /a nested tool call in flight is aborted and journalled `tool\.finished \{outcome: "timeout"\}`, and the call itself is journalled `tool\.finished \{outcome: "timeout"\}`/,
    /\*\*A call deadline is per call\.\*\* On `tool`, `model` and `decide` nodes `deadlineMs` measures one execution of the call/,
    /a call that is attempted again \(a retry, a resume after a suspend or a crash\) gets a fresh bound, and the time a tool call waits for an approval comes before the call and is not counted/,
    /\*\*A node deadline is an instant, not a timer\.\*\* For a composite node, an `agent` hand-off and a `wait`, the deadline is the node's start as journalled \(`node\.started`\) plus `deadlineMs`/,
  ]) {
    assert.match(workflows, rule);
  }
  const architecture = flat(section(await doc("docs/architecture.md"), "Tool calls: started, finished, interrupted"));
  assert.match(architecture, /\*\*Nested steps belong to their call\.\*\*/);
  assert.match(architecture, /`ToolContext\.steps\.signal` is the enclosing call's signal\. Nesting composes to any depth/);
});

test("the command invariant and the two outcomes of a late message are documented with the engine's reason text", async () => {
  // Imported by name at run time: the constant is part of the round-3 engine contract (plan 3.5).
  const commands: Record<string, unknown> = await import("../../src/engine/commands.ts");
  const tooLate = commands["MESSAGE_TOO_LATE"];
  assert.equal(typeof tooLate, "string", "src/engine/commands.ts exports MESSAGE_TOO_LATE");
  const architecture = flat(section(await doc("docs/architecture.md"), "Commands"));
  assert.match(architecture, /A run never leaves `running` for `waiting`, `paused`, `completed`, `failed` or `cancelled` while a command sent to it is unconsumed: the store refuses that commit with `commands_pending`/);
  assert.match(architecture, /Only a release back to `queued` keeps unconsumed commands/);
  assert.match(architecture, /a cancel that arrived before the run completed makes it `cancelled`/);
  assert.ok(architecture.includes(`journalled \`command.rejected\` with the reason "${String(tooLate)}"`), "the too-late reason");
  assert.match(architecture, /journalled `message\.undelivered \{commandId, reason\}` in the same commit as `run\.output`/);
  const undelivered = commands["MESSAGE_UNDELIVERED"];
  assert.equal(typeof undelivered, "string", "src/engine/commands.ts exports MESSAGE_UNDELIVERED");
  assert.ok(architecture.includes(`with the reason "${String(undelivered)}"`), "the undelivered reason");
  assert.match(flat(section(await doc("docs/architecture.md"), "The run state machine")), /refuses \(`commands_pending`\) every transition out of `running`/);
  const api = flat(await doc("docs/api.md"));
  assert.match(api, /202 means the command was accepted, not that it took effect/);
  assert.ok(api.includes(`reason "${String(tooLate)}"`), "the API reference quotes the reason");
  assert.match(flat(await doc("docs/cli.md")), /a message that arrives after the run's last turn is not delivered/);
});
