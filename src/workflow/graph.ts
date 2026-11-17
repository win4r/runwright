import { canonicalJson } from "../core/json.ts";
import type { WorkflowDocument, WorkflowGraph, WorkflowNode } from "./types.ts";

type GraphEdge = WorkflowGraph["edges"][number];

function extraOf(node: WorkflowNode): string | null {
  switch (node.kind) {
    case "tool": return node.tool;
    case "model": return node.output;
    case "decide": return node.decision.type;
    case "call": return node.workflow;
    case "agent": return node.output ?? null;
    default: return null;
  }
}

/** Nodes and edges of a workflow document, for the console and docs. Call targets become synthetic nodes. */
export function toGraph(document: WorkflowDocument): WorkflowGraph {
  const nodes: WorkflowGraph["nodes"] = [];
  const edges: GraphEdge[] = [];
  const targets = new Set<string>();
  const edge = (from: string, to: string, kind: GraphEdge["kind"], label: string | null): void => {
    edges.push({ from, to, kind, label });
  };
  const visit = (node: WorkflowNode): void => {
    const extra = extraOf(node);
    const base = node.title ?? `${node.kind}: ${node.id}`;
    nodes.push({ id: node.id, kind: node.kind, label: extra === null ? base : `${base} (${extra})` });
    switch (node.kind) {
      case "sequence":
        if (node.steps[0] !== undefined) edge(node.id, node.steps[0].id, "contains", null);
        node.steps.forEach((step, i) => {
          const next = node.steps[i + 1];
          if (next !== undefined) edge(step.id, next.id, "next", null);
        });
        node.steps.forEach(visit);
        break;
      case "parallel":
        for (const branch of node.branches) edge(node.id, branch.id, "contains", null);
        node.branches.forEach(visit);
        break;
      case "map":
        edge(node.id, node.run.id, "contains", `each ${node.as}`);
        visit(node.run);
        break;
      case "loop":
        edge(node.id, node.run.id, "contains", `max ${node.maxIterations}`);
        visit(node.run);
        break;
      case "branch":
        for (const entry of node.cases) edge(node.id, entry.run.id, "case", canonicalJson(entry.when));
        if (node.default !== undefined) edge(node.id, node.default.id, "default", null);
        for (const entry of node.cases) visit(entry.run);
        if (node.default !== undefined) visit(node.default);
        break;
      case "decide":
        if (node.lowConfidence !== undefined) {
          edge(node.id, node.lowConfidence.run.id, "low_confidence", `< ${node.lowConfidence.below}`);
          visit(node.lowConfidence.run);
        }
        break;
      case "call": {
        const target = `workflow:${node.workflow}`;
        if (!targets.has(target)) {
          targets.add(target);
          nodes.push({ id: target, kind: "call", label: `workflow: ${node.workflow}` });
        }
        edge(node.id, target, "call", null);
        break;
      }
      default:
        break;
    }
  };
  visit(document.root);
  return { nodes, edges };
}

const NAMED_ENTITIES: Record<string, string> = { '"': "#quot;", "&": "#amp;", "<": "#lt;", ">": "#gt;" };
const ESCAPED = new Set(["#", "`", "|", "[", "]", "{", "}", "(", ")", ";", "\\"]);

/** Escapes a label so that no character can end the quoted string or start Mermaid syntax. */
function escapeMermaidLabel(label: string): string {
  let out = "";
  for (const char of label.replace(/\r\n?/g, "\n")) {
    const code = char.codePointAt(0) as number;
    const named = NAMED_ENTITIES[char];
    if (named !== undefined) out += named;
    else if (char === "\n" || code < 0x20 || code === 0x7f || ESCAPED.has(char)) out += `#${code};`;
    else out += char;
  }
  return out;
}

const ARROWS: Record<GraphEdge["kind"], string> = {
  next: "-->", contains: "-.->", case: "-->", default: "-->", low_confidence: "-.->", body: "-.->", call: "==>",
};

/** Mermaid `flowchart TD` text for a graph; ids are prefixed and every label is quoted and escaped. */
export function toMermaid(graph: WorkflowGraph): string {
  const ids = new Map<string, string>();
  const used = new Set<string>();
  graph.nodes.forEach((node, i) => {
    let id = /^[A-Za-z0-9_]+$/.test(node.id) ? `n_${node.id}` : `x${i}`;
    while (used.has(id)) id = `x${i}_${used.size}`;
    used.add(id);
    ids.set(node.id, id);
  });
  const lines = ["flowchart TD"];
  for (const node of graph.nodes) lines.push(`  ${ids.get(node.id) as string}["${escapeMermaidLabel(node.label)}"]`);
  for (const edge of graph.edges) {
    const from = ids.get(edge.from);
    const to = ids.get(edge.to);
    if (from === undefined || to === undefined) continue;
    const label = edge.label ?? (edge.kind === "default" ? "default" : null);
    const arrow = ARROWS[edge.kind];
    lines.push(label === null ? `  ${from} ${arrow} ${to}` : `  ${from} ${arrow}|"${escapeMermaidLabel(label)}"| ${to}`);
  }
  return lines.join("\n") + "\n";
}
