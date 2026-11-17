import { RunwrightError } from "../../core/errors.ts";
import type { AgentDefinition } from "../../agents/definition.ts";
import { findHiddenCharacters, formatCodePoint, scanForSecrets } from "../../learning/secret-scan.ts";
import { createWriteRedaction, type WriteRedaction } from "../../security/write-redaction.ts";
import type { LearningChange, LearningItem, LearningKind, LearningStatus } from "../../store/types.ts";
import { etagHeader, ifMatch, type ServerContext, type ServerDeps } from "../context.ts";
import { json, notFound, param, queryEnum, queryString } from "../http.ts";
import type { RequestContext, Reply, Route } from "../router.ts";

const STATUSES: readonly LearningStatus[] = ["active", "held", "retired"];
const KINDS: readonly LearningKind[] = ["note", "skill"];
/** What the API description says about a person's text that is refused (see checkPersonText). */
const REFUSED_TEXT = "400 validation_failed when a field or the note holds a stored secret, a credential-shaped string or a hidden character";
const ITEM_FIELDS = "a promoted skill has promotedWorkflow and promotedWorkflowVersion (both null otherwise)";
const noteBody = { type: "object", additionalProperties: false, properties: { note: { type: "string", maxLength: 2000 } } };

async function requireItem(deps: ServerDeps, id: string): Promise<LearningItem> {
  const item = await deps.store.getLearningItem(id);
  if (item === null) throw notFound(`learning item ${id} not found`);
  return item;
}

type CheckedField = "title" | "description" | "body" | "note";
interface TextProblem { path: string; keyword: "secret" | "hidden_character"; message: string }

/** The first problem of one field's text, or null. The message names the field and the kind, never the text. */
async function fieldProblem(
  redaction: WriteRedaction, field: CheckedField, value: string, definition: AgentDefinition | undefined,
): Promise<TextProblem | null> {
  const path = `$.${field}`;
  if ((await redaction.text(value, definition)) !== value) {
    return { path, keyword: "secret", message: `a stored secret was found in ${field}` };
  }
  const label = scanForSecrets(value);
  if (label !== null) return { path, keyword: "secret", message: `${label} was found in ${field}` };
  const hidden = findHiddenCharacters(value);
  if (hidden.length > 0) {
    return {
      path, keyword: "hidden_character",
      message: `a hidden or bidirectional-control character (${hidden.map(formatCodePoint).join(", ")}) was found in ${field}`,
    };
  }
  return null;
}

/**
 * Refuses a person's text that would carry a secret or a hidden character into what later runs read: a stored
 * secret (the item's agent's named secrets are re-read first), a credential-shaped string, or a hidden or
 * bidirectional-control character. Nothing is stored when it throws.
 */
async function checkPersonText(deps: ServerDeps, redaction: WriteRedaction, itemId: string, change: LearningChange): Promise<void> {
  const fields: [CheckedField, string][] = [];
  for (const key of ["title", "description", "body"] as const) {
    const value = change.patch?.[key];
    if (typeof value === "string") fields.push([key, value]);
  }
  if (typeof change.note === "string") fields.push(["note", change.note]);
  if (fields.length === 0) return;
  const item = await requireItem(deps, itemId);
  const definition = (await deps.store.getRevision(item.agentId))?.definition;
  for (const [field, value] of fields) {
    const problem = await fieldProblem(redaction, field, value, definition);
    if (problem !== null) {
      throw new RunwrightError("validation_failed", problem.message, { details: { problems: [{ ...problem }] } });
    }
  }
}

async function change(deps: ServerDeps, redaction: WriteRedaction, request: RequestContext, action: LearningChange["action"]): Promise<Reply> {
  const expectedEtag = ifMatch(request.req.headers["if-match"]);
  const id = param(request.params, "id");
  const body = request.body;
  const input: LearningChange = { expectedEtag, action, actor: "person" };
  if (typeof body["note"] === "string") input.note = body["note"];
  if (action === "edit") {
    const patch: NonNullable<LearningChange["patch"]> = {};
    for (const key of ["title", "description", "body"] as const) {
      const value = body[key];
      if (typeof value === "string") patch[key] = value;
    }
    if (Object.keys(patch).length === 0) {
      throw new RunwrightError("validation_failed", "give at least one of title, description, body", {
        details: { problems: [{ path: "$", keyword: "minProperties", message: "at least one field is required" }] },
      });
    }
    input.patch = patch;
  }
  await checkPersonText(deps, redaction, id, input);
  const item = await deps.store.changeLearningItem(id, input);
  return json(200, { item }, etagHeader(item.etag));
}

export function learningRoutes(context: ServerContext): Route[] {
  const { deps } = context;
  const redaction = createWriteRedaction(deps.secrets);
  const changeRoute = (action: "retire" | "restore" | "approve", summary: string): Route => ({
    id: `learning.${action}`, method: "POST", path: `/v1/learning/:id/${action}`, auth: "bearer", summary,
    query: {}, body: noteBody, bodyMode: "json", response: `{item} + ETag (If-Match required; ${REFUSED_TEXT})`,
    handler: (request) => change(deps, redaction, request, action),
  });
  return [
    {
      id: "learning.list", method: "GET", path: "/v1/learning", auth: "bearer", summary: "Learned notes and skills",
      query: { agentId: "agent id", status: STATUSES.join("|"), kind: KINDS.join("|") },
      body: null, bodyMode: "none", response: `{items}; ${ITEM_FIELDS}`,
      async handler({ query }) {
        const agentId = queryString(query, "agentId");
        const status = queryEnum(query, "status", STATUSES);
        const kind = queryEnum(query, "kind", KINDS);
        const items = await deps.store.listLearningItems({
          ...(agentId === undefined ? {} : { agentId }), ...(status === undefined ? {} : { status }), ...(kind === undefined ? {} : { kind }),
        });
        return json(200, { items });
      },
    },
    {
      id: "learning.get", method: "GET", path: "/v1/learning/:id", auth: "bearer", summary: "One learning item; its ETag is in the header",
      query: {}, body: null, bodyMode: "none", response: `{item} + ETag; ${ITEM_FIELDS}`,
      async handler({ params }) {
        const item = await requireItem(deps, param(params, "id"));
        return json(200, { item }, etagHeader(item.etag));
      },
    },
    {
      id: "learning.history", method: "GET", path: "/v1/learning/:id/history", auth: "bearer", summary: "Every recorded change of an item, oldest first",
      query: {}, body: null, bodyMode: "none", response: "{history}",
      async handler({ params }) {
        const item = await requireItem(deps, param(params, "id"));
        return json(200, { history: await deps.store.learningHistory(item.id) });
      },
    },
    changeRoute("retire", "Retire an item so later runs no longer get it"),
    changeRoute("restore", "Restore a retired item"),
    changeRoute("approve", "Approve an item the grader held for a person"),
    {
      id: "learning.edit", method: "PATCH", path: "/v1/learning/:id", auth: "bearer", summary: "Edit an item's title, description or body",
      query: {}, bodyMode: "json", response: `{item} + ETag (If-Match required; ${REFUSED_TEXT})`,
      body: {
        type: "object", additionalProperties: false,
        properties: {
          title: { type: "string", minLength: 1, maxLength: 200 },
          description: { type: "string", maxLength: 500 },
          body: { type: "string", maxLength: 100_000 },
          note: { type: "string", maxLength: 2000 },
        },
      },
      handler: (request) => change(deps, redaction, request, "edit"),
    },
  ];
}
