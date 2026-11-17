/**
 * The round-4 reviewer's probe of finding R04-01, kept as a test: the `runs.create` route handler, taken from
 * `runRoutes(context)` and called directly with a fake request (no HTTP), answers an identical keyed retry with
 * the first run although the request's data value has become a secret in between (invariant I2).
 *
 * The other three probes of that review already exist as unit tests at the function the reviewer called:
 * `assessProvenance` with untrusted structured data in test/learning/provenance.test.ts ("the reviewer's probe: an
 * item copied from the structured data of an untrusted result is dropped"), `checkSpend` with cap 100, spent
 * 10 000, next 5 000 in test/engine/budgets.test.ts ("the reviewer's probe: allowing unpriced models does not
 * admit a priced call over the cap (R04-03)"), and `nextFire(parseCron("0 0 *\/2 * *"), …)` in
 * test/triggers/cron.test.ts.
 */
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test, type TestContext } from "node:test";
import { RunwrightError } from "../../src/core/errors.ts";
import type { JsonObject } from "../../src/core/json.ts";
import type { Reply, Route } from "../../src/server/router.ts";
import { runRoutes } from "../../src/server/routes/runs.ts";
import { createSseHub } from "../../src/server/sse.ts";
import type { RunRecord } from "../../src/store/types.ts";
import type { WorkflowDocument } from "../../src/workflow/types.ts";
import { startTestServer, testAgentDefinition, type TestServer } from "../server/support.ts";

const VALUE = "production-eu-west";

const workflow = {
  format: "runwright.workflow/v1", name: "deploy",
  schemas: {
    in: { type: "object", required: ["env"], additionalProperties: false, properties: { env: { type: "string", enum: [VALUE, "staging"] } } },
    out: { type: "string" },
  },
  input: "in", output: "out",
  root: { id: "read", kind: "tool", tool: "read_file", args: { path: { $ref: "input.env" } } },
  result: { $ref: "steps.read.content" },
} as unknown as WorkflowDocument;

function createRoute(t: TestContext, s: TestServer): Route {
  const sse = createSseHub({
    store: s.deps.store, events: s.deps.events, logger: s.deps.logger, redact: (text) => s.secrets.redactText(text),
    pollMs: 20, pingMs: 60_000,
  });
  t.after(() => sse.close());
  const route = runRoutes({ deps: s.deps, sse }).find((r) => r.id === "runs.create");
  assert.ok(route !== undefined);
  return route;
}

function call(route: Route, key: string, body: JsonObject): Promise<Reply> {
  return route.handler({
    req: { headers: { "idempotency-key": key } } as unknown as IncomingMessage,
    res: {} as ServerResponse,
    requestId: "probe",
    params: {},
    query: new URLSearchParams(),
    body,
    rawBody: Buffer.alloc(0),
  });
}

function jsonOf(reply: Reply): { status: number; body: { run: RunRecord; created: boolean } } {
  assert.equal(reply.kind, "json");
  return reply as unknown as { status: number; body: { run: RunRecord; created: boolean } };
}

test("the reviewer's probe (R04-01): the runs.create handler answers an identical keyed retry with its run after the data value became a secret", async (t) => {
  const s = await startTestServer(t);
  await s.client.saveAgent(testAgentDefinition({ name: "Deploy", workflow }));
  const route = createRoute(t, s);
  const request = { agentId: "deploy", message: "deploy", data: { env: VALUE } };

  const first = jsonOf(await call(route, "probe-key", request));
  assert.equal(first.status, 201);
  assert.equal(first.body.created, true);

  await s.client.setSecret("ENV_NAME", VALUE);
  const second = jsonOf(await call(route, "probe-key", request));
  assert.equal(second.status, 200);
  assert.deepEqual([second.body.created, second.body.run.id, second.body.run.revision], [false, first.body.run.id, 1]);

  await assert.rejects(call(route, "probe-key-new", request), (error: unknown) =>
    error instanceof RunwrightError && error.code === "validation_failed", "a new key is validated after redaction");
  await assert.rejects(call(route, "probe-key", { ...request, message: "deploy again" }), (error: unknown) =>
    error instanceof RunwrightError && error.code === "idempotency_mismatch");
  assert.equal((await s.client.listRuns()).runs.length, 1);
});
