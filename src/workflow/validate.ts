import { MAX_TIMER_MS } from "../core/clock.ts";
import { canonicalJson, isJsonObject, type Json, type JsonObject } from "../core/json.ts";
import { checkSchema, pathIndex, pathProperty, validateSubschema, type JsonSchema } from "../schema/validate.ts";
import { checkAssignable, isLiteralExpr } from "./assign.ts";
import { checkDecisionValue, decisionValueSchema } from "./decision.ts";
import { ARGS_MAP_MESSAGE, conditionOperator, listRefs, parseRefPath, refForm, resolveValue, type RefScope } from "./refs.ts";
import { bundleSchema } from "./schemas.ts";
import {
  NODE_KINDS, WORKFLOW_FORMAT, type DecisionSpec, type WorkflowDocument, type WorkflowProblem, type WorkflowProblemCode,
} from "./types.ts";
import {
  NODE_ID_PATTERN, UNKNOWN_SHAPE, ancestorsOf, childSlots, childrenOf, indexNodes, isAncestor, isKnownKind, itemShape,
  namedShape, nodeShape, pathAlwaysPresent, plainShape, reachedUnconditionally, shapeTypes, walkShape,
  type IndexedNode, type NodeIndex, type Shape, type ShapeContext,
} from "./walk.ts";

export interface ValidateOptions {
  resolveWorkflow?: (name: string) => WorkflowDocument | null;
  tools?: readonly { name: string; parameters: JsonSchema; retrySafe: boolean }[];
  /**
   * The name the document is, or is about to be, saved under: a `call` to that name resolves to the document
   * being validated. `null`: the document is not a saved workflow (embedded in an agent definition), so no call
   * resolves to it by name. Absent: the document's own `name` field is used (a document being checked before it
   * is saved under that name).
   */
  savedAs?: string | null;
}

type Field = "normal" | "until" | "lcValue";
interface RefAnalysis {
  shape: Shape;
  presence: "always" | "maybe";
  problems: { code: WorkflowProblemCode; message: string; severity: "error" | "warning" }[];
}
type Visibility = { kind: "visible" } | { kind: "conditional" } | { kind: "hidden"; reason: string };

const DOCUMENT_KEYS = new Set(["format", "name", "description", "schemas", "input", "output", "workflows", "root", "result"]);
const COMMON_KEYS = ["id", "kind", "title", "deadlineMs", "retry"];
const KIND_KEYS: Record<string, readonly string[]> = {
  tool: ["tool", "args", "idempotent", "onError"],
  model: ["prompt", "system", "output"],
  decide: ["question", "decision", "lowConfidence"],
  branch: ["on", "cases", "default"],
  sequence: ["steps"],
  parallel: ["branches"],
  map: ["over", "as", "concurrency", "maxItems", "run"],
  loop: ["maxIterations", "until", "run", "onLimit"],
  call: ["workflow", "input"],
  agent: ["message", "instructions", "tools", "output", "maxTurns"],
  wait: ["question", "choices"],
  fail: ["message"],
};
const RETRY_KINDS = new Set(["tool", "model", "decide"]);
/**
 * Node kinds on which a valid `deadlineMs` is accepted but bounds nothing: a `fail` node ends the workflow at once.
 * Every other kind is bounded (a `wait` node's question must be answered before the instant its deadline fixes).
 */
const INERT_DEADLINE_KINDS = new Set(["fail"]);
const MAX_LOOP_ITERATIONS = 1_000_000;
const MAX_MAP_ITEMS = 1_000_000;
const MAX_AGENT_TURNS = 10_000;
const AS_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const EMPTY_SCOPE: RefScope = { input: null, steps: {}, vars: {}, loop: {}, run: { id: "", agentId: "" } };

/** A finite number of milliseconds from 0 to MAX_TIMER_MS: a wait one timer can hold. */
function isTimerMs(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_TIMER_MS;
}

function isFactor(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1;
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function joinPath(base: string, relative: string): string {
  return base + relative.slice(1);
}

class State {
  readonly problems: WorkflowProblem[] = [];
  readonly options: ValidateOptions;
  readonly top: JsonObject | null;
  constructor(options: ValidateOptions, top: JsonObject | null) {
    this.options = options;
    this.top = top;
  }
  add(path: string, code: WorkflowProblemCode, message: string, severity: "error" | "warning" = "error", nodeId?: string | null): void {
    const problem: WorkflowProblem = { path, code, message, severity };
    if (typeof nodeId === "string") problem.nodeId = nodeId;
    this.problems.push(problem);
  }
  tool(name: unknown): { name: string; parameters: JsonSchema; retrySafe: boolean } | undefined {
    return this.options.tools?.find((candidate) => candidate.name === name);
  }
}

/**
 * The storage identity of the document being validated (`ValidateOptions.savedAs`): the name a `call` resolves to
 * it by, or null when no call does.
 */
export function storageIdentity(top: JsonObject | null, savedAs: string | null | undefined): string | null {
  if (savedAs !== undefined) return savedAs;
  return top !== null && typeof top["name"] === "string" ? top["name"] : null;
}

/** Resolves a `call` target from a document: its inline map, then the document being validated by its storage identity, then saved. */
function resolveTarget(state: State, document: JsonObject, name: string): { doc: JsonObject; key: string; label: string; inline: boolean } | null {
  const inline = document["workflows"];
  if (isJsonObject(inline) && Object.hasOwn(inline, name) && isJsonObject(inline[name])) {
    return { doc: inline[name], key: "", label: name, inline: true };
  }
  if (state.top !== null && storageIdentity(state.top, state.options.savedAs) === name) return { doc: state.top, key: "top", label: name, inline: false };
  const saved = state.options.resolveWorkflow?.(name) ?? null;
  if (saved !== null && isJsonObject(saved)) return { doc: saved, key: `saved:${name}`, label: name, inline: false };
  return null;
}

class DocumentChecker {
  readonly state: State;
  readonly doc: JsonObject;
  readonly base: string;
  readonly index: NodeIndex;
  readonly entryOf = new Map<object, IndexedNode>();
  readonly seenIds = new Map<string, string>();
  readonly shapes: ShapeContext;

  constructor(state: State, doc: JsonObject, base: string) {
    this.state = state;
    this.doc = doc;
    this.base = base;
    this.index = indexNodes(doc["root"], pathProperty(base, "root"));
    for (const entry of this.index.nodes) if (!this.entryOf.has(entry.node)) this.entryOf.set(entry.node, entry);
    this.shapes = {
      index: this.index,
      schemas: doc["schemas"],
      callShape: (name) => {
        const target = resolveTarget(state, doc, name);
        return target === null ? UNKNOWN_SHAPE : namedShape(target.doc["schemas"], target.doc["output"]);
      },
    };
  }

  get schemas(): JsonObject {
    return isJsonObject(this.doc["schemas"]) ? this.doc["schemas"] : {};
  }

  hasSchema(name: unknown): boolean {
    return typeof name === "string" && Object.hasOwn(this.schemas, name);
  }

  run(): void {
    const { doc, base, state } = this;
    for (const key of Object.keys(doc)) {
      if (!DOCUMENT_KEYS.has(key)) state.add(pathProperty(base, key), "shape", `unknown document field ${JSON.stringify(key)}`, "warning");
    }
    if (doc["format"] !== WORKFLOW_FORMAT) {
      state.add(pathProperty(base, "format"), "format", `"format" must be ${JSON.stringify(WORKFLOW_FORMAT)}`);
    }
    if (typeof doc["name"] !== "string" || doc["name"].length === 0) state.add(pathProperty(base, "name"), "shape", `"name" must be a non-empty string`);
    if (Object.hasOwn(doc, "description") && typeof doc["description"] !== "string") {
      state.add(pathProperty(base, "description"), "shape", `"description" must be a string`);
    }
    this.checkSchemas();
    for (const key of ["input", "output"]) {
      const path = pathProperty(base, key);
      const value = doc[key];
      if (typeof value !== "string") state.add(path, "shape", `"${key}" must name a schema`);
      else if (!this.hasSchema(value)) state.add(path, "unknown_schema", `the ${key} schema ${JSON.stringify(value)} is not defined in "schemas"`);
    }
    if (Object.hasOwn(doc, "workflows")) {
      const workflows = doc["workflows"];
      const path = pathProperty(base, "workflows");
      if (!isJsonObject(workflows)) state.add(path, "shape", `"workflows" must be an object of workflow documents`);
      else for (const name of Object.keys(workflows)) checkDocument(state, workflows[name], pathProperty(path, name));
    }
    if (!Object.hasOwn(doc, "root")) state.add(pathProperty(base, "root"), "shape", `the document needs a "root" node`);
    else this.checkNode(doc["root"], pathProperty(base, "root"));
    const resultPath = pathProperty(base, "result");
    if (!Object.hasOwn(doc, "result")) {
      state.add(resultPath, "shape", `the document needs a "result" expression`);
    } else {
      const result = doc["result"] ?? null;
      this.checkExpr(result, resultPath, null, "normal");
      if (typeof doc["output"] === "string" && this.hasSchema(doc["output"])) {
        this.assignToNamed(result, resultPath, doc, doc["output"], null, null);
      }
    }
  }

  checkSchemas(): void {
    const path = pathProperty(this.base, "schemas");
    const schemas = this.doc["schemas"];
    if (!isJsonObject(schemas)) {
      this.state.add(path, "shape", `"schemas" must be an object of named JSON Schemas`);
      return;
    }
    for (const name of Object.keys(schemas)) {
      const schemaPath = pathProperty(path, name);
      for (const problem of checkSchema(schemas[name], { definitions: schemas as Record<string, JsonSchema> })) {
        this.state.add(joinPath(schemaPath, problem.path), "invalid_schema", `schema ${JSON.stringify(name)}: ${problem.message}`);
      }
    }
  }

  /** Reports what is provably wrong (Rule P) about `expr`, evaluated at `entry`, flowing into the named schema of `target`. */
  assignToNamed(expr: Json, path: string, target: JsonObject, schemaName: string, entry: IndexedNode | null, nodeId: string | null): void {
    let schema: JsonSchema;
    try {
      schema = bundleSchema(target as unknown as WorkflowDocument, schemaName);
    } catch {
      return;
    }
    if (checkSchema(schema).length > 0) return;
    for (const problem of this.assign(expr, path, schema, schema, entry, "normal")) {
      this.state.add(problem.path, "schema_mismatch", `does not fit schema ${JSON.stringify(schemaName)}: ${problem.message}`, "error", nodeId);
    }
  }

  assign(expr: Json, path: string, schema: JsonSchema, root: JsonSchema, entry: IndexedNode | null, field: Field): { path: string; message: string }[] {
    return checkAssignable({ expr, path, schema, root, refOf: (refPath) => {
      const result = this.analyzeRef(refPath, entry, field);
      return { shape: result.shape, presence: result.presence };
    } });
  }

  checkNode(value: unknown, path: string): void {
    const { state } = this;
    if (!isJsonObject(value)) {
      state.add(path, "shape", "a node must be an object");
      return;
    }
    const rawId = value["id"];
    const id = typeof rawId === "string" ? rawId : null;
    if (!Object.hasOwn(value, "id")) state.add(path, "shape", `the node needs an "id"`);
    else if (id === null) state.add(pathProperty(path, "id"), "shape", `"id" must be a string`);
    else if (!NODE_ID_PATTERN.test(id)) state.add(pathProperty(path, "id"), "duplicate_id", `node id ${JSON.stringify(id)} must match ${NODE_ID_PATTERN.source}`, "error", id);
    else if (this.seenIds.has(id)) state.add(pathProperty(path, "id"), "duplicate_id", `node id ${JSON.stringify(id)} is already used at ${this.seenIds.get(id)}`, "error", id);
    else this.seenIds.set(id, path);
    const kind = value["kind"];
    if (typeof kind !== "string") {
      state.add(pathProperty(path, "kind"), "shape", `the node needs a "kind" string`, "error", id);
      return;
    }
    if (!isKnownKind(kind)) {
      state.add(pathProperty(path, "kind"), "unknown_kind", `unknown node kind ${JSON.stringify(kind)}; expected one of ${NODE_KINDS.join(", ")}`, "error", id);
      return;
    }
    const entry = this.entryOf.get(value) as IndexedNode;
    if (Object.hasOwn(value, "title") && typeof value["title"] !== "string") state.add(pathProperty(path, "title"), "shape", `"title" must be a string`, "error", id);
    const allowed = new Set([...COMMON_KEYS, ...(KIND_KEYS[kind] ?? [])]);
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) state.add(pathProperty(path, key), "shape", `unknown field ${JSON.stringify(key)} on a ${kind} node`, "warning", id);
    }
    this.checkRetryAndDeadline(value, path, kind, id);
    this.checkKind(value, path, entry, id);
    for (const slot of childSlots(value, path)) this.checkNode(slot.value, slot.path);
  }

  need(node: JsonObject, key: string, path: string, id: string | null, test: (v: unknown) => boolean, what: string): boolean {
    if (!Object.hasOwn(node, key)) {
      this.state.add(path, "shape", `a ${String(node["kind"])} node needs "${key}"`, "error", id);
      return false;
    }
    if (!test(node[key])) {
      this.state.add(pathProperty(path, key), "shape", `"${key}" must be ${what}`, "error", id);
      return false;
    }
    return true;
  }

  optional(node: JsonObject, key: string, path: string, id: string | null, test: (v: unknown) => boolean, what: string): boolean {
    if (!Object.hasOwn(node, key)) return false;
    if (!test(node[key])) {
      this.state.add(pathProperty(path, key), "shape", `"${key}" must be ${what}`, "error", id);
      return false;
    }
    return true;
  }

  checkRetryAndDeadline(node: JsonObject, path: string, kind: string, id: string | null): void {
    const { state } = this;
    if (Object.hasOwn(node, "deadlineMs")) {
      const at = pathProperty(path, "deadlineMs");
      if (!isInteger(node["deadlineMs"]) || node["deadlineMs"] <= 0 || node["deadlineMs"] > MAX_TIMER_MS) {
        state.add(at, "bad_deadline", `"deadlineMs" must be a positive integer number of milliseconds, at most ${MAX_TIMER_MS} (about 24.8 days)`, "error", id);
      } else if (INERT_DEADLINE_KINDS.has(kind)) {
        state.add(at, "bad_deadline", `"deadlineMs" has no effect on a ${kind} node`, "warning", id);
      }
    }
    if (!Object.hasOwn(node, "retry")) return;
    const at = pathProperty(path, "retry");
    if (!RETRY_KINDS.has(kind)) {
      state.add(at, "retry_unsafe", `"retry" is only allowed on tool, model and decide nodes`, "error", id);
      return;
    }
    const retry = node["retry"];
    if (!isJsonObject(retry)) {
      state.add(at, "shape", `"retry" must be an object {maxAttempts, backoffMs, factor?, maxBackoffMs?}`, "error", id);
      return;
    }
    const attempts = retry["maxAttempts"];
    if (!isInteger(attempts) || attempts < 1 || attempts > 10) state.add(pathProperty(at, "maxAttempts"), "missing_bound", `"retry.maxAttempts" must be an integer from 1 to 10`, "error", id);
    if (!isTimerMs(retry["backoffMs"])) state.add(pathProperty(at, "backoffMs"), "missing_bound", `"retry.backoffMs" must be a number from 0 to ${MAX_TIMER_MS}`, "error", id);
    if (Object.hasOwn(retry, "factor") && !isFactor(retry["factor"])) state.add(pathProperty(at, "factor"), "shape", `"retry.factor" must be a finite number >= 1`, "error", id);
    if (Object.hasOwn(retry, "maxBackoffMs") && !isTimerMs(retry["maxBackoffMs"])) state.add(pathProperty(at, "maxBackoffMs"), "shape", `"retry.maxBackoffMs" must be a number from 0 to ${MAX_TIMER_MS}`, "error", id);
    for (const key of Object.keys(retry)) {
      if (!["maxAttempts", "backoffMs", "factor", "maxBackoffMs"].includes(key)) state.add(pathProperty(at, key), "shape", `unknown retry field ${JSON.stringify(key)}`, "warning", id);
    }
    if (kind === "tool" && node["idempotent"] !== true) {
      if (state.options.tools === undefined) {
        state.add(at, "retry_unsafe", `cannot confirm that tool ${JSON.stringify(node["tool"])} is safe to retry; mark the node "idempotent": true`, "warning", id);
      } else if (state.tool(node["tool"])?.retrySafe !== true) {
        state.add(at, "retry_unsafe", `tool ${JSON.stringify(node["tool"])} is not safe to retry: it is not read-only or idempotent and the node is not marked "idempotent": true`, "error", id);
      }
    }
  }

  checkKind(node: JsonObject, path: string, entry: IndexedNode, id: string | null): void {
    const { state } = this;
    const isString = (v: unknown): boolean => typeof v === "string";
    const isNonEmpty = (v: unknown): boolean => typeof v === "string" && v.length > 0;
    const isStrings = (v: unknown): boolean => Array.isArray(v) && v.every((s) => typeof s === "string");
    const isNodeList = (v: unknown): boolean => Array.isArray(v);
    const template = (key: string): void => {
      if (typeof node[key] === "string") this.checkExpr(node[key], pathProperty(path, key), entry, "normal");
    };
    switch (entry.kind) {
      case "tool": {
        this.need(node, "tool", path, id, isNonEmpty, "a tool name");
        const argsOk = this.need(node, "args", path, id, isJsonObject, "an object of argument expressions") && this.argsMap(node["args"] as JsonObject, path, id);
        this.optional(node, "idempotent", path, id, (v) => typeof v === "boolean", "a boolean");
        this.optional(node, "onError", path, id, (v) => v === "fail" || v === "continue", `"fail" or "continue"`);
        if (argsOk) {
          const args = node["args"] as JsonObject;
          for (const name of Object.keys(args)) this.checkExpr(args[name] ?? null, pathProperty(pathProperty(path, "args"), name), entry, "normal");
        }
        if (typeof node["tool"] === "string" && state.options.tools !== undefined) {
          const tool = state.tool(node["tool"]);
          if (tool === undefined) state.add(pathProperty(path, "tool"), "unknown_tool", `unknown tool ${JSON.stringify(node["tool"])}`, "error", id);
          else if (argsOk) this.checkToolArgs(node["args"] as JsonObject, pathProperty(path, "args"), tool.name, tool.parameters, entry, id);
        }
        break;
      }
      case "model":
        this.need(node, "prompt", path, id, isString, "a template string");
        this.optional(node, "system", path, id, isString, "a template string");
        if (this.need(node, "output", path, id, isString, "a schema name") && !this.hasSchema(node["output"])) {
          state.add(pathProperty(path, "output"), "unknown_schema", `the output schema ${JSON.stringify(node["output"])} is not defined in "schemas"`, "error", id);
        }
        template("prompt");
        template("system");
        break;
      case "decide":
        this.need(node, "question", path, id, isString, "a template string");
        template("question");
        this.checkDecide(node, path, entry, id);
        break;
      case "branch":
        this.checkBranch(node, path, entry, id);
        break;
      case "sequence":
        if (this.need(node, "steps", path, id, isNodeList, "an array of nodes")) this.checkAfterFail(node["steps"] as unknown[], pathProperty(path, "steps"), id);
        break;
      case "parallel":
        this.need(node, "branches", path, id, isNodeList, "an array of nodes");
        break;
      case "map":
        this.checkMap(node, path, entry, id);
        break;
      case "loop":
        this.checkLoop(node, path, entry, id);
        break;
      case "call":
        this.checkCall(node, path, entry, id);
        break;
      case "agent": {
        this.need(node, "message", path, id, isString, "a template string");
        this.optional(node, "instructions", path, id, isString, "a template string");
        template("message");
        template("instructions");
        if (this.optional(node, "tools", path, id, isStrings, "an array of tool names") && state.options.tools !== undefined) {
          (node["tools"] as string[]).forEach((name, i) => {
            if (state.tool(name) === undefined) state.add(pathIndex(pathProperty(path, "tools"), i), "unknown_tool", `unknown tool ${JSON.stringify(name)}`, "error", id);
          });
        }
        if (this.optional(node, "output", path, id, isString, "a schema name") && !this.hasSchema(node["output"])) {
          state.add(pathProperty(path, "output"), "unknown_schema", `the output schema ${JSON.stringify(node["output"])} is not defined in "schemas"`, "error", id);
        }
        const turns = node["maxTurns"];
        if (!isInteger(turns) || turns < 1 || turns > MAX_AGENT_TURNS) {
          state.add(pathProperty(path, "maxTurns"), "missing_bound", `an agent node needs "maxTurns", an integer from 1 to ${MAX_AGENT_TURNS}`, "error", id);
        }
        break;
      }
      case "wait":
        this.need(node, "question", path, id, isString, "a template string");
        this.optional(node, "choices", path, id, isStrings, "an array of strings");
        template("question");
        break;
      case "fail":
        this.need(node, "message", path, id, isString, "a template string");
        template("message");
        break;
    }
  }

  /** False, with the `shape` error at `args`, when `args` is a `$ref` or `$literal` form (well-formed or not) instead of a map of argument expressions. */
  argsMap(args: JsonObject, path: string, id: string | null): boolean {
    if (refForm(args) === null) return true;
    this.state.add(pathProperty(path, "args"), "shape", ARGS_MAP_MESSAGE, "error", id);
    return false;
  }

  checkToolArgs(args: JsonObject, path: string, name: string, parameters: JsonSchema, entry: IndexedNode, id: string | null): void {
    const required = Array.isArray(parameters["required"]) ? parameters["required"] : [];
    const missing = new Set<string>();
    for (const key of required) {
      if (typeof key === "string" && !Object.hasOwn(args, key)) {
        missing.add(pathProperty(path, key));
        this.state.add(path, "schema_mismatch", `tool ${JSON.stringify(name)} needs the argument ${JSON.stringify(key)}`, "error", id);
      }
    }
    for (const problem of this.assign(args, path, parameters, parameters, entry, "normal")) {
      if (missing.has(problem.path)) continue;
      this.state.add(problem.path, "schema_mismatch", `argument does not fit tool ${JSON.stringify(name)}: ${problem.message}`, "error", id);
    }
  }

  checkDecide(node: JsonObject, path: string, entry: IndexedNode, id: string | null): void {
    const { state } = this;
    const at = pathProperty(path, "decision");
    const decision = node["decision"];
    let spec: DecisionSpec | null = null;
    if (!Object.hasOwn(node, "decision")) state.add(path, "shape", `a decide node needs "decision"`, "error", id);
    else if (!isJsonObject(decision)) state.add(at, "shape", `"decision" must be an object with a "type"`, "error", id);
    else if (decision["type"] === "yes_no") spec = { type: "yes_no" };
    else if (decision["type"] === "pick_one") {
      const options = decision["options"];
      if (!Array.isArray(options) || !options.every((o) => typeof o === "string")) {
        state.add(pathProperty(at, "options"), "shape", `"options" must be an array of strings`, "error", id);
      } else if (options.length < 2) {
        state.add(pathProperty(at, "options"), "schema_mismatch", `a pick_one decision needs at least two options`, "error", id);
      } else if (new Set(options).size !== options.length) {
        state.add(pathProperty(at, "options"), "schema_mismatch", `pick_one options must be unique`, "error", id);
      } else spec = { type: "pick_one", options: options as string[] };
    } else if (decision["type"] === "score") {
      const min = decision["min"];
      const max = decision["max"];
      if (!isFiniteNumber(min) || !isFiniteNumber(max)) state.add(at, "shape", `a score decision needs finite numeric "min" and "max"`, "error", id);
      else if (min >= max) state.add(at, "schema_mismatch", `a score decision needs "min" < "max" (got ${min} and ${max})`, "error", id);
      else spec = { type: "score", min, max };
    } else state.add(pathProperty(at, "type"), "shape", `"decision.type" must be "yes_no", "pick_one" or "score"`, "error", id);

    if (!Object.hasOwn(node, "lowConfidence")) return;
    const lowPath = pathProperty(path, "lowConfidence");
    const low = node["lowConfidence"];
    if (!isJsonObject(low)) {
      state.add(lowPath, "shape", `"lowConfidence" must be an object {below, run, value?}`, "error", id);
      return;
    }
    const below = low["below"];
    if (!isFiniteNumber(below)) state.add(pathProperty(lowPath, "below"), "shape", `"lowConfidence.below" must be a finite number`, "error", id);
    else if (!(below > 0 && below <= 1)) state.add(pathProperty(lowPath, "below"), "schema_mismatch", `"lowConfidence.below" must be in (0, 1], got ${below}`, "error", id);
    if (!Object.hasOwn(low, "run")) state.add(lowPath, "shape", `"lowConfidence" needs a "run" node`, "error", id);
    for (const key of Object.keys(low)) {
      if (!["below", "run", "value"].includes(key)) state.add(pathProperty(lowPath, key), "shape", `unknown lowConfidence field ${JSON.stringify(key)}`, "warning", id);
    }
    if (!Object.hasOwn(low, "value")) return;
    const value = low["value"] ?? null;
    const valuePath = pathProperty(lowPath, "value");
    this.checkExpr(value, valuePath, entry, "lcValue");
    if (spec === null) return;
    if (isLiteralExpr(value)) {
      let literal: Json = null;
      try {
        literal = resolveValue(value, EMPTY_SCOPE);
      } catch {
        return;
      }
      if (!checkDecisionValue(spec, literal)) state.add(valuePath, "schema_mismatch", `the fallback value does not fit the ${spec.type} decision`, "error", id);
      return;
    }
    const schema = decisionValueSchema(spec);
    for (const problem of this.assign(value, valuePath, schema, schema, entry, "lcValue")) {
      state.add(problem.path, "schema_mismatch", `the fallback value does not fit the ${spec.type} decision: ${problem.message}`, "error", id);
    }
  }

  checkBranch(node: JsonObject, path: string, entry: IndexedNode, id: string | null): void {
    const { state } = this;
    if (!Object.hasOwn(node, "on")) state.add(path, "shape", `a branch node needs "on"`, "error", id);
    else this.checkExpr(node["on"] ?? null, pathProperty(path, "on"), entry, "normal");
    const casesPath = pathProperty(path, "cases");
    if (!this.need(node, "cases", path, id, Array.isArray, "an array of {when, run}")) return;
    const onExpr = node["on"];
    const onForm = isJsonObject(onExpr) ? refForm(onExpr) : null;
    const onShape = onForm?.kind === "ref" ? this.refShape(onForm.path, onForm.fallback, entry) : UNKNOWN_SHAPE;
    const resolved = shapeTypes(onShape) === null ? null : onShape;
    const seen = new Set<string>();
    const cases = node["cases"] as unknown[];
    cases.forEach((entryValue, i) => {
      const casePath = pathIndex(casesPath, i);
      if (!isJsonObject(entryValue)) {
        state.add(casePath, "shape", "a case must be an object {when, run}", "error", id);
        return;
      }
      for (const key of Object.keys(entryValue)) {
        if (key !== "when" && key !== "run") state.add(pathProperty(casePath, key), "shape", `unknown case field ${JSON.stringify(key)}`, "warning", id);
      }
      if (!Object.hasOwn(entryValue, "run")) state.add(casePath, "shape", `a case needs a "run" node`, "error", id);
      if (!Object.hasOwn(entryValue, "when")) {
        state.add(casePath, "shape", `a case needs a "when" value`, "error", id);
        return;
      }
      const when = entryValue["when"] ?? null;
      const key = canonicalJson(when);
      if (seen.has(key)) {
        state.add(casePath, "unreachable", `case ${i} repeats the earlier "when" ${key} and can never run`, "error", id);
        return;
      }
      seen.add(key);
      if (resolved !== null) this.checkWhen(when, resolved, pathProperty(casePath, "when"), casePath, i, id);
    });
    if (Object.hasOwn(node, "default") && resolved !== null && this.isExhaustive(resolved, seen)) {
      state.add(pathProperty(path, "default"), "unreachable", `the cases cover every possible value of "on", so the default can never run`, "error", id);
    }
  }

  checkWhen(when: Json, shape: Shape, whenPath: string, casePath: string, i: number, id: string | null): void {
    if (shape.t === "schema") {
      const problems = validateSubschema(shape.root, shape.schema, when, { definitions: shape.defs });
      const typeProblem = problems.find((p) => p.keyword === "type" && p.path === "$");
      if (typeProblem !== undefined) {
        this.state.add(whenPath, "schema_mismatch", `"when" ${canonicalJson(when)} has the wrong type for "on": ${typeProblem.message}`, "error", id);
      } else if (problems.length > 0) {
        this.state.add(casePath, "unreachable", `case ${i} can never match: ${problems[0]?.message ?? ""}`, "error", id);
      }
      return;
    }
    const expected = shape.t === "list" ? "array" : "object";
    const actual = Array.isArray(when) ? "array" : when === null ? "null" : typeof when;
    if (actual !== expected) this.state.add(whenPath, "schema_mismatch", `"when" ${canonicalJson(when)} is ${actual}, but "on" is ${expected}`, "error", id);
  }

  isExhaustive(shape: Shape, seen: Set<string>): boolean {
    if (shape.t !== "schema") return false;
    const types = shapeTypes(shape);
    if (types !== null && types.length === 1 && types[0] === "boolean" && !Object.hasOwn(shape.schema, "enum") && !Object.hasOwn(shape.schema, "const")) {
      return seen.has("true") && seen.has("false");
    }
    const values = shape.schema["enum"];
    return Array.isArray(values) && values.length > 0 && values.every((v) => seen.has(canonicalJson(v)));
  }

  checkAfterFail(steps: unknown[], path: string, id: string | null): void {
    let stopped = false;
    steps.forEach((step, i) => {
      if (stopped) {
        const stepId = isJsonObject(step) && typeof step["id"] === "string" ? step["id"] : id;
        this.state.add(pathIndex(path, i), "unreachable", `step ${i} comes after a step that always fails and can never run`, "error", stepId);
      } else if (neverReturns(step)) stopped = true;
    });
  }

  checkMap(node: JsonObject, path: string, entry: IndexedNode, id: string | null): void {
    const { state } = this;
    if (!Object.hasOwn(node, "over")) state.add(path, "shape", `a map node needs "over"`, "error", id);
    else {
      const over = node["over"] ?? null;
      this.checkExpr(over, pathProperty(path, "over"), entry, "normal");
      const schema: JsonSchema = { type: "array" };
      for (const problem of this.assign(over, pathProperty(path, "over"), schema, schema, entry, "normal")) {
        state.add(problem.path, "schema_mismatch", `"over" must be an array: ${problem.message}`, "error", id);
      }
    }
    this.need(node, "as", path, id, (v) => typeof v === "string" && AS_PATTERN.test(v), `a variable name matching ${AS_PATTERN.source}`);
    const concurrency = node["concurrency"];
    if (!isInteger(concurrency) || concurrency < 1 || concurrency > 64) {
      state.add(pathProperty(path, "concurrency"), "missing_bound", `a map node needs "concurrency", an integer from 1 to 64`, "error", id);
    }
    const maxItems = node["maxItems"];
    if (!isInteger(maxItems) || maxItems < 0 || maxItems > MAX_MAP_ITEMS) {
      state.add(pathProperty(path, "maxItems"), "missing_bound", `a map node needs "maxItems", an integer from 0 to ${MAX_MAP_ITEMS}`, "error", id);
    } else if (Object.hasOwn(node, "over")) {
      const bound: JsonSchema = { maxItems };
      for (const problem of this.assign(node["over"] ?? null, pathProperty(path, "over"), bound, bound, entry, "normal")) {
        state.add(problem.path, "schema_mismatch", `"over" is longer than "maxItems": ${problem.message}`, "error", id);
      }
    }
    if (!Object.hasOwn(node, "run")) state.add(path, "shape", `a map node needs a "run" node`, "error", id);
    else if (maxItems === 0) state.add(pathProperty(path, "run"), "unreachable", `"maxItems" is 0, so the map body can never run`, "error", id);
  }

  checkLoop(node: JsonObject, path: string, entry: IndexedNode, id: string | null): void {
    const { state } = this;
    const max = node["maxIterations"];
    if (!isInteger(max) || max < 0 || max > MAX_LOOP_ITERATIONS) {
      state.add(pathProperty(path, "maxIterations"), "missing_bound", `a loop node needs "maxIterations", an integer from 0 to ${MAX_LOOP_ITERATIONS}`, "error", id);
    }
    this.optional(node, "onLimit", path, id, (v) => v === "fail" || v === "continue", `"fail" or "continue"`);
    if (!Object.hasOwn(node, "until")) state.add(path, "shape", `a loop node needs an "until" condition`, "error", id);
    else this.checkCondition(node["until"], pathProperty(path, "until"), entry, id);
    if (!Object.hasOwn(node, "run")) state.add(path, "shape", `a loop node needs a "run" node`, "error", id);
    else if (max === 0) state.add(pathProperty(path, "run"), "unreachable", `"maxIterations" is 0, so the loop body can never run`, "error", id);
  }

  checkCondition(condition: unknown, path: string, entry: IndexedNode, id: string | null): void {
    const operator = conditionOperator(condition);
    if (operator === null) {
      this.state.add(path, "shape", `a condition must be an object with exactly one of eq, ne, gt, gte, lt, lte, and, or, not, exists, truthy`, "error", id);
      return;
    }
    const value = (condition as JsonObject)[operator] ?? null;
    const at = pathProperty(path, operator);
    switch (operator) {
      case "eq": case "ne": case "gt": case "gte": case "lt": case "lte":
        if (!Array.isArray(value) || value.length !== 2) this.state.add(at, "shape", `"${operator}" takes an array of two expressions`, "error", id);
        else value.forEach((operand, i) => this.checkExpr(operand, pathIndex(at, i), entry, "until"));
        break;
      case "and": case "or":
        if (!Array.isArray(value)) this.state.add(at, "shape", `"${operator}" takes an array of conditions`, "error", id);
        else value.forEach((sub, i) => this.checkCondition(sub, pathIndex(at, i), entry, id));
        break;
      case "not":
        this.checkCondition(value, at, entry, id);
        break;
      case "exists":
        if (typeof value !== "string") this.state.add(at, "shape", `"exists" takes a reference path string`, "error", id);
        else this.checkRef(value, true, at, entry, "until");
        break;
      case "truthy":
        this.checkExpr(value, at, entry, "until");
        break;
    }
  }

  checkCall(node: JsonObject, path: string, entry: IndexedNode, id: string | null): void {
    const { state } = this;
    if (!this.need(node, "workflow", path, id, (v) => typeof v === "string" && v.length > 0, "a workflow name")) return;
    const name = node["workflow"] as string;
    if (!Object.hasOwn(node, "input")) state.add(path, "shape", `a call node needs "input"`, "error", id);
    else this.checkExpr(node["input"] ?? null, pathProperty(path, "input"), entry, "normal");
    const target = resolveTarget(state, this.doc, name);
    if (target === null) {
      if (state.options.resolveWorkflow === undefined) {
        state.add(pathProperty(path, "workflow"), "unknown_workflow", `workflow ${JSON.stringify(name)} is not inline; it must exist as a saved workflow when the run starts`, "warning", id);
      } else {
        state.add(pathProperty(path, "workflow"), "unknown_workflow", `unknown workflow ${JSON.stringify(name)}: not in "workflows" and not a saved workflow`, "error", id);
      }
      return;
    }
    if (Object.hasOwn(node, "input") && typeof target.doc["input"] === "string") {
      this.assignToNamed(node["input"] ?? null, pathProperty(path, "input"), target.doc, target.doc["input"], entry, id);
    }
  }

  checkExpr(expr: Json, path: string, entry: IndexedNode | null, field: Field): void {
    this.reportMalformed(expr, path, entry);
    for (const ref of listRefs(expr)) this.checkRef(ref.path, ref.hasDefault, joinPath(path, ref.at), entry, field);
  }

  reportMalformed(expr: Json, path: string, entry: IndexedNode | null): void {
    if (Array.isArray(expr)) {
      expr.forEach((item, i) => this.reportMalformed(item, pathIndex(path, i), entry));
      return;
    }
    if (!isJsonObject(expr)) return;
    const form = refForm(expr);
    if (form?.kind === "malformed") {
      this.state.add(path, "bad_reference", form.message, "error", entry?.id);
      return;
    }
    if (form !== null) return;
    for (const key of Object.keys(expr)) this.reportMalformed(expr[key] ?? null, pathProperty(path, key), entry);
  }

  checkRef(refPath: string, hasDefault: boolean, at: string, entry: IndexedNode | null, field: Field): void {
    const result = this.analyzeRef(refPath, entry, field);
    for (const problem of result.problems) {
      if (problem.code === "conditional_reference" && hasDefault) continue;
      this.state.add(at, problem.code, problem.message, problem.severity, entry?.id);
    }
  }

  /**
   * The shape a reference's value has, for a check that needs the value itself (a branch's `on`, a map's `over`):
   * the referenced shape, unless the reference has a default and may be missing, when the value may be the
   * default instead.
   */
  refShape(refPath: string, fallback: Json | undefined, entry: IndexedNode): Shape {
    const result = this.analyzeRef(refPath, entry, "normal");
    return fallback === undefined || result.presence === "always" ? result.shape : UNKNOWN_SHAPE;
  }

  /**
   * The static shape of a reference evaluated at `entry`, its problems, and whether it always resolves there:
   * `presence` is "always" when its root always exists at that point and every remaining segment is always
   * present in the root's shape (`pathAlwaysPresent`); "maybe" otherwise.
   */
  analyzeRef(refPath: string, entry: IndexedNode | null, field: Field): RefAnalysis {
    const problems: RefAnalysis["problems"] = [];
    const fail = (code: WorkflowProblemCode, message: string): RefAnalysis => {
      problems.push({ code, message, severity: "error" });
      return { shape: UNKNOWN_SHAPE, presence: "maybe", problems };
    };
    let segments: (string | number)[];
    try {
      segments = parseRefPath(refPath);
    } catch (error) {
      return fail("bad_reference", error instanceof Error ? error.message : String(error));
    }
    const label = JSON.stringify(refPath);
    let shape: Shape;
    let rest: (string | number)[];
    let rootAlways = true;
    switch (segments[0]) {
      case "input":
        shape = namedShape(this.doc["schemas"], this.doc["input"]);
        rest = segments.slice(1);
        break;
      case "steps": {
        const id = segments[1];
        if (typeof id !== "string") return fail("bad_reference", `reference ${label} must name a node: steps.<nodeId>`);
        const target = this.index.byId.get(id);
        if (target === undefined) return fail("unknown_reference", `reference ${label}: there is no node ${JSON.stringify(id)} in this workflow`);
        const visibility = this.visibility(entry, field, target);
        if (visibility.kind === "hidden") return fail("unknown_reference", `reference ${label} is not visible here: ${visibility.reason}`);
        if (visibility.kind === "conditional") {
          rootAlways = false;
          problems.push({
            code: "conditional_reference",
            severity: "error",
            message: `reference ${label}: node ${JSON.stringify(id)} may not have run (it sits inside a branch, low-confidence route, map or loop); use {"$ref": ..., "default": ...} to give a value for that case`,
          });
        }
        shape = nodeShape(this.shapes, target);
        rest = segments.slice(2);
        break;
      }
      case "vars": {
        const name = segments[1];
        if (typeof name !== "string" || segments.length < 2) return fail("bad_reference", `reference ${label} must name a variable: vars.<name>`);
        const map = entry === null ? undefined : [entry, ...ancestorsOf(this.index, entry)].find((candidate) =>
          candidate.key !== entry.key && candidate.kind === "map" && (candidate.node["as"] === name || `${String(candidate.node["as"])}_index` === name));
        if (map === undefined) return fail("bad_reference", `reference ${label}: no enclosing map defines the variable ${JSON.stringify(name)}`);
        if (map.node["as"] === name) {
          const over = map.node["over"] ?? null;
          const form = isJsonObject(over) ? refForm(over) : null;
          shape = form?.kind === "ref" ? itemShape(this.refShape(form.path, form.fallback, map)) : UNKNOWN_SHAPE;
        } else shape = plainShape({ type: "integer", minimum: 0 });
        rest = segments.slice(2);
        break;
      }
      case "loop": {
        const loopId = segments[1];
        const target = typeof loopId === "string" ? this.index.byId.get(loopId) : undefined;
        const inside = target !== undefined && target.kind === "loop" && entry !== null &&
          (isAncestor(this.index, target, entry) || (target.key === entry.key && field === "until"));
        if (!inside) return fail("bad_reference", `reference ${label}: "loop.<id>" is only available inside loop ${JSON.stringify(String(loopId))}`);
        const part = segments[2];
        const body = childrenOf(this.index, target).find((child) => child.relation === "body");
        rest = segments.slice(3);
        // `last` is null in the first iteration: its value has the body's shape only once a path steps into it.
        const lastShape = body === undefined || rest.length === 0 ? UNKNOWN_SHAPE : nodeShape(this.shapes, body);
        if (part === undefined) shape = { t: "record", fields: { index: plainShape({ type: "integer" }), last: UNKNOWN_SHAPE } };
        else if (part === "index") shape = plainShape({ type: "integer", minimum: 0 });
        else if (part === "last") {
          shape = lastShape;
          // `last` itself is always there, but it is null until the first iteration ends: nothing below it is.
          rootAlways = rest.length === 0;
        }
        else return fail("bad_reference", `reference ${label}: a loop exposes only "index" and "last"`);
        break;
      }
      case "run": {
        const part = segments[1];
        if ((part !== "id" && part !== "agentId") || segments.length !== 2) return fail("bad_reference", `reference ${label}: "run" exposes only run.id and run.agentId`);
        shape = plainShape({ type: "string" });
        rest = [];
        break;
      }
      default: {
        if (field !== "lcValue" || entry === null) return fail("bad_reference", `reference ${label}: "fallback" is only available in lowConfidence.value`);
        const low = childrenOf(this.index, entry).find((child) => child.relation === "low_confidence");
        shape = low === undefined ? UNKNOWN_SHAPE : nodeShape(this.shapes, low);
        rest = segments.slice(1);
        break;
      }
    }
    const step = walkShape(shape, rest);
    if (step.problem !== null) {
      const consumed = segments.length - rest.length + step.problem.segment;
      const prefix = segments.slice(0, consumed).join(".");
      problems.push({ code: "schema_mismatch", severity: step.problem.severity, message: `reference ${label}: ${prefix} ${step.problem.message}` });
    }
    const presence = rootAlways && step.problem === null && pathAlwaysPresent(shape, rest) ? "always" : "maybe";
    return { shape: step.shape, presence, problems };
  }

  visibility(from: IndexedNode | null, field: Field, target: IndexedNode): Visibility {
    const index = this.index;
    const verdict = (top: IndexedNode): Visibility => (reachedUnconditionally(index, top, target) ? { kind: "visible" } : { kind: "conditional" });
    if (from === null) return index.root === null ? { kind: "conditional" } : verdict(index.root);
    if (field !== "normal") {
      const relation = field === "until" ? "body" : "low_confidence";
      const body = childrenOf(index, from).find((child) => child.relation === relation);
      if (body !== undefined && (body.key === target.key || isAncestor(index, body, target))) return verdict(body);
    }
    if (target.key === from.key) return { kind: "hidden", reason: "a node cannot reference its own output" };
    if (isAncestor(index, target, from)) return { kind: "hidden", reason: `node ${JSON.stringify(target.id)} encloses this node and has not finished yet` };
    if (isAncestor(index, from, target)) return { kind: "hidden", reason: `node ${JSON.stringify(target.id)} runs inside this node, after this value is needed` };
    const fromChain = new Map<number, IndexedNode>();
    let previous: IndexedNode = from;
    for (const ancestor of ancestorsOf(index, from)) {
      fromChain.set(ancestor.key, previous);
      previous = ancestor;
    }
    let targetChild: IndexedNode = target;
    for (const ancestor of ancestorsOf(index, target)) {
      const fromChild = fromChain.get(ancestor.key);
      if (fromChild !== undefined) {
        if (ancestor.kind === "sequence" && targetChild.index < fromChild.index) return verdict(targetChild);
        if (ancestor.kind === "sequence") return { kind: "hidden", reason: `node ${JSON.stringify(target.id)} runs later in the sequence ${JSON.stringify(ancestor.id)}` };
        return { kind: "hidden", reason: `node ${JSON.stringify(target.id)} runs in a different part of ${ancestor.kind} ${JSON.stringify(ancestor.id)}` };
      }
      targetChild = ancestor;
    }
    return { kind: "hidden", reason: `node ${JSON.stringify(target.id)} is not on this node's path` };
  }
}

function neverReturns(node: unknown): boolean {
  if (!isJsonObject(node)) return false;
  switch (node["kind"]) {
    case "fail": return true;
    case "sequence": return Array.isArray(node["steps"]) && node["steps"].some(neverReturns);
    case "parallel": return Array.isArray(node["branches"]) && node["branches"].some(neverReturns);
    default: return false;
  }
}

function checkDocument(state: State, document: unknown, base: string): void {
  if (!isJsonObject(document)) {
    state.add(base, "shape", "a workflow document must be an object");
    return;
  }
  new DocumentChecker(state, document, base).run();
}

interface CallEdge { path: string | null; target: { doc: JsonObject; key: string; label: string; base: string | null } }

function callEdges(state: State, doc: JsonObject, base: string | null): CallEdge[] {
  const edges: CallEdge[] = [];
  const index = indexNodes(doc["root"], base === null ? "$.root" : pathProperty(base, "root"));
  for (const entry of index.nodes) {
    if (entry.kind !== "call" || typeof entry.node["workflow"] !== "string") continue;
    const target = resolveTarget(state, doc, entry.node["workflow"]);
    if (target === null) continue;
    const targetBase = target.inline && base !== null ? pathProperty(pathProperty(base, "workflows"), target.label) : target.key === "top" ? "$" : null;
    edges.push({ path: base === null ? null : pathProperty(entry.path, "workflow"), target: { doc: target.doc, key: target.key, label: target.label, base: targetBase } });
  }
  return edges;
}

/** Reports each cycle through `call` nodes once, with the chain of workflow names in the message. */
function checkCallCycles(state: State, top: JsonObject): void {
  const keys = new Map<object, string>();
  let counter = 0;
  const keyOf = (doc: JsonObject, hint: string): string => {
    if (hint !== "") return hint;
    let key = keys.get(doc);
    if (key === undefined) {
      key = `inline:${counter++}`;
      keys.set(doc, key);
    }
    return key;
  };
  const done = new Set<string>();
  const reported = new Set<string>();
  const stack: { key: string; label: string; via: string | null }[] = [];
  const onStack = new Map<string, number>();
  let visits = 0;
  const visit = (doc: JsonObject, key: string, label: string, base: string | null, via: string | null): void => {
    if (++visits > 2000) return;
    stack.push({ key, label, via });
    onStack.set(key, stack.length - 1);
    for (const edge of callEdges(state, doc, base)) {
      const targetKey = keyOf(edge.target.doc, edge.target.key);
      const position = onStack.get(targetKey);
      if (position !== undefined) {
        const cycle = stack.slice(position);
        const ids = cycle.map((frame) => frame.key);
        const minAt = ids.indexOf([...ids].sort()[0] as string);
        const canonical = [...ids.slice(minAt), ...ids.slice(0, minAt)].join(" ");
        if (reported.has(canonical)) continue;
        reported.add(canonical);
        const vias = [...cycle.slice(1).map((frame) => frame.via), edge.path];
        const path = vias.find((p) => p !== null) ?? [...stack].reverse().map((f) => f.via).find((p) => p !== null) ?? "$.root";
        const chain = [...cycle.map((frame) => frame.label), edge.target.label].join(" -> ");
        state.add(path, "call_cycle", `call nodes form a cycle: ${chain}`);
        continue;
      }
      if (!done.has(targetKey)) visit(edge.target.doc, targetKey, edge.target.label, edge.target.base, edge.path);
    }
    stack.pop();
    onStack.delete(key);
    done.add(key);
  };
  const label = typeof state.options.savedAs === "string" ? state.options.savedAs : typeof top["name"] === "string" ? top["name"] : "workflow";
  visit(top, "top", label, "$", null);
}

/** Checks a workflow document and returns every problem found, each with a JSON path. Never throws. */
export function validateWorkflow(document: unknown, options?: ValidateOptions): { ok: boolean; problems: WorkflowProblem[] } {
  const top = isJsonObject(document) ? document : null;
  const state = new State(options ?? {}, top);
  try {
    checkDocument(state, document, "$");
    if (top !== null) checkCallCycles(state, top);
  } catch (error) {
    state.add("$", "shape", `the document could not be checked: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { ok: !state.problems.some((problem) => problem.severity === "error"), problems: state.problems };
}
