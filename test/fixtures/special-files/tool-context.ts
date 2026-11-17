/**
 * The built-in file tools and a minimal ToolContext for the special-file fixture scripts (not a script itself):
 * an empty journal, a signal that is never aborted, and the workspace stage claimed for epoch 1 before the first
 * call (`fileToolContext`), as a session claims it.
 */
import type { JsonObject } from "../../../src/core/json.ts";
import { createFileTools } from "../../../src/tools/fs.ts";
import type { ToolContext, ToolDefinition, ToolOutput } from "../../../src/tools/types.ts";
import { fileToolContext } from "../../helpers/tool-context.ts";

export type ToolCall = readonly [tool: string, args: JsonObject];

/** Calls the file tool `tool` of `workspace` with `args` (limits: 1024 bytes read, 1024 bytes written). */
export function fileToolCaller(workspace: string): (tool: string, args: JsonObject) => Promise<ToolOutput> {
  const tools = new Map<string, ToolDefinition>(
    createFileTools({ maxReadBytes: 1024, maxWriteBytes: 1024 }).map((tool) => [tool.name, tool]),
  );
  let context: Promise<ToolContext> | null = null;
  return async (tool, args) => {
    const definition = tools.get(tool);
    if (definition === undefined) throw new Error(`no tool ${tool}`);
    context ??= fileToolContext(workspace);
    return definition.handler(args, await context);
  };
}
