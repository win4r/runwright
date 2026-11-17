import type { PersonQuestion } from "../engine/types.ts";
import type { ToolDefinition } from "./types.ts";

/**
 * ask_person pauses the run with a question until a person answers it. It is built from the durable `ask` step,
 * so invoking it again after a suspend or crash replays the same question instead of asking twice. The control
 * signal that suspends the run propagates unchanged.
 */
export function createAskPersonTool(): ToolDefinition {
  return {
    name: "ask_person",
    description:
      "Ask a person a question and wait for their answer. Use it when you need information or a decision only a " +
      "person can give. Optionally offer `choices` for them to pick from. The run pauses until they answer, and the " +
      "answer is returned as the tool result.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["question"],
      properties: {
        question: { type: "string", minLength: 1, maxLength: 4000, description: "The question, written for a person." },
        choices: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: { type: "string", minLength: 1, maxLength: 200 },
          description: "Optional answers the person can pick from.",
        },
      },
    },
    effect: "read",
    resumable: true,
    async handler(args, context) {
      const question: PersonQuestion = { question: typeof args["question"] === "string" ? args["question"] : "" };
      const choices = args["choices"];
      if (Array.isArray(choices)) question.choices = choices.filter((choice): choice is string => typeof choice === "string");
      const { answer } = await context.steps.ask("ask", question);
      return { content: answer };
    },
  };
}
