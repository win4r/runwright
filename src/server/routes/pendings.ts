import { RunwrightError } from "../../core/errors.ts";
import type { PendingKind, PendingRecord, RunCommand } from "../../store/types.ts";
import type { ServerContext, ServerDeps } from "../context.ts";
import { json, notFound, param, queryEnum, queryInt, queryString } from "../http.ts";
import type { Reply, Route } from "../router.ts";
import { queueCommand } from "./runs.ts";

export const PENDING_KINDS: readonly PendingKind[] = Object.freeze([
  "question", "approval", "spend_cap", "tool_budget", "turn_limit", "interrupted",
] as const);

async function requirePending(deps: ServerDeps, id: string): Promise<PendingRecord> {
  const pending = await deps.store.getPending(id);
  if (pending === null) throw notFound(`pending ${id} not found`);
  return pending;
}

/** An instant as ISO 8601 text; a finite number outside the range a Date holds is written as milliseconds. */
function instantText(at: number): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? `${at} ms since the epoch` : date.toISOString();
}

/**
 * Checks that the pending is open, of the kind the route answers and not past its `detail.expiresAt` (the instant
 * of an enclosing node deadline), then queues the command on its run. The expiry check is the early, readable
 * answer only: the run's own rule is the authority, so a command that is created at or after the instant (one
 * that slips in between this check and the enqueue) is still rejected in the run's journal (`command.rejected`).
 */
async function answerPending(deps: ServerDeps, id: string, kind: PendingKind, command: (pending: PendingRecord) => RunCommand): Promise<Reply> {
  const pending = await requirePending(deps, id);
  if (pending.status !== "open" || pending.kind !== kind) {
    throw new RunwrightError(
      "pending_not_open",
      pending.status !== "open" ? `pending ${id} is already resolved` : `pending ${id} is a ${pending.kind}, not a ${kind}`,
      { details: { pendingId: id, status: pending.status, kind: pending.kind } },
    );
  }
  const expiresAt = pending.detail["expiresAt"];
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && deps.clock.now() >= expiresAt) {
    throw new RunwrightError("pending_not_open", `pending ${id} expired at ${instantText(expiresAt)}`, {
      details: { pendingId: id, status: pending.status, kind: pending.kind, expiresAt },
    });
  }
  return queueCommand(deps, pending.runId, command(pending));
}

export function pendingRoutes(context: ServerContext): Route[] {
  const { deps } = context;
  return [
    {
      id: "pendings.list", method: "GET", path: "/v1/pendings", auth: "bearer",
      summary: "What needs you: questions, approvals, cap and budget pauses, interrupted calls (oldest first)",
      query: { status: "open|resolved, default open", runId: "run id", agentId: "agent id", kind: PENDING_KINDS.join("|"), limit: "1-200, default 50", cursor: "nextCursor of the previous page" },
      body: null, bodyMode: "none", response: "{pendings, nextCursor}",
      async handler({ query }) {
        const status = queryEnum(query, "status", ["open", "resolved"] as const) ?? "open";
        const kind = queryEnum(query, "kind", PENDING_KINDS);
        const runId = queryString(query, "runId");
        const agentId = queryString(query, "agentId");
        const cursor = queryString(query, "cursor");
        const page = await deps.store.listPendings(
          { status, ...(kind === undefined ? {} : { kind }), ...(runId === undefined ? {} : { runId }), ...(agentId === undefined ? {} : { agentId }) },
          { limit: queryInt(query, "limit", { min: 1, max: 200, fallback: 50 }) as number, ...(cursor === undefined ? {} : { cursor }) },
        );
        return json(200, { pendings: page.items, nextCursor: page.nextCursor });
      },
    },
    {
      id: "pendings.get", method: "GET", path: "/v1/pendings/:id", auth: "bearer", summary: "One pending",
      query: {}, body: null, bodyMode: "none", response: "{pending}",
      async handler({ params }) {
        return json(200, { pending: await requirePending(deps, param(params, "id")) });
      },
    },
    {
      id: "pendings.answer", method: "POST", path: "/v1/pendings/:id/answer", auth: "bearer", summary: "Answer an open question that has not expired",
      query: {}, bodyMode: "json", response: "202 {command}",
      body: { type: "object", required: ["answer"], additionalProperties: false, properties: { answer: { type: "string", maxLength: 1_000_000 } } },
      async handler({ params, body }) {
        return answerPending(deps, param(params, "id"), "question", (p) => ({ type: "answer", pendingId: p.id, answer: body["answer"] as string }));
      },
    },
    {
      id: "pendings.approve", method: "POST", path: "/v1/pendings/:id/approve", auth: "bearer",
      summary: "Approve a tool call that waits for approval and has not expired (always: also approve the tool's other open approvals in the run and its later calls)",
      query: {}, bodyMode: "json", response: "202 {command}",
      body: { type: "object", additionalProperties: false, properties: { always: { type: "boolean" } } },
      async handler({ params, body }) {
        return answerPending(deps, param(params, "id"), "approval", (p) => ({ type: "approve", pendingId: p.id, always: body["always"] === true }));
      },
    },
    {
      id: "pendings.deny", method: "POST", path: "/v1/pendings/:id/deny", auth: "bearer",
      summary: "Deny a tool call that waits for approval and has not expired; the reason is returned to the model as the tool result",
      query: {}, bodyMode: "json", response: "202 {command}",
      body: { type: "object", additionalProperties: false, properties: { reason: { type: "string", maxLength: 2000 } } },
      async handler({ params, body }) {
        return answerPending(deps, param(params, "id"), "approval", (p) => ({
          type: "deny", pendingId: p.id, reason: typeof body["reason"] === "string" ? body["reason"] : null,
        }));
      },
    },
    {
      id: "pendings.resolve", method: "POST", path: "/v1/pendings/:id/resolve", auth: "bearer",
      summary: "Decide an open interrupted tool call that has not expired: retry it, skip it with a supplied result, or cancel the run",
      query: {}, bodyMode: "json", response: "202 {command}",
      body: {
        type: "object", required: ["action"], additionalProperties: false,
        properties: { action: { enum: ["retry", "skip", "cancel"] }, result: { type: "string", maxLength: 1_000_000 } },
      },
      async handler({ params, body }) {
        return answerPending(deps, param(params, "id"), "interrupted", (p) => ({
          type: "resolve_interrupted", pendingId: p.id, action: body["action"] as "retry" | "skip" | "cancel",
          result: typeof body["result"] === "string" ? body["result"] : null,
        }));
      },
    },
  ];
}
