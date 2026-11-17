/**
 * docs/workflows.md and docs/configuration.md state that every duration is bounded by the longest wait one Node
 * timer holds (2147483647 ms), and the validator and the configuration loader enforce it (R08-03).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_TIMER_MS } from "../../src/core/clock.ts";
import { RunwrightError } from "../../src/core/errors.ts";
import { loadConfig } from "../../src/config/load.ts";
import type { WorkflowDocument } from "../../src/workflow/types.ts";
import { validateWorkflow } from "../../src/workflow/validate.ts";
import { makeTempDir } from "../helpers/tmp.ts";

const WORKFLOWS = fileURLToPath(new URL("../../docs/workflows.md", import.meta.url));
/** Sentence D2 of the round-15 plan (2.7), verbatim. */
const D2 = "(within one poll interval, `runner.pollMs`, of the instant when a runner has a free slot; a runner whose slots are all busy " +
  "does not look for work, so the wake-up then waits until a slot is free)";
const CONFIGURATION = fileURLToPath(new URL("../../docs/configuration.md", import.meta.url));

async function doc(path: string): Promise<string> {
  return readFile(path, "utf8");
}

/** The text of a `## heading` section, up to the next `## ` heading. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n## ${heading}\n`);
  assert.ok(start >= 0, `section "${heading}" exists`);
  const end = text.indexOf("\n## ", start + 1);
  return text.slice(start, end === -1 ? undefined : end);
}

/** Every run of whitespace as one space. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

function workflowWithDeadline(deadlineMs: number): WorkflowDocument {
  return {
    format: "runwright.workflow/v1",
    name: "limits",
    schemas: { Input: { type: "object" }, Output: {} },
    input: "Input",
    output: "Output",
    root: { id: "main", kind: "sequence", steps: [{ id: "ask", kind: "model", prompt: "p", output: "Output", deadlineMs }] },
    result: null,
  };
}

async function configProblemPaths(dataDir: string, file: object): Promise<string[] | null> {
  await writeFile(join(dataDir, "config.json"), JSON.stringify(file));
  try {
    await loadConfig({ env: {}, overrides: { dataDir } });
    return null;
  } catch (error) {
    assert.ok(error instanceof RunwrightError && error.code === "config_invalid", String(error));
    return ((error.details?.["problems"] ?? []) as { path: string }[]).map((p) => p.path);
  }
}

test("the timer limit is 2147483647 ms", () => {
  assert.equal(MAX_TIMER_MS, 2147483647);
});

test("docs/workflows.md states the duration limits of a node, and the validator enforces them", async () => {
  const text = await doc(WORKFLOWS);
  const retry = flat(section(text, "Retry and deadlines"));
  assert.match(retry, /`deadlineMs` is a positive integer of at most 2147483647 ms \(about 24\.8 days, the longest wait one timer holds\)/);
  assert.match(retry, /`retry\.backoffMs` and `retry\.maxBackoffMs` are numbers from 0 to 2147483647, and `retry\.factor` is a finite number of at least 1/);
  assert.match(retry, /The delay between attempts is never more than 2147483647 ms\./);
  assert.match(text, /\| `missing_bound` \| [^\n]*`retry\.backoffMs` \(0–2147483647\) \|/);
  assert.match(text, /\| `bad_deadline` \| `deadlineMs` that is not an integer from 1 to 2147483647 \(an error, on every node kind\), or a valid `deadlineMs` on a `fail` node, where it has no effect \(a warning\) \|/);
  assert.match(retry, /`deadlineMs` \(positive integer\) is accepted by the validator on every node kind\./);
  assert.match(retry, /On a `fail` node it has no effect, and the validator says so with a `bad_deadline` warning: `"deadlineMs" has no effect on a fail node`\./);
  assert.doesNotMatch(flat(text), /no effect on a wait node|on `wait` and `fail` nodes/i);

  assert.equal(validateWorkflow(workflowWithDeadline(2147483647)).problems.filter((p) => p.code === "bad_deadline").length, 0);
  const over = validateWorkflow(workflowWithDeadline(2147483648));
  assert.equal(over.ok, false);
  assert.deepEqual(over.problems.filter((p) => p.code === "bad_deadline").map((p) => p.path), ["$.root.steps[0].deadlineMs"]);

  const onWait = workflowWithDeadline(1000);
  onWait.root = { id: "main", kind: "sequence", steps: [{ id: "ask", kind: "wait", question: "q", deadlineMs: 1000 } as WorkflowDocument["root"]] };
  const bounded = validateWorkflow(onWait);
  assert.deepEqual([bounded.ok, bounded.problems], [true, []], "a deadline on a wait node bounds the answer: no problem");
  const onFail = workflowWithDeadline(1000);
  onFail.root = { id: "main", kind: "sequence", steps: [{ id: "stop", kind: "fail", message: "m", deadlineMs: 1000 } as WorkflowDocument["root"]] };
  const inert = validateWorkflow(onFail);
  assert.equal(inert.ok, true);
  assert.deepEqual(inert.problems.filter((p) => p.code === "bad_deadline").map((p) => [p.severity, p.message]), [["warning", `"deadlineMs" has no effect on a fail node`]]);
  const badOnWait = workflowWithDeadline(1000);
  badOnWait.root = { id: "main", kind: "sequence", steps: [{ id: "ask", kind: "wait", question: "q", deadlineMs: 0 } as WorkflowDocument["root"]] };
  assert.deepEqual(validateWorkflow(badOnWait).problems.filter((p) => p.code === "bad_deadline").map((p) => p.severity), ["error"]);
  const onSequence = workflowWithDeadline(1000);
  onSequence.root = { id: "main", kind: "sequence", deadlineMs: 1000, steps: [{ id: "ask", kind: "model", prompt: "p", output: "Output" }] } as WorkflowDocument["root"];
  assert.deepEqual(validateWorkflow(onSequence).problems, []);
});

test("docs/workflows.md states what deadlineMs bounds on each node kind, nesting, and that a node deadline is an instant", async () => {
  const text = await doc(WORKFLOWS);
  const retry = flat(section(text, "Retry and deadlines"));
  assert.match(retry, /On `tool`, `model` and `decide` nodes it bounds each attempt's call: when it passes, the call is aborted \(`deadline_exceeded`; a model call is charged at its worst case, a tool call finishes with `outcome: "timeout"`\)\./);
  assert.match(retry, /\*\*A deadline on a composite node bounds the whole node\.\*\* On `sequence`, `parallel`, `branch`, `map`, `loop`, `call` and `agent` nodes, the node must finish within `deadlineMs` of its start, everything inside it included/);
  assert.match(retry, /When it passes, calls in flight inside the node are aborted and journalled as timeouts \(a tool call `tool\.finished \{outcome: "timeout"\}`, a model call `model\.interrupted \{reason: "deadline"\}`, charged at its worst case\), no further step of the node starts, and the node fails with `deadline_exceeded`/);
  assert.match(retry, /\*\*Nested deadlines: the earliest one wins\.\*\*/);
  assert.match(retry, /\*\*A deadline on a `wait` node bounds the answer\.\*\* The question must be answered within `deadlineMs` of the node's start\. An answer the server accepted before that instant counts, however late the run resumes\./);
  assert.match(retry, /the pending is resolved `\{expired: true, expiresAt\}`, and the node fails: the run fails with the error code `workflow_failed` and the message `node "<id>" failed: deadline_exceeded: the question was not answered before its deadline`\./);
  assert.match(retry, /\*\*A node deadline is an instant, not a timer\.\*\* For a composite node, an `agent` hand-off and a `wait`, the deadline is the node's start as journalled \(`node\.started`\) plus `deadlineMs`\./);
  assert.ok(retry.includes("time waiting for a person, time paused, a release at shutdown, a crash and a restart all count. A run that is " +
    "waiting when the instant passes is woken " + D2 + " and the node fails; a run that is paused stays paused and the node fails when " +
    "the run is resumed; a run that comes back after the instant starts nothing more inside the node."), retry);
  assert.doesNotMatch(flat(text), /at most one poll interval/, "the round-14 wording is gone");
  assert.match(retry, /\*\*A call deadline is per call\.\*\* On `tool`, `model` and `decide` nodes `deadlineMs` measures one execution of the call: a call that is attempted again \(a retry, a resume after a suspend or a crash\) gets a fresh bound, and the time a tool call waits for an approval comes before the call and is not counted\./);
  assert.match(retry, /\*\*Pendings carry the instant\.\*\* A pending opened inside a node deadline [^.]* carries `detail\.expiresAt`/);
  assert.doesNotMatch(retry, /entered again under a fresh deadline|does not wake a waiting or paused run|is never counted/);
  const wait = flat(text.slice(text.indexOf("\n### `wait`\n"), text.indexOf("\n### `fail`\n")));
  assert.match(wait, /With `deadlineMs`, the question must be answered within that time of the node's start\. When it is not, the pending is closed as expired and the node fails with `deadline_exceeded`\. The pending's `detail\.expiresAt` is the instant/);
  assert.match(flat(text), /it bounds each call of a `tool`, `model` or `decide` node, the whole node on the composite kinds and `agent`, the time a person has to answer on `wait`, and nothing on `fail`/);
  assert.match(flat(text), /Every node builder accepts `deadlineMs` \(and `title`\)/);
  assert.match(flat(section(text, "Dry run")), /no `deadlineMs` ever passes in it: a document dry-runs exactly as the same document without its deadlines\./);
  for (const kind of ["tool", "model", "decide", "branch", "sequence", "parallel", "map", "loop", "call", "agent", "wait", "fail"]) {
    const row = text.split("\n").find((line) => line.startsWith(`| \`${kind}\` |`));
    assert.ok(row !== undefined && row.includes("`deadlineMs?`"), `the ${kind} row lists deadlineMs: ${row ?? "missing"}`);
  }
});

const ROWS: { key: string; range: string; file: (value: number) => object }[] = [
  { key: "server.ssePingMs", range: "1–2147483647", file: (v) => ({ server: { ssePingMs: v } }) },
  { key: "runner.leaseMs", range: "1–2147483647", file: (v) => ({ runner: { leaseMs: v, heartbeatMs: 1000 } }) },
  { key: "runner.heartbeatMs", range: "1–2147483647", file: (v) => ({ runner: { leaseMs: 2147483647, heartbeatMs: v === 2147483647 ? 2147483646 : v } }) },
  { key: "runner.pollMs", range: "1–2147483647", file: (v) => ({ runner: { pollMs: v } }) },
  { key: "runner.shutdownGraceMs", range: "0–2147483647", file: (v) => ({ runner: { shutdownGraceMs: v } }) },
  { key: "tools.shell.timeoutMs", range: "1–2147483647", file: (v) => ({ tools: { shell: { timeoutMs: v } } }) },
  { key: "tools.webFetch.timeoutMs", range: "1–2147483647", file: (v) => ({ tools: { webFetch: { timeoutMs: v } } }) },
  { key: "triggers.tickMs", range: "1–2147483647", file: (v) => ({ triggers: { tickMs: v } }) },
];

test("docs/configuration.md states the Durations rule, and the loader enforces it", async (t) => {
  const text = flat(await doc(CONFIGURATION));
  assert.match(text, /\*\*Durations\.\*\* Every key that ends in `Ms` is a whole number of milliseconds of at most 2147483647 \(2\^31 − 1, about 24\.8 days: the longest wait one timer holds\)\./);
  assert.match(text, /A larger value is refused when the configuration is loaded \(`config_invalid` with the key's path\), whether it comes from `config\.json`, an environment variable or a flag\./);
  const dataDir = await makeTempDir(t);
  assert.equal(await configProblemPaths(dataDir, { tools: { shell: { timeoutMs: 2147483647 } } }), null);
  assert.deepEqual(await configProblemPaths(dataDir, { tools: { shell: { timeoutMs: 2147483648 } } }), ["$.tools.shell.timeoutMs"]);
  const fromEnv = loadConfig({ env: { RUNWRIGHT_POLL_MS: "2147483648" }, overrides: { dataDir: await makeTempDir(t) } });
  await assert.rejects(fromEnv, (e: unknown) => e instanceof RunwrightError && e.code === "config_invalid");
});

test("each duration row of the configuration table names its range, and the loader holds to it", async (t) => {
  const raw = await doc(CONFIGURATION);
  const dataDir = await makeTempDir(t);
  for (const row of ROWS) {
    const line = raw.split("\n").find((l) => l.startsWith(`| \`${row.key}\` |`));
    assert.ok(line !== undefined, `a row for ${row.key}`);
    assert.ok(line.trimEnd().endsWith(`(${row.range}) |`), `${row.key}: ${line}`);
    assert.equal(await configProblemPaths(dataDir, row.file(2147483647)), null, `${row.key} at the limit`);
    assert.ok((await configProblemPaths(dataDir, row.file(2147483648)))?.includes(`$.${row.key}`), `${row.key} above the limit`);
  }
});
