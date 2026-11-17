import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../../src/log/logger.ts";
import { createFakeClock } from "../../src/core/clock.ts";
import { createRedactor } from "../../src/core/redact.ts";
import type { JsonObject } from "../../src/core/json.ts";
import { generateSealKey } from "../../src/security/seal.ts";
import { createSecretsService } from "../../src/security/secrets.ts";
import { openTestStore } from "../helpers/store.ts";

function capture() {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line), parsed: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

test("writes one JSON object per line with ts, level and msg", () => {
  const sink = capture();
  const clock = createFakeClock(Date.UTC(2026, 0, 2, 3, 4, 5));
  const logger = createLogger({ write: sink.write, clock });
  logger.info("hello", { n: 1 });
  assert.equal(sink.lines.length, 1);
  assert.doesNotMatch(sink.lines[0]!, /\n/);
  assert.deepEqual(sink.parsed()[0], { ts: "2026-01-02T03:04:05.000Z", level: "info", msg: "hello", n: 1 });
});

test("filters by level", () => {
  const sink = capture();
  const logger = createLogger({ write: sink.write, level: "warn" });
  logger.debug("d");
  logger.info("i");
  logger.warn("w");
  logger.error("e");
  assert.deepEqual(sink.parsed().map((r) => r["level"]), ["warn", "error"]);
  const all = capture();
  const debug = createLogger({ write: all.write, level: "debug" });
  debug.debug("d");
  assert.equal(all.lines.length, 1);
  const defaults = capture();
  createLogger({ write: defaults.write }).debug("hidden");
  assert.equal(defaults.lines.length, 0, "default level is info");
});

test("child loggers add fields; call fields win; reserved names are kept apart", () => {
  const sink = capture();
  const logger = createLogger({ write: sink.write, fields: { service: "rw" } });
  const child = logger.child({ runId: "run_1" }).child({ step: "t1" });
  child.warn("x", { step: "t2", msg: "shadow" });
  assert.deepEqual(sink.parsed()[0], {
    ts: sink.parsed()[0]!["ts"], level: "warn", msg: "x", service: "rw", runId: "run_1", step: "t2", field_msg: "shadow",
  });
  logger.info("parent");
  assert.equal(sink.parsed()[1]!["runId"], undefined);
});

test("the whole serialized line passes through redact", () => {
  const sink = capture();
  const redactor = createRedactor({ TOKEN: "super-secret-token" });
  const logger = createLogger({ write: sink.write, redact: (t) => redactor.text(t) });
  logger.error("failed with super-secret-token", { super_secret: "super-secret-token", nested: { list: ["super-secret-token"] } });
  logger.child({ token: "super-secret-token" }).info("child");
  for (const line of sink.lines) assert.doesNotMatch(line, /super-secret-token/);
  assert.match(sink.lines[0]!, /\[redacted:TOKEN\]/);
  assert.equal(sink.parsed().length, 2);
});

test("a throwing sink does not break the caller", () => {
  const logger = createLogger({ write: () => { throw new Error("disk full"); } });
  assert.doesNotThrow(() => logger.error("x"));
});

// The record is redacted as a value, then serialized: a secret that looks like JSON syntax or a number cannot
// break a line, and a numeric secret in a numeric field is replaced.

test("secrets that look like JSON syntax never break a line: every line parses with its level and msg", () => {
  const sink = capture();
  const redactor = createRedactor({ LEVEL: '"level":', TS: '{"ts":"2', MSG: '","msg":"', PIN: "12345678", NAME: "secret-field-name" });
  const clock = createFakeClock(Date.UTC(2026, 0, 2, 3, 4, 5));
  const logger = createLogger({ write: sink.write, redact: (t) => redactor.text(t), clock, level: "debug" });
  logger.info("plain message", { n: 1 });
  logger.warn('says "level": here', { value: 'x "level": y', nested: { deep: ['{"ts":"2', 'a","msg":"b'] }, "secret-field-name": "v" });
  logger.error("count", { pin: 12345678, list: [12345678, 3], other: 42 });
  logger.child({ "secret-field-name": 12345678 }).debug("child");
  const parsed = sink.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(parsed.map((r) => r["level"]), ["info", "warn", "error", "debug"]);
  assert.deepEqual(parsed.map((r) => r["msg"]), ["plain message", "says [redacted:LEVEL] here", "count", "child"]);
  for (const record of parsed) assert.equal(record["ts"], "2026-01-02T03:04:05.000Z");
  assert.equal(parsed[0]!["n"], 1);
  assert.equal(parsed[1]!["value"], "x [redacted:LEVEL] y");
  assert.deepEqual(parsed[1]!["nested"], { deep: ["[redacted:TS]", "a[redacted:MSG]b"] });
  assert.equal(parsed[1]!["[redacted:NAME]"], "v");
  assert.equal(Object.hasOwn(parsed[1]!, "secret-field-name"), false);
  assert.equal(parsed[2]!["pin"], "[redacted:PIN]");
  assert.deepEqual(parsed[2]!["list"], ["[redacted:PIN]", 3]);
  assert.equal(parsed[2]!["other"], 42);
  assert.equal(parsed[3]!["[redacted:NAME]"], "[redacted:PIN]");
  for (const line of sink.lines) {
    assert.doesNotMatch(line, /12345678|secret-field-name/);
    assert.doesNotMatch(line, /x "level": y/);
  }
});

test("the secrets service's redaction (placeholder [redacted]) keeps every line valid JSON", async (t) => {
  const { store } = await openTestStore(t);
  const secrets = await createSecretsService({ store, sealKey: generateSealKey() });
  await secrets.set("LEVEL", '"level":');
  await secrets.set("MSG", '","msg":"');
  await secrets.set("PIN", "12345678");
  const sink = capture();
  const logger = createLogger({ write: sink.write, redact: (text) => secrets.redactText(text) });
  logger.info("a", { f: '","msg":"', costMicros: 12345678 });
  const record = JSON.parse(sink.lines[0]!) as Record<string, unknown>;
  assert.deepEqual(record, { ts: record["ts"], level: "info", msg: "a", f: "[redacted]", costMicros: "[redacted]" });
});

test("a field that is a reserved name after redaction is kept apart from ts, level and msg", () => {
  const sink = capture();
  const logger = createLogger({ write: sink.write, redact: (text) => (text === "level-secret" ? "level" : text) });
  logger.info("m", { "level-secret": "shadow" });
  const record = JSON.parse(sink.lines[0]!) as Record<string, unknown>;
  assert.equal(record["level"], "info");
  assert.equal(record["field_level"], "shadow");
});

test("a redactor that throws does not break the caller, and the line is written without its fields or raw message", () => {
  const sink = capture();
  let calls = 0;
  const failing = createLogger({
    write: sink.write,
    redact: (text) => {
      calls += 1;
      if (text.includes("boom")) throw new Error("redactor broke");
      return text.replaceAll("hidden-value", "[gone]");
    },
  });
  assert.doesNotThrow(() => failing.warn("hidden-value happened", { field: "boom" }));
  assert.doesNotThrow(() => failing.error("boom hidden-value", { field: "ok" }));
  assert.ok(calls > 0);
  const parsed = sink.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(parsed.length, 2);
  assert.deepEqual(Object.keys(parsed[0]!), ["ts", "level", "msg"]);
  assert.equal(parsed[0]!["level"], "warn");
  assert.equal(parsed[0]!["msg"], "[gone] happened");
  assert.deepEqual(Object.keys(parsed[1]!), ["ts", "level", "msg"]);
  assert.equal(parsed[1]!["level"], "error");
  assert.equal(String(parsed[1]!["msg"]).includes("hidden-value"), false);
  assert.equal(String(parsed[1]!["msg"]).includes("boom"), false);
});

test("bigint, Error and repeated objects in fields are still written", () => {
  const sink = capture();
  const logger = createLogger({ write: sink.write });
  const shared = { a: 1 };
  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;
  const fields = { big: 12n, error: new Error("bad"), pair: [shared, shared], cyclic } as unknown as JsonObject;
  logger.info("m", fields);
  const record = JSON.parse(sink.lines[0]!) as Record<string, unknown>;
  assert.equal(record["big"], "12");
  assert.deepEqual(record["error"], { name: "Error", message: "bad" });
  assert.deepEqual(record["pair"], [{ a: 1 }, "[circular]"]);
  assert.deepEqual(record["cyclic"], { self: "[circular]" });
});
