/**
 * "What the validator can and cannot see" in docs/workflows.md says what the code does (R11-03): its worked
 * example produces the documented error, every case it leaves to the run-time checks really is reported by
 * nothing, and it no longer says that a union destination is left to run time.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Json } from "../../src/core/json.ts";
import type { JsonSchema } from "../../src/schema/validate.ts";
import { checkAssignable } from "../../src/workflow/assign.ts";
import { dryRunWorkflow } from "../../src/workflow/dryrun.ts";
import type { WorkflowDocument, WorkflowNode } from "../../src/workflow/types.ts";
import { validateWorkflow } from "../../src/workflow/validate.ts";
import { UNKNOWN_SHAPE, plainShape, type Shape } from "../../src/workflow/walk.ts";

const WORKFLOWS = fileURLToPath(new URL("../../docs/workflows.md", import.meta.url));

async function section(): Promise<string> {
  const text = await readFile(WORKFLOWS, "utf8");
  const start = text.indexOf("\n### What the validator can and cannot see\n");
  assert.ok(start >= 0, "the section exists");
  const end = text.indexOf("\n### ", start + 1);
  return text.slice(start, end < 0 ? undefined : end);
}

const flat = (text: string): string => text.replace(/\s+/g, " ");

function check(expr: Json, schema: JsonSchema, shape: Shape): unknown[] {
  return checkAssignable({ expr, path: "$.x", schema, root: schema, refOf: () => ({ shape, presence: "always" }) });
}

test("the worked example is the validator's error, and the dry run stops on it", async () => {
  const text = flat(await section());
  const example = /with the input schema `([^`]+)`, the output schema `([^`]+)` and the result `([^`]+)`, every run would fail its output check, so the validator returns the error `([^`]+)` at `([^`]+)`/.exec(text);
  assert.ok(example !== null, "the example is in the section");
  const [, input, output, result, message, path] = example as unknown as string[];
  const document: WorkflowDocument = {
    format: "runwright.workflow/v1", name: "example",
    schemas: { In: JSON.parse(input as string) as JsonSchema, Out: JSON.parse(output as string) as JsonSchema },
    input: "In", output: "Out", root: { id: "w", kind: "wait", question: "q" }, result: JSON.parse(result as string) as Json,
  };
  const report = validateWorkflow(document);
  assert.deepEqual(report.problems.map((p) => [p.path, p.code, p.message]), [[path, "schema_mismatch", message]]);
  const dry = dryRunWorkflow(document, { input: 1 });
  assert.deepEqual([dry.ok, dry.steps, dry.wouldCall], [false, [], []]);
  assert.match(text, /a dry run stops there and calls nothing/);
});

test("every case the section leaves to run time is reported by nothing", async () => {
  const text = await section();
  const listStart = text.indexOf("Anything that cannot be decided is left to the run-time checks");
  assert.ok(listStart >= 0);
  const bullets = text.slice(listStart).split("\n\n")[1] ?? "";
  const items = flat(bullets).split(/ ?- /).filter((item) => item.length > 0).map((item) => item.replace(/[;.]$/, ""));
  const cases: [RegExp, () => void][] = [
    [/^`pattern` and `minLength` of a template string$/, () => {
      assert.deepEqual(check("id-{{input.s}}", { pattern: "^x" }, plainShape({ type: "string" })), []);
      assert.deepEqual(check("id-{{input.s}}", { minLength: 50 }, plainShape({ type: "string" })), []);
    }],
    [/^a value of unknown shape: a tool's `data`, a `branch` node's output, `loop\.<id>\.last`/, () => {
      assert.deepEqual(check({ $ref: "steps.t.data" }, { type: "string", const: "x" }, UNKNOWN_SHAPE), []);
      const tool: WorkflowDocument = {
        format: "runwright.workflow/v1", name: "data", schemas: { In: { type: "object" }, Out: { type: "string", maxLength: 1 } }, input: "In", output: "Out",
        root: { id: "t", kind: "tool", tool: "read_file", args: { path: "a.txt" } }, result: { $ref: "steps.t.data" },
      };
      assert.deepEqual(validateWorkflow(tool).problems.filter((p) => p.code === "schema_mismatch"), []);
    }],
    [/^a schema that does not pin its types \(a schema with only `properties` also accepts a string\)$/, () => {
      assert.deepEqual(check({ $ref: "input.p" }, { type: "string" }, plainShape({ properties: { a: {} } })), []);
    }],
    [/^a type that may fit$/, () => {
      assert.deepEqual(check({ $ref: "input.n" }, { type: "integer" }, plainShape({ type: "number" })), []);
    }],
    [/^the length and the items of a `map` node's output list$/, () => {
      assert.deepEqual(check({ $ref: "steps.m" }, { type: "array", minItems: 3, maxItems: 0, items: { type: "integer" } },
        { t: "list", items: plainShape({ type: "string" }) }), []);
    }],
    [/^a union only some of whose alternatives are certainly wrong$/, () => {
      assert.deepEqual(check({ $ref: "input.b" }, { anyOf: [{ type: "string" }, { type: "boolean" }] }, plainShape({ type: "boolean" })), []);
      assert.deepEqual(check({ $ref: "input.b" }, { type: "boolean" }, plainShape({ anyOf: [{ type: "string" }, { type: "boolean" }] })), []);
    }],
  ];
  assert.equal(items.length, cases.length, JSON.stringify(items));
  for (const item of items) {
    const found = cases.filter(([pattern]) => pattern.test(item));
    assert.equal(found.length, 1, `one case for ${JSON.stringify(item)}`);
    (found[0] as (typeof cases)[number])[1]();
  }
  assert.doesNotMatch(flat(text), /a destination with `anyOf` or `oneOf`/, "a union destination is checked now");
});

test("the section's keyword table names every keyword of the documented subset", async () => {
  const text = await section();
  const rows = text.split("\n").filter((line) => line.startsWith("| `"));
  const named = new Set(rows.flatMap((row) => [...(row.split("|")[1] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1])));
  for (const keyword of ["type", "properties", "required", "additionalProperties", "items", "enum", "const", "minimum", "maximum", "minLength",
    "maxLength", "minItems", "maxItems", "pattern", "anyOf", "oneOf"]) {
    assert.ok(named.has(keyword), keyword);
  }
  assert.match(flat(text), /a schema reached through `\$ref` applies together with the keywords next to the `\$ref`/);
});

/** The whole of docs/workflows.md, flattened (blockquote markers removed). */
async function wholeDoc(): Promise<string> {
  return flat((await readFile(WORKFLOWS, "utf8")).replace(/^> ?/gm, ""));
}

test("the reference-root rule (C5) is stated in the words of the contract, and the bundle is one that validates the same", async () => {
  const text = await wholeDoc();
  assert.ok(text.includes("A local reference is resolved against the schema document it is written in. `#/$defs/N` and `#/definitions/N` " +
    "look first in the `$defs` / `definitions` of that document and then among the workflow's named schemas; `#/schemas/N` names a " +
    "workflow schema. Following a reference that lands on a named schema makes that named schema the document for the references inside it."));
  assert.match(text, /it is bundled into a self-contained copy that validates exactly like the named schema/);
  assert.match(text, /hoisted to unique top-level keys \(`<schema>__<definition>`\)/);
  assert.doesNotMatch(text, /every `#\/schemas\/N` rewritten to `#\/\$defs\/N`/);
});

test("savedAs is documented with its three values, and an agent hand-off's tools are enforced", async () => {
  const text = await wholeDoc();
  assert.match(text, /A document is resolved by the name it is \*\*stored\*\* under, at save time and at run time alike; its own `name` field never stands in for that\./);
  assert.match(text, /- a string: the name the document is, or is about to be, saved under\. A `call` to that name resolves to the document being validated/);
  assert.match(text, /- `null`: the document is not a saved workflow \(the workflow embedded in an agent definition\), so no `call` resolves to it by name/);
  assert.match(text, /- absent: the document's own `name` field plays that part/);
  assert.match(text, /a workflow saved as `loop` that calls `loop` is a cycle, when it is saved and when it runs/);
  assert.ok(text.includes("`tools` restricts the hand-off to a subset of the agent's tools: the model is shown only those, and a call to any " +
    "other tool made inside the hand-off — by the loop itself, by a workflow it starts with `run_workflow`, or by a nested hand-off — is " +
    "refused and returned to the model as a denied result."));
  assert.doesNotMatch(text, /narrows the tools/);
});

// ---- "Visibility" in docs/workflows.md says what the validator does, rule by rule (R14D-docs-01) ----

async function visibilitySection(): Promise<string> {
  const text = await readFile(WORKFLOWS, "utf8");
  const start = text.indexOf("\n### Visibility\n");
  assert.ok(start >= 0, "the section exists");
  return flat(text.slice(start, text.indexOf("\n## ", start + 1)));
}

const w = (id: string, question = "q"): WorkflowNode => ({ id, kind: "wait", question });
const seq = (...steps: WorkflowNode[]): WorkflowNode => ({ id: "main", kind: "sequence", steps });
const caseOf = (id: string, ...runs: WorkflowNode[]): WorkflowNode =>
  ({ id, kind: "branch", on: { $ref: "input.k" }, cases: runs.map((run, i) => ({ when: `v${i}`, run })) });

function vdoc(root: WorkflowNode, result: Json = null): WorkflowDocument {
  return {
    format: "runwright.workflow/v1", name: "visibility", schemas: { In: { type: "object", properties: { k: { type: "string" } } }, Out: {} },
    input: "In", output: "Out", root, result,
  };
}

type Verdict = "visible" | "conditional" | { hidden: string };

/** What the validator says about the one reference of the document: visible (no problem), conditional, or hidden with a reason. */
function verdictOf(document: WorkflowDocument): Verdict {
  const problems = validateWorkflow(document).problems;
  if (problems.length === 0) return "visible";
  assert.equal(problems.length, 1, JSON.stringify(problems));
  const problem = problems[0] as { code: string; message: string };
  if (problem.code === "conditional_reference") return "conditional";
  assert.equal(problem.code, "unknown_reference", JSON.stringify(problem));
  return { hidden: problem.message.replace(/^reference "[^"]+" is not visible here: /, "") };
}

/** The documented reason with its placeholders filled in. */
function reason(text: string, template: string, fill: Record<string, string>): string {
  assert.ok(text.includes(`\`${template}\``), `the section quotes ${template}`);
  return template.replace(/"([XSPB])"/g, (_m, slot: string) => JSON.stringify(fill[slot]));
}

test("the Visibility section states the validator's rules, and the self-reference sentence is gone", async () => {
  const text = await visibilitySection();
  assert.doesNotMatch(flat(await readFile(WORKFLOWS, "utf8")), /when X is the node itself/);
  for (const sentence of [
    "**Visible.** X lies in an earlier step of a `sequence` that encloses the referencing node (X is that step or is inside it), and X is " +
      "reached unconditionally from that step: every node between the step and X is a `sequence` or a `parallel`.",
    "From the document's `result`, X is visible when it is reached unconditionally from `root`.",
    "**Conditional.** X lies in such an earlier step (or, from `result`, anywhere), but on the way from it to X there is a `branch` case or " +
      "`default`, a `lowConfidence.run`, a `map` or a `loop` that the referencing node is not inside: X may not have run.",
    "**Hidden.** These are always the error `unknown_reference`, with or without a `default`, and the message gives the reason:",
    "In `loop.until`, the nodes of the loop's body are visible as this iteration's values",
    "In `lowConfidence.value`, the nodes of `lowConfidence.run` are visible by the same rule, and `fallback` is the output of " +
      "`lowConfidence.run` itself.",
  ]) assert.ok(text.includes(sentence), sentence);
});

test("visible: an earlier step of an enclosing sequence, reached through sequences and parallel groups only", () => {
  assert.equal(verdictOf(vdoc(seq(w("a"), w("b", "{{steps.a.answer}}")))), "visible");
  assert.equal(verdictOf(vdoc(seq({ id: "par", kind: "parallel", branches: [{ id: "s", kind: "sequence", steps: [w("p1")] }] },
    w("b", "{{steps.p1.answer}}")))), "visible", "inside an earlier step, through a parallel group and a sequence");
  assert.equal(verdictOf(vdoc(seq(w("a"), caseOf("br", w("b", "{{steps.a.answer}}"))))), "visible", "the referencing node may sit deeper");
  assert.equal(verdictOf(vdoc(seq(w("a")), { $ref: "steps.a.answer" })), "visible", "from result, reached unconditionally from root");
});

test("conditional: inside a branch case or default, a lowConfidence.run, a map or a loop; a default makes it valid", () => {
  const later = (ref: string): WorkflowNode => ({ id: "x", kind: "tool", tool: "t", args: { v: { $ref: ref } } });
  const withDefault = (ref: string): WorkflowNode => ({ id: "x", kind: "tool", tool: "t", args: { v: { $ref: ref, default: null } } });
  const decide: WorkflowNode = { id: "dc", kind: "decide", question: "q", decision: { type: "yes_no" }, lowConfidence: { below: 0.5, run: w("lr") } };
  const holders: [string, WorkflowNode][] = [
    ["c", caseOf("br", w("c"))],
    ["d0", { id: "br", kind: "branch", on: { $ref: "input.k" }, cases: [], default: w("d0") }],
    ["lr", decide],
    ["mb", { id: "e", kind: "map", over: [1], as: "it", concurrency: 1, maxItems: 1, run: w("mb") }],
    ["lb", { id: "l", kind: "loop", maxIterations: 1, until: { truthy: true }, run: w("lb") }],
  ];
  for (const [target, holder] of holders) {
    assert.equal(verdictOf(vdoc(seq(holder, later(`steps.${target}.answer`)))), "conditional", target);
    assert.equal(verdictOf(vdoc(seq(holder, withDefault(`steps.${target}.answer`)))), "visible", target);
    assert.equal(verdictOf(vdoc(seq(holder), { $ref: `steps.${target}.answer` })), "conditional", `${target} from result`);
  }
});

test("hidden: the node itself, an enclosing node, a node inside it, a later step, another part of a parallel group or branch", async () => {
  const text = await visibilitySection();
  const self = reason(text, "a node cannot reference its own output", {});
  assert.deepEqual(verdictOf(vdoc(seq(w("w", "{{steps.w.answer}}")))), { hidden: self }, "the reviewer's wait node w");
  for (const v of [{ $ref: "steps.t" }, { $ref: "steps.t", default: null }] as Json[]) {
    assert.deepEqual(verdictOf(vdoc(seq({ id: "t", kind: "tool", tool: "t", args: { v } }))), { hidden: self }, JSON.stringify(v));
  }
  const encloses = reason(text, 'node "X" encloses this node and has not finished yet', { X: "main" });
  assert.deepEqual(verdictOf(vdoc(seq(w("a", "{{steps.main}}")))), { hidden: encloses });
  assert.deepEqual(verdictOf(vdoc(seq({ id: "t", kind: "tool", tool: "t", args: { v: { $ref: "steps.main", default: 1 } } }))), { hidden: encloses });
  const inside = reason(text, 'node "X" runs inside this node, after this value is needed', { X: "ci" });
  assert.deepEqual(verdictOf(vdoc(seq({ id: "br", kind: "branch", on: { $ref: "steps.ci.answer" }, cases: [{ when: "x", run: w("ci") }] }))),
    { hidden: inside });
  const later = reason(text, 'node "X" runs later in the sequence "S"', { X: "y", S: "main" });
  assert.deepEqual(verdictOf(vdoc(seq(w("a", "{{steps.y.answer}}"), w("y")))), { hidden: later });
  assert.deepEqual(verdictOf(vdoc(seq(w("a", "{{steps.y.answer}}"), { id: "s2", kind: "sequence", steps: [w("y")] }))),
    { hidden: reason(text, 'node "X" runs later in the sequence "S"', { X: "y", S: "main" }) }, "inside a later step");
  const parallel = reason(text, 'node "X" runs in a different part of parallel "P"', { X: "p2", P: "par" });
  assert.deepEqual(verdictOf(vdoc({ id: "par", kind: "parallel", branches: [w("p1", "{{steps.p2.answer}}"), w("p2")] })), { hidden: parallel });
  const branch = reason(text, 'branch "B"', { B: "br" });
  assert.deepEqual(verdictOf(vdoc(caseOf("br", w("c1"), w("c2", "{{steps.c1.answer}}")))),
    { hidden: `node "c1" runs in a different part of ${branch}` });
});

test("the two fields that see inside their own node: loop.until and lowConfidence.value", () => {
  const loop = (run: WorkflowNode, ref: string): WorkflowNode =>
    ({ id: "l", kind: "loop", maxIterations: 2, until: { eq: [{ $ref: ref }, "y"] }, run });
  assert.equal(verdictOf(vdoc(seq(loop(w("lb"), "steps.lb.answer")))), "visible", "the body itself");
  assert.equal(verdictOf(vdoc(seq(loop({ id: "body", kind: "sequence", steps: [w("lb"), w("lc")] }, "steps.lb.answer")))), "visible",
    "reached unconditionally from the body");
  assert.equal(verdictOf(vdoc(seq(loop(caseOf("bb", w("lb")), "steps.lb.answer")))), "conditional", "behind a branch inside the body");
  const decide = (value: Json): WorkflowNode => ({
    id: "dc", kind: "decide", question: "q", decision: { type: "pick_one", options: ["a", "b"] },
    lowConfidence: { below: 0.5, run: { id: "lr", kind: "wait", question: "a or b?", choices: ["a", "b"] }, value },
  });
  assert.equal(verdictOf(vdoc(seq(decide({ $ref: "steps.lr.answer" })))), "visible");
  assert.equal(verdictOf(vdoc(seq(decide({ $ref: "fallback.answer" })))), "visible", "fallback is the output of lowConfidence.run");
  assert.deepEqual(verdictOf(vdoc(seq(decide({ $ref: "steps.dc.value" })))), { hidden: "a node cannot reference its own output" });
});

test("the tool node reference says args is a map, quoting the validator's message for a reference in its place", async () => {
  const text = flat(await readFile(WORKFLOWS, "utf8"));
  const message = "`args` must be an object of argument expressions, not a reference or a literal form";
  assert.ok(text.includes(`\`args\` is a map from argument name to [expression](#references-and-templates): each argument is resolved on its own`));
  assert.ok(text.includes(`A \`$ref\` or \`$literal\` form in place of the map is the validation error \`shape\` at \`args\` (\`\` ${message} \`\`)`));
  assert.match(text, /\| `shape` \| [^|]*a `tool` node's `args` given as a `\$ref` or `\$literal` form instead of a map of argument expressions \|/);
  const document: WorkflowDocument = vdoc(seq({ id: "t", kind: "tool", tool: "t", args: { $ref: "input" } } as unknown as WorkflowNode));
  assert.deepEqual(validateWorkflow(document).problems.map((p) => [p.path, p.code, p.message]), [["$.root.steps[0].args", "shape", message]]);
});
