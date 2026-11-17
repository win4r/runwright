import { RunwrightError } from "../../core/errors.ts";
import type { Json, JsonObject } from "../../core/json.ts";
import { dryRunWorkflow, type DryRunOptions } from "../../workflow/dryrun.ts";
import { toGraph, toMermaid } from "../../workflow/graph.ts";
import type { WorkflowDocument, WorkflowProblem } from "../../workflow/types.ts";
import { validateWorkflow, type ValidateOptions } from "../../workflow/validate.ts";
import { documentCheckOptions, workflowTools, type ServerContext } from "../context.ts";
import { json, notFound, param, queryInt } from "../http.ts";
import type { Route } from "../router.ts";

const documentBody = { required: ["document"], properties: { document: { type: "object", description: "runwright.workflow/v1 document" } } };
/** The body member that checks a document as an agent's embedded workflow (as agent saving does) instead of as a saved one. */
const embeddedProperty = {
  type: "boolean",
  description: "true: check the document as an agent's embedded workflow (no call resolves to it by its name); default false: as the saved workflow of its name",
};

function isEmbedded(body: JsonObject): boolean {
  return body["embedded"] === true;
}
const WORKFLOW_NAME = "^[a-z][a-z0-9_-]{0,63}$";

/** Returns when the validation found no error; otherwise throws 422 workflow_invalid with every problem. */
function assertValid(result: ReturnType<typeof validateWorkflow>): void {
  const errors = result.problems.filter((p: WorkflowProblem) => p.severity === "error");
  if (errors.length > 0) {
    throw new RunwrightError("workflow_invalid", `the workflow document is invalid: ${errors.slice(0, 5).map((p) => `${p.path}: ${p.message}`).join("; ")}`, {
      status: 422,
      details: { problems: result.problems as unknown as Json },
    });
  }
}

/**
 * Validates a document that is not being saved with `options` (`documentCheckOptions`: as an embedded workflow
 * `savedAs` is null; otherwise it is left absent, contract C4, and the document is checked as the name it carries);
 * returns it typed or throws 422.
 */
function validDocument(document: Json | undefined, options: ValidateOptions): WorkflowDocument {
  assertValid(validateWorkflow(document, options));
  return document as unknown as WorkflowDocument;
}

function graphOf(document: WorkflowDocument): { graph: ReturnType<typeof toGraph>; mermaid: string } {
  const graph = toGraph(document);
  return { graph, mermaid: toMermaid(graph) };
}

export function workflowRoutes(context: ServerContext): Route[] {
  const { deps } = context;
  return [
    {
      id: "workflows.validate", method: "POST", path: "/v1/workflows/validate", auth: "bearer",
      summary: "Validate a workflow document (embedded: true checks it as an agent's embedded workflow); every problem has a JSON path (200 even when invalid)",
      query: {}, bodyMode: "json", response: "{ok, problems}",
      body: { type: "object", additionalProperties: false, required: ["document"], properties: { document: {}, embedded: embeddedProperty } },
      async handler({ body }) {
        const result = validateWorkflow(body["document"], await documentCheckOptions(deps, isEmbedded(body)));
        return json(200, { ok: result.ok, problems: result.problems });
      },
    },
    {
      id: "workflows.dryRun", method: "POST", path: "/v1/workflows/dry-run", auth: "bearer",
      summary: "Walk a workflow's control flow with placeholder values (embedded: true as an agent's embedded workflow); no model or tool is called",
      query: {}, bodyMode: "json", response: "{report: DryRunReport} (422 with problems if invalid)",
      body: {
        type: "object", additionalProperties: false, required: ["document"],
        properties: {
          document: documentBody.properties.document,
          embedded: embeddedProperty,
          input: {},
          decisions: {
            type: "object",
            additionalProperties: {
              type: "object", required: ["value", "confidence"], additionalProperties: false,
              properties: { value: { type: ["boolean", "string", "number"] }, confidence: { type: "number", minimum: 0, maximum: 1 } },
            },
          },
        },
      },
      async handler({ body }) {
        const checks = await documentCheckOptions(deps, isEmbedded(body));
        const document = validDocument(body["document"], checks);
        // The dry run validates again before it walks: with the same identity, or it would see a different document.
        const options: DryRunOptions = { resolveWorkflow: checks.resolveWorkflow, ...(checks.savedAs === undefined ? {} : { savedAs: checks.savedAs }) };
        if (body["input"] !== undefined) options.input = body["input"];
        if (body["decisions"] !== undefined) options.decisions = body["decisions"] as unknown as NonNullable<DryRunOptions["decisions"]>;
        return json(200, { report: dryRunWorkflow(document, options) });
      },
    },
    {
      id: "workflows.graph", method: "POST", path: "/v1/workflows/graph", auth: "bearer",
      summary: "A workflow document as a graph (nodes and edges) and as Mermaid text (embedded: true checks it as an agent's embedded workflow)",
      query: {}, bodyMode: "json", response: "{graph, mermaid} (422 with problems if invalid)",
      body: { type: "object", additionalProperties: false, required: documentBody.required, properties: { ...documentBody.properties, embedded: embeddedProperty } },
      async handler({ body }) {
        return json(200, graphOf(validDocument(body["document"], await documentCheckOptions(deps, isEmbedded(body)))));
      },
    },
    {
      id: "workflows.list", method: "GET", path: "/v1/workflows", auth: "bearer", summary: "Saved workflows (latest version of each)",
      query: {}, body: null, bodyMode: "none", response: "{workflows: [{name, version, source, createdAt}]}",
      async handler() {
        const workflows = (await deps.store.listWorkflows()).map((w) => ({ name: w.name, version: w.version, source: w.source, createdAt: w.createdAt }));
        return json(200, { workflows });
      },
    },
    {
      id: "workflows.put", method: "PUT", path: "/v1/workflows/:name", auth: "bearer",
      summary: "Save a workflow under a name; a changed document becomes a new version",
      query: {}, bodyMode: "json",
      response: "201 or 200 {workflow, created} (422 with problems if invalid; 409 conflict, reason promoted_workflow, if the name belongs to a learned skill)",
      body: { type: "object", additionalProperties: false, ...documentBody },
      async handler({ params, body }) {
        const name = param(params, "name");
        if (!new RegExp(WORKFLOW_NAME).test(name)) {
          throw new RunwrightError("validation_failed", `a workflow name matches ${WORKFLOW_NAME}`, {
            details: { problems: [{ path: "$.name", keyword: "pattern", message: `a workflow name matches ${WORKFLOW_NAME}` }] },
          });
        }
        const candidate = body["document"];
        const tools = workflowTools(deps);
        const saved = await deps.store.saveWorkflow({
          name,
          document: candidate as unknown as WorkflowDocument,
          source: "api",
          check: (resolve) => assertValid(validateWorkflow(candidate, { tools, resolveWorkflow: resolve, savedAs: name })),
        });
        return json(saved.created ? 201 : 200, saved);
      },
    },
    {
      id: "workflows.get", method: "GET", path: "/v1/workflows/:name", auth: "bearer", summary: "A saved workflow (latest, or ?version=)",
      query: { version: "version number, default latest" }, body: null, bodyMode: "none", response: "{workflow}",
      async handler({ params, query }) {
        const name = param(params, "name");
        const version = queryInt(query, "version", { min: 1 });
        const workflow = await deps.store.getWorkflow(name, version);
        if (workflow === null) throw notFound(`workflow ${name}${version === undefined ? "" : ` version ${version}`} not found`);
        return json(200, { workflow });
      },
    },
    {
      id: "workflows.savedGraph", method: "GET", path: "/v1/workflows/:name/graph", auth: "bearer",
      summary: "A saved workflow as a graph and as Mermaid text",
      query: {}, body: null, bodyMode: "none", response: "{graph, mermaid}",
      async handler({ params }) {
        const name = param(params, "name");
        const workflow = await deps.store.getWorkflow(name);
        if (workflow === null) throw notFound(`workflow ${name} not found`);
        return json(200, graphOf(workflow.document));
      },
    },
  ];
}

