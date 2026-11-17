import { join } from "node:path";
import type { Clock } from "../core/clock.ts";
import { RunwrightError } from "../core/errors.ts";
import type { EphemeralEvents } from "../core/events.ts";
import type { IdSource } from "../core/ids.ts";
import type { Config } from "../config/types.ts";
import type { Logger } from "../log/logger.ts";
import type { SecretsService } from "../security/types.ts";
import type { RunRecord, Store } from "../store/types.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ValidateOptions } from "../workflow/validate.ts";
import type { WorkflowDocument } from "../workflow/types.ts";
import type { SseHub } from "./sse.ts";

export interface ServerDeps {
  config: Config; store: Store; clock: Clock; ids: IdSource; logger: Logger; token: string;
  tools: ToolRegistry; secrets: SecretsService; events: EphemeralEvents | null; consolePath: string; version: string;
  runnerInfo: () => { id: string; active: number } | null;
}

export interface ServerContext {
  readonly deps: ServerDeps;
  readonly sse: SseHub;
}

export async function requireRun(store: Store, id: string): Promise<RunRecord> {
  const run = await store.getRun(id);
  if (run === null) throw new RunwrightError("not_found", `run ${id} not found`, { details: { runId: id } });
  return run;
}

export function workspaceOf(config: Config, runId: string): string {
  return join(config.dataDir, "workspaces", runId);
}

/** The tool catalogue as the workflow validator wants it. */
export function workflowTools(deps: ServerDeps): NonNullable<ValidateOptions["tools"]> {
  return deps.tools.list().map((tool) => ({
    name: tool.name,
    parameters: tool.parameters,
    retrySafe: tool.effect === "read" || tool.idempotent === true,
  }));
}

/**
 * The tool catalogue and a snapshot of the saved workflows, as the workflow validator wants them. For a document
 * that is not being saved (validate, dry-run, graph); a save validates inside its transaction instead.
 */
export async function workflowOptions(deps: ServerDeps): Promise<ValidateOptions & { resolveWorkflow: (name: string) => WorkflowDocument | null }> {
  const saved = new Map<string, WorkflowDocument>();
  for (const workflow of await deps.store.listWorkflows()) saved.set(workflow.name, workflow.document);
  return { tools: workflowTools(deps), resolveWorkflow: (name: string) => saved.get(name) ?? null };
}

/**
 * The validation options of an agent's embedded workflow: the catalogue of `workflowOptions` with `savedAs: null`,
 * because an embedded workflow is not a saved workflow and no `call` resolves to it by its own `name`. Agent saving
 * and the workflow routes' `embedded: true` both use this, so a document is checked as the same identity in both.
 */
export async function embeddedWorkflowOptions(deps: ServerDeps): Promise<ValidateOptions & { resolveWorkflow: (name: string) => WorkflowDocument | null; savedAs: null }> {
  return { ...(await workflowOptions(deps)), savedAs: null };
}

/**
 * The options a workflow route checks a document with: as an embedded workflow (`embedded: true`), else as the
 * saved workflow of the name it carries (`savedAs` absent).
 */
export function documentCheckOptions(deps: ServerDeps, embedded: boolean): Promise<ValidateOptions & { resolveWorkflow: (name: string) => WorkflowDocument | null }> {
  return embedded ? embeddedWorkflowOptions(deps) : workflowOptions(deps);
}

/** Reads an If-Match header; accepts the ETag with or without quotes (and a weak prefix). */
export function ifMatch(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") {
    throw new RunwrightError("precondition_required", "this change needs an If-Match header with the item's current ETag");
  }
  const unweak = trimmed.startsWith("W/") ? trimmed.slice(2) : trimmed;
  return unweak.length >= 2 && unweak.startsWith('"') && unweak.endsWith('"') ? unweak.slice(1, -1) : unweak;
}

export function etagHeader(etag: string): Record<string, string> {
  return { ETag: `"${etag}"` };
}
