import type { Json, JsonObject } from "../core/json.ts";
import type { JsonSchema } from "../schema/validate.ts";

export const WORKFLOW_FORMAT = "runwright.workflow/v1";
/** Every code the validator reports (see docs/workflows.md). */
export const WORKFLOW_PROBLEM_CODES = Object.freeze([
  "format", "shape", "unknown_kind", "duplicate_id", "unknown_schema", "invalid_schema", "unknown_reference",
  "conditional_reference", "bad_reference", "schema_mismatch", "unknown_tool", "unknown_workflow", "call_cycle",
  "missing_bound", "unreachable", "retry_unsafe", "bad_deadline",
] as const);
export type WorkflowProblemCode = (typeof WORKFLOW_PROBLEM_CODES)[number];
export type Expr = Json;
export type Condition =
  | { eq: [Expr, Expr] } | { ne: [Expr, Expr] } | { gt: [Expr, Expr] } | { gte: [Expr, Expr] }
  | { lt: [Expr, Expr] } | { lte: [Expr, Expr] }
  | { and: Condition[] } | { or: Condition[] } | { not: Condition } | { exists: string } | { truthy: Expr };
export interface RetryPolicy { maxAttempts: number; backoffMs: number; factor?: number; maxBackoffMs?: number }
/**
 * Fields every node kind has. `deadlineMs` bounds each attempt's call on tool, model and decide nodes; on sequence,
 * parallel, branch, map, loop, call and agent nodes the node must finish, and on a wait node the question must be
 * answered, within `deadlineMs` of the node's journalled start; it does nothing on fail.
 */
export interface NodeBase { id: string; title?: string; deadlineMs?: number }
/** A tool node's arguments: a map from argument name to expression. A `$ref` or `$literal` form in place of the map is not one. */
export type ToolArgs = { [name: string]: Expr } & { $ref?: never; $literal?: never };
export interface ToolNode extends NodeBase { kind: "tool"; tool: string; args: ToolArgs; idempotent?: boolean;
  onError?: "fail" | "continue"; retry?: RetryPolicy }
export interface ModelNode extends NodeBase { kind: "model"; prompt: string; system?: string; output: string; retry?: RetryPolicy }
export type DecisionSpec = { type: "yes_no" } | { type: "pick_one"; options: string[] } | { type: "score"; min: number; max: number };
export interface DecideNode extends NodeBase { kind: "decide"; question: string; decision: DecisionSpec;
  lowConfidence?: { below: number; run: WorkflowNode; value?: Expr }; retry?: RetryPolicy }
export interface BranchNode extends NodeBase { kind: "branch"; on: Expr; cases: { when: Json; run: WorkflowNode }[]; default?: WorkflowNode }
export interface SequenceNode extends NodeBase { kind: "sequence"; steps: WorkflowNode[] }
export interface ParallelNode extends NodeBase { kind: "parallel"; branches: WorkflowNode[] }
export interface MapNode extends NodeBase { kind: "map"; over: Expr; as: string; concurrency: number; maxItems: number; run: WorkflowNode }
export interface LoopNode extends NodeBase { kind: "loop"; maxIterations: number; until: Condition; run: WorkflowNode; onLimit?: "fail" | "continue" }
export interface CallNode extends NodeBase { kind: "call"; workflow: string; input: Expr }
export interface AgentNode extends NodeBase { kind: "agent"; message: string; instructions?: string; tools?: string[]; output?: string; maxTurns: number }
export interface WaitNode extends NodeBase { kind: "wait"; question: string; choices?: string[] }
export interface FailNode extends NodeBase { kind: "fail"; message: string }
export type WorkflowNode = ToolNode | ModelNode | DecideNode | BranchNode | SequenceNode | ParallelNode | MapNode
  | LoopNode | CallNode | AgentNode | WaitNode | FailNode;
export type NodeKind = WorkflowNode["kind"];
export const NODE_KINDS: readonly NodeKind[] = Object.freeze([
  "tool", "model", "decide", "branch", "sequence", "parallel", "map", "loop", "call", "agent", "wait", "fail",
] as const);
export interface WorkflowDocument {
  format: typeof WORKFLOW_FORMAT; name: string; description?: string;
  schemas: { [name: string]: JsonSchema }; input: string; output: string;
  workflows?: { [name: string]: WorkflowDocument };
  root: WorkflowNode; result: Expr;
}
export interface DecisionOutput { value: boolean | string | number; confidence: number; reason: string;
  route: "confident" | "low_confidence"; fallback: Json }
export interface ToolNodeOutput { ok: boolean; content: string; data: Json }
export interface LoopOutput { iterations: number; completed: boolean; last: Json }
export interface AgentNodeOutput { text: string; data: Json }
export interface WorkflowProblem { path: string; code: string; message: string; severity: "error" | "warning"; nodeId?: string }
export interface DryRunStep { nodeId: string; kind: NodeKind; path: string; scope: string; note: string | null }
export interface DryRunCall { nodeId: string; type: "tool" | "model" | "decision" | "agent" | "person" | "workflow"; name: string; detail: JsonObject }
export interface DryRunReport { ok: boolean; steps: DryRunStep[]; wouldCall: DryRunCall[]; output: Json; problems: WorkflowProblem[]; truncated: boolean }
export interface WorkflowGraph {
  nodes: { id: string; kind: NodeKind; label: string }[];
  edges: { from: string; to: string; kind: "next" | "contains" | "case" | "default" | "low_confidence" | "body" | "call"; label: string | null }[];
}
