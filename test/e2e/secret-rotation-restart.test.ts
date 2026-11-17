/**
 * Finding R14D-spec-01, through the real app twice on one data directory: a run is handed secret K, waits on a
 * question, K is rotated (or deleted) over the API, the app is stopped and created again, the question is
 * answered, and the run's next turns emit the old value in a tool result, in model text and in the final output
 * (and the answer itself quotes it). The old value is kept sealed as a retired value while the run is unfinished
 * and loaded at start-up, so no journal record, pending, run row, command, timeline or SSE response or log line
 * holds it in any form; once the run has finished, the next change prunes it.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import type { RunwrightClient } from "../../src/client/index.ts";
import { secretForms } from "../../src/core/redact.ts";
import type { PendingRecord } from "../../src/store/types.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import { startTestApp, type TestApp } from "../fixtures/app.ts";
import { callTurn, fullTimeline, scriptedAgent, waitForStatus } from "../fixtures/runs.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { waitFor } from "../helpers/wait.ts";

const NAME = "ROTATED_KEY";

/** A read-only host tool that returns `value` (what a tool reading an old copy of the secret would return). */
function echoTool(value: string): ToolDefinition {
  return {
    name: "read_old_copy",
    description: "Returns the text of an old configuration file.",
    parameters: { type: "object" },
    effect: "read",
    async handler() {
      return { content: `the old file says ${value}` };
    },
  };
}

async function start(t: TestContext, dir: string, old: string): Promise<TestApp> {
  return startTestApp(t, { dir, app: { tools: [echoTool(old)] } });
}

async function openQuestion(client: RunwrightClient, runId: string): Promise<PendingRecord> {
  return waitFor(async () => (await client.getRun(runId)).pendings.find((p) => p.kind === "question") ?? null, {
    timeoutMs: 15_000, intervalMs: 20, message: "the run never asked its question",
  });
}

function assertAbsent(where: string, text: string, value: string): void {
  for (const form of secretForms(value)) assert.equal(text.includes(form), false, `${where} holds the old value (${form})`);
}

function columnTexts(dbPath: string, sql: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).all().map((row) => String(row["text"] ?? ""));
  } finally {
    db.close();
  }
}

async function scenario(t: TestContext, change: "rotate" | "delete"): Promise<void> {
  const dir = await makeTempDir(t, "runwright-e2e-rotation-");
  const old = `old-value-${randomBytes(10).toString("hex")}`;
  const first = await start(t, dir, old);
  await first.client.setSecret(NAME, old);
  const { agent } = await first.client.saveAgent(scriptedAgent({
    name: "Rotation", secrets: [NAME],
    tools: [{ name: "ask_person", policy: "allow" }, { name: "read_old_copy", policy: "allow" }],
    script: {
      turns: [
        callTurn("ask_person", { question: "May I continue?" }),
        callTurn("read_old_copy", {}),
        { text: "Done. {{last_result}}" },
      ],
    },
  }), "rotation");
  const { run } = await first.client.startRun({ agentId: agent.id, message: "read the old file" });
  const question = await openQuestion(first.client, run.id);
  if (change === "rotate") await first.client.setSecret(NAME, `new-value-${randomBytes(10).toString("hex")}`);
  else await first.client.deleteSecret(NAME);
  await first.app.stop({ graceMs: 200 });

  const second = await start(t, dir, old);
  await second.client.answer(question.id, `yes, and the old one was ${old}`);
  const { run: done } = await waitForStatus(second.client, run.id, ["completed", "failed", "cancelled"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));

  const records = await fullTimeline(second.client, run.id);
  const toolResult = records.find((r) => r.type === "tool.finished" && JSON.stringify(r.data).includes("the old file says"));
  assert.ok(toolResult !== undefined, "the tool ran after the restart");
  assert.match(JSON.stringify(toolResult.data), /the old file says \[redacted\]/, "the tool result held the old value");
  assert.match(JSON.stringify(done.output), /Done\. the old file says \[redacted\]/, "the model text and the output held the old value");
  assertAbsent("the timeline", JSON.stringify(records), old);
  const events: string[] = [];
  for await (const event of second.client.followTimeline(run.id)) events.push(JSON.stringify(event));
  assertAbsent("the SSE stream", events.join("\n"), old);
  assertAbsent("GET /v1/runs/:id", JSON.stringify(await second.client.getRun(run.id)), old);
  assertAbsent("GET /v1/runs", JSON.stringify(await second.client.listRuns()), old);
  assertAbsent("GET /v1/pendings", JSON.stringify(await second.client.listPendings({ status: "resolved" })), old);
  assertAbsent("GET /v1/secrets", JSON.stringify(await second.client.listSecrets()), old);
  assertAbsent("the first app's log lines", first.logLines.join("\n"), old);
  assertAbsent("the second app's log lines", second.logLines.join("\n"), old);
  assert.ok(second.logLines.length > 0);

  const dbPath = join(second.app.config.dataDir, "runwright.db");
  for (const [label, sql] of [
    ["journal.data", "SELECT data AS text FROM journal"],
    ["runs.output", "SELECT output AS text FROM runs"],
    ["runs.error", "SELECT error AS text FROM runs"],
    ["pendings", "SELECT title || ' ' || detail || ' ' || coalesce(resolution, '') AS text FROM pendings"],
    ["commands.payload", "SELECT payload AS text FROM commands"],
  ] as const) {
    const texts = columnTexts(dbPath, sql);
    assert.ok(texts.length > 0, `${label} has rows`);
    assertAbsent(label, texts.join("\n"), old);
  }
  assert.ok(columnTexts(dbPath, "SELECT payload AS text FROM commands").some((text) => text.includes("the old one was [redacted]")),
    "the answer was redacted at intake");

  // E3: the run has finished, so the next change prunes the retired value; this process still redacts it.
  assert.ok((await second.app.store.listRetiredSecrets(NAME)).length > 0, "nothing pruned it while it could be needed");
  await second.client.setSecret("UNRELATED_KEY", `unrelated-${randomBytes(6).toString("hex")}`);
  assert.deepEqual(await second.app.store.listRetiredSecrets(), []);
  assertAbsent("a response after pruning", JSON.stringify(await second.client.getRun(run.id)), old);
}

test("E1: a secret rotated while its run waits, then a restart: the old value stays redacted everywhere", { timeout: 60_000 }, async (t) => {
  await scenario(t, "rotate");
});

test("E2: a secret deleted while its run waits, then a restart: the old value stays redacted everywhere", { timeout: 60_000 }, async (t) => {
  await scenario(t, "delete");
});
