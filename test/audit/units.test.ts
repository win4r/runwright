/**
 * Brief, section 4, "Unit tests: reference resolver", checked against wrong implementations the existing test
 * would let through (finding class R09D-tests-01): the existing prototype-safety test names `__proto__`,
 * `constructor` and `prototype` at four positions of `resolveRef` only, so a resolver that checks the second
 * segment alone, or checks `resolveRef` but not templates, `$ref` objects, conditions or the static validator,
 * passes it. Here every forbidden name is tried at every position of a path under every root, through every
 * entry point, and templates try to reach inherited and stored functions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isRunwrightError } from "../../src/core/errors.ts";
import type { Json } from "../../src/core/json.ts";
import { evalCondition, parseRefPath, renderTemplate, resolveRef, resolveValue, type RefScope } from "../../src/workflow/refs.ts";
import { validateWorkflow } from "../../src/workflow/validate.ts";
import type { WorkflowDocument } from "../../src/workflow/types.ts";

const FORBIDDEN = ["__proto__", "constructor", "prototype"] as const;

function scope(): RefScope {
  return {
    input: { ticket: "printer on fire", tags: ["a", "b"], nested: { deep: { leaf: 1 } } },
    steps: { fetch: { ok: true, content: "hi", data: { rows: [{ id: 7 }] } } },
    vars: { item: "x", item_index: 2 },
    loop: { retry: { index: 1, last: { done: false } } },
    run: { id: "run_1", agentId: "agt_1" },
    fallback: { data: { urgent: true } },
  };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert.ok(isRunwrightError(error), String(error));
    return error.code;
  }
  return "no error";
}

/** Valid paths under every root; each forbidden name is put in place of every segment and after the last one. */
const BASES: readonly string[][] = [
  ["input", "ticket"], ["input", "nested", "deep", "leaf"], ["input", "tags", "0"],
  ["steps", "fetch", "data", "rows", "0", "id"], ["vars", "item"], ["loop", "retry", "last", "done"],
  ["run", "id"], ["fallback", "data", "urgent"],
];

function hostilePaths(): string[] {
  const out = new Set<string>();
  for (const base of BASES) {
    for (const name of FORBIDDEN) {
      for (let i = 0; i <= base.length; i++) {
        out.add([...base.slice(0, i), name, ...base.slice(i)].join("."));
        if (i < base.length) out.add([...base.slice(0, i), name, ...base.slice(i + 1)].join("."));
      }
    }
  }
  return [...out];
}

test("a forbidden name at any position under any root is refused by every entry point", () => {
  const s = scope();
  const paths = hostilePaths();
  assert.ok(paths.length > 100, `${paths.length} paths`);
  for (const path of paths) {
    assert.equal(codeOf(() => parseRefPath(path)), "workflow_invalid", `parseRefPath ${path}`);
    assert.equal(codeOf(() => resolveRef(path, s)), "workflow_invalid", `resolveRef ${path}`);
    assert.equal(codeOf(() => resolveValue({ $ref: path }, s)), "workflow_invalid", `$ref ${path}`);
    assert.equal(codeOf(() => resolveValue({ $ref: path, default: "fallback" }, s)), "workflow_invalid", `$ref with default ${path}`);
    assert.equal(codeOf(() => resolveValue({ wrap: [{ $ref: path }] }, s)), "workflow_invalid", `nested $ref ${path}`);
    assert.equal(codeOf(() => renderTemplate(`before {{${path}}} after`, s)), "workflow_invalid", `template ${path}`);
    assert.equal(codeOf(() => renderTemplate(`{{ ${path} }}`, s)), "workflow_invalid", `spaced template ${path}`);
    assert.equal(codeOf(() => evalCondition({ truthy: { $ref: path } }, s)), "workflow_invalid", `truthy ${path}`);
    assert.equal(codeOf(() => evalCondition({ eq: [{ $ref: path }, 1] }, s)), "workflow_invalid", `eq ${path}`);
    assert.equal(codeOf(() => evalCondition({ exists: path }, s)), "workflow_invalid", `exists ${path}`);
  }
  assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
});

test("data that holds the forbidden names as own keys is still unreachable, and nothing is polluted", () => {
  const s = scope();
  s.input = JSON.parse('{"__proto__": {"polluted": 1}, "constructor": {"name": "x"}, "prototype": 3, "ok": {"__proto__": 2}}') as Json;
  for (const path of ["input.__proto__", "input.constructor", "input.constructor.name", "input.prototype", "input.ok.__proto__"]) {
    assert.equal(codeOf(() => resolveRef(path, s)), "workflow_invalid", path);
    assert.equal(codeOf(() => renderTemplate(`{{${path}}}`, s)), "workflow_invalid", path);
  }
  assert.equal(codeOf(() => resolveRef("input.polluted", s)), "reference_unresolved");
  const copied = resolveRef("input", s) as Record<string, unknown>;
  assert.ok(Object.hasOwn(copied, "__proto__"), "a copied __proto__ key stays an own property");
  assert.equal(Object.getPrototypeOf(copied), Object.prototype);
  assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
});

test("a template that tries to reach a function gets an error, never function text or a call", () => {
  const s = scope();
  let called = 0;
  const fn = (): string => {
    called++;
    return "called";
  };
  (s.vars as Record<string, unknown>)["fn"] = fn;
  (s.steps as Record<string, unknown>)["withFn"] = { run: fn };
  const reaching = [
    "input.ticket.toString", "input.ticket.length", "input.tags.map", "input.tags.length", "input.hasOwnProperty",
    "input.nested.valueOf", "run.id.charAt", "loop.retry.index.toFixed", "steps.fetch.data.rows.0.toString",
    "vars.fn", "steps.withFn.run", "vars.fn.call",
  ];
  for (const path of reaching) {
    const viaTemplate = codeOf(() => renderTemplate(`{{${path}}}`, s));
    assert.equal(viaTemplate, "reference_unresolved", `template ${path}`);
    assert.equal(codeOf(() => resolveRef(path, s)), "reference_unresolved", `resolveRef ${path}`);
    assert.equal(resolveValue({ $ref: path, default: "none" }, s), "none", `default for ${path}`);
  }
  for (const expression of ["{{vars.fn()}}", "{{input.ticket.toUpperCase()}}", "{{constructor.constructor('return 1')()}}",
    "{{input['ticket']}}", "{{this}}", "{{globalThis.process}}", "{{process.env}}", "{{`x`}}"]) {
    const code = codeOf(() => renderTemplate(expression, s));
    assert.ok(code === "workflow_invalid" || code === "reference_unresolved", `${expression}: ${code}`);
  }
  assert.equal(called, 0, "no function was called");
});

test("the static validator reports a forbidden name in a $ref, a template and a condition with its JSON path", () => {
  const document = (root: WorkflowDocument["root"], result: WorkflowDocument["result"] = null): WorkflowDocument => ({
    format: "runwright.workflow/v1", name: "hostile", schemas: { Input: { type: "object" }, Output: {} },
    input: "Input", output: "Output", root, result,
  });
  const cases: { name: string; doc: WorkflowDocument; path: string }[] = [];
  for (const name of FORBIDDEN) {
    cases.push(
      { name: `${name} in a $ref in the result`, path: "$.result", doc: document({ id: "w", kind: "wait", question: "q" }, { $ref: `input.${name}` }) },
      { name: `${name} in a template`, path: "$.root.question", doc: document({ id: "w", kind: "wait", question: `see {{input.a.${name}}}` }) },
      { name: `${name} at the root of a template path`, path: "$.root.question", doc: document({ id: "w", kind: "wait", question: `{{${name}.x}}` }) },
      { name: `${name} in a loop condition`, path: "$.root.until",
        doc: document({ id: "l", kind: "loop", maxIterations: 2, until: { truthy: { $ref: `steps.w.${name}` } }, run: { id: "w", kind: "wait", question: "q" } }) },
    );
  }
  for (const c of cases) {
    const problems = validateWorkflow(c.doc, { tools: [] }).problems.filter((p) => p.severity === "error");
    assert.ok(problems.length > 0, `${c.name}: no problem reported`);
    assert.ok(problems.some((p) => p.path.startsWith(c.path)), `${c.name}: ${JSON.stringify(problems)}`);
  }
});
