import { isJsonObject, type Json, type JsonObject } from "../core/json.ts";
import { RunwrightError } from "../core/errors.ts";
import type { JsonSchema } from "../schema/validate.ts";
import { copyJson } from "./refs.ts";
import type { WorkflowDocument } from "./types.ts";

/**
 * Keywords whose value is a map of schemas, a schema, or an array of schemas. Every other keyword (`const`, `enum`,
 * `default`, `examples`, `required`, ...) holds data, and references inside it are never rewritten.
 */
const SCHEMA_MAP_KEYWORDS = new Set(["properties", "$defs", "definitions"]);
const SCHEMA_KEYWORDS = new Set(["items", "additionalProperties"]);
const SCHEMA_LIST_KEYWORDS = new Set(["anyOf", "oneOf"]);
const REF_PATTERN = /^#\/(\$defs|definitions|schemas)\/([^/]+)$/;

function namedSchemas(document: WorkflowDocument): Record<string, JsonSchema> {
  return isJsonObject(document.schemas) ? (document.schemas as Record<string, JsonSchema>) : {};
}

/** The named schema of a workflow document. Throws `workflow_invalid` when it does not exist. */
function schemaOf(document: WorkflowDocument, name: string): JsonSchema {
  const schemas = namedSchemas(document);
  if (typeof name === "string" && Object.hasOwn(schemas, name)) {
    const schema = schemas[name];
    if (isJsonObject(schema)) return schema;
  }
  throw new RunwrightError("workflow_invalid", `workflow ${JSON.stringify(document.name)} has no schema named ${JSON.stringify(name)}`, {
    details: { schema: String(name) },
  });
}

function decodeSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function encodeSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function setOwn(target: JsonObject, key: string, value: Json): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** A schema document whose references are being rewritten: the entry schema, or a named schema placed in the bundle. */
interface SourceDocument {
  schema: JsonSchema;
  /** The named schema's name; null for the entry schema, whose own definitions keep their keys. */
  name: string | null;
}

/**
 * A self-contained copy of a named schema that validates exactly like the named schema with
 * `{definitions: document.schemas}`: validating against the bundle without options gives the same verdict and the
 * same problems.
 *
 * References follow the reference-root rule of `resolveSchemaRef`: a local reference is resolved against the
 * schema document it is written in. `#/$defs/N` and `#/definitions/N` look first in the `$defs` / `definitions` of
 * that document and then among the workflow's named schemas; `#/schemas/N` names a workflow schema. Following a
 * reference that lands on a named schema makes that named schema the document for the references inside it.
 *
 * So the entry schema keeps its own `$defs` and `definitions` under their keys. Every named schema a reference
 * reaches is placed under the bundle's `$defs` (under its name, or `<name>__schema<n>` when that key is taken), and
 * the definitions of that named schema that its references use are hoisted to unique top-level `$defs` keys
 * (`<name>__<definition>`); the references written inside it are rewritten to those keys. A reference that does
 * not resolve is written as `#/schemas/<name>`, which never resolves in a bundle validated without definitions.
 */
export function bundleSchema(document: WorkflowDocument, name: string): JsonSchema {
  const root = schemaOf(document, name);
  const schemas = namedSchemas(document);
  const ownDefs = isJsonObject(root["$defs"]) ? root["$defs"] : {};
  const keyFor = new Map<string, string>();
  const pending: { key: string; schema: Json; source: SourceDocument; named: boolean }[] = [];
  const takenKeys = new Set(Object.keys(ownDefs));

  const allocate = (identity: string, wanted: string, suffix: (n: number) => string): { key: string; fresh: boolean } => {
    const known = keyFor.get(identity);
    if (known !== undefined) return { key: known, fresh: false };
    let key = wanted;
    for (let n = 1; takenKeys.has(key); n++) key = suffix(n);
    takenKeys.add(key);
    keyFor.set(identity, key);
    return { key, fresh: true };
  };

  const namedKey = (schemaName: string): string => {
    const { key, fresh } = allocate(`schema\u0000${schemaName}`, schemaName, (n) => `${schemaName}__schema${n === 1 ? "" : n}`);
    const schema = schemas[schemaName] as JsonSchema;
    if (fresh) pending.push({ key, schema, source: { schema, name: schemaName }, named: true });
    return key;
  };

  const hoistedKey = (source: SourceDocument & { name: string }, section: string, definition: string, schema: Json): string => {
    const wanted = `${source.name}__${definition}`;
    const { key, fresh } = allocate(`${section}\u0000${source.name}\u0000${definition}`, wanted, (n) => `${wanted}__${n + 1}`);
    if (fresh) pending.push({ key, schema, source, named: false });
    return key;
  };

  const rewriteRef = (ref: string, source: SourceDocument): string => {
    const match = REF_PATTERN.exec(ref);
    if (match === null) return ref;
    const section = match[1] as string;
    const target = decodeSegment(match[2] ?? "");
    if (section !== "schemas") {
      const container = source.schema[section];
      if (isJsonObject(container) && Object.hasOwn(container, target) && isJsonObject(container[target])) {
        if (source.name === null) return ref;
        return `#/$defs/${encodeSegment(hoistedKey({ schema: source.schema, name: source.name }, section, target, container[target] ?? null))}`;
      }
    }
    if (Object.hasOwn(schemas, target) && isJsonObject(schemas[target])) return `#/$defs/${encodeSegment(namedKey(target))}`;
    return `#/schemas/${encodeSegment(target)}`;
  };

  /** A map whose every value is a schema; its keys are names, never keywords. */
  const rewriteSchemaMap = (value: Json, source: SourceDocument): Json => {
    if (!isJsonObject(value)) return copyJson(value);
    const out: JsonObject = {};
    for (const key of Object.keys(value)) setOwn(out, key, rewriteSchema(value[key] ?? null, source, false));
    return out;
  };

  /**
   * One schema of `source`: keywords that hold schemas are walked, every other keyword is copied as data. A named
   * schema's own `$defs` / `definitions` (`hoisted`) are left out: what its references use is hoisted.
   */
  const rewriteSchema = (value: Json, source: SourceDocument, hoisted: boolean): Json => {
    if (!isJsonObject(value)) return copyJson(value);
    const out: JsonObject = {};
    for (const key of Object.keys(value)) {
      const item = value[key] ?? null;
      if (hoisted && (key === "$defs" || key === "definitions")) continue;
      if (key === "$ref" && typeof item === "string") setOwn(out, key, rewriteRef(item, source));
      else if (SCHEMA_MAP_KEYWORDS.has(key)) setOwn(out, key, rewriteSchemaMap(item, source));
      else if (SCHEMA_KEYWORDS.has(key)) setOwn(out, key, rewriteSchema(item, source, false));
      else if (SCHEMA_LIST_KEYWORDS.has(key)) setOwn(out, key, Array.isArray(item) ? item.map((member) => rewriteSchema(member, source, false)) : copyJson(item));
      else setOwn(out, key, copyJson(item));
    }
    return out;
  };

  const bundle = rewriteSchema(root, { schema: root, name: null }, false) as JsonObject;
  const defs: JsonObject = isJsonObject(bundle["$defs"]) ? bundle["$defs"] : {};
  for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
    setOwn(defs, next.key, rewriteSchema(next.schema, next.source, next.named));
  }
  if (keyFor.size > 0 || Object.hasOwn(bundle, "$defs")) setOwn(bundle, "$defs", defs);
  return bundle;
}
