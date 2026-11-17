/**
 * R13D-cli-01 on a real process: a second SIGTERM while a graceful stop waits on a tool call that ignores its
 * abort signal ends the process at once with exit code 1. The run was fenced first, so the next process on the
 * same data directory claims it with a higher epoch and leaves the unfinished write call to a person.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { createClient, type RunwrightClient } from "../../src/client/index.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { waitFor } from "../helpers/wait.ts";
import { callTurn, fullTimeline, scriptedAgent, waitForStatus } from "../fixtures/runs.ts";

const CHILD = fileURLToPath(new URL("../cli/stubborn-host.ts", import.meta.url));

interface Child {
  readonly process: ChildProcess;
  readonly client: RunwrightClient;
  readonly stopped: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  exited(): boolean;
  stderr(): string;
}

function childEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("RUNWRIGHT_") && !key.startsWith("STUBBORN_")) out[key] = value;
  return { ...out, RUNWRIGHT_LOG_LEVEL: "warn", ...env };
}

/** Starts the child and waits for the JSON document `serve` prints; the child is SIGKILLed when the test ends. */
async function startChild(t: TestContext, dataDir: string, leaseMs: number): Promise<Child> {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CHILD], {
    env: childEnv({ RUNWRIGHT_DATA_DIR: dataDir, STUBBORN_LEASE_MS: String(leaseMs) }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let exited = false;
  const stopped = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
  });
  t.after(async () => {
    if (!exited) {
      child.kill("SIGKILL");
      await stopped;
    }
  });
  let out = "";
  let err = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    err += chunk.toString("utf8");
  });
  const url = await waitFor(async () => {
    if (exited) throw new Error(`the child exited before it was ready; stderr:\n${err}`);
    try {
      const parsed = JSON.parse(out) as { url?: unknown };
      return typeof parsed.url === "string" ? parsed.url : null;
    } catch {
      return null;
    }
  }, { timeoutMs: 20_000, intervalMs: 10 });
  const token = (await readFile(join(dataDir, "token"), "utf8")).trim();
  return { process: child, client: createClient({ baseUrl: url, token }), stopped, exited: () => exited, stderr: () => err };
}

test("a second SIGTERM ends a process whose graceful stop waits on a call that ignores cancellation", { timeout: 60_000 }, async (t) => {
  const dataDir = join(await makeTempDir(t, "runwright-e2e-forced-exit-"), "data");
  const first = await startChild(t, dataDir, 600);
  const agent = await first.client.saveAgent(scriptedAgent({
    name: "Stubborn", tools: [{ name: "stubborn_write" }],
    script: { turns: [callTurn("stubborn_write", {}), { text: "done" }] },
  }), "stubborn");
  const { run } = await first.client.startRun({ agentId: agent.agent.id, message: "go" });
  await waitFor(async () => (await fullTimeline(first.client, run.id)).some((record) => record.type === "tool.started") || null,
    { timeoutMs: 15_000, intervalMs: 20 });
  const firstEpoch = (await first.client.getRun(run.id)).run.epoch;

  try {
    first.process.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(first.exited(), false, "the graceful stop is still waiting on the stubborn call");
    const forcedAt = Date.now();
    first.process.kill("SIGTERM");
    const outcome = await Promise.race([
      first.stopped,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
    ]);
    assert.notEqual(outcome, null, `the process did not exit within 5 s of the second signal; stderr:\n${first.stderr()}`);
    assert.equal(outcome?.code, 1);
    assert.ok(Date.now() - forcedAt < 5_000);
    assert.match(first.stderr(), /Stopping at once/);
  } finally {
    if (!first.exited()) first.process.kill("SIGKILL");
    await first.stopped;
  }

  const second = await startChild(t, dataDir, 600);
  const { run: waiting, pendings } = await waitForStatus(second.client, run.id, ["waiting", "completed", "failed", "cancelled"], 20_000);
  assert.equal(waiting.status, "waiting");
  assert.ok(waiting.epoch > firstEpoch, `claimed again with a higher epoch (${firstEpoch} → ${waiting.epoch})`);
  assert.deepEqual(pendings.map((pending) => pending.kind), ["interrupted"]);
  const records = await fullTimeline(second.client, run.id);
  assert.equal(records.filter((record) => record.type === "tool.finished").length, 0, "the write call was never finished");
  assert.equal(records.filter((record) => record.type === "tool.started").length, 1, "and never run again");
});
