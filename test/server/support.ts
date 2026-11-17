/**
 * Shared setup for the server and client tests (not a test file): a real server on port 0 over a real SQLite
 * store in a temp directory, the built-in tools, a real secrets service and a temp console page. The server gets
 * the store wrapped with `redactingStore`, as `createApp` wires it. Logs are captured as lines (through the
 * secrets redactor, as the app wires it).
 */
import { writeFile } from "node:fs/promises";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { systemClock } from "../../src/core/clock.ts";
import { createEphemeralEvents, type EphemeralEvents } from "../../src/core/events.ts";
import { createIdSource } from "../../src/core/ids.ts";
import type { JsonObject } from "../../src/core/json.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import type { Config } from "../../src/config/types.ts";
import { createLogger } from "../../src/log/logger.ts";
import { generateSealKey } from "../../src/security/seal.ts";
import { createSecretsService } from "../../src/security/secrets.ts";
import { generateToken } from "../../src/security/token.ts";
import type { SecretsService } from "../../src/security/types.ts";
import { createWriteRedaction, redactingStore } from "../../src/security/write-redaction.ts";
import { openSqliteStore } from "../../src/store/sqlite.ts";
import type {
  ClaimedRun, CommitBatch, NewPending, PendingKind, PendingRecord, RunRecord, Store,
} from "../../src/store/types.ts";
import { createBuiltinTools } from "../../src/tools/builtin.ts";
import { createToolRegistry, type ToolRegistry } from "../../src/tools/registry.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import { createClient, type RunwrightClient } from "../../src/client/index.ts";
import { createServer, type RunwrightServer, type ServerDeps } from "../../src/server/index.ts";
import { createRequestHandler, type HttpCoreDeps } from "../../src/server/http.ts";
import { createRouter, type Route } from "../../src/server/router.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { testAgentDefinition } from "../helpers/store.ts";

export { testAgentDefinition };

export interface TestServer {
  dir: string; config: Config; store: Store; tools: ToolRegistry; secrets: SecretsService; events: EphemeralEvents;
  logLines: string[]; url: string; token: string; client: RunwrightClient; server: RunwrightServer; deps: ServerDeps;
  consolePath: string;
}

export interface TestServerOptions {
  /** Use this store and directory instead of fresh ones (the caller closes the store). */
  store?: Store; dir?: string;
  configure?: (config: Config) => void;
  tools?: readonly ToolDefinition[];
  events?: EphemeralEvents;
  writeConsole?: boolean;
}

export async function startTestServer(t: TestContext, options?: TestServerOptions): Promise<TestServer> {
  const dir = options?.dir ?? (await makeTempDir(t, "runwright-server-"));
  const config = defaultConfig(dir);
  config.server.port = 0;
  config.runner.pollMs = 20;
  config.server.ssePingMs = 60_000;
  options?.configure?.(config);
  const raw = options?.store ?? (await openSqliteStore({ path: join(dir, "runwright.db") }));
  const tools = createToolRegistry([
    ...createBuiltinTools({
      files: config.tools.files,
      shell: config.tools.shell,
      webFetch: { timeoutMs: config.tools.webFetch.timeoutMs, maxBytes: config.tools.webFetch.maxBytes, maxRedirects: config.tools.webFetch.maxRedirects },
    }),
    ...(options?.tools ?? []),
  ]);
  const secrets = await createSecretsService({ store: raw, sealKey: generateSealKey() });
  const store = redactingStore(raw, createWriteRedaction(secrets));
  const logLines: string[] = [];
  const logger = createLogger({ level: "debug", write: (line) => logLines.push(line), redact: (text) => secrets.redactText(text) });
  const consolePath = join(dir, "console.html");
  if (options?.writeConsole ?? true) await writeFile(consolePath, "<!doctype html><title>Runwright</title><p>console</p>\n");
  const token = generateToken();
  const events = options?.events ?? createEphemeralEvents();
  const deps: ServerDeps = {
    config, store, clock: systemClock, ids: createIdSource(), logger, token, tools, secrets, events, consolePath,
    version: "0.1.0-test", runnerInfo: () => null,
  };
  const server = createServer(deps);
  const { url } = await server.listen();
  t.after(async () => {
    await server.close();
    if (options?.store === undefined) await store.close();
  });
  return { dir, config, store, tools, secrets, events, logLines, url, token, client: createClient({ baseUrl: url, token }), server, deps, consolePath };
}

/** fetch with the bearer token. */
export function authed(server: TestServer, path: string, init?: RequestInit & { json?: unknown }): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${server.token}`);
  const { json, ...rest } = init ?? {};
  if (json !== undefined) {
    headers.set("Content-Type", "application/json");
    rest.body = JSON.stringify(json);
  }
  return fetch(`${server.url}${path}`, { ...rest, headers });
}

export interface RawResponse { status: number; headers: Record<string, string | string[] | undefined>; body: string }

/** A request with node:http, so the path is sent exactly as written (fetch would normalise `..`). */
export function rawRequest(
  url: string,
  options: { method?: string; path: string; headers?: Record<string, string>; body?: string | Buffer; chunks?: Buffer[] },
): Promise<RawResponse> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: target.hostname, port: target.port, method: options.method ?? "GET", path: options.path, headers: options.headers,
    }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (chunk: Buffer) => parts.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("error", reject);
    if (options.chunks !== undefined) {
      const chunks = [...options.chunks];
      const next = (): void => {
        const chunk = chunks.shift();
        if (chunk === undefined) {
          req.end();
          return;
        }
        if (req.destroyed) return;
        req.write(chunk, () => setImmediate(next));
      };
      next();
    } else {
      req.end(options.body);
    }
  });
}

export async function errorOf(response: Response): Promise<{ status: number; code: string; message: string; details: JsonObject | undefined }> {
  const body = (await response.json()) as { error: { code: string; message: string; details?: JsonObject } };
  return { status: response.status, code: body.error.code, message: body.error.message, details: body.error.details };
}

/** Claims the queued run as a pretend runner. */
export async function claim(store: Store, runId: string): Promise<ClaimedRun> {
  const claimed = await store.claimRuns({ runnerId: "test-runner", limit: 50, leaseMs: 60_000 });
  const found = claimed.find((c) => c.run.id === runId);
  for (const other of claimed) {
    if (other !== found) await store.commit(other.lease, { records: [{ type: "run.released", data: {} }], transition: { to: "queued" } });
  }
  if (found === undefined) throw new Error(`run ${runId} was not claimable`);
  return found;
}

/** Plays the runner: claims the run and commits one batch. */
export async function commitAs(store: Store, runId: string, batch: CommitBatch): Promise<RunRecord> {
  const { lease } = await claim(store, runId);
  return (await store.commit(lease, batch)).run;
}

let pendingCounter = 0;

/** Claims the run and opens one pending on it (the run goes to waiting). */
export async function openPending(store: Store, runId: string, kind: PendingKind, detail: JsonObject = {}): Promise<PendingRecord> {
  pendingCounter += 1;
  const pending: NewPending = { id: `pnd_test${pendingCounter}_${runId}`, kind, stepKey: `t1.c${pendingCounter}`, title: `A ${kind}`, detail };
  await commitAs(store, runId, {
    records: [{ type: "pending.opened", key: pending.stepKey, data: { pending: pending as unknown as JsonObject } }],
    openPendings: [pending],
    transition: { to: "waiting" },
  });
  const stored = await store.getPending(pending.id);
  if (stored === null) throw new Error("pending was not stored");
  return stored;
}

/** Saves an agent and starts a run on it, through the store. */
export async function seedRun(store: Store, agentId = "seed-agent"): Promise<RunRecord> {
  await store.saveAgent({ id: agentId, definition: testAgentDefinition() });
  return (await store.createRun({ agentId, input: { message: "go", data: null } })).run;
}

/** A bearer route answering `reply()` (a JSON body), or throwing what `reply` throws. */
export function testRoute(path: string, reply: () => unknown): Route {
  return {
    id: `test${path.replaceAll("/", ".")}`, method: "GET", path, auth: "bearer", summary: "test route", query: {}, body: null,
    bodyMode: "none", response: "test", handler: async () => ({ kind: "json", status: 200, body: reply() }),
  };
}

/**
 * The real request handler (`createRequestHandler`) on a bare node:http server on port 0, over the given routes,
 * with a fresh token and a captured logger; `deps` overrides any part of HttpCoreDeps.
 */
export async function startHandlerServer(
  t: TestContext, routes: readonly Route[], deps?: Partial<HttpCoreDeps>,
): Promise<{ url: string; token: string; logLines: string[] }> {
  const logLines: string[] = [];
  const token = generateToken();
  const handle = createRequestHandler({
    router: createRouter([...routes]), token, bodyBytes: 1024 * 1024, ids: createIdSource(),
    logger: createLogger({ level: "debug", write: (line) => logLines.push(line) }), redact: (text) => text, ...deps,
  });
  const server = createHttpServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token, logLines };
}
