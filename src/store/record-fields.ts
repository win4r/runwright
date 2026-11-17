/**
 * The field specification of every journal record the engine and its built-in drivers write, and the one walk
 * that redacts a record by it (rule F): what happens to a value is decided by its place in the record as the
 * engine built it, never by a name that a redaction produced.
 *
 * - "keep": Runwright's own words, written as they are: enumerated values, ids Runwright generated, operator
 *   configuration that names a thing, saved-result paths and digests, booleans and the engine's numbers.
 * - "text": free text and names a model, a caller, a tool or a workflow author chose; a string is redacted as text.
 * - "payload": caller, model, tool and driver values, redacted whole (every string, every object key, every
 *   number whose digits hold a secret).
 * - An object the engine built is an ObjectSpec: its field names are written as they are and every other key is
 *   redacted together with its value (fails closed). An array is an ArraySpec.
 * - An object whose keys are data (a map from a path or a name to something) is a MapSpec: every key is redacted
 *   as text and every value by the map's `values`.
 *
 * Declared specifications (rule H). The value of a step or node, a model's structured output and a tool's data
 * are payloads in RECORD_FIELDS. When the code that writes such a value built its structure and reads it back
 * by field name, it declares the value's specification; the engine attaches `recordFieldsWith(type, field,
 * spec)` to the record it commits (`NewJournalRecord.fields`), so the run's redactor and the store wrapper walk
 * the record by the same object, and the specification itself is never stored. In a declared specification
 * "keep" is only for what the engine itself computed (a boolean, a counter, an enumerated word, an id it
 * generated); whatever a model, a person, a caller or a tool supplied is "text" or "payload". A value without a
 * declaration stays a payload.
 *
 * The store stays below the engine: nothing here imports from `src/engine/`.
 */
import { RunwrightError } from "../core/errors.ts";
import type { Json, JsonObject } from "../core/json.ts";

/** The two redactions a field can call for. */
export interface FieldRedactor { text(value: string): string; payload(value: Json): Json }

export type FieldSpec = "keep" | "text" | "payload" | ObjectSpec | ArraySpec | MapSpec;
/** An object the engine built. `fields`: its field names. `rest`: every other key (default "payload"). */
export interface ObjectSpec { readonly fields: Readonly<Record<string, FieldSpec>>; readonly rest?: FieldSpec }
export interface ArraySpec { readonly items: FieldSpec }
/** An object whose keys are data: every key is redacted as text, every value by `values`. */
export interface MapSpec { readonly values: FieldSpec }

const K = "keep";
const T = "text";
const P = "payload";

/**
 * Deepest nesting of ObjectSpec, ArraySpec and MapSpec that `isFieldSpec` accepts: a word is at depth 0, and a
 * specification that contains a chain of 64 of them (`fieldList(fieldList(... "text"))` 64 times) is the deepest
 * one accepted; 65 is refused.
 */
export const MAX_FIELD_SPEC_DEPTH = 64;

/** A frozen ObjectSpec over a copy of `fields` (own enumerable keys; a key named `__proto__` stays an own key). */
export function fieldObject(fields: Readonly<Record<string, FieldSpec>>, rest?: FieldSpec): ObjectSpec {
  const copy: Record<string, FieldSpec> = {};
  for (const key of Object.keys(fields)) {
    Object.defineProperty(copy, key, { value: fields[key], enumerable: true, writable: true, configurable: true });
  }
  Object.freeze(copy);
  return Object.freeze(rest === undefined ? { fields: copy } : { fields: copy, rest });
}

/** A frozen ArraySpec. */
export function fieldList(items: FieldSpec): ArraySpec {
  return Object.freeze({ items });
}

/** A frozen MapSpec. */
export function fieldMap(values: FieldSpec): MapSpec {
  return Object.freeze({ values });
}

/** Freezes a specification and everything in it. */
function deepFreeze<V>(value: V): V {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

const LIMITS = fieldObject({ maxCostMicros: K, maxToolCalls: K, maxTurns: K, allowUnpriced: K });
const USAGE = fieldObject({ inputTokens: K, outputTokens: K, cacheReadTokens: K, cacheWriteTokens: K });
/** The usage counts the engine charged at their reserved bound (`"input"`, `"output"`): Runwright's own words. */
const USAGE_ASSUMED = fieldList(K);
const ERROR = fieldObject({ code: K, message: T });
const COMMAND = fieldObject({ type: K, text: T, pendingId: K, answer: T, always: K, reason: T, limits: LIMITS, action: K, result: T });
const TOOL_CALLS = fieldList(fieldObject({ id: T, name: T, args: P }));
const PROBLEMS = fieldList(fieldObject({ path: T, message: T }));
const MEMO = { name: T, nodeId: T, scope: T, kind: K, workflow: T } as const;
const LEARNING_ITEM_REF = fieldObject({ itemId: K, path: T, version: K });
const PATH_REASON = fieldList(fieldObject({ path: T, reason: T }));

/** A pending's `detail`, every kind (question, approval, spend_cap, tool_budget, turn_limit, interrupted). */
export const PENDING_DETAIL_FIELDS: ObjectSpec = deepFreeze(fieldObject({
  question: T, choices: fieldList(T), tool: T, args: P, capMicros: K, spentMicros: K, neededMicros: K, nextCallWorstCaseMicros: K,
  reason: K, model: K, limit: K, used: K, needed: K, attempt: K, expiresAt: K,
}));

/** A pending's `resolution`, every kind, and the forms that close a pending (expired, closed with the run). */
export const PENDING_RESOLUTION_FIELDS: ObjectSpec = deepFreeze(fieldObject({
  answer: T, decision: K, always: K, reason: T, limits: LIMITS, action: K, result: T, expired: K, expiresAt: K, closed: K,
}));

/** One entry per record type the engine or a built-in driver writes: the specification of its `data`. Deeply frozen. */
export const RECORD_FIELDS: Readonly<Record<string, ObjectSpec>> = deepFreeze({
  "run.created": fieldObject({
    agentId: K, revision: K, input: fieldObject({ message: T, data: P }), limits: LIMITS, trigger: fieldObject({ id: K, kind: K }),
  }),
  "run.claimed": fieldObject({ runnerId: K }),
  "command.applied": fieldObject({ commandId: K, command: COMMAND }),
  "command.rejected": fieldObject({ commandId: K, command: COMMAND, reason: T }),
  "limits.changed": fieldObject({ limits: LIMITS }),
  "inbox.taken": fieldObject({ messages: fieldList(fieldObject({ commandId: K, text: T, at: K })) }),
  "model.started": fieldObject({
    model: K, purpose: K, step: T, turn: K, countsAsTurn: K, inputTokensEstimate: K, maxOutputTokens: K, worstCaseMicros: K,
    repair: K, attempt: K,
  }),
  "model.invalid": fieldObject({
    model: K, purpose: K, text: T, toolCalls: TOOL_CALLS, output: P, problems: PROBLEMS, usage: USAGE, costMicros: K, durationMs: K,
    usageAssumed: USAGE_ASSUMED,
  }),
  "model.finished": fieldObject({
    model: K, purpose: K, text: T, toolCalls: TOOL_CALLS, output: P, stopReason: K, usage: USAGE, costMicros: K, durationMs: K,
    usageAssumed: USAGE_ASSUMED,
  }),
  "model.interrupted": fieldObject({ model: K, reason: K, assumedCostMicros: K, attempt: K }),
  "model.failed": fieldObject({
    model: K, error: ERROR, usage: USAGE, usageAssumed: USAGE_ASSUMED, costMicros: K, attempts: K, assumedCostMicros: K,
    retryAfterMs: K, retryAfterOverLimit: K,
  }),
  "model.retry": fieldObject({
    attempt: K, delayMs: K, code: K, message: T, status: K, billing: K, assumedCostMicros: K, retryAfterMs: K,
  }),
  "tool.started": fieldObject({ callId: T, tool: T, args: P, effect: K, attempt: K }),
  "tool.finished": fieldObject({
    callId: T, tool: T, outcome: K, content: T, data: P, isError: K, untrusted: K, truncated: K, fullResultPath: K, durationMs: K,
    fullResultSha256: K, fullResultBytes: K, fullDataPath: K, fullDataSha256: K, fullDataBytes: K,
  }),
  "tool.interrupted": fieldObject({ tool: T, args: P, attempt: K, reason: K }),
  "pending.opened": fieldObject({ pending: fieldObject({ id: K, kind: K, stepKey: K, title: T, detail: PENDING_DETAIL_FIELDS }) }),
  "pending.resolved": fieldObject({ pendingId: K, kind: K, resolution: PENDING_RESOLUTION_FIELDS, commandId: K }),
  "step.started": fieldObject({ ...MEMO }),
  "step.finished": fieldObject({ ...MEMO, value: P }),
  "node.started": fieldObject({ ...MEMO }),
  "node.finished": fieldObject({ ...MEMO, value: P }),
  "node.retry": fieldObject({ nodeId: T, attempt: K, delayMs: K, error: ERROR }),
  "context.compacted": fieldObject({ throughTurn: K, tokensBefore: K, tokensAfter: K }),
  "learning.given": fieldObject({ items: fieldList(fieldObject({ itemId: K, version: K, kind: K, name: T, mode: K })) }),
  "learning.checked": fieldObject({ dropAll: T, dropped: PATH_REASON, surviving: fieldList(T) }),
  "learning.graded": fieldObject({ decisions: fieldList(fieldObject({ path: T, verdict: K, reason: T, by: K })) }),
  "learning.applied": fieldObject({ kept: fieldList(LEARNING_ITEM_REF), held: fieldList(LEARNING_ITEM_REF), conflicts: PATH_REASON }),
  "learning.skipped": fieldObject({ reason: T }),
  "learning.promotion": fieldObject({ itemId: K, outcome: K, workflow: T, problems: fieldList(T) }),
  "run.output": fieldObject({ output: P }),
  "message.undelivered": fieldObject({ commandId: K, reason: T }),
  "run.waiting": fieldObject({ pendingIds: fieldList(K) }),
  "run.paused": fieldObject({ commandId: K }),
  "run.released": fieldObject({ reason: T }),
  "run.completed": fieldObject({ output: P }),
  "run.failed": fieldObject({ error: ERROR }),
  "run.cancelled": fieldObject({ reason: T }),
});

/** Whether `type` is a record type the engine or a built-in driver writes (it has an entry in RECORD_FIELDS). */
export function isEngineRecordType(type: string): boolean {
  return Object.hasOwn(RECORD_FIELDS, type);
}

/** Which kind of container a specification that is not a word is, told apart by its own keys. */
function containerKind(spec: ObjectSpec | ArraySpec | MapSpec): "object" | "array" | "map" {
  if (Object.hasOwn(spec, "items")) return "array";
  if (Object.hasOwn(spec, "values")) return "map";
  return "object";
}

function isWord(value: unknown): value is "keep" | "text" | "payload" {
  return value === K || value === T || value === P;
}

/** Whether `value` is an object whose prototype is Object.prototype or null, and not an array. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * The own properties of `value` as name -> value, or null when one of them is a symbol, not enumerable, or an
 * accessor (a specification is read the same way every time, so a getter is never called).
 */
function ownData(value: object): Map<string, unknown> | null {
  const out = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value")) return null;
    out.set(key, descriptor.value);
  }
  return out;
}

/**
 * True for "keep", "text", "payload", and for an object that has exactly the own keys of an ObjectSpec (`fields`,
 * optionally `rest`), an ArraySpec (`items`) or a MapSpec (`values`), whose parts are specifications too, nested
 * at most MAX_FIELD_SPEC_DEPTH deep (so a cyclic object is false). `fields` is a plain object. Every key read is an
 * own, enumerable data property; a symbol key or an accessor makes the value no specification. Never throws.
 */
export function isFieldSpec(value: unknown): value is FieldSpec {
  // A container found valid with this much nesting left fits wherever at least as much is left; a part shared
  // within the value is checked again only where less is left.
  const valid = new Map<object, number>();
  const check = (current: unknown, left: number): boolean => {
    if (isWord(current)) return true;
    if (!isPlainRecord(current) || left === 0) return false;
    const known = valid.get(current);
    if (known !== undefined && known <= left) return true;
    const own = ownData(current);
    if (own === null) return false;
    let ok: boolean;
    if (own.size === 1 && own.has("items")) ok = check(own.get("items"), left - 1);
    else if (own.size === 1 && own.has("values")) ok = check(own.get("values"), left - 1);
    else if (own.has("fields") && (own.size === 1 || (own.size === 2 && own.has("rest")))) {
      const fields = own.get("fields");
      const listed = isPlainRecord(fields) ? ownData(fields) : null;
      ok = listed !== null && [...listed.values()].every((part) => check(part, left - 1))
        && (!own.has("rest") || check(own.get("rest"), left - 1));
    } else ok = false;
    if (ok) valid.set(current, left);
    return ok;
  };
  try {
    return check(value, MAX_FIELD_SPEC_DEPTH);
  } catch {
    return false;
  }
}

/**
 * Structural equality: same kind; an ObjectSpec the same field names (in any order) with equal specifications and
 * the same `rest` (absent equals "payload"). Bounded like `isFieldSpec`: beyond MAX_FIELD_SPEC_DEPTH, false.
 */
export function sameFieldSpec(a: FieldSpec, b: FieldSpec): boolean {
  const equal = new Map<object, Map<object, number>>();
  const same = (x: FieldSpec, y: FieldSpec, left: number): boolean => {
    if (isWord(x) || isWord(y)) return x === y;
    if (left === 0) return false;
    const known = equal.get(x)?.get(y);
    if (known !== undefined && known <= left) return true;
    const kind = containerKind(x);
    if (kind !== containerKind(y)) return false;
    let ok: boolean;
    if (kind === "array") ok = same((x as ArraySpec).items, (y as ArraySpec).items, left - 1);
    else if (kind === "map") ok = same((x as MapSpec).values, (y as MapSpec).values, left - 1);
    else {
      const xs = x as ObjectSpec;
      const ys = y as ObjectSpec;
      const names = Object.keys(xs.fields);
      ok = names.length === Object.keys(ys.fields).length
        && names.every((name) => Object.hasOwn(ys.fields, name) && same(xs.fields[name] as FieldSpec, ys.fields[name] as FieldSpec, left - 1))
        && same(xs.rest ?? P, ys.rest ?? P, left - 1);
    }
    if (ok) {
      const row = equal.get(x) ?? new Map<object, number>();
      row.set(y, left);
      equal.set(x, row);
    }
    return ok;
  };
  return same(a, b, MAX_FIELD_SPEC_DEPTH);
}

/**
 * RECORD_FIELDS[type] with the specification of its field `field` replaced by `spec`. Frozen: the new object,
 * its `fields`, and a deeply frozen copy of `spec` in that field (the caller's object is not frozen). Throws RunwrightError("internal") when `type` has no entry, when
 * the entry does not list `field`, or when `spec` is not a field specification. RECORD_FIELDS is not changed.
 */
export function recordFieldsWith(type: string, field: string, spec: FieldSpec): ObjectSpec {
  if (!isEngineRecordType(type)) throw new RunwrightError("internal", `no field specification for record type ${JSON.stringify(type)}`);
  const entry = RECORD_FIELDS[type] as ObjectSpec;
  if (!Object.hasOwn(entry.fields, field)) {
    throw new RunwrightError("internal", `record type ${JSON.stringify(type)} has no field ${JSON.stringify(field)}`);
  }
  if (!isFieldSpec(spec)) throw new RunwrightError("internal", `the specification of ${type}.${field} is not a field specification`);
  const own = frozenCopy(spec);
  const fields: Record<string, FieldSpec> = {};
  for (const key of Object.keys(entry.fields)) {
    Object.defineProperty(fields, key, { value: key === field ? own : entry.fields[key], enumerable: true, writable: true, configurable: true });
  }
  return fieldObject(fields, entry.rest);
}

/**
 * A deeply frozen copy of a specification that `isFieldSpec` accepted, so a later change of the caller's object
 * cannot change how a record is redacted. A part shared within `spec` is copied once.
 */
function frozenCopy(spec: FieldSpec): FieldSpec {
  const copies = new Map<object, FieldSpec>();
  const copy = (current: FieldSpec): FieldSpec => {
    if (isWord(current)) return current;
    const known = copies.get(current);
    if (known !== undefined) return known;
    const kind = containerKind(current);
    let out: FieldSpec;
    if (kind === "array") out = fieldList(copy((current as ArraySpec).items));
    else if (kind === "map") out = fieldMap(copy((current as MapSpec).values));
    else {
      const object = current as ObjectSpec;
      const fields: Record<string, FieldSpec> = {};
      for (const name of Object.keys(object.fields)) {
        Object.defineProperty(fields, name, { value: copy(object.fields[name] as FieldSpec), enumerable: true, writable: true, configurable: true });
      }
      out = fieldObject(fields, object.rest === undefined ? undefined : copy(object.rest));
    }
    copies.set(current, out);
    return out;
  };
  return copy(spec);
}

/**
 * Every field name that an ObjectSpec inside `spec` lists, at any depth (through `fields`, `rest`, `items` and
 * `values`), without duplicates, in first-seen order (a name, then the names inside its specification). For
 * tests that generate secrets from a specification.
 */
export function listedNames(spec: FieldSpec): string[] {
  const names = new Set<string>();
  const seen = new Set<object>();
  const walk = (current: FieldSpec): void => {
    if (isWord(current) || seen.has(current)) return;
    seen.add(current);
    const kind = containerKind(current);
    if (kind === "array") walk((current as ArraySpec).items);
    else if (kind === "map") walk((current as MapSpec).values);
    else {
      const object = current as ObjectSpec;
      for (const name of Object.keys(object.fields)) {
        names.add(name);
        walk(object.fields[name] as FieldSpec);
      }
      if (object.rest !== undefined) walk(object.rest);
    }
  };
  walk(spec);
  return [...names];
}

function isPlainObject(value: Json): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The spec of a field of `spec`, or undefined when `key` is not one of its own field names. */
function fieldSpec(spec: ObjectSpec, key: string): FieldSpec | undefined {
  return Object.hasOwn(spec.fields, key) ? spec.fields[key] : undefined;
}

function define(out: JsonObject, key: string, value: Json): void {
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * `value` redacted by `spec` (rules F1-F6):
 *
 * - "payload": `redact.payload(value)`.
 * - "text": a string by `redact.text`; null and booleans as they are; anything else as "payload".
 * - "keep": a string, number, boolean or null as it is; an array or an object as "payload".
 * - ObjectSpec: a plain object becomes a new object with the same keys in the same order. A key named in
 *   `fields` is written as it is, its value redacted by that field's spec. Every other key is redacted with its
 *   value by `rest` (default "payload"; the key by `redact.text`, unless `rest` is "keep"). When a redacted
 *   unlisted key equals a listed key of the object, the listed key's value wins. null as it is; any other value
 *   as "payload".
 * - ArraySpec: an array element by element by `items`; null as it is; anything else as "payload".
 * - MapSpec: a plain object becomes a new object; each key is written as `redact.text(key)` and its value redacted
 *   by `values` (when two keys redact to the same text the later one wins). null as it is; any other value as
 *   "payload".
 *
 * Own enumerable string keys only; a property whose value is `undefined` is left out (as JSON leaves it out) and
 * `undefined` in an array is null; a key named `__proto__` stays an own property. The input is never changed.
 */
export function redactBySpec(value: Json, spec: FieldSpec, redact: FieldRedactor): Json {
  if (spec === "payload") return redact.payload(value);
  if (spec === "text") {
    if (typeof value === "string") return redact.text(value);
    if (value === null || typeof value === "boolean") return value;
    return redact.payload(value);
  }
  if (spec === "keep") return value === null || typeof value !== "object" ? value : redact.payload(value);
  if (value === null) return null;
  const kind = containerKind(spec);
  if (kind === "array") {
    if (!Array.isArray(value)) return redact.payload(value);
    const items = (spec as ArraySpec).items;
    return value.map((item) => redactBySpec(item ?? null, items, redact));
  }
  if (!isPlainObject(value)) return redact.payload(value);
  if (kind === "map") {
    const values = (spec as MapSpec).values;
    const out: JsonObject = {};
    for (const key of Object.keys(value)) {
      const item = value[key];
      if (item !== undefined) define(out, redact.text(key), redactBySpec(item, values, redact));
    }
    return out;
  }
  return redactObject(value, spec as ObjectSpec, redact);
}

function redactObject(value: JsonObject, spec: ObjectSpec, redact: FieldRedactor): JsonObject {
  const rest = spec.rest ?? "payload";
  const out: JsonObject = {};
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (item === undefined) continue;
    const listed = fieldSpec(spec, key);
    if (listed !== undefined) {
      define(out, key, redactBySpec(item, listed, redact));
      continue;
    }
    const renamed = rest === "keep" ? key : redact.text(key);
    if (fieldSpec(spec, renamed) !== undefined && Object.hasOwn(value, renamed) && value[renamed] !== undefined) continue;
    define(out, renamed, redactBySpec(item, rest, redact));
  }
  return out;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function childPath(path: string, key: string): string {
  return IDENTIFIER.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

/**
 * JSON paths (from `$`) of everything in `value` that `spec` does not name: a key that fell to `rest`, and a
 * value whose JSON type the spec does not expect ("text" over a number, an array or an object; "keep" over an
 * array or an object; an ObjectSpec, ArraySpec or MapSpec over the wrong JSON type). null is expected everywhere,
 * and "payload" expects anything. A MapSpec walks every value by `values`; no key of it is unlisted. For the
 * completeness tests.
 */
export function unlistedPaths(value: Json, spec: FieldSpec): string[] {
  const out: string[] = [];
  const walk = (current: Json, at: FieldSpec, path: string): void => {
    if (at === "payload" || current === null) return;
    if (at === "text") {
      if (typeof current !== "string" && typeof current !== "boolean") out.push(path);
      return;
    }
    if (at === "keep") {
      if (typeof current === "object") out.push(path);
      return;
    }
    const kind = containerKind(at);
    if (kind === "array") {
      const items = (at as ArraySpec).items;
      if (!Array.isArray(current)) out.push(path);
      else current.forEach((item, index) => walk(item ?? null, items, `${path}[${index}]`));
      return;
    }
    if (!isPlainObject(current)) {
      out.push(path);
      return;
    }
    for (const key of Object.keys(current)) {
      const item = current[key];
      if (item === undefined) continue;
      if (kind === "map") {
        walk(item, (at as MapSpec).values, childPath(path, key));
        continue;
      }
      const listed = fieldSpec(at as ObjectSpec, key);
      if (listed === undefined) out.push(childPath(path, key));
      else walk(item, listed, childPath(path, key));
    }
  };
  walk(value, spec, "$");
  return out;
}
