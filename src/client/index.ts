import { HTTP_STATUS, RunwrightError, type ErrorCode } from "../core/errors.ts";
import { performance } from "node:perf_hooks";
import { delay, MAX_TIMER_MS } from "../core/clock.ts";
import type { Json, JsonObject } from "../core/json.ts";
import type { AgentDefinition } from "../agents/definition.ts";
import type { SecretStatus } from "../security/types.ts";
import type {
  AgentRecord, AgentRevision, CommandRecord, JournalRecord, LearningHistoryEntry, LearningItem, LearningKind,
  LearningMetrics, LearningStatus, LearningUse, PendingKind, PendingRecord, RunRecord, RunStatus,
  SavedWorkflow, TriggerRecord, UsageRow,
} from "../store/types.ts";
import type { WorkspaceEntry } from "../tools/workspace.ts";
import type { TriggerInput } from "../triggers/service.ts";
import type { DryRunReport, WorkflowGraph, WorkflowProblem } from "../workflow/types.ts";
import type { ApiDescription } from "../server/describe.ts";
import { SseParser } from "./sse.ts";

export interface ClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  /**
   * The time limit of every request but the event stream, from sending it to the end of its body, in ms
   * (default 30000; a finite number from 1 to 2147483647, otherwise bad_request when the client is created).
   */
  requestTimeoutMs?: number;
}
export interface TimelineEvent { id: number | null; event: string; data: Json }

/**
 * Limits a request may set or change (`startRun`, `setLimits`): whole numbers from 0 to 2^53 - 1 (the client's
 * types cannot say "whole", so the server checks it and answers `validation_failed`). A limit cannot be removed
 * over the API, only changed: there is no `null`, unlike the `RunLimits` a run reports.
 */
export interface RunLimitsInput { maxCostMicros?: number; maxToolCalls?: number; maxTurns?: number; allowUnpriced?: boolean }

/**
 * How a workflow document that is not being saved is checked (`validateWorkflow`, `dryRunWorkflow`,
 * `graphWorkflow`). `embedded: true`: as an agent's embedded workflow is checked when the agent is saved, so no
 * `call` resolves to the document by its own `name`. Absent or false: as the saved workflow of its own `name`.
 */
export interface WorkflowCheckOptions { embedded?: boolean }

/** The value and confidence a dry run gives named decision nodes. */
export type DryRunDecisions = { [nodeId: string]: { value: boolean | string | number; confidence: number } };

/**
 * The operations of the HTTP API. Every value a parameter's type allows is one the route's schema can accept, as
 * far as TypeScript can say it; what it cannot say (a whole number in a range, a string's length or pattern, such
 * as an agent id or a workflow name) the server checks, answering `validation_failed` (a body) or `bad_request`
 * (a query or path parameter). The ranges are given on the methods.
 */
export interface RunwrightClient {
  health(): Promise<{ status: string; version: string }>;
  ready(): Promise<JsonObject>;
  describeApi(): Promise<ApiDescription>;
  listAgents(): Promise<{ agent: AgentRecord; definition: AgentDefinition }[]>;
  getAgent(id: string): Promise<{ agent: AgentRecord; revision: AgentRevision }>;
  /** `id` matches `AGENT_ID_PATTERN` (src/agents/definition.ts); the server checks it and the whole definition. */
  saveAgent(definition: AgentDefinition, id?: string): Promise<{ agent: AgentRecord; revision: AgentRevision; created: boolean }>;
  listRevisions(id: string): Promise<AgentRevision[]>;
  getRevision(id: string, revision: number): Promise<AgentRevision>;
  learningMetrics(agentId: string): Promise<LearningMetrics>;
  /** `revision` is a whole number from 1; `idempotencyKey` is 1 to 200 characters (the server checks both). */
  startRun(input: { agentId: string; message?: string; data?: Json; limits?: RunLimitsInput; revision?: number; idempotencyKey?: string }): Promise<{ run: RunRecord; created: boolean }>;
  /** The run and every one of its open pendings, oldest first. */
  getRun(id: string): Promise<{ run: RunRecord; pendings: PendingRecord[] }>;
  /**
   * One page of runs, newest first (`limit` a whole number from 1 to 200, default 50; the server checks it). Runs
   * grow without bound over time, so there is no helper that follows every page: pass `nextCursor` as `cursor`.
   */
  listRuns(query?: { agentId?: string; status?: RunStatus[]; triggerId?: string; limit?: number; cursor?: string }): Promise<{ runs: RunRecord[]; nextCursor: string | null }>;
  /**
   * Resolves when the run is completed, failed, cancelled, waiting or paused. Each request gets the signal and
   * at most the time left of `timeoutMs`; rejects RunwrightError("aborted") when the signal aborts and
   * RunwrightError("unavailable") once `timeoutMs` has passed, even when a response arrives after it.
   * `timeoutMs` (finite, >= 0) and `pollMs` (finite, > 0, default 100) are bad_request otherwise.
   */
  waitForRun(id: string, options?: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal }): Promise<{ run: RunRecord; pendings: PendingRecord[] }>;
  cancelRun(id: string, reason?: string): Promise<CommandRecord>;
  pauseRun(id: string): Promise<CommandRecord>;
  resumeRun(id: string): Promise<CommandRecord>;
  sendMessage(id: string, text: string): Promise<CommandRecord>;
  /** At least one limit (the server answers `validation_failed` for none). */
  setLimits(id: string, limits: RunLimitsInput): Promise<CommandRecord>;
  /**
   * One page of the run's journal, oldest first (`after` a whole number from 0, `limit` from 1 to 1000, default
   * 500; the server checks both). A journal grows with the run, so there is no helper that reads every page: pass
   * `nextAfter` (or the last record's `seq`) as `after`.
   */
  timeline(id: string, query?: { after?: number; limit?: number }): Promise<{ records: JournalRecord[]; nextAfter: number | null; archived: boolean }>;
  /** Ends after the "end" event (which is yielded). The stream has no time limit; only its signal stops it. */
  followTimeline(id: string, options?: { after?: number; signal?: AbortSignal }): AsyncIterable<TimelineEvent>;
  /**
   * Every file of the run's workspace, ordered by path: follows `nextCursor` until the last page. Kept as one call
   * because the list is bounded by the run's workspace, not by time.
   */
  listFiles(id: string): Promise<WorkspaceEntry[]>;
  readFile(id: string, path: string): Promise<{ contentType: string; body: Uint8Array }>;
  runLearning(id: string): Promise<LearningUse[]>;
  /**
   * One page of pendings, oldest first (`limit` a whole number from 1 to 200, default 50; the server checks it).
   * Resolved pendings grow without bound over time, so there is no helper that follows every page.
   */
  listPendings(query?: { status?: "open" | "resolved"; runId?: string; agentId?: string; kind?: PendingKind; limit?: number; cursor?: string }): Promise<{ pendings: PendingRecord[]; nextCursor: string | null }>;
  getPending(id: string): Promise<PendingRecord>;
  answer(pendingId: string, answer: string): Promise<CommandRecord>;
  approve(pendingId: string, options?: { always?: boolean }): Promise<CommandRecord>;
  deny(pendingId: string, reason?: string): Promise<CommandRecord>;
  resolveInterrupted(pendingId: string, action: "retry" | "skip" | "cancel", result?: string): Promise<CommandRecord>;
  validateWorkflow(document: Json, options?: WorkflowCheckOptions): Promise<{ ok: boolean; problems: WorkflowProblem[] }>;
  /** `decisions`: per node id `{value, confidence}` with a confidence from 0 to 1 (the server checks the range). */
  dryRunWorkflow(document: Json, options?: { input?: Json; decisions?: DryRunDecisions } & WorkflowCheckOptions): Promise<DryRunReport>;
  graphWorkflow(document: Json, options?: WorkflowCheckOptions): Promise<{ graph: WorkflowGraph; mermaid: string }>;
  listWorkflows(): Promise<{ name: string; version: number; source: string; createdAt: number }[]>;
  getWorkflow(name: string, version?: number): Promise<SavedWorkflow>;
  /** `name` matches `^[a-z][a-z0-9_-]{0,63}$` (the server checks it). */
  saveWorkflow(name: string, document: Json): Promise<{ workflow: SavedWorkflow; created: boolean }>;
  savedWorkflowGraph(name: string): Promise<{ graph: WorkflowGraph; mermaid: string }>;
  listLearning(query?: { agentId?: string; status?: LearningStatus; kind?: LearningKind }): Promise<LearningItem[]>;
  getLearning(id: string): Promise<LearningItem>;
  learningHistory(id: string): Promise<LearningHistoryEntry[]>;
  retireLearning(id: string, etag: string): Promise<LearningItem>;
  restoreLearning(id: string, etag: string): Promise<LearningItem>;
  approveLearning(id: string, etag: string): Promise<LearningItem>;
  editLearning(id: string, etag: string, patch: { title?: string; description?: string; body?: string }): Promise<LearningItem>;
  listTriggers(): Promise<TriggerRecord[]>;
  createTrigger(input: TriggerInput): Promise<TriggerRecord>;
  getTrigger(id: string): Promise<TriggerRecord>;
  updateTrigger(id: string, patch: Partial<TriggerInput>): Promise<TriggerRecord>;
  deleteTrigger(id: string): Promise<void>;
  fireTrigger(id: string, data?: Json): Promise<{ run: RunRecord; created: boolean }>;
  listSecrets(): Promise<SecretStatus[]>;
  secretStatus(name: string): Promise<SecretStatus>;
  setSecret(name: string, value: string): Promise<SecretStatus>;
  deleteSecret(name: string): Promise<void>;
  /** `from` and `to` are epoch milliseconds, whole numbers from 0 (the server checks them). */
  usage(query?: { groupBy?: "day" | "agent" | "model"; from?: number; to?: number; agentId?: string }): Promise<{ groupBy: string; rows: UsageRow[] }>;
}

const SETTLED: readonly RunStatus[] = ["completed", "failed", "cancelled", "waiting", "paused"];

type Query = Record<string, string | number | boolean | undefined>;
interface RequestOptions { query?: Query; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number }

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_MS = 100;
/** Files per request of `listFiles` (the server's maximum: each page walks the workspace once). */
const FILES_PAGE = 1000;

/** `value` when it is a finite number in range, otherwise bad_request naming the option. */
function checkedNumber(name: string, value: unknown, min: number, inclusive: boolean, max: number): number {
  const ok = typeof value === "number" && Number.isFinite(value) && (inclusive ? value >= min : value > min) && value <= max;
  if (!ok) {
    const range = max === Number.MAX_VALUE ? `${inclusive ? ">=" : ">"} ${min}` : `from ${min} to ${max}`;
    throw new RunwrightError("bad_request", `${name} must be a finite number ${range}, got ${String(value)}`, {
      details: { option: name },
    });
  }
  return value;
}

/**
 * One request's signal: the caller's signal and a time limit together. `race` settles a promise early when either
 * fires (an injected fetch may not wire the signal to its body), and `failure` says which one did.
 */
interface RequestGuard {
  readonly signal: AbortSignal;
  race<T>(work: Promise<T>): Promise<T>;
  /** The error for a fired signal: `aborted` for the caller's, `unavailable` for the time limit; null if neither. */
  failure(cause?: unknown): RunwrightError | null;
  dispose(): void;
}

const enc = encodeURIComponent;

/** A file path encoded segment by segment, so "/" separators survive and everything else is escaped. */
export function encodeFilePath(path: string): string {
  return path.split("/").map(enc).join("/");
}

function isErrorCode(code: unknown): code is ErrorCode {
  return typeof code === "string" && Object.hasOwn(HTTP_STATUS, code);
}

function errorFrom(status: number, text: string): RunwrightError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const error = parsed !== null && typeof parsed === "object" ? (parsed as { error?: unknown }).error : undefined;
  if (error !== null && typeof error === "object") {
    const { code, message, details } = error as { code?: unknown; message?: unknown; details?: unknown };
    const options: { status: number; details?: JsonObject } = { status };
    if (details !== null && typeof details === "object" && !Array.isArray(details)) options.details = details as JsonObject;
    return new RunwrightError(isErrorCode(code) ? code : "internal", typeof message === "string" ? message : `HTTP ${status}`, options);
  }
  return new RunwrightError("internal", `the server answered HTTP ${status} with an unreadable body`, { status });
}

function queryString(query: Query | undefined): string {
  if (query === undefined) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

/** The `embedded` member of a workflow check's body: sent only when it is true. */
function embeddedField(options: WorkflowCheckOptions | undefined): { embedded?: true } {
  return options?.embedded === true ? { embedded: true } : {};
}

function quoteEtag(etag: string): string {
  return etag.startsWith('"') ? etag : `"${etag}"`;
}

/** A dependency-free client for the Runwright HTTP API. */
export function createClient(options: ClientOptions): RunwrightClient {
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const requestTimeoutMs = options.requestTimeoutMs === undefined
    ? DEFAULT_REQUEST_TIMEOUT_MS
    : checkedNumber("requestTimeoutMs", options.requestTimeoutMs, 1, true, MAX_TIMER_MS);
  /** The time-limit errors this client made, so a wait can tell its own deadline from other failures. */
  const timeLimitErrors = new WeakSet<RunwrightError>();

  const guardFor = (caller: AbortSignal | undefined, limitMs: number): RequestGuard => {
    const controller = new AbortController();
    let timedOut = false;
    const onCallerAbort = (): void => controller.abort(caller?.reason);
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("request time limit"));
    }, Math.max(1, Math.ceil(limitMs)));
    if (caller?.aborted === true) controller.abort(caller.reason);
    else caller?.addEventListener("abort", onCallerAbort, { once: true });
    const failure = (cause?: unknown): RunwrightError | null => {
      if (caller?.aborted === true) return new RunwrightError("aborted", "the request was aborted", { cause });
      if (!timedOut) return null;
      const error = new RunwrightError("unavailable", `the Runwright server at ${base} did not answer within ${Math.ceil(limitMs)} ms`, { cause });
      timeLimitErrors.add(error);
      return error;
    };
    return {
      signal: controller.signal,
      failure,
      race<T>(work: Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
          const fail = (): void => reject(failure() ?? new RunwrightError("aborted", "the request was aborted"));
          if (controller.signal.aborted) {
            work.catch(() => undefined);
            fail();
            return;
          }
          controller.signal.addEventListener("abort", fail, { once: true });
          work.then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", fail));
        });
      },
      dispose(): void {
        clearTimeout(timer);
        caller?.removeEventListener("abort", onCallerAbort);
      },
    };
  };

  const requestInit = (method: string, request: RequestOptions | undefined): RequestInit => {
    const headers: Record<string, string> = { Authorization: `Bearer ${options.token}`, Accept: "application/json", ...request?.headers };
    const init: RequestInit = { method, headers };
    if (request?.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(request.body);
    }
    return init;
  };

  /**
   * One request and the reading of its body, both under one time limit (`request.timeoutMs`, at most
   * `requestTimeoutMs`) and the caller's signal. A non-2xx answer becomes the server's RunwrightError.
   */
  const exchange = async <T>(method: string, path: string, request: RequestOptions | undefined, read: (response: Response) => Promise<T>): Promise<T> => {
    const limit = Math.min(requestTimeoutMs, request?.timeoutMs ?? requestTimeoutMs);
    const guard = guardFor(request?.signal, limit);
    let response: Response | null = null;
    try {
      try {
        response = await guard.race(doFetch(`${base}${path}${queryString(request?.query)}`, { ...requestInit(method, request), signal: guard.signal }));
      } catch (error) {
        throw guard.failure(error)
          ?? new RunwrightError("unavailable", `cannot reach the Runwright server at ${base}: ${(error as Error).message}`, { cause: error });
      }
      const answered = response;
      try {
        if (!answered.ok) {
          const text = await guard.race(answered.text()).catch((error: unknown) => {
            const failure = guard.failure(error);
            if (failure !== null) throw failure;
            return "";
          });
          throw errorFrom(answered.status, text);
        }
        return await guard.race(read(answered));
      } catch (error) {
        throw guard.failure(error) ?? error;
      }
    } finally {
      if (guard.signal.aborted) response?.body?.cancel().catch(() => undefined);
      guard.dispose();
    }
  };

  const call = <T>(method: string, path: string, request?: RequestOptions): Promise<T> =>
    exchange(method, path, request, async (response) => {
      if (response.status === 204) return undefined as T;
      const text = await response.text();
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new RunwrightError("internal", `the server sent a response that is not JSON (HTTP ${response.status})`, { status: response.status });
      }
    });

  /** The event stream: no time limit, only the caller's signal. */
  const openStream = async (path: string, headers: Record<string, string>, signal: AbortSignal | undefined): Promise<Response> => {
    const init = requestInit("GET", { headers });
    if (signal !== undefined) init.signal = signal;
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, init);
    } catch (error) {
      if (signal?.aborted === true) throw new RunwrightError("aborted", "the request was aborted", { cause: error });
      throw new RunwrightError("unavailable", `cannot reach the Runwright server at ${base}: ${(error as Error).message}`, { cause: error });
    }
    if (!response.ok) throw errorFrom(response.status, await response.text().catch(() => ""));
    return response;
  };

  const withEtag = async (method: string, path: string, etag: string, body: unknown): Promise<LearningItem> =>
    (await call<{ item: LearningItem }>(method, path, { body, headers: { "If-Match": quoteEtag(etag) } })).item;

  async function* followTimeline(id: string, follow?: { after?: number; signal?: AbortSignal }): AsyncGenerator<TimelineEvent> {
    let lastId: string | null = follow?.after === undefined ? null : String(follow.after);
    let reconnected = false;
    for (;;) {
      const headers: Record<string, string> = { Accept: "text/event-stream" };
      if (lastId !== null) headers["Last-Event-ID"] = lastId;
      let response: Response;
      try {
        response = await openStream(`/v1/runs/${enc(id)}/events`, headers, follow?.signal);
      } catch (error) {
        if (follow?.signal?.aborted === true) return;
        if (!reconnected && error instanceof RunwrightError && error.code === "unavailable" && lastId !== null) {
          reconnected = true;
          continue;
        }
        throw error;
      }
      if (response.body === null) throw new RunwrightError("unavailable", "the event stream has no body");
      const parser = new SseParser();
      const decoder = new TextDecoder();
      let received = false;
      try {
        for await (const chunk of response.body) {
          for (const raw of parser.push(decoder.decode(chunk, { stream: true }))) {
            let data: Json;
            try {
              data = JSON.parse(raw.data) as Json;
            } catch {
              data = raw.data;
            }
            const numeric = raw.id !== null && /^\d+$/.test(raw.id) ? Number(raw.id) : null;
            if (raw.id !== null) lastId = raw.id;
            received = true;
            yield { id: numeric, event: raw.event, data };
            if (raw.event === "end") return;
          }
        }
      } catch (error) {
        if (follow?.signal?.aborted === true) return;
        if (error instanceof RunwrightError) throw error;
      }
      if (follow?.signal?.aborted === true) return;
      // The connection dropped before "end": reconnect once from the last id (again after any progress).
      if (reconnected && !received) {
        throw new RunwrightError("unavailable", "the event stream dropped and reconnecting did not help");
      }
      reconnected = true;
    }
  }

  return {
    health: () => call("GET", "/v1/health"),
    ready: () => call("GET", "/v1/ready"),
    describeApi: () => call("GET", "/v1/api"),
    listAgents: async () => (await call<{ agents: { agent: AgentRecord; definition: AgentDefinition }[] }>("GET", "/v1/agents")).agents,
    getAgent: (id) => call("GET", `/v1/agents/${enc(id)}`),
    saveAgent: (definition, id) =>
      id === undefined ? call("POST", "/v1/agents", { body: { definition } }) : call("PUT", `/v1/agents/${enc(id)}`, { body: { definition } }),
    listRevisions: async (id) => (await call<{ revisions: AgentRevision[] }>("GET", `/v1/agents/${enc(id)}/revisions`)).revisions,
    getRevision: async (id, revision) => (await call<{ revision: AgentRevision }>("GET", `/v1/agents/${enc(id)}/revisions/${enc(String(revision))}`)).revision,
    learningMetrics: async (agentId) => (await call<{ metrics: LearningMetrics }>("GET", `/v1/agents/${enc(agentId)}/learning/metrics`)).metrics,
    startRun: (input) => call("POST", "/v1/runs", { body: input }),
    getRun: (id) => call("GET", `/v1/runs/${enc(id)}`),
    listRuns: (query) => call("GET", "/v1/runs", {
      query: { agentId: query?.agentId, status: query?.status?.join(","), triggerId: query?.triggerId, limit: query?.limit, cursor: query?.cursor },
    }),
    async waitForRun(id, wait) {
      const timeoutMs = wait?.timeoutMs === undefined ? undefined : checkedNumber("timeoutMs", wait.timeoutMs, 0, true, Number.MAX_VALUE);
      const pollMs = wait?.pollMs === undefined ? DEFAULT_POLL_MS : checkedNumber("pollMs", wait.pollMs, 0, false, Number.MAX_VALUE);
      const signal = wait?.signal;
      const abortedNow = (): boolean => signal?.aborted === true;
      const deadline = timeoutMs === undefined ? Number.POSITIVE_INFINITY : performance.now() + timeoutMs;
      let last: RunStatus | null = null;
      const aborted = (cause?: unknown): RunwrightError => new RunwrightError("aborted", "waiting for the run was aborted", { cause });
      const expired = (cause?: unknown): RunwrightError => last === null
        ? new RunwrightError("unavailable", `run ${id} did not answer within ${timeoutMs} ms`, { details: { runId: id }, cause })
        : new RunwrightError("unavailable", `run ${id} is still ${last} after ${timeoutMs} ms`, { details: { runId: id, status: last }, cause });
      for (;;) {
        if (abortedNow()) throw aborted(signal?.reason);
        const left = deadline - performance.now();
        if (left <= 0) throw expired();
        const limit = Math.min(requestTimeoutMs, left);
        const request: RequestOptions = signal === undefined ? { timeoutMs: limit } : { timeoutMs: limit, signal };
        let current: { run: RunRecord; pendings: PendingRecord[] };
        try {
          current = await call<{ run: RunRecord; pendings: PendingRecord[] }>("GET", `/v1/runs/${enc(id)}`, request);
        } catch (error) {
          if (abortedNow()) throw aborted(error);
          const ownLimit = error instanceof RunwrightError && timeLimitErrors.has(error) && limit < requestTimeoutMs;
          if (ownLimit || performance.now() >= deadline) throw expired(error);
          throw error;
        }
        if (abortedNow()) throw aborted(signal?.reason);
        last = current.run.status;
        if (performance.now() >= deadline) throw expired();
        if (SETTLED.includes(current.run.status)) return current;
        try {
          await delay(Math.min(pollMs, deadline - performance.now()), signal);
        } catch (error) {
          throw aborted(error);
        }
      }
    },
    cancelRun: async (id, reason) =>
      (await call<{ command: CommandRecord }>("POST", `/v1/runs/${enc(id)}/cancel`, { body: reason === undefined ? {} : { reason } })).command,
    pauseRun: async (id) => (await call<{ command: CommandRecord }>("POST", `/v1/runs/${enc(id)}/pause`, { body: {} })).command,
    resumeRun: async (id) => (await call<{ command: CommandRecord }>("POST", `/v1/runs/${enc(id)}/resume`, { body: {} })).command,
    sendMessage: async (id, text) => (await call<{ command: CommandRecord }>("POST", `/v1/runs/${enc(id)}/messages`, { body: { text } })).command,
    setLimits: async (id, limits) => (await call<{ command: CommandRecord }>("POST", `/v1/runs/${enc(id)}/limits`, { body: limits })).command,
    timeline: (id, query) => call("GET", `/v1/runs/${enc(id)}/timeline`, { query: { after: query?.after, limit: query?.limit } }),
    followTimeline: (id, follow) => followTimeline(id, follow),
    async listFiles(id) {
      const files: WorkspaceEntry[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await call<{ files: WorkspaceEntry[]; nextCursor: string | null }>("GET", `/v1/runs/${enc(id)}/files`, {
          query: { limit: FILES_PAGE, cursor },
        });
        for (const file of page.files) files.push(file);
        if (page.nextCursor === null || page.nextCursor === undefined) return files;
        if (page.nextCursor === cursor) throw new RunwrightError("internal", "the server's pages of files do not advance");
        cursor = page.nextCursor;
      }
    },
    async readFile(id, path) {
      return exchange("GET", `/v1/runs/${enc(id)}/files/${encodeFilePath(path)}`, { headers: { Accept: "*/*" } }, async (response) => ({
        contentType: response.headers.get("content-type") ?? "application/octet-stream",
        body: new Uint8Array(await response.arrayBuffer()),
      }));
    },
    runLearning: async (id) => (await call<{ uses: LearningUse[] }>("GET", `/v1/runs/${enc(id)}/learning`)).uses,
    listPendings: (query) => call("GET", "/v1/pendings", { query: { ...query } }),
    getPending: async (id) => (await call<{ pending: PendingRecord }>("GET", `/v1/pendings/${enc(id)}`)).pending,
    answer: async (pendingId, answer) => (await call<{ command: CommandRecord }>("POST", `/v1/pendings/${enc(pendingId)}/answer`, { body: { answer } })).command,
    approve: async (pendingId, approve) =>
      (await call<{ command: CommandRecord }>("POST", `/v1/pendings/${enc(pendingId)}/approve`, { body: approve?.always === undefined ? {} : { always: approve.always } })).command,
    deny: async (pendingId, reason) =>
      (await call<{ command: CommandRecord }>("POST", `/v1/pendings/${enc(pendingId)}/deny`, { body: reason === undefined ? {} : { reason } })).command,
    resolveInterrupted: async (pendingId, action, result) =>
      (await call<{ command: CommandRecord }>("POST", `/v1/pendings/${enc(pendingId)}/resolve`, { body: result === undefined ? { action } : { action, result } })).command,
    validateWorkflow: (document, check) => call("POST", "/v1/workflows/validate", { body: { document, ...embeddedField(check) } }),
    dryRunWorkflow: async (document, dry) => {
      const body: JsonObject = { document, ...embeddedField(dry) };
      if (dry?.input !== undefined) body["input"] = dry.input;
      if (dry?.decisions !== undefined) body["decisions"] = dry.decisions;
      return (await call<{ report: DryRunReport }>("POST", "/v1/workflows/dry-run", { body })).report;
    },
    graphWorkflow: (document, check) => call("POST", "/v1/workflows/graph", { body: { document, ...embeddedField(check) } }),
    listWorkflows: async () => (await call<{ workflows: { name: string; version: number; source: string; createdAt: number }[] }>("GET", "/v1/workflows")).workflows,
    getWorkflow: async (name, version) => (await call<{ workflow: SavedWorkflow }>("GET", `/v1/workflows/${enc(name)}`, { query: { version } })).workflow,
    saveWorkflow: (name, document) => call("PUT", `/v1/workflows/${enc(name)}`, { body: { document } }),
    savedWorkflowGraph: (name) => call("GET", `/v1/workflows/${enc(name)}/graph`),
    listLearning: async (query) => (await call<{ items: LearningItem[] }>("GET", "/v1/learning", { query: { ...query } })).items,
    getLearning: async (id) => (await call<{ item: LearningItem }>("GET", `/v1/learning/${enc(id)}`)).item,
    learningHistory: async (id) => (await call<{ history: LearningHistoryEntry[] }>("GET", `/v1/learning/${enc(id)}/history`)).history,
    retireLearning: (id, etag) => withEtag("POST", `/v1/learning/${enc(id)}/retire`, etag, {}),
    restoreLearning: (id, etag) => withEtag("POST", `/v1/learning/${enc(id)}/restore`, etag, {}),
    approveLearning: (id, etag) => withEtag("POST", `/v1/learning/${enc(id)}/approve`, etag, {}),
    editLearning: (id, etag, patch) => withEtag("PATCH", `/v1/learning/${enc(id)}`, etag, patch),
    listTriggers: async () => (await call<{ triggers: TriggerRecord[] }>("GET", "/v1/triggers")).triggers,
    createTrigger: async (input) => (await call<{ trigger: TriggerRecord }>("POST", "/v1/triggers", { body: input })).trigger,
    getTrigger: async (id) => (await call<{ trigger: TriggerRecord }>("GET", `/v1/triggers/${enc(id)}`)).trigger,
    updateTrigger: async (id, patch) => (await call<{ trigger: TriggerRecord }>("PATCH", `/v1/triggers/${enc(id)}`, { body: patch })).trigger,
    deleteTrigger: async (id) => {
      await call<void>("DELETE", `/v1/triggers/${enc(id)}`);
    },
    fireTrigger: (id, data) => call("POST", `/v1/triggers/${enc(id)}/fire`, { body: data === undefined ? {} : { data } }),
    listSecrets: async () => (await call<{ secrets: SecretStatus[] }>("GET", "/v1/secrets")).secrets,
    secretStatus: async (name) => (await call<{ secret: SecretStatus }>("GET", `/v1/secrets/${enc(name)}`)).secret,
    setSecret: async (name, value) => (await call<{ secret: SecretStatus }>("PUT", `/v1/secrets/${enc(name)}`, { body: { value } })).secret,
    deleteSecret: async (name) => {
      await call<void>("DELETE", `/v1/secrets/${enc(name)}`);
    },
    usage: (query) => call("GET", "/v1/usage", { query: { ...query } }),
  };
}
