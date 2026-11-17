/**
 * Placeholder values for JSON Schemas (used by the dry run and by the scripted model).
 *
 * For every schema node candidates are tried in a fixed order and the first one that validates against the node
 * is taken: `const`; `default`; each `examples` entry; each `enum` value; for `$ref`, the placeholder of the
 * node's other keywords together with the referenced schema, then of the referenced schema alone; for each
 * `anyOf` branch, then each `oneOf` branch, the placeholder of the node's other keywords together with the
 * branch, then of the branch alone; then by type, for each type the node allows in the order it lists them.
 * When nothing validates, the node gets its first by-type candidate (else the first candidate tried, else null).
 * A `$ref` is resolved by the reference-root rule of `resolveSchemaRef`: a reference that lands on a named schema
 * makes that schema the document the references inside it resolve in (its candidates and their checks included).
 * The result says whether the whole value validates against the schema; it never claims so when it does not.
 *
 * Limits: a generated string is at most 4 096 characters, a generated array at most 256 items, and one call
 * builds arrays with at most 100 000 values in all, a string counting one more per 64 characters (larger
 * minimums give a cut value, which does not validate);
 * nesting deeper than 64 gives null; after 5 000 visited schema nodes, or once the candidate checks of the call
 * have spent 1 000 000 schema evaluations in all, every further node takes its first by-type candidate without
 * trying others. The final check of the whole value is one ordinary validation (bounded on its own).
 */
import { isJsonObject, type Json, type JsonObject } from "../core/json.ts";
import { samplePattern } from "./pattern-sample.ts";
import {
  resolveSchemaRefIn, validateSubschema, validateSubschemaWithin, type EvaluationBudget, type JsonSchema, type SchemaOptions,
} from "./validate.ts";

const MAX_DEPTH = 64;
const MAX_STRING_LENGTH = 4096;
const MAX_ARRAY_ITEMS = 256;
const MAX_ARRAY_VALUES = 100_000;
const STRING_WEIGHT_CHARS = 64;
const MAX_VISITS = 5000;
/** Schema-node evaluations all candidate checks of one call may spend together. */
const MAX_CHECK_EVALUATIONS = 1_000_000;
/** How many values that satisfy a combined or referenced subschema are tried against the node around it. */
const MAX_ALTERNATIVES = 4;
const KNOWN_TYPES = new Set(["null", "boolean", "integer", "number", "string", "array", "object"]);

export interface PlaceholderResult {
  /** The placeholder. When `satisfied` is false it is the generator's best attempt and does not validate. */
  value: Json;
  /** True exactly when validateSchema(schema, value, options) reports no problem. */
  satisfied: boolean;
}

/** What one call counts, shared by every context of the call. */
interface Counts { visits: number; arrayValues: number }

interface Context {
  /** The schema document local references resolve in (the reference-root rule of `resolveSchemaRef`). */
  root: JsonSchema;
  options: SchemaOptions | undefined;
  checkOptions: SchemaOptions;
  counts: Counts;
  checks: EvaluationBudget;
}

/** The same call's context with `root` as the document for local references. */
function inDocument(ctx: Context, root: JsonSchema): Context {
  return root === ctx.root ? ctx : { ...ctx, root };
}

function setProperty(target: JsonObject, name: string, value: Json): void {
  Object.defineProperty(target, name, { value, enumerable: true, writable: true, configurable: true });
}

function cloneJson(value: Json): Json {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (value !== null && typeof value === "object") {
    const out: JsonObject = {};
    for (const [key, item] of Object.entries(value)) setProperty(out, key, cloneJson(item));
    return out;
  }
  return value;
}

/** The types the node allows, in its order; without "type": one inferred type, as the generator always did. */
function nodeTypes(schema: JsonSchema): string[] {
  const type = schema["type"];
  if (typeof type === "string") return KNOWN_TYPES.has(type) ? [type] : [];
  if (Array.isArray(type)) {
    const out: string[] = [];
    for (const t of type) if (typeof t === "string" && KNOWN_TYPES.has(t) && !out.includes(t)) out.push(t);
    return out;
  }
  if (isJsonObject(schema["properties"]) || Array.isArray(schema["required"])) return ["object"];
  if (schema["items"] !== undefined) return ["array"];
  return ["null"];
}

function intersectTypes(first: Json | undefined, second: Json | undefined): Json | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  const a = (Array.isArray(first) ? first : [first]).filter((t): t is string => typeof t === "string");
  const b = (Array.isArray(second) ? second : [second]).filter((t): t is string => typeof t === "string");
  const out: string[] = [];
  for (const t of a) {
    let met: string | null = null;
    if (b.includes(t)) met = t;
    else if ((t === "integer" && b.includes("number")) || (t === "number" && b.includes("integer"))) met = "integer";
    if (met !== null && !out.includes(met)) out.push(met);
  }
  if (out.length === 0) return second;
  return out.length === 1 ? (out[0] ?? null) : out;
}

/**
 * The shallow merge used to make candidates: `first` without `without`, then the keywords of `second` over it,
 * except "properties" (merged per name, recursively), "required" (union) and "type" (intersection).
 */
function conjunction(first: JsonSchema, without: string | null, second: JsonSchema): JsonSchema {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(first)) if (key !== without) setProperty(out, key, value);
  for (const [key, value] of Object.entries(second)) {
    const mine = Object.hasOwn(out, key) ? out[key] : undefined;
    if (key === "properties" && isJsonObject(mine) && isJsonObject(value)) {
      const merged: JsonObject = { ...mine };
      for (const [name, sub] of Object.entries(value)) {
        const existing = Object.hasOwn(merged, name) ? merged[name] : undefined;
        setProperty(merged, name, isJsonObject(existing) && isJsonObject(sub) ? conjunction(existing, null, sub) : sub);
      }
      setProperty(out, key, merged);
    } else if (key === "required" && Array.isArray(mine) && Array.isArray(value)) {
      const union: Json[] = [...mine];
      for (const name of value) if (!union.includes(name)) union.push(name);
      setProperty(out, key, union);
    } else if (key === "type") {
      const met = intersectTypes(mine, value);
      if (met !== undefined) setProperty(out, key, met);
    } else {
      setProperty(out, key, value);
    }
  }
  return out;
}

function numberFor(schema: JsonSchema, integer: boolean): number {
  const minimum = schema["minimum"];
  const maximum = schema["maximum"];
  let value = typeof minimum === "number" ? minimum : 0;
  if (typeof minimum !== "number" && typeof maximum === "number" && maximum < value) value = maximum;
  if (integer) {
    value = Math.ceil(value);
    if (typeof maximum === "number" && value > maximum) value = Math.floor(maximum);
  }
  return value;
}

/** The weight of a value for the array budget: one per value, and one more per 64 characters of a string. */
function countValues(value: Json, limit: number): number {
  let count = 1;
  if (typeof value === "string") count += Math.floor(value.length / STRING_WEIGHT_CHARS);
  else if (Array.isArray(value)) {
    for (const item of value) {
      if (count > limit) break;
      count += countValues(item, limit - count);
    }
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) {
      if (count > limit) break;
      count += countValues(item, limit - count);
    }
  }
  return count;
}

/** The by-type candidates of a node (step 7), lazily. */
function* byType(schema: JsonSchema, ctx: Context, depth: number): Generator<Json> {
  for (const type of nodeTypes(schema)) {
    switch (type) {
      case "string": {
        const minLength = schema["minLength"];
        const maxLength = schema["maxLength"];
        const pattern = schema["pattern"];
        if (typeof pattern === "string") {
          const sample = samplePattern(pattern, {
            min: typeof minLength === "number" ? minLength : undefined,
            max: typeof maxLength === "number" ? maxLength : undefined,
          });
          if (sample !== null) yield sample;
        }
        const count = typeof minLength === "number" && minLength > 0 ? Math.min(Math.ceil(minLength), MAX_STRING_LENGTH) : 0;
        yield "x".repeat(count);
        break;
      }
      case "integer":
        yield numberFor(schema, true);
        break;
      case "number": {
        const value = numberFor(schema, false);
        yield value;
        yield value + 0.5;
        break;
      }
      case "boolean":
        yield false;
        break;
      case "null":
        yield null;
        break;
      case "array": {
        const minItems = schema["minItems"];
        const wanted = typeof minItems === "number" && minItems > 0 ? Math.min(Math.ceil(minItems), MAX_ARRAY_ITEMS) : 0;
        if (wanted === 0) {
          yield [];
          break;
        }
        const item = place(schema["items"], ctx, depth + 1);
        const size = countValues(item, MAX_ARRAY_VALUES);
        const remaining = MAX_ARRAY_VALUES - ctx.counts.arrayValues;
        const count = Math.max(0, Math.min(wanted, Math.floor(remaining / size)));
        ctx.counts.arrayValues += count * size;
        const items: Json[] = [];
        for (let i = 0; i < count; i++) items.push(item);
        yield items;
        break;
      }
      case "object": {
        const out: JsonObject = {};
        const properties = isJsonObject(schema["properties"]) ? schema["properties"] : {};
        const required = schema["required"];
        if (Array.isArray(required)) {
          for (const name of required) {
            if (typeof name !== "string") continue;
            const propertySchema = Object.hasOwn(properties, name) ? properties[name] : schema["additionalProperties"];
            setProperty(out, name, place(propertySchema, ctx, depth + 1));
          }
        }
        yield out;
        break;
      }
    }
  }
}

/** Up to MAX_ALTERNATIVES values for a subschema: the ones that satisfy it, else its fallback value. */
function* alternativesOf(schema: unknown, ctx: Context, depth: number): Generator<Json> {
  let taken = 0;
  for (const value of alternatives(schema, ctx, depth)) {
    yield value;
    if (++taken >= MAX_ALTERNATIVES) return;
  }
}

/** The raw candidates of a node (steps 1 to 7), lazily, each marked with whether it comes from step 7. */
function* candidates(schema: JsonSchema, ctx: Context, depth: number): Generator<{ value: Json; byType: boolean }> {
  if (Object.hasOwn(schema, "const")) yield { value: schema["const"] ?? null, byType: false };
  if (Object.hasOwn(schema, "default")) yield { value: schema["default"] ?? null, byType: false };
  const examples = schema["examples"];
  if (Array.isArray(examples)) for (const example of examples) yield { value: example, byType: false };
  const enumValues = schema["enum"];
  if (Array.isArray(enumValues)) for (const value of enumValues) yield { value, byType: false };
  const ref = schema["$ref"];
  if (typeof ref === "string") {
    const target = resolveSchemaRefIn(ref, ctx.root, ctx.options?.definitions);
    if (target !== null) {
      const there = inDocument(ctx, target.root);
      for (const value of alternativesOf(conjunction(schema, "$ref", target.schema), there, depth + 1)) yield { value, byType: false };
      for (const value of alternativesOf(target.schema, there, depth + 1)) yield { value, byType: false };
    }
  }
  for (const keyword of ["anyOf", "oneOf"]) {
    const branches = schema[keyword];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      if (!isJsonObject(branch)) continue;
      for (const value of alternativesOf(conjunction(schema, keyword, branch), ctx, depth + 1)) yield { value, byType: false };
      for (const value of alternativesOf(branch, ctx, depth + 1)) yield { value, byType: false };
    }
  }
  for (const value of byType(schema, ctx, depth)) yield { value, byType: true };
}

function firstByType(schema: JsonSchema, ctx: Context, depth: number): Json {
  for (const value of byType(schema, ctx, depth)) return value;
  return null;
}

/**
 * The values that satisfy a node, in candidate order; when none does, its single fallback value. After the
 * visit budget is spent a node yields its first by-type candidate only, without checking it.
 */
function* alternatives(schema: unknown, ctx: Context, depth: number): Generator<Json> {
  if (!isJsonObject(schema) || depth > MAX_DEPTH) {
    yield null;
    return;
  }
  ctx.counts.visits++;
  if (ctx.counts.visits > MAX_VISITS || ctx.checks.remaining <= 0) {
    yield firstByType(schema, ctx, depth);
    return;
  }
  let found = false;
  let fallback: Json = null;
  let tried = false;
  let haveByType = false;
  for (const candidate of candidates(schema, ctx, depth)) {
    if (!haveByType && (candidate.byType || !tried)) {
      fallback = candidate.value;
      haveByType = candidate.byType;
    }
    tried = true;
    if (validateSubschemaWithin(ctx.root, schema, candidate.value, ctx.checkOptions, ctx.checks).length === 0) {
      found = true;
      yield candidate.value;
    }
  }
  if (!found) yield fallback;
}

function place(schema: unknown, ctx: Context, depth: number): Json {
  for (const value of alternatives(schema, ctx, depth)) return value;
  return null;
}

/** Deterministic: the same schema and options always give the same result. Never throws. */
export function generatePlaceholder(schema: JsonSchema, options?: SchemaOptions): PlaceholderResult {
  return generateSubschemaPlaceholder(schema, schema, options);
}

/**
 * generatePlaceholder for a subschema of the schema document `root` (the document its local references resolve
 * in, as for validateSubschema); `satisfied` is true exactly when validateSubschema(root, schema, value, options)
 * reports no problem.
 */
export function generateSubschemaPlaceholder(root: JsonSchema, schema: JsonSchema, options?: SchemaOptions): PlaceholderResult {
  const ctx: Context = {
    root,
    options,
    checkOptions: { definitions: options?.definitions, maxProblems: 1 },
    counts: { visits: 0, arrayValues: 0 },
    checks: { remaining: MAX_CHECK_EVALUATIONS },
  };
  let value: Json;
  try {
    value = cloneJson(place(schema, ctx, 0));
  } catch {
    value = null;
  }
  let satisfied: boolean;
  try {
    satisfied = validateSubschema(root, schema, value, options).length === 0;
  } catch {
    satisfied = false;
  }
  return { value, satisfied };
}

/** generatePlaceholder(schema, options).value */
export function placeholderFor(schema: JsonSchema, options?: SchemaOptions): Json {
  return generatePlaceholder(schema, options).value;
}
