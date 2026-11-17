/**
 * Runs each example as a child process with the command its README gives (read out of the README, see
 * `blocks.ts`), and checks the facts in its final JSON summary line. The README's other blocks, the CLI ones, are
 * run by readme-blocks.test.ts.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { exampleReadmes, isRunLine, ROOT } from "./blocks.ts";

interface ExampleResult { code: number; lines: string[]; summary: Record<string, unknown>; stderr: string }

/** The README's one line that runs `examples/<name>/run.ts`, split into the arguments after `node`. */
async function runArguments(name: string): Promise<string[]> {
  const readme = (await exampleReadmes()).find((r) => r.name === name);
  assert.ok(readme !== undefined, `examples/${name}/README.md`);
  const lines = readme.blocks.flat().filter((line) => isRunLine(name, line));
  assert.equal(lines.length, 1, `examples/${name}/README.md has one line that runs run.ts`);
  return (lines[0]?.command ?? "").split(/\s+/).slice(1);
}

async function runExample(name: string): Promise<ExampleResult> {
  const args = await runArguments(name);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("RUNWRIGHT_")) env[key] = value;
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, { cwd: ROOT, env, timeout: 60_000 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
        const lines = stdout.split("\n").filter((line) => line !== "");
        try {
          const summary = JSON.parse(lines.at(-1) ?? "null") as Record<string, unknown>;
          resolve({ code, lines, summary, stderr });
        } catch {
          reject(new Error(`example ${name} printed no JSON summary (exit ${code}):\n${stdout}\n${stderr}`));
        }
      });
  });
}

test("ask-and-write: waits on the question, then writes the answer into greeting.txt", { timeout: 60_000 }, async () => {
  const result = await runExample("ask-and-write");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.summary["status"], "completed");
  assert.equal(result.summary["content"], "Hello, Ada!\n");
  assert.equal(result.summary["question"], "What is your name?");
  assert.ok(result.lines.some((line) => line === "run is waiting"), "the run was shown waiting first");
});

test("triage-workflow: validates, dry-runs, and takes both the confident and the low-confidence route", { timeout: 60_000 }, async () => {
  const result = await runExample("triage-workflow");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.summary["valid"], true);
  assert.equal(result.summary["dryRunOk"], true);
  assert.ok(result.lines.some((line) => line.trim() === "flowchart TD"), "the Mermaid graph was printed");
  const results = result.summary["results"] as { ticket: string; status: string; route: string; urgent: boolean; file: string; agentTurns: number }[];
  const byTicket = new Map(results.map((r) => [r.ticket, r]));
  assert.deepEqual(byTicket.get("outage"), { ...byTicket.get("outage"), status: "completed", route: "confident", urgent: true, file: "urgent.txt", agentTurns: 0 });
  const printer = byTicket.get("printer");
  assert.equal(printer?.status, "completed");
  assert.equal(printer?.route, "low_confidence");
  assert.equal(printer?.urgent, false);
  assert.equal(printer?.file, "routine.txt");
  assert.ok((printer?.agentTurns ?? 0) > 0, "the low-confidence ticket was handed to the agent");
});

test("learning: run 2 is given run 1's note and is cheaper", { timeout: 60_000 }, async () => {
  const result = await runExample("learning");
  assert.equal(result.code, 0, result.stderr);
  const [first, second] = result.summary["runs"] as { status: string; jobCostMicros: number; turns: number; given: string[] }[];
  assert.equal(first?.status, "completed");
  assert.equal(second?.status, "completed");
  assert.deepEqual(first?.given, []);
  assert.ok(second?.given.includes("note:release-notes-format"));
  assert.ok((second?.jobCostMicros ?? Infinity) < (first?.jobCostMicros ?? 0), "run 2 cost less than run 1");
  assert.ok((second?.turns ?? Infinity) < (first?.turns ?? 0));
  const items = result.summary["items"] as { kind: string; name: string; status: string }[];
  assert.deepEqual(items.map((item) => `${item.kind}:${item.name}:${item.status}`).sort(),
    ["note:release-notes-format:active", "skill:write-release-notes:active"]);
  const metrics = result.summary["metrics"] as { before: { runs: number }; after: { runs: number } };
  assert.equal(metrics.before.runs, 1);
  assert.equal(metrics.after.runs, 1);
});
