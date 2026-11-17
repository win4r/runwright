import { readFile, stat } from "node:fs/promises";
import { RunwrightError } from "../../core/errors.ts";
import type { ServerContext } from "../context.ts";
import type { ApiDescription } from "../describe.ts";
import { json } from "../http.ts";
import type { Route } from "../router.ts";

const CONSOLE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; " +
  "img-src 'self' data: blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Reads the console page, re-reading it only when its modification time or size changes. */
function consoleLoader(path: string): () => Promise<Buffer | null> {
  let cached: { mtimeMs: number; size: number; content: Buffer } | null = null;
  return async () => {
    try {
      const info = await stat(path);
      if (!info.isFile()) return null;
      if (cached !== null && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.content;
      const content = await readFile(path);
      cached = { mtimeMs: info.mtimeMs, size: info.size, content };
      return content;
    } catch {
      cached = null;
      return null;
    }
  };
}

export function systemRoutes(context: ServerContext, description: () => ApiDescription): Route[] {
  const { deps } = context;
  const loadConsole = consoleLoader(deps.consolePath);
  return [
    {
      id: "console", method: "GET", path: "/", auth: "none", summary: "The web console (one static HTML page)",
      query: {}, body: null, bodyMode: "none", response: "text/html",
      async handler({ res }) {
        const content = await loadConsole();
        if (content === null) throw new RunwrightError("unavailable", "the console page is not available");
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Content-Length", content.length);
        res.setHeader("Content-Security-Policy", CONSOLE_CSP);
        res.setHeader("X-Frame-Options", "DENY");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.writeHead(200);
        res.end(content);
        return { kind: "handled" };
      },
    },
    {
      id: "health", method: "GET", path: "/v1/health", auth: "none", summary: "Liveness: the server answers",
      query: {}, body: null, bodyMode: "none", response: "{status: \"ok\", version}",
      async handler() {
        return json(200, { status: "ok", version: deps.version });
      },
    },
    {
      id: "ready", method: "GET", path: "/v1/ready", auth: "none", summary: "Readiness: the store answers a read",
      query: {}, body: null, bodyMode: "none", response: "{status: \"ready\", schemaVersion, runner: {id, active} | null} or 503",
      async handler() {
        try {
          await deps.store.getAgent("readiness-probe");
        } catch {
          throw new RunwrightError("unavailable", "the store is not available");
        }
        return json(200, { status: "ready", schemaVersion: deps.store.schemaVersion, runner: deps.runnerInfo() });
      },
    },
    {
      id: "api.describe", method: "GET", path: "/v1/api", auth: "bearer", summary: "This machine-readable API description",
      query: {}, body: null, bodyMode: "none", response: "ApiDescription",
      async handler() {
        return json(200, description());
      },
    },
  ];
}
