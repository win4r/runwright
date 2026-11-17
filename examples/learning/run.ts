/**
 * Example 3: learning. The first run does the job the long way and, in its learning turn, keeps a note and a
 * skill (checked by code, graded, versioned). The second run is given them and does the job in fewer turns, so
 * it is measurably cheaper. Exits 1 if it is not.
 * Run: node --disable-warning=ExperimentalWarning examples/learning/run.ts
 */
import type { RunwrightClient } from "../../src/client/index.ts";
import { journal, loadAgentFile, runExample, say, settle, summary } from "../lib.ts";

const LEARNING_PURPOSES = new Set(["learning", "grader", "promotion"]);

interface JobFigures { runId: string; status: string; jobCostMicros: number; jobTokens: number; turns: number; given: string[] }

/** The job's own cost and tokens (model calls other than the learning, grading and promotion calls). */
async function figures(client: RunwrightClient, runId: string): Promise<JobFigures> {
  const { run } = await client.getRun(runId);
  let jobCostMicros = 0;
  let jobTokens = 0;
  for (const record of await journal(client, runId)) {
    if (record.type !== "model.finished" || LEARNING_PURPOSES.has(String(record.data["purpose"]))) continue;
    jobCostMicros += Number(record.data["costMicros"] ?? 0);
    const usage = record.data["usage"] as { inputTokens: number; outputTokens: number };
    jobTokens += usage.inputTokens + usage.outputTokens;
  }
  const uses = await client.runLearning(runId);
  const items = new Map((await client.listLearning({ agentId: run.agentId })).map((item) => [item.id, `${item.kind}:${item.name}`]));
  return {
    runId, status: run.status, jobCostMicros, jobTokens, turns: run.usage.turns,
    given: uses.map((use) => items.get(use.itemId) ?? use.itemId),
  };
}

await runExample("learning", async ({ client }) => {
  const { id, definition } = await loadAgentFile(new URL("./", import.meta.url));
  const { agent } = await client.saveAgent(definition, id);
  const message = "Added dark mode to the settings page.";

  const runs: JobFigures[] = [];
  for (const attempt of [1, 2]) {
    const { run } = await client.startRun({ agentId: agent.id, message });
    const done = await settle(client, run.id);
    const figure = await figures(client, run.id);
    runs.push(figure);
    say(`run ${attempt}: ${done.run.status}; ${figure.turns} turns, job cost $${(figure.jobCostMicros / 1e6).toFixed(6)}, ` +
      `${figure.jobTokens} tokens; given ${figure.given.length === 0 ? "nothing" : figure.given.join(", ")}`);
    if (attempt === 1) {
      for (const item of await client.listLearning({ agentId: agent.id })) {
        say(`  kept ${item.kind} ${item.name} (v${item.version}, ${item.status}): ${item.title}`);
      }
    }
  }

  const items = await client.listLearning({ agentId: agent.id });
  const metrics = await client.learningMetrics(agent.id);
  say(`metrics: before learning ${metrics.before.runs} run(s), avg job cost ${metrics.before.avgCostMicros} micro-USD; ` +
    `after ${metrics.after.runs} run(s), avg job cost ${metrics.after.avgCostMicros} micro-USD`);
  const [first, second] = runs as [JobFigures, JobFigures];
  const cheaper = second.jobCostMicros < first.jobCostMicros;
  const gotNote = second.given.includes("note:release-notes-format");
  say(cheaper ? `run 2 was ${(100 * (1 - second.jobCostMicros / first.jobCostMicros)).toFixed(0)}% cheaper than run 1` : "run 2 was NOT cheaper");

  summary({
    example: "learning", runs: runs.map((run) => ({ ...run })),
    items: items.map((item) => ({ kind: item.kind, name: item.name, status: item.status, version: item.version, title: item.title })),
    metrics: { before: { ...metrics.before }, after: { ...metrics.after } },
    cheaper, run2GivenNote: gotNote,
  });
  return first.status === "completed" && second.status === "completed" && cheaper && gotNote;
});
