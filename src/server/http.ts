import type { IncomingMessage, ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import { RunwrightError, isRunwrightError } from "../core/errors.ts";
import { isJsonObject, parseStrictJson, type Json, type JsonObject } from "../core/json.ts";
import type { IdSource } from "../core/ids.ts";
import type { Logger } from "../log/logger.ts";
import { redactJsonWith } from "../core/redact.ts";
import { tokensEqual, type DigestCompare } from "../security/token.ts";
import { validateSchema } from "../schema/validate.ts";
import type { Reply, RequestContext, Route, Router } from "./router.ts";

export interface HttpCoreDeps {
  router: Router;
  token: string;
  bodyBytes: number;
  ids: IdSource;
  logger: Logger;
  /**
   * Text redaction applied to every JSON body and error the server sends, value by value before the body is
   * serialized: every string, every object key, and every number whose digits it changes.
   */
  redact: (text: string) => string;
  /** The digest comparison behind the bearer-token check (default `timingSafeEqual`). */
  compareDigests?: DigestCompare;
}

const JSON_TYPE = "application/json; charset=utf-8";
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);
const JSON_CONTENT_TYPE = /^application\/json\s*(;.*)?$/i;

export function json(status: number, body: unknown, headers?: Record<string, string>): Reply {
  return headers === undefined ? { kind: "json", status, body } : { kind: "json", status, body, headers };
}

export function empty(status: number, headers?: Record<string, string>): Reply {
  return headers === undefined ? { kind: "empty", status } : { kind: "empty", status, headers };
}

export const handled: Reply = Object.freeze({ kind: "handled" });

/** Headers every response carries, whatever its content. */
export function baseHeaders(res: ServerResponse, requestId: string): void {
  res.setHeader("X-Request-Id", requestId);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
}

function errorBody(error: RunwrightError): JsonObject {
  const body: JsonObject = { code: error.code, message: error.message };
  if (error.details !== undefined) body["details"] = error.details;
  return { error: body };
}

/**
 * After a streamed body passes the limit, the rest of it is read and thrown away, up to this many bytes and this
 * long, before the 413 is sent. Closing a socket that still has unread input resets the connection, and the reset
 * can reach the client before the 413 does; reading the remainder first lets the client see the answer.
 */
export const DISCARD_BYTES = 4 * 1024 * 1024;
export const DISCARD_MS = 2000;

function readRawBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = req.headers["content-length"];
  if (declared !== undefined && Number(declared) > limit) {
    return Promise.reject(tooLarge(limit));
  }
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    let discardTimer: NodeJS.Timeout | null = null;
    const finish = (error: RunwrightError | null): void => {
      if (done) return;
      done = true;
      if (discardTimer !== null) clearTimeout(discardTimer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      if (error !== null) reject(error);
      else resolve(Buffer.concat(chunks, total));
    };
    const stopDiscarding = (): void => {
      req.pause();
      finish(tooLarge(limit));
    };
    const onData = (chunk: Buffer): void => {
      total += chunk.length;
      if (total <= limit) {
        chunks.push(chunk);
        return;
      }
      if (discardTimer === null) {
        chunks.length = 0;
        discardTimer = setTimeout(stopDiscarding, DISCARD_MS);
        discardTimer.unref();
      }
      if (total - limit > DISCARD_BYTES) stopDiscarding();
    };
    const onEnd = (): void => finish(total > limit ? tooLarge(limit) : null);
    const onError = (): void => finish(new RunwrightError("bad_request", "the request body could not be read"));
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

function tooLarge(limit: number): RunwrightError {
  return new RunwrightError("body_too_large", `the request body is larger than ${limit} bytes`, { details: { limitBytes: limit } });
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** Parses a request body as one strict JSON value (duplicate keys, trailing text, `__proto__` keys refused). */
export function parseJsonBytes(bytes: Uint8Array): Json {
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    throw new RunwrightError("invalid_json", "the request body is not valid UTF-8");
  }
  return parseStrictJson(text);
}

/** Parses a request body as one strict JSON object. */
function parseJsonObject(bytes: Uint8Array): JsonObject {
  const value = parseJsonBytes(bytes);
  if (!isJsonObject(value)) throw new RunwrightError("bad_request", "the request body must be a JSON object");
  return value;
}

function presentedToken(req: IncomingMessage): string | null {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return null;
  const match = /^Bearer[ ]+(\S+)\s*$/.exec(header);
  return match === null ? null : (match[1] as string);
}

function checkAuth(route: Route, req: IncomingMessage, token: string, compare: DigestCompare | undefined): void {
  if (route.auth !== "bearer") return;
  const presented = presentedToken(req);
  if (presented === null || !tokensEqual(token, presented, compare)) {
    throw new RunwrightError("unauthorized", "a valid bearer token is required");
  }
}

async function readBody(route: Route, req: IncomingMessage, limit: number): Promise<{ body: JsonObject; raw: Buffer }> {
  const method = req.method ?? "GET";
  if (route.bodyMode === "none" || !BODY_METHODS.has(method)) return { body: {}, raw: Buffer.alloc(0) };
  const raw = await readRawBody(req, limit);
  if (route.bodyMode === "raw") return { body: {}, raw };
  let body: JsonObject = {};
  if (raw.length > 0) {
    const type = req.headers["content-type"];
    if (typeof type !== "string" || !JSON_CONTENT_TYPE.test(type)) {
      throw new RunwrightError("bad_request", "the request body must be sent with Content-Type: application/json", { status: 415 });
    }
    body = parseJsonObject(raw);
  }
  if (route.body !== null) {
    const problems = validateSchema(route.body, body);
    if (problems.length > 0) {
      throw new RunwrightError("validation_failed", problems.slice(0, 5).map((p) => `${p.path}: ${p.message}`).join("; "), {
        details: { problems: problems.map((p) => ({ path: p.path, keyword: p.keyword, message: p.message })) },
      });
    }
  }
  return { body, raw };
}

function splitUrl(url: string): { pathname: string; search: string } {
  const index = url.indexOf("?");
  return index < 0 ? { pathname: url, search: "" } : { pathname: url.slice(0, index), search: url.slice(index + 1) };
}

/**
 * The request handler: route match (404 / 405), auth (401), body (413 / 415 / 400), handler, one error shape.
 * One access log line per request at debug; bodies and the Authorization header are never logged.
 */
export function createRequestHandler(deps: HttpCoreDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const send = (res: ServerResponse, reply: Reply): void => {
    if (reply.kind === "handled") return;
    for (const [name, value] of Object.entries(reply.headers ?? {})) res.setHeader(name, value);
    if (reply.kind === "empty") {
      res.writeHead(reply.status);
      res.end();
      return;
    }
    const text = JSON.stringify(redactJsonWith(reply.body === undefined ? null : reply.body, deps.redact, { numbers: true }));
    res.setHeader("Content-Type", JSON_TYPE);
    res.setHeader("Content-Length", Buffer.byteLength(text));
    res.writeHead(reply.status);
    res.end(text);
  };

  const sendError = (req: IncomingMessage, res: ServerResponse, requestId: string, error: unknown): void => {
    let failure: RunwrightError;
    if (isRunwrightError(error)) {
      failure = error;
    } else {
      deps.logger.error("request failed", {
        requestId,
        error: deps.redact(error instanceof Error ? error.message : String(error)),
      });
      failure = new RunwrightError("internal", "internal server error");
    }
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (failure.code === "unauthorized") res.setHeader("WWW-Authenticate", "Bearer");
    if (failure.code === "body_too_large") {
      res.setHeader("Connection", "close");
      res.once("finish", () => req.destroy());
    }
    send(res, json(failure.status, errorBody(failure)));
  };

  return async (req, res) => {
    const requestId = deps.ids.next("req");
    const started = performance.now();
    const method = req.method ?? "GET";
    const { pathname, search } = splitUrl(req.url ?? "/");
    res.once("finish", () => {
      deps.logger.debug("http request", {
        method,
        path: pathname,
        status: res.statusCode,
        ms: Math.round((performance.now() - started) * 10) / 10,
        requestId,
      });
    });
    baseHeaders(res, requestId);
    try {
      const match = deps.router.match(method, pathname);
      if (match.kind === "none") throw new RunwrightError("not_found", `no route for ${method} ${pathname}`);
      if (match.kind === "wrong_method") {
        res.setHeader("Allow", match.allow.join(", "));
        throw new RunwrightError("method_not_allowed", `${method} is not allowed here`, { details: { allow: match.allow } });
      }
      checkAuth(match.route, req, deps.token, deps.compareDigests);
      const { body, raw } = await readBody(match.route, req, deps.bodyBytes);
      const context: RequestContext = {
        req, res, requestId, params: match.params, query: new URLSearchParams(search), body, rawBody: raw,
      };
      send(res, await match.route.handler(context));
    } catch (error) {
      try {
        sendError(req, res, requestId, error);
      } catch {
        // The error body itself could not be built (a redactor that throws): the connection is cut instead.
        res.destroy();
      }
    }
  };
}

// ------------------------------------------------------------------ helpers for handlers

export function badRequest(message: string, details?: JsonObject): RunwrightError {
  return new RunwrightError("bad_request", message, details === undefined ? undefined : { details });
}

export function notFound(message: string): RunwrightError {
  return new RunwrightError("not_found", message);
}

export function queryString(query: URLSearchParams, name: string): string | undefined {
  const value = query.get(name);
  return value === null || value === "" ? undefined : value;
}

export function queryInt(
  query: URLSearchParams,
  name: string,
  options: { min: number; max?: number; fallback?: number },
): number | undefined {
  const text = queryString(query, name);
  if (text === undefined) return options.fallback;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (!/^\d{1,16}$/.test(text) || Number(text) < options.min || Number(text) > max) {
    throw badRequest(`query parameter ${name} must be an integer from ${options.min} to ${max}`, { parameter: name });
  }
  return Number(text);
}

export function queryEnum<T extends string>(query: URLSearchParams, name: string, allowed: readonly T[]): T | undefined {
  const text = queryString(query, name);
  if (text === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(text)) {
    throw badRequest(`query parameter ${name} must be one of ${allowed.join(", ")}`, { parameter: name });
  }
  return text as T;
}

/** Integer path parameter, 1 to Number.MAX_SAFE_INTEGER (a larger one would not be read back exactly). */
export function paramInt(params: Readonly<Record<string, string>>, name: string): number {
  const text = params[name] ?? "";
  if (!/^[1-9]\d{0,15}$/.test(text) || Number(text) > Number.MAX_SAFE_INTEGER) {
    throw badRequest(`path parameter ${name} must be an integer from 1 to ${Number.MAX_SAFE_INTEGER}`, { parameter: name });
  }
  return Number(text);
}

export function param(params: Readonly<Record<string, string>>, name: string): string {
  return params[name] ?? "";
}

/** Prefixes body-relative problem paths ("$.x") with the property they were found under. */
export function problemsUnder(prefix: string, problems: readonly { path: string; message: string; keyword?: string }[]): Json {
  return problems.map((p) => ({ ...p, path: prefix + p.path.slice(1) }));
}
