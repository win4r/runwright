import type { JsonObject } from "./json.ts";

export type ErrorCode =
  | "bad_request" | "invalid_json" | "body_too_large" | "validation_failed" | "unauthorized" | "not_found"
  | "method_not_allowed" | "conflict" | "run_terminal" | "pending_not_open" | "precondition_required"
  | "etag_mismatch" | "idempotency_mismatch" | "illegal_transition" | "lease_lost" | "commands_pending" | "learning_conflict"
  | "schema_too_new" | "store_error" | "tool_unknown" | "tool_failed" | "workspace_escape" | "ssrf_blocked"
  | "fetch_failed" | "model_unknown" | "model_transient" | "model_failed" | "model_output_invalid"
  | "secret_missing" | "limit_reached" | "workflow_invalid" | "workflow_failed" | "reference_unresolved"
  | "deadline_exceeded" | "webhook_signature" | "webhook_replay" | "trigger_disabled" | "cron_invalid"
  | "seal_failed" | "config_invalid" | "unavailable" | "aborted" | "internal";

export const HTTP_STATUS: Readonly<Record<ErrorCode, number>> = Object.freeze({
  bad_request: 400,
  invalid_json: 400,
  validation_failed: 400,
  cron_invalid: 400,
  workflow_invalid: 400,
  config_invalid: 400,
  reference_unresolved: 400,
  unauthorized: 401,
  webhook_signature: 401,
  webhook_replay: 401,
  not_found: 404,
  tool_unknown: 404,
  model_unknown: 404,
  secret_missing: 404,
  method_not_allowed: 405,
  conflict: 409,
  run_terminal: 409,
  pending_not_open: 409,
  idempotency_mismatch: 409,
  illegal_transition: 409,
  lease_lost: 409,
  commands_pending: 409,
  learning_conflict: 409,
  trigger_disabled: 409,
  limit_reached: 409,
  etag_mismatch: 412,
  body_too_large: 413,
  precondition_required: 428,
  unavailable: 503,
  schema_too_new: 500,
  store_error: 500,
  tool_failed: 500,
  workspace_escape: 500,
  ssrf_blocked: 500,
  fetch_failed: 500,
  model_transient: 500,
  model_failed: 500,
  model_output_invalid: 500,
  workflow_failed: 500,
  deadline_exceeded: 500,
  seal_failed: 500,
  aborted: 500,
  internal: 500,
});

export class RunwrightError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: JsonObject | undefined;

  constructor(code: ErrorCode, message: string, options?: { status?: number; details?: JsonObject; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RunwrightError";
    this.code = code;
    this.status = options?.status ?? HTTP_STATUS[code];
    this.details = options?.details;
  }
}

export function isRunwrightError(error: unknown): error is RunwrightError {
  return error instanceof RunwrightError;
}

export function errorInfo(error: unknown): { code: string; message: string } {
  if (error instanceof RunwrightError) return { code: error.code, message: error.message };
  if (error instanceof Error) return { code: "internal", message: error.message };
  return { code: "internal", message: String(error) };
}
