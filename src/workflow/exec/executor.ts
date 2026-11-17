/**
 * The durable workflow executor (plan 3.11). It walks a workflow document on top of a RunContext: every node
 * runs inside `ctx.memo("wf/<scope><nodeId>")`, so a finished node returns its journalled output on replay and
 * its subtree is not walked again. Model, tool, person and agent work goes through the context's primitives,
 * so the agent's policy, approvals, caps and budgets apply inside workflows exactly as in the agent loop.
 *
 * Scope strings: "" at the top, extended by "<mapId>[<index>]/", "<loopId>#<iteration>/" and "<callId>>/",
 * so every execution of a node has its own key.
 *
 * A composite node that encloses other nodes of the same frame (sequence, parallel, branch, a decision with a
 * low-confidence fallback) also journals the step values of those nodes under "<key>/scope" before it
 * finishes. When the composite is skipped on replay, that record puts the inner values back into `steps`, so
 * later nodes that reference them resolve exactly as in the uninterrupted run.
 *
 * Every node record and every scope record declares the field specification of its value (`value-fields.ts`):
 * the field names the executor wrote and the node ids are stored as they are, so a stored value is read back by
 * the same names, live and on replay, whatever secrets exist.
 *
 * A node deadline is an instant: the `ts` of the node's journalled `node.started` record plus `deadlineMs`, the
 * same in every session that runs the node. A composite node (sequence, parallel, branch, map, loop, call, agent)
 * with `deadlineMs` runs its work inside `ctx.deadline(deadlineMs, …, {startedAt})`: every step of the node and of
 * its descendants goes through the scoped context, so when the instant passes the steps in flight are aborted, no
 * further step starts and the node fails with `deadline_exceeded`; a pending opened inside carries the instant,
 * a waiting run is woken at it, and a run that comes back after it (from waiting, paused, released or crashed)
 * fails the node on entry. Keys do not change (the scoped context has the same prefix). A wait node with
 * `deadlineMs` asks its question with `expiresAt` at the instant: unanswered by then, the question is closed and
 * the node fails with `deadline_exceeded`. Tool, model and decide nodes bound each attempt's call instead.
 */
import { RunwrightError } from "../../core/errors.ts";
import type { Json, JsonObject } from "../../core/json.ts";
import { isControlSignal } from "../../engine/control.ts";
import type { AgentLoopFn, MemoMeta, RunContext } from "../../engine/types.ts";
import { validateSchema } from "../../schema/validate.ts";
import type { Store } from "../../store/types.ts";
import type { ToolRegistry } from "../../tools/registry.ts";
import { resolveValue, type RefScope } from "../refs.ts";
import { bundleSchema } from "../schemas.ts";
import type { NodeKind, WorkflowDocument, WorkflowNode } from "../types.ts";
import { validateWorkflow } from "../validate.ts";
import {
  asNodeFailure, listSchemaProblems, schemaProblemsJson, workflowProblemsJson, type NodePlace,
} from "./errors.ts";
import { execNode } from "./nodes.ts";
import { enclosedNodes, nodeValueFields, scopeValueFields } from "./value-fields.ts";

export interface WorkflowRuntimeDeps { agentLoop: AgentLoopFn; store: Pick<Store, "getWorkflow">; tools: ToolRegistry }

/** One execution frame: a document, the values its expressions see, and where its keys live. */
export interface Frame {
  readonly doc: WorkflowDocument;
  readonly scope: RefScope;
  readonly scopeKey: string;
  /** meta.turn for model steps: iteration index + 1 of the innermost map or loop, else 1. */
  readonly turn: number;
  /** Sub-workflow call depth. */
  readonly depth: number;
}

/** Kinds whose `deadlineMs` bounds the whole node from its journalled start (tool, model and decide bound each call). */
const SCOPED_DEADLINE_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>(["sequence", "parallel", "branch", "map", "loop", "call", "agent"]);

export class WorkflowExecutor {
  readonly ctx: RunContext;
  readonly deps: WorkflowRuntimeDeps;

  constructor(ctx: RunContext, deps: WorkflowRuntimeDeps) {
    this.ctx = ctx;
    this.deps = deps;
  }

  /** An executor with the same dependencies over another context (a deadline scope of this one). */
  withContext(ctx: RunContext): WorkflowExecutor {
    return new WorkflowExecutor(ctx, this.deps);
  }

  /** True when the registered tool may be run again after a failure (read-only or idempotent). */
  toolRetrySafe(name: string): boolean {
    const tool = this.deps.tools.get(name);
    return tool !== null && (tool.effect === "read" || tool.idempotent === true);
  }

  /**
   * Validates a document against the registered tools; throws `workflow_invalid` with every problem. `savedAs` is
   * the document's storage identity (`ValidateOptions.savedAs`): the name it is saved under, or null for a
   * document that is not a saved workflow (an agent's embedded workflow).
   */
  checkDocument(document: unknown, savedAs: string | null): asserts document is WorkflowDocument {
    const tools = this.deps.tools.list().map((tool) => ({
      name: tool.name, parameters: tool.parameters, retrySafe: tool.effect === "read" || tool.idempotent === true,
    }));
    const result = validateWorkflow(document, { tools, savedAs });
    if (!result.ok) {
      const errors = result.problems.filter((p) => p.severity === "error");
      const name = typeof (document as { name?: unknown } | null)?.name === "string" ? (document as { name: string }).name : "workflow";
      throw new RunwrightError("workflow_invalid", `workflow "${name}" is invalid: ${errors.map((p) => `${p.path}: ${p.message}`).join("; ")}`, {
        details: { problems: workflowProblemsJson(result.problems) },
      });
    }
  }

  /** Validates (with its storage identity, see `checkDocument`) and runs a top-level document. */
  async execute(document: WorkflowDocument, input: Json, savedAs: string | null): Promise<Json> {
    this.checkDocument(document, savedAs);
    return this.runDocument(document, input, { scopeKey: "", depth: 0, caller: null });
  }

  /** Runs a (validated) document with a fresh scope: only `input` and `run` are visible to it. */
  async runDocument(document: WorkflowDocument, input: Json, at: { scopeKey: string; depth: number; caller: NodePlace | null }): Promise<Json> {
    const inputProblems = validateSchema(bundleSchema(document, document.input), input);
    if (inputProblems.length > 0) {
      throw new RunwrightError("validation_failed", `input of workflow "${document.name}" does not match schema "${document.input}": ${listSchemaProblems(inputProblems)}`, {
        details: { workflow: document.name, schema: document.input, problems: schemaProblemsJson(inputProblems) },
      });
    }
    const frame: Frame = {
      doc: document,
      scope: { input, steps: {}, vars: {}, loop: {}, run: { id: this.ctx.run.id, agentId: this.ctx.run.agentId } },
      scopeKey: at.scopeKey,
      turn: 1,
      depth: at.depth,
    };
    await this.run(document.root, "$.root", frame);
    let result: Json;
    try {
      result = resolveValue(document.result, frame.scope);
    } catch (error) {
      throw new RunwrightError("workflow_failed", `the result of workflow "${document.name}" cannot be built: ${error instanceof Error ? error.message : String(error)}`, {
        details: { workflow: document.name, path: "$.result", ...(at.caller === null ? {} : { nodeId: at.caller.nodeId }) },
      });
    }
    const outputProblems = validateSchema(bundleSchema(document, document.output), result);
    if (outputProblems.length > 0) {
      throw new RunwrightError("workflow_failed", `the result of workflow "${document.name}" does not match schema "${document.output}": ${listSchemaProblems(outputProblems)}`, {
        details: {
          workflow: document.name, path: "$.result", schema: document.output, problems: schemaProblemsJson(outputProblems),
          ...(at.caller === null ? {} : { nodeId: at.caller.nodeId }),
        },
      });
    }
    return result;
  }

  /** Runs one node durably and stores its output in `frame.scope.steps`. */
  async run(node: WorkflowNode, path: string, frame: Frame): Promise<Json> {
    const key = `wf/${frame.scopeKey}${node.id}`;
    const place: NodePlace = { nodeId: node.id, path, workflow: frame.doc.name, scope: frame.scopeKey };
    const enclosed = enclosedNodes(node);
    const scopeMeta: MemoMeta = {
      recordType: "step", name: "workflow.scope", info: { nodeId: node.id, scope: frame.scopeKey }, valueFields: scopeValueFields(node),
    };
    const collect = async (): Promise<JsonObject> => {
      const out: JsonObject = {};
      for (const { id } of enclosed) {
        if (Object.hasOwn(frame.scope.steps, id)) out[id] = frame.scope.steps[id] as Json;
      }
      return out;
    };
    const nodeMeta: MemoMeta = { recordType: "node", name: node.id, info: { kind: node.kind, scope: frame.scopeKey }, valueFields: nodeValueFields(node) };
    const output = await this.ctx.memo<Json>(key, nodeMeta, async (step) => {
      let value: Json;
      try {
        value = await this.execBounded(node, path, frame, key, place, step.startedAt);
      } catch (error) {
        if (isControlSignal(error)) throw error;
        throw asNodeFailure(error, place);
      }
      if (enclosed.length > 0) await this.ctx.memo(`${key}/scope`, scopeMeta, collect);
      return value;
    });
    if (enclosed.length > 0) {
      const restored = await this.ctx.memo(`${key}/scope`, scopeMeta, collect);
      for (const id of Object.keys(restored)) frame.scope.steps[id] = restored[id] as Json;
    }
    frame.scope.steps[node.id] = output;
    return output;
  }

  /**
   * The node's own work: inside a deadline scope that expires at `startedAt + deadlineMs` when it is a composite
   * node with `deadlineMs`; a wait node's question expires at that instant.
   */
  private execBounded(node: WorkflowNode, path: string, frame: Frame, key: string, place: NodePlace, startedAt: number): Promise<Json> {
    const deadlineMs = node.deadlineMs;
    if (deadlineMs !== undefined && node.kind === "wait") return execNode(this, node, path, frame, key, place, startedAt + deadlineMs);
    if (deadlineMs === undefined || !SCOPED_DEADLINE_KINDS.has(node.kind)) return execNode(this, node, path, frame, key, place);
    return this.ctx.deadline(deadlineMs, (scoped) => execNode(this.withContext(scoped), node, path, frame, key, place), { startedAt });
  }
}
