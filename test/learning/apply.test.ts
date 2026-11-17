import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFLICT_REASONS, itemPath, planApply } from "../../src/learning/apply.ts";
import type { CandidateItem } from "../../src/learning/checks.ts";
import type { Decision } from "../../src/learning/grader.ts";
import type { LearningItem } from "../../src/store/types.ts";

const candidate = (name: string, body = `${name} body`): CandidateItem => ({
  path: `notes/${name}.md`, kind: "note", name, title: name, description: `${name} description`, body,
});
const stored = (name: string, patch: Partial<LearningItem> = {}): LearningItem => ({
  id: `li_${name}`, agentId: "a", kind: "note", name, title: name, description: `${name} description`, body: `${name} body`,
  status: "active", version: 1, etag: "e", sourceRunId: "run_0", promotedWorkflow: null, promotedWorkflowVersion: null, promotionAttempts: 0,
  createdAt: 1, updatedAt: 1, ...patch,
});
const keep = (name: string): Decision => ({ path: `notes/${name}.md`, verdict: "keep", reason: "useful", by: "grader" });
const hold = (name: string): Decision => ({ path: `notes/${name}.md`, verdict: "hold", reason: "check", by: "grader" });

function ids(): () => string {
  let n = 0;
  return () => `li_new${++n}`;
}

test("itemPath names notes and skills by folder", () => {
  assert.equal(itemPath({ kind: "note", name: "build" }), "notes/build.md");
  assert.equal(itemPath({ kind: "skill", name: "deploy" }), "skills/deploy.md");
});

test("planApply follows the version table", () => {
  const candidates = [
    candidate("fresh"), candidate("raced"), candidate("edited", "new body"), candidate("retired", "new body"),
    candidate("same"), candidate("changed", "new body"), candidate("held"), candidate("dropped"), candidate("vanished"),
  ];
  const decisions: Decision[] = [
    keep("fresh"), keep("raced"), keep("edited"), keep("retired"), keep("same"), keep("changed"), hold("held"),
    { path: "notes/dropped.md", verdict: "drop", reason: "no", by: "grader" }, keep("vanished"),
  ];
  const versions = { "notes/edited.md": 1, "notes/retired.md": 1, "notes/same.md": 3, "notes/changed.md": 2, "notes/held.md": 1, "notes/vanished.md": 1 };
  const current = [
    stored("raced"), stored("edited", { version: 2 }), stored("retired", { status: "retired", version: 2 }),
    stored("same", { version: 3 }), stored("changed", { version: 2 }), stored("held"),
  ];
  const { value, puts } = planApply({ decisions, candidates, versions, current, newId: ids() });

  assert.deepEqual(value.kept, [
    { itemId: "li_new1", path: "notes/fresh.md", version: 1 },
    { itemId: "li_same", path: "notes/same.md", version: 3 },
    { itemId: "li_changed", path: "notes/changed.md", version: 3 },
  ]);
  assert.deepEqual(value.held, [{ itemId: "li_held", path: "notes/held.md", version: 2 }]);
  assert.deepEqual(value.conflicts, [
    { path: "notes/raced.md", reason: CONFLICT_REASONS.created },
    { path: "notes/edited.md", reason: CONFLICT_REASONS.changed },
    { path: "notes/retired.md", reason: CONFLICT_REASONS.retired },
    { path: "notes/vanished.md", reason: CONFLICT_REASONS.changed },
  ]);
  assert.deepEqual(puts, [
    { id: "li_new1", kind: "note", name: "fresh", title: "fresh", description: "fresh description", body: "fresh body", status: "active", note: "useful", expectedVersion: null },
    { id: "li_changed", kind: "note", name: "changed", title: "changed", description: "changed description", body: "new body", status: "active", note: "useful", expectedVersion: 2 },
    { id: "li_held", kind: "note", name: "held", title: "held", description: "held description", body: "held body", status: "held", note: "check", expectedVersion: 1 },
  ]);
});

test("planApply never writes a retired item, whatever the checked version or content", () => {
  const { value, puts } = planApply({
    decisions: [keep("old")], candidates: [candidate("old")], versions: { "notes/old.md": 4 },
    current: [stored("old", { status: "retired", version: 4 })], newId: ids(),
  });
  assert.deepEqual(puts, []);
  assert.deepEqual(value.conflicts, [{ path: "notes/old.md", reason: "retired" }]);
});
