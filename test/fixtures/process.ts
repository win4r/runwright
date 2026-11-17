/**
 * Spawning and controlling `test/fixtures/host.ts` child processes for the crash tests (not a test file).
 *
 *   const host = await startHost(t, { RUNWRIGHT_DATA_DIR: dir, HOST_EFFECTS_FILE: effects, HOST_LEASE_MS: "400" });
 *   host.kill("SIGKILL"); await host.stopped;
 *
 * The child gets the parent's environment minus every RUNWRIGHT_* and HOST_* variable, plus `env`, so a
 * developer's own settings never leak into a test. Every child is killed (SIGKILL, which also ends a stopped
 * process) when the test ends.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { createClient, type RunwrightClient } from "../../src/client/index.ts";

export const HOST_PATH: string = fileURLToPath(new URL("./host.ts", import.meta.url));
const READY_TIMEOUT_MS = 20_000;

export interface HostProcess {
  readonly pid: number;
  /** "" for a runner-only host. */
  readonly url: string;
  readonly token: string;
  /** Null for a runner-only host. */
  readonly client: RunwrightClient | null;
  readonly runnerId: string | null;
  /** Resolves when the process has exited. */
  readonly stopped: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  exited(): boolean;
  kill(signal: NodeJS.Signals): void;
  /** Everything the process wrote to stderr so far (its JSON log lines). */
  stderr(): string;
}

function childEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("RUNWRIGHT_") || key.startsWith("HOST_")) continue;
    out[key] = value;
  }
  return { ...out, ...env };
}

function waitReady(child: ChildProcess, errText: () => string): Promise<{ url: string; pid: number; runnerId: string | null }> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`host did not become ready within ${READY_TIMEOUT_MS} ms; stderr:\n${errText()}`));
    }, READY_TIMEOUT_MS);
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      cleanup();
      try {
        const parsed = JSON.parse(line) as { ready?: unknown; url?: unknown; pid?: unknown; runnerId?: unknown };
        if (parsed.ready !== true) throw new Error("not a ready line");
        resolve({
          url: typeof parsed.url === "string" ? parsed.url : "",
          pid: Number(parsed.pid),
          runnerId: typeof parsed.runnerId === "string" ? parsed.runnerId : null,
        });
      } catch {
        reject(new Error(`unexpected host output: ${line}`));
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(`host exited before it was ready (code ${code}, signal ${signal}); stderr:\n${errText()}`));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onData);
    child.once("exit", onExit);
  });
}

/** Starts a host process and waits for its ready line. `env` must contain RUNWRIGHT_DATA_DIR. */
export async function startHost(t: TestContext, env: Record<string, string>): Promise<HostProcess> {
  const dataDir = env["RUNWRIGHT_DATA_DIR"];
  if (dataDir === undefined) throw new Error("startHost needs RUNWRIGHT_DATA_DIR");
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", HOST_PATH], {
    env: childEnv({ RUNWRIGHT_LOG_LEVEL: "info", ...env }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errText = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    errText += chunk.toString("utf8");
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
  const ready = await waitReady(child, () => errText);
  const token = (await readFile(join(dataDir, "token"), "utf8")).trim();
  return {
    pid: ready.pid,
    url: ready.url,
    token,
    client: ready.url === "" ? null : createClient({ baseUrl: ready.url, token }),
    runnerId: ready.runnerId,
    stopped,
    exited: () => exited,
    kill(signal: NodeJS.Signals): void {
      if (!exited) child.kill(signal);
    },
    stderr: () => errText,
  };
}

/** The client of a server host (throws for a runner-only one). */
export function clientOf(host: HostProcess): RunwrightClient {
  if (host.client === null) throw new Error("this host has no server");
  return host.client;
}
