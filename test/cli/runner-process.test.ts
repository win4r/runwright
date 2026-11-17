/**
 * `runwright serve --no-runner` next to a separate `runwright runner` process on the same data directory, both
 * real child processes of `bin/runwright.ts`: the runner stays up while idle, claims and finishes the run the
 * server queued, and both stop cleanly (exit 0) on SIGTERM. Neither prints the node:sqlite warning.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createClient } from "../../src/client/index.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { waitFor } from "../helpers/wait.ts";
import { scriptedAgent, waitForStatus } from "../fixtures/runs.ts";
import { BIN, ROOT } from "./support.ts";

interface Child { process: ChildProcess; stdout: () => string; stderr: () => string; exit: Promise<number | null> }

function start(t: TestContext, argv: string[], dataDir: string): Child {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("RUNWRIGHT_")) env[key] = value;
  env.RUNWRIGHT_DATA_DIR = dataDir;
  const child = spawn(process.execPath, [BIN, ...argv], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const exit = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  return { process: child, stdout: () => stdout, stderr: () => stderr, exit };
}

test("a separate runner process works next to serve --no-runner and both stop on SIGTERM", { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t, "runwright-cli-runner-");
  const dataDir = join(dir, "data");
  const server = start(t, ["serve", "--no-runner", "--port", "0"], dataDir);
  const url = await waitFor(async () => {
    const parsed = JSON.parse(await readFile(join(dataDir, "server.json"), "utf8")) as { url?: string };
    return parsed.url;
  }, { timeoutMs: 20_000, message: `serve did not write server.json; stderr:\n${server.stderr()}` });
  const runner = start(t, ["runner", "--lease-ms", "500"], dataDir);
  const runnerId = await waitFor(() => {
    const line = runner.stdout().trim();
    if (line === "" || !line.endsWith("}")) return null;
    return (JSON.parse(line) as { runnerId?: string }).runnerId ?? null;
  }, { timeoutMs: 20_000, message: `the runner printed nothing; stderr:\n${runner.stderr()}` });

  // Idle for longer than the server's poll interval: the runner process must still be there.
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(runner.process.exitCode, null, `the runner exited while idle; stderr:\n${runner.stderr()}`);

  const token = (await readFile(join(dataDir, "token"), "utf8")).trim();
  const client = createClient({ baseUrl: url, token });
  const ready = await client.ready();
  assert.equal(ready.runner, null, "the server hosts no runner");
  const { agent } = await client.saveAgent(scriptedAgent({ name: "Remote runner", script: { turns: [{ text: "done remotely" }] } }), "remote-runner");
  const { run } = await client.startRun({ agentId: agent.id, message: "go" });
  const { run: done } = await waitForStatus(client, run.id, ["completed", "failed"], 20_000);
  assert.equal(done.status, "completed");
  assert.deepEqual(done.output, { text: "done remotely" });
  const claimed = (await client.timeline(run.id)).records.find((record) => record.type === "run.claimed");
  assert.equal((claimed?.data as { runnerId?: string } | undefined)?.runnerId, runnerId, "the separate runner claimed the run");

  runner.process.kill("SIGTERM");
  server.process.kill("SIGTERM");
  assert.equal(await runner.exit, 0, runner.stderr());
  assert.equal(await server.exit, 0, server.stderr());
  for (const child of [server, runner]) {
    assert.doesNotMatch(child.stderr(), /ExperimentalWarning|SQLite is an experimental feature/);
  }
});
