import type { AgentDefinition } from "../../agents/definition.ts";
import { isJsonObject } from "../../core/json.ts";
import { formatCost } from "../../models/prices.ts";
import type { MetricsGroup } from "../../store/types.ts";
import { intFlag, readJsonFile, stringFlag, UsageError } from "../args.ts";
import { arg, type CommandSpec } from "../context.ts";
import { labelled, table, time } from "../output.ts";

function metricsRow(label: string, group: MetricsGroup): string[] {
  const n = (value: number | null): string => (value === null ? "-" : String(Math.round(value)));
  return [
    label, String(group.runs), group.avgCostMicros === null ? "-" : formatCost(Math.round(group.avgCostMicros), false),
    n(group.avgInputTokens), n(group.avgOutputTokens), group.avgDurationMs === null ? "-" : `${Math.round(group.avgDurationMs)} ms`,
  ];
}

export const agentCommands: CommandSpec[] = [
  {
    name: "agents list", summary: "List agents", args: "", flags: {},
    async handler(ctx) {
      const agents = await (await ctx.client()).listAgents();
      ctx.print({ agents }, () => (agents.length === 0 ? "No agents." : table(
        ["AGENT", "NAME", "REVISION", "MODEL"],
        agents.map(({ agent, definition }) => [agent.id, agent.name, String(agent.currentRevision), `${definition.model.provider}/${definition.model.name}`]),
      )));
      return 0;
    },
  },
  {
    name: "agents get", summary: "Show an agent and its current revision (or another one with --revision)", args: "<id>",
    flags: { revision: { value: "n", description: "show this revision instead of the current one" } },
    async handler(ctx) {
      const client = await ctx.client();
      const id = arg(ctx, 0);
      const number = intFlag(ctx.values, "revision", ctx.name, 1, Number.MAX_SAFE_INTEGER);
      const { agent, revision: current } = await client.getAgent(id);
      const revision = number === undefined ? current : await client.getRevision(id, number);
      const d = revision.definition;
      ctx.print({ agent, revision }, () => labelled([
        ["Agent", agent.id],
        ["Name", d.name],
        ["Revision", revision.revision === agent.currentRevision ? String(revision.revision) : `${revision.revision} (current: ${agent.currentRevision})`],
        ["Model", `${d.model.provider}/${d.model.name}`],
        ["Tools", d.tools.length === 0 ? "none" : d.tools.map((t) => (t.policy === undefined ? t.name : `${t.name} (${t.policy})`)).join(", ")],
        ["Learning", d.learning ? "on" : "off"],
        ["Workflow", d.workflow === undefined ? undefined : d.workflow.name],
        ["Updated", time(agent.updatedAt)],
      ]));
      return 0;
    },
  },
  {
    name: "agents save", summary: "Save an agent from a JSON file (a changed definition makes a new revision)", args: "<file>",
    flags: { id: { value: "id", description: "the agent id (overrides the file's)" } },
    async handler(ctx) {
      const file = await readJsonFile(arg(ctx, 0), ctx.name);
      if (!isJsonObject(file)) throw new UsageError(`${arg(ctx, 0)} must hold a JSON object`, ctx.name);
      const wrapped = isJsonObject(file["definition"]);
      const definition = (wrapped ? file["definition"] : file) as unknown as AgentDefinition;
      const fileId = wrapped && typeof file["id"] === "string" ? file["id"] : undefined;
      const id = stringFlag(ctx.values, "id") ?? fileId;
      const result = await (await ctx.client()).saveAgent(definition, id);
      ctx.print(result, () => `${result.created ? "Saved" : "Unchanged:"} agent ${result.agent.id} revision ${result.revision.revision}`);
      return 0;
    },
  },
  {
    name: "agents revisions", summary: "List an agent's revisions, newest first", args: "<id>", flags: {},
    async handler(ctx) {
      const revisions = await (await ctx.client()).listRevisions(arg(ctx, 0));
      ctx.print({ revisions }, () => table(
        ["REVISION", "CREATED", "HASH"], revisions.map((r) => [String(r.revision), time(r.createdAt), r.definitionHash.slice(0, 12)]),
      ));
      return 0;
    },
  },
  {
    name: "agents metrics", summary: "Compare an agent's runs before and after learning", args: "<id>", flags: {},
    async handler(ctx) {
      const metrics = await (await ctx.client()).learningMetrics(arg(ctx, 0));
      ctx.print({ metrics }, () => table(
        ["", "RUNS", "AVG COST", "AVG IN", "AVG OUT", "AVG TIME"],
        [metricsRow("before", metrics.before), metricsRow("after", metrics.after)],
      ));
      return 0;
    },
  },
];
