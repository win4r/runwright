import type { LearningContext, LearningGiven } from "../engine/types.ts";
import { textTokens } from "../models/util.ts";
import type { LearningItem } from "../store/types.ts";
import { rankBm25 } from "./bm25.ts";
import { renderItem, renderLine } from "./proposal.ts";

export const SECTION_HEADING = "## Learned from earlier runs";
const INTRO_ALL = "These notes and skills were kept from earlier runs of this agent. Use them where they apply.";
const INTRO_LINES = "These notes and skills were kept from earlier runs of this agent. Items listed on one line are "
  + "summaries: open one in full with the `recall` tool (pass the item's name).";
/** The intro when the run cannot call `recall` (the agent or the server denies it). */
const INTRO_LINES_NO_RECALL = "These notes and skills were kept from earlier runs of this agent. Items listed on one line are summaries only.";
export const RECALL_TOOL_NAME = "recall";

type Selectable = Pick<LearningItem, "id" | "kind" | "name" | "title" | "description" | "body" | "version" | "updatedAt" | "promotedWorkflow" | "promotedWorkflowVersion">;

export interface SelectOptions {
  /** Token estimate of a text; by default the typical estimate (`textTokens`). */
  estimate?: (text: string) => number;
  /** Whether the run can call `recall` (default true): when false, lines are still listed but no tool is granted. */
  recall?: boolean;
}

const head = (withLines: boolean, recall: boolean): string =>
  `${SECTION_HEADING}\n\n${withLines ? (recall ? INTRO_LINES : INTRO_LINES_NO_RECALL) : INTRO_ALL}\n\n`;
const fullPiece = (item: Selectable): string => `${renderItem(item)}\n\n`;
const linePiece = (item: Selectable): string => `${renderLine(item)}\n`;

function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function given(item: Selectable, mode: "full" | "line"): LearningGiven {
  return { itemId: item.id, version: item.version, kind: item.kind, name: item.name, mode };
}

function assemble(full: readonly Selectable[], lines: readonly Selectable[], recall: boolean): LearningContext {
  if (full.length === 0 && lines.length === 0) return { promptSection: "", given: [], tools: [] };
  const text = head(lines.length > 0, recall) + full.map(fullPiece).join("") + lines.map(linePiece).join("");
  return {
    promptSection: text.trimEnd(),
    given: [...full.map((item) => given(item, "full")), ...lines.map((item) => given(item, "line"))],
    tools: lines.length > 0 && recall ? [RECALL_TOOL_NAME] : [],
  };
}

/**
 * Chooses what a run is given (rule S2, docs/learning.md). If everything fits whole, every item is given whole
 * (skills first, then by name). Otherwise the items are ranked by BM25 against the run's first message (ties:
 * newest first, then name), and the budget is measured with the larger heading from the start (if even that does
 * not fit, nothing is given):
 * (a) when one line for every item fits, every item is given: each starts as its line, and in rank order an item
 *     is given whole instead when the difference still fits; no item is left out;
 * (b) when even the lines do not all fit, relevance decides what is left out: in rank order an item is given
 *     whole if it still fits, otherwise as its line if that fits, otherwise it is left out.
 * Output: whole items in rank order, then lines in rank order. The section never exceeds the budget. Each item's
 * whole text and line are estimated once, so `estimate` is called at most 2 × items.length + 2 times; choosing
 * costs O(N log N) (two sorts and the BM25 ranking). With `recall: false` the lines are listed as summaries only
 * and no tool is granted. Pure.
 */
export function selectItems(
  items: readonly Selectable[], firstMessage: string, budgetTokens: number, options?: SelectOptions,
): LearningContext {
  const estimate = options?.estimate ?? textTokens;
  const recall = options?.recall ?? true;
  if (items.length === 0) return assemble([], [], recall);
  const fullCost = new Map<Selectable, number>();
  for (const item of items) if (!fullCost.has(item)) fullCost.set(item, estimate(fullPiece(item)));
  const byKindAndName = [...items].sort((a, b) => (a.kind === b.kind ? compareNames(a.name, b.name) : a.kind === "skill" ? -1 : 1));
  const allHead = estimate(head(false, recall));
  const everything = allHead + byKindAndName.reduce((sum, item) => sum + (fullCost.get(item) as number), 0);
  if (everything <= budgetTokens) return assemble(byKindAndName, [], recall);

  const tieOrder = [...items].sort((a, b) => b.updatedAt - a.updatedAt || compareNames(a.name, b.name));
  const byId = new Map(tieOrder.map((item) => [item.id, item]));
  const ranked = rankBm25(firstMessage, tieOrder).map((score) => byId.get(score.id) as Selectable);

  let used = Math.max(allHead, estimate(head(true, recall)));
  if (used > budgetTokens) return assemble([], [], recall);
  const lineCost = new Map<Selectable, number>();
  for (const item of items) if (!lineCost.has(item)) lineCost.set(item, estimate(linePiece(item)));
  const allLines = ranked.reduce((sum, item) => sum + (lineCost.get(item) as number), 0);

  if (used + allLines <= budgetTokens) {
    used += allLines;
    const whole = new Set<Selectable>();
    for (const item of ranked) {
      const difference = (fullCost.get(item) as number) - (lineCost.get(item) as number);
      if (used + difference <= budgetTokens) {
        whole.add(item);
        used += difference;
      }
    }
    return assemble(ranked.filter((item) => whole.has(item)), ranked.filter((item) => !whole.has(item)), recall);
  }

  const full: Selectable[] = [];
  const lines: Selectable[] = [];
  for (const item of ranked) {
    const whole = fullCost.get(item) as number;
    const line = lineCost.get(item) as number;
    if (used + whole <= budgetTokens) {
      full.push(item);
      used += whole;
    } else if (used + line <= budgetTokens) {
      lines.push(item);
      used += line;
    }
  }
  return assemble(full, lines, recall);
}
