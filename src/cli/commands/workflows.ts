import { writeFile } from "node:fs/promises";
import { isJsonObject, type Json } from "../../core/json.ts";
import type { WorkflowGraph, WorkflowProblem } from "../../workflow/types.ts";
import type { DryRunDecisions, WorkflowCheckOptions } from "../../client/index.ts";
import { boolFlag, intFlag, readJsonArgument, readJsonFile, stringFlag, UsageError, type FlagValues } from "../args.ts";
import { arg, type CommandSpec } from "../context.ts";
import { labelled, short, table, time } from "../output.ts";

function problemLine(problem: WorkflowProblem): string {
  return `${problem.severity} ${problem.path} ${problem.code}: ${problem.message}`;
}

function graphText(graph: WorkflowGraph): string {
  const nodes = table(["NODE", "KIND", "LABEL"], graph.nodes.map((n) => [n.id, n.kind, n.label]));
  const edges = table(["FROM", "TO", "KIND", "LABEL"], graph.edges.map((e) => [e.from, e.to, e.kind, e.label ?? ""]));
  return `Nodes:\n${nodes}\n\nEdges:\n${edges}`;
}

const EMBEDDED_FLAG = { description: "check the document as an agent's embedded workflow (no call resolves to it by its own name)" };

function checkOptions(values: FlagValues): WorkflowCheckOptions {
  return boolFlag(values, "embedded") ? { embedded: true } : {};
}

export const workflowCommands: CommandSpec[] = [
  {
    name: "workflows validate", summary: "Check a workflow document (exit 1 when it has errors)", args: "<file>", flags: { embedded: EMBEDDED_FLAG },
    async handler(ctx) {
      const result = await (await ctx.client()).validateWorkflow(await readJsonFile(arg(ctx, 0), ctx.name), checkOptions(ctx.values));
      const errors = result.problems.filter((p) => p.severity === "error").length;
      ctx.print(result, () => (result.problems.length === 0 ? "Valid: no problems." : result.problems.map(problemLine).join("\n")));
      return errors > 0 || !result.ok ? 1 : 0;
    },
  },
  {
    name: "workflows dry-run", summary: "Walk a workflow with placeholders: no model or tool is called", args: "<file>",
    flags: {
      input: { value: "json|@file", description: "the workflow input" },
      decisions: { value: "json|@file", description: "per node id: {value, confidence} to steer decisions" },
      embedded: EMBEDDED_FLAG,
    },
    async handler(ctx) {
      const document = await readJsonFile(arg(ctx, 0), ctx.name);
      const options: { input?: Json; decisions?: DryRunDecisions } & WorkflowCheckOptions = checkOptions(ctx.values);
      const input = stringFlag(ctx.values, "input");
      if (input !== undefined) options.input = await readJsonArgument(input, "--input", ctx.name);
      const decisions = stringFlag(ctx.values, "decisions");
      if (decisions !== undefined) {
        const parsed = await readJsonArgument(decisions, "--decisions", ctx.name);
        if (!isJsonObject(parsed)) throw new UsageError("--decisions must be a JSON object keyed by node id", ctx.name);
        // The server checks each entry's shape (validation_failed names the path of a bad one).
        options.decisions = parsed as unknown as DryRunDecisions;
      }
      const report = await (await ctx.client()).dryRunWorkflow(document, options);
      ctx.print({ report }, () => {
        const lines = ["Steps:", ...report.steps.map((s) => `  ${s.nodeId}  ${s.kind}  ${s.path}${s.note === null ? "" : `  ${s.note}`}`)];
        lines.push("Would call:");
        if (report.wouldCall.length === 0) lines.push("  nothing");
        for (const c of report.wouldCall) lines.push(`  ${c.type}  ${c.name}  (${c.nodeId})`);
        lines.push(`Output: ${short(JSON.stringify(report.output), 200)}`);
        if (report.truncated) lines.push("(stopped early: too many steps)");
        if (report.problems.length > 0) lines.push("Problems:");
        for (const p of report.problems) lines.push(`  ${problemLine(p)}`);
        lines.push(report.ok ? "Dry run OK." : "Dry run failed.");
        return lines.join("\n");
      });
      return report.ok ? 0 : 1;
    },
  },
  {
    name: "workflows graph", summary: "Print a workflow's nodes and edges, or its Mermaid text with --mermaid", args: "[<file>]",
    flags: {
      name: { value: "saved", description: "the saved workflow of this name instead of a file" },
      mermaid: { description: "print the Mermaid text (in JSON mode: {mermaid})" },
      out: { value: "file", description: "write the Mermaid text to this file" },
      embedded: { description: "with <file>: graph it as an agent's embedded workflow (no call resolves to it by its own name)" },
    },
    async handler(ctx) {
      const file = ctx.positionals[0];
      const name = stringFlag(ctx.values, "name");
      if ((file === undefined) === (name === undefined)) throw new UsageError("give exactly one of <file> and --name", ctx.name);
      if (name !== undefined && boolFlag(ctx.values, "embedded")) throw new UsageError("--embedded goes with a <file>, not with --name", ctx.name);
      const client = await ctx.client();
      const result = name === undefined
        ? await client.graphWorkflow(await readJsonFile(file as string, ctx.name), checkOptions(ctx.values))
        : await client.savedWorkflowGraph(name);
      const mermaid = result.mermaid.endsWith("\n") ? result.mermaid : `${result.mermaid}\n`;
      const out = stringFlag(ctx.values, "out");
      if (out !== undefined) {
        await writeFile(out, mermaid);
        const bytes = Buffer.byteLength(mermaid);
        ctx.print({ out, bytes }, () => `Wrote ${bytes} bytes to ${out}`);
        return 0;
      }
      if (!boolFlag(ctx.values, "mermaid")) ctx.print(result, () => graphText(result.graph));
      else if (ctx.json) ctx.print({ mermaid: result.mermaid }, () => result.mermaid);
      else ctx.raw(mermaid);
      return 0;
    },
  },
  {
    name: "workflows save", summary: "Save a workflow under a name (a changed document makes a new version)", args: "<name> <file>", flags: {},
    async handler(ctx) {
      const result = await (await ctx.client()).saveWorkflow(arg(ctx, 0), await readJsonFile(arg(ctx, 1), ctx.name));
      ctx.print(result, () => `${result.created ? "Saved" : "Unchanged:"} workflow ${result.workflow.name} version ${result.workflow.version}`);
      return 0;
    },
  },
  {
    name: "workflows list", summary: "List saved workflows", args: "", flags: {},
    async handler(ctx) {
      const workflows = await (await ctx.client()).listWorkflows();
      ctx.print({ workflows }, () => (workflows.length === 0 ? "No saved workflows." : table(
        ["NAME", "VERSION", "SOURCE", "CREATED"], workflows.map((w) => [w.name, String(w.version), w.source, time(w.createdAt)]),
      )));
      return 0;
    },
  },
  {
    name: "workflows get", summary: "Show a saved workflow", args: "<name>",
    flags: { version: { value: "n", description: "this version (default: the latest)" } },
    async handler(ctx) {
      const workflow = await (await ctx.client()).getWorkflow(arg(ctx, 0), intFlag(ctx.values, "version", ctx.name, 1, Number.MAX_SAFE_INTEGER));
      ctx.print({ workflow }, () => `${labelled([
        ["Workflow", workflow.name],
        ["Version", String(workflow.version)],
        ["Source", workflow.source],
        ["Created", time(workflow.createdAt)],
      ])}\n${JSON.stringify(workflow.document, null, 2)}`);
      return 0;
    },
  },
];
