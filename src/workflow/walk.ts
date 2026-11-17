import { canonicalJson, isJsonObject, type JsonObject } from "../core/json.ts";
import { pathIndex, pathProperty, resolveSchemaRefIn, type JsonSchema } from "../schema/validate.ts";
import { decisionValueSchema } from "./decision.ts";
import { NODE_KINDS, type DecisionSpec, type NodeKind } from "./types.ts";

/** How a child node hangs off its parent. */
export type ChildRelation = "step" | "branch" | "case" | "default" | "low_confidence" | "body";

export interface ChildSlot { relation: ChildRelation; index: number; path: string; value: unknown }

export const NODE_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** The child node positions of a (possibly malformed) node, with their JSON paths. Unknown kinds have none. */
export function childSlots(node: unknown, path: string): ChildSlot[] {
  if (!isJsonObject(node)) return [];
  const slots: ChildSlot[] = [];
  const list = (key: string, relation: ChildRelation): void => {
    const items = node[key];
    if (!Array.isArray(items)) return;
    items.forEach((value, index) => slots.push({ relation, index, path: pathIndex(pathProperty(path, key), index), value }));
  };
  switch (node["kind"]) {
    case "sequence":
      list("steps", "step");
      break;
    case "parallel":
      list("branches", "branch");
      break;
    case "branch": {
      const cases = node["cases"];
      if (Array.isArray(cases)) {
        cases.forEach((entry, index) => {
          if (isJsonObject(entry) && Object.hasOwn(entry, "run")) {
            slots.push({ relation: "case", index, path: pathProperty(pathIndex(pathProperty(path, "cases"), index), "run"), value: entry["run"] });
          }
        });
      }
      if (Object.hasOwn(node, "default")) slots.push({ relation: "default", index: 0, path: pathProperty(path, "default"), value: node["default"] });
      break;
    }
    case "decide": {
      const low = node["lowConfidence"];
      if (isJsonObject(low) && Object.hasOwn(low, "run")) {
        slots.push({ relation: "low_confidence", index: 0, path: pathProperty(pathProperty(path, "lowConfidence"), "run"), value: low["run"] });
      }
      break;
    }
    case "map":
    case "loop":
      if (Object.hasOwn(node, "run")) slots.push({ relation: "body", index: 0, path: pathProperty(path, "run"), value: node["run"] });
      break;
    default:
      break;
  }
  return slots;
}

export function isKnownKind(kind: unknown): kind is NodeKind {
  return typeof kind === "string" && (NODE_KINDS as readonly string[]).includes(kind);
}

/** One node of a document, indexed by an internal key (ids may be missing or duplicated in bad documents). */
export interface IndexedNode {
  key: number;
  id: string | null;
  kind: NodeKind;
  path: string;
  node: JsonObject;
  parent: number | null;
  relation: ChildRelation | null;
  index: number;
  depth: number;
  children: number[];
}

export interface NodeIndex {
  nodes: IndexedNode[];
  /** First node carrying each id. */
  byId: Map<string, IndexedNode>;
  root: IndexedNode | null;
}

/** Indexes every node of known kind reachable from `root` (subtrees of unknown kinds are not entered). */
export function indexNodes(root: unknown, rootPath: string): NodeIndex {
  const nodes: IndexedNode[] = [];
  const byId = new Map<string, IndexedNode>();
  const onPath = new Set<object>();
  const visit = (value: unknown, path: string, parent: number | null, relation: ChildRelation | null, index: number, depth: number): void => {
    if (!isJsonObject(value) || !isKnownKind(value["kind"]) || onPath.has(value)) return;
    const id = typeof value["id"] === "string" ? value["id"] : null;
    const entry: IndexedNode = { key: nodes.length, id, kind: value["kind"], path, node: value, parent, relation, index, depth, children: [] };
    nodes.push(entry);
    if (parent !== null) (nodes[parent] as IndexedNode).children.push(entry.key);
    if (id !== null && !byId.has(id)) byId.set(id, entry);
    onPath.add(value);
    for (const slot of childSlots(value, path)) visit(slot.value, slot.path, entry.key, slot.relation, slot.index, depth + 1);
    onPath.delete(value);
  };
  visit(root, rootPath, null, null, 0, 0);
  return { nodes, byId, root: nodes[0] ?? null };
}

/** Child entries of an indexed node, in document order. */
export function childrenOf(index: NodeIndex, entry: IndexedNode): IndexedNode[] {
  return entry.children.map((key) => index.nodes[key] as IndexedNode);
}

/** True when `ancestor` is a strict ancestor of `node`. */
export function isAncestor(index: NodeIndex, ancestor: IndexedNode, node: IndexedNode): boolean {
  let current = node.parent;
  while (current !== null) {
    if (current === ancestor.key) return true;
    current = (index.nodes[current] as IndexedNode).parent;
  }
  return false;
}

/** Ancestors of a node from its parent up to the root. */
export function ancestorsOf(index: NodeIndex, node: IndexedNode): IndexedNode[] {
  const out: IndexedNode[] = [];
  let current = node.parent;
  while (current !== null) {
    const entry = index.nodes[current] as IndexedNode;
    out.push(entry);
    current = entry.parent;
  }
  return out;
}

/** True when every container strictly between `top` (inclusive) and `node` is a sequence or parallel. */
export function reachedUnconditionally(index: NodeIndex, top: IndexedNode, node: IndexedNode): boolean {
  let current = node;
  while (current.key !== top.key) {
    if (current.parent === null) return false;
    const parent = index.nodes[current.parent] as IndexedNode;
    if (parent.kind !== "sequence" && parent.kind !== "parallel") return false;
    current = parent;
  }
  return true;
}

/**
 * The statically known shape of a value: a JSON Schema (with its resolution context), a closed record of
 * fields, a list, or unknown.
 */
export type Shape =
  | { t: "schema"; schema: JsonSchema; root: JsonSchema; defs: Readonly<Record<string, JsonSchema>> | undefined }
  | { t: "record"; fields: { [name: string]: Shape } }
  | { t: "list"; items: Shape }
  | { t: "unknown" };

export const UNKNOWN_SHAPE: Shape = Object.freeze({ t: "unknown" });

export function plainShape(schema: JsonSchema): Shape {
  return { t: "schema", schema, root: schema, defs: undefined };
}

/** The shape of a document's named schema (unknown when the schema does not exist). */
export function namedShape(schemas: unknown, name: unknown): Shape {
  if (!isJsonObject(schemas) || typeof name !== "string" || !Object.hasOwn(schemas, name)) return UNKNOWN_SHAPE;
  const schema = schemas[name];
  if (!isJsonObject(schema)) return UNKNOWN_SHAPE;
  return { t: "schema", schema, root: schema, defs: schemas as Record<string, JsonSchema> };
}

function isDecisionSpec(value: unknown): value is DecisionSpec {
  if (!isJsonObject(value)) return false;
  switch (value["type"]) {
    case "yes_no": return true;
    case "pick_one": return Array.isArray(value["options"]) && value["options"].every((o) => typeof o === "string");
    case "score": return typeof value["min"] === "number" && typeof value["max"] === "number";
    default: return false;
  }
}

export interface ShapeContext {
  index: NodeIndex;
  schemas: unknown;
  /** Output shape of a `call` target, when it can be resolved. */
  callShape?: (workflow: string) => Shape;
}

/** The statically known shape of the value a node leaves in `steps.<id>`. */
export function nodeShape(context: ShapeContext, entry: IndexedNode, seen: Set<number> = new Set()): Shape {
  if (seen.has(entry.key)) return UNKNOWN_SHAPE;
  seen.add(entry.key);
  const node = entry.node;
  const child = (relation: ChildRelation): IndexedNode | undefined =>
    childrenOf(context.index, entry).find((candidate) => candidate.relation === relation);
  switch (entry.kind) {
    case "tool":
      return { t: "record", fields: { ok: plainShape({ type: "boolean" }), content: plainShape({ type: "string" }), data: UNKNOWN_SHAPE } };
    case "model":
      return namedShape(context.schemas, node["output"]);
    case "decide": {
      const spec = node["decision"];
      return {
        t: "record",
        fields: {
          value: isDecisionSpec(spec) ? plainShape(decisionValueSchema(spec)) : UNKNOWN_SHAPE,
          confidence: plainShape({ type: "number", minimum: 0, maximum: 1 }),
          reason: plainShape({ type: "string" }),
          route: plainShape({ enum: ["confident", "low_confidence"] }),
          fallback: UNKNOWN_SHAPE,
        },
      };
    }
    case "sequence": {
      const steps = childrenOf(context.index, entry);
      const last = steps.at(-1);
      const declared = Array.isArray(node["steps"]) ? node["steps"].length : 0;
      if (last === undefined || steps.length !== declared) return UNKNOWN_SHAPE;
      return nodeShape(context, last, seen);
    }
    case "parallel": {
      const fields: { [name: string]: Shape } = {};
      const branches = childrenOf(context.index, entry);
      const declared = Array.isArray(node["branches"]) ? node["branches"].length : 0;
      if (branches.length !== declared) return UNKNOWN_SHAPE;
      for (const branch of branches) {
        if (branch.id === null) return UNKNOWN_SHAPE;
        Object.defineProperty(fields, branch.id, { value: nodeShape(context, branch, seen), enumerable: true, writable: true, configurable: true });
      }
      return { t: "record", fields };
    }
    case "map": {
      const body = child("body");
      return { t: "list", items: body === undefined ? UNKNOWN_SHAPE : nodeShape(context, body, seen) };
    }
    case "loop": {
      const body = child("body");
      return {
        t: "record",
        fields: {
          iterations: plainShape({ type: "integer", minimum: 0 }),
          completed: plainShape({ type: "boolean" }),
          last: body === undefined ? UNKNOWN_SHAPE : nodeShape(context, body, seen),
        },
      };
    }
    case "call":
      return typeof node["workflow"] === "string" && context.callShape !== undefined ? context.callShape(node["workflow"]) : UNKNOWN_SHAPE;
    case "agent":
      return {
        t: "record",
        fields: {
          text: plainShape({ type: "string" }),
          data: node["output"] === undefined ? plainShape({ type: "null" }) : namedShape(context.schemas, node["output"]),
        },
      };
    case "wait":
      return { t: "record", fields: { answer: plainShape({ type: "string" }) } };
    case "branch":
    case "fail":
      return UNKNOWN_SHAPE;
  }
}

/** Result of walking a reference path into a shape. */
export interface ShapeStep {
  /** Shape at the end of the path (unknown when the walk stopped early). */
  shape: Shape;
  /** A statically visible problem: error when the path cannot exist, warning when it is undeclared. */
  problem: { severity: "error" | "warning"; message: string; segment: number } | null;
}

function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

/**
 * The JSON types every value a schema accepts has, from `type`, else `const`, else `enum`; null when the schema
 * does not pin them (a schema with only `properties` accepts a string too, so it pins nothing). `integer` stands
 * for the whole numbers among `number`.
 */
export function schemaValueTypes(schema: JsonSchema): string[] | null {
  const type = schema["type"];
  if (typeof type === "string") return [type];
  if (Array.isArray(type)) {
    const listed = type.filter((t): t is string => typeof t === "string");
    return listed.length > 0 ? listed : null;
  }
  if (Object.hasOwn(schema, "const")) return [jsonType(schema["const"])];
  if (Array.isArray(schema["enum"])) return [...new Set(schema["enum"].map(jsonType))];
  return null;
}

/**
 * The types a reference path can step through: `schemaValueTypes`, or `array` and `object` for a schema that only
 * describes properties (it accepts any value, and a path steps only through objects and, by a numeric segment,
 * arrays; its `items`, when it has none, leave the array reading unknown).
 */
function navigableTypes(schema: JsonSchema): string[] | null {
  const types = schemaValueTypes(schema);
  if (types !== null) return types;
  if (isJsonObject(schema["properties"])) return ["array", "object"];
  return null;
}

/**
 * Follows the `$ref`s of a schema shape (sibling keywords next to a `$ref` are not kept); unknown when one does not
 * resolve. References follow the reference-root rule of `resolveSchemaRef` (`resolveSchemaRefIn`): a reference
 * that lands on a named schema makes it the shape's `root`, the document the references inside it resolve in.
 */
export function derefShape(shape: Shape): Shape {
  let current = shape;
  for (let depth = 0; depth < 64 && current.t === "schema"; depth++) {
    const ref = current.schema["$ref"];
    if (typeof ref !== "string") return current;
    const target = resolveSchemaRefIn(ref, current.root, current.defs);
    if (target === null) return UNKNOWN_SHAPE;
    current = { ...current, schema: target.schema, root: target.root };
  }
  return current.t === "schema" && typeof current.schema["$ref"] === "string" ? UNKNOWN_SHAPE : current;
}

function describeTypes(types: readonly string[]): string {
  return types.join(" or ");
}

/**
 * The ways one segment can step into a schema whose values have `types`: the array reading (a numeric segment
 * and `array` among the types: the element, `items`) and the object reading (`object` among the types: own
 * property `String(segment)`, as `resolveRef` reads it). Each reading is a shape, or a problem: a warning when the
 * property is undeclared on an open object, an error when the schema allows no such property.
 */
function segmentReadings(current: Shape & { t: "schema" }, types: readonly string[], segment: string | number, i: number): ShapeStep[] {
  const schema = current.schema;
  const readings: ShapeStep[] = [];
  if (typeof segment === "number" && types.includes("array")) {
    const items = schema["items"];
    readings.push({ shape: isJsonObject(items) ? { ...current, schema: items } : UNKNOWN_SHAPE, problem: null });
  }
  if (types.includes("object")) {
    const key = String(segment);
    const label = JSON.stringify(key);
    const properties = isJsonObject(schema["properties"]) ? schema["properties"] : {};
    const additional = schema["additionalProperties"];
    if (Object.hasOwn(properties, key) && isJsonObject(properties[key])) {
      readings.push({ shape: { ...current, schema: properties[key] as JsonSchema }, problem: null });
    } else if (additional === false) {
      readings.push({ shape: UNKNOWN_SHAPE, problem: { severity: "error", segment: i, message: `has no property ${label} (the schema allows no other properties)` } });
    } else if (isJsonObject(additional)) {
      readings.push({ shape: { ...current, schema: additional }, problem: null });
    } else {
      readings.push({ shape: UNKNOWN_SHAPE, problem: { severity: "warning", segment: i, message: `does not declare property ${label}` } });
    }
  }
  return readings;
}

/**
 * Walks `segments` (the part of a reference after its root value) into `shape`. A segment into a schema is read
 * every way a value of the schema allows (`segmentReadings`): with one possible reading the walk follows it; with
 * two (a numeric segment into a value that may be an array or an object) it follows them only when both give the
 * same schema, and is unknown otherwise. A problem is an error only when every reading is one, and a warning only
 * when no reading succeeds without one. So the shape always includes every value the reference can have.
 */
export function walkShape(shape: Shape, segments: readonly (string | number)[]): ShapeStep {
  let current = shape;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] as string | number;
    current = derefShape(current);
    const label = JSON.stringify(String(segment));
    switch (current.t) {
      case "unknown":
        return { shape: UNKNOWN_SHAPE, problem: null };
      case "record": {
        const key = String(segment);
        if (!Object.hasOwn(current.fields, key)) {
          const names = Object.keys(current.fields);
          return {
            shape: UNKNOWN_SHAPE,
            problem: { severity: "error", segment: i, message: `has no field ${label}${names.length > 0 ? ` (fields: ${names.join(", ")})` : ""}` },
          };
        }
        current = current.fields[key] as Shape;
        break;
      }
      case "list":
        if (typeof segment !== "number") {
          return { shape: UNKNOWN_SHAPE, problem: { severity: "error", segment: i, message: `is an array; ${label} is not an index` } };
        }
        current = current.items;
        break;
      case "schema": {
        const schema = current.schema;
        if (Array.isArray(schema["anyOf"]) || Array.isArray(schema["oneOf"])) return { shape: UNKNOWN_SHAPE, problem: null };
        const types = navigableTypes(schema);
        if (types === null) return { shape: UNKNOWN_SHAPE, problem: null };
        const readings = segmentReadings(current, types, segment, i);
        const possible = readings.filter((reading) => reading.problem?.severity !== "error");
        if (possible.length === 0) {
          return readings[0] ?? {
            shape: UNKNOWN_SHAPE,
            problem: { severity: "error", segment: i, message: `is ${describeTypes(types)}; it has no ${typeof segment === "number" ? "element" : "property"} ${label}` },
          };
        }
        const [first, second] = possible as [ShapeStep, ShapeStep | undefined];
        if (second === undefined) {
          if (first.problem !== null) return { shape: UNKNOWN_SHAPE, problem: first.problem };
          current = first.shape;
          break;
        }
        if (first.problem === null && second.problem === null && first.shape.t === "schema" && second.shape.t === "schema" &&
          canonicalJson(first.shape.schema) === canonicalJson(second.shape.schema)) {
          current = first.shape;
          break;
        }
        return { shape: UNKNOWN_SHAPE, problem: null };
      }
    }
  }
  return { shape: derefShape(current), problem: null };
}

/** The JSON types every value of a shape has (`schemaValueTypes`), or null when they are not known. */
export function shapeTypes(shape: Shape): string[] | null {
  const resolved = derefShape(shape);
  switch (resolved.t) {
    case "unknown": return null;
    case "record": return ["object"];
    case "list": return ["array"];
    case "schema":
      if (Array.isArray(resolved.schema["anyOf"]) || Array.isArray(resolved.schema["oneOf"])) return null;
      return schemaValueTypes(resolved.schema);
  }
}

/** The shape of an array's elements (unknown when not statically known). */
export function itemShape(shape: Shape): Shape {
  const resolved = derefShape(shape);
  if (resolved.t === "list") return resolved.items;
  if (resolved.t === "schema" && isJsonObject(resolved.schema["items"])) return { ...resolved, schema: resolved.schema["items"] };
  return UNKNOWN_SHAPE;
}

function hasUnionKeyword(schema: JsonSchema): boolean {
  return Array.isArray(schema["anyOf"]) || Array.isArray(schema["oneOf"]);
}

function sameTypes(schema: JsonSchema, type: string): boolean {
  const types = schemaValueTypes(schema);
  return types !== null && types.length === 1 && types[0] === type;
}

/**
 * How many items every value of `shape` has at least: the integer `minItems` of a plain array schema (one whose
 * only type is `array`, without `anyOf` / `oneOf`); 0 for every other shape (a union, several types, a list, unknown).
 */
export function guaranteedLength(shape: Shape): number {
  const resolved = derefShape(shape);
  if (resolved.t !== "schema" || hasUnionKeyword(resolved.schema) || !sameTypes(resolved.schema, "array")) return 0;
  const minItems = resolved.schema["minItems"];
  return Number.isInteger(minItems) && (minItems as number) > 0 ? (minItems as number) : 0;
}

/**
 * True when every value of `shape` has the whole path `segments`, so a reference that steps along it always
 * resolves. Each step must be a field of a record, a property a plain object schema requires, or an index below
 * a plain array schema's `minItems`; an unknown shape, a union, a list index or an optional property is not
 * always there. An empty path always is.
 */
export function pathAlwaysPresent(shape: Shape, segments: readonly (string | number)[]): boolean {
  let current = shape;
  for (const segment of segments) {
    current = derefShape(current);
    switch (current.t) {
      case "unknown":
      case "list":
        return false;
      case "record": {
        const key = String(segment);
        if (!Object.hasOwn(current.fields, key)) return false;
        current = current.fields[key] as Shape;
        break;
      }
      case "schema": {
        const schema = current.schema;
        if (hasUnionKeyword(schema)) return false;
        let next: unknown;
        if (typeof segment === "number") {
          if (guaranteedLength(current) <= segment) return false;
          next = schema["items"];
        } else {
          const required = schema["required"];
          if (!sameTypes(schema, "object") || !Array.isArray(required) || !required.includes(segment)) return false;
          const properties = schema["properties"];
          next = isJsonObject(properties) && Object.hasOwn(properties, segment) ? properties[segment] : undefined;
        }
        current = isJsonObject(next) ? { ...current, schema: next } : UNKNOWN_SHAPE;
        break;
      }
    }
  }
  return true;
}
