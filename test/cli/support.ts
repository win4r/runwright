/**
 * Shared setup for the CLI tests (not a test file): a real API server on port 0 over a temp data directory with
 * its token file written, the CLI run in-process with captured output or as a real child process, and helpers
 * that move runs through states the way a runner would.
 */
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import type { JsonObject } from "../../src/core/json.ts";
import { main } from "../../src/cli/main.ts";
import type { NewPending, PendingKind, PendingRecord, RunRecord, Store } from "../../src/store/types.ts";
import { claim, startTestServer, type TestServer } from "../server/support.ts";

export const BIN = fileURLToPath(new URL("../../bin/runwright.ts", import.meta.url));
export const ROOT = fileURLToPath(new URL("../../", import.meta.url));

export interface CliResult { code: number; stdout: string; stderr: string }

export async function cliServer(t: TestContext): Promise<TestServer> {
  const s = await startTestServer(t);
  await writeFile(join(s.dir, "token"), `${s.token}\n`, { mode: 0o600 });
  return s;
}

/** Runs `main` in-process. The environment points at `dataDir` only (nothing from the real home directory). */
export async function cli(
  argv: readonly string[],
  options: { dataDir: string; isTTY?: boolean; stdin?: string; env?: NodeJS.ProcessEnv },
): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    stdin: async () => options.stdin ?? "",
    env: { HOME: options.dataDir, RUNWRIGHT_DATA_DIR: options.dataDir, ...options.env },
    isTTY: options.isTTY ?? false,
  });
  return { code, stdout, stderr };
}

/** Parses the single JSON document a command printed. */
export function parsed<T = JsonObject>(result: CliResult): T {
  return JSON.parse(result.stdout) as T;
}

/** Runs `node bin/runwright.ts …` as a child process (asynchronously, so a server in this process keeps serving). */
export function bin(argv: readonly string[], options: { dataDir: string; env?: NodeJS.ProcessEnv }): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("RUNWRIGHT_") && !key.startsWith("NODE_TEST")) env[key] = value;
  Object.assign(env, { HOME: options.dataDir, RUNWRIGHT_DATA_DIR: options.dataDir }, options.env);
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [BIN, ...argv], { cwd: ROOT, env, timeout: 30_000 }, (error, stdout, stderr) => {
      if (error !== null && typeof error.code !== "number") {
        reject(error);
        return;
      }
      resolve({ code: error === null ? 0 : (error.code as number), stdout, stderr });
    });
  });
}

/** Saves an agent through the store and creates one queued run. */
export async function seed(store: Store, agentId = "cli-agent", message = "go"): Promise<RunRecord> {
  if ((await store.getAgent(agentId)) === null) {
    await store.saveAgent({
      id: agentId,
      definition: {
        name: "CLI agent", instructions: "Do the job.", model: { provider: "scripted", name: "scripted-1" }, tools: [], limits: {}, learning: false,
      },
    });
  }
  return (await store.createRun({ agentId, input: { message, data: null } })).run;
}

/** Plays a runner that ends the run in a terminal or paused state. */
export async function finish(store: Store, runId: string, to: "completed" | "failed" | "cancelled" | "paused", costMicros: number | null = 1500): Promise<RunRecord> {
  const { lease } = await claim(store, runId);
  const type = to === "paused" ? "run.paused" : `run.${to}`;
  const transition = to === "completed" ? { to, output: "all done" } : to === "failed" ? { to, error: { code: "model_failed", message: "the model broke" } } : { to };
  const { run } = await store.commit(lease, {
    records: [{ type, data: {} }],
    transition,
    usage: [{ model: costMicros === null ? "scripted/unpriced-1" : "scripted/scripted-1", purpose: "run", inputTokens: 100, outputTokens: 20,
      cacheReadTokens: 0, cacheWriteTokens: 0, costMicros, assumed: false }],
  });
  return run;
}

let counter = 0;

/** Opens pendings of the given kinds on the run in one commit; the run becomes waiting. */
export async function openPendings(store: Store, runId: string, kinds: readonly PendingKind[]): Promise<PendingRecord[]> {
  const { lease } = await claim(store, runId);
  const pendings: NewPending[] = kinds.map((kind) => {
    counter += 1;
    return { id: `pnd_cli${counter}_${runId}`, kind, stepKey: `t1.c${counter}`, title: `Please handle ${kind} ${counter}`, detail: {} };
  });
  await store.commit(lease, {
    records: pendings.map((p) => ({ type: "pending.opened", key: p.stepKey, data: { pending: p as unknown as JsonObject } })),
    openPendings: pendings,
    transition: { to: "waiting" },
  });
  return Promise.all(pendings.map(async (p) => (await store.getPending(p.id)) as PendingRecord));
}
