/**
 * `node file-tool-waves.ts <workspace> <json waves>`: `waves` is a list of lists of `[tool, args]` calls. The calls
 * of one wave run at the same time; a wave starts when the one before it has answered. Prints the outputs as one
 * JSON line, a list per wave.
 */
import { fileToolCaller, type ToolCall } from "./tool-context.ts";

const [workspace, waves] = process.argv.slice(2);
if (workspace === undefined || waves === undefined) throw new Error("usage: file-tool-waves.ts <workspace> <json waves>");
const call = fileToolCaller(workspace);
const outputs: unknown[] = [];
for (const wave of JSON.parse(waves) as ToolCall[][]) {
  outputs.push(await Promise.all(wave.map(([tool, args]) => call(tool, args))));
}
process.stdout.write(`${JSON.stringify(outputs)}\n`);
