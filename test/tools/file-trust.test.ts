/**
 * Finding R09D-spec-04 (Rule T): `isTrustedContent` decides from the journal alone whether bytes with a digest are
 * the run's own work.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Json, JsonObject } from "../../src/core/json.ts";
import type { JournalRecord } from "../../src/store/types.ts";
import { isTrustedContent, sha256OfBytes } from "../../src/tools/file-trust.ts";

const D = createHash("sha256").update("the bytes").digest("hex");
const OTHER = createHash("sha256").update("other bytes").digest("hex");

function record(type: string, data: JsonObject): JournalRecord {
  return { runId: "run_1", seq: 1, epoch: 1, ts: 0, type, key: "k", data };
}

function finished(tool: string, data: Json, extra?: JsonObject): JournalRecord {
  return record("tool.finished", {
    callId: "c1", tool, outcome: "ok", content: "", data, isError: false, untrusted: false, truncated: false,
    fullResultPath: null, durationMs: 1, ...extra,
  });
}

test("sha256OfBytes is the lower-case hex SHA-256", () => {
  assert.equal(sha256OfBytes(Buffer.from("the bytes")), D);
  assert.match(sha256OfBytes(new Uint8Array()), /^[0-9a-f]{64}$/);
});

test("an empty journal vouches for nothing", () => {
  assert.equal(isTrustedContent([], D), false);
});

test("a write_file or edit_file result with the same digest vouches", () => {
  assert.equal(isTrustedContent([finished("write_file", { path: "a", bytes: 9, sha256: D })], D), true);
  assert.equal(isTrustedContent([finished("edit_file", { path: "a", replacements: 1, bytes: 9, sha256: D })], D), true);
  assert.equal(isTrustedContent([finished("write_file", { path: "a", bytes: 9, sha256: OTHER })], D), false);
});

test("an error or untrusted write does not vouch", () => {
  assert.equal(isTrustedContent([finished("write_file", { sha256: D }, { isError: true })], D), false);
  assert.equal(isTrustedContent([finished("edit_file", { sha256: D }, { untrusted: true })], D), false);
});

test("another tool's data.sha256 does not vouch: a host tool cannot vouch for its own files", () => {
  for (const tool of ["read_file", "download", "shell", "list_files", "delete_file"]) {
    assert.equal(isTrustedContent([finished(tool, { sha256: D })], D), false, tool);
  }
});

test("a digest anywhere but data.sha256 of a writing tool does not vouch", () => {
  assert.equal(isTrustedContent([finished("write_file", D)], D), false);
  assert.equal(isTrustedContent([finished("write_file", [D])], D), false);
  assert.equal(isTrustedContent([finished("write_file", { nested: { sha256: D } })], D), false);
  assert.equal(isTrustedContent([finished("write_file", null, { content: D })], D), false);
});

test("a trusted saved result or saved data file vouches; an untrusted or failed one does not", () => {
  assert.equal(isTrustedContent([finished("report", null, { fullResultPath: "p", fullResultSha256: D, fullResultBytes: 9 })], D), true);
  assert.equal(isTrustedContent([finished("report", null, { fullDataPath: "p", fullDataSha256: D, fullDataBytes: 9 })], D), true);
  assert.equal(isTrustedContent([finished("lookup", null, { untrusted: true, fullResultPath: "p", fullResultSha256: D })], D), false);
  assert.equal(isTrustedContent([finished("lookup", null, { isError: true, fullDataPath: "p", fullDataSha256: D })], D), false);
});

test("records of other types do not vouch, whatever they hold", () => {
  const journal = [
    record("step.finished", { name: "s", value: { sha256: D }, tool: "write_file", data: { sha256: D } }),
    record("tool.started", { callId: "c", tool: "write_file", args: { sha256: D }, effect: "write", attempt: 1 }),
    record("tool.interrupted", { tool: "write_file", args: { content: "the bytes" }, attempt: 1, data: { sha256: D } }),
  ];
  assert.equal(isTrustedContent(journal, D), false);
});

test("one vouching record among many is enough, wherever it is", () => {
  const noise = Array.from({ length: 50 }, (_, i) => finished("write_file", { sha256: createHash("sha256").update(String(i)).digest("hex") }));
  assert.equal(isTrustedContent([...noise, finished("write_file", { sha256: D }), ...noise], D), true);
  assert.equal(isTrustedContent([finished("write_file", { sha256: D }, { untrusted: true }), ...noise], D), false);
});
