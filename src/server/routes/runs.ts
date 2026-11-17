import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { RunwrightError } from "../../core/errors.ts";
import { openRegularFile, type OpenedRegularFile } from "../../core/regular-file.ts";
import type { Json } from "../../core/json.ts";
import { validateSchema } from "../../schema/validate.ts";
import { createWriteRedaction } from "../../security/write-redaction.ts";
import { requestFingerprint } from "../../store/idempotency.ts";
import { isTerminal, RUN_STATUSES } from "../../store/state-machine.ts";
import type { PendingRecord, RunCommand, RunLimits, RunRecord, RunStatus } from "../../store/types.ts";
import { listWorkspaceFiles, resolveInWorkspace, safeContentType } from "../../tools/workspace.ts";
import { bundleSchema } from "../../workflow/schemas.ts";
import { requireRun, workspaceOf, type ServerContext, type ServerDeps } from "../context.ts";
import { badRequest, baseHeaders, json, notFound, param, problemsUnder, queryInt, queryString } from "../http.ts";
import type { Reply, Route } from "../router.ts";

const nonNegativeInteger = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const limitsSchema = {
  type: "object", additionalProperties: false,
  properties: {
    maxCostMicros: nonNegativeInteger, maxToolCalls: nonNegativeInteger, maxTurns: nonNegativeInteger,
    allowUnpriced: { type: "boolean" },
  },
};
const emptyBody = { type: "object", additionalProperties: false, properties: {} };

function toLimits(value: Json | undefined): Partial<RunLimits> | undefined {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Partial<RunLimits> = {};
  for (const key of ["maxCostMicros", "maxToolCalls", "maxTurns"] as const) {
    const item = value[key];
    if (typeof item === "number") out[key] = item;
  }
  if (typeof value["allowUnpriced"] === "boolean") out.allowUnpriced = value["allowUnpriced"];
  return out;
}

/**
 * Runs the checks of a new request (they read state that can change). When they reject, the key is looked up
 * once more before the rejection is answered: a run that an identical request started in the meantime is the
 * answer instead (invariant I2).
 */
async function orStartedRun<T>(
  started: () => Promise<RunRecord | null>,
  checks: () => Promise<T>,
): Promise<{ kind: "new"; value: T } | { kind: "started"; run: RunRecord }> {
  try {
    return { kind: "new", value: await checks() };
  } catch (error) {
    const run = await started();
    if (run !== null) return { kind: "started", run };
    throw error;
  }
}

/**
 * Queues a command after the API-level checks: the run exists (404) and is not finished (409). The single place
 * routes enqueue from; the store an app hands the server redacts the command's free text before it is stored.
 */
export async function queueCommand(deps: ServerDeps, runId: string, command: RunCommand): Promise<Reply> {
  const run = await requireRun(deps.store, runId);
  if (isTerminal(run.status)) {
    throw new RunwrightError("run_terminal", `run ${run.id} is already ${run.status}`, { details: { runId: run.id, status: run.status } });
  }
  return json(202, { command: await deps.store.enqueueCommand(run.id, command) });
}

/** Passes bytes through and fails at the end when their count is not `size`, so a short body is never ended normally. */
function exactly(size: number): Transform {
  let passed = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      passed += chunk.length;
      callback(null, chunk);
    },
    flush(callback) {
      callback(passed === size ? null : new Error(`sent ${passed} of ${size} bytes`));
    },
  });
}

function safeFilename(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);
  return cleaned === "" || /^\.+$/.test(cleaned) ? "file" : cleaned;
}

const FILES_PAGE_DEFAULT = 200;
const FILES_PAGE_MAX = 1000;
/** Open pendings are read from the store in pages of this size until there are no more. */
const PENDINGS_PAGE = 200;

function encodeFileCursor(path: string): string {
  return Buffer.from(path, "utf8").toString("base64url");
}

/** The path a files cursor names; 400 bad_request unless it is the canonical base64url of a UTF-8 path. */
function decodeFileCursor(cursor: string): string {
  const bad = (): RunwrightError => badRequest("cursor is not a nextCursor of this listing", { parameter: "cursor" });
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw bad();
  const bytes = Buffer.from(cursor, "base64url");
  if (bytes.toString("base64url") !== cursor) throw bad();
  let path: string;
  try {
    path = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw bad();
  }
  if (path === "") throw bad();
  return path;
}

/** Every open pending of the run, oldest first: the store is read page by page until `nextCursor` is null. */
async function allOpenPendings(deps: ServerDeps, runId: string): Promise<PendingRecord[]> {
  const all: PendingRecord[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await deps.store.listPendings({ runId, status: "open" }, { limit: PENDINGS_PAGE, ...(cursor === undefined ? {} : { cursor }) });
    for (const pending of page.items) all.push(pending);
    if (page.nextCursor === null) return all;
    if (page.nextCursor === cursor) throw new RunwrightError("store_error", "the store's pages of pendings do not advance");
    cursor = page.nextCursor;
  }
}

function startPosition(lastEventId: string | string[] | undefined, after: string | undefined): number {
  const header = Array.isArray(lastEventId) ? lastEventId[0] : lastEventId;
  const text = header !== undefined && header.trim() !== "" ? header.trim() : after;
  if (text === undefined || text === "") return 0;
  if (!/^\d{1,16}$/.test(text) || Number(text) > Number.MAX_SAFE_INTEGER) {
    throw badRequest(`Last-Event-ID / after must be an integer from 0 to ${Number.MAX_SAFE_INTEGER}`);
  }
  return Number(text);
}

export function runRoutes(context: ServerContext): Route[] {
  const { deps } = context;
  const redaction = createWriteRedaction(deps.secrets);
  return [
    {
      id: "runs.create", method: "POST", path: "/v1/runs", auth: "bearer",
      summary: "Start a run of an agent; an Idempotency-Key (header or body, stored only as its sha256 digest) returns the same run for the same request",
      query: {}, bodyMode: "json", response: "201 new / 200 existing {run, created}",
      body: {
        type: "object", required: ["agentId"], additionalProperties: false,
        properties: {
          agentId: { type: "string", minLength: 1, maxLength: 64 },
          message: { type: "string", maxLength: 1_000_000 },
          data: {},
          limits: limitsSchema,
          revision: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
          idempotencyKey: { type: "string", minLength: 1, maxLength: 200 },
        },
      },
      async handler({ req, body }) {
        const header = req.headers["idempotency-key"];
        const headerKey = typeof header === "string" && header.trim() !== "" ? header.trim() : undefined;
        if (headerKey !== undefined && headerKey.length > 200) throw badRequest("the Idempotency-Key header is at most 200 characters");
        const bodyKey = typeof body["idempotencyKey"] === "string" ? body["idempotencyKey"] : undefined;
        if (headerKey !== undefined && bodyKey !== undefined && headerKey !== bodyKey) {
          throw badRequest("the Idempotency-Key header and the body's idempotencyKey differ");
        }
        const idempotencyKey = headerKey ?? bodyKey;
        const agentId = body["agentId"] as string;
        const revisionNumber = typeof body["revision"] === "number" ? body["revision"] : undefined;
        const limits = toLimits(body["limits"]);
        const sent = {
          message: typeof body["message"] === "string" ? body["message"] : "",
          data: body["data"] === undefined ? null : body["data"],
        };
        // The request's identity is taken from what was sent, before redaction, so it never depends on which
        // secrets exist; it is exactly what a bare store computes for the same request.
        const fingerprint = requestFingerprint({
          agentId, input: sent,
          ...(revisionNumber === undefined ? {} : { revision: revisionNumber }),
          ...(limits === undefined ? {} : { limits }),
        });
        // Invariant I2: the key is looked up before anything that can change between two identical requests (the
        // secret set, the agent's current revision, its workflow input schema) is read. A key that already started
        // a run is answered with that run (or 409 for a different request) and with nothing else.
        const started = (): Promise<RunRecord | null> => idempotencyKey === undefined
          ? Promise.resolve(null)
          : deps.store.findIdempotentRun({ idempotencyKey, requestFingerprint: fingerprint });
        const existing = await started();
        if (existing !== null) return json(200, { run: existing, created: false });
        // A new request: redact, then validate, so what is stored is exactly what was validated, against the
        // revision the run is then pinned to.
        const prepared = await orStartedRun(started, async () => {
          const revision = await deps.store.getRevision(agentId, revisionNumber);
          if (revision === null) {
            throw notFound(revisionNumber === undefined ? `agent ${agentId} not found` : `agent ${agentId} has no revision ${revisionNumber}`);
          }
          const input = await redaction.runInput(revision.definition, sent);
          const workflow = revision.definition.workflow;
          if (workflow !== undefined) {
            const problems = validateSchema(bundleSchema(workflow, workflow.input), input.data);
            if (problems.length > 0) {
              throw new RunwrightError("validation_failed", `data does not match the workflow input schema: ${problems
                .slice(0, 5).map((p) => `${p.path}: ${p.message}`).join("; ")}`, { details: { problems: problemsUnder("$.data", problems) } });
            }
          }
          return { revision: revision.revision, input };
        });
        if (prepared.kind === "started") return json(200, { run: prepared.run, created: false });
        const result = await deps.store.createRun({
          agentId,
          input: prepared.value.input,
          requestFingerprint: fingerprint,
          revision: prepared.value.revision,
          ...(limits === undefined ? {} : { limits }),
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        });
        return json(result.created ? 201 : 200, result);
      },
    },
    {
      id: "runs.list", method: "GET", path: "/v1/runs", auth: "bearer", summary: "List runs, newest first, with cursor pagination",
      query: { agentId: "agent id", status: "comma list of run statuses", triggerId: "trigger id", limit: "1-200, default 50", cursor: "nextCursor of the previous page" },
      body: null, bodyMode: "none", response: "{runs, nextCursor}",
      async handler({ query }) {
        const statusText = queryString(query, "status");
        let statuses: RunStatus[] | undefined;
        if (statusText !== undefined) {
          statuses = statusText.split(",").map((s) => s.trim()).filter((s) => s !== "") as RunStatus[];
          const bad = statuses.filter((s) => !RUN_STATUSES.includes(s));
          if (bad.length > 0 || statuses.length === 0) {
            throw badRequest(`status must be a comma list of ${RUN_STATUSES.join(", ")}`, { parameter: "status" });
          }
        }
        const agentId = queryString(query, "agentId");
        const triggerId = queryString(query, "triggerId");
        const cursor = queryString(query, "cursor");
        const page = await deps.store.listRuns(
          { ...(agentId === undefined ? {} : { agentId }), ...(statuses === undefined ? {} : { statuses }), ...(triggerId === undefined ? {} : { triggerId }) },
          { limit: queryInt(query, "limit", { min: 1, max: 200, fallback: 50 }) as number, ...(cursor === undefined ? {} : { cursor }) },
        );
        return json(200, { runs: page.items, nextCursor: page.nextCursor });
      },
    },
    {
      id: "runs.get", method: "GET", path: "/v1/runs/:id", auth: "bearer", summary: "A run and every one of its open pendings",
      query: {}, body: null, bodyMode: "none", response: "{run, pendings} (all open pendings of the run, oldest first)",
      async handler({ params }) {
        const run = await requireRun(deps.store, param(params, "id"));
        return json(200, { run, pendings: await allOpenPendings(deps, run.id) });
      },
    },
    {
      id: "runs.cancel", method: "POST", path: "/v1/runs/:id/cancel", auth: "bearer", summary: "Cancel a run (applied by a runner)",
      query: {}, bodyMode: "json", response: "202 {command}",
      body: { type: "object", additionalProperties: false, properties: { reason: { type: "string", maxLength: 2000 } } },
      async handler({ params, body }) {
        return queueCommand(deps, param(params, "id"), { type: "cancel", reason: typeof body["reason"] === "string" ? body["reason"] : null });
      },
    },
    {
      id: "runs.pause", method: "POST", path: "/v1/runs/:id/pause", auth: "bearer", summary: "Pause a run at the next step boundary",
      query: {}, body: emptyBody, bodyMode: "json", response: "202 {command}",
      async handler({ params }) {
        return queueCommand(deps, param(params, "id"), { type: "pause" });
      },
    },
    {
      id: "runs.resume", method: "POST", path: "/v1/runs/:id/resume", auth: "bearer", summary: "Resume a paused run",
      query: {}, body: emptyBody, bodyMode: "json", response: "202 {command}",
      async handler({ params }) {
        return queueCommand(deps, param(params, "id"), { type: "resume" });
      },
    },
    {
      id: "runs.message", method: "POST", path: "/v1/runs/:id/messages", auth: "bearer", summary: "Send a message to a run",
      query: {}, bodyMode: "json", response: "202 {command}",
      body: { type: "object", required: ["text"], additionalProperties: false, properties: { text: { type: "string", minLength: 1, maxLength: 1_000_000 } } },
      async handler({ params, body }) {
        return queueCommand(deps, param(params, "id"), { type: "message", text: body["text"] as string });
      },
    },
    {
      id: "runs.limits", method: "POST", path: "/v1/runs/:id/limits", auth: "bearer",
      summary: "Change a run's limits (raise the cap, the tool-call budget or the turn limit; allow unpriced models)",
      query: {}, body: limitsSchema, bodyMode: "json", response: "202 {command}",
      async handler({ params, body }) {
        const limits = toLimits(body) ?? {};
        if (Object.keys(limits).length === 0) {
          throw new RunwrightError("validation_failed", "give at least one of maxCostMicros, maxToolCalls, maxTurns, allowUnpriced", {
            details: { problems: [{ path: "$", keyword: "minProperties", message: "at least one limit is required" }] },
          });
        }
        return queueCommand(deps, param(params, "id"), { type: "limits", limits });
      },
    },
    {
      id: "runs.timeline", method: "GET", path: "/v1/runs/:id/timeline", auth: "bearer", summary: "A page of the run's journal, oldest first",
      query: { after: "seq to start after, default 0", limit: "1-1000, default 500" },
      body: null, bodyMode: "none", response: "{records, nextAfter, archived}",
      async handler({ params, query }) {
        const run = await requireRun(deps.store, param(params, "id"));
        const after = queryInt(query, "after", { min: 0, fallback: 0 }) as number;
        const limit = queryInt(query, "limit", { min: 1, max: 1000, fallback: 500 }) as number;
        const archived = run.journalArchivedAt !== null;
        if (archived) return json(200, { records: [], nextAfter: null, archived });
        const rows = await deps.store.readJournal(run.id, { afterSeq: after, limit: limit + 1 });
        const records = rows.slice(0, limit);
        const last = records[records.length - 1];
        return json(200, { records, nextAfter: rows.length > limit && last !== undefined ? last.seq : null, archived });
      },
    },
    {
      id: "runs.events", method: "GET", path: "/v1/runs/:id/events", auth: "bearer",
      summary: "Live timeline as Server-Sent Events; resumes after Last-Event-ID (or ?after=)",
      query: { after: "seq to start after when no Last-Event-ID header is sent" },
      body: null, bodyMode: "none", response: "text/event-stream: id/event/data per journal record, event: delta, event: end",
      async handler({ req, res, params, query, requestId }) {
        const run = await requireRun(deps.store, param(params, "id"));
        const after = startPosition(req.headers["last-event-id"], queryString(query, "after"));
        await context.sse.subscribe(req, res, requestId, run, after);
        return { kind: "handled" };
      },
    },
    {
      id: "runs.files", method: "GET", path: "/v1/runs/:id/files", auth: "bearer",
      summary: "The files in the run's workspace, ordered by path, a page at a time",
      query: { limit: `1-${FILES_PAGE_MAX}, default ${FILES_PAGE_DEFAULT}`, cursor: "nextCursor of the previous page (base64url of the last path returned)" },
      body: null, bodyMode: "none", response: "{files: [{path, size, modifiedAt}], nextCursor} (nextCursor null on the last page; 400 bad_request for a cursor that does not decode)",
      async handler({ params, query }) {
        const run = await requireRun(deps.store, param(params, "id"));
        const limit = queryInt(query, "limit", { min: 1, max: FILES_PAGE_MAX, fallback: FILES_PAGE_DEFAULT }) as number;
        const cursor = queryString(query, "cursor");
        const after = cursor === undefined ? undefined : decodeFileCursor(cursor);
        let page: Awaited<ReturnType<typeof listWorkspaceFiles>> = { files: [], more: false };
        try {
          page = await listWorkspaceFiles(workspaceOf(deps.config, run.id), { limit, ...(after === undefined ? {} : { after }) });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const last = page.files[page.files.length - 1];
        return json(200, { files: page.files, nextCursor: page.more && last !== undefined ? encodeFileCursor(last.path) : null });
      },
    },
    {
      id: "runs.file", method: "GET", path: "/v1/runs/:id/files/*path", auth: "bearer",
      summary: "One file of the run's workspace, with a safe content type",
      query: {}, body: null, bodyMode: "none", response: "the file's bytes",
      async handler({ res, params, requestId }) {
        const run = await requireRun(deps.store, param(params, "id"));
        const relative = param(params, "path");
        const missing = notFound("file not found");
        let opened: OpenedRegularFile | null;
        try {
          opened = await openRegularFile(await resolveInWorkspace(workspaceOf(deps.config, run.id), relative));
        } catch {
          throw missing;
        }
        if (opened === null) throw missing;
        const { handle, size } = opened;
        try {
          const type = safeContentType(relative);
          baseHeaders(res, requestId);
          res.setHeader("Content-Type", type.contentType);
          res.setHeader("Content-Length", size);
          res.setHeader("Content-Disposition", type.disposition === "inline" ? "inline" : `attachment; filename="${safeFilename(relative)}"`);
          res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
          res.writeHead(200);
        } catch (error) {
          // The error being handled is the one to report; a failed close of the read handle adds nothing.
          await handle.close().catch(() => undefined);
          throw error;
        }
        if (size === 0) {
          // Nothing is read from an empty file, so a failed close of its read handle changes nothing sent.
          await handle.close().catch(() => undefined);
          res.end();
          return { kind: "handled" };
        }
        // The stream reads the handle whose type and size were checked and closes it (autoClose). A file that
        // shrank ends the stream early: the response is then destroyed rather than ended short of its length.
        try {
          await pipeline(handle.createReadStream({ start: 0, end: size - 1 }), exactly(size), res);
        } catch {
          res.destroy();
        }
        return { kind: "handled" };
      },
    },
    {
      id: "runs.learning", method: "GET", path: "/v1/runs/:id/learning", auth: "bearer",
      summary: "The learning items the run was given and which it opened",
      query: {}, body: null, bodyMode: "none", response: "{uses: LearningUse[]}",
      async handler({ params }) {
        const run = await requireRun(deps.store, param(params, "id"));
        return json(200, { uses: await deps.store.learningUses(run.id) });
      },
    },
  ];
}

