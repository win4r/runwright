/**
 * Contract C5 at run time: a run's input is validated against the bundle of the input schema, which resolves a
 * reference inside a named schema against that named schema's own definitions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { WorkflowDocument } from "../../../src/workflow/types.ts";
import { doc, setupWorkflow } from "./helpers.ts";

/** Only A defines `$defs.X` (a number); the input schema refers to A. */
const document = (): WorkflowDocument => doc({ id: "w", kind: "tool", tool: "count", args: { label: "x", value: { $ref: "input.x" } } },
  { $ref: "steps.w.data" }, {
    schemas: {
      Input: { $ref: "#/schemas/A" },
      A: { type: "object", $defs: { X: { type: "number" } }, required: ["x"], properties: { x: { $ref: "#/$defs/X" } } },
      Output: { type: "number" },
    },
  });

test("a run whose input schema refers to a named schema with its own definitions validates its input by them", async (t) => {
  const s = await setupWorkflow(t);
  const agent = await s.agent({ workflow: document() });
  const ok = await s.run(agent, { x: 1 });
  assert.equal(ok.status, "completed", JSON.stringify(ok.error));
  assert.equal(ok.output, 1);
  const wrong = await s.run(agent, { x: "hello" });
  assert.equal(wrong.status, "failed");
  assert.match(wrong.error?.message ?? "", /does not match schema "Input".*expected number, got string/);
});
