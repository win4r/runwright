import { test } from "node:test";
import assert from "node:assert/strict";
import type { Json } from "../../src/core/json.ts";
import { isRunwrightError } from "../../src/core/errors.ts";
import {
  ARGS_MAP_MESSAGE, evalCondition, listRefs, parseRefPath, renderTemplate, resolveArgs, resolveRef, resolveValue, templateParts, type RefScope,
} from "../../src/workflow/refs.ts";

function scope(): RefScope {
  return {
    input: { ticket: "printer on fire", tags: ["a", "b"], n: 3 },
    steps: { fetch: { ok: true, content: "hi", data: { rows: [{ id: 7 }] } } },
    vars: { item: "x", item_index: 2 },
    loop: { retry: { index: 1, last: { done: false } } },
    run: { id: "run_1", agentId: "agt_1" },
  };
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert.ok(isRunwrightError(error), String(error));
    return error.code;
  }
  assert.fail("expected an error");
}

test("parseRefPath splits identifiers and indexes and checks the root", () => {
  assert.deepEqual(parseRefPath("steps.fetch.data.rows.0.id"), ["steps", "fetch", "data", "rows", 0, "id"]);
  for (const bad of ["", "input..x", "input.a b", "nope.x", "input.-1", "input.01x"]) assert.equal(code(() => parseRefPath(bad)), "workflow_invalid", bad);
});

test("resolveRef reaches every root", () => {
  const s = scope();
  assert.equal(resolveRef("input.ticket", s), "printer on fire");
  assert.equal(resolveRef("steps.fetch.data.rows.0.id", s), 7);
  assert.equal(resolveRef("vars.item_index", s), 2);
  assert.equal(resolveRef("loop.retry.index", s), 1);
  assert.equal(resolveRef("run.agentId", s), "agt_1");
  assert.equal(resolveRef("fallback.x", { ...s, fallback: { x: true } }), true);
  assert.equal(code(() => resolveRef("fallback", s)), "reference_unresolved");
});

test("arrays: bounds-checked integer indexes only", () => {
  const s = scope();
  assert.equal(resolveRef("input.tags.1", s), "b");
  assert.equal(code(() => resolveRef("input.tags.2", s)), "reference_unresolved");
  assert.equal(code(() => resolveRef("input.tags.length", s)), "reference_unresolved");
});

test("unresolved errors name the path and the missing segment", () => {
  try {
    resolveRef("steps.fetch.data.missing.x", scope());
    assert.fail("expected an error");
  } catch (error) {
    assert.ok(isRunwrightError(error));
    assert.equal(error.code, "reference_unresolved");
    assert.match(error.message, /steps\.fetch\.data\.missing\.x/);
    assert.equal(error.details?.["missing"], "missing");
  }
});

test("resolveValue: $ref with default, $literal, templates, nesting", () => {
  const s = scope();
  assert.deepEqual(resolveValue({ a: { $ref: "input.n" }, b: [{ $ref: "steps.nope", default: 0 }] }, s), { a: 3, b: [0] });
  assert.deepEqual(resolveValue({ $literal: { $ref: "input.n", t: "{{input.n}}" } }, s), { $ref: "input.n", t: "{{input.n}}" });
  assert.equal(resolveValue("n={{ input.n }} t={{input.ticket}}", s), "n=3 t=printer on fire");
  assert.equal(renderTemplate("rows: {{steps.fetch.data.rows}}", s), 'rows: [{"id":7}]');
  assert.equal(renderTemplate("open {{ never closed", s), "open {{ never closed");
  assert.equal(code(() => renderTemplate("{{input.nope}}", s)), "reference_unresolved");
  assert.equal(code(() => resolveValue({ $ref: "input.n", extra: 1 }, s)), "workflow_invalid");
});

test("prototype safety", () => {
  const s = scope();
  for (const bad of ["input.__proto__", "input.constructor", "steps.prototype", "input.ticket.constructor"]) {
    assert.equal(code(() => resolveRef(bad, s)), "workflow_invalid", bad);
  }
  const hostile = scope();
  hostile.input = JSON.parse('{"__proto__": {"polluted": 1}}');
  assert.equal(code(() => resolveRef("input.polluted", hostile)), "reference_unresolved");
  assert.equal(code(() => resolveRef("input.toString", s)), "reference_unresolved");
  assert.equal(code(() => resolveRef("input.ticket.length", s)), "reference_unresolved");
  assert.equal(code(() => resolveRef("input.tags.length", s)), "reference_unresolved");
  assert.equal(code(() => renderTemplate("{{constructor.constructor('return 1')()}}", s)), "workflow_invalid");
  const resolved = resolveValue({ $ref: "steps.fetch" }, s) as { data: { rows: unknown[] } };
  resolved.data.rows.push(1);
  assert.equal((s.steps["fetch"] as { data: { rows: unknown[] } }).data.rows.length, 1);
  assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
});

test("evalCondition", () => {
  const s = scope();
  assert.equal(evalCondition({ eq: [{ $ref: "input.tags" }, { $literal: ["a", "b"] }] }, s), true);
  assert.equal(evalCondition({ ne: [{ $ref: "input.n" }, 3] }, s), false);
  assert.equal(evalCondition({ gt: [{ $ref: "input.n" }, 2] }, s), true);
  assert.equal(evalCondition({ lt: ["a", "b"] }, s), true);
  assert.equal(evalCondition({ gte: [{ $ref: "input.n" }, "3"] }, s), false);
  assert.equal(evalCondition({ and: [{ exists: "input.n" }, { not: { exists: "input.zzz" } }] }, s), true);
  assert.equal(evalCondition({ or: [{ truthy: "" }, { truthy: { $ref: "loop.retry.last.done" } }] }, s), false);
  assert.equal(evalCondition({ truthy: { $ref: "input.tags" } }, s), true);
});

test("listRefs reports refs and template paths with positions", () => {
  assert.deepEqual(listRefs({ a: [{ $ref: "input.x", default: 1 }], b: "hi {{ steps.y }}", c: { $literal: { $ref: "input.z" } } }), [
    { path: "input.x", hasDefault: true, at: "$.a[0]" },
    { path: "steps.y", hasDefault: false, at: "$.b" },
  ]);
});

test("onUnresolved: called for a $ref without default, a template part and a condition operand; its value is used", () => {
  const s = scope();
  const seen: [string, string, unknown][] = [];
  const options = {
    onUnresolved: (path: string, error: { code: string; details: Record<string, unknown> | undefined }): Json | undefined => {
      seen.push([path, error.code, error.details?.["at"]]);
      return "X";
    },
  };
  assert.deepEqual(resolveValue({ a: { $ref: "steps.fetch.data.nope" }, b: [{ $ref: "input.n" }] }, s, options), { a: "X", b: [3] });
  assert.equal(renderTemplate("v={{input.zzz}}!", s, options), "v=X!");
  assert.equal(evalCondition({ eq: [{ $ref: "vars.nope" }, "X"] }, s, options), true);
  assert.equal(evalCondition({ truthy: "{{loop.retry.last.missing}}" }, s, options), true);
  assert.deepEqual(seen, [
    ["steps.fetch.data.nope", "reference_unresolved", 3],
    ["input.zzz", "reference_unresolved", 1],
    ["vars.nope", "reference_unresolved", 1],
    ["loop.retry.last.missing", "reference_unresolved", 3],
  ]);
});

test("onUnresolved: undefined rethrows; defaults and exists never call it; without options nothing changes", () => {
  const s = scope();
  let calls = 0;
  const rethrow = { onUnresolved: (): Json | undefined => { calls++; return undefined; } };
  assert.equal(code(() => resolveValue({ $ref: "input.nope" }, s, rethrow)), "reference_unresolved");
  assert.equal(code(() => renderTemplate("{{input.nope}}", s, rethrow)), "reference_unresolved");
  assert.equal(code(() => evalCondition({ truthy: { $ref: "input.nope" } }, s, rethrow)), "reference_unresolved");
  assert.equal(calls, 3);
  const never = { onUnresolved: (): Json | undefined => assert.fail("must not be called") };
  assert.deepEqual(resolveValue({ $ref: "input.nope", default: 0 }, s, never), 0);
  assert.equal(evalCondition({ exists: "input.nope" }, s, never), false);
  assert.equal(code(() => resolveValue({ $ref: "input.n", extra: 1 }, s, never)), "workflow_invalid");
  assert.equal(code(() => renderTemplate("{{nope.x}}", s, never)), "workflow_invalid");
  const expr = { a: { $ref: "input.tags" }, t: "{{input.ticket}}", d: { $ref: "steps.nope", default: [1] } };
  assert.deepEqual(resolveValue(expr, s, {}), resolveValue(expr, s));
  assert.equal(code(() => resolveValue({ $ref: "input.nope" }, s, {})), "reference_unresolved");
});

test("templateParts: text and reference parts in order, with their offsets; an unclosed {{ is text", () => {
  assert.deepEqual(templateParts("order-{{ input.id }}/{{run.id}}{{vars.x}}!"), [
    { kind: "text", text: "order-", offset: 0 },
    { kind: "ref", text: "input.id", offset: 6 },
    { kind: "text", text: "/", offset: 20 },
    { kind: "ref", text: "run.id", offset: 21 },
    { kind: "ref", text: "vars.x", offset: 31 },
    { kind: "text", text: "!", offset: 41 },
  ]);
  assert.deepEqual(templateParts("{{input.a}}"), [{ kind: "ref", text: "input.a", offset: 0 }]);
  assert.deepEqual(templateParts("a {{input.a}} b {{ open"), [
    { kind: "text", text: "a ", offset: 0 },
    { kind: "ref", text: "input.a", offset: 2 },
    { kind: "text", text: " b {{ open", offset: 13 },
  ]);
  assert.deepEqual(templateParts("plain {{ text"), [{ kind: "text", text: "plain {{ text", offset: 0 }]);
  assert.deepEqual(templateParts(""), []);
});

test("resolveArgs resolves each argument of the map on its own and refuses anything that is not a map", () => {
  const args = JSON.parse('{"__proto__": {"$ref": "input.n"}, "constructor": "{{input.ticket}}", "plain": {"$literal": {"$ref": "kept"}}}') as Json;
  const out = resolveArgs(args, scope());
  assert.deepEqual(Object.keys(out), ["__proto__", "constructor", "plain"]);
  assert.equal(Object.getOwnPropertyDescriptor(out, "__proto__")?.value, 3);
  assert.equal(Object.getPrototypeOf(out), Object.prototype, "no prototype was written");
  assert.equal(out["constructor"], "printer on fire");
  assert.deepEqual(out["plain"], { $ref: "kept" });
  assert.deepEqual(resolveArgs({}, scope()), {});
  for (const bad of [{ $ref: "input" }, { $literal: { a: 1 } }, { $ref: "input", a: 1 }, [1], "x", null, 3] as unknown[]) {
    assert.throws(() => resolveArgs(bad, scope()), (error: unknown) => isRunwrightError(error) && error.code === "workflow_invalid" &&
      error.message === ARGS_MAP_MESSAGE, JSON.stringify(bad));
  }
});
