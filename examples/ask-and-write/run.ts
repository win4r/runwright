/**
 * Example 1: an agent that asks a person a question, then writes a file with the answer.
 * Run: node --disable-warning=ExperimentalWarning examples/ask-and-write/run.ts
 */
import { dollars, loadAgentFile, runExample, say, settle, summary } from "../lib.ts";

await runExample("ask-and-write", async ({ client }) => {
  const { id, definition } = await loadAgentFile(new URL("./", import.meta.url));
  const { agent, revision } = await client.saveAgent(definition, id);
  say(`saved agent ${agent.id} (revision ${revision.revision})`);

  const { run } = await client.startRun({ agentId: agent.id, message: "Please greet me." });
  say(`started run ${run.id}`);

  const waiting = await settle(client, run.id);
  say(`run is ${waiting.run.status}`);
  const { pendings } = await client.listPendings({ runId: run.id });
  const question = pendings[0];
  if (waiting.run.status !== "waiting" || question === undefined || question.kind !== "question") {
    say("expected the run to wait on a question");
    return false;
  }
  say(`pending ${question.id} (${question.kind}): ${question.title}`);
  await client.answer(question.id, "Ada");
  say('answered "Ada"');

  const done = await settle(client, run.id);
  say(`run is ${done.run.status}, cost ${dollars(done.run)}`);
  const file = await client.readFile(run.id, "greeting.txt");
  const content = new TextDecoder().decode(file.body);
  say(`greeting.txt: ${content.trim()}`);

  summary({
    example: "ask-and-write", runId: run.id, status: done.run.status, question: question.title,
    file: "greeting.txt", content, costMicros: done.run.usage.costMicros, turns: done.run.usage.turns,
  });
  return done.run.status === "completed" && content === "Hello, Ada!\n";
});
