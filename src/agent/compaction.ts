import { canonicalJson, type Json } from "../core/json.ts";
import type { RunContext } from "../engine/types.ts";
import type { Message, ToolSpec } from "../models/types.ts";
import { typicalTokens } from "../models/util.ts";

export interface CompactionSettings {
  /** Compact when the request's typical token estimate exceeds this fraction of the context budget. */
  compactAtFraction: number;
  /** Assistant turns (with their tool results) kept verbatim after a compaction. */
  keepRecentTurns: number;
  /** Context budget for models whose ref has no `contextTokens`. */
  defaultContextTokens: number;
}

/** Instructions of the summariser model call. Fixed text, so a replayed run sends the same request. */
const SUMMARISER_INSTRUCTIONS =
  "You summarise the earlier part of an agent's working session so the agent can continue without the full " +
  "transcript. Keep every fact the agent still needs: what it was asked, decisions made, files it created or " +
  "changed and what they contain, tool results that matter, answers people gave, and what remains to be done. " +
  "Leave out pleasantries and repetition. Write plain text.";

export const SUMMARY_PREFIX = "[Summary of earlier work]\n";

/** One assistant turn: the user messages that preceded it, the assistant message and its tool results. */
interface TurnGroup { messages: Message[] }

/**
 * Splits the conversation after its first message into turn groups. A group ends with an assistant message and
 * every tool result that follows it, so a tool result is never separated from the call that produced it. User
 * messages after the last group (not yet answered) are returned as the tail.
 */
export function splitTurns(rest: readonly Message[]): { groups: TurnGroup[]; tail: Message[] } {
  const groups: TurnGroup[] = [];
  let pending: Message[] = [];
  let current: TurnGroup | null = null;
  for (const message of rest) {
    if (message.role === "assistant") {
      current = { messages: [...pending, message] };
      pending = [];
      groups.push(current);
    } else if (message.role === "tool" && current !== null && pending.length === 0) {
      current.messages.push(message);
    } else {
      pending.push(message);
    }
  }
  return { groups, tail: pending };
}

/** Renders messages as a plain-text transcript for the summariser. */
export function renderTranscript(messages: readonly Message[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      lines.push(`User: ${message.content}`);
    } else if (message.role === "assistant") {
      if (message.content !== "") lines.push(`Assistant: ${message.content}`);
      for (const call of message.toolCalls) {
        lines.push(`Assistant called tool ${call.name} (${call.id}) with arguments ${canonicalJson(call.args as Json)}`);
      }
    } else {
      lines.push(`Tool result${message.isError ? " (error)" : ""} from ${message.name} (${message.toolCallId}): ${message.content}`);
    }
  }
  return lines.join("\n");
}

function estimate(system: string, messages: Message[], tools: ToolSpec[]): number {
  return typicalTokens({ system, messages, tools, output: null });
}

/**
 * Before the model call of `turn`: when the request nears the context budget and there are more than
 * `keepRecentTurns` assistant turns, the older turns are summarised by a durable `compaction` model step and
 * replaced by the summary. The first user message and the most recent turns are kept as they are.
 *
 * The decision depends only on the conversation, which replay reproduces, and the summary is a journalled step,
 * so a resumed run compacts at the same points and reuses the summary. At most one compaction per turn.
 */
export async function compactIfNeeded(
  ctx: RunContext,
  settings: CompactionSettings,
  turn: number,
  system: string,
  conv: Message[],
  specs: ToolSpec[],
): Promise<Message[]> {
  const contextTokens = ctx.definition.model.contextTokens ?? settings.defaultContextTokens;
  const budget = contextTokens * settings.compactAtFraction;
  const tokensBefore = estimate(system, conv, specs);
  if (tokensBefore <= budget) return conv;

  const first = conv[0];
  if (first === undefined) return conv;
  const keep = Math.max(0, Math.floor(settings.keepRecentTurns));
  const { groups, tail } = splitTurns(conv.slice(1));
  if (groups.length <= keep) return conv;

  const older = groups.slice(0, groups.length - keep);
  const recent = groups.slice(groups.length - keep);
  const key = `t${turn}.compact`;
  const summary = await ctx.model(key, {
    purpose: "compaction",
    countsAsTurn: false,
    step: "compaction",
    turn,
    system: SUMMARISER_INSTRUCTIONS,
    messages: [{ role: "user", content: renderTranscript(older.flatMap((group) => group.messages)) }],
  });

  const compacted: Message[] = [
    first,
    { role: "user", content: SUMMARY_PREFIX + summary.text },
    ...recent.flatMap((group) => group.messages),
    ...tail,
  ];
  // Every assistant message in the conversation is one loop turn, and they are consecutive up to turn - 1.
  const throughTurn = turn - 1 - keep;
  await ctx.emit(key, "context.compacted", { throughTurn, tokensBefore, tokensAfter: estimate(system, compacted, specs) });
  return compacted;
}
