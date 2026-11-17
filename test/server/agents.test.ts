import { test } from "node:test";
import assert from "node:assert/strict";
import { RunwrightError } from "../../src/core/errors.ts";
import type { WorkflowDocument } from "../../src/workflow/types.ts";
import { authed, errorOf, startTestServer, testAgentDefinition } from "./support.ts";

function simpleWorkflow(tool = "read_file"): WorkflowDocument {
  return {
    format: "runwright.workflow/v1",
    name: "reader",
    schemas: { in: { type: "object", required: ["path"], properties: { path: { type: "string" } } }, out: { type: "string" } },
    input: "in",
    output: "out",
    root: { id: "read", kind: "tool", tool, args: { path: { $ref: "input.path" } } },
    result: { $ref: "steps.read.content" },
  } as unknown as WorkflowDocument;
}

test("saving creates a revision only when the definition changes", async (t) => {
  const s = await startTestServer(t);
  const first = await s.client.saveAgent(testAgentDefinition({ name: "Helper" }));
  assert.equal(first.created, true);
  assert.equal(first.agent.id, "helper");
  assert.equal(first.revision.revision, 1);

  const again = await authed(s, "/v1/agents", { method: "POST", json: { definition: testAgentDefinition({ name: "Helper" }) } });
  assert.equal(again.status, 200);
  assert.equal(((await again.json()) as { created: boolean }).created, false);

  const changed = await authed(s, "/v1/agents/helper", { method: "PUT", json: { definition: testAgentDefinition({ name: "Helper", instructions: "New." }) } });
  assert.equal(changed.status, 201);
  const body = (await changed.json()) as { revision: { revision: number }; created: boolean };
  assert.equal(body.revision.revision, 2);

  const revisions = await s.client.listRevisions("helper");
  assert.deepEqual(revisions.map((r) => r.revision), [2, 1]);
  assert.equal((await s.client.getRevision("helper", 1)).definition.instructions, "Do the job.");
  const current = await s.client.getAgent("helper");
  assert.equal(current.revision.revision, 2);
  const listed = await s.client.listAgents();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.definition.instructions, "New.");
});

test("an explicit id must match the agent id pattern", async (t) => {
  const s = await startTestServer(t);
  const response = await authed(s, "/v1/agents", { method: "POST", json: { id: "Bad Id!", definition: testAgentDefinition() } });
  const error = await errorOf(response);
  assert.equal(error.code, "validation_failed");
  const put = await authed(s, "/v1/agents/Bad%20Id", { method: "PUT", json: { definition: testAgentDefinition() } });
  assert.equal((await errorOf(put)).code, "validation_failed");
  const ok = await s.client.saveAgent(testAgentDefinition(), "my-agent_2");
  assert.equal(ok.agent.id, "my-agent_2");
});

test("an invalid definition is rejected with paths under $.definition", async (t) => {
  const s = await startTestServer(t);
  const response = await authed(s, "/v1/agents", { method: "POST", json: { definition: { name: "", model: {} } } });
  const error = await errorOf(response);
  assert.equal(error.code, "validation_failed");
  const paths = (error.details?.["problems"] as { path: string }[]).map((p) => p.path);
  assert.ok(paths.every((p) => p.startsWith("$.definition")), paths.join(","));
  assert.ok(paths.includes("$.definition.name"));
});

test("an unknown tool is rejected, naming it; registered and implicit tools are accepted", async (t) => {
  const s = await startTestServer(t);
  const error = await s.client.saveAgent(testAgentDefinition({ tools: [{ name: "read_file" }, { name: "teleport" }] })).then(
    () => assert.fail("expected a rejection"),
    (e: unknown) => e as RunwrightError,
  );
  assert.ok(error instanceof RunwrightError);
  assert.equal(error.code, "validation_failed");
  assert.equal(error.status, 400);
  assert.match(error.message, /teleport/);
  assert.deepEqual((error.details?.["problems"] as { path: string }[]).map((p) => p.path), ["$.definition.tools[1].name"]);
  const ok = await s.client.saveAgent(testAgentDefinition({ tools: [{ name: "read_file" }, { name: "recall" }, { name: "run_workflow" }] }));
  assert.equal(ok.created, true);
});

test("an invalid embedded workflow is rejected with its problems; a valid one is saved", async (t) => {
  const s = await startTestServer(t);
  const response = await authed(s, "/v1/agents", {
    method: "POST", json: { definition: testAgentDefinition({ workflow: simpleWorkflow("no_such_tool") }) },
  });
  const error = await errorOf(response);
  assert.equal(error.code, "validation_failed");
  const problems = error.details?.["problems"] as { path: string }[];
  assert.ok(problems.length > 0);
  assert.ok(problems.every((p) => p.path.startsWith("$.definition.workflow")), JSON.stringify(problems));

  const saved = await s.client.saveAgent(testAgentDefinition({ name: "Wf", workflow: simpleWorkflow() }));
  assert.equal(saved.created, true);
});

test("missing agents and revisions are 404; a non-numeric revision is 400", async (t) => {
  const s = await startTestServer(t);
  await s.client.saveAgent(testAgentDefinition({ name: "One" }));
  assert.equal((await errorOf(await authed(s, "/v1/agents/nobody"))).status, 404);
  assert.equal((await errorOf(await authed(s, "/v1/agents/nobody/revisions"))).status, 404);
  assert.equal((await errorOf(await authed(s, "/v1/agents/one/revisions/9"))).status, 404);
  assert.equal((await errorOf(await authed(s, "/v1/agents/one/revisions/abc"))).status, 400);
  // A revision number past 2^53 - 1 would be read as a different number: it is refused, not looked up.
  for (const n of ["9007199254740992", "9999999999999999", "0", "-1", "1.5", "1e3"]) {
    const refused = await errorOf(await authed(s, `/v1/agents/one/revisions/${n}`));
    assert.equal(refused.status, 400, n);
    assert.equal(refused.code, "bad_request", n);
  }
  assert.equal((await errorOf(await authed(s, "/v1/agents/one/revisions/9007199254740991"))).status, 404);
  assert.equal((await errorOf(await authed(s, "/v1/agents/nobody/learning/metrics"))).status, 404);
  const metrics = await s.client.learningMetrics("one");
  assert.equal(metrics.agentId, "one");
  assert.equal(metrics.before.runs, 0);
});

test("integer fields of an agent definition have a maximum: 1e308 and one above it are 400 with the path", async (t) => {
  const s = await startTestServer(t);
  const base = testAgentDefinition({ name: "Bounded" });
  const cases: { patch: (value: number) => unknown; path: string; above: number }[] = [
    { patch: (v) => ({ ...base, limits: { maxCostMicros: v } }), path: "$.limits.maxCostMicros", above: Number.MAX_SAFE_INTEGER + 1 },
    { patch: (v) => ({ ...base, limits: { maxToolCalls: v } }), path: "$.limits.maxToolCalls", above: Number.MAX_SAFE_INTEGER + 1 },
    { patch: (v) => ({ ...base, limits: { maxTurns: v } }), path: "$.limits.maxTurns", above: Number.MAX_SAFE_INTEGER + 1 },
    { patch: (v) => ({ ...base, model: { ...base.model, maxOutputTokens: v } }), path: "$.model.maxOutputTokens", above: Number.MAX_SAFE_INTEGER + 1 },
    { patch: (v) => ({ ...base, model: { ...base.model, contextTokens: v } }), path: "$.model.contextTokens", above: Number.MAX_SAFE_INTEGER + 1 },
    { patch: (v) => ({ ...base, model: { ...base.model, script: { turns: [{ text: "x", delayMs: v }] } } }), path: "$.model.script.turns[0].delayMs", above: 2147483648 },
    { patch: (v) => ({ ...base, model: { ...base.model, script: { turns: [{ text: "x", usage: { inputTokens: v } }] } } }), path: "$.model.script.turns[0].usage.inputTokens", above: Number.MAX_SAFE_INTEGER + 1 },
    { patch: (v) => ({ ...base, model: { ...base.model, script: { steps: { s: [{ fail: { attempts: 1, retryAfterMs: v } }] } } } }), path: "$.model.script.steps.s", above: 2147483648 },
  ];
  for (const { patch, path, above } of cases) {
    for (const value of [1e308, above]) {
      for (const [method, url] of [["POST", "/v1/agents"], ["PUT", "/v1/agents/bounded"]]) {
        const error = await errorOf(await authed(s, url as string, { method, json: { definition: patch(value) } }));
        assert.equal(error.status, 400, `${method} ${path} ${value}`);
        assert.equal(error.code, "validation_failed", `${method} ${path} ${value}`);
        const paths = ((error.details?.["problems"] ?? []) as { path: string }[]).map((p) => p.path);
        assert.ok(paths.some((p) => p.startsWith(path.replace("$.", "$.definition."))), `${method} ${path} ${value}: ${JSON.stringify(paths)}`);
      }
    }
  }
  const ok = await authed(s, "/v1/agents", {
    method: "POST",
    json: { definition: { ...base, limits: { maxTurns: Number.MAX_SAFE_INTEGER }, model: { ...base.model, script: { turns: [{ text: "x", delayMs: 2147483647 }] } } } },
  });
  assert.equal(ok.status, 201);
  await ok.body?.cancel();
});

// An embedded workflow has no storage identity (contract C4, finding R13D-workflow-01).
test("an agent whose embedded workflow is named like a saved workflow it calls is saved, not refused as a cycle", async (t) => {
  const s = await startTestServer(t);
  await s.client.saveWorkflow("helper", { ...(simpleWorkflow() as unknown as Record<string, unknown>), name: "helper" } as never);
  const embedded = {
    ...(simpleWorkflow() as unknown as Record<string, unknown>),
    name: "helper",
    root: { id: "sub", kind: "call", workflow: "helper", input: { path: { $ref: "input.path" } } },
    result: { $ref: "steps.sub" },
  } as unknown as WorkflowDocument;
  const response = await authed(s, "/v1/agents", { method: "POST", json: { definition: testAgentDefinition({ name: "Calls helper", workflow: embedded }) } });
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  const ghost = { ...(embedded as unknown as Record<string, unknown>), root: { id: "sub", kind: "call", workflow: "ghost", input: {} } } as unknown as WorkflowDocument;
  const refused = await errorOf(await authed(s, "/v1/agents", { method: "POST", json: { definition: testAgentDefinition({ name: "Calls ghost", workflow: ghost }) } }));
  assert.equal(refused.code, "validation_failed", "a call that resolves to nothing is still refused");
});
