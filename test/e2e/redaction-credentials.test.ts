/**
 * Finding R03-01 through `createApp`: the credential of every model a run calls is registered with the run's
 * redactor before the provider is called (invariant R1), not only the secrets the agent definition names.
 *
 * - The learning grader runs on its own OpenAI-compatible model with its own key (GRADER_KEY). Its fake endpoint
 *   echoes the key in its text (split across streamed deltas), in its structured output, and in the reason it
 *   gives. Nothing at rest (every table but `secrets`), in the logs, in the timeline, on the SSE stream, in the
 *   learning items or in the archive holds a form of the key, before and after the secret is deleted and the app
 *   restarted; the grader's `model.finished` holds the run's own placeholder `[redacted:GRADER_KEY]`.
 * - The agent's own key is rotated from A to B while the run waits on a question; the second turn echoes B and
 *   repeats A. Neither value is anywhere at rest, in the timeline, on the SSE stream or in the logs.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { gunzipSync } from "node:zlib";
import type { RunwrightClient, TimelineEvent } from "../../src/client/index.ts";
import { systemClock } from "../../src/core/clock.ts";
import type { ModelRef } from "../../src/models/types.ts";
import { archiveFinishedRuns } from "../../src/ops/retention.ts";
import { startTestApp } from "../fixtures/app.ts";
import { fakeOpenAi, forcedFunction } from "../fixtures/fake-openai.ts";
import { fullTimeline, scriptedAgent, waitForStatus } from "../fixtures/runs.ts";
import { waitFor } from "../helpers/wait.ts";
import { formsIn, scanDatabase } from "../security/at-rest.ts";

const NOTE_PATH = "notes/build.md";
const NOTE = "---\ntitle: Build command\ndescription: How this project builds.\n---\nRun `make all` from the repository root.";

/** A key with characters whose JSON, percent and base64 forms differ from the plain text. */
function makeKey(label: string): string {
  return `${label}-${randomBytes(9).toString("hex")}/+=x`;
}

const b64 = (value: string): string => Buffer.from(value, "utf8").toString("base64");

function assertNoForms(where: string, text: string, ...values: string[]): void {
  for (const value of values) assert.deepEqual(formsIn(text, value), [], `${where} holds a form of the key`);
}

/** Follows the run's SSE stream from event id 0 until it ends; `attached` resolves once the first event arrived. */
function followRun(t: TestContext, client: RunwrightClient, runId: string): { attached: Promise<void>; events: Promise<TimelineEvent[]> } {
  let markAttached: () => void = () => undefined;
  const attached = new Promise<void>((resolve) => {
    markAttached = resolve;
  });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 20_000);
  t.after(() => clearTimeout(timer));
  const events = (async () => {
    const out: TimelineEvent[] = [];
    for await (const event of client.followTimeline(runId, { after: 0, signal: abort.signal })) {
      out.push(event);
      markAttached();
    }
    return out;
  })();
  return { attached, events };
}

async function archiveTexts(dataDir: string): Promise<string[]> {
  const root = join(dataDir, "archive");
  const files = (await readdir(root, { recursive: true })).filter((name) => name.endsWith(".jsonl.gz"));
  return Promise.all(files.map(async (file) => gunzipSync(await readFile(join(root, file))).toString("utf8")));
}

test("a grader model's own key is redacted everywhere: at rest, logs, timeline, SSE, learning, archive, after restart", { timeout: 60_000 }, async (t) => {
  const key = makeKey("grader");
  let releaseGrader: () => void = () => undefined;
  const graderGate = new Promise<void>((resolve) => {
    releaseGrader = resolve;
  });
  const grader = fakeOpenAi(async (request) => {
    assert.equal(forcedFunction(request), "learning_grades");
    await graderGate;
    const sent = request.bearer;
    return {
      deltas: [`grading with ${sent.slice(0, 9)}`, `${sent.slice(9, 17)}`, `${sent.slice(17)} and ${b64(sent)} done`],
      calls: [{ name: "learning_grades", args: { job_finished: true, decisions: [{ path: NOTE_PATH, verdict: "keep", reason: `checked with ${sent}` }] } }],
    };
  });
  const graderModel: ModelRef = { provider: "openai-compatible", name: "grader-1", baseUrl: "http://grader.test/v1", apiKeySecret: "GRADER_KEY" };
  const first = await startTestApp(t, {
    configure: (config) => {
      config.learning.graderModel = graderModel;
    },
    app: { fetch: grader.fetch },
  });
  const { client, app, dir } = first;
  await client.setSecret("GRADER_KEY", key);
  const { agent } = await client.saveAgent(scriptedAgent({
    name: "Builder", learning: true,
    script: { turns: [{ text: "built" }], steps: { "learning.propose": { output: { job_finished: true, files: [{ path: NOTE_PATH, content: NOTE }] } } } },
  }), "builder");

  const { run } = await client.startRun({ agentId: agent.id, message: "build it" });
  const followed = followRun(t, client, run.id);
  await followed.attached;
  releaseGrader();
  const events = await followed.events;
  const { run: done } = await waitForStatus(client, run.id, ["completed", "failed", "cancelled"]);
  assert.equal(done.status, "completed");
  assert.equal(grader.requests.length, 1);
  assert.equal(grader.requests[0]?.bearer, key, "the grader provider was sent its own key");

  // The run's own redactor knew the grader key: the journalled text carries the named placeholder.
  const timeline = await fullTimeline(client, run.id);
  const started = timeline.find((r) => r.type === "model.started" && r.data["step"] === "learning.grade");
  assert.ok(started !== undefined);
  const finished = timeline.find((r) => r.type === "model.finished" && r.key === started.key);
  assert.ok(finished !== undefined);
  assert.equal(finished.data["text"], "grading with [redacted:GRADER_KEY] and [redacted:GRADER_KEY] done");
  assert.match(JSON.stringify(finished.data["output"]), /checked with \[redacted:GRADER_KEY\]/);
  assertNoForms("the timeline", JSON.stringify(timeline), key);

  // The SSE stream: journal records and the grader's deltas, one by one and put together.
  const deltas = events.filter((e) => e.event === "delta").map((e) => e.data as { key?: string; text?: string })
    .filter((d) => d.key === started.key).map((d) => d.text ?? "");
  assert.ok(deltas.length >= 2, `expected the grader's reply in several deltas, got ${deltas.length}`);
  assert.equal(deltas.join(""), finished.data["text"], "the deltas are exactly the journalled text");
  for (const delta of deltas) assertNoForms("a delta", delta, key);
  assertNoForms("the SSE stream", JSON.stringify(events), key);

  // Learning items and their history.
  const items = await client.listLearning({ agentId: agent.id });
  assert.deepEqual(items.map((i) => [i.name, i.status]), [["build", "active"]]);
  assertNoForms("the learning items", JSON.stringify(items), key);
  for (const item of items) assertNoForms("a learning history", JSON.stringify(await client.learningHistory(item.id)), key);

  // Every table but the sealed secrets, and the log lines.
  const database = join(app.config.dataDir, "runwright.db");
  assert.deepEqual(scanDatabase(database, key, ["secrets"]), []);
  assert.ok(first.logLines.length > 0);
  assert.deepEqual(first.logLines.filter((line) => formsIn(line, key).length > 0), []);

  // The archive of the run's journal.
  const archived = await archiveFinishedRuns({ store: app.store, clock: systemClock, dataDir: app.config.dataDir }, { olderThanMs: 0, limit: 10 });
  assert.deepEqual(archived.archived.map((a) => a.runId), [run.id]);
  const archives = await archiveTexts(app.config.dataDir);
  assert.equal(archives.length, 1);
  assert.match(archives[0] ?? "", /\[redacted:GRADER_KEY\]/);
  assertNoForms("the archive", archives[0] ?? "", key);

  // Delete the secret, restart on the same data directory: nothing ever held the key, so nothing shows it.
  await client.deleteSecret("GRADER_KEY");
  await app.stop({ graceMs: 200 });
  const second = await startTestApp(t, { dir });
  const reread = await second.client.timeline(run.id, { limit: 1000 });
  assertNoForms("the timeline after restart", JSON.stringify(reread), key);
  assertNoForms("the run after restart", JSON.stringify(await second.client.getRun(run.id)), key);
  for (const text of await archiveTexts(second.app.config.dataDir)) assertNoForms("the archive after restart", text, key);
  assert.deepEqual(scanDatabase(database, key, ["secrets"]), []);
});

test("a model key rotated while the run waits is redacted in both values: at rest, timeline, SSE and logs", { timeout: 60_000 }, async (t) => {
  const keyA = makeKey("rot-a");
  const keyB = makeKey("rot-b");
  const model = fakeOpenAi((request, index) => {
    if (index === 0) {
      return { deltas: [`first turn with ${request.bearer}`], calls: [{ name: "ask_person", args: { question: `Which build? ${request.bearer}` } }] };
    }
    return { deltas: [`second turn with ${request.bearer} and earlier ${keyA}`] };
  });
  const { client, app, logLines } = await startTestApp(t, { app: { fetch: model.fetch } });
  await client.setSecret("OPENAI_API_KEY", keyA);
  const { agent } = await client.saveAgent({
    ...scriptedAgent({ name: "Rotating", tools: [{ name: "ask_person" }], script: { turns: [] } }),
    model: { provider: "openai-compatible", name: "echo-1", baseUrl: "http://agent.test/v1", apiKeySecret: "OPENAI_API_KEY" },
  }, "rotating");

  const { run } = await client.startRun({ agentId: agent.id, message: "go" });
  const pending = await waitFor(async () => {
    const { run: current, pendings } = await client.getRun(run.id);
    if (current.status === "failed" || current.status === "completed") throw new Error(`run ended ${current.status}`);
    return pendings.find((p) => p.kind === "question") ?? null;
  }, { timeoutMs: 15_000, intervalMs: 25 });
  assert.match(pending.title, /\[redacted:OPENAI_API_KEY\]/);
  await client.setSecret("OPENAI_API_KEY", keyB);
  const followed = followRun(t, client, run.id);
  await followed.attached;
  await client.answer(pending.id, "the main one");
  const events = await followed.events;
  const { run: done } = await waitForStatus(client, run.id, ["completed", "failed", "cancelled"]);
  assert.equal(done.status, "completed");
  assert.deepEqual(model.requests.map((r) => r.bearer), [keyA, keyB], "the provider was sent A, then the rotated B");

  const timeline = await fullTimeline(client, run.id);
  const texts = timeline.filter((r) => r.type === "model.finished").map((r) => r.data["text"]);
  assert.equal(texts[0], "first turn with [redacted:OPENAI_API_KEY]");
  assert.match(String(texts[1]), /^second turn with \[redacted:OPENAI_API_KEY\] and earlier \[redacted(:OPENAI_API_KEY)?\]$/);
  assertNoForms("the timeline", JSON.stringify(timeline), keyA, keyB);
  assertNoForms("the SSE stream", JSON.stringify(events), keyA, keyB);
  assert.ok(events.some((e) => e.event === "delta"), "the second turn was streamed");
  const database = join(app.config.dataDir, "runwright.db");
  assert.deepEqual(scanDatabase(database, keyA, ["secrets"]), []);
  assert.deepEqual(scanDatabase(database, keyB, ["secrets"]), []);
  assert.deepEqual(logLines.filter((line) => formsIn(line, keyA).length + formsIn(line, keyB).length > 0), []);
});
