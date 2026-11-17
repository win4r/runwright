import { createAskPersonTool } from "./ask-person.ts";
import { createFileTools } from "./fs.ts";
import { createShellTool } from "./shell.ts";
import type { ToolDefinition } from "./types.ts";
import { createWebFetchTool, type WebFetchDeps } from "./web-fetch.ts";

export interface BuiltinToolOptions {
  files: { maxReadBytes: number; maxWriteBytes: number };
  shell: { enabled: boolean; timeoutMs: number; outputBytes: number };
  webFetch: WebFetchDeps;
}

/** read_file, write_file, edit_file, list_files, delete_file, ask_person, web_fetch, and shell only when enabled. */
export function createBuiltinTools(options: BuiltinToolOptions): ToolDefinition[] {
  const tools = [...createFileTools(options.files), createAskPersonTool(), createWebFetchTool(options.webFetch)];
  if (options.shell.enabled) tools.push(createShellTool({ timeoutMs: options.shell.timeoutMs, outputBytes: options.shell.outputBytes }));
  return tools;
}
