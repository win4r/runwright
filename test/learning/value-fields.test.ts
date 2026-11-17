import { test } from "node:test";
import assert from "node:assert/strict";
import { createRedactor } from "../../src/core/redact.ts";
import type { Json, JsonObject } from "../../src/core/json.ts";
import { planApply } from "../../src/learning/apply.ts";
import { checkProposal } from "../../src/learning/checks.ts";
import { assessProvenance } from "../../src/learning/provenance.ts";
import { selectItems } from "../../src/learning/select.ts";
import {
  APPLIED_VALUE_FIELDS, CHECKED_VALUE_FIELDS, DRAFT_OUTPUT_FIELDS, GIVEN_VALUE_FIELDS, GRADES_OUTPUT_FIELDS, PICKED_VALUE_FIELDS,
  PROMOTION_VALUE_FIELDS, PROPOSAL_OUTPUT_FIELDS, PROVENANCE_VALUE_FIELDS,
} from "../../src/learning/value-fields.ts";
import {
  isFieldSpec, listedNames, redactBySpec, unlistedPaths, type ArraySpec, type FieldSpec, type MapSpec, type ObjectSpec,
} from "../../src/store/record-fields.ts";
import type { LearningItem } from "../../src/store/types.ts";
import type { WorkflowDocument } from "../../src/workflow/types.ts";
import { promoteSkill, seedLearningItems } from "../helpers/learning.ts";
import { openTestStore, testAgentDefinition } from "../helpers/store.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { wordSecrets } from "../helpers/two-layer.ts";
import { itemFile } from "./support.ts";

const SPECS: Readonly<Record<string, FieldSpec>> = {
  GIVEN_VALUE_FIELDS, CHECKED_VALUE_FIELDS, PROVENANCE_VALUE_FIELDS, APPLIED_VALUE_FIELDS, PICKED_VALUE_FIELDS,
  PROMOTION_VALUE_FIELDS, PROPOSAL_OUTPUT_FIELDS, GRADES_OUTPUT_FIELDS, DRAFT_OUTPUT_FIELDS,
};

function kindOf(spec: ObjectSpec | ArraySpec | MapSpec): "object" | "array" | "map" {
  return Object.hasOwn(spec, "items") ? "array" : Object.hasOwn(spec, "values") ? "map" : "object";
}

function deeplyFrozen(spec: FieldSpec): boolean {
  if (typeof spec === "string") return true;
  if (!Object.isFrozen(spec)) return false;
  const kind = kindOf(spec);
  if (kind === "array") return deeplyFrozen((spec as ArraySpec).items);
  if (kind === "map") return deeplyFrozen((spec as MapSpec).values);
  const object = spec as ObjectSpec;
  return Object.isFrozen(object.fields) && Object.values(object.fields).every(deeplyFrozen);
}

test("each of the nine specifications is a deeply frozen field specification", () => {
  for (const [name, spec] of Object.entries(SPECS)) {
    assert.equal(isFieldSpec(spec), true, name);
    assert.equal(deeplyFrozen(spec), true, name);
  }
});

const WORKFLOW = {
  format: "runwright.workflow/v1", name: "draft", schemas: { In: { type: "object" }, Out: { type: "object" } }, input: "In", output: "Out",
  root: { id: "write", kind: "model", prompt: "Write the weekly report", output: "Out" }, result: { $ref: "steps.write" },
} as unknown as WorkflowDocument;

async function storedItems(t: import("node:test").TestContext): Promise<{ note: LearningItem; skill: LearningItem }> {
  const { store } = await openTestStore(t);
  await store.saveAgent({ id: "learner", definition: testAgentDefinition() });
  const [note, skill] = await seedLearningItems(store, "learner", [
    { kind: "note", name: "build", title: "Build command", description: "How this project builds.", body: "Run make all from the repository root and wait two minutes. ".repeat(20), status: "active" },
    { kind: "skill", name: "report", title: "Weekly report", description: "How to write the report.", body: "1. Collect.\n2. Write.", status: "active" },
  ]);
  const promoted = await promoteSkill(store, skill as LearningItem, "skill-report-x", WORKFLOW);
  return { note: note as LearningItem, skill: promoted };
}

test("PICKED_VALUE_FIELDS lists exactly the fields of a learning item read from the store", async (t) => {
  const { note, skill } = await storedItems(t);
  const listed = new Set(listedNames(PICKED_VALUE_FIELDS));
  for (const item of [note, skill]) assert.deepEqual(new Set(Object.keys(item)), listed);
  assert.equal(typeof skill.promotedWorkflow, "string", "the promoted skill has every field set");
});

/** [path, value] of every value the specification keeps, and of every object key, for comparing two values. */
function fixedParts(value: Json, spec: FieldSpec, path = "$"): [string, Json][] {
  if (value === null || spec === "payload" || spec === "text") return [];
  if (spec === "keep") return [[path, value]];
  const kind = kindOf(spec);
  if (kind === "array") {
    return Array.isArray(value) ? value.flatMap((item, i) => fixedParts(item ?? null, (spec as ArraySpec).items, `${path}[${i}]`)) : [];
  }
  if (typeof value !== "object" || Array.isArray(value)) return [];
  const out: [string, Json][] = [[`${path} keys`, Object.keys(value)]];
  for (const key of Object.keys(value)) {
    const inner = kind === "map" ? (spec as MapSpec).values : (spec as ObjectSpec).fields[key];
    if (inner !== undefined) out.push(...fixedParts(value[key] ?? null, inner, `${path}.${key}`));
  }
  return out;
}

async function representativeValues(t: import("node:test").TestContext): Promise<Record<string, Json>> {
  const { note, skill } = await storedItems(t);
  const proposal = {
    job_finished: true,
    files: [
      { path: "notes/build.md", content: itemFile("Build command", "How this project builds.", "Run make all.") },
      { path: "skills/report.md", content: itemFile("Weekly report", "How to write the report.", "1. Collect.\n2. Write.") },
      { path: "notes/Bad!.md", content: itemFile("Bad", "Bad.", "Bad.") },
    ],
  };
  const checked = checkProposal(proposal, { maxNotes: 5, maxSkills: 2, existing: { "notes/build.md": "active", "skills/report.md": "active" } });
  const provenance = await assessProvenance(checked.items, [], await makeTempDir(t, "runwright-values-"));
  const decisions = checked.items.map((item) => ({ path: item.path, verdict: item.kind === "note" ? "keep" : "hold", reason: "useful", by: "grader" }) as const);
  const applied = planApply({
    decisions: [...decisions, { path: "notes/gone.md", verdict: "keep", reason: "x", by: "grader" }], candidates: checked.items,
    versions: { "notes/build.md": note.version, "skills/report.md": skill.version }, current: [note, skill], newId: () => "li_new",
  });
  return {
    GIVEN_VALUE_FIELDS: selectItems([note, skill], "build", 160) as unknown as Json,
    CHECKED_VALUE_FIELDS: { ...checked, heldPaths: ["skills/report.md"], versions: { "notes/build.md": note.version, "skills/report.md": skill.version } } as unknown as Json,
    PROVENANCE_VALUE_FIELDS: provenance as unknown as Json,
    APPLIED_VALUE_FIELDS: { ...applied.value, conflicts: [{ path: "notes/old.md", reason: "retired" }] } as unknown as Json,
    PICKED_VALUE_FIELDS: skill as unknown as Json,
    PROMOTION_VALUE_FIELDS: { outcome: "rejected", workflow: null, problems: ["$.root: unknown node kind (unknown_kind)"] },
    PROPOSAL_OUTPUT_FIELDS: proposal,
    GRADES_OUTPUT_FIELDS: { job_finished: true, decisions: [{ path: "notes/build.md", verdict: "keep", reason: "useful" }] },
    DRAFT_OUTPUT_FIELDS: { document: WORKFLOW as unknown as Json },
  };
}

test("with every name of a specification as a secret, its value keeps every key and every kept value", async (t) => {
  const values = await representativeValues(t);
  for (const [name, spec] of Object.entries(SPECS)) {
    const value = values[name] as Json;
    const secrets = wordSecrets(spec);
    const redactor = createRedactor(Object.fromEntries(secrets.map((secret, i) => [`S${i}`, secret])));
    const redacted = redactBySpec(value, spec, redactor);
    assert.deepEqual(fixedParts(redacted, spec), fixedParts(value, spec), name);
    assert.notDeepEqual(fixedParts(redactor.payload(value), spec), fixedParts(value, spec), `${name}: as a payload its keys would change`);
    assert.deepEqual(unlistedPaths(value, spec), [], `${name}: the representative value is fully named`);
    assert.deepEqual(unlistedPaths(redacted, spec), [], `${name}: and so is its redacted form`);
  }
  // The table's shape holds where the producers put something in every field.
  const given = values["GIVEN_VALUE_FIELDS"] as JsonObject;
  assert.deepEqual((given["given"] as JsonObject[]).map((g) => g["mode"]), ["full", "line"]);
  assert.deepEqual(given["tools"], ["recall"]);
  const applied = values["APPLIED_VALUE_FIELDS"] as JsonObject;
  assert.ok(Array.isArray(applied["kept"]) && applied["kept"].length > 0 && Array.isArray(applied["held"]) && applied["held"].length > 0);
});

test("versions: a path holding a secret is redacted to the same text as the item's path; a version stays a number", () => {
  const path = "notes/zebra-ledger.md";
  const value = {
    dropAll: null, jobFinished: true,
    items: [{ path, kind: "note", name: "zebra-ledger", title: "Ledger", description: "Where the ledger is.", body: "In the sheet." }],
    dropped: [], heldPaths: [path], versions: { [path]: 12345678 },
  };
  const redactor = createRedactor({ PATH_PART: "zebra-ledger", NUMBER: "12345678" });
  const redacted = redactBySpec(value, CHECKED_VALUE_FIELDS, redactor) as JsonObject;
  const items = redacted["items"] as JsonObject[];
  const storedPath = items[0]?.["path"];
  assert.equal(typeof storedPath, "string");
  assert.notEqual(storedPath, path, "the path is redacted as text");
  assert.deepEqual(redacted["versions"], { [storedPath as string]: 12345678 }, "found by the stored path, as a number");
  assert.deepEqual(redacted["heldPaths"], [storedPath]);
  assert.equal(typeof redactor.payload(12345678), "string", "as a payload the same number would not stay a number");
});
