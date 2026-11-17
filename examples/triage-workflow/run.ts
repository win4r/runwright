/**
 * Example 2: a typed workflow with a yes/no decision whose low-confidence answers are routed to an agent.
 * Run: node --disable-warning=ExperimentalWarning examples/triage-workflow/run.ts
 */
import { readFile } from "node:fs/promises";
import { canonicalJson, type Json } from "../../src/core/json.ts";
import { journal, loadAgentFile, runExample, say, settle, summary } from "../lib.ts";
import { triageWorkflow } from "./workflow.ts";

const TICKETS = [
  { name: "outage", ticket: "The login server is down and no customer can sign in." },
  { name: "printer", ticket: "The office printer makes a strange noise when it starts." },
];

await runExample("triage-workflow", async ({ client }) => {
  const document = triageWorkflow();
  const folder = new URL("./", import.meta.url);
  const saved = JSON.parse(await readFile(new URL("workflow.json", folder), "utf8")) as Json;
  const { id, definition } = await loadAgentFile(folder);
  if (canonicalJson(saved) !== canonicalJson(document as unknown as Json) ||
    canonicalJson(definition.workflow as unknown as Json) !== canonicalJson(document as unknown as Json)) {
    say("workflow.json or agent.json is out of date with workflow.ts");
    return false;
  }

  const validation = await client.validateWorkflow(document as unknown as Json);
  say(`validate: ${validation.ok ? "ok" : "problems"} (${validation.problems.length} problems)`);
  const dry = await client.dryRunWorkflow(document as unknown as Json, { input: { ticket: "anything" } });
  say(`dry run: ${dry.ok ? "ok" : "failed"}; path ${dry.steps.map((step) => step.nodeId).join(" > ")}`);
  say(`dry run would call: ${dry.wouldCall.map((call) => `${call.type}:${call.name}`).join(", ")}`);
  const { mermaid } = await client.graphWorkflow(document as unknown as Json);
  say("graph (Mermaid):");
  for (const line of mermaid.trimEnd().split("\n")) say(`  ${line}`);

  const { agent } = await client.saveAgent(definition, id);
  const results: { ticket: string; status: string; route: string; urgent: boolean; file: string; content: string; agentTurns: number }[] = [];
  for (const { name, ticket } of TICKETS) {
    const { run } = await client.startRun({ agentId: agent.id, message: `triage the ${name} ticket`, data: { ticket } });
    const done = await settle(client, run.id);
    const records = await journal(client, run.id);
    const decision = records.find((r) => r.type === "node.finished" && r.data["name"] === "urgent");
    const value = (decision?.data["value"] ?? {}) as { value?: boolean; confidence?: number; route?: string };
    const agentTurns = records.filter((r) => r.type === "model.finished" && r.data["purpose"] === "run").length;
    const files = await client.listFiles(run.id);
    const written = files.find((file) => file.path === "urgent.txt" || file.path === "routine.txt");
    const content = written === undefined ? "" : new TextDecoder().decode((await client.readFile(run.id, written.path)).body);
    say(`${name}: ${done.run.status}; confidence ${value.confidence}, route ${value.route}, urgent ${value.value}; wrote ${written?.path ?? "nothing"}`);
    results.push({
      ticket: name, status: done.run.status, route: String(value.route), urgent: value.value === true,
      file: written?.path ?? "", content, agentTurns,
    });
  }

  summary({
    example: "triage-workflow", valid: validation.ok, dryRunOk: dry.ok,
    dryRunCalls: dry.wouldCall.map((call) => `${call.type}:${call.name}`), results,
  });
  const routes = results.map((result) => result.route).sort();
  return validation.ok && dry.ok && results.every((result) => result.status === "completed") &&
    routes.join(",") === "confident,low_confidence";
});
