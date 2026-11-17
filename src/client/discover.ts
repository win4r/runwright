import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { delay } from "../core/clock.ts";
import { RunwrightError } from "../core/errors.ts";
import { defaultDataDir } from "../config/defaults.ts";

const POLL_MS = 100;
const DEFAULT_TIMEOUT_MS = 5000;
const PROBE_TIMEOUT_MS = 1000;

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The URL recorded in `<dataDir>/server.json`, or null when there is none or its process is gone. */
async function recordedUrl(dataDir: string): Promise<string | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(dataDir, "server.json"), "utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const { url, pid } = parsed as { url?: unknown; pid?: unknown };
  if (typeof url !== "string" || url === "") return null;
  if (typeof pid === "number" && Number.isInteger(pid) && pid > 0 && !processAlive(pid)) return null;
  return url;
}

/** Whether GET /v1/health answers {status: "ok"} within `limitMs` (the request and its body). */
async function healthy(url: string, limitMs: number): Promise<boolean> {
  try {
    const signal = AbortSignal.timeout(Math.max(1, Math.ceil(limitMs)));
    const response = await fetch(`${url.replace(/\/+$/, "")}/v1/health`, { signal });
    if (!response.ok) return false;
    const body = (await response.json()) as { status?: unknown };
    return body.status === "ok";
  } catch {
    return false;
  }
}

/**
 * Finds a running local server and its token. url: option > RUNWRIGHT_URL > <dataDir>/server.json (ignored when
 * the process that wrote it is gone). token: option > RUNWRIGHT_TOKEN > <dataDir>/token. Polls every 100 ms
 * until GET /v1/health answers, or rejects with RunwrightError("unavailable") after timeoutMs (default 5000; a
 * finite number >= 0, otherwise bad_request). Each health probe has a time limit of 1 s or the time left, whichever
 * is shorter.
 */
export async function discoverServer(options?: {
  env?: NodeJS.ProcessEnv; dataDir?: string; url?: string; token?: string; timeoutMs?: number;
}): Promise<{ baseUrl: string; token: string }> {
  const env = options?.env ?? process.env;
  const dataDir = options?.dataDir ?? defaultDataDir(env);
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RunwrightError("bad_request", `timeoutMs must be a finite number >= 0, got ${String(timeoutMs)}`, { details: { option: "timeoutMs" } });
  }
  const fixedUrl = options?.url ?? envValue(env, "RUNWRIGHT_URL");
  let token = options?.token ?? envValue(env, "RUNWRIGHT_TOKEN");
  const deadline = Date.now() + timeoutMs;
  let lastUrl: string | null = null;
  for (;;) {
    const url = fixedUrl ?? (await recordedUrl(dataDir));
    if (url !== null) {
      lastUrl = url;
      if (await healthy(url, Math.min(PROBE_TIMEOUT_MS, Math.max(1, deadline - Date.now())))) {
        if (token === undefined) {
          try {
            token = (await readFile(join(dataDir, "token"), "utf8")).trim();
          } catch {
            token = "";
          }
          if (token === "") {
            throw new RunwrightError("unavailable", `found a server at ${url} but no token: set RUNWRIGHT_TOKEN or pass --token (looked in ${join(dataDir, "token")})`);
          }
        }
        return { baseUrl: url.replace(/\/+$/, ""), token };
      }
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      const where = lastUrl !== null ? `at ${lastUrl}` : `(no server.json in ${dataDir}; is \`runwright serve\` running?)`;
      throw new RunwrightError("unavailable", `no Runwright server answered ${where} within ${timeoutMs} ms`, {
        details: { dataDir, url: lastUrl },
      });
    }
    await delay(Math.min(POLL_MS, left));
  }
}
