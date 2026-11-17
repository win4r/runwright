import { test } from "node:test";
import assert from "node:assert/strict";
import type { Json } from "../../src/core/json.ts";
import { createRedactor } from "../../src/core/redact.ts";
import { checkDraft, type CatalogueTool } from "../../src/learning/promotion.ts";
import type { WorkflowDocument } from "../../src/workflow/types.ts";

const TOOLS: CatalogueTool[] = [{ name: "lookup", description: "Looks something up.", parameters: { type: "object" }, retrySafe: true }];
const OPTIONS = { name: "skill-probe-01j", tools: TOOLS, resolveWorkflow: () => null };

function draft(schemas: { [name: string]: Json }, root: Json, result: Json): Json {
  return { document: {
    format: "runwright.workflow/v1", name: "draft", input: "In", output: "Out",
    schemas: { In: { type: "object" }, Out: { type: "object" }, ...schemas }, root, result,
  } };
}

const lookup = (id: string): Json => ({ id, kind: "tool", tool: "lookup", args: {} });
const codeOut = (pattern: string): Json => ({ type: "object", required: ["code"], properties: { code: { type: "string", pattern, minLength: 2, maxLength: 2 } } });

function kept(value: Json): void {
  const check = checkDraft(value, OPTIONS);
  assert.equal(check.ok, true, JSON.stringify(check));
  if (check.ok) assert.equal(check.document.name, OPTIONS.name);
}

test("the reviewer's document and its look-ahead variant are kept", () => {
  const model = { id: "m", kind: "model", prompt: "Give a code", output: "Out" };
  kept(draft({ Out: codeOut("^[A-Z]{2}$") }, model, { $ref: "steps.m" }));
  kept(draft({ Out: codeOut("^(?=[A-Z]{2}$)[A-Z]+$") }, model, { $ref: "steps.m" }));
});

test("drafts whose dry run only has placeholder-dependent warnings are kept: rows (a), (d), (f), (g)", () => {
  kept(draft({ M: { type: "object", required: ["code"], properties: { code: { type: "string" } } }, Out: { type: "object", properties: { code: { enum: ["a", "b"] } } } },
    { id: "m", kind: "model", prompt: "p", output: "M" }, { code: { $ref: "steps.m.code" } }));
  kept(draft({ Out: { type: "object", required: ["n"], properties: { n: { type: "integer" } } } }, lookup("t"), { n: { $ref: "steps.t.data.count" } }));
  kept(draft({ M: { type: "object", required: ["kind"], properties: { kind: { type: "string" } } } },
    { id: "main", kind: "sequence", steps: [{ id: "m", kind: "model", prompt: "p", output: "M" },
      { id: "route", kind: "branch", on: { $ref: "steps.m.kind" }, cases: [{ when: "bug", run: lookup("file") }], default: { id: "stop", kind: "fail", message: "unknown kind" } }] },
    {}));
  kept(draft({ M: { type: "object", required: ["done"], properties: { done: { type: "boolean" } } } },
    { id: "lp", kind: "loop", maxIterations: 3, onLimit: "fail", until: { truthy: { $ref: "steps.m.done" } }, run: { id: "m", kind: "model", prompt: "p", output: "M" } },
    { $ref: "steps.lp" }));
});

test("an unconditional fail is rejected with the step note; a certain mismatch lists its error and no warning", () => {
  const failing = checkDraft(draft({}, { id: "stop", kind: "fail", message: "cannot do it" }, {}), OPTIONS);
  assert.equal(failing.ok, false);
  if (!failing.ok) assert.match(failing.problems.join("\n"), /dry run .*would fail/);

  const out = { type: "object", required: ["n", "code"], properties: { n: { type: "integer" }, code: { type: "string", pattern: "^(?=[A-Z]{2}$)[A-Z]+$" } } };
  const certain = checkDraft(draft({ Out: out, M: { type: "object", required: ["code"], properties: { code: { type: "string" } } } },
    { id: "main", kind: "sequence", steps: [{ id: "w", kind: "wait", question: "q" }, { id: "m", kind: "model", prompt: "p", output: "M" }] },
    { n: { $ref: "steps.w.answer" }, code: { $ref: "steps.m.code" } }), OPTIONS);
  assert.equal(certain.ok, false);
  if (!certain.ok) {
    assert.deepEqual(certain.problems, ['$.result.n: does not fit schema "Out": is string, but expected integer (schema_mismatch)']);
  }
});

test("a draft calling a saved workflow named like the draft's own name field is judged under the name it is stored under", () => {
  const saved = {
    format: "runwright.workflow/v1", name: "weekly", input: "In", output: "Out", schemas: { In: { type: "object" }, Out: { type: "object" } },
    root: { id: "m", kind: "model", prompt: "Write it", output: "Out" }, result: { $ref: "steps.m" },
  } as unknown as WorkflowDocument;
  const value: Json = { document: {
    format: "runwright.workflow/v1", name: "weekly", input: "In", output: "Out", schemas: { In: { type: "object" }, Out: { type: "object" } },
    root: { id: "sub", kind: "call", workflow: "weekly", input: {} }, result: { $ref: "steps.sub" },
  } };
  const check = checkDraft(value, { ...OPTIONS, resolveWorkflow: (name) => (name === "weekly" ? saved : null) });
  assert.equal(check.ok, true, JSON.stringify(check));
  if (check.ok) assert.equal(check.document.name, OPTIONS.name);
  const self = checkDraft({ document: { ...(value as { document: object }).document, root: { id: "sub", kind: "call", workflow: OPTIONS.name, input: {} } } },
    { ...OPTIONS, resolveWorkflow: () => null });
  assert.equal(self.ok, false, "a call of its own storage name is the draft itself");
});

test("a draft holding a redaction marker or a credential anywhere is rejected and the problem names where, not what", () => {
  const key = `sk-${"Dr4ft5Ecr3".repeat(3)}`;
  const model = (prompt: string): Json => ({ id: "m", kind: "model", prompt, output: "Out" });
  const cases: { name: string; value: Json; where: string; label: string }[] = [
    { name: "generic marker in a prompt", value: draft({}, model("Use [redacted] to log in"), { $ref: "steps.m" }), where: "$.document.root.prompt", label: "a redacted secret" },
    { name: "named marker in a nested step", value: draft({}, { id: "s", kind: "sequence", steps: [model("Key [redacted:API_KEY]")] }, { $ref: "steps.m" }),
      where: "$.document.root.steps[0].prompt", label: "the handed secret API_KEY" },
    { name: "marker in a schema key", value: draft({ Out: { type: "object", properties: { "[redacted]": { type: "string" } } } }, model("p"), { $ref: "steps.m" }),
      where: "$.document.schemas.Out.properties", label: "a redacted secret" },
    { name: "credential in a tool argument", value: draft({}, { id: "t", kind: "tool", tool: "lookup", args: { q: { $literal: key } } }, {}),
      where: "$.document.root.args.q.$literal", label: "an API key (sk-…)" },
  ];
  for (const c of cases) {
    const check = checkDraft(c.value, OPTIONS);
    assert.equal(check.ok, false, c.name);
    if (!check.ok) {
      assert.deepEqual(check.problems, [`${c.where}: ${c.label} was found; a draft holding a secret is not kept`], c.name);
      assert.ok(!check.problems.join("").includes(key), `${c.name}: the problem does not quote the secret`);
    }
  }
  kept(draft({}, model("The report was redacted by legal"), { $ref: "steps.m" }));
});

test("a draft holding a value the run's redactor knows is rejected", () => {
  const redactor = createRedactor({ REPORT_KEY: "report-key-value-123" });
  const value = draft({}, { id: "m", kind: "model", prompt: "Write it for report-key-value-123", output: "Out" }, { $ref: "steps.m" });
  const check = checkDraft(value, { ...OPTIONS, redactor });
  assert.equal(check.ok, false);
  if (!check.ok) assert.deepEqual(check.problems, ["$.document.root.prompt: the handed secret REPORT_KEY was found; a draft holding a secret is not kept"]);
  assert.equal(checkDraft(value, OPTIONS).ok, true, "without the redactor the value is ordinary text");
});

test("(R14-03) a draft whose loop can never end is rejected: an until that never holds with onLimit fail", () => {
  const boolIn = { type: "object", required: ["go"], properties: { go: { type: "boolean" } } };
  const done = { type: "object", required: ["done"], properties: { done: { type: "boolean" } } };
  const loop = (until: Json, run: Json): Json => ({ id: "lp", kind: "loop", maxIterations: 3, onLimit: "fail", until, run });
  const onInput = draft({ In: boolIn }, loop({ and: [{ ne: [1, 1] }, { truthy: { $ref: "input.go" } }] }, lookup("t")), {});
  const onModel = draft({ M: done }, loop({ and: [{ ne: [1, 1] }, { truthy: { $ref: "steps.m.done" } }] },
    { id: "m", kind: "model", prompt: "p", output: "M" }), {});
  for (const [label, value] of [["input", onInput], ["model step", onModel]] as const) {
    const check = checkDraft(value, OPTIONS);
    assert.equal(check.ok, false, `${label}: ${JSON.stringify(check)}`);
    if (!check.ok) assert.match(check.problems.join("\n"), /dry run .*would fail/, label);
  }
  // The same loop with an until that can hold is kept: the rejection is about the impossible condition.
  kept(draft({ M: done }, loop({ and: [{ eq: [1, 1] }, { truthy: { $ref: "steps.m.done" } }] },
    { id: "m", kind: "model", prompt: "p", output: "M" }), {}));
});
