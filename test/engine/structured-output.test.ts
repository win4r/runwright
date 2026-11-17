import { test } from "node:test";
import assert from "node:assert/strict";
import { isRunwrightError } from "../../src/core/errors.ts";
import type { Json, JsonObject } from "../../src/core/json.ts";
import type { ModelRequest, ModelResponse } from "../../src/models/types.ts";
import type { Driver, ModelStepRequest } from "../../src/engine/types.ts";
import { createHarness, fakeModels, reply, type Harness } from "../helpers/engine.ts";

const isRepair = (request: ModelRequest): boolean => request.messages.length > 1;

/** A reply that carried no structured output: what a provider returns for a refusal in plain text. */
const missing = (text: string): ModelResponse => ({ ...reply({ text, output: null }), outputMissing: true });

function step(schema: JsonObject): ModelStepRequest {
  return { purpose: "step", system: "Answer.", messages: [{ role: "user", content: "well?" }], maxOutputTokens: 100, output: { name: "Answer", schema } };
}

/** Runs one structured step; the run's output is `{output}` on success or `{code, message}` when the step throws. */
async function runStep(t: Parameters<typeof createHarness>[0], schema: JsonObject, respond: (request: ModelRequest) => ModelResponse) {
  const requests: ModelRequest[] = [];
  const driver: Driver = async (ctx): Promise<Json> => {
    try {
      const result: JsonObject = { output: (await ctx.model("answer", step(schema))).output };
      return result;
    } catch (error) {
      if (!isRunwrightError(error)) throw error;
      const failure: JsonObject = { code: error.code, message: error.message };
      return failure;
    }
  };
  const h: Harness = await createHarness(t, {
    models: fakeModels((request) => {
      requests.push(request);
      return respond(request);
    }),
    drivers: { agent: driver },
  });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id);
  const done = await h.until(run.id, "completed");
  const types = (await h.journal(run.id)).filter((r) => r.key === "answer" && r.type.startsWith("model.")).map((r) => r.type);
  return { h, run: done, requests, types, output: done.output as { output?: Json; code?: string; message?: string } };
}

test("a reply with no structured output is invalid under a nullable schema and repaired; the answered null is accepted", async (t) => {
  const { h, run, requests, types, output } = await runStep(t, { type: ["string", "null"] },
    (request) => (isRepair(request) ? reply({ output: null }) : missing("I cannot say")));
  assert.deepEqual(types, ["model.started", "model.invalid", "model.started", "model.finished"]);
  const [invalid] = await h.records(run.id, "model.invalid");
  assert.deepEqual(invalid?.problems, [{ path: "$", message: "the reply carried no structured output" }]);
  assert.equal(invalid?.output, null);
  assert.equal(invalid?.text, "I cannot say");
  const started = await h.records(run.id, "model.started");
  assert.equal(started[1]?.repair, true);
  assert.deepEqual(output, { output: null });
  assert.equal(requests.length, 2, "two provider calls");
  const repairText = requests[1]?.messages.map((m) => m.content).join("\n") ?? "";
  assert.match(repairText, /- \$: the reply carried no structured output/);
});

test("both replies with no structured output fail the step with model_output_invalid naming the problem", async (t) => {
  const { h, run, requests, types, output } = await runStep(t, { type: ["string", "null"] }, () => missing("no idea"));
  assert.deepEqual(types, ["model.started", "model.invalid", "model.started", "model.failed"]);
  assert.equal(output.code, "model_output_invalid");
  assert.match(output.message ?? "", /"Answer" is invalid after one repair: \$: the reply carried no structured output/);
  const [failed] = await h.records(run.id, "model.failed");
  assert.equal(failed?.error.code, "model_output_invalid");
  assert.equal(requests.length, 2);
});

test("array and string outputs are accepted as they are, without a repair", async (t) => {
  const array = await runStep(t, { type: "array", items: { type: "integer" } }, () => reply({ output: [1, 2] }));
  assert.deepEqual(array.output, { output: [1, 2] });
  assert.deepEqual(array.types, ["model.started", "model.finished"]);
  assert.equal(array.requests.length, 1);
  const text = await runStep(t, { type: "string" }, () => reply({ output: "ok" }));
  assert.deepEqual(text.output, { output: "ok" });
  assert.deepEqual(text.types, ["model.started", "model.finished"]);
});
