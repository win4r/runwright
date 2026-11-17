import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestServer } from "./support.ts";

/** The table of plan 3.14: the API description must list exactly these. */
const EXPECTED = [
  "GET /", "GET /v1/health", "GET /v1/ready", "GET /v1/api",
  "GET /v1/agents", "POST /v1/agents", "PUT /v1/agents/:id", "GET /v1/agents/:id", "GET /v1/agents/:id/revisions",
  "GET /v1/agents/:id/revisions/:n", "GET /v1/agents/:id/learning/metrics",
  "POST /v1/runs", "GET /v1/runs", "GET /v1/runs/:id", "POST /v1/runs/:id/cancel", "POST /v1/runs/:id/pause",
  "POST /v1/runs/:id/resume", "POST /v1/runs/:id/messages", "POST /v1/runs/:id/limits", "GET /v1/runs/:id/timeline",
  "GET /v1/runs/:id/events", "GET /v1/runs/:id/files", "GET /v1/runs/:id/files/*path", "GET /v1/runs/:id/learning",
  "GET /v1/pendings", "GET /v1/pendings/:id", "POST /v1/pendings/:id/answer", "POST /v1/pendings/:id/approve",
  "POST /v1/pendings/:id/deny", "POST /v1/pendings/:id/resolve",
  "POST /v1/workflows/validate", "POST /v1/workflows/dry-run", "POST /v1/workflows/graph", "GET /v1/workflows",
  "PUT /v1/workflows/:name", "GET /v1/workflows/:name", "GET /v1/workflows/:name/graph",
  "GET /v1/learning", "GET /v1/learning/:id", "GET /v1/learning/:id/history", "POST /v1/learning/:id/retire",
  "POST /v1/learning/:id/restore", "POST /v1/learning/:id/approve", "PATCH /v1/learning/:id",
  "GET /v1/triggers", "POST /v1/triggers", "GET /v1/triggers/:id", "PATCH /v1/triggers/:id", "DELETE /v1/triggers/:id",
  "POST /v1/triggers/:id/fire", "POST /v1/hooks/:id",
  "GET /v1/secrets", "GET /v1/secrets/:name", "PUT /v1/secrets/:name", "DELETE /v1/secrets/:name",
  "GET /v1/usage",
];

test("GET /v1/api lists every route with a method, path, auth and summary, and nothing else", async (t) => {
  const s = await startTestServer(t);
  const description = await s.client.describeApi();
  assert.equal(description.name, "runwright");
  assert.equal(description.version, "v1");
  const listed = description.operations.map((op) => `${op.method} ${op.path}`);
  assert.deepEqual([...listed].sort(), [...EXPECTED].sort());
  const ids = new Set<string>();
  for (const op of description.operations) {
    assert.ok(op.id.length > 0 && !ids.has(op.id), `id ${op.id}`);
    ids.add(op.id);
    assert.ok(["GET", "POST", "PUT", "PATCH", "DELETE"].includes(op.method));
    assert.ok(["bearer", "none", "signature"].includes(op.auth));
    assert.ok(op.summary.length > 5, `${op.id} summary`);
    assert.ok(op.response.length > 0, `${op.id} response`);
    assert.equal(typeof op.query, "object");
    if (op.method === "GET" || op.method === "DELETE") assert.equal(op.body, null, `${op.id} body`);
    assert.deepEqual(Object.keys(op).sort(), ["auth", "body", "id", "method", "path", "query", "response", "summary"]);
  }
});

test("every described operation is served (none answers 404 for its own path)", async (t) => {
  const s = await startTestServer(t);
  const description = await s.client.describeApi();
  for (const op of description.operations) {
    const path = op.path.replace(/:[a-zA-Z]+/g, "x1").replace(/\*[a-zA-Z]+/, "a.txt");
    const init: RequestInit = { method: op.method, headers: { Authorization: `Bearer ${s.token}` } };
    if (op.method !== "GET" && op.method !== "DELETE") {
      (init.headers as Record<string, string>)["Content-Type"] = "application/json";
      init.body = "{}";
    }
    if (op.path === "/v1/runs/:id/events") continue;
    const response = await fetch(`${s.url}${path}`, init);
    const text = await response.text();
    if (response.status === 404) {
      assert.notEqual(JSON.parse(text).error.message.startsWith("no route"), true, `${op.method} ${op.path} is not routed`);
    }
  }
});

test("the description states the round-3 refusals and the versioned promotion pointer", async (t) => {
  const s = await startTestServer(t);
  const byRoute = new Map((await s.client.describeApi()).operations.map((op) => [`${op.method} ${op.path}`, op.response]));
  assert.match(byRoute.get("PUT /v1/workflows/:name") ?? "", /409 conflict, reason promoted_workflow/);
  for (const route of ["PATCH /v1/learning/:id", "POST /v1/learning/:id/retire", "POST /v1/learning/:id/restore", "POST /v1/learning/:id/approve"]) {
    assert.match(byRoute.get(route) ?? "", /400 validation_failed when a field or the note holds a stored secret/, route);
  }
  for (const route of ["GET /v1/learning", "GET /v1/learning/:id"]) {
    assert.match(byRoute.get(route) ?? "", /promotedWorkflow and promotedWorkflowVersion/, route);
  }
});
