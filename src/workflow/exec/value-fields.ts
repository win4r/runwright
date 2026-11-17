/**
 * The field specifications of what the workflow executor journals (rule H): every node's value by the node's
 * kind, the scope step of a composite node, the pinned version of a saved workflow, a decision's structured
 * output and the provider wait in `run_workflow`'s error data. The executor reads these values back by field
 * name (an author's reference, a branch on `route`, a decision's `confidence`), so their field names are listed
 * and written as they are; the text and the values a model, a tool or a person supplied inside them are still
 * redacted.
 *
 * - "keep" only for what the executor computed: `ok`, `route`, `iterations`, `completed`, `version`, the provider
 *   wait's numbers.
 * - "text" for `content`, `reason`, `answer`, `text`; "payload" for `data`, `value`, `confidence` and for a value
 *   an author's schema or expression builds (a model node's output, a sub-workflow call's result).
 * - A composite's specification follows the nodes it encloses. Node ids are listed field names (of a parallel
 *   group's value and of the scope step's value): they are part of every node record's key, which is never redacted.
 *
 * A specification never nests deeper than MAX_NODE_SPEC_DEPTH containers: where that bound is reached, the
 * enclosed node's value is "payload", so a document nested deeper still runs (the engine refuses a
 * specification deeper than MAX_FIELD_SPEC_DEPTH).
 *
 * This module also holds the walk over the nodes a composite encloses in its own frame, which the executor uses
 * for the scope step.
 */
import { fieldList, fieldObject, sameFieldSpec, type FieldSpec, type ObjectSpec } from "../../store/record-fields.ts";
import type { WorkflowNode } from "../types.ts";

/** The most container levels (objects and lists) a node's specification nests. */
export const MAX_NODE_SPEC_DEPTH = 32;

const K = "keep";
const T = "text";
const P = "payload";

/** The pinned version of a saved workflow, `{version}` (a number, or null when none was found). */
export const RESOLVE_VALUE_FIELDS: FieldSpec = fieldObject({ version: K });
/** A decision's structured output as the model answers it. */
export const DECISION_OUTPUT_FIELDS: FieldSpec = fieldObject({ value: P, confidence: P, reason: T });
/** `run_workflow`'s error data when a nested model step failed with a provider wait outstanding. */
export const PROVIDER_WAIT_DATA_FIELDS: FieldSpec = fieldObject({
  providerWait: fieldObject({ retryAfterMs: K, retryAfterOverLimit: K }),
});

const TOOL_VALUE_FIELDS = fieldObject({ ok: K, content: T, data: P });
const WAIT_VALUE_FIELDS = fieldObject({ answer: T });
const AGENT_VALUE_FIELDS = fieldObject({ text: T, data: P });

/** The nodes directly inside `node` that run in its own frame (not inside a map or loop body or a sub-workflow). */
export function frameChildren(node: WorkflowNode): readonly WorkflowNode[] {
  switch (node.kind) {
    case "sequence":
      return node.steps;
    case "parallel":
      return node.branches;
    case "branch":
      return [...node.cases.map((entry) => entry.run), ...(node.default === undefined ? [] : [node.default])];
    case "decide":
      return node.lowConfidence === undefined ? [] : [node.lowConfidence.run];
    default:
      return [];
  }
}

const enclosedCache = new WeakMap<WorkflowNode, readonly WorkflowNode[]>();

/** Every node inside `node` that shares its frame, at any depth, in document order. Cached per node object. */
export function enclosedNodes(node: WorkflowNode): readonly WorkflowNode[] {
  const cached = enclosedCache.get(node);
  if (cached !== undefined) return cached;
  const nodes: WorkflowNode[] = [];
  const visit = (child: WorkflowNode): void => {
    nodes.push(child);
    for (const inner of frameChildren(child)) visit(inner);
  };
  for (const child of frameChildren(node)) visit(child);
  Object.freeze(nodes);
  enclosedCache.set(node, nodes);
  return nodes;
}

/** Specifications per node object, by the container levels that were left for it (0 … MAX_NODE_SPEC_DEPTH). */
const valueCache = new WeakMap<WorkflowNode, Map<number, FieldSpec>>();

/** An ObjectSpec whose field names are node ids, each an own key (an id like `constructor` included). */
function byId(entries: readonly (readonly [string, FieldSpec])[]): ObjectSpec {
  const fields: Record<string, FieldSpec> = {};
  for (const [id, spec] of entries) {
    Object.defineProperty(fields, id, { value: spec, enumerable: true, writable: true, configurable: true });
  }
  return fieldObject(fields);
}

/** The specification of `node`'s value using at most `left` container levels. */
function valueFields(node: WorkflowNode, left: number): FieldSpec {
  let row = valueCache.get(node);
  const cached = row?.get(left);
  if (cached !== undefined) return cached;
  const spec = buildValueFields(node, left);
  if (row === undefined) {
    row = new Map();
    valueCache.set(node, row);
  }
  row.set(left, spec);
  return spec;
}

function buildValueFields(node: WorkflowNode, left: number): FieldSpec {
  switch (node.kind) {
    case "model":
    case "call":
    case "fail":
      return P;
    case "sequence": {
      const last = node.steps[node.steps.length - 1];
      return last === undefined ? K : valueFields(last, left);
    }
    case "branch": {
      const specs = frameChildren(node).map((child) => valueFields(child, left));
      const first = specs[0];
      if (first === undefined) return K;
      return specs.every((spec) => sameFieldSpec(spec, first)) ? first : P;
    }
    // Every other kind's value is a container: it needs one level of the bound.
    case "tool":
      return left < 1 ? P : TOOL_VALUE_FIELDS;
    case "wait":
      return left < 1 ? P : WAIT_VALUE_FIELDS;
    case "agent":
      return left < 1 ? P : AGENT_VALUE_FIELDS;
    case "decide":
      return left < 1 ? P : fieldObject({
        value: P, confidence: P, reason: T, route: K,
        fallback: node.lowConfidence === undefined ? K : valueFields(node.lowConfidence.run, left - 1),
      });
    case "map":
      return left < 1 ? P : fieldList(valueFields(node.run, left - 1));
    case "loop":
      return left < 1 ? P : fieldObject({ iterations: K, completed: K, last: valueFields(node.run, left - 1) });
    case "parallel":
      return left < 1 ? P : byId(node.branches.map((branch) => [branch.id, valueFields(branch, left - 1)] as const));
  }
}

/** The field specification of `node`'s value (what its `node.finished` record holds), by the node's kind. */
export function nodeValueFields(node: WorkflowNode): FieldSpec {
  return valueFields(node, MAX_NODE_SPEC_DEPTH);
}

const scopeCache = new WeakMap<WorkflowNode, ObjectSpec>();

/** One listed field per node enclosed by `node` in the same frame: its id -> nodeValueFields(that node). */
export function scopeValueFields(node: WorkflowNode): ObjectSpec {
  const cached = scopeCache.get(node);
  if (cached !== undefined) return cached;
  const spec = byId(enclosedNodes(node).map((child) => [child.id, nodeValueFields(child)] as const));
  scopeCache.set(node, spec);
  return spec;
}
