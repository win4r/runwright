import { canonicalJson, type Json } from "../../core/json.ts";
import { isControlSignal } from "../../engine/control.ts";
import type { RunContext } from "../../engine/types.ts";
import type { Store } from "../../store/types.ts";
import type { ToolDefinition } from "../../tools/types.ts";
import type { WorkflowDocument } from "../types.ts";
import { errorMessage, providerWaitOf } from "./errors.ts";
import { PROVIDER_WAIT_DATA_FIELDS, RESOLVE_VALUE_FIELDS } from "./value-fields.ts";

/** Validates and runs a document; `savedAs` is its storage identity (`ValidateOptions.savedAs`). */
export type ExecuteFn = (context: RunContext, document: WorkflowDocument, input: Json, savedAs: string | null) => Promise<Json>;

/**
 * `run_workflow`: runs a saved workflow as one tool call. The handler is built from durable steps under the
 * call's own key (`resumable`), so after a suspend or crash it replays the finished nodes and continues. The
 * workflow version (the one asked for, else the latest) is resolved once and journalled, so a version saved later
 * never changes a running call. The call's signal is honoured: its nested steps stop once it is aborted, and an
 * aborted call reaches the engine as an abort (a deadline is journalled as a timeout).
 */
export function createRunWorkflowTool(deps: { store: Pick<Store, "getWorkflow">; execute: ExecuteFn }): ToolDefinition {
  return {
    name: "run_workflow",
    description: "Run a saved workflow by name (and optionally version) with the given input and return its result as JSON.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: {
        name: { type: "string", minLength: 1, description: "Name of the saved workflow." },
        version: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: "Version of the saved workflow to run (default: the latest)." },
        input: { description: "Input for the workflow; it must match the workflow's input schema." },
      },
    },
    effect: "write",
    resumable: true,
    async handler(args, context) {
      const name = typeof args["name"] === "string" ? args["name"] : "";
      const version = Object.hasOwn(args, "version") ? args["version"] : undefined;
      if (version !== undefined && !(typeof version === "number" && Number.isSafeInteger(version) && version >= 1)) {
        return { content: `"version" must be an integer from 1 to ${Number.MAX_SAFE_INTEGER}, not ${canonicalJson(version)}`, isError: true };
      }
      const wanted = typeof version === "number" ? version : null;
      const input: Json = Object.hasOwn(args, "input") ? (args["input"] ?? null) : null;
      try {
        const pinned = await context.steps.memo("resolve", {
          recordType: "step", name: "workflow.resolve", info: { workflow: name }, valueFields: RESOLVE_VALUE_FIELDS,
        }, async () => {
          const saved = wanted === null ? await deps.store.getWorkflow(name) : await deps.store.getWorkflow(name, wanted);
          return { version: saved === null ? null : saved.version };
        });
        const version = pinned.version;
        if (typeof version !== "number") {
          const unknown = wanted === null ? `unknown workflow ${JSON.stringify(name)}` : `unknown workflow ${JSON.stringify(name)} version ${wanted}`;
          return { content: unknown, isError: true };
        }
        const saved = await deps.store.getWorkflow(name, version);
        if (saved === null) return { content: `saved workflow ${JSON.stringify(name)} version ${version} no longer exists`, isError: true };
        const result = await deps.execute(context.steps, saved.document, input, name);
        // A workflow that ran to its end although the call was aborted is still an aborted call.
        if (context.signal.aborted) throw context.signal.reason;
        return { content: canonicalJson(result), data: result };
      } catch (error) {
        if (isControlSignal(error)) throw error;
        // Aborted (its deadline, a pause, a shutdown): the engine journals the call as the abort, not as an error result.
        if (context.signal.aborted) throw error;
        const content = `workflow ${JSON.stringify(name)} failed: ${errorMessage(error)}`;
        // A nested model step that failed with a provider wait outstanding says so, for a tool node's retry.
        const wait = providerWaitOf(error);
        return wait === null
          ? { content, isError: true }
          : { content, isError: true, data: { providerWait: wait }, dataFields: PROVIDER_WAIT_DATA_FIELDS };
      }
    },
  };
}
