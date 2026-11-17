/**
 * The docs on structured output and the dry run say what the code does: the placeholder rules, limits and
 * pattern syntax they quote are the generator's, every step note and warning they quote is produced by a dry run,
 * the output transport they describe is the one the providers use, and the CLI, the API and skill promotion treat
 * warnings as the docs say.
 */
import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isRunwrightError } from "../../src/core/errors.ts";
import type { Json, JsonObject } from "../../src/core/json.ts";
import type { Driver } from "../../src/engine/types.ts";
import { checkDraft } from "../../src/learning/promotion.ts";
import { OUTPUT_VALUE_KEY, WRAPPED_INSTRUCTION_SENTENCE, WRAPPED_TOOL_SENTENCE, outputToolSchema, readOutputArgs, readOutputText } from "../../src/models/output-transport.ts";
import { createScriptedProvider } from "../../src/models/scripted.ts";
import type { ModelRequest, ModelResponse } from "../../src/models/types.ts";
import { samplePattern } from "../../src/schema/pattern-sample.ts";
import { generatePlaceholder } from "../../src/schema/placeholder.ts";
import { validateSchema, type JsonSchema } from "../../src/schema/validate.ts";
import { conditionVerdict } from "../../src/workflow/dry-check.ts";
import { dryRunWorkflow, PLACEHOLDER_DEPENDENT, type DryRunOptions } from "../../src/workflow/dryrun.ts";
import { evalCondition } from "../../src/workflow/refs.ts";
import type { Condition, DryRunReport, WorkflowDocument } from "../../src/workflow/types.ts";
import { UNKNOWN_SHAPE } from "../../src/workflow/walk.ts";
import { cli, cliServer } from "../cli/support.ts";
import { createHarness, fakeModels, reply } from "../helpers/engine.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function doc(name: string): Promise<string> {
  return readFile(join(ROOT, name), "utf8");
}

async function allDocs(): Promise<{ name: string; text: string }[]> {
  const names = ["README.md", ...(await readdir(join(ROOT, "docs"))).filter((n) => n.endsWith(".md")).map((n) => `docs/${n}`)];
  return Promise.all(names.map(async (name) => ({ name, text: await doc(name) })));
}

/** Markdown wraps lines; compare with every run of whitespace as one space. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** The text under a heading (`## X` or `### X`) up to the next heading of the same or a higher level. */
function section(text: string, heading: string): string {
  const level = /^#+/.exec(heading)?.[0] ?? "";
  const start = text.indexOf(`\n${heading}\n`);
  assert.ok(start >= 0, `section "${heading}" exists`);
  const ends = ["\n## ", ...(level === "###" ? ["\n### "] : [])].map((h) => text.indexOf(h, start + 1)).filter((i) => i >= 0);
  return text.slice(start, ends.length === 0 ? undefined : Math.min(...ends));
}

/** The one backtick-quoted text of `text` (flattened) that starts with `prefix`. */
function quoted(text: string, prefix: string): string {
  const hits = [...flat(text).matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "").filter((q) => q.startsWith(prefix));
  assert.ok(hits.length > 0, `the docs quote a text starting with ${JSON.stringify(prefix)}`);
  const unique = [...new Set(hits)];
  assert.equal(unique.length, 1, `one quoted text starts with ${JSON.stringify(prefix)}: ${JSON.stringify(unique)}`);
  return unique[0] as string;
}

/** Replaces each `<name>` slot of a quoted template. */
function fill(template: string, values: Record<string, string>): string {
  return template.replace(/<([^>]+)>/g, (slot, name: string) => {
    assert.ok(Object.hasOwn(values, name), `a value for the slot ${slot} of ${JSON.stringify(template)}`);
    return values[name] as string;
  });
}

const workflowsDoc = (): Promise<string> => doc("docs/workflows.md");
const dryRunDoc = async (): Promise<string> => section(await workflowsDoc(), "## Dry run");

/** A document with input schema `In` (any object unless given) and output schema `Out`. */
function wf(schemas: { [name: string]: JsonSchema }, root: JsonObject, result: Json): WorkflowDocument {
  const document: JsonObject = {
    format: "runwright.workflow/v1", name: "probe", schemas: { In: { type: "object" }, ...schemas } as JsonObject,
    input: "In", output: "Out", root, result,
  };
  return document as unknown as WorkflowDocument;
}

function dry(document: WorkflowDocument, options?: DryRunOptions): DryRunReport {
  return dryRunWorkflow(document, options);
}

const notes = (report: DryRunReport): string[] => report.steps.flatMap((s) => (s.note === null ? [] : [s.note]));
const messages = (report: DryRunReport): string[] => report.problems.map((p) => p.message);

/** A model output schema whose `code` has a pattern no placeholder can be generated for (a look-ahead). */
const LOOKAHEAD: JsonSchema = { type: "object", required: ["code"], properties: { code: { type: "string", pattern: "^(?=A)[A-Z]{2}$" } } };
const lookaheadDocument = (): WorkflowDocument => wf({ Out: LOOKAHEAD }, { id: "m", kind: "model", prompt: "Code?", output: "Out" }, { $ref: "steps.m" });

const KEYED: JsonSchema = { type: "object", required: ["k"], properties: { k: { type: "string" } } };

test("the Dry run section names placeholder_dependent, and a pattern without a placeholder gives exactly that warning with ok: true", async () => {
  const text = await dryRunDoc();
  assert.equal(PLACEHOLDER_DEPENDENT, "placeholder_dependent");
  assert.match(text, /`placeholder_dependent`/);
  assert.match(flat(await workflowsDoc()), /\| `placeholder_dependent` \| only from the \[dry run\]\(#dry-run\), and always a warning/);

  const report = dry(lookaheadDocument());
  assert.equal(report.ok, true);
  assert.ok(report.problems.length > 0);
  for (const problem of report.problems) {
    assert.equal(problem.code, "placeholder_dependent");
    assert.equal(problem.severity, "warning");
  }
  const unsatisfied = quoted(text, "no placeholder that satisfies schema ");
  assert.ok(messages(report).includes(fill(unsatisfied, { name: "Out" })), JSON.stringify(report.problems));
  const notChecked = quoted(text, "not checked against a real value: ");
  const prefix = fill(notChecked, { "the validator's message": "" });
  const outputWarning = report.problems.find((p) => p.path === "output.code");
  assert.ok(outputWarning !== undefined);
  assert.ok(outputWarning.message.startsWith(prefix), outputWarning.message);
  assert.match(flat(text), /a report can be `ok: true` and still list `placeholder_dependent` warnings in `problems`/);
});

test("the candidate order is const, default, examples, enum, and the generator follows it", async () => {
  const paragraph = flat(section(await workflowsDoc(), "### How a placeholder is chosen"));
  const at = ["`const`", "`default`", "`examples`", "`enum`"].map((word) => paragraph.indexOf(word));
  assert.ok(at.every((i) => i >= 0), JSON.stringify(at));
  assert.deepEqual([...at].sort((a, b) => a - b), at, "the four keywords appear in this order");
  assert.match(paragraph, /takes the first one that validates against that schema/);
  assert.match(paragraph, /validated once more at the end: the generator reports `satisfied: true` only when it validates/);

  assert.deepEqual(generatePlaceholder({ type: "string", pattern: "^(?=a)a$", examples: ["a"] }), { value: "a", satisfied: true });
  assert.deepEqual(generatePlaceholder({ type: "string", default: "d", minLength: 1 }), { value: "d", satisfied: true });
  assert.deepEqual(generatePlaceholder({ type: "string", const: "c", default: "d" }), { value: "c", satisfied: true });
  assert.deepEqual(generatePlaceholder({ enum: ["p", "q"], examples: ["q"] }), { value: "q", satisfied: true });
  // A default that does not validate is skipped, as the docs say ("the first one that validates").
  assert.deepEqual(generatePlaceholder({ type: "string", default: "", minLength: 2 }), { value: "xx", satisfied: true });
  // Sibling keywords are applied with a branch: the integer branch alone would give 0, below the minimum.
  assert.deepEqual(generatePlaceholder({ anyOf: [{ type: "integer" }], minimum: 3 }), { value: 3, satisfied: true });
  const unsatisfiable = generatePlaceholder({ type: "string", pattern: "^(?=a)b$" });
  assert.equal(unsatisfiable.satisfied, false);
  assert.ok(validateSchema({ type: "string", pattern: "^(?=a)b$" }, unsatisfiable.value).length > 0);
  assert.match(paragraph, /When no placeholder can be generated\*\*, give the schema a `default` or an `examples` entry/);
});

test("the limits the docs quote are the generator's and the sampler's", async () => {
  const paragraph = flat(section(await workflowsDoc(), "### How a placeholder is chosen"));
  const limits = /A generated string is at most ([\d ]+) characters and a generated array at most ([\d ]+) items/.exec(paragraph);
  assert.ok(limits !== null, "the docs quote the string and array limits");
  const number = (text: string | undefined): number => Number((text ?? "").replace(/ /g, ""));
  const longString = generatePlaceholder({ type: "string", minLength: 100000 });
  const longArray = generatePlaceholder({ type: "array", minItems: 100000 });
  assert.equal((longString.value as string).length, number(limits[1]));
  assert.equal((longArray.value as Json[]).length, number(limits[2]));
  assert.equal(longString.satisfied, false, "a cut value does not validate");
  assert.equal(longArray.satisfied, false);

  const patternLimit = /A pattern longer than ([\d ]+) characters gives no sample/.exec(paragraph);
  assert.ok(patternLimit !== null);
  const limit = number(patternLimit[1]);
  assert.equal(samplePattern("a".repeat(limit)), "a".repeat(limit));
  assert.equal(samplePattern("a".repeat(limit + 1)), null);
});

test("the pattern subset the docs list is the one the sampler supports", async () => {
  const paragraph = flat(section(await workflowsDoc(), "### How a placeholder is chosen"));
  for (const pattern of ["^[A-Z]{2}$", "^\\d{3}-\\d{4}$", "^(?:ab|cd)+x?$", "^[^0-9]\\w*\\.txt$", "^a.c\\/d$", "^(x|y){2,3}?$", "^\\s[a-z-]+$"]) {
    const sample = samplePattern(pattern);
    assert.ok(sample !== null && new RegExp(pattern, "u").test(sample), `${pattern} → ${JSON.stringify(sample)}`);
  }
  const unsupported: [RegExp, string][] = [
    [/look-ahead and look-behind/, "^(?=a)a$"], [/look-ahead and look-behind/, "^(?<=a)a$"], [/back-references/, "^(a)\\1$"],
    [/named groups/, "^(?<n>a)$"], [/`\\b` and `\\B`/, "^\\ba$"], [/`\\p\{\.\.\.\}`/, "^\\p{L}$"], [/`\\D`, `\\W`, `\\S`/, "^\\D$"],
    [/`\\n`, `\\t`, `\\uXXXX` and `\\xHH`/, "^\\x41$"],
  ];
  for (const [mention, pattern] of unsupported) {
    assert.match(paragraph, mention);
    assert.equal(samplePattern(pattern), null, pattern);
  }
  assert.match(paragraph, /A class contributes one character: an upper-case letter, else a lower-case letter, else a digit/);
  assert.equal(samplePattern("^[0-9a-z]$"), "a");
  assert.equal(samplePattern("^[0-9A-Za-z]$"), "A");
  assert.equal(samplePattern("^[0-9]$"), "0");
});

test("the dry-run docs state rule D in its own words", async () => {
  const text = flat(await dryRunDoc());
  for (const sentence of [
    "When the value a branch switches on is a placeholder, the dry run considers only the outcomes a real value could select: a case is " +
      "reachable when its `when` value is valid for the declared schema of `on`; the default is reachable unless the schema allows only a " +
      "finite set of values (`const`, `enum`, a `boolean`, a `null`) and every one of them is some case's `when`; with no default, \"no case " +
      "matched\" is an outcome under the same condition. When the schema of `on` is not statically known, every branch is reachable.",
    "A node *cannot succeed* when its structure alone makes every run through it fail: a `fail` node; a sequence or a parallel group with a " +
      "step that cannot succeed; a map whose `over` always has an item (rule A) and whose body cannot succeed; a loop with `maxIterations` " +
      "of 1 or more whose body cannot succeed, or whose `onLimit` is `\"fail\"` and whose `until` can never hold " +
      "(rule V); a branch all of whose reachable outcomes are nodes that cannot succeed; a `call` whose target's root cannot " +
      "succeed. Every other node can succeed.",
    "The walk takes the branch the placeholder selects if it can succeed, otherwise the first reachable branch that can succeed (cases in " +
      "order, then the default). When more than one outcome is reachable, the path taken is marked as assumed, and a failure met on it is a " +
      "warning. When only one outcome is reachable, or no reachable branch can succeed, the walk takes it as a real run would and a failure " +
      "on it is certain: the dry run is not ok.",
    "A loop whose `until` depends on a placeholder is assumed to hold after an iteration only when it can hold (rule V). When it can " +
      "never hold, the loop ends at `maxIterations` (and fails for certain when `onLimit` is `\"fail\"`).",
    "A branch whose `on` has no reference has one value, so only the outcome a run selects for it is reachable.",
    "A path is *assumed* only when a real run with valid values might not take it; a node that every valid run executes is never on an " +
      "assumed path, whatever values were made up on the way.",
    "A loop's first iteration is never assumed, and a later one only after a made-up `until` that can hold (the walk then assumes it " +
      "holds and stops there).",
  ]) assert.ok(text.includes(sentence), sentence);
  assert.doesNotMatch(text, /whose `run` node is not a `fail` node/);
  assert.doesNotMatch(text, /decided conservatively|when the declared schemas let it hold|every other condition \(`not`/,
    "the round-14 rule (a literal ne, truthy, gt or not can hold) is gone");
});

test("rule V: the docs' literal conditions have the values they say, and the worked loop fails at its bound", async () => {
  const text = flat(section(await workflowsDoc(), "#### Rule V: what a condition can be"));
  const examples = /So ((?:`[^`]+`(?:, | and | ))+)never hold, and `([^`]+)` always holds\./.exec(text);
  assert.ok(examples !== null, "the section gives literal examples");
  const nevers = [...(examples[1] as string).matchAll(/`([^`]+)`/g)].map((m) => JSON.parse(m[1] as string) as Condition);
  assert.equal(nevers.length, 4);
  const empty = { input: null, steps: {}, vars: {}, loop: {}, run: { id: "", agentId: "" } };
  for (const condition of nevers) {
    assert.equal(evalCondition(condition, empty), false, JSON.stringify(condition));
    assert.equal(conditionVerdict(condition, () => UNKNOWN_SHAPE), "never", JSON.stringify(condition));
  }
  const always = JSON.parse(examples[2] as string) as Condition;
  assert.equal(evalCondition(always, empty), true);
  assert.equal(conditionVerdict(always, () => UNKNOWN_SHAPE), "always");
  assert.match(text, /A condition, or any part of one, with no `\$ref`, no `\{\{path\}\}` and no `exists` in it is never assumed: it is evaluated exactly as a run evaluates it/);
  assert.match(text, /`ne` is the opposite of `eq`/);

  const worked = /So a loop with `onLimit: "fail"` and `until: ([^`]+)` is reported as failing at its bound \(`([^`]+)`, the dry run is not ok\)/.exec(text);
  assert.ok(worked !== null, "the worked example is in the section");
  const until = JSON.parse(worked[1] as string) as Condition;
  for (const go of [{ type: "boolean" }, { const: true }, {}] as JsonSchema[]) {
    const report = dry(wf({ In: { type: "object", required: ["go"], properties: { go } }, Out: {} },
      { id: "lp", kind: "loop", maxIterations: 3, onLimit: "fail", until, run: { id: "w", kind: "wait", question: "q" } }, null));
    assert.equal(report.ok, false, JSON.stringify(go));
    assert.deepEqual(notes(report), [fill(worked[2] as string, { n: "3" })]);
  }
});

test("every step note and warning the dry-run docs quote is produced by a dry run", async () => {
  const text = await dryRunDoc();

  // A branch on a model's answer whose matching choice is a fail node takes the next reachable one that can succeed.
  const branchOn = (cases: JsonObject[], fallback?: JsonObject): WorkflowDocument => wf({ C: KEYED, Out: { type: "string" } },
    { id: "s", kind: "sequence", steps: [
      { id: "m", kind: "model", prompt: "Pick.", output: "C" },
      { id: "b", kind: "branch", on: { $ref: "steps.m.k" }, cases, ...(fallback === undefined ? {} : { default: fallback }) },
    ] }, "done");
  const toCase = branchOn([{ when: "yes", run: { id: "r", kind: "wait", question: "q" } }], { id: "f", kind: "fail", message: "no" });
  const caseReport = dry(toCase);
  assert.equal(caseReport.ok, true);
  assert.deepEqual(notes(caseReport), [quoted(text, "case 0 (")]);
  const toDefault = branchOn([{ when: "yes", run: { id: "f", kind: "fail", message: "no" } }], { id: "r", kind: "wait", question: "q" });
  const defaultReport = dry(toDefault);
  assert.equal(defaultReport.ok, true);
  assert.deepEqual(notes(defaultReport), [fill(quoted(text, "default (<value>, placeholder)"), { value: '""' })]);

  // A branch on a given input runs as in a real run, with the notes the docs quote.
  const onInput = wf({ In: { type: "object", required: ["k"], properties: { k: { type: "string" } } }, Out: { type: "string" } },
    { id: "b", kind: "branch", on: { $ref: "input.k" }, cases: [{ when: "yes", run: { id: "r", kind: "wait", question: "q" } }] }, "done");
  const matched = dry(onInput, { input: { k: "yes" } });
  assert.deepEqual(notes(matched), [fill(quoted(text, "case <i> (<value>)"), { i: "0", value: '"yes"' })]);
  const unmatched = dry(onInput, { input: { k: "no" } });
  assert.deepEqual([unmatched.ok, notes(unmatched)], [true, [fill(quoted(text, "no case matched (<value>)"), { value: '"no"' })]]);
  const branchWithDefault = wf({ In: { type: "object", required: ["k"], properties: { k: { type: "string" } } }, Out: { type: "string" } },
    { id: "b", kind: "branch", on: { $ref: "input.k" }, cases: [{ when: "yes", run: { id: "r", kind: "wait", question: "q" } }],
      default: { id: "f", kind: "fail", message: "other" } }, "done");
  const toFail = dry(branchWithDefault, { input: { k: "no" } });
  assert.equal(toFail.ok, false, "a fail reached on a given value is certain");
  assert.equal(notes(toFail)[0], fill(quoted(text, "default (<value>)"), { value: '"no"' }));

  // A loop with onLimit "fail" whose until reads a model's answer.
  const loop = wf({ D: { type: "object", required: ["done"], properties: { done: { type: "boolean" } } }, Out: { type: "string" } },
    { id: "l", kind: "loop", maxIterations: 3, onLimit: "fail", until: { eq: [{ $ref: "steps.m.done" }, true] },
      run: { id: "m", kind: "model", prompt: "Done?", output: "D" } }, "done");
  const loopReport = dry(loop);
  assert.equal(loopReport.ok, true);
  assert.deepEqual(notes(loopReport), [fill(quoted(text, "until depends on placeholder values"), { n: "1" })]);
  assert.deepEqual(loopReport.output, "done");
  const loopStep = loopReport.steps.find((s) => s.nodeId === "l");
  assert.ok(loopStep !== undefined);
  const loopOut = dry(wf({ D: { type: "object", required: ["done"], properties: { done: { type: "boolean" } } }, Out: { type: "object" } },
    { id: "l", kind: "loop", maxIterations: 3, onLimit: "fail", until: { eq: [{ $ref: "steps.m.done" }, true] },
      run: { id: "m", kind: "model", prompt: "Done?", output: "D" } }, { $ref: "steps.l" }));
  assert.deepEqual(loopOut.output, { iterations: 1, completed: true, last: { done: false } });
  assert.match(flat(text), /the output `\{iterations: <n>, completed: true, last\}`/);

  // A branch on a made-up value whose only case fails, with no default: a real value may match no case, so the walk
  // ends the branch there (an assumed path, more than one outcome is reachable) and the workflow is ok.
  const noMatch = dry(branchOn([{ when: "yes", run: { id: "f", kind: "fail", message: "stop" } }]));
  assert.equal(noMatch.ok, true);
  assert.deepEqual(notes(noMatch), [fill(quoted(text, "no case matched (<value>, placeholder)"), { value: '""' })]);
  assert.deepEqual(noMatch.problems, []);
  // A case the declared schema of `on` rules out is skipped, and the note says so.
  const ENUM_K: JsonSchema = { type: "object", required: ["k"], properties: { k: { enum: ["a", "b", "cc"], maxLength: 1 } } };
  const skipped = dry(wf({ C: ENUM_K, Out: { type: "string" } }, { id: "s", kind: "sequence", steps: [
    { id: "m", kind: "model", prompt: "Pick.", output: "C" },
    { id: "b", kind: "branch", on: { $ref: "steps.m.k" }, cases: [{ when: "a", run: { id: "f", kind: "fail", message: "no" } },
      { when: "b", run: { id: "r", kind: "wait", question: "q" } }], default: { id: "d", kind: "wait", question: "d" } },
  ] }, "done"));
  assert.equal(skipped.ok, true);
  assert.deepEqual(notes(skipped), [`case 1 ("a", placeholder)${quoted(text, ", unreachable branches skipped")}`]);
  // A loop whose until can never hold for the declared schemas stops at its bound.
  const never = dry(wf({ D: { type: "object", required: ["done"], properties: { done: { const: false } } }, Out: { type: "object" } },
    { id: "l", kind: "loop", maxIterations: 3, onLimit: "continue", until: { eq: [{ $ref: "steps.m.done" }, true] },
      run: { id: "m", kind: "model", prompt: "Done?", output: "D" } }, { $ref: "steps.l" }));
  assert.equal(never.ok, true);
  assert.deepEqual(notes(never), [fill(quoted(text, "until cannot hold for the declared schemas"), { n: "3" })]);
  assert.deepEqual(never.output, { iterations: 3, completed: false, last: { done: false } });

  // A fail on an assumed path (the body of a map over a made-up list), and a loop bound with onLimit "fail" on one.
  const assumedMap = (run: JsonObject): WorkflowDocument => wf({
    L: { type: "object", required: ["items"], properties: { items: { type: "array", items: { type: "string" } } } }, Out: { type: "string" },
  }, { id: "s", kind: "sequence", steps: [
    { id: "m", kind: "model", prompt: "List.", output: "L" },
    { id: "each", kind: "map", over: { $ref: "steps.m.items" }, as: "it", concurrency: 1, maxItems: 3, run },
  ] }, "done");
  const assumedWarning = quoted(text, "a run that takes this path fails here");
  const failNote = quoted(text, "would fail: <message>");
  const failReport = dry(assumedMap({ id: "f", kind: "fail", message: "stop" }));
  assert.equal(failReport.ok, true);
  assert.equal(failReport.output, null);
  assert.ok(notes(failReport).includes(fill(failNote, { message: "stop" })));
  assert.deepEqual(failReport.problems.map((p) => [p.code, p.severity, p.message]), [["placeholder_dependent", "warning", assumedWarning]]);
  const boundReport = dry(assumedMap({ id: "l", kind: "loop", maxIterations: 2, onLimit: "fail", until: { eq: [1, 2] },
    run: { id: "w", kind: "wait", question: "q" } }));
  assert.equal(boundReport.ok, true);
  assert.ok(notes(boundReport).includes(fill(quoted(text, "would fail: reached maxIterations"), { n: "2" })));
  assert.deepEqual(messages(boundReport), [assumedWarning]);
  // Off an assumed path the same fail is certain.
  const certain = dry(wf({ Out: { type: "string" } }, { id: "f", kind: "fail", message: "stop" }, "x"));
  assert.equal(certain.ok, false);
  assert.deepEqual(notes(certain), [fill(failNote, { message: "stop" })]);

  // A reference into a tool's data reads as null; with a default it reads the default and warns nothing.
  const toolData = (ref: JsonObject): WorkflowDocument => wf({ Out: { type: "object" } },
    { id: "t", kind: "tool", tool: "read_file", args: { path: "a.txt" } }, { n: ref });
  const unresolved = dry(toolData({ $ref: "steps.t.data.count" }));
  assert.equal(unresolved.ok, true);
  assert.deepEqual(unresolved.output, { n: null });
  assert.deepEqual(messages(unresolved), [fill(quoted(text, "reference \"<path>\""), { path: "steps.t.data.count" })]);
  assert.match(flat(text), /This is what happens to `steps\.t\.data\.count` after a `tool` node `t`/);
  const withDefault = dry(toolData({ $ref: "steps.t.data.count", default: 0 }));
  assert.deepEqual([withDefault.ok, withDefault.problems, withDefault.output], [true, [], { n: 0 }]);

  // Maps over a made-up list.
  const mapOver = (items: JsonSchema, maxItems: number): WorkflowDocument => wf(
    { L: { type: "object", required: ["xs"], properties: { xs: items } }, Out: { type: "array" } },
    { id: "s", kind: "sequence", steps: [
      { id: "m", kind: "model", prompt: "List.", output: "L" },
      { id: "e", kind: "map", over: { $ref: "steps.m.xs" }, as: "x", concurrency: 1, maxItems, run: { id: "w", kind: "wait", question: "{{vars.x}}" } },
    ] }, { $ref: "steps.e" });
  const cut = dry(mapOver({ type: "array", items: { type: "string" }, examples: [["a", "b", "c", "d"]] }, 2));
  assert.deepEqual(notes(cut), [fill(quoted(text, "placeholder list cut to maxItems"), { n: "2" })]);
  // A list whose schema needs more items than maxItems fails every run: the validator's error, before any walk.
  const tooLong = dry(mapOver({ type: "array", minItems: 4, items: { type: "string" } }, 2));
  assert.deepEqual([tooLong.ok, tooLong.steps, tooLong.problems.map((p) => [p.path, p.code, p.message])], [false, [], [
    ["$.root.steps[1].over", "schema_mismatch", `"over" is longer than "maxItems": has at least 4 items, but must have at most 2`],
  ]]);
  const empty = dry(mapOver({ type: "array", items: { type: "string", pattern: "^(?=a)a$" } }, 2));
  assert.equal(empty.ok, true);
  assert.deepEqual(notes(empty), [quoted(text, "over is an empty placeholder list")]);
  assert.deepEqual(messages(empty), [quoted(text, "no placeholder that satisfies the item schema")]);

  // The input placeholder warns at path `input`.
  const input = dry(wf({ In: { type: "string", pattern: "^(?=a)a$" }, Out: { type: "string" } }, { id: "w", kind: "wait", question: "q" }, "x"));
  assert.deepEqual(input.problems.map((p) => [p.path, p.message]), [["input", fill(quoted(text, "no placeholder that satisfies schema "), { name: "In" })]]);

  // A low-confidence fallback value built from a model's answer.
  const decide = dry(wf({ F: { type: "object", required: ["v"], properties: { v: { type: ["string", "boolean"] } } }, Out: { type: "string" } },
    { id: "d", kind: "decide", question: "q", decision: { type: "yes_no" },
      lowConfidence: { below: 0.5, run: { id: "m", kind: "model", prompt: "q", output: "F" }, value: { $ref: "fallback.v" } } }, "x"),
  { decisions: { d: { value: true, confidence: 0.1 } } });
  assert.equal(decide.ok, true);
  assert.deepEqual(messages(decide), [quoted(text, "the fallback value depends on a placeholder")]);
});

test("the certain and dependent examples of the docs come out as errors and warnings", async () => {
  const text = flat(await dryRunDoc());
  const inputSchema: JsonSchema = { type: "object", required: ["id"], properties: { id: { type: "string" } } };
  const template = wf({ In: inputSchema, Out: { type: "object", required: ["u"], properties: { u: { type: "string", minLength: 12 } } } },
    { id: "w", kind: "wait", question: "q" }, { u: "https://{{input.id}}" });
  const madeUp = dry(template);
  assert.equal(madeUp.ok, true);
  assert.deepEqual(madeUp.problems.map((p) => [p.code, p.severity]), [["placeholder_dependent", "warning"]]);
  const given = dry(template, { input: { id: "a" } });
  assert.equal(given.ok, false);
  const lengthError = /and the error `([^`]+)` with the input `\{"id": "a"\}`/.exec(text);
  assert.ok(lengthError !== null);
  assert.deepEqual(given.problems.map((p) => [p.path, p.code, p.message]), [["output.u", "schema_mismatch", lengthError[1]]]);

  const answer = dry(wf({ Out: { type: "object", required: ["u"], properties: { u: { type: "boolean" } } } },
    { id: "w", kind: "wait", question: "q" }, { u: { $ref: "steps.w.answer" } }));
  const typeError = /into a boolean output property is the validator's error `([^`]+)` at `\$\.result\.<property>`/.exec(text);
  assert.ok(typeError !== null);
  assert.match(text, /then the dry run returns the validator's error and walks nothing/);
  assert.equal(answer.ok, false);
  assert.deepEqual(answer.problems.map((p) => [p.path, p.code, p.severity, p.message]), [["$.result.u", "schema_mismatch", "error", typeError[1]]]);
  assert.deepEqual([answer.steps, answer.wouldCall], [[], []], "the dry run walks nothing");

  assert.match(text, /a model's answer, a string, into an output property with an `enum` is a warning/);
  const enumReport = dry(wf({ C: KEYED, Out: { type: "object", required: ["u"], properties: { u: { enum: ["a", "b"] } } } },
    { id: "m", kind: "model", prompt: "q", output: "C" }, { u: { $ref: "steps.m.k" } }));
  assert.equal(enumReport.ok, true);
  assert.deepEqual(enumReport.problems.map((p) => [p.path, p.code, p.severity]), [["output.u", "placeholder_dependent", "warning"]]);
});

test("no doc says that anyOf or oneOf take the first branch", async () => {
  const hits: string[] = [];
  for (const { name, text } of await allDocs()) {
    if (/(anyOf|oneOf)[^.]{0,40}take the first/.test(flat(text))) hits.push(name);
  }
  assert.deepEqual(hits, []);
});

test("architecture.md describes the output transport and the no-output rule the code has", async (t) => {
  const architecture = flat(section(await doc("docs/architecture.md"), "## Model calls: reservations, interruption and repair"));
  assert.match(architecture, /`the reply carried no structured output`/);
  assert.match(architecture, new RegExp(`the one required property \`${OUTPUT_VALUE_KEY}\` \\(\`OUTPUT_VALUE_KEY\`\\)`));
  assert.ok(architecture.includes(`\`${WRAPPED_TOOL_SENTENCE}\``), "the appended sentence is quoted as sent");
  assert.ok(architecture.includes(`\`${WRAPPED_INSTRUCTION_SENTENCE}\``), "the instruction's sentence is quoted as sent");

  const wrapped = outputToolSchema({ type: "array" });
  assert.deepEqual(Object.keys(wrapped["properties"] as JsonObject), [OUTPUT_VALUE_KEY]);
  assert.deepEqual(wrapped["required"], [OUTPUT_VALUE_KEY]);
  assert.equal(wrapped["additionalProperties"], false);
  const withDefs = outputToolSchema({ type: "array", items: { $ref: "#/$defs/N" }, $defs: { N: { type: "integer" } } });
  assert.deepEqual(withDefs["$defs"], { N: { type: "integer" } });
  assert.equal(Object.hasOwn(withDefs["properties"] as JsonObject, "$defs"), false);
  assert.deepEqual(validateSchema(withDefs, { value: [1, 2] }), []);
  const object: JsonSchema = { type: "object" };
  assert.equal(outputToolSchema(object), object, "an object schema is sent as it is");

  // Bare values, the wrapper, JSON text and no output, as the docs describe them.
  assert.deepEqual(readOutputArgs({ type: "array" }, [1, 2]), { kind: "value", value: [1, 2] });
  assert.deepEqual(readOutputArgs({ type: "array" }, { value: [1, 2] }), { kind: "value", value: [1, 2] });
  assert.deepEqual(readOutputArgs({ type: "array" }, {}), { kind: "missing" });
  assert.deepEqual(readOutputArgs({ type: "object" }, [1]), { kind: "not_object" });
  assert.deepEqual(readOutputText(" [1, 2] "), { kind: "value", value: [1, 2] });
  assert.deepEqual(readOutputText("I cannot say"), { kind: "missing" });
  assert.match(architecture, /Arguments that are not a JSON object fail the reply \(`model_failed`, billing `"unknown"`\); they are never replaced by `\{\}`/);

  // The engine journals a reply with no output as model.invalid with the quoted problem, and repairs it.
  const driver: Driver = async (ctx): Promise<Json> => {
    try {
      const result = await ctx.model("answer", {
        purpose: "step", system: "Answer.", messages: [{ role: "user", content: "well?" }], maxOutputTokens: 100,
        output: { name: "Answer", schema: { type: ["string", "null"] } },
      });
      return { output: result.output };
    } catch (error) {
      if (!isRunwrightError(error)) throw error;
      return { code: error.code };
    }
  };
  const missing = (request: ModelRequest): ModelResponse =>
    (request.messages.length > 1 ? reply({ output: null }) : { ...reply({ text: "I cannot say", output: null }), outputMissing: true });
  const h = await createHarness(t, { models: fakeModels(missing), drivers: { agent: driver } });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id);
  const done = await h.until(run.id, "completed");
  const [invalid] = await h.records(run.id, "model.invalid");
  assert.deepEqual(invalid?.problems, [{ path: "$", message: "the reply carried no structured output" }]);
  assert.deepEqual(done.output, { output: null }, "the repair's answered null is accepted");
});

test("the scripted model answers an unscripted structured step with the placeholder, and needs a script entry when none validates", async (t) => {
  const configuration = flat(await doc("docs/configuration.md"));
  assert.match(configuration, /A structured step that has a step name \(a workflow node's id, for example\) and no script entry is answered with a placeholder of its schema/);
  assert.match(configuration, /so give such a step a script entry/);
  const provider = createScriptedProvider();
  const request = (schema: JsonSchema): ModelRequest => ({
    model: { provider: "scripted", name: "scripted-1", script: { turns: [] } }, system: "s", messages: [{ role: "user", content: "go" }],
    tools: [], output: { name: "Out", schema }, maxOutputTokens: 100,
    meta: { runId: "run_1", key: "k", purpose: "step", turn: 1, step: "m", attempt: 1 },
  });
  const signal = new AbortController().signal;
  const good: JsonSchema = { type: "string", pattern: "^[A-Z]{2}$", minLength: 2, maxLength: 2 };
  const answered = await provider.generate(request(good), { signal });
  assert.deepEqual(answered.output, generatePlaceholder(good).value);
  assert.deepEqual(validateSchema(good, answered.output), []);
  const bad: JsonSchema = { type: "string", pattern: "^(?=A)[A-Z]{2}$" };
  const invalid = await provider.generate(request(bad), { signal });
  assert.ok(validateSchema(bad, invalid.output).length > 0, "the unsatisfied placeholder is an invalid answer");

  // Through the engine: the named step's answer and its repair are both the unsatisfied placeholder.
  const driver: Driver = async (ctx): Promise<Json> => {
    try {
      await ctx.model("answer", {
        purpose: "step", step: "m", system: "Answer.", messages: [{ role: "user", content: "well?" }], maxOutputTokens: 100,
        output: { name: "Out", schema: bad },
      });
      return { code: null };
    } catch (error) {
      if (!isRunwrightError(error)) throw error;
      return { code: error.code };
    }
  };
  const h = await createHarness(t, { models: fakeModels((req, options) => provider.generate(req, options)), drivers: { agent: driver } });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id);
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, { code: "model_output_invalid" });
  const types = (await h.journal(run.id)).filter((r) => r.key === "answer" && r.type.startsWith("model.")).map((r) => r.type);
  assert.deepEqual(types, ["model.started", "model.invalid", "model.started", "model.failed"]);
});

test("learning.md's promotion step: warnings do not reject a draft, and a rejection lists only errors", async () => {
  const learning = flat(section(await doc("docs/learning.md"), "## Skill promotion"));
  assert.match(learning, /\[what `ok` means\]\(workflows\.md#what-ok-means\)/);
  assert.match(learning, /Warnings about placeholder-dependent values \(code `placeholder_dependent`/);
  assert.match(learning, /do not reject a draft and do not count as a failed attempt/);
  assert.match(learning, /the recorded problems are the dry run's errors only, each as `dry run <path>: <message> \(<code>\)`/);
  assert.match(learning, /warnings never appear among them/);
  assert.match(flat(await workflowsDoc()), /### What `ok` means/);

  const options = { name: "skill-probe", tools: [], resolveWorkflow: (): WorkflowDocument | null => null };
  // A model step and a workflow output whose `code` has a pattern and an exact length: the placeholder satisfies it.
  const code: JsonSchema = { type: "object", required: ["code"], properties: { code: { type: "string", pattern: "^[A-Z]{2}$", minLength: 2, maxLength: 2 } } };
  const patterned = wf({ Code: code, Out: code }, { id: "m", kind: "model", prompt: "Code?", output: "Code" }, { code: { $ref: "steps.m.code" } });
  const clean = dry(patterned);
  assert.deepEqual([clean.ok, clean.problems], [true, []]);
  const keptPatterned = checkDraft({ document: patterned as unknown as Json }, options);
  assert.ok(keptPatterned.ok, JSON.stringify(keptPatterned));
  assert.equal(JSON.stringify(keptPatterned.document.root), JSON.stringify(patterned.root), "the document is kept as drafted");
  // A pattern no placeholder can be made for: warnings only, and the draft is still kept.
  const kept = checkDraft({ document: lookaheadDocument() as unknown as Json }, options);
  assert.ok(kept.ok, JSON.stringify(kept));
  assert.equal(kept.document.name, "skill-probe");
  assert.equal(JSON.stringify(kept.document.root), JSON.stringify(lookaheadDocument().root));

  const mixed = wf(
    { M: LOOKAHEAD, Out: { type: "object", required: ["u", "c"], properties: { u: { type: "boolean" }, c: { type: "string", pattern: "^(?=A)[A-Z]{2}$" } } } },
    { id: "s", kind: "sequence", steps: [
      { id: "m", kind: "model", prompt: "q", output: "M" },
      { id: "b", kind: "branch", on: { $ref: "steps.m.code" }, cases: [{ when: "AB", run: { id: "f", kind: "fail", message: "no", deadlineMs: 1000 } }] },
      { id: "w", kind: "wait", question: "q" },
    ] },
    { u: { $ref: "steps.w.answer" }, c: { $ref: "steps.m.code" } });
  assert.match(learning, /A draft that the validator rejects records the validator's errors only, each as `<path>: <message> \(<code>\)`/);
  const report = dry(mixed);
  assert.deepEqual(report.problems.map((p) => [p.code, p.severity]), [["bad_deadline", "warning"], ["schema_mismatch", "error"]], "the report has a warning too");
  const rejected = checkDraft({ document: mixed as unknown as Json }, options);
  assert.deepEqual(rejected, { ok: false, problems: ['$.result.u: does not fit schema "Out": is string, but expected boolean (schema_mismatch)'] });

  // A draft the validator passes and its dry run rejects with an error next to a warning: a chain of saved
  // workflows that nests deeper than the call bound, after a model step with no placeholder.
  const saved = new Map<string, WorkflowDocument>();
  for (let i = 1; i <= 17; i++) {
    saved.set(`w${i}`, {
      format: "runwright.workflow/v1", name: `w${i}`, input: "Any", output: "Any", schemas: { Any: {} },
      root: i < 17 ? { id: "c", kind: "call", workflow: `w${i + 1}`, input: {} } : { id: "x", kind: "wait", question: "q" }, result: {},
    } as unknown as WorkflowDocument);
  }
  const chained = { ...options, resolveWorkflow: (name: string): WorkflowDocument | null => saved.get(name) ?? null };
  const deep = wf({ M: LOOKAHEAD, Out: { type: "object" } },
    { id: "s", kind: "sequence", steps: [{ id: "m", kind: "model", prompt: "q", output: "M" }, { id: "c", kind: "call", workflow: "w1", input: {} }] }, {});
  const deepReport = dryRunWorkflow(deep, { resolveWorkflow: chained.resolveWorkflow });
  assert.deepEqual(deepReport.problems.map((p) => [p.code, p.severity]), [["placeholder_dependent", "warning"], ["limit_exceeded", "error"]]);
  assert.deepEqual(checkDraft({ document: deep as unknown as Json }, chained),
    { ok: false, problems: ["dry run $.root: sub-workflow calls nest deeper than 16 (limit_exceeded)"] });
});

test("cli.md and api.md: warnings come with ok: true, the CLI prints them under Problems, prints Dry run OK. and exits 0", { timeout: 30_000 }, async (t) => {
  const cliDoc = flat(await doc("docs/cli.md"));
  assert.match(cliDoc, /every problem under "Problems", and then `Dry run OK\.` \(exit 0\) or `Dry run failed\.` \(exit 1\)/);
  assert.match(cliDoc, /a report with only warnings still prints `Dry run OK\.` and exits 0/);
  const apiDoc = flat(await doc("docs/api.md"));
  assert.match(apiDoc, /`report\.problems` can hold warnings with code `placeholder_dependent` while `report\.ok` is true, because warnings never change `ok`/);

  const s = await cliServer(t);
  const file = join(s.dir, "lookahead.json");
  await writeFile(file, JSON.stringify(lookaheadDocument()));
  const out = await cli(["workflows", "dry-run", file], { dataDir: s.dir, isTTY: true });
  assert.equal(out.code, 0, out.stderr);
  const problemsAt = out.stdout.indexOf("Problems:\n");
  assert.ok(problemsAt >= 0, out.stdout);
  assert.match(out.stdout.slice(problemsAt), /^ {2}warning \S+ placeholder_dependent: /m);
  assert.match(out.stdout, /Dry run OK\.\s*$/);

  const report = await s.client.dryRunWorkflow(lookaheadDocument() as unknown as Json);
  assert.equal(report.ok, true);
  assert.ok(report.problems.length > 0 && report.problems.every((p) => p.code === "placeholder_dependent" && p.severity === "warning"));
});
