/**
 * `node file-tool.ts <workspace> <tool> <json args>`: calls one built-in file tool and prints its ToolOutput as
 * one JSON line.
 */
import type { JsonObject } from "../../../src/core/json.ts";
import { fileToolCaller } from "./tool-context.ts";

const [workspace, tool, args] = process.argv.slice(2);
if (workspace === undefined || tool === undefined || args === undefined) throw new Error("usage: file-tool.ts <workspace> <tool> <json args>");
const output = await fileToolCaller(workspace)(tool, JSON.parse(args) as JsonObject);
process.stdout.write(`${JSON.stringify(output)}\n`);
