import { RunwrightError } from "../core/errors.ts";
import { isJsonObject } from "../core/json.ts";
import { checkSchema } from "../schema/validate.ts";
import type { ToolDefinition } from "./types.ts";

export interface ToolRegistry {
  /** Throws bad_request on bad name, duplicate, or a schema that fails checkSchema. */
  register(tool: ToolDefinition): void;
  get(name: string): ToolDefinition | null;
  /** Sorted by name. */
  list(): ToolDefinition[];
}

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export function createToolRegistry(tools?: readonly ToolDefinition[]): ToolRegistry {
  const byName = new Map<string, ToolDefinition>();
  const registry: ToolRegistry = {
    register(tool: ToolDefinition): void {
      if (typeof tool.name !== "string" || !TOOL_NAME_PATTERN.test(tool.name)) {
        throw new RunwrightError("bad_request", `invalid tool name ${JSON.stringify(tool.name)}`);
      }
      if (byName.has(tool.name)) {
        throw new RunwrightError("bad_request", `tool ${JSON.stringify(tool.name)} is already registered`);
      }
      if (tool.effect !== "read" && tool.effect !== "write") {
        throw new RunwrightError("bad_request", `tool ${tool.name}: effect must be "read" or "write"`);
      }
      if (typeof tool.handler !== "function") {
        throw new RunwrightError("bad_request", `tool ${tool.name}: handler must be a function`);
      }
      const problems = checkSchema(tool.parameters);
      if (problems.length > 0) {
        throw new RunwrightError("bad_request", `tool ${tool.name}: invalid parameters schema: ${problems
          .map((p) => `${p.path}: ${p.message}`)
          .join("; ")}`, { details: { problems: problems.map((p) => ({ ...p })) } });
      }
      if (!isJsonObject(tool.parameters) || (tool.parameters["type"] !== undefined && tool.parameters["type"] !== "object")) {
        throw new RunwrightError("bad_request", `tool ${tool.name}: parameters must be an object schema`);
      }
      byName.set(tool.name, tool);
    },
    get(name: string): ToolDefinition | null {
      return byName.get(name) ?? null;
    },
    list(): ToolDefinition[] {
      return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },
  };
  for (const tool of tools ?? []) registry.register(tool);
  return registry;
}
