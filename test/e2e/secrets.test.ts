/**
 * Brief, section 4, "Secrets never appear in API responses, journals or logs", through the whole app: a secret
 * set over the API is handed to a run (shell env), the shell prints it and the model quotes the result; neither
 * the value nor its base64, base64url or JSON-escaped forms appear in the timeline, the SSE stream, the run
 * listings, the pendings, the captured log lines, or the database files. A learning proposal that contains the
 * value stores nothing. It runs for an ASCII value, a multibyte value, and a value with a quote, a backslash and
 * a newline (which serialized JSON carries only in escaped form).
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { startTestApp } from "../fixtures/app.ts";
import { callTurn, fullTimeline, scriptedAgent, waitForStatus } from "../fixtures/runs.ts";

const NAME = "DEPLOY_TOKEN";

function forms(value: string): { label: string; text: string }[] {
  const bytes = Buffer.from(value, "utf8");
  return [
    { label: "plain", text: value },
    { label: "base64", text: bytes.toString("base64") },
    { label: "unpadded base64", text: bytes.toString("base64").replace(/=+$/, "") },
    { label: "base64url", text: bytes.toString("base64url") },
    { label: "JSON-escaped", text: JSON.stringify(value).slice(1, -1) },
  ];
}

function assertAbsent(where: string, text: string, value: string): void {
  for (const form of forms(value)) assert.equal(text.includes(form.text), false, `${where} contains the secret (${form.label})`);
}

/** Searches a file's bytes for each form's UTF-8 bytes, so a multibyte value is found as it would be stored. */
async function assertAbsentInFile(where: string, path: string, value: string): Promise<void> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const form of forms(value)) {
    assert.equal(bytes.includes(Buffer.from(form.text, "utf8")), false, `${where} contains the secret (${form.label})`);
  }
}

const VALUES: readonly { label: string; make: () => string }[] = [
  { label: "an ASCII value", make: () => `rw-secret-${randomBytes(12).toString("hex")}` },
  { label: "a multibyte value", make: () => `秘密口令-${randomBytes(4).toString("hex")}-鍵` },
  { label: "a value with a quote, a backslash and a newline", make: () => `rw"quoted\\back\nline-${randomBytes(6).toString("hex")}` },
];

for (const { label, make } of VALUES) {
  test(`a secret handed to a run never appears in the API, the journal, the logs or the database (${label})`, { timeout: 30_000 }, async (t) => {
    await checkSecretNeverLeaks(t, make());
  });
}

async function checkSecretNeverLeaks(t: TestContext, value: string): Promise<void> {
  const { app, client, logLines } = await startTestApp(t, { configure: (config) => { config.tools.shell.enabled = true; } });
  const status = await client.setSecret(NAME, value);
  assert.deepEqual({ name: status.name, set: status.set }, { name: NAME, set: true });
  assertAbsent("PUT /v1/secrets response", JSON.stringify(status), value);
  assertAbsent("GET /v1/secrets", JSON.stringify(await client.listSecrets()), value);

  const { agent } = await client.saveAgent(scriptedAgent({
    name: "Secret user",
    secrets: [NAME],
    tools: [{ name: "shell", policy: "allow" }],
    script: { turns: [callTurn("shell", { command: `printf '%s' "$${NAME}"` }), { text: "The command said: {{last_result}}" }] },
  }), "secret-user");
  const { run } = await client.startRun({ agentId: agent.id, message: "print the token" });
  const { run: done } = await waitForStatus(client, run.id, ["completed", "failed", "waiting"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  const outputText = JSON.stringify(done.output);
  assert.ok(outputText.includes("redacted"), `the shell really printed the secret, and it was redacted: ${outputText}`);

  const records = await fullTimeline(client, run.id);
  const shellResult = records.find((r) => r.type === "tool.finished");
  assert.equal(shellResult?.data["outcome"], "ok");
  assert.match(JSON.stringify(shellResult?.data["content"]), new RegExp(`\\[redacted:${NAME}\\]`), "the shell output held the secret");
  assertAbsent("the timeline", JSON.stringify(records), value);

  const events: string[] = [];
  for await (const event of client.followTimeline(run.id)) events.push(JSON.stringify(event));
  assert.ok(events.length >= records.length);
  assertAbsent("the SSE stream", events.join("\n"), value);
  assertAbsent("GET /v1/runs", JSON.stringify(await client.listRuns()), value);
  assertAbsent("GET /v1/runs/:id", JSON.stringify(await client.getRun(run.id)), value);
  assertAbsent("GET /v1/pendings", JSON.stringify([
    await client.listPendings({ status: "open" }), await client.listPendings({ status: "resolved" }),
  ]), value);
  assertAbsent("GET /v1/usage", JSON.stringify(await client.usage({ groupBy: "agent" })), value);
  assertAbsent("the shell output file listing", JSON.stringify(await client.listFiles(run.id)), value);
  assert.ok(logLines.length > 0);
  assertAbsent("the log lines", logLines.join("\n"), value);

  const dbPath = join(app.config.dataDir, "runwright.db");
  for (const suffix of ["", "-wal", "-shm"]) await assertAbsentInFile(`runwright.db${suffix}`, dbPath + suffix, value);

  // A learning proposal carrying the value drops the whole proposal: nothing is stored.
  const learner = await client.saveAgent(scriptedAgent({
    name: "Secret learner",
    secrets: [NAME],
    learning: true,
    script: {
      turns: [{ text: "job done" }],
      steps: {
        "learning.propose": {
          output: {
            job_finished: true,
            files: [
              { path: "notes/deploy.md", content: `---\ntitle: Deploying\ndescription: How to deploy\n---\nUse the token ${value} to deploy.` },
              { path: "notes/harmless.md", content: "---\ntitle: Harmless\ndescription: A harmless fact\n---\nThe sky is blue today." },
            ],
          },
        },
      },
    },
  }), "secret-learner");
  const learnRun = (await client.startRun({ agentId: learner.agent.id, message: "learn something" })).run;
  const { run: learned } = await waitForStatus(client, learnRun.id, ["completed", "failed", "waiting"]);
  assert.equal(learned.status, "completed");
  assert.deepEqual(await client.listLearning({ agentId: learner.agent.id }), [], "nothing was stored");
  const learnRecords = await fullTimeline(client, learnRun.id);
  const checked = learnRecords.find((r) => r.type === "learning.checked");
  assert.ok(checked !== undefined, learnRecords.map((r) => r.type).join(","));
  assert.notEqual(checked.data["dropAll"], null);
  assertAbsent("the learning run's timeline", JSON.stringify(learnRecords), value);

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare("SELECT data FROM journal").all() as { data: string }[];
    assert.ok(rows.length > 0);
    assertAbsent("the journal table", rows.map((row) => row.data).join("\n"), value);
    const items = db.prepare("SELECT title, description, body FROM learning_items").all();
    assert.deepEqual(items, []);
    const history = db.prepare("SELECT body FROM learning_history").all();
    assert.deepEqual(history, []);
  } finally {
    db.close();
  }
  assertAbsent("the log lines", logLines.join("\n"), value);
}
