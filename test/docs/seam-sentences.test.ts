/**
 * Docs sentences about behaviour that crosses packages, each pinned to the code that backs it: the body-limit
 * discard, the price bound, the worst-case input rate, value redaction and records field by field, the
 * learning pause at the cap, the workflow failure code of a deadline, the shape check of an always-present
 * property, the installable package, declared field specifications (finding R12-02) and regular-file reads
 * (finding R12-01).
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultConfig } from "../../src/config/defaults.ts";
import { MAX_PRICE_PER_MTOK } from "../../src/config/load.ts";
import { createRedactor, redactJsonWith } from "../../src/core/redact.ts";
import { createPricing } from "../../src/models/prices.ts";
import { DISCARD_BYTES, DISCARD_MS } from "../../src/server/http.ts";
import { RECORD_FIELDS, fieldObject, recordFieldsWith, redactBySpec, type FieldSpec } from "../../src/store/record-fields.ts";
import { redactCommitBatch } from "../../src/store/batch-redaction.ts";
import { validateWorkflow } from "../../src/workflow/validate.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

async function flatDoc(name: string): Promise<string> {
  return (await readFile(join(ROOT, name), "utf8")).replace(/\s+/g, " ");
}

test("security.md: a streamed body over the limit is discarded within the bounds the server uses", async () => {
  const security = await flatDoc("docs/security.md");
  assert.equal(DISCARD_BYTES, 4 * 1024 * 1024);
  assert.equal(DISCARD_MS, 2000);
  assert.match(security, /a stream that grows past the limit is refused with 413 and `Connection: close`\. Nothing past the limit is kept: the rest of that body is read and thrown away, at most 4 MiB more and for at most 2 seconds/);
  assert.doesNotMatch(security, /grows past the limit is cut off/);
});

test("configuration.md: the price bound is the one the loader enforces", async () => {
  const configuration = await flatDoc("docs/configuration.md");
  assert.equal(MAX_PRICE_PER_MTOK, 1_000_000_000);
  assert.match(configuration, /every price \(`models\.prices`\) is a number from 0 to 1000000000 USD per million tokens/);
});

test("README: the worst case prices input at the highest of the input, cache-read and cache-write rates", async () => {
  const readme = await flatDoc("docs/reference.md");
  assert.match(readme, /priced at the highest of the input, cache-read and cache-write prices/);
  const ref = { provider: "test", name: "m" };
  const pricing = (cacheReadPerMTok: number, cacheWritePerMTok: number) =>
    createPricing({ "test/m": { inputPerMTok: 1, outputPerMTok: 0, cacheReadPerMTok, cacheWritePerMTok } });
  assert.equal(pricing(0.1, 1.25).worstCaseMicros(ref, 1_000_000, 0), 1_250_000, "cache write is the highest");
  assert.equal(pricing(3, 1.25).worstCaseMicros(ref, 1_000_000, 0), 3_000_000, "cache read is the highest");
  assert.equal(pricing(0.1, 0.5).worstCaseMicros(ref, 1_000_000, 0), 1_000_000, "input is the highest");
});

test("README: redaction works on values; numbers change at an output boundary and in stored payload values; records field by field", async () => {
  const readme = await flatDoc("docs/reference.md");
  assert.match(readme, /Redaction works on values, never on serialized text: at an output boundary and in caller, model, tool and driver values, each string and each object key is redacted on its own, so the output is always valid JSON/);
  assert.match(readme, /A journal record is redacted field by field: its free text as text, and Runwright's own field names, enumerated values, ids and numbers as they are, because a resume reads them back; a field the field specification does not name, and a record of a type the engine does not write, is redacted whole/);
  assert.doesNotMatch(readme, /Redaction works on values, never on serialized text: each string and each object key is redacted on its own/);
  // A record: the field names, the stop reason and the cost stay; the text and the payload value are redacted.
  const r = createRedactor({ A: "toolCalls", B: "tool_use", PIN: "12345678" });
  const record = { text: "toolCalls", toolCalls: [{ id: "c", name: "x", args: { n: 12345678 } }], stopReason: "tool_use", costMicros: 12345678 };
  assert.deepEqual(redactBySpec(record, RECORD_FIELDS["model.finished"] as FieldSpec, r), {
    text: "[redacted:A]", toolCalls: [{ id: "c", name: "x", args: { n: "[redacted:PIN]" } }], stopReason: "tool_use", costMicros: 12345678,
  });
  assert.deepEqual(redactBySpec({ surprise: 12345678 }, RECORD_FIELDS["model.finished"] as FieldSpec, r), { surprise: "[redacted:PIN]" });
  assert.match(readme, /At an output boundary \(API responses, SSE events, log lines\) and in every stored caller, model, tool or driver value, a number whose digits hold a secret becomes the redacted text, as a string; only the numbers the engine owns \(limits, costs, counters, timestamps\) are stored unchanged, because the engine reads them back from the journal/);
  const text = (value: string): string => value.replaceAll("12345678", "[redacted]");
  const value = { maxCostMicros: 12345678, note: "pin 12345678", other: 7 };
  assert.deepEqual(redactJsonWith(value, text, { numbers: true }), { maxCostMicros: "[redacted]", note: "pin [redacted]", other: 7 });
  assert.deepEqual(redactJsonWith(value, text), { maxCostMicros: 12345678, note: "pin [redacted]", other: 7 });
});

test("README: the fetch time limit covers address resolution", async () => {
  assert.match(await flatDoc("docs/reference.md"), /Its time limit covers the whole call, address resolution on every hop included/);
});

test("README: learning pauses at the cap by default, and onLimit skip skips", async () => {
  const readme = await flatDoc("docs/reference.md");
  assert.match(readme, /A learning, grading or promotion call that does not fit the run's spend cap pauses the run with a `spend_cap` pending at that step \(`learning\.onLimit: "pause"`, the default\)/);
  assert.match(readme, /With `learning\.onLimit: "skip"` the step is skipped instead/);
  assert.equal(defaultConfig(join(ROOT, "unused-data-dir")).learning.onLimit, "pause");
});

test("workflows.md: a deadline's node failure is a workflow_failed run error naming the node", async () => {
  const workflows = await flatDoc("docs/workflows.md");
  assert.match(workflows, /the node fails with `deadline_exceeded`: the run then fails with the error code `workflow_failed` and the message `node "<id>" failed: deadline_exceeded: the deadline of <n> ms passed`/);
});

test("workflows.md: a property a reference always has must be allowed by additionalProperties", async () => {
  const workflows = await flatDoc("docs/workflows.md");
  assert.match(workflows, /when a property it always has never fits \(its value never fits, or `additionalProperties` refuses the property\)/);
  const document = {
    format: "runwright.workflow/v1", name: "strict", input: "In", output: "Out",
    schemas: { In: { type: "object" }, Out: { type: "object", additionalProperties: false, properties: { x: { type: "string" } } } },
    root: { id: "w", kind: "wait", question: "q" }, result: { $ref: "steps.w" },
  };
  const report = validateWorkflow(document);
  assert.deepEqual(report.problems.map((p) => [p.path, p.code, p.severity]), [["$.result.answer", "schema_mismatch", "error"]]);
});

test("README: what a node deadline bounds, and who reads a message", async () => {
  const readme = await flatDoc("docs/reference.md");
  assert.match(readme, /`deadlineMs` on a composite node or an `agent` hand-off bounds that node's whole execution, everything inside it included, and on a `wait` node the time a person has to answer; both are measured from the node's journalled start, so they hold across waits, pauses and restarts\. On `tool`, `model` and `decide` nodes it bounds each call, and on a `fail` node it has no effect\./);
  assert.match(readme, /A message sent to a run is handed to at most one agent loop, the first that takes its messages after it arrived: in a workflow with parallel agent hand-offs, never to two of them/);
  const document = {
    format: "runwright.workflow/v1", name: "waits", input: "In", output: "Out", schemas: { In: { type: "object" }, Out: {} },
    root: { id: "w", kind: "wait", question: "q", deadlineMs: 1000 }, result: "done",
  };
  const report = validateWorkflow(document);
  assert.deepEqual([report.ok, report.problems], [true, []], "a deadline on a wait node is accepted with no problem");
  const onFail = validateWorkflow({ ...document, root: { id: "f", kind: "fail", message: "stop", deadlineMs: 1000 } });
  assert.equal(onFail.ok, true);
  assert.deepEqual(onFail.problems.map((p) => [p.code, p.severity, p.message]), [["bad_deadline", "warning", '"deadlineMs" has no effect on a fail node']]);
});

test("architecture.md: one writer at a time, with the busy timeout the store sets", async () => {
  const architecture = await flatDoc("docs/architecture.md");
  assert.match(architecture, /\*\*One writer at a time\.\*\* SQLite lets one transaction write at a time, and every transaction is synchronous and short/);
  assert.match(architecture, /every other writer waits up to `busy_timeout` \(5 s\) and then fails with a store error \(a runner's claim is tried again at its next poll\)/);
  const store = await readFile(join(ROOT, "src/store/sqlite.ts"), "utf8");
  assert.match(store, /PRAGMA busy_timeout = 5000/);
  const runner = await readFile(join(ROOT, "src/engine/runner.ts"), "utf8");
  assert.match(runner, /logger\.warn\("runner\.claim_failed"/);
});

test("README: the scope no longer calls the installed package unsupported", async () => {
  const readme = await flatDoc("README.md");
  assert.doesNotMatch(readme, /Installing from a registry tarball/);
  assert.match(readme, /The npm package ships compiled JavaScript with type declarations/);
});

test("security.md and README: a value Runwright built is redacted by its writer's declared specification, which is never stored", async () => {
  const security = await flatDoc("docs/security.md");
  assert.match(security, /The value of a step or node, a model's structured output and a tool's data are payloads unless the code that writes them declares their field specification \(`MemoMeta\.valueFields`, `ModelStepRequest\.outputFields`, `ToolOutput\.dataFields`\)/);
  assert.match(security, /The engine attaches the specification to the record it commits \(`NewJournalRecord\.fields`\); the run's redactor and the store wrapper both use it; it is never stored\./);
  assert.match(security, /every string that a model, a person, a caller or a tool supplied is still redacted, and a key the specification does not list is redacted together with its value/);
  assert.match(security, /The same holds for a field specification that a driver or host tool declares for its own step value, structured output or tool data: what it marks as kept is stored as it is\. Without a declaration its value is redacted whole\./);
  assert.match(security, /what is stored follows the rules above/);
  assert.doesNotMatch(security, /what is stored is not affected/);
  const readme = await flatDoc("docs/reference.md");
  assert.match(readme, /A value whose structure Runwright itself built \(a learning step's value, a decision, a loop's or a tool node's result\) keeps Runwright's field names, and only the text inside it is redacted; a value an author's expression builds \(a sub-workflow's result, a workflow's result\) is a payload\./);
  assert.match(readme, /\(what is stored is redacted field by field; do not store such values as secrets\)/);
  // The mechanism as documented: the declared key stays, its text is redacted, the record keeps the same fields
  // object for the next pass, and an undeclared value is redacted whole.
  const r = createRedactor({ WORD: "promptSection", NOTE: "note-text-0042" });
  const fields = recordFieldsWith("step.finished", "value", fieldObject({ promptSection: "text" }));
  const value = { promptSection: "see note-text-0042" };
  const [declared, whole] = redactCommitBatch({
    records: [{ type: "step.finished", data: { name: "n", value }, fields }, { type: "step.finished", data: { name: "n", value } }],
  }, r).records;
  assert.deepEqual(declared?.data["value"], { promptSection: "see [redacted:NOTE]" });
  assert.equal(declared?.fields, fields);
  assert.deepEqual(whole?.data["value"], { "[redacted:WORD]": "see [redacted:NOTE]" });
});

test("security.md and README: only regular files are read from a workspace", async () => {
  const security = await flatDoc("docs/security.md");
  assert.match(security, /\*\*Only regular files are read\.\*\* `read_file`, `edit_file`, the engine's check of a saved result, learning's verification of one and the file download open a path once, without following a final symbolic link and without blocking \(`O_NOFOLLOW \| O_NONBLOCK`, `src\/core\/regular-file\.ts`\)/);
  assert.match(security, /A FIFO, a socket, a device or a directory is `<path>: not a regular file` \(a 404 for the download\)/);
  assert.match(security, /A read never takes more than its size limit plus one byte into memory, also when the file grows while it is read\./);
  assert.match(security, /The bytes come from the handle whose type and size were checked, and exactly the announced number of bytes is sent\./);
  assert.match(await flatDoc("docs/reference.md"), /They read regular files only: a FIFO, a socket or a device in the workspace is refused without a blocking open\./);
});
