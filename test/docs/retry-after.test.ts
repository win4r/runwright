/**
 * R07-01 in the docs: the README, the architecture notes and the configuration reference say that a provider's
 * retry-after wait is waited out in full, also after a resume, or the call stops; the message they quote is the
 * one the engine builds, and the default limit they name is the one the code uses.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultConfig } from "../../src/config/defaults.ts";
import { DEFAULT_MAX_RETRY_AFTER_MS, backoffDelayMs, retryAfterLimitMs } from "../../src/models/retry.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function doc(name: string): Promise<string> {
  return readFile(join(ROOT, name), "utf8");
}

/** The text of a `## heading` section, up to the next `## ` heading. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n## ${heading}\n`);
  assert.ok(start >= 0, `section "${heading}" exists`);
  const end = text.indexOf("\n## ", start + 1);
  return text.slice(start, end === -1 ? undefined : end);
}

/** Markdown wraps lines; compare with every run of whitespace as one space. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

test("the README says a provider's wait is served in full, also after a pause or restart, or the call stops", async () => {
  const readme = flat(section(await doc("docs/reference.md"), "Control and cost"));
  assert.match(readme, /waits that long, never less, before the next attempt/);
  assert.match(readme, /the rest of the wait is served first/);
  assert.match(readme, /A wait longer than `models\.retry\.maxRetryAfterMs` \(5 minutes by default\) is neither waited out nor cut short/);
  assert.match(flat(await doc("README.md")), /honouring `Retry-After` in full up to a configurable limit/);
});

test("the architecture notes describe the stop, the resumed wait and the journal fields", async () => {
  const text = await doc("docs/architecture.md");
  const calls = flat(section(text, "Model calls: reservations, interruption and repair"));
  assert.match(calls, /A hint is waited out in full or the call stops\./);
  assert.ok(calls.includes(
    "`model call not retried after N attempts (last error: status S | no status): the provider asked for a wait of W ms, " +
      "more than models.retry.maxRetryAfterMs (L ms): <last message>`",
  ), "the stop message");
  assert.match(calls, /the resumed session first waits whatever is left of that wait/);
  const journal = flat(section(text, "Journal records"));
  assert.match(journal, /`retryAfterMs`, the provider's retry-after hint in ms, present exactly when it gave one \(`delayMs` then equals it\)/);
  assert.match(journal, /`retryAfterMs`, present when the call ended while a provider's retry-after wait was outstanding/);
  assert.match(journal, /`retryAfterOverLimit: true`/);
});

test("the configuration reference has the limit with the default the code uses", async () => {
  const text = await doc("docs/configuration.md");
  const row = text.split("\n").find((line) => line.startsWith("| `models.retry.maxRetryAfterMs` |"));
  assert.ok(row !== undefined, "a row for models.retry.maxRetryAfterMs");
  const documented = Number(/^\| `models\.retry\.maxRetryAfterMs` \| `(\d+)` \|/.exec(row)?.[1]);
  assert.equal(documented, 300_000);
  assert.equal(documented, defaultConfig("/data").models.retry.maxRetryAfterMs);
  assert.equal(documented, DEFAULT_MAX_RETRY_AFTER_MS);
  assert.match(flat(section(text, "Models and keys")), /A hint longer than `maxRetryAfterMs` is never shortened/);
});

test("behind the sentences: the engine builds the quoted message and honours a hint under the default limit", async () => {
  const context = await readFile(join(ROOT, "src/engine/context.ts"), "utf8");
  assert.ok(context.includes("`model call not retried after ${attempts} attempt"), "the engine's stop message");
  assert.ok(context.includes("more than models.retry.maxRetryAfterMs (${limitMs} ms)"), "the engine's stop message");
  const defaultPolicy = defaultConfig("/data").models.retry;
  assert.equal(backoffDelayMs(defaultPolicy, 1, () => 0, 299_999), 299_999);
  assert.equal(retryAfterLimitMs(defaultPolicy), 300_000);
});
