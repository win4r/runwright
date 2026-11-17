import type { LearningItem, Store } from "../store/types.ts";
import type { ToolDefinition, ToolOutput } from "../tools/types.ts";
import { renderItem } from "./proposal.ts";
import { RECALL_TOOL_NAME } from "./select.ts";

const FOLDER: Readonly<Record<string, string>> = { note: "notes", skill: "skills" };

function namesFor(item: LearningItem): string[] {
  const folder = FOLDER[item.kind] as string;
  return [item.name, `${item.kind}/${item.name}`, `${folder}/${item.name}`, `${folder}/${item.name}.md`];
}

/**
 * The `recall` tool: opens a learning item that was given to this run (usually as one line). It writes nothing
 * itself: the item is reported in `learningOpened`, which the engine commits with the call's `tool.finished`.
 * The text is the item at the version the run was given, and so is the workflow pointer: a skill is promoted at
 * most once, by a history entry "promoted" that writes its own version, and the pointer is never cleared, so the
 * pointer belongs to version v exactly when that entry's version is at most v.
 */
export function createRecallTool(store: Pick<Store, "learningUses" | "getLearningItem" | "learningHistory">): ToolDefinition {
  return {
    name: RECALL_TOOL_NAME,
    description: "Open, in full, a note or skill kept from earlier runs that is listed in your instructions. "
      + "Pass its name (or kind/name, e.g. note/build-steps).",
    parameters: {
      type: "object",
      required: ["name"],
      additionalProperties: false,
      properties: { name: { type: "string", minLength: 1, maxLength: 200 } },
    },
    effect: "read",
    async handler(args, context): Promise<ToolOutput> {
      const wanted = String(args["name"]).trim();
      const uses = await store.learningUses(context.runId);
      const available: { item: LearningItem; version: number }[] = [];
      for (const use of uses) {
        const item = await store.getLearningItem(use.itemId);
        if (item !== null) available.push({ item, version: use.version });
      }
      const matches = available.filter(({ item }) => namesFor(item).includes(wanted));
      if (matches.length !== 1) {
        const listing = available.map(({ item }) => `${item.kind}/${item.name}`).sort().join(", ");
        const problem = matches.length === 0
          ? `No learning item named "${wanted}" was given to this run.`
          : `"${wanted}" names more than one item; use kind/name.`;
        return { content: `${problem} Available: ${listing === "" ? "(none)" : listing}`, isError: true };
      }
      const { item, version } = matches[0] as { item: LearningItem; version: number };
      const history = await store.learningHistory(item.id);
      const snapshot = history.find((entry) => entry.version === version);
      const promotedAt = history.find((entry) => entry.action === "promoted")?.version;
      const promoted = promotedAt !== undefined && promotedAt <= version && item.promotedWorkflow !== null;
      const content = renderItem({
        kind: item.kind, name: item.name,
        ...(promoted ? { promotedWorkflow: item.promotedWorkflow, promotedWorkflowVersion: item.promotedWorkflowVersion } : {}),
        title: snapshot?.title ?? item.title, description: snapshot?.description ?? item.description, body: snapshot?.body ?? item.body,
      });
      return { content, data: { itemId: item.id, version, kind: item.kind, name: item.name, promoted }, learningOpened: [item.id] };
    },
  };
}
