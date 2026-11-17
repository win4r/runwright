import { test } from "node:test";
import assert from "node:assert/strict";
import { HTTP_STATUS, RunwrightError, errorInfo, isRunwrightError } from "../../src/core/errors.ts";

test("RunwrightError carries code, default status, details and cause", () => {
  const cause = new Error("root");
  const error = new RunwrightError("not_found", "missing", { details: { id: "x" }, cause });
  assert.equal(error.code, "not_found");
  assert.equal(error.status, 404);
  assert.deepEqual(error.details, { id: "x" });
  assert.equal(error.cause, cause);
  assert.equal(error.message, "missing");
  assert.ok(error instanceof Error);
  assert.equal(new RunwrightError("conflict", "x", { status: 418 }).status, 418);
});

test("HTTP status table follows the contract", () => {
  const expected: Record<number, string[]> = {
    400: ["bad_request", "invalid_json", "validation_failed", "cron_invalid", "workflow_invalid", "config_invalid", "reference_unresolved"],
    401: ["unauthorized", "webhook_signature", "webhook_replay"],
    404: ["not_found", "tool_unknown", "model_unknown", "secret_missing"],
    405: ["method_not_allowed"],
    409: ["conflict", "run_terminal", "pending_not_open", "idempotency_mismatch", "illegal_transition", "lease_lost",
      "commands_pending", "learning_conflict", "trigger_disabled", "limit_reached"],
    412: ["etag_mismatch"], 413: ["body_too_large"], 428: ["precondition_required"], 503: ["unavailable"],
  };
  const listed = new Set<string>();
  for (const [status, codes] of Object.entries(expected)) {
    for (const code of codes) {
      listed.add(code);
      assert.equal(HTTP_STATUS[code as keyof typeof HTTP_STATUS], Number(status), code);
    }
  }
  for (const [code, status] of Object.entries(HTTP_STATUS)) if (!listed.has(code)) assert.equal(status, 500, code);
  assert.ok(Object.isFrozen(HTTP_STATUS));
});

test("isRunwrightError and errorInfo", () => {
  assert.equal(isRunwrightError(new RunwrightError("internal", "x")), true);
  assert.equal(isRunwrightError(new Error("x")), false);
  assert.deepEqual(errorInfo(new RunwrightError("lease_lost", "gone")), { code: "lease_lost", message: "gone" });
  assert.deepEqual(errorInfo(new TypeError("bad")), { code: "internal", message: "bad" });
  assert.deepEqual(errorInfo("text"), { code: "internal", message: "text" });
});
