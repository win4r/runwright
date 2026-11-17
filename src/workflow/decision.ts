import type { Json } from "../core/json.ts";
import type { JsonSchema } from "../schema/validate.ts";
import type { DecisionSpec } from "./types.ts";

/** JSON Schema of the value part of a decision answer. */
export function decisionValueSchema(spec: DecisionSpec): JsonSchema {
  switch (spec.type) {
    case "yes_no":
      return { type: "boolean" };
    case "pick_one":
      return { enum: [...spec.options] };
    case "score":
      return { type: "number", minimum: spec.min, maximum: spec.max };
  }
}

/** Structured-output schema a decision model call must answer with: `{value, confidence, reason?}`. */
export function decisionSchema(spec: DecisionSpec): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: ["value", "confidence"],
    properties: {
      value: decisionValueSchema(spec),
      confidence: { type: "number", minimum: 0, maximum: 1 },
      reason: { type: "string" },
    },
  };
}

/** True when `value` is an allowed answer for the decision. */
export function checkDecisionValue(spec: DecisionSpec, value: Json): boolean {
  switch (spec.type) {
    case "yes_no":
      return typeof value === "boolean";
    case "pick_one":
      return typeof value === "string" && spec.options.includes(value);
    case "score":
      return typeof value === "number" && Number.isFinite(value) && value >= spec.min && value <= spec.max;
  }
}
