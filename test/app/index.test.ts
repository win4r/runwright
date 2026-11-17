import assert from "node:assert/strict";
import { test } from "node:test";
import * as runwright from "../../src/index.ts";
import { literal, node, ref, toGraph, toMermaid, validateWorkflow, dryRunWorkflow, workflow, type WorkflowDocument } from "../../src/index.ts";

test("the public entry exports the composition root, client, config and workflow language", () => {
  for (const name of [
    "createApp", "loadConfig", "createClient", "discoverServer", "workflow", "ref", "literal", "tpl",
    "validateWorkflow", "dryRunWorkflow", "toGraph", "toMermaid", "createToolRegistry", "RunwrightError", "defaultConfig",
  ] as const) {
    assert.equal(typeof runwright[name], "function", `${name} is exported`);
  }
  assert.equal(typeof runwright.node.tool, "function");
  assert.equal(runwright.WORKFLOW_FORMAT, "runwright.workflow/v1");
  assert.equal(runwright.DEFAULT_PORT, 7411);
  assert.match(runwright.VERSION, /^\d+\.\d+\.\d+/);
});

test("a workflow written with the exported builder validates, dry-runs and graphs", () => {
  const document: WorkflowDocument = workflow("greet")
    .input("Input", { type: "object", required: ["name"], properties: { name: { type: "string" } } })
    .output("Output", { type: "object", required: ["written"], properties: { written: { type: "boolean" }, note: {} } })
    .root(node.sequence("main",
      node.tool("write", "write_file", { path: "hello.txt", content: "Hello, {{input.name}}!" }),
      node.branch("check", ref("steps.write.ok"), [{ when: true, run: node.wait("confirm", "Looks good?") }]),
    ))
    .result({ written: ref("steps.write.ok"), note: literal({ $ref: "kept as is" }) })
    .build();
  assert.equal(validateWorkflow(document).ok, true);
  const report = dryRunWorkflow(document, { input: { name: "Ada" } });
  assert.equal(report.ok, true);
  assert.deepEqual(report.wouldCall.map((call) => call.type), ["tool", "person"]);
  const mermaid = toMermaid(toGraph(document));
  assert.match(mermaid, /write/);
});
