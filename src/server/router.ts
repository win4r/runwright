import type { IncomingMessage, ServerResponse } from "node:http";
import type { JsonObject } from "../core/json.ts";
import type { JsonSchema } from "../schema/validate.ts";

export type RouteAuth = "bearer" | "none" | "signature";
/** `json`: a strict JSON object body (empty means `{}`); `raw`: the bytes, unparsed; `none`: no body is read. */
export type BodyMode = "none" | "json" | "raw";

export interface RequestContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly requestId: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  /** The parsed body for `json` routes, `{}` otherwise. */
  readonly body: JsonObject;
  /** The raw body for `raw` routes, empty otherwise. */
  readonly rawBody: Buffer;
}

export type Reply =
  | { kind: "json"; status: number; body: unknown; headers?: Record<string, string> }
  | { kind: "empty"; status: number; headers?: Record<string, string> }
  /** The handler wrote the response itself (files, the console, SSE). */
  | { kind: "handled" };

export interface Route {
  id: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Segments: literals, `:param`, and one optional trailing `*rest`. */
  path: string;
  auth: RouteAuth;
  summary: string;
  query: Record<string, string>;
  body: JsonSchema | null;
  bodyMode: BodyMode;
  response: string;
  handler(context: RequestContext): Promise<Reply>;
}

type Segment = { kind: "literal"; value: string } | { kind: "param"; name: string } | { kind: "rest"; name: string };

interface CompiledRoute { route: Route; segments: Segment[]; score: number }

export type RouteMatch =
  | { kind: "found"; route: Route; params: Record<string, string> }
  | { kind: "wrong_method"; allow: string[] }
  | { kind: "none" };

export interface Router {
  readonly routes: readonly Route[];
  match(method: string, pathname: string): RouteMatch;
}

function compile(route: Route): CompiledRoute {
  if (!route.path.startsWith("/")) throw new Error(`route ${route.id}: path must start with "/"`);
  const parts = route.path === "/" ? [] : route.path.slice(1).split("/");
  const segments: Segment[] = parts.map((part, index) => {
    if (part.startsWith(":")) return { kind: "param", name: part.slice(1) };
    if (part.startsWith("*")) {
      if (index !== parts.length - 1) throw new Error(`route ${route.id}: *${part.slice(1)} must be the last segment`);
      return { kind: "rest", name: part.slice(1) };
    }
    return { kind: "literal", value: part };
  });
  // Literal segments outrank parameters, which outrank a trailing rest, position by position.
  let score = 0;
  for (const segment of segments) score = score * 3 + (segment.kind === "literal" ? 2 : segment.kind === "param" ? 1 : 0);
  return { route, segments, score: score * 100 + segments.length };
}

function matchSegments(segments: Segment[], path: string[]): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index] as Segment;
    if (segment.kind === "rest") {
      const rest = path.slice(index);
      if (rest.length === 0 || (rest.length === 1 && rest[0] === "")) return null;
      params[segment.name] = rest.join("/");
      return params;
    }
    const value = path[index];
    if (value === undefined) return null;
    if (segment.kind === "literal") {
      if (value !== segment.value) return null;
    } else {
      if (value === "") return null;
      params[segment.name] = value;
    }
  }
  return path.length === segments.length ? params : null;
}

/** Splits a raw path into percent-decoded segments (decoded exactly once); null when the encoding is malformed. */
function decodePath(pathname: string): string[] | null {
  if (!pathname.startsWith("/")) return null;
  if (pathname === "/") return [];
  const out: string[] = [];
  for (const raw of pathname.slice(1).split("/")) {
    try {
      out.push(decodeURIComponent(raw));
    } catch {
      return null;
    }
  }
  return out;
}

export function createRouter(routes: readonly Route[]): Router {
  const ids = new Set<string>();
  for (const route of routes) {
    if (ids.has(route.id)) throw new Error(`duplicate route id ${route.id}`);
    ids.add(route.id);
  }
  const compiled = routes.map(compile).sort((a, b) => b.score - a.score);
  return {
    routes,
    match(method: string, pathname: string): RouteMatch {
      const path = decodePath(pathname);
      if (path === null) return { kind: "none" };
      const allow: string[] = [];
      for (const entry of compiled) {
        const params = matchSegments(entry.segments, path);
        if (params === null) continue;
        if (entry.route.method === method) return { kind: "found", route: entry.route, params };
        if (!allow.includes(entry.route.method)) allow.push(entry.route.method);
      }
      return allow.length > 0 ? { kind: "wrong_method", allow: allow.sort() } : { kind: "none" };
    },
  };
}
