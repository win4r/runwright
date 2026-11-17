import { createServer as createHttpServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RunwrightError } from "../core/errors.ts";
import type { ServerContext, ServerDeps } from "./context.ts";
import { describeApi, type ApiDescription, type ApiOperation } from "./describe.ts";
import { createRequestHandler } from "./http.ts";
import { createRouter, type Route } from "./router.ts";
import { createSseHub } from "./sse.ts";
import { agentRoutes } from "./routes/agents.ts";
import { learningRoutes } from "./routes/learning.ts";
import { pendingRoutes } from "./routes/pendings.ts";
import { runRoutes } from "./routes/runs.ts";
import { secretRoutes } from "./routes/secrets.ts";
import { systemRoutes } from "./routes/system.ts";
import { triggerRoutes } from "./routes/triggers.ts";
import { usageRoutes } from "./routes/usage.ts";
import { workflowRoutes } from "./routes/workflows.ts";

export type { ServerDeps, ApiDescription, ApiOperation };

export interface RunwrightServer { listen(): Promise<{ url: string; port: number }>; close(): Promise<void> }

/**
 * What `listen()` does to the outside world, replaceable so tests can hold it at any step: one bind attempt, and
 * the three file operations that publish `server.json`. The defaults are `listenOn` and `node:fs/promises`.
 */
export interface ServerSeams {
  listenOn(server: Server, host: string, port: number): Promise<number>;
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
  writeFile(path: string, data: string, options: { mode: number }): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
}

const CLOSE_WAIT_MS = 2000;

function urlHost(host: string): string {
  if (host === "0.0.0.0" || host === "") return "127.0.0.1";
  if (host === "::") return "[::1]";
  return host.includes(":") ? `[${host}]` : host;
}

/** One bind attempt: resolves with the bound port, rejects with the bind error (e.g. EADDRINUSE). */
export function listenOn(server: Server, host: string, port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

/** Every route of the API, in description order. */
function allRoutes(context: ServerContext, description: () => ApiDescription): Route[] {
  return [
    ...systemRoutes(context, description),
    ...agentRoutes(context),
    ...runRoutes(context),
    ...pendingRoutes(context),
    ...workflowRoutes(context),
    ...learningRoutes(context),
    ...triggerRoutes(context),
    ...secretRoutes(context),
    ...usageRoutes(context),
  ];
}

/**
 * The HTTP API server. `listen()` binds `config.server.host` (port 0 → any free port; otherwise the first free
 * port of port … port + portSearch) and writes `<dataDir>/server.json` (mode 0600); when anything after the bind
 * fails it closes the socket and the SSE hub before it rejects with that error, so a rejected `listen()` leaves
 * nothing listening. `close()` ends open SSE streams, stops accepting, waits up to 2 s for in-flight requests,
 * destroys what remains and removes `server.json` if it is still this server's. It resolves in every state
 * (never listened, failed listen, already closed) and is idempotent; a closed server does not listen again.
 *
 * `close()` called while `listen()` is pending waits for that `listen()` to settle and then shuts down, so when
 * it resolves nothing is listening and no `server.json` of this server is left. The pending `listen()` checks
 * after every step (each bind attempt, `mkdir`, `writeFile`, `chmod`) whether `close()` was called, and if so
 * stops there and rejects with `conflict` ("the server was closed"); it never ends in a published, listening
 * server once `close()` was called.
 */
export function createServer(deps: ServerDeps, seams?: Partial<ServerSeams>): RunwrightServer {
  const io: ServerSeams = { listenOn, mkdir, writeFile, chmod, ...seams };
  const redact = (text: string): string => deps.secrets.redactText(text);
  const sse = createSseHub({
    store: deps.store, events: deps.events, logger: deps.logger, redact,
    pollMs: deps.config.runner.pollMs, pingMs: deps.config.server.ssePingMs,
  });
  const context: ServerContext = { deps, sse };
  let description: ApiDescription | null = null;
  const routes = allRoutes(context, () => {
    description ??= describeApi(routes);
    return description;
  });
  const handle = createRequestHandler({
    router: createRouter(routes), token: deps.token, bodyBytes: deps.config.server.bodyBytes, ids: deps.ids,
    logger: deps.logger, redact,
  });

  let inFlight = 0;
  let idle: (() => void) | null = null;
  const sockets = new Set<Socket>();
  const server = createHttpServer((req, res) => {
    inFlight += 1;
    res.once("close", () => {
      inFlight -= 1;
      if (inFlight === 0) idle?.();
    });
    void handle(req, res);
  });
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  const serverJson = join(deps.config.dataDir, "server.json");
  let info: { url: string; pid: number; startedAt: number } | null = null;
  let listening = false;
  /** The pending or settled `listen()`, which a `close()` waits for before it shuts down. */
  let starting: Promise<unknown> | null = null;
  let closing: Promise<void> | null = null;
  const closedError = (cause?: unknown): RunwrightError =>
    new RunwrightError("conflict", "the server was closed", cause === undefined ? undefined : { cause });

  /**
   * Ends the SSE streams, stops accepting, waits up to CLOSE_WAIT_MS for in-flight requests, destroys what remains
   * and removes `server.json` if it is still this server's. Safe in every state: a server that never listened (or
   * whose socket is already closed) is not closed again, so ERR_SERVER_NOT_RUNNING never comes out of it.
   */
  const shutDown = async (): Promise<void> => {
    sse.close();
    const stopped = server.listening ? new Promise<void>((resolve) => server.close(() => resolve())) : Promise.resolve();
    server.closeIdleConnections();
    if (inFlight > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CLOSE_WAIT_MS);
        idle = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
    for (const socket of sockets) socket.destroy();
    await stopped;
    const published = info;
    info = null;
    if (published !== null) {
      try {
        const current = JSON.parse(await readFile(serverJson, "utf8")) as { pid?: unknown; url?: unknown };
        if (current.pid === published.pid && current.url === published.url) await unlink(serverJson);
      } catch {
        // Already gone or replaced by another server: nothing of ours to remove.
      }
    }
  };

  /** Binds the first free candidate port; a `close()` during the search stops it with `conflict`. */
  const bind = async (host: string, port: number, portSearch: number): Promise<number> => {
    const last = port === 0 ? 0 : port + Math.max(0, portSearch);
    for (let candidate = port; ; candidate++) {
      let bound: number;
      try {
        bound = await io.listenOn(server, host, candidate);
      } catch (error) {
        if (closing !== null) throw closedError();
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || candidate >= last) {
          throw new RunwrightError("unavailable", `cannot listen on ${host}:${candidate}: ${(error as Error).message}`, { cause: error });
        }
        continue;
      }
      // Bound, but close() was called meanwhile: the pending close() closes the socket once this listen() settled.
      if (closing !== null) throw closedError();
      return bound;
    }
  };

  /** Writes `server.json` (mode 0600); `info` is set before the write, so a shutdown removes whatever was written. */
  const publish = async (published: { url: string; pid: number; startedAt: number }): Promise<void> => {
    await io.mkdir(deps.config.dataDir, { recursive: true, mode: 0o700 });
    if (closing !== null) throw closedError();
    info = published;
    await io.writeFile(serverJson, `${JSON.stringify(published)}\n`, { mode: 0o600 });
    if (closing !== null) throw closedError();
    await io.chmod(serverJson, 0o600);
    if (closing !== null) throw closedError();
  };

  const start = async (): Promise<{ url: string; port: number }> => {
    const { host, port, portSearch } = deps.config.server;
    let actual: number;
    try {
      actual = await bind(host, port, portSearch);
    } catch (error) {
      // Nothing of a failed bind is listening; a bind that succeeded after close() is closed by that close().
      listening = false;
      throw error;
    }
    const published = { url: `http://${urlHost(host)}:${actual}`, pid: process.pid, startedAt: deps.clock.now() };
    try {
      await publish(published);
    } catch (error) {
      // Nothing may stay listening after a failed start. When close() is already pending it shuts down as soon as
      // this listen() has settled (waiting for it here would wait for itself), and listen() rejects with conflict.
      if (closing !== null) throw error instanceof RunwrightError && error.code === "conflict" ? error : closedError(error);
      closing = shutDown();
      await closing;
      throw error;
    }
    deps.logger.info("server listening", { url: published.url });
    return { url: published.url, port: actual };
  };

  return {
    async listen() {
      if (closing !== null) throw closedError();
      if (listening) throw new RunwrightError("conflict", "the server is already listening");
      listening = true;
      const pending = start();
      starting = pending;
      return pending;
    },

    close() {
      closing ??= (async () => {
        await starting?.catch(() => undefined);
        await shutDown();
      })();
      return closing;
    },
  };
}
