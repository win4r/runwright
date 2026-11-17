/**
 * Rule P as a table (R11-03): every cell of "destination keyword x expression form" that the validator decides,
 * one certain mismatch and one may-fit neighbour each, through checkAssignable. Every case also carries the
 * inputs of runs it speaks about, and those are resolved and validated as a run would:
 * - a case that reports a problem lists runs that read the reported part, and every one of them is refused by
 *   the schema validator (the report is certain for them);
 * - a case that reports nothing lists at least one run whose value the schema validator accepts (the expression
 *   really may fit), and with `everyFits` every listed run fits.
 * Each run's input is checked against the shapes the case claims, so a sample can never be one the shapes rule out.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isJsonObject, type Json, type JsonObject } from "../../src/core/json.ts";
import { validateSchema, type JsonSchema } from "../../src/schema/validate.ts";
import { MAX_ALTERNATIVES, MAX_COMPARISON_EVALUATIONS, checkAssignable, type AssignProblem } from "../../src/workflow/assign.ts";
import { renderTemplate, resolveValue, type RefScope } from "../../src/workflow/refs.ts";
import { UNKNOWN_SHAPE, plainShape, type Shape } from "../../src/workflow/walk.ts";

type Form = "template" | "array" | "object" | "ref";
type Presence = "always" | "maybe";

interface Case {
  name: string;
  /** The rows of the table this case exercises. */
  keywords: string[];
  expr: Json;
  schema: JsonSchema;
  /** Shapes of `input.<name>`: a schema, or a Shape for records, lists and unknown values. */
  shapes?: { [name: string]: JsonSchema | Shape };
  /** Presence of `input.<name>` (default "always"). */
  presence?: { [name: string]: Presence };
  problems: AssignProblem[];
  /** Inputs of runs the case speaks about (see the header). */
  runs: JsonObject[];
  /** For a case without problems: every run fits, not only one. */
  everyFits?: boolean;
  /** Shapes whose consistency with a run cannot be checked by validation (a source with a `$ref` that does not resolve). */
  unchecked?: string[];
}

const r = (name: string, fallback?: Json): Json => (fallback === undefined ? { $ref: `input.${name}` } : { $ref: `input.${name}`, default: fallback });
const record = (fields: { [name: string]: Shape }): Shape => ({ t: "record", fields });
const STRING = plainShape({ type: "string" });

function isShape(value: JsonSchema | Shape): value is Shape {
  const t = (value as { t?: unknown }).t;
  return t === "schema" || t === "record" || t === "list" || t === "unknown";
}

function shapeOf(c: Case, name: string): Shape {
  const given = c.shapes?.[name];
  if (given === undefined) return UNKNOWN_SHAPE;
  return isShape(given) ? given : plainShape(given);
}

function formOf(expr: Json): Form {
  if (typeof expr === "string") return "template";
  if (Array.isArray(expr)) return "array";
  return isJsonObject(expr) && Object.hasOwn(expr, "$ref") ? "ref" : "object";
}

function run(c: Case): AssignProblem[] {
  return checkAssignable({
    expr: c.expr, path: "$.x", schema: c.schema, root: c.schema,
    refOf: (path) => {
      const name = path.slice("input.".length);
      return { shape: shapeOf(c, name), presence: c.presence?.[name] ?? "always" };
    },
  });
}

/** True when `value` is a value of `shape` (a schema shape by validation). */
function fits(value: Json, shape: Shape): boolean {
  switch (shape.t) {
    case "unknown": return true;
    case "schema": return validateSchema(shape.root, value, { ...(shape.defs === undefined ? {} : { definitions: shape.defs }) }).length === 0;
    case "record":
      return isJsonObject(value) && Object.keys(value).length === Object.keys(shape.fields).length
        && Object.keys(shape.fields).every((key) => Object.hasOwn(value, key) && fits(value[key] ?? null, shape.fields[key] as Shape));
    case "list": return Array.isArray(value) && value.every((item) => fits(item, shape.items));
  }
}

function scope(input: JsonObject): RefScope {
  return { input, steps: {}, vars: {}, loop: {}, run: { id: "run_1", agentId: "agt_1" } };
}

/** The run-time agreement of a case: the problems it reports are certain for its runs, or one of its runs fits. */
function agree(c: Case, problems: AssignProblem[]): void {
  assert.ok(c.runs.length > 0, `${c.name}: at least one run`);
  const verdicts = c.runs.map((input) => {
    for (const name of Object.keys(c.shapes ?? {})) {
      if (!Object.hasOwn(input, name)) {
        assert.equal(c.presence?.[name] ?? "always", "maybe", `${c.name}: input.${name} is missing in a run, so it must be "maybe"`);
      } else if (!(c.unchecked ?? []).includes(name)) {
        assert.ok(fits(input[name] ?? null, shapeOf(c, name)), `${c.name}: ${JSON.stringify(input[name])} is a value of input.${name}'s shape`);
      }
    }
    const value = resolveValue(c.expr, scope(input));
    return { value, problems: validateSchema(c.schema, value) };
  });
  if (problems.length > 0) {
    for (const verdict of verdicts) assert.ok(verdict.problems.length > 0, `${c.name}: the run value ${JSON.stringify(verdict.value)} is refused at run time`);
  } else if (c.everyFits === true) {
    for (const verdict of verdicts) assert.deepEqual(verdict.problems, [], `${c.name}: the run value ${JSON.stringify(verdict.value)} fits`);
  } else {
    assert.ok(verdicts.some((verdict) => verdict.problems.length === 0), `${c.name}: some run value fits: ${JSON.stringify(verdicts)}`);
  }
}

const OBJECT_UNION: JsonSchema = { anyOf: [
  { type: "object", properties: { a: { type: "string" } } },
  { type: "object", properties: { a: { type: "number" } } },
] };
const ARRAY_UNION: JsonSchema = { anyOf: [{ type: "array", items: { type: "string" } }, { type: "array", items: { type: "number" } }] };
const SCALAR_UNION: JsonSchema = { anyOf: [{ type: "string" }, { type: "number" }] };
const NEVER_ALTERNATIVE = "never matches any of the 2 schemas (anyOf)";

const CASES: Case[] = [
  // 1. Written arrays: the written length is the length.
  { name: "the finding: one written element into minItems 2", keywords: ["minItems", "items", "type"], expr: [r("n")],
    schema: { type: "array", items: { type: "number" }, minItems: 2 }, shapes: { n: { type: "number" } },
    problems: [{ path: "$.x", message: "must have at least 2 items, got 1" }], runs: [{ n: 1 }, { n: 2.5 }] },
  { name: "two written elements into minItems 2", keywords: ["minItems", "items", "type"], expr: [r("n"), r("n")],
    schema: { type: "array", items: { type: "number" }, minItems: 2 }, shapes: { n: { type: "number" } }, problems: [], runs: [{ n: 1 }] },
  { name: "three written elements into maxItems 2", keywords: ["maxItems"], expr: [r("n"), r("n"), 3], schema: { maxItems: 2 },
    shapes: { n: { type: "number" } }, problems: [{ path: "$.x", message: "must have at most 2 items, got 3" }], runs: [{ n: 1 }] },
  { name: "two written elements into maxItems 2", keywords: ["maxItems"], expr: [r("n"), 3], schema: { maxItems: 2 },
    shapes: { n: { type: "number" } }, problems: [], runs: [{ n: 1 }] },
  { name: "a written array into minItems behind a $ref chain", keywords: ["$ref", "minItems"], expr: [r("n")],
    schema: { $ref: "#/$defs/L", $defs: { L: { $ref: "#/$defs/M" }, M: { type: "array", minItems: 3 } } }, shapes: { n: { type: "number" } },
    problems: [{ path: "$.x", message: "must have at least 3 items, got 1" }], runs: [{ n: 1 }] },
  { name: "a written array long enough behind a $ref chain", keywords: ["$ref", "minItems"], expr: [r("n"), r("n"), r("n")],
    schema: { $ref: "#/$defs/L", $defs: { L: { $ref: "#/$defs/M" }, M: { type: "array", minItems: 3 } } }, shapes: { n: { type: "number" } },
    problems: [], runs: [{ n: 1 }] },
  { name: "a written array into maxItems behind a $ref chain", keywords: ["$ref", "maxItems"], expr: [r("n"), r("n")],
    schema: { $ref: "#/$defs/L", $defs: { L: { $ref: "#/$defs/M" }, M: { maxItems: 1 } } }, shapes: { n: { type: "number" } },
    problems: [{ path: "$.x", message: "must have at most 1 items, got 2" }], runs: [{ n: 1 }] },
  { name: "a written array within maxItems behind a $ref chain", keywords: ["$ref", "maxItems"], expr: [r("n")],
    schema: { $ref: "#/$defs/L", $defs: { L: { $ref: "#/$defs/M" }, M: { maxItems: 1 } } }, shapes: { n: { type: "number" } },
    problems: [], runs: [{ n: 1 }] },
  { name: "a written array inside a written object, too long", keywords: ["maxItems", "properties"], expr: { list: [r("n")] },
    schema: { type: "object", properties: { list: { maxItems: 0 } } }, shapes: { n: { type: "number" } },
    problems: [{ path: "$.x.list", message: "must have at most 0 items, got 1" }], runs: [{ n: 1 }] },
  { name: "an empty written array inside a written object", keywords: ["maxItems", "properties"], expr: { list: [], k: r("n") },
    schema: { type: "object", properties: { list: { maxItems: 0 } } }, shapes: { n: { type: "number" } }, problems: [], runs: [{ n: 1 }] },
  { name: "a written array inside a written array, too short", keywords: ["minItems", "items"], expr: [[r("n")]],
    schema: { items: { minItems: 2 } }, shapes: { n: { type: "number" } },
    problems: [{ path: "$.x[0]", message: "must have at least 2 items, got 1" }], runs: [{ n: 1 }] },
  { name: "a written array inside a written array, long enough", keywords: ["minItems", "items"], expr: [[r("n"), 1]],
    schema: { items: { minItems: 2 } }, shapes: { n: { type: "number" } }, problems: [], runs: [{ n: 1 }] },
  { name: "a written array's element of the wrong type", keywords: ["items"], expr: [r("s")], schema: { items: { type: "integer" } },
    shapes: { s: { type: "string" } }, problems: [{ path: "$.x[0]", message: "is string, but expected integer" }], runs: [{ s: "a" }] },
  { name: "a written array into an object type", keywords: ["type"], expr: [r("s")], schema: { type: "object" },
    shapes: { s: { type: "string" } }, problems: [{ path: "$.x", message: "is an array, but expected object" }], runs: [{ s: "a" }] },
  { name: "a written array into an array or object type", keywords: ["type"], expr: [r("s")], schema: { type: ["object", "array"] },
    shapes: { s: { type: "string" } }, problems: [], runs: [{ s: "a" }] },

  // 2. Written arrays and objects against const and enum (Q).
  { name: "a written array of the wrong length into const", keywords: ["const"], expr: [r("a")], schema: { const: [1, 2] },
    shapes: { a: { type: "integer" } }, problems: [{ path: "$.x", message: "can never equal [1,2]" }], runs: [{ a: 1 }] },
  { name: "a written array that can equal const", keywords: ["const"], expr: [r("a"), 2], schema: { const: [1, 2] },
    shapes: { a: { type: "integer" } }, problems: [], runs: [{ a: 1 }] },
  { name: "a written array with an element that can never equal", keywords: ["const"], expr: [r("s"), 2], schema: { const: [1, 2] },
    shapes: { s: { type: "string" } }, problems: [{ path: "$.x", message: "can never equal [1,2]" }], runs: [{ s: "1" }] },
  { name: "a written array of the wrong length for every enum value", keywords: ["enum"], expr: [r("a")], schema: { enum: [[1, 2], [3, 4]] },
    shapes: { a: { type: "integer" } }, problems: [{ path: "$.x", message: "can never be one of [1,2], [3,4]" }], runs: [{ a: 3 }] },
  { name: "a written array that can equal one enum value", keywords: ["enum"], expr: [r("a")], schema: { enum: [[1, 2], [3]] },
    shapes: { a: { type: "integer" } }, problems: [], runs: [{ a: 3 }] },
  { name: "a written object with the wrong keys into const", keywords: ["const"], expr: { a: r("a") }, schema: { const: { a: 1, b: 2 } },
    shapes: { a: { type: "integer" } }, problems: [{ path: "$.x", message: `can never equal {"a":1,"b":2}` }], runs: [{ a: 1 }] },
  { name: "a written object that can equal const", keywords: ["const"], expr: { a: r("a"), b: 2 }, schema: { const: { a: 1, b: 2 } },
    shapes: { a: { type: "integer" } }, problems: [], runs: [{ a: 1 }] },
  { name: "a written object whose value can never equal any enum value", keywords: ["enum"], expr: { a: r("s") }, schema: { enum: [{ a: 1 }, { a: 2 }] },
    shapes: { s: { type: "string" } }, problems: [{ path: "$.x", message: `can never be one of {"a":1}, {"a":2}` }], runs: [{ s: "1" }] },
  { name: "a written object that can equal an enum value", keywords: ["enum"], expr: { a: r("a") }, schema: { enum: [{ a: 1 }, { a: 2 }] },
    shapes: { a: { type: "integer" } }, problems: [], runs: [{ a: 2 }] },
  { name: "a reference element whose default may be read and equals const", keywords: ["const"], expr: [r("s", 1)], schema: { const: [1] },
    shapes: { s: { type: "string" } }, presence: { s: "maybe" }, problems: [], runs: [{}] },
  { name: "a reference element that always resolves never reads its default", keywords: ["const"], expr: [r("s", 1)], schema: { const: [1] },
    shapes: { s: { type: "string" } }, presence: { s: "always" }, problems: [{ path: "$.x", message: "can never equal [1]" }], runs: [{ s: "1" }] },
  { name: "a template element that can render the constant", keywords: ["const"], expr: ["id-{{input.s}}"], schema: { const: ["id-7"] },
    shapes: { s: { type: "string" } }, problems: [], runs: [{ s: "7" }] },
  { name: "a template element that can never render the constant", keywords: ["const"], expr: ["id-{{input.s}}"], schema: { const: ["7"] },
    shapes: { s: { type: "string" } }, problems: [{ path: "$.x", message: `can never equal ["7"]` }], runs: [{ s: "7" }] },

  // 3. Templates.
  { name: "a template longer than maxLength", keywords: ["maxLength", "type"], expr: "order-{{input.id}}", schema: { type: "string", maxLength: 3 },
    shapes: { id: { type: "string" } }, problems: [{ path: "$.x", message: "always has at least 6 characters, but must be at most 3" }], runs: [{ id: "" }, { id: "7" }] },
  { name: "a template exactly at maxLength", keywords: ["maxLength"], expr: "order-{{input.id}}", schema: { maxLength: 6 },
    shapes: { id: { type: "string" } }, problems: [], runs: [{ id: "" }] },
  { name: "a template whose prefix rules out const", keywords: ["const"], expr: "order-{{input.id}}", schema: { const: "ord" },
    shapes: { id: { type: "string" } }, problems: [{ path: "$.x", message: `can never equal "ord"` }], runs: [{ id: "" }, { id: "x" }] },
  { name: "a template that can render const", keywords: ["const"], expr: "order-{{input.id}}", schema: { const: "order-7" },
    shapes: { id: { type: "string" } }, problems: [], runs: [{ id: "7" }] },
  { name: "a template that renders no enum value", keywords: ["enum"], expr: "order-{{input.id}}", schema: { enum: ["a", "b"] },
    shapes: { id: { type: "string" } }, problems: [{ path: "$.x", message: `can never be one of "a", "b"` }], runs: [{ id: "a" }] },
  { name: "a template whose suffix fits one enum value", keywords: ["enum"], expr: "{{input.id}}.txt", schema: { enum: ["a.md", "b.txt"] },
    shapes: { id: { type: "string" } }, problems: [], runs: [{ id: "b" }] },
  { name: "a template whose suffix rules out const", keywords: ["const"], expr: "{{input.id}}.txt", schema: { const: "a.md" },
    shapes: { id: { type: "string" } }, problems: [{ path: "$.x", message: `can never equal "a.md"` }], runs: [{ id: "a" }] },
  { name: "a template's middle parts out of order", keywords: ["const"], expr: "{{input.a}}-{{input.b}}+{{input.c}}", schema: { const: "x+y-z" },
    shapes: { a: { type: "string" }, b: { type: "string" }, c: { type: "string" } },
    problems: [{ path: "$.x", message: `can never equal "x+y-z"` }], runs: [{ a: "x+y", b: "", c: "z" }, { a: "x", b: "y", c: "-z" }] },
  { name: "a template's middle parts in order", keywords: ["const"], expr: "{{input.a}}-{{input.b}}+{{input.c}}", schema: { const: "x-y+z" },
    shapes: { a: { type: "string" }, b: { type: "string" }, c: { type: "string" } }, problems: [], runs: [{ a: "x", b: "y", c: "z" }] },
  { name: "adjacent references can render the empty string", keywords: ["const"], expr: "{{input.a}}{{input.b}}", schema: { const: "" },
    shapes: { a: { type: "string" }, b: { type: "string" } }, problems: [], runs: [{ a: "", b: "" }] },
  { name: "a template never renders a non-string constant", keywords: ["const"], expr: "{{input.a}}{{input.b}}", schema: { type: ["string", "integer"], const: 5 },
    shapes: { a: { type: "string" }, b: { type: "string" } }, problems: [{ path: "$.x", message: "can never equal 5" }], runs: [{ a: "5", b: "" }] },
  { name: "a non-string constant pins the type a template does not have", keywords: ["type"], expr: "{{input.a}}{{input.b}}", schema: { const: 5 },
    shapes: { a: { type: "string" }, b: { type: "string" } }, problems: [{ path: "$.x", message: "is string, but expected integer" }], runs: [{ a: "5", b: "" }] },
  { name: "a template never renders a non-string enum value", keywords: ["enum"], expr: "{{input.a}}", schema: { enum: [5, null] },
    shapes: { a: { type: "integer" } }, problems: [{ path: "$.x", message: "is string, but expected integer or null" }], runs: [{ a: 5 }] },
  { name: "a template that renders a string enum value among others", keywords: ["enum"], expr: "{{input.a}}", schema: { enum: [5, "5"] },
    shapes: { a: { type: "integer" } }, problems: [], runs: [{ a: 5 }] },
  { name: "overlapping prefix and suffix", keywords: ["const"], expr: "ab{{input.x}}ba", schema: { const: "aba" },
    shapes: { x: { type: "string" } }, problems: [{ path: "$.x", message: `can never equal "aba"` }], runs: [{ x: "" }] },
  { name: "prefix and suffix side by side", keywords: ["const"], expr: "ab{{input.x}}ba", schema: { const: "abba" },
    shapes: { x: { type: "string" } }, problems: [], runs: [{ x: "" }] },
  { name: "a template's minLength is left to run time", keywords: ["minLength"], expr: "{{input.s}}", schema: { minLength: 5 },
    shapes: { s: { type: "string" } }, problems: [], runs: [{ s: "hello" }] },
  { name: "a template's pattern is left to run time", keywords: ["pattern"], expr: "id-{{input.s}}", schema: { pattern: "^id-[0-9]+$" },
    shapes: { s: { type: "string" } }, problems: [], runs: [{ s: "12" }] },
  { name: "a template into an integer type", keywords: ["type"], expr: "{{input.s}}", schema: { type: "integer" },
    shapes: { s: { type: "string" } }, problems: [{ path: "$.x", message: "is string, but expected integer" }], runs: [{ s: "1" }] },
  { name: "a template into a string or null type", keywords: ["type"], expr: "{{input.s}}", schema: { type: ["string", "null"] },
    shapes: { s: { type: "string" } }, problems: [], runs: [{ s: "1" }] },
  { name: "a template into maxLength behind a $ref", keywords: ["$ref", "maxLength"], expr: "{{input.s}}!",
    schema: { $ref: "#/$defs/Short", $defs: { Short: { maxLength: 0 } } }, shapes: { s: { type: "string" } },
    problems: [{ path: "$.x", message: "always has at least 1 characters, but must be at most 0" }], runs: [{ s: "" }] },
  { name: "a template into maxLength 1 behind a $ref", keywords: ["$ref", "maxLength"], expr: "{{input.s}}!",
    schema: { $ref: "#/$defs/Short", $defs: { Short: { maxLength: 1 } } }, shapes: { s: { type: "string" } }, problems: [], runs: [{ s: "" }] },
  { name: "a surrogate pair split by a reference counts once", keywords: ["maxLength"], expr: "\ud83d{{input.s}}\ude00", schema: { maxLength: 1 },
    shapes: { s: { type: "string" } }, problems: [], runs: [{ s: "" }] },

  // 4. Reference ranges.
  { name: "a number that is always above maximum", keywords: ["maximum"], expr: r("n"), schema: { maximum: 5 },
    shapes: { n: { type: "number", minimum: 10 } }, problems: [{ path: "$.x", message: "is at least 10, but must be <= 5" }], runs: [{ n: 10 }, { n: 99.5 }] },
  { name: "a number whose minimum touches maximum", keywords: ["maximum"], expr: r("n"), schema: { maximum: 5 },
    shapes: { n: { type: "number", minimum: 5 } }, problems: [], runs: [{ n: 5 }] },
  { name: "a number that is always below minimum", keywords: ["minimum"], expr: r("n"), schema: { type: "number", minimum: 2 },
    shapes: { n: { type: "number", maximum: 1 } }, problems: [{ path: "$.x", message: "is at most 1, but must be >= 2" }], runs: [{ n: 1 }] },
  { name: "a number whose maximum touches minimum", keywords: ["minimum"], expr: r("n"), schema: { minimum: 2 },
    shapes: { n: { type: "number", maximum: 2 } }, problems: [], runs: [{ n: 2 }] },
  { name: "an integer source into a number range", keywords: ["maximum"], expr: r("i"), schema: { type: "number", maximum: 9.5 },
    shapes: { i: { type: "integer", minimum: 10 } }, problems: [{ path: "$.x", message: "is at least 10, but must be <= 9.5" }], runs: [{ i: 10 }] },
  { name: "a source with two types is not compared by range", keywords: ["maximum"], expr: r("v"), schema: { maximum: 5 },
    shapes: { v: { type: ["number", "string"], minimum: 10 } }, problems: [], runs: [{ v: "x" }] },
  { name: "a string that is always longer than maxLength", keywords: ["maxLength"], expr: r("s"), schema: { maxLength: 3 },
    shapes: { s: { type: "string", minLength: 4 } }, problems: [{ path: "$.x", message: "has at least 4 characters, but must be at most 3" }], runs: [{ s: "abcd" }] },
  { name: "a string whose minLength touches maxLength", keywords: ["maxLength"], expr: r("s"), schema: { maxLength: 3 },
    shapes: { s: { type: "string", minLength: 3 } }, problems: [], runs: [{ s: "abc" }] },
  { name: "a string that is always shorter than minLength", keywords: ["minLength"], expr: r("s"), schema: { minLength: 3 },
    shapes: { s: { type: "string", maxLength: 2 } }, problems: [{ path: "$.x", message: "has at most 2 characters, but must be at least 3" }], runs: [{ s: "ab" }] },
  { name: "a string whose maxLength touches minLength", keywords: ["minLength"], expr: r("s"), schema: { minLength: 2 },
    shapes: { s: { type: "string", maxLength: 2 } }, problems: [], runs: [{ s: "ab" }] },
  { name: "an array that always has more than maxItems", keywords: ["maxItems"], expr: r("a"), schema: { maxItems: 2 },
    shapes: { a: { type: "array", minItems: 3 } }, problems: [{ path: "$.x", message: "has at least 3 items, but must have at most 2" }], runs: [{ a: [1, 2, 3] }] },
  { name: "an array whose minItems touches maxItems", keywords: ["maxItems"], expr: r("a"), schema: { maxItems: 2 },
    shapes: { a: { type: "array", minItems: 2 } }, problems: [], runs: [{ a: [1, 2] }] },
  { name: "an array that always has fewer than minItems", keywords: ["minItems"], expr: r("a"), schema: { minItems: 2 },
    shapes: { a: { type: "array", maxItems: 1 } }, problems: [{ path: "$.x", message: "has at most 1 items, but must have at least 2" }], runs: [{ a: [1] }] },
  { name: "a list of unknown length into minItems", keywords: ["minItems"], expr: r("l"), schema: { minItems: 2 },
    shapes: { l: { t: "list", items: STRING } }, problems: [], runs: [{ l: ["a", "b"] }] },

  // 5. Reference items.
  { name: "a never-empty array with the wrong item type", keywords: ["items"], expr: r("a"), schema: { type: "array", items: { type: "integer" } },
    shapes: { a: { type: "array", minItems: 1, items: { type: "string" } } }, problems: [{ path: "$.x[0]", message: "is string, but expected integer" }], runs: [{ a: ["x"] }] },
  { name: "an array that may be empty", keywords: ["items"], expr: r("a"), schema: { type: "array", items: { type: "integer" } },
    shapes: { a: { type: "array", items: { type: "string" } } }, problems: [], runs: [{ a: [] }] },
  { name: "a list shape's items are not compared", keywords: ["items"], expr: r("l"), schema: { type: "array", items: { type: "integer" } },
    shapes: { l: { t: "list", items: STRING } }, problems: [], runs: [{ l: [] }] },

  // 6. The destination's const and enum against a reference (B).
  { name: "a short string can never equal const", keywords: ["const"], expr: r("s"), schema: { const: "abc" },
    shapes: { s: { type: "string", maxLength: 2 } }, problems: [{ path: "$.x", message: `can never equal "abc"` }], runs: [{ s: "ab" }] },
  { name: "a short string can never be an enum value", keywords: ["enum"], expr: r("s"), schema: { enum: ["abc", "defg"] },
    shapes: { s: { type: "string", maxLength: 2 } }, problems: [{ path: "$.x", message: `can never be one of "abc", "defg"` }], runs: [{ s: "ab" }] },
  { name: "a short string can be one enum value", keywords: ["enum"], expr: r("s"), schema: { enum: ["abc", "de"] },
    shapes: { s: { type: "string", maxLength: 2 } }, problems: [], runs: [{ s: "de" }] },
  { name: "an unknown shape may be const", keywords: ["const"], expr: r("u"), schema: { const: "x" },
    shapes: { u: UNKNOWN_SHAPE }, problems: [], runs: [{ u: "x" }] },
  { name: "a record can never equal const", keywords: ["const"], expr: r("w"), schema: { const: { answer: 5 } },
    shapes: { w: record({ answer: STRING }) }, problems: [{ path: "$.x", message: `can never equal {"answer":5}` }], runs: [{ w: { answer: "5" } }] },
  { name: "a record may equal const", keywords: ["const"], expr: r("w"), schema: { const: { answer: "yes" } },
    shapes: { w: record({ answer: STRING }) }, problems: [], runs: [{ w: { answer: "yes" } }] },
  { name: "a list can never equal a const with an element of another type", keywords: ["const"], expr: r("l"), schema: { const: ["a", 1] },
    shapes: { l: { t: "list", items: STRING } }, problems: [{ path: "$.x", message: `can never equal ["a",1]` }], runs: [{ l: ["a", "1"] }, { l: [] }] },
  { name: "a list may equal a const of strings", keywords: ["const"], expr: r("l"), schema: { const: ["a", "b"] },
    shapes: { l: { t: "list", items: STRING } }, problems: [], runs: [{ l: ["a", "b"] }] },
  { name: "a source schema with a $ref that does not resolve may be anything", keywords: ["const"], expr: r("s"), schema: { const: { a: 1 } },
    shapes: { s: { type: "object", properties: { a: { $ref: "#/$defs/Nope" } } } }, unchecked: ["s"], problems: [], runs: [{ s: { a: 1 } }] },
  { name: "a source enum that the pattern refuses", keywords: ["pattern"], expr: r("e"), schema: { type: "string", pattern: "^[ab]$" },
    shapes: { e: { enum: ["p", "q"] } }, problems: [{ path: "$.x", message: `can only be "p", "q", none of which fits` }], runs: [{ e: "p" }, { e: "q" }] },
  { name: "a source enum that the pattern accepts", keywords: ["pattern"], expr: r("e"), schema: { type: "string", pattern: "^[pq]$" },
    shapes: { e: { enum: ["p", "q"] } }, problems: [], runs: [{ e: "p" }] },
  { name: "a source enum against a destination enum", keywords: ["enum"], expr: r("e"), schema: { enum: ["a", "b"] },
    shapes: { e: { enum: ["p", "q"] } }, problems: [{ path: "$.x", message: `can only be "p", "q", none of which fits` }], runs: [{ e: "q" }] },

  // Types, objects and $ref for a reference.
  { name: "a boolean into a string", keywords: ["type"], expr: r("b"), schema: { type: "string" },
    shapes: { b: { type: "boolean" } }, problems: [{ path: "$.x", message: "is boolean, but expected string" }], runs: [{ b: true }] },
  { name: "a number into an integer", keywords: ["type"], expr: r("n"), schema: { type: "integer" },
    shapes: { n: { type: "number" } }, problems: [], runs: [{ n: 3 }] },
  { name: "a boolean into a string behind a $ref", keywords: ["$ref", "type"], expr: r("b"), schema: { $ref: "#/$defs/S", $defs: { S: { type: "string" } } },
    shapes: { b: { type: "boolean" } }, problems: [{ path: "$.x", message: "is boolean, but expected string" }], runs: [{ b: false }] },
  { name: "a string into a string behind a $ref", keywords: ["$ref", "type"], expr: r("s"), schema: { $ref: "#/$defs/S", $defs: { S: { type: "string" } } },
    shapes: { s: { type: "string" } }, problems: [], runs: [{ s: "a" }] },
  { name: "a record property of the wrong type", keywords: ["properties"], expr: r("w"), schema: { properties: { answer: { type: "boolean" } } },
    shapes: { w: record({ answer: STRING }) }, problems: [{ path: "$.x.answer", message: "is string, but expected boolean" }], runs: [{ w: { answer: "y" } }] },
  { name: "a record property of the right type", keywords: ["properties"], expr: r("w"), schema: { properties: { answer: { type: "string" } } },
    shapes: { w: record({ answer: STRING }) }, problems: [], runs: [{ w: { answer: "y" } }] },
  { name: "a record without a required property", keywords: ["required"], expr: r("w"), schema: { required: ["urgent"] },
    shapes: { w: record({ answer: STRING }) }, problems: [{ path: "$.x.urgent", message: `never has the required property "urgent"` }], runs: [{ w: { answer: "y" } }] },
  { name: "a record with the required property", keywords: ["required"], expr: r("w"), schema: { required: ["answer"] },
    shapes: { w: record({ answer: STRING }) }, problems: [], runs: [{ w: { answer: "y" } }] },
  { name: "a record property that additionalProperties refuses", keywords: ["additionalProperties"], expr: r("w"), schema: { additionalProperties: false },
    shapes: { w: record({ answer: STRING }) }, problems: [{ path: "$.x.answer", message: `always has the property "answer", which is not allowed` }],
    runs: [{ w: { answer: "y" } }] },
  { name: "a record property that additionalProperties accepts", keywords: ["additionalProperties"], expr: r("w"), schema: { additionalProperties: { type: "string" } },
    shapes: { w: record({ answer: STRING }) }, problems: [], runs: [{ w: { answer: "y" } }] },

  // Written objects.
  { name: "a written object into an array type", keywords: ["type"], expr: { a: r("s") }, schema: { type: "array" },
    shapes: { s: { type: "string" } }, problems: [{ path: "$.x", message: "is an object, but expected array" }], runs: [{ s: "a" }] },
  { name: "a written object into an object type", keywords: ["type"], expr: { a: r("s") }, schema: { type: "object" },
    shapes: { s: { type: "string" } }, problems: [], runs: [{ s: "a" }] },
  { name: "a written object's property of the wrong type", keywords: ["properties"], expr: { a: r("s") }, schema: { properties: { a: { type: "integer" } } },
    shapes: { s: { type: "string" } }, problems: [{ path: "$.x.a", message: "is string, but expected integer" }], runs: [{ s: "1" }] },
  { name: "a written object's property of the right type", keywords: ["properties"], expr: { a: r("s") }, schema: { properties: { a: { type: "string" } } },
    shapes: { s: { type: "string" } }, problems: [], runs: [{ s: "1" }] },
  { name: "a written object without a required key", keywords: ["required"], expr: { a: r("s") }, schema: { required: ["b"] },
    shapes: { s: { type: "string" } }, problems: [{ path: "$.x.b", message: `missing required property "b"` }], runs: [{ s: "1" }] },
  { name: "a written object with the required key", keywords: ["required"], expr: { a: r("s") }, schema: { required: ["a"] },
    shapes: { s: { type: "string" } }, problems: [], runs: [{ s: "1" }] },
  { name: "a written key that additionalProperties refuses", keywords: ["additionalProperties"], expr: { a: r("s") }, schema: { additionalProperties: false },
    shapes: { s: { type: "string" } }, problems: [{ path: "$.x.a", message: `property "a" is not allowed` }], runs: [{ s: "1" }] },
  { name: "a written key that additionalProperties accepts", keywords: ["additionalProperties"], expr: { a: r("s") }, schema: { additionalProperties: { type: "string" } },
    shapes: { s: { type: "string" } }, problems: [], runs: [{ s: "1" }] },
  { name: "a written object behind a $ref", keywords: ["$ref", "required"], expr: { a: r("s") },
    schema: { $ref: "#/$defs/O", $defs: { O: { type: "object", required: ["b"] } } }, shapes: { s: { type: "string" } },
    problems: [{ path: "$.x.b", message: `missing required property "b"` }], runs: [{ s: "1" }] },
  { name: "a written object that fits behind a $ref", keywords: ["$ref", "required"], expr: { a: r("s"), b: 1 },
    schema: { $ref: "#/$defs/O", $defs: { O: { type: "object", required: ["b"] } } }, shapes: { s: { type: "string" } }, problems: [], runs: [{ s: "1" }] },
  { name: "a written array behind a $ref with the wrong type", keywords: ["$ref", "type"], expr: [r("s")],
    schema: { $ref: "#/$defs/O", $defs: { O: { type: "object" } } }, shapes: { s: { type: "string" } },
    problems: [{ path: "$.x", message: "is an array, but expected object" }], runs: [{ s: "1" }] },

  // 7. Unions.
  { name: "a boolean that fits no alternative (anyOf)", keywords: ["anyOf"], expr: r("b"), schema: SCALAR_UNION,
    shapes: { b: { type: "boolean" } }, problems: [{ path: "$.x", message: NEVER_ALTERNATIVE }], runs: [{ b: true }] },
  { name: "a boolean that fits no alternative (oneOf)", keywords: ["oneOf"], expr: r("b"), schema: { oneOf: [{ type: "string" }, { type: "number" }] },
    shapes: { b: { type: "boolean" } }, problems: [{ path: "$.x", message: "never matches any of the 2 schemas (oneOf)" }], runs: [{ b: false }] },
  { name: "a boolean that fits one alternative (anyOf)", keywords: ["anyOf"], expr: r("b"), schema: { anyOf: [{ type: "string" }, { type: "boolean" }] },
    shapes: { b: { type: "boolean" } }, problems: [], runs: [{ b: true }] },
  { name: "a boolean that fits one alternative (oneOf)", keywords: ["oneOf"], expr: r("b"), schema: { oneOf: [{ type: "string" }, { type: "boolean" }] },
    shapes: { b: { type: "boolean" } }, problems: [], runs: [{ b: true }] },
  { name: "sibling keywords next to a union are checked", keywords: ["anyOf", "maximum"], expr: r("n"),
    schema: { maximum: 5, anyOf: [{ type: "number" }, { type: "string" }] }, shapes: { n: { type: "number", minimum: 10 } },
    problems: [{ path: "$.x", message: "is at least 10, but must be <= 5" }], runs: [{ n: 10 }] },
  { name: "a union behind a $ref", keywords: ["oneOf", "$ref"], expr: r("b"),
    schema: { $ref: "#/$defs/U", $defs: { U: { oneOf: [{ type: "string" }, { type: "integer" }] } } }, shapes: { b: { type: "boolean" } },
    problems: [{ path: "$.x", message: "never matches any of the 2 schemas (oneOf)" }], runs: [{ b: true }] },
  { name: "nested unions, every alternative wrong", keywords: ["anyOf", "oneOf"], expr: r("b"),
    schema: { anyOf: [{ anyOf: [{ type: "string" }] }, { oneOf: [{ type: "number" }] }] }, shapes: { b: { type: "boolean" } },
    problems: [{ path: "$.x", message: NEVER_ALTERNATIVE }], runs: [{ b: true }] },
  { name: "nested unions, one inner alternative may fit", keywords: ["anyOf"], expr: r("b"),
    schema: { anyOf: [{ anyOf: [{ type: "string" }, { type: "boolean" }] }, { type: "number" }] }, shapes: { b: { type: "boolean" } },
    problems: [], runs: [{ b: true }] },
  { name: "a source union whose every alternative is wrong", keywords: ["anyOf", "type"], expr: r("u"), schema: { type: "string" },
    shapes: { u: { anyOf: [{ type: "boolean" }, { type: "null" }] } },
    problems: [{ path: "$.x", message: "none of its 2 alternatives fits: is boolean, but expected string" }], runs: [{ u: true }, { u: null }] },
  { name: "a source union one of whose alternatives may fit", keywords: ["anyOf", "type"], expr: r("u"), schema: { type: "string" },
    shapes: { u: { anyOf: [{ type: "boolean" }, { type: "string" }] } }, problems: [], runs: [{ u: "x" }] },
  { name: "a template that fits no alternative (anyOf)", keywords: ["anyOf"], expr: "x{{input.s}}", schema: { anyOf: [{ type: "integer" }, { maxLength: 0 }] },
    shapes: { s: { type: "string" } }, problems: [{ path: "$.x", message: NEVER_ALTERNATIVE }], runs: [{ s: "" }] },
  { name: "a template that fits one alternative (anyOf)", keywords: ["anyOf"], expr: "x{{input.s}}", schema: { anyOf: [{ type: "integer" }, { maxLength: 1 }] },
    shapes: { s: { type: "string" } }, problems: [], runs: [{ s: "" }] },
  { name: "a template that fits no alternative (oneOf)", keywords: ["oneOf"], expr: "{{input.s}}", schema: { oneOf: [{ type: "boolean" }, { const: 5 }] },
    shapes: { s: { type: "string" } }, problems: [{ path: "$.x", message: "never matches any of the 2 schemas (oneOf)" }], runs: [{ s: "5" }] },
  { name: "a template that fits one alternative (oneOf)", keywords: ["oneOf"], expr: "{{input.s}}", schema: { oneOf: [{ type: "boolean" }, { const: "5" }] },
    shapes: { s: { type: "string" } }, problems: [], runs: [{ s: "5" }] },
  { name: "a written array that fits no alternative (anyOf)", keywords: ["anyOf"], expr: [r("s")],
    schema: { anyOf: [{ type: "object" }, { type: "array", minItems: 2 }] }, shapes: { s: { type: "string" } },
    problems: [{ path: "$.x", message: NEVER_ALTERNATIVE }], runs: [{ s: "a" }] },
  { name: "a written array that fits one alternative (anyOf)", keywords: ["anyOf"], expr: [r("s")],
    schema: { anyOf: [{ type: "object" }, { type: "array", minItems: 1 }] }, shapes: { s: { type: "string" } }, problems: [], runs: [{ s: "a" }] },
  { name: "a written array that fits no alternative (oneOf)", keywords: ["oneOf"], expr: [r("s")],
    schema: { oneOf: [{ items: { type: "integer" } }, { maxItems: 0 }] }, shapes: { s: { type: "string" } },
    problems: [{ path: "$.x", message: "never matches any of the 2 schemas (oneOf)" }], runs: [{ s: "a" }] },
  { name: "a written array that fits one alternative (oneOf)", keywords: ["oneOf"], expr: [r("s")],
    schema: { oneOf: [{ items: { type: "integer" } }, { maxItems: 1 }] }, shapes: { s: { type: "string" } }, problems: [], runs: [{ s: "a" }] },
  { name: "a written object that fits no alternative (oneOf)", keywords: ["oneOf"], expr: { a: r("s") },
    schema: { oneOf: [{ type: "array" }, { required: ["b"] }] }, shapes: { s: { type: "string" } },
    problems: [{ path: "$.x", message: "never matches any of the 2 schemas (oneOf)" }], runs: [{ s: "a" }] },
  { name: "a written object that fits one alternative (oneOf)", keywords: ["oneOf"], expr: { a: r("s") },
    schema: { oneOf: [{ type: "array" }, { required: ["a"] }] }, shapes: { s: { type: "string" } }, problems: [], runs: [{ s: "a" }] },
  { name: "a written object that fits no alternative (anyOf)", keywords: ["anyOf"], expr: { a: r("b") }, schema: OBJECT_UNION,
    shapes: { b: { type: "boolean" } }, problems: [{ path: "$.x", message: NEVER_ALTERNATIVE }], runs: [{ b: true }] },
  { name: "a written object that fits one alternative (anyOf)", keywords: ["anyOf"], expr: { a: r("s") }, schema: OBJECT_UNION,
    shapes: { s: { type: "string" } }, problems: [], runs: [{ s: "a" }] },

  // Defaults and unions.
  { name: "nested in an object: the shape fits one alternative, the default the other", keywords: ["anyOf"], expr: { a: r("x", 5) },
    schema: OBJECT_UNION, shapes: { x: { type: "string" } }, presence: { x: "maybe" }, problems: [], runs: [{ x: "s" }, {}], everyFits: true },
  { name: "nested in an array: the shape fits one alternative, the default the other", keywords: ["anyOf"], expr: [r("x", 5)],
    schema: ARRAY_UNION, shapes: { x: { type: "string" } }, presence: { x: "maybe" }, problems: [], runs: [{ x: "s" }, {}], everyFits: true },
  { name: "nested: the shape and the default both wrong for every alternative", keywords: ["anyOf"], expr: { a: r("x", null) },
    schema: OBJECT_UNION, shapes: { x: { type: "boolean" } }, presence: { x: "maybe" },
    problems: [{ path: "$.x", message: NEVER_ALTERNATIVE }], runs: [{ x: true }, {}] },
  { name: "nested: the shape wrong for every alternative, the default fits one", keywords: ["anyOf"], expr: { a: r("x", 5) },
    schema: OBJECT_UNION, shapes: { x: { type: "boolean" } }, presence: { x: "maybe" }, problems: [], runs: [{}, { x: true }] },
  { name: "nested: the same reference always resolves, so its default is never read", keywords: ["anyOf"], expr: { a: r("x", 5) },
    schema: OBJECT_UNION, shapes: { x: { type: "boolean" } }, presence: { x: "always" },
    problems: [{ path: "$.x", message: NEVER_ALTERNATIVE }], runs: [{ x: true }] },
  { name: "direct: the shape is wrong for every alternative, whatever the default", keywords: ["anyOf"], expr: r("x", 5),
    schema: SCALAR_UNION, shapes: { x: { type: "boolean" } }, presence: { x: "maybe" },
    problems: [{ path: "$.x", message: NEVER_ALTERNATIVE }], runs: [{ x: true }] },
  { name: "direct: a default that may be read is checked against the whole union", keywords: ["anyOf"], expr: r("x", true),
    schema: SCALAR_UNION, shapes: { x: { type: "boolean" } }, presence: { x: "maybe" },
    problems: [{ path: "$.x", message: NEVER_ALTERNATIVE }, { path: "$.x.default", message: "must match at least one of 2 schemas (anyOf), matched 0" }],
    runs: [{ x: true }, {}] },
  { name: "direct: a reference that always resolves never has its default checked", keywords: ["anyOf"], expr: r("x", true),
    schema: SCALAR_UNION, shapes: { x: { type: "boolean" } }, presence: { x: "always" },
    problems: [{ path: "$.x", message: NEVER_ALTERNATIVE }], runs: [{ x: false }] },
  { name: "direct: the shape fits one alternative", keywords: ["anyOf"], expr: r("x", 5),
    schema: SCALAR_UNION, shapes: { x: { type: "string" } }, presence: { x: "maybe" }, problems: [], runs: [{ x: "s" }, {}], everyFits: true },
];

for (const c of CASES) {
  test(`matrix: ${c.name}`, () => {
    const problems = run(c);
    assert.deepEqual(problems, c.problems);
    agree(c, problems);
  });
}

/** The forms for which the table has a rule for each keyword of the documented subset. */
const RULES: { [keyword: string]: Form[] } = {
  type: ["template", "array", "object", "ref"],
  properties: ["object", "ref"],
  required: ["object", "ref"],
  additionalProperties: ["object", "ref"],
  items: ["array", "ref"],
  enum: ["template", "array", "object", "ref"],
  const: ["template", "array", "object", "ref"],
  minimum: ["ref"],
  maximum: ["ref"],
  minLength: ["template", "ref"],
  maxLength: ["template", "ref"],
  minItems: ["array", "ref"],
  maxItems: ["array", "ref"],
  pattern: ["template", "ref"],
  anyOf: ["template", "array", "object", "ref"],
  oneOf: ["template", "array", "object", "ref"],
  $ref: ["template", "array", "object", "ref"],
};

/** Cells the table leaves to run time: they only have a case that reports nothing. */
const RUN_TIME_ONLY = ["minLength x template", "pattern x template"];

test("every keyword of the documented subset has a case for every form the table has a rule for", () => {
  const subset = ["type", "properties", "required", "additionalProperties", "items", "enum", "const", "minimum", "maximum", "minLength",
    "maxLength", "minItems", "maxItems", "pattern", "anyOf", "oneOf", "$ref"];
  assert.deepEqual(Object.keys(RULES).sort(), [...subset].sort());
  const missing: string[] = [];
  for (const keyword of subset) {
    for (const form of RULES[keyword] ?? []) {
      const cases = CASES.filter((c) => formOf(c.expr) === form && c.keywords.includes(keyword));
      const cell = `${keyword} x ${form}`;
      const certain = RUN_TIME_ONLY.includes(cell) || cases.some((c) => c.problems.length > 0);
      if (!certain || !cases.some((c) => c.problems.length === 0)) missing.push(cell);
    }
  }
  assert.deepEqual(missing, [], "each cell needs a certain mismatch (unless it is left to run time) and a may-fit neighbour");
  for (const c of CASES) {
    for (const keyword of c.keywords) assert.ok(subset.includes(keyword), `${c.name}: ${keyword}`);
  }
});

test("T1 never refuses what a template renders", () => {
  const templates = ["order-{{input.a}}", "{{input.a}}.txt", "ab{{input.a}}ba", "{{input.a}}-{{input.b}}+{{input.a}}", "{{input.a}}{{input.b}}", "x{{input.a}}y{{input.b}}z"];
  const strings = ["", "a", "ab", "ba", "-", "+", "x-y+z", "abba", "{{", "é", "😀"];
  for (const template of templates) {
    for (const a of strings) {
      for (const b of strings) {
        const rendered = renderTemplate(template, scope({ a, b }));
        const problems = checkAssignable({ expr: template, path: "$.x", schema: { const: rendered }, root: { const: rendered }, refOf: () => ({ shape: STRING, presence: "always" }) });
        assert.deepEqual(problems, [], `${template} with ${JSON.stringify([a, b])} renders ${JSON.stringify(rendered)}`);
        const bound = [...rendered].length;
        const short = checkAssignable({ expr: template, path: "$.x", schema: { maxLength: bound }, root: { maxLength: bound }, refOf: () => ({ shape: STRING, presence: "always" }) });
        assert.deepEqual(short, [], `T2: ${JSON.stringify(rendered)} has ${bound} characters`);
      }
    }
  }
});

test("beyond 512 alternatives nothing is reported, and the check returns", { timeout: 30_000 }, () => {
  const wide: JsonSchema = { anyOf: Array.from({ length: 600 }, () => ({ type: "string" })) };
  const refOf = () => ({ shape: plainShape({ type: "boolean" }), presence: "always" as const });
  assert.deepEqual(checkAssignable({ expr: { $ref: "input.b" }, path: "$.x", schema: wide, root: wide, refOf }), []);
  assert.equal(MAX_ALTERNATIVES, 512);
  const narrow: JsonSchema = { anyOf: Array.from({ length: 512 }, () => ({ type: "string" })) };
  assert.deepEqual(checkAssignable({ expr: { $ref: "input.b" }, path: "$.x", schema: narrow, root: narrow, refOf }),
    [{ path: "$.x", message: "never matches any of the 512 schemas (anyOf)" }], "512 alternatives are still evaluated");
  let nested: JsonSchema = { type: "string" };
  for (let i = 0; i < 40; i++) nested = { anyOf: [nested, nested, nested] };
  assert.deepEqual(checkAssignable({ expr: [{ $ref: "input.b" }], path: "$.x", schema: { type: "array", items: nested }, root: nested, refOf }), [],
    "a union nested 40 deep with 3 alternatives each is cut at the bound");
  const source = plainShape({ anyOf: Array.from({ length: 600 }, () => ({ type: "boolean" })) });
  assert.deepEqual(checkAssignable({ expr: { $ref: "input.u" }, path: "$.x", schema: { type: "string" }, root: { type: "string" }, refOf: () => ({ shape: source, presence: "always" }) }), [],
    "a source union beyond the bound");
});

test("a malformed part of a written value is undecided: it may equal anything", () => {
  const expr = [{ $ref: "input.s" }, { $ref: 5 }] as unknown as Json;
  const refOf = () => ({ shape: STRING, presence: "always" as const });
  assert.deepEqual(checkAssignable({ expr, path: "$.x", schema: { const: ["a", 2] }, root: {}, refOf }), []);
  assert.deepEqual(checkAssignable({ expr, path: "$.x", schema: { const: [1, 2] }, root: {}, refOf }), [{ path: "$.x", message: "can never equal [1,2]" }],
    "the reference part alone rules the constant out");
});

test("comparisons stop at the evaluation bound, and then nothing more is claimed", { timeout: 30_000 }, () => {
  const values = Array.from({ length: 1000 }, (_, i) => `v${i}`);
  const refOf = () => ({ shape: plainShape({ type: "string", maxLength: 1 }), presence: "always" as const });
  const one: JsonSchema = { anyOf: [{ $ref: "#/$defs/E" }, { type: "integer" }], $defs: { E: { enum: values } } };
  assert.deepEqual(checkAssignable({ expr: { $ref: "input.s" }, path: "$.x", schema: one, root: one, refOf }),
    [{ path: "$.x", message: "never matches any of the 2 schemas (anyOf)" }], "below the bound every value is compared");
  const alternatives = Math.ceil(MAX_COMPARISON_EVALUATIONS / values.length) + 10;
  assert.ok(alternatives < MAX_ALTERNATIVES);
  const many: JsonSchema = { anyOf: Array.from({ length: alternatives }, () => ({ $ref: "#/$defs/E" })), $defs: { E: { enum: values } } };
  assert.deepEqual(checkAssignable({ expr: { $ref: "input.s" }, path: "$.x", schema: many, root: many, refOf }), [],
    "the alternatives after the bound may fit");
});
