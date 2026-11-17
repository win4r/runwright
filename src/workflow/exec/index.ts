import { RunwrightError } from "../../core/errors.ts";
import type { Json } from "../../core/json.ts";
import type { Driver, RunContext } from "../../engine/types.ts";
import type { ToolDefinition } from "../../tools/types.ts";
import type { WorkflowDocument } from "../types.ts";
import { WorkflowExecutor, type WorkflowRuntimeDeps } from "./executor.ts";
import { createRunWorkflowTool } from "./run-workflow-tool.ts";

export type { WorkflowRuntimeDeps } from "./executor.ts";
export { MAX_CALL_DEPTH } from "./nodes.ts";

export interface WorkflowRuntime {
  /** Runs `context.definition.workflow` with input = run.input.data; its result is the run output. */
  driver: Driver;
  /**
   * Validates and runs a document durably on the context's primitives. `savedAs` is its storage identity: the
   * name it is saved under, or null for a document that is not a saved workflow.
   */
  execute(context: RunContext, document: WorkflowDocument, input: Json, savedAs: string | null): Promise<Json>;
  /** "run_workflow" {name, input}; resumable. */
  runWorkflowTool: ToolDefinition;
}

export function createWorkflowRuntime(deps: WorkflowRuntimeDeps): WorkflowRuntime {
  const execute = (context: RunContext, document: WorkflowDocument, input: Json, savedAs: string | null): Promise<Json> =>
    new WorkflowExecutor(context, deps).execute(document, input, savedAs);
  const driver: Driver = async (context) => {
    const workflow = context.definition.workflow;
    if (workflow === undefined) {
      throw new RunwrightError("workflow_invalid", `agent "${context.definition.name}" has no workflow document`);
    }
    return execute(context, workflow, context.run.input.data, null);
  };
  return { driver, execute, runWorkflowTool: createRunWorkflowTool({ store: deps.store, execute }) };
}
