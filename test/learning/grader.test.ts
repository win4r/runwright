import { test } from "node:test";
import assert from "node:assert/strict";
import type { Json } from "../../src/core/json.ts";
import type { CandidateItem } from "../../src/learning/checks.ts";
import { combineVerdicts, GRADES_SCHEMA, MAX_REASON_CHARS } from "../../src/learning/grader.ts";
import { validateSchema } from "../../src/schema/validate.ts";
import type { ProvenanceVerdict } from "../../src/learning/provenance.ts";
import { buildDigest, capText } from "../../src/learning/proposal.ts";
import type { JournalRecord } from "../../src/store/types.ts";

const note: CandidateItem = { path: "notes/a.md", kind: "note", name: "a", title: "A", description: "a", body: "a body" };
const skill: CandidateItem = { path: "skills/s.md", kind: "skill", name: "s", title: "S", description: "s", body: "steps" };
const keep = (path: string): ProvenanceVerdict => ({ path, verdict: "keep", field: "whole", overlap: 0, verbatimRun: false, reason: "none" });

test("the stricter of grader and provenance wins; the grader cannot upgrade", () => {
  const provenance: ProvenanceVerdict[] = [{ ...keep("notes/a.md"), verdict: "hold", reason: "partly copied" }];
  const decisions = combineVerdicts({
    candidates: [note], provenance, proposalJobFinished: true,
    grader: { job_finished: true, decisions: [{ path: "notes/a.md", verdict: "keep", reason: "great" }] },
  });
  assert.deepEqual(decisions, [{ path: "notes/a.md", verdict: "hold", reason: "partly copied", by: "provenance" }]);
  const graderDrop = combineVerdicts({
    candidates: [note], provenance, proposalJobFinished: true,
    grader: { job_finished: true, decisions: [{ path: "notes/a.md", verdict: "drop", reason: "vague" }] },
  });
  assert.deepEqual(graderDrop[0], { path: "notes/a.md", verdict: "drop", reason: "vague", by: "grader" });
});

test("missing decision → hold; skill needs job_finished from both; grader unavailable → hold", () => {
  const grader = { job_finished: false, decisions: [{ path: "skills/s.md", verdict: "keep", reason: "ok" }] };
  const decisions = combineVerdicts({ candidates: [note, skill], provenance: [keep(note.path), keep(skill.path)], proposalJobFinished: true, grader });
  assert.equal(decisions[0]?.verdict, "hold");
  assert.deepEqual([decisions[1]?.verdict, decisions[1]?.by], ["drop", "rule"]);
  const unavailable = combineVerdicts({ candidates: [note], provenance: [keep(note.path)], proposalJobFinished: true, grader: null, graderUnavailable: "limit" });
  assert.equal(unavailable[0]?.verdict, "hold");
  assert.match(unavailable[0]?.reason ?? "", /limit/);
});

test("an item whose earlier version is held stays held", () => {
  const decisions = combineVerdicts({
    candidates: [note], provenance: [keep(note.path)], proposalJobFinished: true, heldPaths: ["notes/a.md"],
    grader: { job_finished: true, decisions: [{ path: "notes/a.md", verdict: "keep", reason: "fine" }] },
  });
  assert.deepEqual([decisions[0]?.verdict, decisions[0]?.by], ["hold", "rule"]);
});

test("the digest marks untrusted results, leaves out learning steps and keeps the start and the end", () => {
  const record = (seq: number, type: string, key: string | null, data: JournalRecord["data"]): JournalRecord => ({ runId: "r", seq, epoch: 1, ts: 0, type, key, data });
  const journal = [
    record(1, "model.finished", "t1", { purpose: "run", text: "fetching", toolCalls: [{ id: "c", name: "web_fetch", args: { url: "https://x.test" } }], output: null }),
    record(2, "tool.finished", "t1.c0", { tool: "web_fetch", outcome: "ok", content: "page text", untrusted: true }),
    record(3, "model.finished", "learning/propose", { purpose: "learning", text: "SHOULD NOT APPEAR", toolCalls: [], output: null }),
  ];
  const digest = buildDigest(journal, "go fetch", { text: "done" });
  assert.match(digest, /First message: go fetch/);
  assert.match(digest, /calls web_fetch\(\{"url":"https:\/\/x\.test"\}\)/);
  assert.match(digest, /web_fetch → ok \[untrusted\]: page text/);
  assert.ok(!digest.includes("SHOULD NOT APPEAR"));
  assert.match(digest, /Final output: \{"text":"done"\}/);
  const capped = capText(`${"a".repeat(30_000)}${"z".repeat(30_000)}`, 24_000);
  assert.equal(capped.length, 24_000);
  assert.ok(capped.startsWith("aaa") && capped.endsWith("zzz"));
});

test("each grader decision is checked alone: a malformed one is held, the others apply", () => {
  const third: CandidateItem = { ...note, path: "notes/c.md", name: "c" };
  const malformed: Json[] = [
    { path: "notes/c.md", verdict: "maybe", reason: "?" },
    { path: "notes/c.md", verdict: "keep", reason: 3 },
    { path: "notes/c.md", verdict: "keep" },
    { path: "notes/c.md", verdict: "keep", reason: "ok", extra: true },
  ];
  for (const bad of malformed) {
    const grader: Json = { job_finished: true, decisions: [{ path: note.path, verdict: "keep", reason: "good" }, bad, { path: skill.path, verdict: "drop", reason: "vague" }] };
    assert.deepEqual(validateSchema(GRADES_SCHEMA, grader), [], "the envelope accepts the reply");
    const decisions = combineVerdicts({ candidates: [note, third, skill], provenance: [keep(note.path), keep(third.path), keep(skill.path)], proposalJobFinished: true, grader });
    assert.deepEqual(decisions, [
      { path: note.path, verdict: "keep", reason: "good", by: "grader" },
      { path: third.path, verdict: "hold", reason: "the grader's decision was malformed; a person decides", by: "grader" },
      { path: skill.path, verdict: "drop", reason: "vague", by: "grader" },
    ], JSON.stringify(bad));
  }
  const fixedLater = combineVerdicts({
    candidates: [note], provenance: [keep(note.path)], proposalJobFinished: true,
    grader: { job_finished: true, decisions: [{ path: note.path, verdict: "nope" }, { path: note.path, verdict: "keep", reason: "second try" }] },
  });
  assert.deepEqual(fixedLater[0], { path: note.path, verdict: "keep", reason: "second try", by: "grader" });
  assert.equal(validateSchema(GRADES_SCHEMA, { job_finished: true }).length > 0, true, "the envelope is still required");
});

test("a grader reason is cut to 500 characters", () => {
  const long = "é".repeat(MAX_REASON_CHARS + 40);
  const [decision] = combineVerdicts({
    candidates: [note], provenance: [keep(note.path)], proposalJobFinished: true,
    grader: { job_finished: true, decisions: [{ path: note.path, verdict: "drop", reason: long }] },
  });
  assert.equal(MAX_REASON_CHARS, 500);
  assert.equal(decision?.reason, "é".repeat(500));
});
