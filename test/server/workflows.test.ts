import { test } from "node:test";
import assert from "node:assert/strict";
import type { Json } from "../../src/core/json.ts";
import { validateWorkflow } from "../../src/workflow/validate.ts";
import { authed, errorOf, startTestServer, testAgentDefinition } from "./support.ts";

function reader(tool = "read_file"): Json {
  return {
    format: "runwright.workflow/v1",
    name: "reader",
    schemas: { in: { type: "object", required: ["path"], properties: { path: { type: "string" } } }, out: { type: "string" } },
    input: "in",
    output: "out",
    root: { id: "read", kind: "tool", tool, args: { path: { $ref: "input.path" } } },
    result: { $ref: "steps.read.content" },
  };
}

test("validate answers 200 with the problems even for an invalid document", async (t) => {
  const s = await startTestServer(t);
  const good = await s.client.validateWorkflow(reader());
  assert.equal(good.ok, true);
  const bad = await s.client.validateWorkflow(reader("not_a_tool"));
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.length > 0);
  assert.ok(bad.problems.every((p) => p.path.startsWith("$")));
  const notEvenAnObject = await authed(s, "/v1/workflows/validate", { method: "POST", json: { document: 42 } });
  assert.equal(notEvenAnObject.status, 200);
  assert.equal(((await notEvenAnObject.json()) as { ok: boolean }).ok, false);
});

test("dry-run reports what would be called; an invalid document is 422 with problems", async (t) => {
  const s = await startTestServer(t);
  const report = await s.client.dryRunWorkflow(reader(), { input: { path: "a.txt" } });
  assert.equal(report.ok, true);
  assert.deepEqual(report.wouldCall.map((c) => [c.type, c.name]), [["tool", "read_file"]]);
  const invalid = await errorOf(await authed(s, "/v1/workflows/dry-run", { method: "POST", json: { document: reader("nope") } }));
  assert.equal(invalid.status, 422);
  assert.equal(invalid.code, "workflow_invalid");
  assert.ok((invalid.details?.["problems"] as unknown[]).length > 0);
  const badDecisions = await errorOf(await authed(s, "/v1/workflows/dry-run", {
    method: "POST", json: { document: reader(), decisions: { x: { value: true, confidence: 7 } } },
  }));
  assert.equal(badDecisions.code, "validation_failed");
});

test("graph returns nodes, edges and Mermaid text; invalid is 422", async (t) => {
  const s = await startTestServer(t);
  const { graph, mermaid } = await s.client.graphWorkflow(reader());
  assert.ok(graph.nodes.some((n) => n.id === "read"));
  assert.match(mermaid, /read/);
  const invalid = await authed(s, "/v1/workflows/graph", { method: "POST", json: { document: reader("nope") } });
  assert.equal(invalid.status, 422);
  await invalid.body?.cancel();
});

test("saved workflows: put validates, versions on change, list, get and graph", async (t) => {
  const s = await startTestServer(t);
  const invalid = await errorOf(await authed(s, "/v1/workflows/reader", { method: "PUT", json: { document: reader("nope") } }));
  assert.equal(invalid.status, 422);
  const badName = await errorOf(await authed(s, "/v1/workflows/Bad%20Name", { method: "PUT", json: { document: reader() } }));
  assert.equal(badName.code, "validation_failed");

  const first = await authed(s, "/v1/workflows/reader", { method: "PUT", json: { document: reader() } });
  assert.equal(first.status, 201);
  const same = await s.client.saveWorkflow("reader", reader());
  assert.equal(same.created, false);
  assert.equal(same.workflow.version, 1);
  assert.equal(same.workflow.source, "api");
  const changed = { ...(reader() as Record<string, Json>), description: "v2" };
  assert.equal((await s.client.saveWorkflow("reader", changed)).workflow.version, 2);

  const list = await s.client.listWorkflows();
  assert.equal(list.length, 1);
  assert.deepEqual(Object.keys(list[0] ?? {}).sort(), ["createdAt", "name", "source", "version"]);
  assert.equal(list[0]?.version, 2);
  assert.equal((await s.client.getWorkflow("reader")).version, 2);
  assert.equal((await s.client.getWorkflow("reader", 1)).document.description, undefined);
  assert.equal((await errorOf(await authed(s, "/v1/workflows/reader?version=9"))).status, 404);
  assert.equal((await errorOf(await authed(s, "/v1/workflows/ghost"))).status, 404);
  const saved = await s.client.savedWorkflowGraph("reader");
  assert.ok(saved.graph.nodes.length > 0);
  assert.equal((await errorOf(await authed(s, "/v1/workflows/ghost/graph"))).status, 404);
});

test("a call to a saved workflow validates against the saved one", async (t) => {
  const s = await startTestServer(t);
  await s.client.saveWorkflow("reader", reader());
  const caller: Json = {
    format: "runwright.workflow/v1",
    name: "caller",
    schemas: { in: { type: "object", required: ["path"], properties: { path: { type: "string" } } }, out: { type: "string" } },
    input: "in",
    output: "out",
    root: { id: "sub", kind: "call", workflow: "reader", input: { path: { $ref: "input.path" } } },
    result: { $ref: "steps.sub" },
  };
  const result = await s.client.validateWorkflow(caller);
  assert.deepEqual(result.problems.filter((p) => p.severity === "error"), []);
  const missing = await s.client.validateWorkflow({ ...(caller as Record<string, Json>), root: { id: "sub", kind: "call", workflow: "ghost", input: {} } });
  assert.equal(missing.ok, false);
});

test("PUT on a name a learned skill owns is 409 conflict and adds no version", async (t) => {
  const s = await startTestServer(t);
  const name = "skill-report-01jabcdefghjkmnpqrstvwxyz0";
  const promoted = { ...(reader() as Record<string, Json>), name };
  await s.store.saveWorkflow({ name, document: promoted as never, source: "promotion", skillItemId: "li_01JABCDEFGHJKMNPQRSTVWXYZ0" });
  for (const document of [promoted, { ...promoted, description: "operator edit" }]) {
    const refused = await errorOf(await authed(s, `/v1/workflows/${name}`, { method: "PUT", json: { document } }));
    assert.equal(refused.status, 409);
    assert.equal(refused.code, "conflict");
    assert.equal(refused.details?.["reason"], "promoted_workflow");
    assert.equal(refused.details?.["skillItemId"], "li_01JABCDEFGHJKMNPQRSTVWXYZ0");
  }
  const saved = await s.client.getWorkflow(name);
  assert.deepEqual([saved.version, saved.source], [1, "promotion"]);
  assert.equal((await errorOf(await authed(s, `/v1/workflows/${name}?version=2`))).status, 404);
});

/** A workflow named `name` whose root calls the saved workflow `target` with the same input. */
function caller(name: string, target: string): Json {
  return {
    format: "runwright.workflow/v1",
    name,
    schemas: { in: { type: "object", required: ["path"], properties: { path: { type: "string" } } }, out: { type: "string" } },
    input: "in",
    output: "out",
    root: { id: "sub", kind: "call", workflow: target, input: { path: { $ref: "input.path" } } },
    result: { $ref: "steps.sub" },
  };
}

function leaf(name: string): Json {
  return { ...(reader() as Record<string, Json>), name };
}

async function putWorkflow(s: Awaited<ReturnType<typeof startTestServer>>, name: string, document: Json): Promise<Response> {
  return authed(s, `/v1/workflows/${name}`, { method: "PUT", json: { document } });
}

function hasCycle(problems: unknown): boolean {
  return Array.isArray(problems) && problems.some((p) => (p as { code?: unknown }).code === "call_cycle");
}

test("PUT validates the document as the name it is saved under: a self-call under another name is a cycle", async (t) => {
  const s = await startTestServer(t);
  assert.equal((await putWorkflow(s, "saved", leaf("saved"))).status, 201);
  const before = await s.client.getWorkflow("saved");
  const refused = await errorOf(await putWorkflow(s, "saved", caller("different", "saved")));
  assert.equal(refused.status, 422);
  assert.equal(refused.code, "workflow_invalid");
  assert.ok(hasCycle(refused.details?.["problems"]), JSON.stringify(refused.details));
  const after = await s.client.getWorkflow("saved");
  assert.deepEqual([after.version, after.documentHash], [before.version, before.documentHash]);
  assert.equal((await errorOf(await authed(s, "/v1/workflows/saved?version=2"))).status, 404);
});

test("PUT refuses an update that closes an indirect sub-workflow cycle", async (t) => {
  const s = await startTestServer(t);
  assert.equal((await putWorkflow(s, "b", leaf("b"))).status, 201);
  assert.equal((await putWorkflow(s, "a", caller("a", "b"))).status, 201);
  const refused = await errorOf(await putWorkflow(s, "b", caller("b", "a")));
  assert.equal(refused.status, 422);
  assert.equal(refused.code, "workflow_invalid");
  assert.ok(hasCycle(refused.details?.["problems"]), JSON.stringify(refused.details));
  assert.equal((await s.client.getWorkflow("b")).version, 1);
  const update = await putWorkflow(s, "b", { ...(leaf("b") as Record<string, Json>), description: "v2" });
  assert.equal(update.status, 201);
  await update.body?.cancel();
  assert.equal((await s.client.getWorkflow("b")).version, 2);
});

test("two concurrent PUTs that would form a cycle together: one is saved, the other is 422", async (t) => {
  const s = await startTestServer(t);
  for (const name of ["a", "b"]) assert.equal((await putWorkflow(s, name, leaf(name))).status, 201);
  const responses = await Promise.all([putWorkflow(s, "a", caller("a", "b")), putWorkflow(s, "b", caller("b", "a"))]);
  const statuses = responses.map((r) => r.status).sort();
  assert.deepEqual(statuses, [201, 422]);
  const refused = await errorOf(responses.find((r) => r.status === 422) as Response);
  assert.ok(hasCycle(refused.details?.["problems"]));
  for (const response of responses) if (response.status !== 422) await response.body?.cancel();
  const stored = new Map((await Promise.all(["a", "b"].map((n) => s.client.getWorkflow(n)))).map((w) => [w.name, w.document]));
  for (const [name, document] of stored) {
    const result = validateWorkflow(document, { savedAs: name, resolveWorkflow: (other) => stored.get(other) ?? null });
    assert.ok(!result.problems.some((p) => p.code === "call_cycle"), `${name}: ${JSON.stringify(result.problems)}`);
  }
});

// Storage identity of each validation (contract C4, finding R13D-workflow-01).
test("a workflow saved under main with name helper that calls the saved helper validates, graphs and saves as main", async (t) => {
  const s = await startTestServer(t);
  assert.equal((await putWorkflow(s, "helper", leaf("helper"))).status, 201);
  const document = caller("helper", "helper");
  const saved = await putWorkflow(s, "main", document);
  assert.equal(saved.status, 201, "saved under main, its call to helper is the saved helper");
  const graph = await s.client.savedWorkflowGraph("main");
  assert.ok(graph.graph.nodes.some((n) => n.id === "sub"));
  // The body endpoints check a document that is not saved: its own name is its identity, so the same document
  // sent there calls itself.
  const unsaved = await s.client.validateWorkflow(document);
  assert.ok(hasCycle(unsaved.problems), JSON.stringify(unsaved.problems));
  const other = await s.client.validateWorkflow(caller("main2", "helper"));
  assert.deepEqual(other.problems.filter((p) => p.severity === "error"), []);
  const report = await s.client.dryRunWorkflow(caller("main2", "helper"), { input: { path: "a.txt" } });
  assert.equal(report.ok, true, JSON.stringify(report.problems));
});

test("(R15D-server-02) embedded: true checks a document as an agent's embedded workflow: validate, dry-run and graph", async (t) => {
  const s = await startTestServer(t);
  assert.equal((await putWorkflow(s, "helper", leaf("helper"))).status, 201);
  const embedded = caller("helper", "helper");
  const agent = await authed(s, "/v1/agents", { method: "POST", json: { definition: testAgentDefinition({ name: "Calls helper", workflow: embedded as never }) } });
  assert.equal(agent.status, 201, "the agent saves: its embedded workflow calls the saved helper");

  const graph = await authed(s, "/v1/workflows/graph", { method: "POST", json: { document: embedded, embedded: true } });
  assert.equal(graph.status, 200, JSON.stringify(await graph.clone().json()));
  const body = (await graph.json()) as { graph: { nodes: { id: string }[] }; mermaid: string };
  assert.ok(body.graph.nodes.some((n) => n.id === "sub"));
  assert.match(body.mermaid, /flowchart/);
  const asSaved = await errorOf(await authed(s, "/v1/workflows/graph", { method: "POST", json: { document: embedded } }));
  assert.equal(asSaved.status, 422);
  assert.ok(hasCycle(asSaved.details?.["problems"]), "without embedded the document is its own name, so it calls itself");
  const explicitFalse = await errorOf(await authed(s, "/v1/workflows/graph", { method: "POST", json: { document: embedded, embedded: false } }));
  assert.ok(hasCycle(explicitFalse.details?.["problems"]));

  const valid = (await (await authed(s, "/v1/workflows/validate", { method: "POST", json: { document: embedded, embedded: true } })).json()) as { ok: boolean; problems: unknown[] };
  assert.deepEqual(valid, { ok: true, problems: [] });
  const cycle = (await (await authed(s, "/v1/workflows/validate", { method: "POST", json: { document: embedded } })).json()) as { ok: boolean; problems: unknown[] };
  assert.equal(cycle.ok, false);
  assert.ok(hasCycle(cycle.problems));

  const dry = await authed(s, "/v1/workflows/dry-run", { method: "POST", json: { document: embedded, embedded: true, input: { path: "a.txt" } } });
  assert.equal(dry.status, 200, JSON.stringify(await dry.clone().json()));
  const report = ((await dry.json()) as { report: { ok: boolean; problems: unknown[]; wouldCall: { name: string }[] } }).report;
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.ok(!hasCycle(report.problems), "the dry run's own validation checks the same identity");
  assert.deepEqual(report.wouldCall.map((c) => c.name), ["helper", "read_file"], "the call runs the saved helper and its tool");
  const dryCycle = await errorOf(await authed(s, "/v1/workflows/dry-run", { method: "POST", json: { document: embedded, input: { path: "a.txt" } } }));
  assert.equal(dryCycle.status, 422);
  assert.ok(hasCycle(dryCycle.details?.["problems"]));

  const client = await s.client.graphWorkflow(embedded, { embedded: true });
  assert.ok(client.graph.nodes.some((n) => n.id === "sub"));
  assert.deepEqual(await s.client.validateWorkflow(embedded, { embedded: true }), { ok: true, problems: [] });
  assert.equal((await s.client.dryRunWorkflow(embedded, { embedded: true, input: { path: "a.txt" } })).ok, true);
  const refused = await errorOf(await authed(s, "/v1/workflows/graph", { method: "POST", json: { document: embedded, embedded: "yes" } }));
  assert.equal(refused.code, "validation_failed", "embedded is a boolean");
});
