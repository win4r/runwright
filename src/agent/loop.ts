import { canonicalJson, type Json } from "../core/json.ts";
import type { AgentLoopFn, AgentLoopParams, AgentLoopResult, Driver, InboxMessage, RunContext } from "../engine/types.ts";
import type { Message } from "../models/types.ts";
import { compactIfNeeded } from "./compaction.ts";
import { buildSystemPrompt } from "./prompt.ts";

export interface AgentLoopOptions { compactAtFraction: number; keepRecentTurns: number; defaultContextTokens: number }

/** The request appended to the conversation for the structured final answer. */
const FINAL_OUTPUT_REQUEST = "Give the final result as structured data.";

function stoppedNote(maxTurns: number): string {
  return `(stopped after ${maxTurns} turn${maxTurns === 1 ? "" : "s"}: the turn limit of this hand-off was reached)`;
}

/** Appends one user message per inbox message to `conv` (a loop: the number of messages has no bound). */
function appendUserMessages(conv: Message[], messages: readonly InboxMessage[]): void {
  for (const message of messages) conv.push({ role: "user", content: message.text });
}

/**
 * Creates the agent loop and the agent driver built on it.
 *
 * The loop only uses durable step primitives with keys built from the turn structure (`t<n>.in`, `t<n>`,
 * `t<n>.c<i>`, `t<n>.late`, `t<n>.compact`, `final`), so a replayed run takes the same path and every finished
 * step returns from the journal. Control signals and model failures are never caught here: they belong to the
 * engine. The tool calls of one turn run one at a time, so approvals and budgets apply in a fixed order.
 *
 * With `params.toolNames` every step of the loop runs through `ctx.withTools(toolNames)`: the model is shown only
 * those tools, and a call it makes of any other tool is journalled as denied ("not among the tools of this
 * hand-off") and returned to it as the tool result, also for whatever such a call would run.
 */
export function createAgentLoop(options: AgentLoopOptions): { driver: Driver; loop: AgentLoopFn } {
  const loop: AgentLoopFn = async (outer: RunContext, params: AgentLoopParams): Promise<AgentLoopResult> => {
    const ctx = params.toolNames === undefined ? outer : outer.withTools(params.toolNames);
    const system = buildSystemPrompt(params.instructions, ctx.learning?.promptSection);
    let conv: Message[] = [{ role: "user", content: params.message }];
    const specs = ctx.toolSpecs();
    let text = "";
    let lastAssistantText = "";
    let turns = 0;
    let stopped = false;

    for (let turn = 1; ; turn++) {
      if (params.maxTurns !== undefined && turn > params.maxTurns) {
        text = lastAssistantText !== "" ? lastAssistantText : stoppedNote(params.maxTurns);
        stopped = true;
        break;
      }
      appendUserMessages(conv, await ctx.inbox(`t${turn}.in`));
      conv = await compactIfNeeded(ctx, options, turn, system, conv, specs);
      const reply = await ctx.model(`t${turn}`, {
        purpose: "run",
        system,
        messages: [...conv],
        tools: specs,
        turn,
        ...(params.step === undefined ? {} : { step: params.step }),
      });
      turns = turn;
      conv.push({ role: "assistant", content: reply.text, toolCalls: reply.toolCalls });
      if (reply.text !== "") lastAssistantText = reply.text;

      if (reply.toolCalls.length === 0) {
        const late = await ctx.inbox(`t${turn}.late`);
        if (late.length > 0) {
          appendUserMessages(conv, late);
          continue;
        }
        text = reply.text;
        break;
      }
      for (const [index, call] of reply.toolCalls.entries()) {
        const result = await ctx.tool(`t${turn}.c${index}`, { name: call.name, args: call.args, callId: call.id });
        conv.push({ role: "tool", toolCallId: call.id, name: call.name, content: result.content, isError: result.isError });
      }
    }

    let data: Json = null;
    if (params.output !== undefined) {
      const final = await ctx.model("final", {
        purpose: "run",
        countsAsTurn: false,
        system,
        output: params.output,
        turn: turns + 1,
        ...(params.step === undefined ? {} : { step: `${params.step}.final` }),
        messages: [...conv, { role: "user", content: FINAL_OUTPUT_REQUEST }],
      });
      data = final.output;
    }
    ctx.logger.debug("agent.loop.finished", { turns, stoppedByTurnLimit: stopped });
    return { text, data, turns };
  };

  const driver: Driver = async (ctx: RunContext) => {
    const input = ctx.run.input;
    const message = input.data === null ? input.message : `${input.message}\n\nInput data (JSON):\n${canonicalJson(input.data)}`;
    const result = await loop(ctx, { instructions: ctx.definition.instructions, message });
    return { text: result.text };
  };

  return { driver, loop };
}
