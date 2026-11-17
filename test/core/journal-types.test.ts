import { test } from "node:test";
import assert from "node:assert/strict";
import { dataOf, newRecord } from "../../src/engine/journal-types.ts";
import type { JournalRecord } from "../../src/store/types.ts";
import { recordFieldsWith } from "../../src/store/record-fields.ts";

test("newRecord builds a NewJournalRecord with or without a key", () => {
  assert.deepEqual(newRecord("run.claimed", { runnerId: "r1" }), { type: "run.claimed", data: { runnerId: "r1" } });
  const withKey = newRecord("tool.interrupted", { tool: "write_file", args: { path: "a" }, attempt: 1 }, "t1.c0");
  assert.deepEqual(withKey, { type: "tool.interrupted", key: "t1.c0", data: { tool: "write_file", args: { path: "a" }, attempt: 1 } });
  assert.equal(Object.hasOwn(newRecord("run.released", { reason: "x" }), "key"), false);
});

test("round-2 record shapes: interrupted reason, repair flag, invalid replies, learning conflicts", () => {
  const interrupted = newRecord("tool.interrupted", { tool: "deploy", args: {}, attempt: 2, reason: "shutdown" }, "t1.c0");
  assert.deepEqual(interrupted.data, { tool: "deploy", args: {}, attempt: 2, reason: "shutdown" });
  const started = newRecord("model.started", {
    model: "p/m", purpose: "step", step: null, turn: 1, countsAsTurn: false, inputTokensEstimate: 1030, maxOutputTokens: 10,
    worstCaseMicros: 1080, repair: true,
  }, "s");
  assert.equal(started.data["repair"], true);
  const invalid = newRecord("model.invalid", {
    model: "p/m", purpose: "step", text: "", toolCalls: [], output: { n: "x" }, problems: [{ path: "$.n", message: "must be integer" }],
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, costMicros: 6, durationMs: 0,
  }, "s");
  assert.equal(invalid.type, "model.invalid");
  const applied = newRecord("learning.applied", { kept: [], held: [], conflicts: [{ path: "notes/a.md", reason: "retired meanwhile" }] });
  assert.deepEqual(applied.data["conflicts"], [{ path: "notes/a.md", reason: "retired meanwhile" }]);
});

test("round-3 record shapes: attempts on started, interrupted and failed; billing and assumed charge on retry", () => {
  const started = newRecord("model.started", {
    model: "p/m", purpose: "step", step: null, turn: 1, countsAsTurn: false, inputTokensEstimate: 1030, maxOutputTokens: 10,
    worstCaseMicros: 1080, repair: false, attempt: 2,
  }, "s");
  assert.equal(started.data["attempt"], 2);
  const retry = newRecord("model.retry", {
    attempt: 2, delayMs: 400, code: "model_transient", message: "stream cut", status: null, billing: "unknown", assumedCostMicros: 1080,
  }, "s");
  assert.deepEqual(retry.data, { attempt: 2, delayMs: 400, code: "model_transient", message: "stream cut", status: null, billing: "unknown", assumedCostMicros: 1080 });
  const refused = newRecord("model.retry", { attempt: 1, delayMs: 3000, code: "model_transient", message: "429", status: 429, billing: "none" }, "s");
  assert.equal(Object.hasOwn(refused.data, "assumedCostMicros"), false);
  const interrupted = newRecord("model.interrupted", { model: "p/m", reason: "pause", assumedCostMicros: 1080, attempt: 3 }, "s");
  assert.equal(interrupted.data["attempt"], 3);
  const failed = newRecord("model.failed", {
    model: "p/m", error: { code: "model_failed", message: "model call failed after 3 attempts (last error: no status): cut" },
    attempts: 3, assumedCostMicros: null,
  }, "s");
  assert.deepEqual([failed.data["attempts"], failed.data["assumedCostMicros"]], [3, null]);
});

test("provider waits on model.retry and model.failed: retryAfterMs and retryAfterOverLimit", () => {
  const toRecord = (r: ReturnType<typeof newRecord>): JournalRecord => ({ runId: "r", seq: 1, epoch: 1, ts: 0, type: r.type, key: r.key ?? null, data: r.data });
  const retry = dataOf(toRecord(newRecord("model.retry", {
    attempt: 1, delayMs: 3000, code: "model_transient", message: "429", status: 429, billing: "none", retryAfterMs: 3000,
  }, "s")), "model.retry");
  assert.equal(retry?.retryAfterMs, 3000);
  assert.equal(retry?.delayMs, retry?.retryAfterMs);
  const failed = dataOf(toRecord(newRecord("model.failed", {
    model: "p/m", error: { code: "model_failed", message: "model call not retried after 1 attempt" }, attempts: 1,
    retryAfterMs: 7000, retryAfterOverLimit: true,
  }, "s")), "model.failed");
  assert.equal(failed?.retryAfterMs, 7000);
  assert.equal(failed?.retryAfterOverLimit, true);
  const plain = dataOf(toRecord(newRecord("model.failed", { model: "p/m", error: { code: "model_failed", message: "x" }, attempts: 1 }, "s")), "model.failed");
  assert.equal(plain?.retryAfterMs, undefined);
  assert.equal(plain?.retryAfterOverLimit, undefined);
});

test("dataOf returns typed data only for a matching type", () => {
  const record: JournalRecord = { runId: "run_1", seq: 3, epoch: 1, ts: 0, type: "run.failed", key: null,
    data: { error: { code: "internal", message: "boom" } } };
  const failed = dataOf(record, "run.failed");
  assert.deepEqual(failed?.error, { code: "internal", message: "boom" });
  assert.equal(dataOf(record, "run.completed"), null);
});

test("round-4 record shape: tool.finished with and without the digest of a saved full result", () => {
  const base = {
    callId: "c1", tool: "fetch", outcome: "ok" as const, content: "cut", data: null, isError: false, untrusted: true,
    truncated: true, fullResultPath: ".runwright/tool-results/untrusted/3-t1.c0.txt", durationMs: 4,
  };
  const digest = "a".repeat(64);
  const saved = newRecord("tool.finished", { ...base, fullResultSha256: digest, fullResultBytes: 1234 }, "t1.c0");
  assert.deepEqual([saved.data["fullResultSha256"], saved.data["fullResultBytes"]], [digest, 1234]);
  const old = newRecord("tool.finished", base, "t1.c0");
  assert.equal(Object.hasOwn(old.data, "fullResultSha256"), false);
  assert.equal(Object.hasOwn(old.data, "fullResultBytes"), false);
});

test("newRecord sets fields only when they are given, as the same object", () => {
  const fields = recordFieldsWith("step.finished", "value", { fields: { promptSection: "text" } });
  const declared = newRecord("step.finished", { name: "learning.given", value: { promptSection: "x" } }, "learning/given", fields);
  assert.deepEqual(declared, { type: "step.finished", key: "learning/given", data: { name: "learning.given", value: { promptSection: "x" } }, fields });
  assert.equal(declared.fields, fields);
  const keyless = newRecord("step.finished", { name: "n", value: 1 }, undefined, fields);
  assert.equal(Object.hasOwn(keyless, "key"), false);
  assert.equal(keyless.fields, fields);
  for (const record of [newRecord("step.finished", { name: "n", value: 1 }, "k"), newRecord("step.finished", { name: "n", value: 1 }, "k", undefined)]) {
    assert.equal(Object.hasOwn(record, "fields"), false, "no fields property without a declaration");
  }
});
