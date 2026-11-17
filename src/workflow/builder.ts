import type { Json, JsonObject } from "../core/json.ts";
import { RunwrightError } from "../core/errors.ts";
import type { JsonSchema } from "../schema/validate.ts";
import { copyJson } from "./refs.ts";
import { validateWorkflow, type ValidateOptions } from "./validate.ts";
import {
  WORKFLOW_FORMAT,
  type AgentNode, type BranchNode, type CallNode, type DecideNode, type Expr, type FailNode, type LoopNode, type MapNode,
  type ModelNode, type ParallelNode, type SequenceNode, type ToolArgs, type ToolNode, type WaitNode, type WorkflowDocument, type WorkflowNode,
} from "./types.ts";

export type { WorkflowDocument, WorkflowNode, Expr } from "./types.ts";

/** A `{"$ref": path}` expression, with an optional default for a value that may be missing. */
export function ref(path: string, fallback?: Json): { $ref: string; default?: Json } {
  return fallback === undefined ? { $ref: path } : { $ref: path, default: fallback };
}

/** A value inserted verbatim, never treated as a reference or template. */
export function literal(value: Json): { $literal: Json } {
  return { $literal: value };
}

/** A `{{ path }}` template fragment, for building template strings. */
export function tpl(path: string): string {
  return `{{${path}}}`;
}

function compact<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) if (item !== undefined) out[key] = item;
  return out as T;
}

/**
 * Options every node builder accepts: the graph label and the node's deadline (see `NodeBase`). A deadline is an
 * instant, the node's journalled start plus `deadlineMs`: a composite node or an `agent` hand-off must finish, and
 * a `wait` node's question must be answered, before it, across waits, pauses and restarts; on `tool`, `model` and
 * `decide` nodes it bounds each attempt's call, measured from the call; on `fail` it has no effect.
 */
export interface NodeOptions { title?: string; deadlineMs?: number }

function isNodeOptions(value: WorkflowNode | NodeOptions | undefined): value is NodeOptions {
  return value !== undefined && !Object.hasOwn(value, "kind");
}

/** Splits `[options?, ...children]`: a leading argument without a `kind` is the options object. */
function splitChildren(items: readonly (WorkflowNode | NodeOptions)[]): { options: NodeOptions; children: WorkflowNode[] } {
  const [first, ...rest] = items;
  if (isNodeOptions(first)) return { options: first, children: rest as WorkflowNode[] };
  return { options: {}, children: items as WorkflowNode[] };
}

function extras(options: NodeOptions | undefined): NodeOptions {
  return compact({ title: options?.title, deadlineMs: options?.deadlineMs });
}

/**
 * Node builders. Every one accepts `deadlineMs` (and `title`): in its options object, as a trailing options
 * argument (`branch`, `call`, `wait`, `fail`), or as an options object right after the id (`sequence`, `parallel`).
 */
export const node: {
  tool(id: string, tool: string, args: ToolArgs, options?: Omit<ToolNode, "id" | "kind" | "tool" | "args">): ToolNode;
  model(id: string, options: Omit<ModelNode, "id" | "kind">): ModelNode;
  decide(id: string, options: Omit<DecideNode, "id" | "kind">): DecideNode;
  branch(id: string, on: Expr, cases: { when: Json; run: WorkflowNode }[], otherwise?: WorkflowNode, options?: NodeOptions): BranchNode;
  sequence(id: string, ...steps: WorkflowNode[]): SequenceNode;
  sequence(id: string, options: NodeOptions, ...steps: WorkflowNode[]): SequenceNode;
  parallel(id: string, ...branches: WorkflowNode[]): ParallelNode;
  parallel(id: string, options: NodeOptions, ...branches: WorkflowNode[]): ParallelNode;
  map(id: string, options: Omit<MapNode, "id" | "kind">): MapNode;
  loop(id: string, options: Omit<LoopNode, "id" | "kind">): LoopNode;
  call(id: string, workflow: string, input: Expr, options?: NodeOptions): CallNode;
  agent(id: string, options: Omit<AgentNode, "id" | "kind">): AgentNode;
  wait(id: string, question: string, choices?: string[], options?: NodeOptions): WaitNode;
  fail(id: string, message: string, options?: NodeOptions): FailNode;
} = Object.freeze({
  tool: (id: string, tool: string, args: ToolArgs, options?: Omit<ToolNode, "id" | "kind" | "tool" | "args">): ToolNode =>
    compact({ id, kind: "tool" as const, tool, args, ...options }),
  model: (id: string, options: Omit<ModelNode, "id" | "kind">): ModelNode => compact({ id, kind: "model" as const, ...options }),
  decide: (id: string, options: Omit<DecideNode, "id" | "kind">): DecideNode => compact({ id, kind: "decide" as const, ...options }),
  branch: (id: string, on: Expr, cases: { when: Json; run: WorkflowNode }[], otherwise?: WorkflowNode, options?: NodeOptions): BranchNode =>
    compact({ id, kind: "branch" as const, ...extras(options), on, cases, default: otherwise }),
  sequence: (id: string, ...items: (WorkflowNode | NodeOptions)[]): SequenceNode => {
    const { options, children } = splitChildren(items);
    return { id, kind: "sequence", ...extras(options), steps: children };
  },
  parallel: (id: string, ...items: (WorkflowNode | NodeOptions)[]): ParallelNode => {
    const { options, children } = splitChildren(items);
    return { id, kind: "parallel", ...extras(options), branches: children };
  },
  map: (id: string, options: Omit<MapNode, "id" | "kind">): MapNode => compact({ id, kind: "map" as const, ...options }),
  loop: (id: string, options: Omit<LoopNode, "id" | "kind">): LoopNode => compact({ id, kind: "loop" as const, ...options }),
  call: (id: string, workflow: string, input: Expr, options?: NodeOptions): CallNode => ({ id, kind: "call", ...extras(options), workflow, input }),
  agent: (id: string, options: Omit<AgentNode, "id" | "kind">): AgentNode => compact({ id, kind: "agent" as const, ...options }),
  wait: (id: string, question: string, choices?: string[], options?: NodeOptions): WaitNode =>
    compact({ id, kind: "wait" as const, ...extras(options), question, choices }),
  fail: (id: string, message: string, options?: NodeOptions): FailNode => ({ id, kind: "fail", ...extras(options), message }),
});

export interface WorkflowBuilder {
  describe(text: string): WorkflowBuilder;
  schema(name: string, schema: JsonSchema): WorkflowBuilder;
  input(name: string, schema?: JsonSchema): WorkflowBuilder;
  output(name: string, schema?: JsonSchema): WorkflowBuilder;
  sub(name: string, document: WorkflowDocument): WorkflowBuilder;
  root(node: WorkflowNode): WorkflowBuilder;
  result(expr: Expr): WorkflowBuilder;
  build(options?: ValidateOptions): WorkflowDocument;
}

/** Starts a typed builder for a `runwright.workflow/v1` document. */
export function workflow(name: string): WorkflowBuilder {
  let description: string | undefined;
  const schemas: { [name: string]: JsonSchema } = {};
  const workflows: { [name: string]: WorkflowDocument } = {};
  let inputName: string | undefined;
  let outputName: string | undefined;
  let rootNode: WorkflowNode | undefined;
  let resultExpr: Expr | undefined;
  const builder: WorkflowBuilder = {
    describe(text) { description = text; return builder; },
    schema(schemaName, schema) { schemas[schemaName] = schema; return builder; },
    input(schemaName, schema) { inputName = schemaName; if (schema !== undefined) schemas[schemaName] = schema; return builder; },
    output(schemaName, schema) { outputName = schemaName; if (schema !== undefined) schemas[schemaName] = schema; return builder; },
    sub(subName, document) { workflows[subName] = document; return builder; },
    root(value) { rootNode = value; return builder; },
    result(expr) { resultExpr = expr; return builder; },
    build(options) {
      const draft: Record<string, unknown> = { format: WORKFLOW_FORMAT, name };
      if (description !== undefined) draft["description"] = description;
      draft["schemas"] = schemas;
      draft["input"] = inputName;
      draft["output"] = outputName;
      if (Object.keys(workflows).length > 0) draft["workflows"] = workflows;
      draft["root"] = rootNode;
      draft["result"] = resultExpr;
      const document = copyJson(compact(draft)) as JsonObject;
      const { problems } = validateWorkflow(document, options);
      const errors = problems.filter((p) => p.severity === "error");
      if (errors.length > 0) {
        throw new RunwrightError("workflow_invalid", `workflow ${JSON.stringify(name)} is invalid: ${errors.map((p) => `${p.path}: ${p.message}`).join("; ")}`, {
          details: { problems: problems.map((p) => copyJson(p)) },
        });
      }
      return document as unknown as WorkflowDocument;
    },
  };
  return builder;
}
