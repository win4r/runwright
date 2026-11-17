import { RunwrightError, isRunwrightError } from "../../core/errors.ts";
import { isJsonObject, type Json, type JsonObject } from "../../core/json.ts";
import type { SchemaProblem } from "../../schema/validate.ts";
import type { WorkflowProblem } from "../types.ts";

/** Where a node sits: its id, its JSON path inside its document, the document's name and the scope string. */
export interface NodePlace { nodeId: string; path: string; workflow: string; scope: string }

/** Codes that come from the document or the data, so running the same attempt again cannot change the outcome. */
const PERMANENT_CODES = new Set<string>([
  "workflow_invalid", "reference_unresolved", "validation_failed", "limit_reached", "workflow_failed",
]);
/** Tool outcomes worth another attempt; a denial, a bad argument or an unknown tool will not change. */
const RETRYABLE_OUTCOMES = new Set<string>(["error", "timeout"]);

/** A node failure: `workflow_failed` carrying the node id, its path and the underlying code. */
export function nodeFailure(place: NodePlace, message: string, extra?: JsonObject): RunwrightError {
  return new RunwrightError("workflow_failed", `node "${place.nodeId}" failed: ${message}`, {
    details: { nodeId: place.nodeId, path: place.path, workflow: place.workflow, scope: place.scope, ...extra },
  });
}

/**
 * Turns any error raised while a node ran into a node failure of that node. A `workflow_failed` error is
 * passed through unchanged: it already names the innermost node that failed.
 */
export function asNodeFailure(error: unknown, place: NodePlace): RunwrightError {
  if (isRunwrightError(error) && error.code === "workflow_failed") return error;
  if (isRunwrightError(error)) {
    const extra: JsonObject = { code: error.code };
    if (error.details !== undefined) extra["cause"] = error.details;
    return nodeFailure(place, `${error.code}: ${error.message}`, extra);
  }
  const message = error instanceof Error ? error.message : String(error);
  return nodeFailure(place, message, { code: "internal" });
}

/**
 * The error raised by a tool node attempt whose tool returned an error result. When the result's
 * `data.providerWait` names a provider wait (`run_workflow` whose nested model step failed with one outstanding),
 * its `retryAfterMs` and `retryAfterOverLimit` are carried in `details`, so the node's retry honours them.
 */
export function toolAttemptError(tool: string, outcome: string, content: string, data?: Json): RunwrightError {
  const wait = isJsonObject(data) && isJsonObject(data["providerWait"]) ? waitFields(data["providerWait"]) : null;
  return new RunwrightError("tool_failed", `tool "${tool}" returned ${outcome}: ${content}`, { details: { tool, outcome, ...wait } });
}

/** `retryAfterMs` (a finite number > 0) and `retryAfterOverLimit` (true) of `details`; null when it has neither. */
function waitFields(details: JsonObject): JsonObject | null {
  const out: JsonObject = {};
  const wait = details["retryAfterMs"];
  if (typeof wait === "number" && Number.isFinite(wait) && wait > 0) out["retryAfterMs"] = wait;
  if (details["retryAfterOverLimit"] === true) out["retryAfterOverLimit"] = true;
  return Object.keys(out).length === 0 ? null : out;
}

/**
 * The provider wait a failure names, from its own `details` or, for a node failure, from the details of the error
 * it wraps (`details.cause`): `{retryAfterMs?, retryAfterOverLimit?}`, or null when it names none.
 */
export function providerWaitOf(error: unknown): JsonObject | null {
  if (!isRunwrightError(error) || error.details === undefined) return null;
  const own = waitFields(error.details);
  if (own !== null) return own;
  const cause = error.details["cause"];
  return isJsonObject(cause) ? waitFields(cause) : null;
}

/**
 * True when another attempt of a retryable node may succeed. A model call the engine stopped because the provider
 * asked for a wait longer than the engine will wait (`details.retryAfterOverLimit`) is not retried: another
 * attempt now cannot succeed and would break that wait.
 */
export function isRetryable(error: unknown): boolean {
  if (!isRunwrightError(error)) return true;
  if (error.details?.["retryAfterOverLimit"] === true) return false;
  if (error.code === "tool_failed") {
    const outcome = error.details?.["outcome"];
    return typeof outcome === "string" && RETRYABLE_OUTCOMES.has(outcome);
  }
  return !PERMANENT_CODES.has(error.code);
}

/** The provider wait still outstanding when a model step failed (`details.retryAfterMs`), in ms; 0 when none. */
export function providerWaitMs(error: unknown): number {
  if (!isRunwrightError(error)) return 0;
  const wait = error.details?.["retryAfterMs"];
  return typeof wait === "number" && Number.isFinite(wait) && wait > 0 ? wait : 0;
}

/** The code recorded for an attempt's error. */
export function errorCode(error: unknown): string {
  return isRunwrightError(error) ? error.code : "internal";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function schemaProblemsJson(problems: readonly SchemaProblem[]): Json[] {
  return problems.map((p) => ({ path: p.path, keyword: p.keyword, message: p.message }));
}

export function workflowProblemsJson(problems: readonly WorkflowProblem[]): Json[] {
  return problems.map((p) => {
    const out: JsonObject = { path: p.path, code: p.code, message: p.message, severity: p.severity };
    if (p.nodeId !== undefined) out["nodeId"] = p.nodeId;
    return out;
  });
}

export function listSchemaProblems(problems: readonly SchemaProblem[]): string {
  return problems.map((p) => `${p.path}: ${p.message}`).join("; ");
}
