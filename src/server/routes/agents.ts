import { RunwrightError } from "../../core/errors.ts";
import type { Json, JsonObject } from "../../core/json.ts";
import { AGENT_ID_PATTERN, validateAgentDefinition, type AgentDefinition } from "../../agents/definition.ts";
import { validateWorkflow } from "../../workflow/validate.ts";
import type { AgentRecord } from "../../store/types.ts";
import { embeddedWorkflowOptions, type ServerContext, type ServerDeps } from "../context.ts";
import { json, notFound, param, paramInt, problemsUnder } from "../http.ts";
import type { Route } from "../router.ts";

/** Tools the host adds per run rather than through the registry. */
const IMPLICIT_TOOLS = new Set(["recall", "run_workflow"]);

const definitionBody = { type: "object", description: "AgentDefinition (validated in full by the handler)" };

function invalid(message: string, problems: Json): RunwrightError {
  return new RunwrightError("validation_failed", message, { details: { problems } });
}

/** Full check of a definition: shape, registered tools, embedded workflow. Problem paths start at `$.definition`. */
async function checkDefinition(deps: ServerDeps, value: JsonObject): Promise<AgentDefinition> {
  const shape = validateAgentDefinition(value);
  if (shape.length > 0) {
    throw invalid(`invalid agent definition: ${shape.slice(0, 5).map((p) => `${p.path}: ${p.message}`).join("; ")}`, problemsUnder("$.definition", shape));
  }
  const definition = value as unknown as AgentDefinition;
  const unknown = definition.tools
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => deps.tools.get(entry.name) === null && !IMPLICIT_TOOLS.has(entry.name));
  if (unknown.length > 0) {
    throw invalid(
      `unknown tool(s): ${unknown.map(({ entry }) => entry.name).join(", ")}`,
      unknown.map(({ entry, index }) => ({
        path: `$.definition.tools[${index}].name`, keyword: "tool", message: `no tool named ${JSON.stringify(entry.name)} is registered`,
      })),
    );
  }
  if (definition.workflow !== undefined) {
    // An embedded workflow is not a saved workflow (C4): no `call` resolves to it by its own `name`.
    const result = validateWorkflow(definition.workflow, await embeddedWorkflowOptions(deps));
    const errors = result.problems.filter((p) => p.severity === "error");
    if (errors.length > 0) {
      throw invalid(
        `the embedded workflow is invalid: ${errors.slice(0, 5).map((p) => `${p.path}: ${p.message}`).join("; ")}`,
        problemsUnder("$.definition.workflow", errors),
      );
    }
  }
  return definition;
}

async function requireAgent(deps: ServerDeps, id: string): Promise<AgentRecord> {
  const agent = await deps.store.getAgent(id);
  if (agent === null) throw notFound(`agent ${id} not found`);
  return agent;
}

export function agentRoutes(context: ServerContext): Route[] {
  const { deps } = context;
  return [
    {
      id: "agents.list", method: "GET", path: "/v1/agents", auth: "bearer", summary: "List agents with their current definitions",
      query: {}, body: null, bodyMode: "none", response: "{agents: [{agent, definition}]}",
      async handler() {
        const agents = [];
        for (const agent of await deps.store.listAgents()) {
          const revision = await deps.store.getRevision(agent.id);
          if (revision !== null) agents.push({ agent, definition: revision.definition });
        }
        return json(200, { agents });
      },
    },
    {
      id: "agents.create", method: "POST", path: "/v1/agents", auth: "bearer",
      summary: "Save an agent definition (the id is derived from the name when absent); a change creates a revision",
      query: {}, bodyMode: "json", response: "201 or 200 {agent, revision, created}",
      body: {
        type: "object", required: ["definition"], additionalProperties: false,
        properties: { id: { type: "string", pattern: AGENT_ID_PATTERN.source }, definition: definitionBody },
      },
      async handler({ body }) {
        const definition = await checkDefinition(deps, body["definition"] as JsonObject);
        const id = body["id"];
        const saved = await deps.store.saveAgent(typeof id === "string" ? { id, definition } : { definition });
        return json(saved.created ? 201 : 200, saved);
      },
    },
    {
      id: "agents.put", method: "PUT", path: "/v1/agents/:id", auth: "bearer",
      summary: "Create or update the agent with this id; a change creates a revision",
      query: {}, bodyMode: "json", response: "201 or 200 {agent, revision, created}",
      body: { type: "object", required: ["definition"], additionalProperties: false, properties: { definition: definitionBody } },
      async handler({ params, body }) {
        const id = param(params, "id");
        if (!AGENT_ID_PATTERN.test(id)) {
          throw invalid("invalid agent id", [{ path: "$.id", keyword: "pattern", message: `an agent id matches ${AGENT_ID_PATTERN.source}` }]);
        }
        const definition = await checkDefinition(deps, body["definition"] as JsonObject);
        const saved = await deps.store.saveAgent({ id, definition });
        return json(saved.created ? 201 : 200, saved);
      },
    },
    {
      id: "agents.get", method: "GET", path: "/v1/agents/:id", auth: "bearer", summary: "An agent and its current revision",
      query: {}, body: null, bodyMode: "none", response: "{agent, revision}",
      async handler({ params }) {
        const agent = await requireAgent(deps, param(params, "id"));
        const revision = await deps.store.getRevision(agent.id);
        if (revision === null) throw notFound(`agent ${agent.id} has no revision`);
        return json(200, { agent, revision });
      },
    },
    {
      id: "agents.revisions", method: "GET", path: "/v1/agents/:id/revisions", auth: "bearer", summary: "An agent's revisions, newest first",
      query: {}, body: null, bodyMode: "none", response: "{revisions}",
      async handler({ params }) {
        const agent = await requireAgent(deps, param(params, "id"));
        return json(200, { revisions: await deps.store.listRevisions(agent.id) });
      },
    },
    {
      id: "agents.revision", method: "GET", path: "/v1/agents/:id/revisions/:n", auth: "bearer", summary: "One revision of an agent",
      query: {}, body: null, bodyMode: "none", response: "{revision}",
      async handler({ params }) {
        const agent = await requireAgent(deps, param(params, "id"));
        const n = paramInt(params, "n");
        const revision = await deps.store.getRevision(agent.id, n);
        if (revision === null) throw notFound(`agent ${agent.id} has no revision ${n}`);
        return json(200, { revision });
      },
    },
    {
      id: "agents.learningMetrics", method: "GET", path: "/v1/agents/:id/learning/metrics", auth: "bearer",
      summary: "Cost, tokens and duration of the agent's runs before and after learning",
      query: {}, body: null, bodyMode: "none", response: "{metrics: LearningMetrics}",
      async handler({ params }) {
        const agent = await requireAgent(deps, param(params, "id"));
        return json(200, { metrics: await deps.store.learningMetrics(agent.id) });
      },
    },
  ];
}
