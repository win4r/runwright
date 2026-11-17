/**
 * Rule P: what can be proved wrong about a workflow expression flowing into a schema. The validator reports a
 * mismatch only when it is certain: no run that evaluates the expression could make it fit.
 *
 * A literal (no reference, no template path, or a `$literal`) is validated in full. Every other expression is one
 * of four forms, and each keyword of every destination part (the schema and every schema on its `$ref` chain) is
 * applied to it as this table says. S is the dereferenced shape of a reference.
 *
 * | keyword                  | template string     | written array       | written object      | reference with shape S          |
 * |--------------------------|---------------------|---------------------|---------------------|---------------------------------|
 * | type                     | string admitted     | array admitted      | object admitted     | some type of S admitted         |
 * | const, enum              | T1                  | Q                   | Q                   | B                               |
 * | minimum, maximum         | n/a                 | n/a                 | n/a                 | S only numbers: ranges overlap  |
 * | minLength, maxLength     | T2 (maxLength only) | n/a                 | n/a                 | S only strings: lengths overlap |
 * | pattern                  | run time            | n/a                 | n/a                 | through S's own const/enum      |
 * | minItems, maxItems       | n/a                 | the written length  | n/a                 | S only arrays: lengths overlap  |
 * | items                    | n/a                 | each element        | n/a                 | S never empty: item at `[0]`    |
 * | properties, required,    | n/a                 | n/a                 | each key, each      | what S never has or always has  |
 * |   additionalProperties   |                     |                     |   required key      |                                 |
 * | anyOf, oneOf             | U                   | U                   | U                   | U                               |
 * | $ref                     | followed            | followed            | followed            | followed                        |
 *
 * - T1: a template renders its text parts in order with arbitrary strings between them; an allowed value it
 *   cannot render (a non-string, or a string without the leading text, the trailing text or the middle texts in
 *   order) does not count.
 * - T2: the text parts alone have this many characters, whatever the references render.
 * - Q: an allowed value counts when it can equal the written value: the same length or exactly the same keys,
 *   and each element or value can equal it (a literal by canonical JSON, a template by T1, a reference by B or
 *   by a default it may read).
 * - B: an allowed value counts when S can be it (it validates against S's schema; an unknown shape can be
 *   anything).
 * - U: every alternative of an `anyOf` / `oneOf` is checked by these rules on its own; a problem is reported only
 *   when every alternative has one. Sibling keywords next to a union are checked like any other part.
 * - A reference with a default is compared by its shape (whenever it resolves, its value has that shape); its
 *   default is validated in full, at `<path>.default`, only when the reference may be missing. Inside a written
 *   array or object that is checked against one alternative, such a reference counts against the alternative
 *   only when its shape and its default are both certainly wrong there.
 * - A reference whose shape is a union is compared alternative by alternative and reported only when every
 *   alternative is certainly wrong.
 * - Every `$ref` follows the reference-root rule of `resolveSchemaRef`: a reference that lands on a named schema
 *   makes that schema the document its own references (and those of the keywords below it) resolve in.
 *
 * Left to the run-time checks: `minLength` and `pattern` of a template; a value of unknown shape; a schema that
 * does not pin its types; a type that may fit; the length and items of a list shape (a map's output); a union
 * only some of whose alternatives are certainly wrong; a `$ref` that does not resolve; anything beyond
 * `MAX_DEPTH`, beyond `MAX_ALTERNATIVES` evaluated alternatives or beyond `MAX_COMPARISON_EVALUATIONS` schema
 * evaluations of the comparisons.
 */
import { canonicalJson, isJsonObject, type Json, type JsonObject } from "../core/json.ts";
import {
  pathIndex, pathProperty, resolveSchemaRefIn, validateSubschema, validateSubschemaWithin, type EvaluationBudget, type JsonSchema, type SchemaProblem,
} from "../schema/validate.ts";
import { listRefs, refForm, resolveValue, copyJson, templateParts, type RefScope } from "./refs.ts";
import { UNKNOWN_SHAPE, derefShape, schemaValueTypes, type Shape } from "./walk.ts";

export interface AssignProblem { path: string; message: string }

export interface RefInfo {
  shape: Shape;
  /** "always": every run that evaluates the expression resolves the reference. "maybe": it may be missing. */
  presence: "always" | "maybe";
}

export interface AssignInput {
  /** The workflow expression (may hold `{$ref}`, `{$literal}` and templates). */
  expr: Json;
  /** JSON path of the expression, for problem paths. */
  path: string;
  /** Destination schema. */
  schema: JsonSchema;
  /** Schema whose `$defs` / `definitions` local references resolve in. */
  root: JsonSchema;
  /** The document's named schemas, when there are any. */
  definitions?: Readonly<Record<string, JsonSchema>>;
  /** The static shape of a reference (what `steps.x.y` names) and whether it always resolves. */
  refOf: (refPath: string) => RefInfo;
}

/** Comparisons of shapes and expressions stop this deep (unknown below). */
const MAX_DEPTH = 32;
/** `$ref` chains of a destination are followed this far (unknown beyond). */
const MAX_REF_HOPS = 64;
/** Union alternatives (of destinations and of sources) evaluated per `checkAssignable` call; beyond, nothing is claimed. */
export const MAX_ALTERNATIVES = 512;
/**
 * Schema evaluations per `checkAssignable` call for the comparisons that decide whether a value is possible or
 * allowed (B, Q, a source's own value list, a default inside an alternative); once spent, every such value may fit.
 */
export const MAX_COMPARISON_EVALUATIONS = 200_000;
const EMPTY_SCOPE: RefScope = { input: null, steps: {}, vars: {}, loop: {}, run: { id: "", agentId: "" } };
const UNION_KEYWORDS = ["anyOf", "oneOf"] as const;

interface Budget { alternatives: number; evaluations: EvaluationBudget }

interface Context {
  /** The schema document local references of the destination resolve in (the reference-root rule). */
  root: JsonSchema;
  definitions: Readonly<Record<string, JsonSchema>> | undefined;
  refOf: (refPath: string) => RefInfo;
  out: AssignProblem[];
  seen: Set<string>;
  budget: Budget;
  /** True while a written array or object is checked against one alternative of a union. */
  inAlternative: boolean;
}

function scratch(ctx: Context, inAlternative: boolean): Context {
  return { ...ctx, out: [], seen: new Set(), inAlternative };
}

/** One destination part: a schema and the schema document its local references resolve in. */
interface Part { schema: JsonSchema; root: JsonSchema }

/** The same context (same problems, same budget) with `root` as the document for local references. */
function inDocument(ctx: Context, root: JsonSchema): Context {
  return root === ctx.root ? ctx : { ...ctx, root };
}

function joinPath(base: string, relative: string): string {
  return base + relative.slice(1);
}

function add(ctx: Context, path: string, message: string): void {
  const key = `${path}\u0000${message}`;
  if (ctx.seen.has(key)) return;
  ctx.seen.add(key);
  ctx.out.push({ path, message });
}

function hasMalformed(expr: Json): boolean {
  if (Array.isArray(expr)) return expr.some(hasMalformed);
  if (!isJsonObject(expr)) return false;
  const form = refForm(expr);
  if (form !== null) return form.kind === "malformed";
  return Object.keys(expr).some((key) => hasMalformed(expr[key] ?? null));
}

/** True for an expression with no reference, no template path and nothing malformed: its value is fixed. */
export function isLiteralExpr(expr: Json): boolean {
  return listRefs(expr).length === 0 && !hasMalformed(expr);
}

function describe(value: Json): string {
  const text = JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function describeTypes(types: readonly string[]): string {
  return types.join(" or ");
}

/**
 * The schema and every schema its `$ref` chain leads to, each with the document its own references resolve in
 * (`resolveSchemaRefIn`): all of them apply. Null when a reference does not resolve.
 */
function parts(ctx: Context, schema: unknown): Part[] | null {
  if (!isJsonObject(schema)) return null;
  const list: Part[] = [{ schema, root: ctx.root }];
  let current: Part = { schema, root: ctx.root };
  for (let hops = 0; typeof current.schema["$ref"] === "string"; hops++) {
    if (hops >= MAX_REF_HOPS) return null;
    const target = resolveSchemaRefIn(current.schema["$ref"], current.root, ctx.definitions);
    if (target === null) return null;
    list.push(target);
    current = target;
  }
  return list;
}

/** True when a value of JSON type `type` may be accepted by a schema that admits `allowed` (3.0 is an integer). */
function mayAdmit(allowed: readonly string[], type: string): boolean {
  if (allowed.includes(type)) return true;
  if (type === "integer") return allowed.includes("number");
  if (type === "number") return allowed.includes("integer");
  return false;
}

/** True when a validation outcome is not decided: the schema has a `$ref` that does not resolve, or the budget ran out. */
function undecided(problems: readonly SchemaProblem[]): boolean {
  return problems.some((problem) => problem.keyword === "$ref" || problem.keyword === "limit");
}

/** Validation for a comparison, within the call's evaluation budget (a spent budget gives the "limit" problem). */
function compareValidate(budget: Budget, root: JsonSchema, schema: unknown, value: Json, definitions: Readonly<Record<string, JsonSchema>> | undefined): SchemaProblem[] {
  return validateSubschemaWithin(root, schema, value, { definitions }, budget.evaluations);
}

/** True when `value` certainly fails `schema` (in the destination's context). */
function certainlyFails(ctx: Context, value: Json, schema: unknown): boolean {
  const problems = compareValidate(ctx.budget, ctx.root, schema, value, ctx.definitions);
  return problems.length > 0 && !undecided(problems);
}

/** A fixed value, validated in full against the destination. */
function checkValue(ctx: Context, value: Json, path: string, schema: unknown): void {
  for (const problem of validateSubschema(ctx.root, schema, value, { definitions: ctx.definitions })) {
    add(ctx, joinPath(path, problem.path), problem.message);
  }
}

function literalValue(expr: Json): Json | undefined {
  try {
    return resolveValue(expr, EMPTY_SCOPE);
  } catch {
    return undefined;
  }
}

/** The allowed values a part lists: its `const` (as a one-element list), else its `enum`, else null. */
function allowedValues(part: JsonSchema): { keyword: "const" | "enum"; values: Json[] } | null {
  if (Object.hasOwn(part, "const")) return { keyword: "const", values: [part["const"] ?? null] };
  if (Array.isArray(part["enum"])) return { keyword: "enum", values: part["enum"] };
  return null;
}

/** Reports a part's `const` / `enum` when none of its values passes `possible`. */
function checkAllowed(ctx: Context, part: JsonSchema, path: string, possible: (value: Json) => boolean): void {
  const allowed = allowedValues(part);
  if (allowed === null || allowed.values.some(possible)) return;
  if (allowed.keyword === "const") add(ctx, path, `can never equal ${describe(allowed.values[0] ?? null)}`);
  else add(ctx, path, `can never be one of ${allowed.values.map(describe).join(", ")}`);
}

/** A part's known types do not include `type`: report it and say so. */
function excludes(ctx: Context, list: readonly Part[], type: string, what: string, path: string): boolean {
  for (const part of list) {
    const allowed = schemaValueTypes(part.schema);
    if (allowed !== null && !mayAdmit(allowed, type)) {
      add(ctx, path, `is ${what}, but expected ${describeTypes(allowed)}`);
      return true;
    }
  }
  return false;
}

/**
 * Rule U for every part of `list` that has `anyOf` / `oneOf`: `check` runs once per alternative into a scratch
 * context, and the union is reported only when every alternative got a problem. An alternative that is not a
 * schema object, or a union beyond the alternative budget, may fit.
 */
function checkUnions(ctx: Context, list: readonly Part[], path: string, inAlternative: boolean,
  check: (sub: Context, alternative: JsonSchema) => void): void {
  for (const part of list) {
    for (const keyword of UNION_KEYWORDS) {
      const alternatives = part.schema[keyword];
      if (!Array.isArray(alternatives) || alternatives.length === 0) continue;
      if (unionFails(inDocument(ctx, part.root), alternatives, inAlternative, check)) add(ctx, path, `never matches any of the ${alternatives.length} schemas (${keyword})`);
    }
  }
}

function unionFails(ctx: Context, alternatives: readonly unknown[], inAlternative: boolean,
  check: (sub: Context, alternative: JsonSchema) => void): boolean {
  if (ctx.budget.alternatives + alternatives.length > MAX_ALTERNATIVES) {
    ctx.budget.alternatives = MAX_ALTERNATIVES;
    return false;
  }
  ctx.budget.alternatives += alternatives.length;
  for (const alternative of alternatives) {
    if (!isJsonObject(alternative)) return false;
    const sub = scratch(ctx, inAlternative);
    check(sub, alternative);
    if (sub.out.length === 0) return false;
  }
  return true;
}

function checkExpr(ctx: Context, expr: Json, path: string, schema: unknown, depth: number): void {
  if (depth > MAX_DEPTH) return;
  if (isLiteralExpr(expr)) {
    const value = literalValue(expr);
    if (value !== undefined) checkValue(ctx, value, path, schema);
    return;
  }
  const list = parts(ctx, schema);
  if (list === null) return;
  if (typeof expr === "string") {
    checkTemplate(ctx, expr, path, list, depth);
    return;
  }
  if (Array.isArray(expr)) {
    checkArray(ctx, expr, path, list, depth);
    return;
  }
  if (!isJsonObject(expr)) return;
  const form = refForm(expr);
  if (form === null) {
    checkObject(ctx, expr, path, list, depth);
    return;
  }
  if (form.kind !== "ref") return;
  checkRef(ctx, form.path, form.fallback, path, schema, list, depth);
}

/** T1: true when the template can render `value`. */
function canRender(template: string, value: Json): boolean {
  if (typeof value !== "string") return false;
  const pieces = templateParts(template);
  const first = pieces[0];
  const last = pieces.at(-1);
  if (first === undefined || last === undefined) return value === template;
  let start = 0;
  let end = value.length;
  let from = 0;
  let to = pieces.length;
  if (first.kind === "text") {
    if (!value.startsWith(first.text)) return false;
    start = first.text.length;
    from = 1;
  }
  if (last.kind === "text" && to > from) {
    if (!value.endsWith(last.text) || value.length - last.text.length < start) return false;
    end = value.length - last.text.length;
    to -= 1;
  }
  let position = start;
  for (let i = from; i < to; i++) {
    const piece = pieces[i] as (typeof pieces)[number];
    if (piece.kind !== "text") continue;
    const found = value.indexOf(piece.text, position);
    if (found < 0 || found + piece.text.length > end) return false;
    position = found + piece.text.length;
  }
  return true;
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/** Code points of `text` as the schema validator counts them. */
function codePoints(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (!(isLowSurrogate(text.charCodeAt(i)) && i > 0 && isHighSurrogate(text.charCodeAt(i - 1)))) count++;
  }
  return count;
}

/** T2: the characters a template always renders, from its text parts (a lone surrogate at either end of a part is not counted). */
function fixedLength(template: string): number {
  let total = 0;
  for (const piece of templateParts(template)) {
    if (piece.kind !== "text") continue;
    let text = piece.text;
    if (text.length > 0 && isLowSurrogate(text.charCodeAt(0))) text = text.slice(1);
    if (text.length > 0 && isHighSurrogate(text.charCodeAt(text.length - 1))) text = text.slice(0, -1);
    total += codePoints(text);
  }
  return total;
}

/** A template string: always a string, with its text parts fixed. */
function checkTemplate(ctx: Context, expr: string, path: string, list: readonly Part[], depth: number): void {
  if (excludes(ctx, list, "string", "string", path)) return;
  for (const { schema: part } of list) {
    checkAllowed(ctx, part, path, (value) => canRender(expr, value));
    const maxLength = part["maxLength"];
    if (typeof maxLength === "number") {
      const fixed = fixedLength(expr);
      if (fixed > maxLength) add(ctx, path, `always has at least ${fixed} characters, but must be at most ${maxLength}`);
    }
  }
  checkUnions(ctx, list, path, true, (sub, alternative) => checkExpr(sub, expr, path, alternative, depth + 1));
}

/** An array written in the document that holds a reference somewhere: its length is the written length. */
function checkArray(ctx: Context, expr: Json[], path: string, list: readonly Part[], depth: number): void {
  if (excludes(ctx, list, "array", "an array", path)) return;
  for (const { schema: part } of list) {
    const minItems = part["minItems"];
    if (typeof minItems === "number" && expr.length < minItems) add(ctx, path, `must have at least ${minItems} items, got ${expr.length}`);
    const maxItems = part["maxItems"];
    if (typeof maxItems === "number" && expr.length > maxItems) add(ctx, path, `must have at most ${maxItems} items, got ${expr.length}`);
  }
  for (const { schema: part, root } of list) {
    const items = part["items"];
    if (isJsonObject(items)) expr.forEach((item, i) => checkExpr(inDocument(ctx, root), item, pathIndex(path, i), items, depth + 1));
  }
  for (const { schema: part } of list) checkAllowed(ctx, part, path, (value) => canEqual(ctx, expr, value, depth + 1));
  checkUnions(ctx, list, path, true, (sub, alternative) => checkExpr(sub, expr, path, alternative, depth + 1));
}

/** An object written in the document that holds a reference somewhere: its keys are the written keys. */
function checkObject(ctx: Context, expr: JsonObject, path: string, list: readonly Part[], depth: number): void {
  if (excludes(ctx, list, "object", "an object", path)) return;
  for (const { schema: part, root } of list) {
    const there = inDocument(ctx, root);
    const properties = isJsonObject(part["properties"]) ? part["properties"] : {};
    const additional = part["additionalProperties"];
    for (const key of Object.keys(expr)) {
      const value = expr[key] ?? null;
      const at = pathProperty(path, key);
      if (Object.hasOwn(properties, key)) checkExpr(there, value, at, properties[key], depth + 1);
      else if (additional === false) add(ctx, at, `property ${JSON.stringify(key)} is not allowed`);
      else if (isJsonObject(additional)) checkExpr(there, value, at, additional, depth + 1);
    }
    const required = part["required"];
    if (!Array.isArray(required)) continue;
    for (const name of required) {
      if (typeof name === "string" && !Object.hasOwn(expr, name)) add(ctx, pathProperty(path, name), `missing required property ${JSON.stringify(name)}`);
    }
  }
  for (const { schema: part } of list) checkAllowed(ctx, part, path, (value) => canEqual(ctx, expr, value, depth + 1));
  checkUnions(ctx, list, path, true, (sub, alternative) => checkExpr(sub, expr, path, alternative, depth + 1));
}

/** A reference: its shape is compared; its default is checked when it may be missing (see the header). */
function checkRef(ctx: Context, refPath: string, fallback: Json | undefined, path: string, schema: unknown,
  list: readonly Part[], depth: number): void {
  const info = ctx.refOf(refPath);
  const readsDefault = fallback !== undefined && info.presence === "maybe";
  if (!ctx.inAlternative || !readsDefault) {
    compareShape(ctx, info.shape, list, path, depth);
    if (readsDefault) checkValue(ctx, copyJson(fallback), pathProperty(path, "default"), schema);
    return;
  }
  const shapeProblems = scratch(ctx, true);
  compareShape(shapeProblems, info.shape, list, path, depth);
  if (shapeProblems.out.length === 0 || !certainlyFails(ctx, copyJson(fallback), schema)) return;
  for (const problem of shapeProblems.out) add(ctx, problem.path, problem.message);
}

/** Q: true when the written expression can evaluate to `value` in some run. */
function canEqual(ctx: Context, expr: Json, value: Json, depth: number): boolean {
  if (depth > MAX_DEPTH) return true;
  if (isLiteralExpr(expr)) {
    const fixed = literalValue(expr);
    return fixed === undefined || canonicalJson(fixed) === canonicalJson(value);
  }
  if (typeof expr === "string") return canRender(expr, value);
  if (Array.isArray(expr)) {
    return Array.isArray(value) && value.length === expr.length && expr.every((item, i) => canEqual(ctx, item, value[i] ?? null, depth + 1));
  }
  if (!isJsonObject(expr)) return true;
  const form = refForm(expr);
  if (form === null) {
    if (!isJsonObject(value)) return false;
    const keys = Object.keys(expr);
    if (keys.length !== Object.keys(value).length || !keys.every((key) => Object.hasOwn(value, key))) return false;
    return keys.every((key) => canEqual(ctx, expr[key] ?? null, value[key] ?? null, depth + 1));
  }
  if (form.kind !== "ref") return true;
  const info = ctx.refOf(form.path);
  if (mayBe(ctx.budget, info.shape, value, depth + 1)) return true;
  return form.fallback !== undefined && info.presence === "maybe" && canonicalJson(copyJson(form.fallback)) === canonicalJson(value);
}

/** B: true when a value of `source` can be `value` (unknown, a `$ref` that does not resolve or a spent budget: yes). */
function mayBe(budget: Budget, source: Shape, value: Json, depth: number): boolean {
  if (depth > MAX_DEPTH) return true;
  const shape = derefShape(source);
  switch (shape.t) {
    case "unknown":
      return true;
    case "schema": {
      const problems = compareValidate(budget, shape.root, shape.schema, value, shape.defs);
      return problems.length === 0 || undecided(problems);
    }
    case "record": {
      if (!isJsonObject(value)) return false;
      const names = Object.keys(shape.fields);
      if (names.length !== Object.keys(value).length || !names.every((name) => Object.hasOwn(value, name))) return false;
      return names.every((name) => mayBe(budget, shape.fields[name] as Shape, value[name] ?? null, depth + 1));
    }
    case "list":
      return Array.isArray(value) && value.every((item) => mayBe(budget, shape.items, item, depth + 1));
  }
}

/** The shape of a property that every value of an object shape has; "never" when no value has it; null when it may be absent. */
function fieldOf(shape: Shape, name: string): Shape | "never" | null {
  if (shape.t === "record") return Object.hasOwn(shape.fields, name) ? (shape.fields[name] as Shape) : "never";
  if (shape.t !== "schema") return null;
  const schema = shape.schema;
  const properties = isJsonObject(schema["properties"]) ? schema["properties"] : {};
  const declared = Object.hasOwn(properties, name) ? properties[name] : undefined;
  const required = Array.isArray(schema["required"]) && schema["required"].includes(name);
  if (!required) return declared === undefined && schema["additionalProperties"] === false ? "never" : null;
  const additional = schema["additionalProperties"];
  const sub = declared !== undefined ? declared : isJsonObject(additional) ? additional : undefined;
  if (!isJsonObject(sub)) return UNKNOWN_SHAPE;
  return { ...shape, schema: sub };
}

/** The values a shape can only take (its `const` or `enum`, those that fit or may fit its own schema), or null. */
function valueList(budget: Budget, shape: Shape): Json[] | null {
  if (shape.t !== "schema") return null;
  const schema = shape.schema;
  const listed = Object.hasOwn(schema, "const") ? [schema["const"] ?? null] : Array.isArray(schema["enum"]) ? schema["enum"] : null;
  if (listed === null) return null;
  return listed.filter((value) => {
    const problems = compareValidate(budget, shape.root, schema, value, shape.defs);
    return problems.length === 0 || undecided(problems);
  });
}

function sourceUnion(shape: Shape): { keyword: string; alternatives: unknown[] } | null {
  if (shape.t !== "schema") return null;
  for (const keyword of UNION_KEYWORDS) {
    const alternatives = shape.schema[keyword];
    if (Array.isArray(alternatives) && alternatives.length > 0) return { keyword, alternatives };
  }
  return null;
}

/** A source union: reported when every alternative of the source is certainly wrong for the destination. */
function compareSourceUnion(ctx: Context, shape: Shape & { t: "schema" }, alternatives: readonly unknown[], list: readonly Part[],
  path: string, depth: number): void {
  if (ctx.budget.alternatives + alternatives.length > MAX_ALTERNATIVES) {
    ctx.budget.alternatives = MAX_ALTERNATIVES;
    return;
  }
  ctx.budget.alternatives += alternatives.length;
  let first: AssignProblem | undefined;
  for (const alternative of alternatives) {
    if (!isJsonObject(alternative)) return;
    const sub = scratch(ctx, ctx.inAlternative);
    compareShape(sub, { ...shape, schema: alternative }, list, path, depth + 1);
    const found = sub.out[0];
    if (found === undefined) return;
    first ??= found;
  }
  if (first !== undefined) add(ctx, path, `none of its ${alternatives.length} alternatives fits: ${first.message}`);
}

function numberBound(part: JsonSchema, keyword: string): number | null {
  const value = part[keyword];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The range rows: S's own bounds against the destination's, when S has only the types the keywords apply to. */
function compareBounds(ctx: Context, schema: JsonSchema, types: readonly string[], part: JsonSchema, path: string): void {
  const own = (keyword: string): number | null => numberBound(schema, keyword);
  const theirs = (keyword: string): number | null => numberBound(part, keyword);
  const pairs: { lower: number | null; upper: number | null; ownLower: number | null; ownUpper: number | null; ownIsAtLeast: (n: number, bound: number) => string; ownIsAtMost: (n: number, bound: number) => string }[] = [];
  if (types.every((type) => type === "number" || type === "integer")) {
    pairs.push({ lower: theirs("minimum"), upper: theirs("maximum"), ownLower: own("minimum"), ownUpper: own("maximum"),
      ownIsAtLeast: (n, bound) => `is at least ${n}, but must be <= ${bound}`, ownIsAtMost: (n, bound) => `is at most ${n}, but must be >= ${bound}` });
  }
  if (types.every((type) => type === "string")) {
    pairs.push({ lower: theirs("minLength"), upper: theirs("maxLength"), ownLower: own("minLength"), ownUpper: own("maxLength"),
      ownIsAtLeast: (n, bound) => `has at least ${n} characters, but must be at most ${bound}`,
      ownIsAtMost: (n, bound) => `has at most ${n} characters, but must be at least ${bound}` });
  }
  if (types.every((type) => type === "array")) {
    pairs.push({ lower: theirs("minItems"), upper: theirs("maxItems"), ownLower: own("minItems"), ownUpper: own("maxItems"),
      ownIsAtLeast: (n, bound) => `has at least ${n} items, but must have at most ${bound}`,
      ownIsAtMost: (n, bound) => `has at most ${n} items, but must have at least ${bound}` });
  }
  for (const pair of pairs) {
    if (pair.ownLower !== null && pair.upper !== null && pair.ownLower > pair.upper) add(ctx, path, pair.ownIsAtLeast(pair.ownLower, pair.upper));
    if (pair.ownUpper !== null && pair.lower !== null && pair.ownUpper < pair.lower) add(ctx, path, pair.ownIsAtMost(pair.ownUpper, pair.lower));
  }
}

/** The items row: a source array that is never empty has an element of its item shape at index 0. */
function compareItems(ctx: Context, shape: Shape & { t: "schema" }, part: Part, path: string, depth: number): void {
  const minItems = shape.schema["minItems"];
  const items = shape.schema["items"];
  if (typeof minItems !== "number" || minItems < 1 || !isJsonObject(items)) return;
  const list = parts(inDocument(ctx, part.root), part.schema["items"]);
  if (list === null) return;
  compareShape(ctx, { ...shape, schema: items }, list, pathIndex(path, 0), depth + 1);
}

/** Compares the shape of a reference with a destination (every part of `list` applies) and reports what never fits. */
function compareShape(ctx: Context, source: Shape, list: readonly Part[], path: string, depth: number): void {
  if (depth > MAX_DEPTH) return;
  const shape = derefShape(source);
  if (shape.t === "unknown") return;
  if (shape.t === "schema") {
    const union = sourceUnion(shape);
    if (union !== null) {
      compareSourceUnion(ctx, shape, union.alternatives, list, path, depth);
      return;
    }
  }
  const types = shape.t === "record" ? ["object"] : shape.t === "list" ? ["array"] : schemaValueTypes(shape.schema);
  if (types === null || types.length === 0) return;
  for (const { schema: part } of list) {
    const allowed = schemaValueTypes(part);
    if (allowed !== null && !types.some((type) => mayAdmit(allowed, type))) {
      add(ctx, path, `is ${describeTypes(types)}, but expected ${describeTypes(allowed)}`);
      return;
    }
  }
  if (types.every((type) => type === "object")) {
    for (const part of list) compareObject(ctx, shape, part, path, depth);
  }
  if (shape.t === "schema") {
    for (const { schema: part } of list) compareBounds(ctx, shape.schema, types, part, path);
    if (types.every((type) => type === "array")) for (const part of list) compareItems(ctx, shape, part, path, depth);
  }
  if (!compareValueList(ctx, shape, list, path)) {
    for (const { schema: part } of list) checkAllowed(ctx, part, path, (value) => mayBe(ctx.budget, shape, value, depth + 1));
  }
  checkUnions(ctx, list, path, ctx.inAlternative, (sub, alternative) => {
    const alternativeParts = parts(sub, alternative);
    if (alternativeParts !== null) compareShape(sub, shape, alternativeParts, path, depth + 1);
  });
}

/** The source's own `const` / `enum`: reported when every listed value fails the destination. True when reported. */
function compareValueList(ctx: Context, shape: Shape, list: readonly Part[], path: string): boolean {
  const values = valueList(ctx.budget, shape);
  const first = list[0];
  if (values === null || values.length === 0 || first === undefined) return false;
  const there = inDocument(ctx, first.root);
  if (!values.every((value) => certainlyFails(there, value, first.schema))) return false;
  add(ctx, path, `can only be ${values.map(describe).join(", ")}, none of which fits`);
  return true;
}

function compareObject(ctx: Context, shape: Shape, destination: Part, path: string, depth: number): void {
  const part = destination.schema;
  const there = inDocument(ctx, destination.root);
  const required = Array.isArray(part["required"]) ? part["required"] : [];
  for (const name of required) {
    if (typeof name === "string" && fieldOf(shape, name) === "never") {
      add(ctx, pathProperty(path, name), `never has the required property ${JSON.stringify(name)}`);
    }
  }
  const properties = isJsonObject(part["properties"]) ? part["properties"] : {};
  for (const name of Object.keys(properties)) {
    const field = fieldOf(shape, name);
    if (field === null || field === "never") continue;
    const list = parts(there, properties[name]);
    if (list === null) continue;
    compareShape(ctx, field, list, pathProperty(path, name), depth + 1);
  }
  const additional = part["additionalProperties"];
  if (additional !== false && !isJsonObject(additional)) return;
  for (const name of alwaysPresent(shape)) {
    if (Object.hasOwn(properties, name)) continue;
    if (additional === false) {
      add(ctx, pathProperty(path, name), `always has the property ${JSON.stringify(name)}, which is not allowed`);
      continue;
    }
    const field = fieldOf(shape, name);
    if (field === null || field === "never") continue;
    const list = parts(there, additional);
    if (list === null) continue;
    compareShape(ctx, field, list, pathProperty(path, name), depth + 1);
  }
}

/** The property names every value of an object shape has. */
function alwaysPresent(shape: Shape): string[] {
  if (shape.t === "record") return Object.keys(shape.fields);
  if (shape.t !== "schema" || !Array.isArray(shape.schema["required"])) return [];
  return shape.schema["required"].filter((name): name is string => typeof name === "string");
}

/** What can be proved wrong about `expr` flowing into `schema` (Rule P). Empty when nothing can be proved. */
export function checkAssignable(input: AssignInput): AssignProblem[] {
  const ctx: Context = {
    root: input.root, definitions: input.definitions, refOf: input.refOf, out: [], seen: new Set(),
    budget: { alternatives: 0, evaluations: { remaining: MAX_COMPARISON_EVALUATIONS } }, inAlternative: false,
  };
  checkExpr(ctx, input.expr, input.path, input.schema, 0);
  return ctx.out;
}
