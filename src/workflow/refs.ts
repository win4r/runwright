import { canonicalJson, isJsonObject, type Json, type JsonObject } from "../core/json.ts";
import { RunwrightError, isRunwrightError } from "../core/errors.ts";
import { pathIndex, pathProperty } from "../schema/validate.ts";
import type { Condition, Expr } from "./types.ts";

/**
 * Values a workflow expression can reference. Roots: `input`, `steps.<nodeId>`, `vars.<name>`,
 * `loop.<loopId>.index|last`, `run.id|agentId` and (only inside `lowConfidence.value`) `fallback`.
 */
export interface RefScope {
  input: Json;
  steps: { [nodeId: string]: Json };
  vars: { [name: string]: Json };
  loop: { [loopId: string]: { index: number; last: Json } };
  run: { id: string; agentId: string };
  fallback?: Json;
}

const REF_ROOTS: readonly string[] = Object.freeze(["input", "steps", "vars", "loop", "run", "fallback"]);
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const IDENTIFIER_SEGMENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const INDEX_SEGMENT = /^(?:0|[1-9][0-9]*)$/;

function invalidPath(path: string, reason: string): RunwrightError {
  return new RunwrightError("workflow_invalid", `invalid reference ${JSON.stringify(path)}: ${reason}`, {
    details: { path, reason },
  });
}

/** Splits a reference path into segments (identifiers as strings, array indexes as numbers). */
export function parseRefPath(path: string): (string | number)[] {
  if (typeof path !== "string" || path.length === 0) throw invalidPath(String(path), "the path is empty");
  const segments: (string | number)[] = [];
  for (const raw of path.split(".")) {
    if (raw.length === 0) throw invalidPath(path, "a segment is empty");
    if (FORBIDDEN_SEGMENTS.has(raw)) throw invalidPath(path, `the segment ${JSON.stringify(raw)} is not allowed`);
    if (INDEX_SEGMENT.test(raw)) {
      const index = Number(raw);
      if (!Number.isSafeInteger(index)) throw invalidPath(path, `the index ${raw} is too large`);
      segments.push(index);
    } else if (IDENTIFIER_SEGMENT.test(raw)) {
      segments.push(raw);
    } else {
      throw invalidPath(path, `the segment ${JSON.stringify(raw)} is neither an identifier nor an array index`);
    }
  }
  const root = segments[0];
  if (typeof root !== "string" || !REF_ROOTS.includes(root)) {
    throw invalidPath(path, `the path must start with one of ${REF_ROOTS.join(", ")}`);
  }
  return segments;
}

/** True for plain JSON objects and for null-prototype records built by the executor. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return isJsonObject(value);
}

function unresolved(path: string, segment: string | number, index: number): RunwrightError {
  return new RunwrightError(
    "reference_unresolved",
    `reference ${JSON.stringify(path)} cannot be resolved: ${JSON.stringify(String(segment))} is missing`,
    { details: { path, missing: String(segment), at: index } },
  );
}

function setOwn(target: JsonObject, key: string, value: Json): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Deep copy of a JSON value that reads own enumerable properties only; non-JSON values become null. */
export function copyJson(value: unknown): Json {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((item: unknown) => copyJson(item));
  if (isRecord(value)) {
    const out: JsonObject = {};
    for (const key of Object.keys(value)) {
      const item = value[key];
      if (item !== undefined) setOwn(out, key, copyJson(item));
    }
    return out;
  }
  return null;
}

function lookup(segments: readonly (string | number)[], path: string, scope: RefScope): unknown {
  const root = segments[0] as string;
  let current: unknown;
  switch (root) {
    case "input": current = scope.input; break;
    case "steps": current = scope.steps; break;
    case "vars": current = scope.vars; break;
    case "loop": current = scope.loop; break;
    case "run": current = scope.run; break;
    default: current = Object.hasOwn(scope, "fallback") ? scope.fallback : undefined; break;
  }
  if (current === undefined) throw unresolved(path, root, 0);
  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i] as string | number;
    let next: unknown;
    if (Array.isArray(current)) {
      next = typeof segment === "number" && segment < current.length ? current[segment] : undefined;
    } else if (isRecord(current)) {
      const key = String(segment);
      next = Object.hasOwn(current, key) ? current[key] : undefined;
    } else {
      next = undefined;
    }
    if (next === undefined || typeof next === "function") throw unresolved(path, segment, i);
    current = next;
  }
  return current;
}

/** Resolves a reference path against the scope (own properties only). Throws `reference_unresolved`. */
export function resolveRef(path: string, scope: RefScope): Json {
  const segments = parseRefPath(path);
  return copyJson(lookup(segments, path, scope));
}

/** Classifies an object that uses `$ref` or `$literal`; returns null for an ordinary object. */
export function refForm(value: JsonObject): { kind: "ref"; path: string; fallback: Json | undefined } | { kind: "literal"; value: Json } | { kind: "malformed"; message: string } | null {
  const keys = Object.keys(value);
  if (Object.hasOwn(value, "$ref")) {
    const ref = value["$ref"];
    if (typeof ref !== "string") return { kind: "malformed", message: "\"$ref\" must be a string path" };
    if (!keys.every((key) => key === "$ref" || key === "default")) {
      return { kind: "malformed", message: "a $ref object may only have the keys \"$ref\" and \"default\"" };
    }
    return { kind: "ref", path: ref, fallback: Object.hasOwn(value, "default") ? value["default"] : undefined };
  }
  if (Object.hasOwn(value, "$literal")) {
    if (keys.length !== 1) return { kind: "malformed", message: "a $literal object may only have the key \"$literal\"" };
    return { kind: "literal", value: value["$literal"] ?? null };
  }
  return null;
}

/** Options of `resolveValue`, `renderTemplate` and `evalCondition`. Without them a reference that cannot be resolved throws. */
export interface ResolveOptions {
  /** Called for a reference that cannot be resolved and has no default. A returned value is used in its place; undefined rethrows the error. */
  onUnresolved?: (path: string, error: RunwrightError) => Json | undefined;
}

/** `resolveRef`, handing a `reference_unresolved` error to `options.onUnresolved` (a reference without default). */
function resolveRefWith(path: string, scope: RefScope, options: ResolveOptions | undefined): Json {
  try {
    return resolveRef(path, scope);
  } catch (error) {
    const hook = options?.onUnresolved;
    if (hook !== undefined && isRunwrightError(error) && error.code === "reference_unresolved") {
      const replacement = hook(path, error);
      if (replacement !== undefined) return copyJson(replacement);
    }
    throw error;
  }
}

/** Deep copy of `expr` with every `$ref`, `$literal` and `{{ path }}` template substituted. */
export function resolveValue(expr: Expr, scope: RefScope, options?: ResolveOptions): Json {
  if (typeof expr === "string") return renderTemplate(expr, scope, options);
  if (Array.isArray(expr)) return expr.map((item) => resolveValue(item, scope, options));
  if (isRecord(expr)) {
    const form = refForm(expr);
    if (form !== null) {
      switch (form.kind) {
        case "literal":
          return copyJson(form.value);
        case "malformed":
          throw new RunwrightError("workflow_invalid", form.message);
        case "ref":
          if (form.fallback === undefined) return resolveRefWith(form.path, scope, options);
          try {
            return resolveRef(form.path, scope);
          } catch (error) {
            if (isRunwrightError(error) && error.code === "reference_unresolved") return copyJson(form.fallback);
            throw error;
          }
      }
    }
    const out: JsonObject = {};
    for (const key of Object.keys(expr)) setOwn(out, key, resolveValue(expr[key] ?? null, scope, options));
    return out;
  }
  return expr;
}

/** The one message for a `tool` node's `args` given as a reference or literal form instead of a map (validator and resolver). */
export const ARGS_MAP_MESSAGE = "`args` must be an object of argument expressions, not a reference or a literal form";

/**
 * Resolves a `tool` node's `args`, a map from argument name to expression: each own argument on its own, into an
 * object where every name, `__proto__` and `constructor` included, is an own property. Throws `workflow_invalid`
 * when `args` is not such a map (not a plain object, or a `$ref` or `$literal` form in place of the map).
 */
export function resolveArgs(args: unknown, scope: RefScope, options?: ResolveOptions): JsonObject {
  if (!isJsonObject(args) || refForm(args) !== null) throw new RunwrightError("workflow_invalid", ARGS_MAP_MESSAGE);
  const out: JsonObject = {};
  for (const name of Object.keys(args)) setOwn(out, name, resolveValue(args[name] ?? null, scope, options));
  return out;
}

export interface TemplatePart { kind: "text" | "ref"; text: string; offset: number }

/** Splits a template into literal text and `{{ path }}` parts. A `{{` with no closing `}}` is text. */
export function templateParts(template: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let position = 0;
  while (position < template.length) {
    const open = template.indexOf("{{", position);
    if (open < 0) break;
    const close = template.indexOf("}}", open + 2);
    if (close < 0) break;
    if (open > position) parts.push({ kind: "text", text: template.slice(position, open), offset: position });
    parts.push({ kind: "ref", text: template.slice(open + 2, close).trim(), offset: open });
    position = close + 2;
  }
  if (position < template.length) parts.push({ kind: "text", text: template.slice(position), offset: position });
  return parts;
}

/** Replaces each `{{ path }}`: strings as they are, other values as canonical JSON. No evaluation of any kind. */
export function renderTemplate(template: string, scope: RefScope, options?: ResolveOptions): string {
  let out = "";
  for (const part of templateParts(template)) {
    if (part.kind === "text") {
      out += part.text;
      continue;
    }
    const value = resolveRefWith(part.text, scope, options);
    out += typeof value === "string" ? value : canonicalJson(value);
  }
  return out;
}

const CONDITION_KEYS = ["eq", "ne", "gt", "gte", "lt", "lte", "and", "or", "not", "exists", "truthy"] as const;
export type ConditionOperator = (typeof CONDITION_KEYS)[number];

/** Returns the operator of a well-formed condition object, or null. */
export function conditionOperator(condition: unknown): ConditionOperator | null {
  if (!isRecord(condition)) return null;
  const keys = Object.keys(condition);
  if (keys.length !== 1) return null;
  const key = keys[0] as string;
  return (CONDITION_KEYS as readonly string[]).includes(key) ? (key as ConditionOperator) : null;
}

function badCondition(message: string): RunwrightError {
  return new RunwrightError("workflow_invalid", `invalid condition: ${message}`);
}

function operands(value: unknown, operator: string): [Expr, Expr] {
  if (!Array.isArray(value) || value.length !== 2) throw badCondition(`"${operator}" takes an array of two expressions`);
  return [value[0] as Expr, value[1] as Expr];
}

function compare(a: Json, b: Json, operator: "gt" | "gte" | "lt" | "lte"): boolean {
  const comparable = (typeof a === "number" && typeof b === "number") || (typeof a === "string" && typeof b === "string");
  if (!comparable) return false;
  switch (operator) {
    case "gt": return a > b;
    case "gte": return a >= b;
    case "lt": return a < b;
    case "lte": return a <= b;
  }
}

/**
 * Evaluates a condition. Operands are resolved with `resolveValue` (and `options`); there is no other evaluation.
 * `exists` never calls `options.onUnresolved`.
 */
export function evalCondition(condition: Condition, scope: RefScope, options?: ResolveOptions): boolean {
  const operator = conditionOperator(condition);
  if (operator === null) throw badCondition("expected an object with exactly one of " + CONDITION_KEYS.join(", "));
  const value = (condition as Record<string, unknown>)[operator];
  switch (operator) {
    case "eq":
    case "ne": {
      const [a, b] = operands(value, operator);
      const equal = canonicalJson(resolveValue(a, scope, options)) === canonicalJson(resolveValue(b, scope, options));
      return operator === "eq" ? equal : !equal;
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const [a, b] = operands(value, operator);
      return compare(resolveValue(a, scope, options), resolveValue(b, scope, options), operator);
    }
    case "and":
    case "or": {
      if (!Array.isArray(value)) throw badCondition(`"${operator}" takes an array of conditions`);
      const list = value as Condition[];
      return operator === "and" ? list.every((c) => evalCondition(c, scope, options)) : list.some((c) => evalCondition(c, scope, options));
    }
    case "not":
      return !evalCondition(value as Condition, scope, options);
    case "exists": {
      if (typeof value !== "string") throw badCondition("\"exists\" takes a reference path string");
      try {
        resolveRef(value, scope);
        return true;
      } catch (error) {
        if (isRunwrightError(error) && error.code === "reference_unresolved") return false;
        throw error;
      }
    }
    case "truthy":
      return Boolean(resolveValue(value as Expr, scope, options));
  }
}

/** Every `$ref` and every template path in `expr`, with the JSON path (inside `expr`) where it sits. */
export function listRefs(expr: Expr): { path: string; hasDefault: boolean; at: string }[] {
  const found: { path: string; hasDefault: boolean; at: string }[] = [];
  const visit = (value: Json, at: string): void => {
    if (typeof value === "string") {
      for (const part of templateParts(value)) if (part.kind === "ref") found.push({ path: part.text, hasDefault: false, at });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, pathIndex(at, index)));
      return;
    }
    if (!isRecord(value)) return;
    const form = refForm(value);
    if (form?.kind === "ref") {
      found.push({ path: form.path, hasDefault: form.fallback !== undefined, at });
      return;
    }
    if (form?.kind === "literal") return;
    for (const key of Object.keys(value)) visit(value[key] ?? null, pathProperty(at, key));
  };
  visit(expr, "$");
  return found;
}
