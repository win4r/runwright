/**
 * Pure helpers of the dry run: which values the walk made up ("fabricated" sources), whether an expression or a
 * condition depends on them, whether an unresolvable reference points inside a made-up value, whether a schema
 * problem found in a value built from made-up values is certain (a real run has it too) or depends on them, and
 * the static verdict of a condition (`conditionVerdict`, the one place that reasons about conditions statically).
 */
import { canonicalJson, isJsonObject, type Json } from "../core/json.ts";
import type { RunwrightError } from "../core/errors.ts";
import { validateSubschema, type SchemaProblem } from "../schema/validate.ts";
import { conditionOperator, evalCondition, listRefs, refForm, resolveValue, type RefScope } from "./refs.ts";
import type { Condition, Expr, WorkflowDocument } from "./types.ts";
import { derefShape, indexNodes, namedShape, nodeShape, walkShape, UNKNOWN_SHAPE, type Shape } from "./walk.ts";

/** A scope with no values: what a part without references is evaluated in (it reads nothing from it). */
const EMPTY_SCOPE: RefScope = { input: null, steps: {}, vars: {}, loop: {}, run: { id: "", agentId: "" } };

/** Which sources a reference can name hold values the walk made up. */
export interface FabricatedSources {
  /** `input` was made up (no input given, or a sub-workflow's input built from made-up values). */
  input: boolean;
  /** Node ids whose `steps.<id>` value is made up. */
  steps: Set<string>;
  /** Variable names whose `vars.<name>` value is made up. */
  vars: Set<string>;
  /** Loop ids whose `loop.<id>.last` value is made up. */
  loops: Set<string>;
  /** `fallback` (inside a decision's `lowConfidence.value`) is made up. */
  fallback: boolean;
}

export function emptySources(input: boolean): FabricatedSources {
  return { input, steps: new Set(), vars: new Set(), loops: new Set(), fallback: false };
}

/** An independent copy (iteration and sub-workflow frames copy the bookkeeping as they copy `steps`). */
export function copySources(sources: FabricatedSources): FabricatedSources {
  return { input: sources.input, steps: new Set(sources.steps), vars: new Set(sources.vars), loops: new Set(sources.loops), fallback: sources.fallback };
}

/**
 * The number of leading segments that name a fabricated source of the reference path (`input`: 1;
 * `steps.<id>`, `vars.<name>`: 2; `loop.<id>.last`: 3; `fallback`: 1), or null when the source is not fabricated.
 */
function fabricatedPrefix(path: string, sources: FabricatedSources): number | null {
  const segments = path.split(".");
  const name = segments[1];
  switch (segments[0]) {
    case "input":
      return sources.input ? 1 : null;
    case "steps":
      return name !== undefined && sources.steps.has(name) ? 2 : null;
    case "vars":
      return name !== undefined && sources.vars.has(name) ? 2 : null;
    case "loop":
      if (name === undefined || !sources.loops.has(name)) return null;
      return segments[2] === undefined || segments[2] === "last" ? 3 : null;
    case "fallback":
      return sources.fallback ? 1 : null;
    default:
      return null;
  }
}

/** True when the reference path names a fabricated source. */
function isRefFabricated(path: string, sources: FabricatedSources): boolean {
  return fabricatedPrefix(path, sources) !== null;
}

/** True when any `$ref` object (with or without default) or template path in the expression names a fabricated source. */
export function isExprFabricated(expr: Expr, sources: FabricatedSources): boolean {
  return listRefs(expr).some((ref) => isRefFabricated(ref.path, sources));
}

/** True when any operand of the condition (including the path of `exists`) names a fabricated source. */
export function isConditionFabricated(condition: Condition, sources: FabricatedSources): boolean {
  const operator = conditionOperator(condition);
  if (operator === null) return false;
  const value = (condition as Record<string, Json>)[operator] ?? null;
  switch (operator) {
    case "and":
    case "or":
      return Array.isArray(value) && value.some((c) => isConditionFabricated(c as Condition, sources));
    case "not":
      return isConditionFabricated(value as Condition, sources);
    case "exists":
      return typeof value === "string" && isRefFabricated(value, sources);
    default:
      return isExprFabricated(value, sources);
  }
}

/**
 * True when an unresolvable reference lies inside a fabricated source's value: the reference names a fabricated
 * source and the missing segment (`error.details.at`) is at or beyond the source's own prefix.
 */
export function unresolvedInsideFabricated(path: string, error: RunwrightError, sources: FabricatedSources): boolean {
  const prefix = fabricatedPrefix(path, sources);
  const at = error.details?.["at"];
  return prefix !== null && typeof at === "number" && at >= prefix;
}

/** The segments of a validator problem path (`$`, then `.name`, `["json string"]` or `[index]`); the inverse of pathProperty/pathIndex. */
export function parseProblemPath(path: string): (string | number)[] {
  if (!path.startsWith("$")) throw new Error(`not a problem path: ${JSON.stringify(path)}`);
  const segments: (string | number)[] = [];
  let i = 1;
  while (i < path.length) {
    const c = path[i];
    if (c === ".") {
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(path.slice(i + 1));
      if (match === null) throw new Error(`bad property segment at ${i} in ${JSON.stringify(path)}`);
      segments.push(match[0]);
      i += 1 + match[0].length;
    } else if (c === "[" && path[i + 1] === "\"") {
      let j = i + 2;
      while (j < path.length && path[j] !== "\"") j += path[j] === "\\" ? 2 : 1;
      if (j >= path.length || path[j + 1] !== "]") throw new Error(`unterminated key at ${i} in ${JSON.stringify(path)}`);
      segments.push(JSON.parse(path.slice(i + 1, j + 1)) as string);
      i = j + 2;
    } else if (c === "[") {
      const match = /^\[(0|[1-9][0-9]*)\]/.exec(path.slice(i));
      if (match === null) throw new Error(`bad index segment at ${i} in ${JSON.stringify(path)}`);
      segments.push(Number(match[1]));
      i += match[0].length;
    } else {
      throw new Error(`unexpected ${JSON.stringify(c)} at ${i} in ${JSON.stringify(path)}`);
    }
  }
  return segments;
}

function valueAt(value: Json, segments: readonly (string | number)[]): Json | undefined {
  let current: Json | undefined = value;
  for (const segment of segments) {
    if (typeof segment === "number" && Array.isArray(current)) current = current[segment];
    else if (typeof segment === "string" && isJsonObject(current) && Object.hasOwn(current, segment)) current = current[segment];
    else return undefined;
  }
  return current;
}

function refSegment(raw: string): string | number {
  return /^(?:0|[1-9][0-9]*)$/.test(raw) ? Number(raw) : raw;
}

/** The static shape of what `path` (a reference) names, walked further along `rest`; unknown when it cannot be known. */
function referencedShape(path: string, rest: readonly (string | number)[], document: WorkflowDocument): Shape {
  const segments = path.split(".").map(refSegment);
  let base: Shape;
  let after: (string | number)[];
  if (segments[0] === "input") {
    base = namedShape(document.schemas, document.input);
    after = segments.slice(1);
  } else if (segments[0] === "steps" && typeof segments[1] === "string") {
    const index = indexNodes(document.root, "$.root");
    const entry = index.byId.get(segments[1]);
    if (entry === undefined) return UNKNOWN_SHAPE;
    base = nodeShape({ index, schemas: document.schemas }, entry);
    after = segments.slice(2);
  } else {
    return UNKNOWN_SHAPE;
  }
  const walked = walkShape(base, [...after, ...rest]);
  return walked.problem === null ? walked.shape : UNKNOWN_SHAPE;
}

/** The one JSON type a shape guarantees (other than "number"), or null. */
function pinnedType(shape: Shape): string | null {
  switch (shape.t) {
    case "record": return "object";
    case "list": return "array";
    case "unknown": return null;
    case "schema": {
      const type = shape.schema["type"];
      const single = typeof type === "string" ? type : Array.isArray(type) && type.length === 1 && typeof type[0] === "string" ? type[0] : null;
      return single === null || single === "number" ? null : single;
    }
  }
}

function hasJsonType(value: Json | undefined, type: string): boolean {
  switch (type) {
    case "null": return value === null;
    case "boolean": return typeof value === "boolean";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "string": return typeof value === "string";
    case "array": return Array.isArray(value);
    case "object": return isJsonObject(value);
    default: return false;
  }
}

/**
 * Whether a schema problem in `value` (built from `expression` of `document`) is certain, or depends on made-up
 * values:
 * 1. the subject is the problem's path, or for `required`/`additionalProperties` its parent object;
 * 2. the expression is walked along the subject through arrays and plain objects until a `$ref`, a `$literal`
 *    or a string is reached (the governing node; the unwalked segments are the rest);
 * 3. a `$literal` or a governing node that is not fabricated: certain; a fabricated template: certain for `type`;
 *    a fabricated plain object or array: certain for `type`, `required` and `additionalProperties`, and an array
 *    also for `minItems` and `maxItems` (the document fixes its length); a fabricated
 *    `$ref` (without default): certain for `type` when the referenced shape pins one type other than `number` and
 *    the value at the problem's path has that type, for `required` when the shape is a record without the
 *    property, for `additionalProperties` when it is a record with it. Everything else is dependent.
 * A fabricated `$ref` with a default is dependent for every keyword: a real run may read its default instead.
 */
export function classifyProblem(
  problem: SchemaProblem, value: Json, expression: Expr, sources: FabricatedSources, document: WorkflowDocument,
): "certain" | "dependent" {
  const segments = parseProblemPath(problem.path);
  const parentKeyword = problem.keyword === "required" || problem.keyword === "additionalProperties";
  const property = parentKeyword ? segments.at(-1) : undefined;
  const subject = parentKeyword ? segments.slice(0, -1) : segments;
  let node: Json = expression;
  let walked = 0;
  while (walked < subject.length) {
    if (typeof node === "string") break;
    if (isJsonObject(node) && refForm(node) !== null) break;
    const segment = subject[walked] as string | number;
    let next: Json | undefined;
    if (Array.isArray(node) && typeof segment === "number") next = node[segment];
    else if (isJsonObject(node) && typeof segment === "string" && Object.hasOwn(node, segment)) next = node[segment];
    if (next === undefined) break;
    node = next;
    walked++;
  }
  const rest = subject.slice(walked);
  const form = isJsonObject(node) ? refForm(node) : null;
  if (form?.kind === "literal" || !isExprFabricated(node, sources)) return "certain";
  if (typeof node === "string") return problem.keyword === "type" ? "certain" : "dependent";
  if (form === null) {
    const length = Array.isArray(node) && (problem.keyword === "minItems" || problem.keyword === "maxItems");
    const fixed = problem.keyword === "type" || parentKeyword || length;
    return fixed && rest.length === 0 ? "certain" : "dependent";
  }
  if (form.kind !== "ref" || form.fallback !== undefined) return "dependent";
  const shape = referencedShape(form.path, rest, document);
  switch (problem.keyword) {
    case "type": {
      const type = pinnedType(shape);
      return type !== null && hasJsonType(valueAt(value, segments), type) ? "certain" : "dependent";
    }
    case "required":
      return shape.t === "record" && !Object.hasOwn(shape.fields, String(property)) ? "certain" : "dependent";
    case "additionalProperties":
      return shape.t === "record" && Object.hasOwn(shape.fields, String(property)) ? "certain" : "dependent";
    default:
      return "dependent";
  }
}

/** True when the schema shape may hold `value`: it validates, or the outcome is not decided (an unresolved `$ref`, the evaluation limit). */
function admits(shape: Shape & { t: "schema" }, value: Json): boolean {
  const problems = validateSubschema(shape.root, shape.schema, value, { definitions: shape.defs, maxProblems: 1 });
  return problems.length === 0 || problems.some((p) => p.keyword === "$ref" || p.keyword === "limit");
}

/**
 * Every value a shape can hold when that set is finite and statically known, else null: after `derefShape`, a
 * `const`, an `enum`, a `type` of exactly "boolean" (true, false) or exactly "null"; the values its own schema
 * rules out are dropped (an enum combined with a `type`).
 */
export function finiteDomain(shape: Shape): Json[] | null {
  const resolved = derefShape(shape);
  if (resolved.t !== "schema") return null;
  const schema = resolved.schema;
  let values: Json[];
  if (Object.hasOwn(schema, "const")) values = [schema["const"] ?? null];
  else if (Array.isArray(schema["enum"])) values = schema["enum"];
  else if (schema["type"] === "boolean") values = [true, false];
  else if (schema["type"] === "null") values = [null];
  else return null;
  return values.filter((value) => admits(resolved, value));
}

/** True when some value of the shape can be `value` (an unknown or non-schema shape: yes). */
export function shapeMayBe(shape: Shape, value: Json): boolean {
  const resolved = derefShape(shape);
  return resolved.t !== "schema" || admits(resolved, value);
}

/** What a condition can be at run time: true in every run, false in every run, or not known statically. */
export type ConditionVerdict = "always" | "never" | "unknown";

/** The statically known shape of an expression's value (unknown for anything but a reference of known shape without a default). */
export type ShapeOf = (expr: Expr) => Shape;

/**
 * True when no part of the condition reads anything: no `$ref` and no template path in any operand, and no
 * `exists` anywhere (a malformed condition counts as reading nothing: evaluating it fails).
 */
export function conditionIsLiteral(condition: unknown): boolean {
  const operator = conditionOperator(condition);
  if (operator === null) return true;
  const operand = (condition as Record<string, Json>)[operator] ?? null;
  switch (operator) {
    case "and":
    case "or":
      return !Array.isArray(operand) || operand.every((part) => conditionIsLiteral(part));
    case "not":
      return conditionIsLiteral(operand);
    case "exists":
      return false;
    default:
      return listRefs(operand).length === 0;
  }
}

function negate(verdict: ConditionVerdict): ConditionVerdict {
  return verdict === "always" ? "never" : verdict === "never" ? "always" : "unknown";
}

/** The `$ref` form of an operand, or null. */
function refOperand(expr: Expr): { path: string; fallback: Json | undefined } | null {
  const form = isJsonObject(expr) ? refForm(expr) : null;
  return form?.kind === "ref" ? form : null;
}

/** The value of an operand without references, or undefined (it has one, or it is malformed). */
function literalOperand(expr: Expr): Json | undefined {
  if (listRefs(expr).length > 0) return undefined;
  try {
    return resolveValue(expr, EMPTY_SCOPE);
  } catch {
    return undefined;
  }
}

/** The verdict of `eq` (or, negated, `ne`) of two operands, at least one of which has a reference. */
function equalityVerdict(a: Expr, b: Expr, shapeOf: ShapeOf): ConditionVerdict {
  const refA = refOperand(a);
  const refB = refOperand(b);
  if (refA !== null && refB !== null && refA.fallback === undefined && refB.fallback === undefined && refA.path === refB.path) return "always";
  const literalA = literalOperand(a);
  const literalB = literalOperand(b);
  const literal = literalA !== undefined ? literalA : literalB;
  const reference = literalA !== undefined ? b : a;
  if (literal === undefined || refOperand(reference) === null) return "unknown";
  const shape = shapeOf(reference);
  if (!shapeMayBe(shape, literal)) return "never";
  const domain = finiteDomain(shape);
  if (domain === null || domain.length === 0) return "unknown";
  const key = canonicalJson(literal);
  const equal = domain.filter((value) => canonicalJson(value) === key).length;
  if (equal === domain.length) return "always";
  return equal === 0 ? "never" : "unknown";
}

/**
 * Whether `condition` holds in every run, in none, or is not known statically (rule V). A condition, or any part of
 * one, that reads nothing (`conditionIsLiteral`) has exactly the value `evalCondition` gives it at run time ("unknown"
 * when evaluating it fails: the validator reports a malformed condition). `and`, `or` and `not` combine the verdicts
 * of their parts by logic. `eq` and `ne` of the same reference (no default) on both sides are "always" and "never".
 * `eq` of a reference and a literal is "never" when the literal is not valid for the reference's shape (`shapeOf`)
 * and, when the shape has a finite domain (`finiteDomain`), "always" when every domain value equals the literal and
 * "never" when none does; `ne` is the opposite. `truthy` of a reference with a finite domain is "always" or "never"
 * when every or no domain value is truthy. Values are compared as canonical JSON, as `evalCondition` compares them.
 * Everything else is "unknown".
 */
export function conditionVerdict(condition: Condition, shapeOf: ShapeOf): ConditionVerdict {
  if (conditionIsLiteral(condition)) {
    try {
      return evalCondition(condition, EMPTY_SCOPE) ? "always" : "never";
    } catch {
      return "unknown";
    }
  }
  const operator = conditionOperator(condition);
  const operand = operator === null ? null : (condition as Record<string, Json>)[operator] ?? null;
  switch (operator) {
    case "and":
    case "or": {
      if (!Array.isArray(operand)) return "unknown";
      const parts = operand.map((part) => conditionVerdict(part as Condition, shapeOf));
      const [decisive, other] = operator === "and" ? ["never", "always"] as const : ["always", "never"] as const;
      if (parts.includes(decisive)) return decisive;
      return parts.every((verdict) => verdict === other) ? other : "unknown";
    }
    case "not":
      return negate(conditionVerdict(operand as Condition, shapeOf));
    case "eq":
    case "ne": {
      if (!Array.isArray(operand) || operand.length !== 2) return "unknown";
      const verdict = equalityVerdict(operand[0] as Expr, operand[1] as Expr, shapeOf);
      return operator === "eq" ? verdict : negate(verdict);
    }
    case "truthy": {
      if (refOperand(operand) === null) return "unknown";
      const domain = finiteDomain(shapeOf(operand));
      if (domain === null || domain.length === 0) return "unknown";
      const truthy = domain.filter((value) => Boolean(value)).length;
      if (truthy === domain.length) return "always";
      return truthy === 0 ? "never" : "unknown";
    }
    default:
      return "unknown";
  }
}
