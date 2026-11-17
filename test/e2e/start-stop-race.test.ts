/**
 * R14D-engine-01 and R14D-server-02 together, on the real app with the real HTTP server (plan 2.8): `start()` and
 * `stop()` without awaiting the first, 50 times, in a child process. After each pair nothing listens on the port
 * and `server.json` is gone; afterwards the child exits by itself, so no socket, timer or scheduler tick is left
 * holding it open.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../helpers/tmp.ts";

const SCRIPT = fileURLToPath(new URL("../fixtures/start-stop.ts", import.meta.url));
const ITERATIONS = 50;
const EXIT_TIMEOUT_MS = 45_000;

test("start() and stop() without awaiting the start, 50 times: nothing listens, server.json is gone, the process exits by itself", { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t, "runwright-e2e-start-stop-");
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("RUNWRIGHT_")) env[key] = value;
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", SCRIPT, join(dir, "data"), String(ITERATIONS)], {
    env, stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const exited = await new Promise<{ code: number | null; signal: NodeJS.Signals | null } | "timeout">((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), EXIT_TIMEOUT_MS);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  assert.notEqual(exited, "timeout", `the child did not exit by itself within ${EXIT_TIMEOUT_MS} ms; stdout:\n${stdout}\nstderr:\n${stderr}`);
  assert.deepEqual(exited, { code: 0, signal: null }, stderr);
  const report = JSON.parse(stdout.trim()) as { iterations: number; started: number; refused: number; failures: string[] };
  assert.deepEqual(report.failures, []);
  assert.equal(report.iterations, ITERATIONS);
  assert.equal(report.started + report.refused, ITERATIONS);
  assert.ok(report.refused > 0, "some stops landed while the start was pending");
});
