import { isJsonObject } from "../core/json.ts";
import type { ModelRef } from "../models/types.ts";
import type { WorkflowDocument } from "../workflow/types.ts";
import { pathIndex, validateSchema, type JsonSchema, type SchemaProblem } from "../schema/validate.ts";

export type ToolPolicy = "allow" | "ask" | "deny";
export interface AgentToolEntry { name: string; policy?: ToolPolicy }
export interface AgentLimits { maxCostMicros?: number; maxToolCalls?: number; maxTurns?: number }
export interface AgentDefinition {
  name: string;
  instructions: string;
  model: ModelRef;
  tools: AgentToolEntry[];
  limits: AgentLimits;
  learning: boolean;
  workflow?: WorkflowDocument;
  secrets?: string[];
}

export const AGENT_ID_PATTERN: RegExp = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const nonNegativeInteger: JsonSchema = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const positiveInteger: JsonSchema = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
/** A duration a timer waits: an integer number of milliseconds a Node timer can hold. */
const timerMs: JsonSchema = { type: "integer", minimum: 0, maximum: 2147483647 };
const secretName: JsonSchema = { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,63}$" };

/** A closed object: `additionalProperties: false`, so an unknown key is reported with its path. */
function closed(properties: { [key: string]: JsonSchema }, required?: string[]): JsonSchema {
  return required === undefined
    ? { type: "object", additionalProperties: false, properties }
    : { type: "object", additionalProperties: false, required, properties };
}

/** One tool call of a scripted turn. `args` is an open payload: any JSON object. */
const scriptedToolCall: JsonSchema = closed(
  { name: { type: "string", minLength: 1 }, args: { type: "object" }, id: { type: "string" } },
  ["name", "args"],
);

/** One scripted turn (`ScriptedTurn`). `output` is an open payload: any JSON value. */
const scriptedTurn: JsonSchema = closed({
  text: { type: "string" },
  toolCalls: { type: "array", items: scriptedToolCall },
  output: {},
  usage: closed({
    inputTokens: nonNegativeInteger, outputTokens: nonNegativeInteger,
    cacheReadTokens: nonNegativeInteger, cacheWriteTokens: nonNegativeInteger,
  }),
  delayMs: timerMs,
  chunks: positiveInteger,
  fail: closed({
    attempts: nonNegativeInteger,
    status: { type: "integer", minimum: 100, maximum: 599 },
    network: { type: "boolean" },
    retryAfterMs: timerMs,
    message: { type: "string" },
    billing: { enum: ["none", "unknown"] },
  }, ["attempts"]),
});
const scriptedTurns: JsonSchema = { type: "array", items: scriptedTurn };
/**
 * Step name → one turn or a list of turns. One schema for both (object keywords apply to an object, `items` to an
 * array) rather than an `anyOf`, so a problem inside a step's turn is reported at its own path.
 */
const scriptedSteps: JsonSchema = {
  type: "object",
  additionalProperties: { ...scriptedTurn, type: ["object", "array"], items: scriptedTurn },
};

/** One variant (`ScriptedVariant`): `when` says which requests it applies to. */
const scriptedVariant: JsonSchema = closed({
  when: closed({ contains: { type: "string" }, in: { enum: ["system", "messages", "any"] } }, ["contains"]),
  turns: scriptedTurns,
  steps: scriptedSteps,
}, ["when"]);

/** The scripted model's script (`ScriptedScript`), closed at every depth. */
const scriptedScript: JsonSchema = closed({ turns: scriptedTurns, steps: scriptedSteps, variants: { type: "array", items: scriptedVariant } });

/** A model reference (`ModelRef`), closed. Also the shape of `learning.graderModel` in the configuration. */
export const modelRefSchema: JsonSchema = {
  type: "object",
  required: ["provider", "name"],
  additionalProperties: false,
  properties: {
    provider: { enum: ["scripted", "anthropic", "openai-compatible"] },
    name: { type: "string", minLength: 1, maxLength: 200 },
    baseUrl: { type: "string", minLength: 1 },
    apiKeySecret: secretName,
    maxOutputTokens: positiveInteger,
    contextTokens: positiveInteger,
    script: scriptedScript,
  },
};

/**
 * A definition is validated in full: every object is closed (`additionalProperties: false`) or a map whose values
 * have a schema, so an unknown key or a value of the wrong type is reported with its path at any depth. The only
 * intentionally open payloads are a scripted tool call's `args` (any JSON object), a scripted turn's `output`
 * (any JSON value) and `workflow` (checked here as an object, and in full by the workflow validator).
 */
export const agentDefinitionSchema: JsonSchema = {
  type: "object",
  required: ["name", "instructions", "model", "tools", "limits", "learning"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 120 },
    instructions: { type: "string" },
    model: modelRefSchema,
    tools: {
      type: "array",
      items: {
        type: "object",
        required: ["name"],
        additionalProperties: false,
        properties: {
          name: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
          policy: { enum: ["allow", "ask", "deny"] },
        },
      },
    },
    limits: {
      type: "object",
      additionalProperties: false,
      properties: { maxCostMicros: nonNegativeInteger, maxToolCalls: nonNegativeInteger, maxTurns: nonNegativeInteger },
    },
    learning: { type: "boolean" },
    workflow: { type: "object" },
    secrets: { type: "array", items: secretName },
  },
};

/** Schema problems plus duplicate tool names. */
export function validateAgentDefinition(value: unknown): SchemaProblem[] {
  const problems = validateSchema(agentDefinitionSchema, value);
  if (isJsonObject(value) && Array.isArray(value["tools"])) {
    const seen = new Set<string>();
    value["tools"].forEach((entry, index) => {
      if (!isJsonObject(entry) || typeof entry["name"] !== "string") return;
      const name = entry["name"];
      if (seen.has(name)) {
        problems.push({
          path: `${pathIndex("$.tools", index)}.name`,
          keyword: "uniqueTools",
          message: `tool ${JSON.stringify(name)} is listed more than once`,
        });
      }
      seen.add(name);
    });
  }
  return problems;
}
