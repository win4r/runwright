/**
 * The host tools the crash tests observe (not a test file). Each appends lines to one effects file, so a test
 * can count exactly how often a handler ran:
 *   record_effect {label}      write: appends "<label>\n"
 *   slow_effect {label, ms}    write: appends "start:<label>", waits ms (abortable), appends "end:<label>"
 *   slow_read {label, ms}      read:  the same, declared read-only (so the engine retries it after a crash)
 */
import { appendFile } from "node:fs/promises";
import { delay } from "../../src/core/clock.ts";
import { RunwrightError } from "../../src/core/errors.ts";
import type { JsonObject } from "../../src/core/json.ts";
import type { JsonSchema } from "../../src/schema/validate.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";

const labelSchema: JsonSchema = {
  type: "object", required: ["label"], additionalProperties: false, properties: { label: { type: "string", minLength: 1 } },
};
const slowSchema: JsonSchema = {
  type: "object", required: ["label", "ms"], additionalProperties: false,
  properties: { label: { type: "string", minLength: 1 }, ms: { type: "integer", minimum: 0, maximum: 60000 } },
};

function labelOf(args: JsonObject): string {
  return String(args["label"]);
}

/** The three host tools writing to `effectsFile` (a call fails with tool_failed when it is null). */
export function createHostTools(effectsFile: string | null): ToolDefinition[] {
  const file = (): string => {
    if (effectsFile === null || effectsFile === "") throw new RunwrightError("tool_failed", "HOST_EFFECTS_FILE is not set");
    return effectsFile;
  };
  const slow = (name: string, effect: "read" | "write"): ToolDefinition => ({
    name,
    description: `Appends start:<label>, waits ms milliseconds, appends end:<label> (${effect === "read" ? "read-only" : "a write"}).`,
    parameters: slowSchema,
    effect,
    async handler(args, context) {
      const target = file();
      await appendFile(target, `start:${labelOf(args)}\n`);
      await delay(Number(args["ms"]), context.signal);
      await appendFile(target, `end:${labelOf(args)}\n`);
      return { content: `${name} ${labelOf(args)} done` };
    },
  });
  return [
    {
      name: "record_effect",
      description: "Appends the label to the effects file.",
      parameters: labelSchema,
      effect: "write",
      async handler(args) {
        await appendFile(file(), `${labelOf(args)}\n`);
        return { content: `recorded ${labelOf(args)}` };
      },
    },
    slow("slow_effect", "write"),
    slow("slow_read", "read"),
  ];
}
