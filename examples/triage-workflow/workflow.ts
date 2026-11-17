/**
 * The triage workflow, written with the typed builder. `workflow.json` (and the `workflow` inside
 * `agent.json`) is this document serialized; `run.ts` checks that they match.
 *
 *   urgent  decide (yes/no) "Is this ticket urgent?"; below 0.7 confidence an agent reviews it instead
 *   file    branch on the decision: write urgent.txt or routine.txt
 */
import { node, ref, workflow, type WorkflowDocument } from "../../src/workflow/builder.ts";

export function triageWorkflow(): WorkflowDocument {
  return workflow("triage")
    .describe("Classify a support ticket; tickets the model is unsure about go to an agent for review.")
    .input("Input", { type: "object", required: ["ticket"], additionalProperties: false, properties: { ticket: { type: "string", minLength: 1 } } })
    .schema("Verdict", { type: "object", required: ["urgent"], additionalProperties: false, properties: { urgent: { type: "boolean" } } })
    .output("Output", {
      type: "object", required: ["urgent", "route"], additionalProperties: false,
      properties: { urgent: { type: "boolean" }, route: { enum: ["confident", "low_confidence"] } },
    })
    .root(node.sequence("main",
      node.decide("urgent", {
        question: "Is this support ticket urgent?\n\n{{input.ticket}}",
        decision: { type: "yes_no" },
        lowConfidence: {
          below: 0.7,
          run: node.agent("review", {
            message: "Read this ticket carefully and decide whether it is urgent: {{input.ticket}}",
            maxTurns: 3,
            output: "Verdict",
            tools: [],
          }),
          value: ref("fallback.data.urgent"),
        },
      }),
      node.branch("file", ref("steps.urgent.value"), [
        { when: true, run: node.tool("write_urgent", "write_file", { path: "urgent.txt", content: "URGENT: {{input.ticket}}\n" }) },
        { when: false, run: node.tool("write_routine", "write_file", { path: "routine.txt", content: "routine: {{input.ticket}}\n" }) },
      ]),
    ))
    .result({ urgent: ref("steps.urgent.value"), route: ref("steps.urgent.route") })
    .build();
}
