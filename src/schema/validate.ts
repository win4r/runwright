import { isJsonObject, type JsonObject } from "../core/json.ts";

export type JsonSchema = JsonObject;
export interface SchemaProblem { path: string; keyword: string; message: string }
export interface SchemaOptions { definitions?: Readonly<Record<string, JsonSchema>>; maxProblems?: number }

const DEFAULT_MAX_PROBLEMS = 50;
const MAX_REF_DEPTH = 64;
const TYPE_NAMES = ["null", "boolean", "integer", "number", "string", "array", "object"] as const;

const ANNOTATION_KEYWORDS = new Set(["title", "description", "default", "examples", "$schema", "$id", "$defs", "definitions"]);
const VALIDATION_KEYWORDS = new Set([
  "type", "properties", "required", "additionalProperties", "items", "enum", "const", "minimum", "maximum",
  "minLength", "maxLength", "minItems", "maxItems", "pattern", "anyOf", "oneOf", "$ref",
]);

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Appends a property segment to a JSON path ("$.a", or `$["a b"]` for non-identifiers). */
export function pathProperty(path: string, key: string): string {
  return IDENTIFIER.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

/** Appends an array index segment to a JSON path. */
export function pathIndex(path: string, index: number): string {
  return `${path}[${index}]`;
}

const regexCache = new Map<string, RegExp | null>();

function compilePattern(pattern: string): RegExp | null {
  if (regexCache.has(pattern)) return regexCache.get(pattern) ?? null;
  let compiled: RegExp | null;
  try {
    compiled = new RegExp(pattern, "u");
  } catch {
    compiled = null;
  }
  if (regexCache.size > 500) regexCache.clear();
  regexCache.set(pattern, compiled);
  return compiled;
}

/**
 * Looks up a local `$ref`. "#/$defs/N" and "#/definitions/N" are searched in the root schema, then in
 * `definitions`; "#/schemas/N" only in `definitions`. Returns null when it cannot be resolved.
 *
 * The reference-root rule: a local reference is resolved against the schema document it is written in.
 * `#/$defs/N` and `#/definitions/N` look first in the `$defs` / `definitions` of that document and then among the
 * workflow's named schemas; `#/schemas/N` names a workflow schema. Following a reference that lands on a named
 * schema makes that named schema the document for the references inside it (`resolveSchemaRefIn`).
 */
export function resolveSchemaRef(
  ref: string,
  root: JsonSchema,
  definitions: Readonly<Record<string, JsonSchema>> | undefined,
): JsonSchema | null {
  const match = /^#\/(\$defs|definitions|schemas)\/([^/]+)$/.exec(ref);
  if (match === null) return null;
  const section = match[1] as "$defs" | "definitions" | "schemas";
  const name = decodePointerSegment(match[2] ?? "");
  if (section !== "schemas") {
    const container = root[section];
    if (isJsonObject(container) && Object.hasOwn(container, name)) {
      const found = container[name];
      if (isJsonObject(found)) return found;
    }
  }
  if (definitions !== undefined && Object.hasOwn(definitions, name)) {
    const found = definitions[name];
    if (found !== undefined && isJsonObject(found)) return found;
  }
  return null;
}

/** `resolveSchemaRef` plus the document the target's own references resolve in (`root`, or the target itself
 *  when it was found among `definitions`). */
export function resolveSchemaRefIn(
  ref: string, root: JsonSchema, definitions: Readonly<Record<string, JsonSchema>> | undefined,
): { schema: JsonSchema; root: JsonSchema } | null {
  const match = /^#\/(\$defs|definitions|schemas)\/([^/]+)$/.exec(ref);
  if (match === null) return null;
  const section = match[1] as "$defs" | "definitions" | "schemas";
  const name = decodePointerSegment(match[2] ?? "");
  if (section !== "schemas") {
    const container = root[section];
    if (isJsonObject(container) && Object.hasOwn(container, name)) {
      const found = container[name];
      if (isJsonObject(found)) return { schema: found, root };
    }
  }
  if (definitions !== undefined && Object.hasOwn(definitions, name)) {
    const found = definitions[name];
    if (found !== undefined && isJsonObject(found)) return { schema: found, root: found };
  }
  return null;
}

function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "null": return value === null;
    case "boolean": return typeof value === "boolean";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "string": return typeof value === "string";
    case "array": return Array.isArray(value);
    case "object": return isJsonObject(value);
    default: return false;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (Array.isArray(b)) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra);
  const kb = Object.keys(rb);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.hasOwn(rb, k) && deepEqual(ra[k], rb[k]));
}

function describe(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) return String(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function codePointLength(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0xdc00 || unit > 0xdfff || i === 0 || text.charCodeAt(i - 1) < 0xd800 || text.charCodeAt(i - 1) > 0xdbff) count++;
  }
  return count;
}

/** The most schema-node evaluations one validation call makes, across every branch at every depth. */
export const MAX_SCHEMA_EVALUATIONS = 100_000;

const CYCLE_MESSAGE = "reference cycle without progress";
const LIMIT_PROBLEM: SchemaProblem = Object.freeze({
  path: "$",
  keyword: "limit",
  message: `validation stopped: the schema needed more than ${MAX_SCHEMA_EVALUATIONS} evaluations`,
});

/** State shared by one validation call: the main collector and every anyOf / oneOf probe. */
interface ValidationState {
  definitions: Readonly<Record<string, JsonSchema>> | undefined;
  /** Evaluations left; the call stops everywhere when it reaches 0. */
  remaining: number;
  stopped: boolean;
  /** The (schema document, schema node, value path) triples being evaluated right now. */
  active: Map<object, Map<object, Set<string>>>;
  /** Paths where a reference cycle without progress was entered, in the order found. */
  cycles: Set<string>;
}

class Collector {
  readonly problems: SchemaProblem[] = [];
  readonly max: number;
  readonly state: ValidationState;
  constructor(max: number, state: ValidationState) {
    this.max = max;
    this.state = state;
  }
  get full(): boolean {
    return this.state.stopped || this.problems.length >= this.max;
  }
  add(path: string, keyword: string, message: string): void {
    if (!this.full) this.problems.push({ path, keyword, message });
  }
}

/** Accounts for one evaluation; false when the call's budget is spent (the call then stops everywhere). */
function spendEvaluation(state: ValidationState): boolean {
  if (state.stopped) return false;
  if (state.remaining <= 0) {
    state.stopped = true;
    return false;
  }
  state.remaining--;
  return true;
}

/**
 * Validates `value` against `schema`, a node of the schema document `root` (the document its local references
 * resolve in).
 */
function validateNode(schema: unknown, value: unknown, path: string, out: Collector, refDepth: number, root: JsonSchema): void {
  if (out.full) return;
  if (!spendEvaluation(out.state)) return;
  if (schema === true) return;
  if (schema === false) {
    out.add(path, "false", "no value is allowed here");
    return;
  }
  if (!isJsonObject(schema)) return;

  let byNode = out.state.active.get(root);
  if (byNode === undefined) {
    byNode = new Map();
    out.state.active.set(root, byNode);
  }
  let paths = byNode.get(schema);
  if (paths?.has(path) === true) {
    out.state.cycles.add(path);
    out.add(path, "$ref", CYCLE_MESSAGE);
    return;
  }
  if (paths === undefined) {
    paths = new Set();
    byNode.set(schema, paths);
  }
  paths.add(path);
  try {
    validateKeywords(schema, value, path, out, refDepth, root);
  } finally {
    paths.delete(path);
    if (paths.size === 0) byNode.delete(schema);
    if (byNode.size === 0) out.state.active.delete(root);
  }
}

function validateKeywords(schema: JsonObject, value: unknown, path: string, out: Collector, refDepth: number, root: JsonSchema): void {
  const state = out.state;
  const ref = schema["$ref"];
  if (typeof ref === "string") {
    if (refDepth >= MAX_REF_DEPTH) {
      out.add(path, "$ref", `reference depth exceeds ${MAX_REF_DEPTH}`);
      return;
    }
    const target = resolveSchemaRefIn(ref, root, state.definitions);
    if (target === null) out.add(path, "$ref", `cannot resolve reference ${JSON.stringify(ref)}`);
    else validateNode(target.schema, value, path, out, refDepth + 1, target.root);
  }
  const type = schema["type"];
  if (typeof type === "string" || Array.isArray(type)) {
    const types = (Array.isArray(type) ? type : [type]).filter((t): t is string => typeof t === "string");
    if (!types.some((t) => matchesType(value, t))) {
      out.add(path, "type", `expected ${types.join(" or ")}, got ${typeOf(value)}`);
    }
  }

  if (Object.hasOwn(schema, "const") && !deepEqual(value, schema["const"])) {
    out.add(path, "const", `must equal ${describe(schema["const"])}`);
  }
  const enumValues = schema["enum"];
  if (Array.isArray(enumValues) && !enumValues.some((candidate) => deepEqual(value, candidate))) {
    out.add(path, "enum", `must be one of ${enumValues.map(describe).join(", ")}`);
  }

  if (typeof value === "number") {
    const minimum = schema["minimum"];
    if (typeof minimum === "number" && value < minimum) out.add(path, "minimum", `must be >= ${minimum}, got ${value}`);
    const maximum = schema["maximum"];
    if (typeof maximum === "number" && value > maximum) out.add(path, "maximum", `must be <= ${maximum}, got ${value}`);
  }

  if (typeof value === "string") {
    const minLength = schema["minLength"];
    const maxLength = schema["maxLength"];
    if (typeof minLength === "number" || typeof maxLength === "number") {
      const length = codePointLength(value);
      if (typeof minLength === "number" && length < minLength) {
        out.add(path, "minLength", `must be at least ${minLength} characters, got ${length}`);
      }
      if (typeof maxLength === "number" && length > maxLength) {
        out.add(path, "maxLength", `must be at most ${maxLength} characters, got ${length}`);
      }
    }
    const pattern = schema["pattern"];
    if (typeof pattern === "string") {
      const regex = compilePattern(pattern);
      if (regex === null) out.add(path, "pattern", `schema pattern ${JSON.stringify(pattern)} is not a valid regular expression`);
      else if (!regex.test(value)) out.add(path, "pattern", `must match pattern ${JSON.stringify(pattern)}`);
    }
  }

  if (Array.isArray(value)) {
    const minItems = schema["minItems"];
    if (typeof minItems === "number" && value.length < minItems) {
      out.add(path, "minItems", `must have at least ${minItems} items, got ${value.length}`);
    }
    const maxItems = schema["maxItems"];
    if (typeof maxItems === "number" && value.length > maxItems) {
      out.add(path, "maxItems", `must have at most ${maxItems} items, got ${value.length}`);
    }
    const items = schema["items"];
    if (items !== undefined) {
      for (let i = 0; i < value.length && !out.full; i++) validateNode(items, value[i], pathIndex(path, i), out, refDepth, root);
    }
  }

  if (isJsonObject(value)) {
    const properties = isJsonObject(schema["properties"]) ? schema["properties"] : null;
    const required = schema["required"];
    if (Array.isArray(required)) {
      for (const name of required) {
        if (typeof name === "string" && !Object.hasOwn(value, name)) {
          out.add(pathProperty(path, name), "required", `missing required property ${JSON.stringify(name)}`);
        }
      }
    }
    const additional = schema["additionalProperties"];
    for (const key of Object.keys(value)) {
      if (out.full) break;
      const childPath = pathProperty(path, key);
      if (properties !== null && Object.hasOwn(properties, key)) {
        validateNode(properties[key], value[key], childPath, out, refDepth, root);
      } else if (additional === false) {
        out.add(childPath, "additionalProperties", `property ${JSON.stringify(key)} is not allowed`);
      } else if (isJsonObject(additional)) {
        validateNode(additional, value[key], childPath, out, refDepth, root);
      }
    }
  }

  const anyOf = schema["anyOf"];
  if (Array.isArray(anyOf) && anyOf.length > 0) {
    const matched = countMatches(anyOf, value, path, out.state, refDepth, 1, root);
    if (matched === 0 && !state.stopped) out.add(path, "anyOf", `must match at least one of ${anyOf.length} schemas (anyOf), matched 0`);
  }
  const oneOf = schema["oneOf"];
  if (Array.isArray(oneOf) && oneOf.length > 0) {
    const matched = countMatches(oneOf, value, path, out.state, refDepth, 2, root);
    if (matched !== 1 && !state.stopped) {
      const count = matched === 0 ? "0" : "more than one";
      out.add(path, "oneOf", `must match exactly one of ${oneOf.length} schemas (oneOf), matched ${count}`);
    }
  }
}

/** How many of `schemas` the value matches, counting up to `enough` (later branches are not evaluated). */
function countMatches(
  schemas: readonly unknown[], value: unknown, path: string, state: ValidationState, refDepth: number, enough: number, root: JsonSchema,
): number {
  let matched = 0;
  for (const candidate of schemas) {
    if (matched >= enough || state.stopped) break;
    const sub = new Collector(1, state);
    validateNode(candidate, value, path, sub, refDepth, root);
    if (sub.problems.length === 0 && !state.stopped) matched++;
  }
  return matched;
}

function runValidation(root: JsonSchema, schema: unknown, value: unknown, options: SchemaOptions | undefined, budget: number): {
  problems: SchemaProblem[]; used: number;
} {
  const state: ValidationState = {
    definitions: options?.definitions,
    remaining: budget,
    stopped: false,
    active: new Map(),
    cycles: new Set(),
  };
  const out = new Collector(options?.maxProblems ?? DEFAULT_MAX_PROBLEMS, state);
  validateNode(schema, value, "$", out, 0, root);
  const problems = out.problems;
  for (const path of state.cycles) {
    if (problems.length >= out.max) break;
    if (!problems.some((p) => p.path === path && p.keyword === "$ref" && p.message === CYCLE_MESSAGE)) {
      problems.push({ path, keyword: "$ref", message: CYCLE_MESSAGE });
    }
  }
  if (state.stopped) problems.push({ ...LIMIT_PROBLEM });
  return { problems, used: budget - state.remaining };
}

export function validateSchema(schema: JsonSchema, value: unknown, options?: SchemaOptions): SchemaProblem[] {
  return runValidation(schema, schema, value, options, MAX_SCHEMA_EVALUATIONS).problems;
}

/** validateSchema for a subschema of `root`: "#/$defs/N" and "#/definitions/N" are looked up in `root` (then in options.definitions). */
export function validateSubschema(root: JsonSchema, schema: unknown, value: unknown, options?: SchemaOptions): SchemaProblem[] {
  return runValidation(root, schema, value, options, MAX_SCHEMA_EVALUATIONS).problems;
}

/** Evaluations a caller shares across many validation calls (the placeholder generator, for one placeholder). */
export interface EvaluationBudget { remaining: number }

/**
 * validateSubschema with at most min(MAX_SCHEMA_EVALUATIONS, budget.remaining) evaluations; what the call used is
 * taken from `budget`. When the evaluations run out the result holds the "limit" problem, as validateSubschema's.
 */
export function validateSubschemaWithin(
  root: JsonSchema, schema: unknown, value: unknown, options: SchemaOptions | undefined, budget: EvaluationBudget,
): SchemaProblem[] {
  const allowed = Math.max(0, Math.min(MAX_SCHEMA_EVALUATIONS, Math.floor(budget.remaining)));
  const result = runValidation(root, schema, value, options, allowed);
  budget.remaining = Math.max(0, budget.remaining - result.used);
  return result.problems;
}

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** The problems of one checkSchema call, up to `max`. */
class ProblemList {
  readonly problems: SchemaProblem[] = [];
  readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  get full(): boolean {
    return this.problems.length >= this.max;
  }
  add(path: string, keyword: string, message: string): void {
    if (!this.full) this.problems.push({ path, keyword, message });
  }
}

interface CheckScope {
  root: JsonSchema;
  definitions: Readonly<Record<string, JsonSchema>> | undefined;
  /** The document path of every schema object the check visited. */
  paths: Map<JsonObject, string>;
}

function checkNode(schema: unknown, path: string, scope: CheckScope, out: ProblemList): void {
  if (out.full) return;
  if (!isJsonObject(schema)) {
    out.add(path, "schema", "a schema must be an object");
    return;
  }
  if (scope.paths.has(schema)) return;
  scope.paths.set(schema, path);
  for (const [keyword, value] of Object.entries(schema)) {
    if (out.full) return;
    const at = pathProperty(path, keyword);
    if (!VALIDATION_KEYWORDS.has(keyword) && !ANNOTATION_KEYWORDS.has(keyword)) {
      out.add(at, keyword, `unsupported keyword ${JSON.stringify(keyword)}`);
      continue;
    }
    switch (keyword) {
      case "type": {
        const list = Array.isArray(value) ? value : [value];
        const ok = list.length > 0 && list.every((t) => typeof t === "string" && (TYPE_NAMES as readonly string[]).includes(t));
        if (!ok) out.add(at, keyword, `"type" must be one of ${TYPE_NAMES.join(", ")} or a non-empty array of them`);
        break;
      }
      case "properties":
      case "$defs":
      case "definitions":
        if (!isJsonObject(value)) out.add(at, keyword, `"${keyword}" must be an object of schemas`);
        else for (const [name, sub] of Object.entries(value)) checkNode(sub, pathProperty(at, name), scope, out);
        break;
      case "required":
        if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
          out.add(at, keyword, `"required" must be an array of strings`);
        }
        break;
      case "additionalProperties":
        if (typeof value !== "boolean") checkNode(value, at, scope, out);
        break;
      case "items":
        checkNode(value, at, scope, out);
        break;
      case "enum":
        if (!Array.isArray(value)) out.add(at, keyword, `"enum" must be an array`);
        break;
      case "minimum":
      case "maximum":
        if (typeof value !== "number") out.add(at, keyword, `"${keyword}" must be a number`);
        break;
      case "minLength":
      case "maxLength":
      case "minItems":
      case "maxItems":
        if (!isNonNegativeInteger(value)) out.add(at, keyword, `"${keyword}" must be a non-negative integer`);
        break;
      case "pattern":
        if (typeof value !== "string") out.add(at, keyword, `"pattern" must be a string`);
        else if (compilePattern(value) === null) out.add(at, keyword, `"pattern" is not a valid regular expression`);
        break;
      case "anyOf":
      case "oneOf":
        if (!Array.isArray(value) || value.length === 0) out.add(at, keyword, `"${keyword}" must be a non-empty array of schemas`);
        else value.forEach((sub, i) => checkNode(sub, pathIndex(at, i), scope, out));
        break;
      case "$ref":
        if (typeof value !== "string") out.add(at, keyword, `"$ref" must be a string`);
        else if (resolveSchemaRefIn(value, scope.root, scope.definitions) === null) {
          out.add(at, keyword, `cannot resolve reference ${JSON.stringify(value)}`);
        }
        break;
      case "title":
      case "description":
      case "$schema":
      case "$id":
        if (typeof value !== "string") out.add(at, keyword, `"${keyword}" must be a string`);
        break;
      case "examples":
        if (!Array.isArray(value)) out.add(at, keyword, `"examples" must be an array`);
        break;
      default:
        break;
    }
  }
}

/**
 * One step of the cycle walk: a schema node, the schema document its references resolve in, where it is, and the
 * `$ref` that led to it (null for a member).
 */
interface WalkStep { node: JsonObject; root: JsonSchema; path: string; ref: string | null }

/** A node on the walk's stack, with the steps leading out of it and how many of them were taken. */
interface WalkFrame { step: WalkStep; next: WalkStep[]; taken: number }

/** The steps out of a node: its `$ref` target (when it resolves), then its `anyOf` and `oneOf` members. */
function stepsFrom(step: WalkStep, scope: CheckScope): WalkStep[] {
  const next: WalkStep[] = [];
  const ref = step.node["$ref"];
  if (typeof ref === "string") {
    const target = resolveSchemaRefIn(ref, step.root, scope.definitions);
    if (target !== null) next.push({ node: target.schema, root: target.root, path: pathProperty(step.path, "$ref"), ref });
  }
  for (const keyword of ["anyOf", "oneOf"]) {
    const members = step.node[keyword];
    if (!Array.isArray(members)) continue;
    members.forEach((member, i) => {
      if (isJsonObject(member)) next.push({ node: member, root: step.root, path: pathIndex(pathProperty(step.path, keyword), i), ref: null });
    });
  }
  return next;
}

/**
 * Reports every reference cycle that consumes no input: a path from a schema node back to itself through
 * `$ref` targets and `anyOf` / `oneOf` members only, once per node the cycle returns to, at the `$ref` that
 * closes it. Each node is explored once (on-stack and finished sets) with an explicit stack, so the walk is
 * linear in the number of nodes and references and does not recurse, whatever the schema's shape.
 */
function checkCycles(scope: CheckScope, out: ProblemList): void {
  const finished = new Set<object>();
  const onStack = new Map<object, number>();
  const reported = new Set<object>();
  const frames: WalkFrame[] = [];
  const enter = (step: WalkStep): void => {
    onStack.set(step.node, frames.length);
    frames.push({ step, next: stepsFrom(step, scope), taken: 0 });
  };

  for (const [node, path] of scope.paths) {
    if (out.full) return;
    if (finished.has(node)) continue;
    enter({ node, root: scope.root, path, ref: null });
    while (frames.length > 0 && !out.full) {
      const frame = frames[frames.length - 1] as WalkFrame;
      const edge = frame.next[frame.taken++];
      if (edge === undefined) {
        frames.pop();
        onStack.delete(frame.step.node);
        finished.add(frame.step.node);
        continue;
      }
      const at = onStack.get(edge.node);
      if (at !== undefined) {
        if (edge.ref === null || reported.has(edge.node)) continue;
        reported.add(edge.node);
        const refs = frames.slice(at + 1).map((f) => f.step.ref).filter((r): r is string => r !== null);
        out.add(edge.path, "$ref", `${CYCLE_MESSAGE}: ${[edge.ref, ...refs, edge.ref].join(" -> ")}`);
        continue;
      }
      if (finished.has(edge.node)) continue;
      enter({ node: edge.node, root: edge.root, path: scope.paths.get(edge.node) ?? edge.path, ref: edge.ref });
    }
  }
}

export function checkSchema(schema: unknown, options?: SchemaOptions): SchemaProblem[] {
  const out = new ProblemList(options?.maxProblems ?? DEFAULT_MAX_PROBLEMS);
  const root = isJsonObject(schema) ? schema : {};
  const scope: CheckScope = { root, definitions: options?.definitions, paths: new Map() };
  checkNode(schema, "$", scope, out);
  checkCycles(scope, out);
  return out.problems;
}
