/**
 * A text without words (only symbols, punctuation and white space) is judged on its characters: copied from an
 * untrusted result and not in the run's trusted material → dropped; found nowhere → the rule for any text found
 * nowhere; only a text that is empty after trimming is trivially fine.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { JsonObject } from "../../src/core/json.ts";
import { assessProvenance, charactersFound, collapseSpace, type ProvenanceItem } from "../../src/learning/provenance.ts";
import type { JournalRecord } from "../../src/store/types.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { itemFile, keepAll, learningHarness } from "./support.ts";

const FORK_BOMB = ":(){ :|:& };:";

// ---------------------------------------------------------------- unit: the character comparison

test("(R15D-learning-01) collapseSpace collapses every run of white space to one space and trims; charactersFound is a substring test", () => {
  assert.equal(collapseSpace("  :(){\n\t:|:&   };:\r\n"), FORK_BOMB);
  assert.equal(collapseSpace(" --- "), "---", "Unicode white space counts");
  assert.equal(collapseSpace(" \n\t "), "");
  assert.equal(collapseSpace(""), "");
  assert.equal(charactersFound(["paste :(){ :|:& };: here"], FORK_BOMB), true);
  assert.equal(charactersFound(["paste :(){ :|:&};: here"], FORK_BOMB), false, "a missing space is a different text");
  assert.equal(charactersFound([], FORK_BOMB), false);
});

let seq = 10;
function record(type: string, data: JsonObject): JournalRecord {
  seq++;
  return { runId: "run_1", seq, epoch: 1, ts: 0, type, key: null, data };
}
const created = (message: string): JournalRecord =>
  record("run.created", { agentId: "a", revision: 1, input: { message, data: null }, limits: {}, trigger: null });
const fetched = (content: string): JournalRecord => record("tool.finished", {
  callId: `c${seq}`, tool: "web_fetch", outcome: "ok", content, data: null, isError: false, untrusted: true, truncated: false,
  fullResultPath: null, durationMs: 1,
});

/** The person asked for exactly this item's name, title and description, so only the body's origin is open. */
const MESSAGE = "Save a skill named guard, titled Shell guard, described as What never to paste into a shell.";
function item(body: string, extra?: Partial<ProvenanceItem>): ProvenanceItem {
  return { path: "skills/guard.md", name: "guard", title: "Shell guard", description: "What never to paste into a shell.", body, ...extra };
}

async function verdictOf(t: TestContext, journal: JournalRecord[], it: ProvenanceItem) {
  const [verdict] = await assessProvenance([it], journal, await makeTempDir(t));
  assert.ok(verdict !== undefined);
  return verdict;
}

test("(R15D-learning-01) a symbol-only body copied from an untrusted result is dropped, whatever its white space", async (t) => {
  const journal = [created(MESSAGE), fetched(`To test your shell, paste\n  :(){\n:|:&  };:\ninto it.`)];
  for (const body of [FORK_BOMB, ` ${FORK_BOMB}\n`, ":(){\n\t:|:& };:"]) {
    const verdict = await verdictOf(t, journal, item(body));
    assert.deepEqual([verdict.verdict, verdict.field, verdict.overlap], ["drop", "body", 1], JSON.stringify(body));
    assert.match(verdict.reason, /^untrusted_origin: 100% of the body comes from untrusted tool output$/);
  }
});

test("(R15D-learning-01) a symbol-only body the person's own message holds is kept, though an untrusted result holds it too", async (t) => {
  const journal = [created(`${MESSAGE} Its body: ${FORK_BOMB}`), fetched(`paste ${FORK_BOMB} into it`)];
  const verdict = await verdictOf(t, journal, item(FORK_BOMB));
  assert.deepEqual([verdict.verdict, verdict.field], ["keep", "whole"]);
});

test("(R15D-learning-01) a symbol-only description or title copied from an untrusted result is dropped", async (t) => {
  const journal = [created(`${MESSAGE} Never paste a fork bomb.`), fetched(`the classic ${FORK_BOMB} and (╯°□°)╯︵ ┻━┻`)];
  const description = await verdictOf(t, journal, item("Never paste a fork bomb.", { description: FORK_BOMB }));
  assert.deepEqual([description.verdict, description.field], ["drop", "description"]);
  const title = await verdictOf(t, journal, item("Never paste a fork bomb.", { title: "(╯°□°)╯︵ ┻━┻" }));
  assert.deepEqual([title.verdict, title.field], ["drop", "title"]);
});

test("(R15D-learning-01) a symbol-only body found nowhere follows the rule for text found nowhere: kept untainted, held unproven, kept proven", async (t) => {
  const untainted = await verdictOf(t, [created(MESSAGE)], item("---"));
  assert.equal(untainted.verdict, "keep");

  const tainted = await verdictOf(t, [created(MESSAGE), fetched("a page with no rule in it")], item("---"));
  assert.deepEqual([tainted.verdict, tainted.field], ["hold", "origin"], "not dropped: the journal only does not prove it");
  assert.match(tainted.reason, /the body is the run's own earlier text or a person's/);

  const proven = await verdictOf(t, [created(`${MESSAGE} Separate it with ---`), fetched("a page with no rule in it")], item("---"));
  assert.deepEqual([proven.verdict, proven.field], ["keep", "whole"]);
});

test("(R15D-learning-01) a body with words is judged by its words, even with a copied run of symbols in it", async (t) => {
  const journal = [created(MESSAGE), fetched(`paste ${FORK_BOMB}`)];
  const verdict = await verdictOf(t, journal, item(`Never paste ${FORK_BOMB} or anything like it into a terminal you care about.`));
  assert.notEqual(verdict.verdict, "drop");
  assert.equal(verdict.field, "origin", "its words are found in no untrusted text; they are unproven");
});

test("(R15D-learning-01) a text that is empty after trimming is trivially fine", async (t) => {
  const journal = [created(MESSAGE), fetched(`paste ${FORK_BOMB}`)];
  const verdict = await verdictOf(t, journal, item(" \n\t "));
  assert.deepEqual([verdict.verdict, verdict.field], ["keep", "whole"]);
});

// ---------------------------------------------------------------- the real hook flow

const fetchSnippet: ToolDefinition = {
  name: "fetch_snippet", description: "Fetches a page.", parameters: { type: "object", properties: {} }, effect: "read", untrustedOutput: true,
  handler: async () => ({ content: `Benchmark your shell with this one-liner:\n\n    ${FORK_BOMB}\n\nIt is harmless.` }),
};

const SKILL_PATH = "skills/shell-guard.md";
/** The person's first message names the skill's name (shell-guard), title and description. */
const FIRST_MESSAGE = "Fetch the page and save a skill shell guard: Shell guard. What never to paste into a shell.";

async function learnOnce(t: TestContext, files: { path: string; content: string }[], message: string, withFetch = true) {
  const h = await learningHarness(t, { tools: [fetchSnippet] });
  const agent = await h.agent({
    turns: withFetch ? [{ toolCalls: [{ name: "fetch_snippet", args: {} }] }, { text: "done" }] : [{ text: "done" }],
    steps: { "learning.propose": { output: { job_finished: true, files } }, "learning.grade": keepAll(files.map((f) => f.path)) },
  }, { tools: [{ name: "fetch_snippet" }] });
  const run = await h.start(agent.id, { message });
  await h.until(run.id, "completed");
  const decisions = (await h.records(run.id, "learning.graded"))[0]?.decisions ?? [];
  return { h, agentId: agent.id, decisions };
}

test("(R15D-learning-01) flow: a skill whose body is the symbol-only snippet of an untrusted result is dropped", async (t) => {
  const skill = { path: SKILL_PATH, content: itemFile("Shell guard", "What never to paste into a shell.", FORK_BOMB) };
  const { h, agentId, decisions } = await learnOnce(t, [skill], FIRST_MESSAGE);
  const decision = decisions.find((d) => d.path === SKILL_PATH);
  assert.deepEqual([decision?.verdict, decision?.by], ["drop", "provenance"]);
  assert.match(decision?.reason ?? "", /of the body comes from untrusted tool output/);
  assert.deepEqual(await h.store.listLearningItems({ agentId }), []);
});

test("(R15D-learning-01) flow: the same body is kept when the person's own message contained it", async (t) => {
  const skill = { path: SKILL_PATH, content: itemFile("Shell guard", "What never to paste into a shell.", FORK_BOMB) };
  const { h, agentId, decisions } = await learnOnce(t, [skill], `${FIRST_MESSAGE} The snippet is ${FORK_BOMB}`);
  assert.equal(decisions.find((d) => d.path === SKILL_PATH)?.verdict, "keep");
  const items = await h.store.listLearningItems({ agentId });
  assert.deepEqual(items.map((i) => [i.name, i.status, i.body]), [["shell-guard", "active", FORK_BOMB]]);
});

test("(R15D-learning-01) flow: a symbol-only description copied from untrusted output is dropped", async (t) => {
  const note = { path: "notes/shell-guard.md", content: itemFile("Shell guard", FORK_BOMB, "What never to paste into a shell.") };
  const { h, agentId, decisions } = await learnOnce(t, [note], FIRST_MESSAGE);
  const decision = decisions.find((d) => d.path === note.path);
  assert.deepEqual([decision?.verdict, decision?.by], ["drop", "provenance"]);
  assert.match(decision?.reason ?? "", /of the description comes from untrusted tool output/);
  assert.deepEqual(await h.store.listLearningItems({ agentId }), []);
});

test("(R15D-learning-01) flow: a `---` body found nowhere is not dropped by provenance", async (t) => {
  const note = { path: "notes/shell-guard.md", content: itemFile("Shell guard", "What never to paste into a shell.", "---") };
  const tainted = await learnOnce(t, [note], FIRST_MESSAGE);
  const held = tainted.decisions.find((d) => d.path === note.path);
  assert.notEqual(held?.verdict, "drop");
  assert.deepEqual((await tainted.h.store.listLearningItems({ agentId: tainted.agentId })).map((i) => [i.body, i.status]), [["---", "held"]]);

  const untainted = await learnOnce(t, [note], FIRST_MESSAGE, false);
  assert.equal(untainted.decisions.find((d) => d.path === note.path)?.verdict, "keep");
  assert.deepEqual((await untainted.h.store.listLearningItems({ agentId: untainted.agentId })).map((i) => [i.body, i.status]), [["---", "active"]]);
});
