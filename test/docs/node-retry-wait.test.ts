/**
 * The "Retry and deadlines" section of docs/workflows.md says that a node's retry waits out what is left of a
 * provider's retry-after wait and does not retry a call the engine stopped over the limit, and (R15D-workflow-01)
 * that after a restart or a resume a node waits only what is left of its backoff; the code backs it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { RunwrightError } from "../../src/core/errors.ts";
import { isRetryable, providerWaitMs, toolAttemptError } from "../../src/workflow/exec/errors.ts";
import { journalledDelayMs, retryDelayMs } from "../../src/workflow/exec/nodes.ts";
import type { JournalRecord } from "../../src/store/types.ts";

const WORKFLOWS = fileURLToPath(new URL("../../docs/workflows.md", import.meta.url));
const ARCHITECTURE = fileURLToPath(new URL("../../docs/architecture.md", import.meta.url));

/** The text of a `## heading` section, up to the next `## ` heading, with every run of whitespace as one space. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n## ${heading}\n`);
  assert.ok(start >= 0, `section "${heading}" exists`);
  const end = text.indexOf("\n## ", start + 1);
  return text.slice(start, end === -1 ? undefined : end).replace(/\s+/g, " ");
}

function errorWith(retryAfterMs: number): RunwrightError {
  return new RunwrightError("model_failed", "model call failed after 1 attempt (last error: status 429): HTTP 429", {
    details: { status: 429, attempts: 1, retryAfterMs },
  });
}

test("docs/workflows.md states how a node's retry treats a provider's wait", async () => {
  const text = section(await readFile(WORKFLOWS, "utf8"), "Retry and deadlines");
  assert.match(text, /the delay is at least what is left of that wait/);
  assert.match(text, /a model call the engine stopped because the provider asked for a wait longer than `models\.retry\.maxRetryAfterMs`/);
  assert.match(text, /\(\[configuration\.md\]\(configuration\.md#models-and-keys\)\)/);
});

test("the code behind the sentences", () => {
  const stopped = new RunwrightError("model_failed", "model call not retried after 1 attempt", {
    details: { status: 429, attempts: 1, retryAfterMs: 400_000, maxRetryAfterMs: 300_000, retryAfterOverLimit: true },
  });
  assert.equal(isRetryable(stopped), false);
  assert.equal(Math.max(retryDelayMs({ maxAttempts: 2, backoffMs: 1 }, 1), providerWaitMs(errorWith(1500))), 1500);
});

test("docs/workflows.md says a tool node's retry around run_workflow reads the nested wait, and the code backs it", async () => {
  const text = await readFile(WORKFLOWS, "utf8");
  const retrySection = section(text, "Retry and deadlines");
  assert.match(retrySection, /a `tool` node that calls `run_workflow` when the nested workflow failed in such a model step: the call's error result carries `data\.providerWait`/);
  assert.match(retrySection, /also when it was a model step of a workflow that a `tool` node ran with `run_workflow`/);
  assert.match(section(text, "Saved workflows and `run_workflow`"), /the result's `data` is `\{providerWait: \{retryAfterMs, retryAfterOverLimit\?\}\}`/);
  const nested = toolAttemptError("run_workflow", "error", "workflow \"inner\" failed", { providerWait: { retryAfterMs: 1500 } });
  assert.equal(Math.max(retryDelayMs({ maxAttempts: 2, backoffMs: 1 }, 1), providerWaitMs(nested)), 1500);
  assert.equal(isRetryable(toolAttemptError("run_workflow", "error", "x", { providerWait: { retryAfterMs: 400_000, retryAfterOverLimit: true } })), false);
});

function retryRecord(delayMs: unknown): JournalRecord {
  return { runId: "r", seq: 3, epoch: 1, ts: 1000, type: "node.retry", key: "wf/n#retry1", data: { nodeId: "n", attempt: 1, delayMs: delayMs as number } };
}

test("(R15D-workflow-01) the docs say a node waits only what is left of its backoff after a restart or a resume", async () => {
  const workflows = section(await readFile(WORKFLOWS, "utf8"), "Retry and deadlines");
  assert.match(workflows, /each retry is journalled once as `node\.retry` with its `delayMs`; the next attempt starts at that record's time plus `delayMs`/);
  assert.match(workflows, /after a restart or a resume, a node waits only what is left of its backoff/);
  assert.match(workflows, /the waits of all sessions together are never longer than `delayMs`/);
  const architecture = section(await readFile(ARCHITECTURE, "utf8"), "Journal records");
  assert.match(architecture, /after a restart or a resume a node waits only what is left of its backoff \(`ctx\.sleepUntil`\)/);
});

test("the code behind it: the wait ends at the record's ts + its journalled delayMs", () => {
  assert.equal(journalledDelayMs(retryRecord(10_000), 3), 10_000, "the journalled delay wins over this session's computation");
  assert.equal(journalledDelayMs(retryRecord(0), 3), 0);
  for (const bad of [-1, Number.NaN, "10", null]) assert.equal(journalledDelayMs(retryRecord(bad), 7), 7, String(bad));
});
