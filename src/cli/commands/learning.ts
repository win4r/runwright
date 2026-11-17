import type { RunwrightClient } from "../../client/index.ts";
import type { LearningItem, LearningKind, LearningStatus } from "../../store/types.ts";
import { readUtf8File, stringFlag, UsageError } from "../args.ts";
import { arg, type CommandContext, type CommandSpec } from "../context.ts";
import { labelled, table, time } from "../output.ts";

const STATUSES: readonly LearningStatus[] = ["active", "held", "retired"];
const KINDS: readonly LearningKind[] = ["note", "skill"];

function itemText(item: LearningItem): string {
  return `${labelled([
    ["Item", item.id],
    ["Agent", item.agentId],
    ["Kind", item.kind],
    ["Name", item.name],
    ["Status", item.status],
    ["Version", String(item.version)],
    ["ETag", item.etag],
    ["Title", item.title],
    ["Description", item.description],
    ["Source run", item.sourceRunId ?? undefined],
    ["Workflow", item.promotedWorkflow === null
      ? undefined
      : item.promotedWorkflowVersion === null ? item.promotedWorkflow : `${item.promotedWorkflow} v${item.promotedWorkflowVersion}`],
    ["Updated", time(item.updatedAt)],
  ])}\n\n${item.body}`;
}

/** retire / restore / approve / edit: the ETag from --etag, else read from the item first. */
async function etagFor(ctx: CommandContext, id: string): Promise<string> {
  return stringFlag(ctx.values, "etag") ?? (await (await ctx.client()).getLearning(id)).etag;
}

function change(
  verb: "retire" | "restore" | "approve",
  summary: string,
  call: (client: RunwrightClient, id: string, etag: string) => Promise<LearningItem>,
): CommandSpec {
  return {
    name: `learning ${verb}`, summary, args: "<id>",
    flags: { etag: { value: "etag", description: "only if the item still has this ETag (default: read it first)" } },
    async handler(ctx) {
      const id = arg(ctx, 0);
      const item = await call(await ctx.client(), id, await etagFor(ctx, id));
      ctx.print({ item }, () => `${item.id} is now ${item.status} (version ${item.version})`);
      return 0;
    },
  };
}

export const learningCommands: CommandSpec[] = [
  {
    name: "learning list", summary: "List learned notes and skills", args: "",
    flags: {
      agent: { value: "id", description: "only this agent's items" },
      status: { value: "active|held|retired", description: "only items with this status" },
      kind: { value: "note|skill", description: "only this kind" },
    },
    async handler(ctx) {
      const query: NonNullable<Parameters<RunwrightClient["listLearning"]>[0]> = {};
      const agent = stringFlag(ctx.values, "agent");
      if (agent !== undefined) query.agentId = agent;
      const status = stringFlag(ctx.values, "status");
      if (status !== undefined) {
        if (!(STATUSES as readonly string[]).includes(status)) throw new UsageError(`--status must be one of ${STATUSES.join(", ")}`, ctx.name);
        query.status = status as LearningStatus;
      }
      const kind = stringFlag(ctx.values, "kind");
      if (kind !== undefined) {
        if (!(KINDS as readonly string[]).includes(kind)) throw new UsageError(`--kind must be one of ${KINDS.join(", ")}`, ctx.name);
        query.kind = kind as LearningKind;
      }
      const items = await (await ctx.client()).listLearning(query);
      ctx.print({ items }, () => (items.length === 0 ? "No learned items." : table(
        ["ITEM", "AGENT", "KIND", "NAME", "STATUS", "VERSION", "TITLE"],
        items.map((i) => [i.id, i.agentId, i.kind, i.name, i.status, String(i.version), i.title]),
      )));
      return 0;
    },
  },
  {
    name: "learning show", summary: "Show a learned item", args: "<id>", flags: {},
    async handler(ctx) {
      const item = await (await ctx.client()).getLearning(arg(ctx, 0));
      ctx.print({ item }, () => itemText(item));
      return 0;
    },
  },
  {
    name: "learning history", summary: "Show every version of a learned item", args: "<id>", flags: {},
    async handler(ctx) {
      const history = await (await ctx.client()).learningHistory(arg(ctx, 0));
      ctx.print({ history }, () => table(
        ["VERSION", "ACTION", "STATUS", "ACTOR", "AT", "NOTE"],
        history.map((h) => [String(h.version), h.action, h.status, h.actor, time(h.at), h.note ?? ""]),
      ));
      return 0;
    },
  },
  change("retire", "Retire a learned item (later runs stop getting it)", (c, id, etag) => c.retireLearning(id, etag)),
  change("restore", "Restore a retired item", (c, id, etag) => c.restoreLearning(id, etag)),
  change("approve", "Approve an item held for a person", (c, id, etag) => c.approveLearning(id, etag)),
  {
    name: "learning edit", summary: "Change a learned item's title, description or body", args: "<id>",
    flags: {
      title: { value: "text", description: "new title" },
      description: { value: "text", description: "new one-line description" },
      body: { value: "text|@file", description: "new body, or @file to read it from a file" },
      etag: { value: "etag", description: "only if the item still has this ETag (default: read it first)" },
    },
    async handler(ctx) {
      const patch: { title?: string; description?: string; body?: string } = {};
      const title = stringFlag(ctx.values, "title");
      if (title !== undefined) patch.title = title;
      const description = stringFlag(ctx.values, "description");
      if (description !== undefined) patch.description = description;
      const body = stringFlag(ctx.values, "body");
      if (body !== undefined) {
        if (body.startsWith("@")) {
          try {
            patch.body = await readUtf8File(body.slice(1));
          } catch (error) {
            throw new UsageError(`cannot read ${body.slice(1)}: ${(error as Error).message}`, ctx.name);
          }
        } else patch.body = body;
      }
      if (Object.keys(patch).length === 0) throw new UsageError("give at least one of --title, --description, --body", ctx.name);
      const id = arg(ctx, 0);
      const item = await (await ctx.client()).editLearning(id, await etagFor(ctx, id), patch);
      ctx.print({ item }, () => `Edited ${item.id} (version ${item.version})`);
      return 0;
    },
  },
];
