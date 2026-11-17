/**
 * Configuration and services reach the engine through `createApp`: the server deny list, price overrides,
 * `models.allowUnpricedModels`, model keys from the secrets service, the injected `fetch`, and model text
 * deltas of the in-process runner on the run's SSE stream (the same events object the server reads). And the
 * choke point of redaction at intake: an app never hands out a bare store.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { TimelineEvent } from "../../src/client/index.ts";
import type { JournalDataMap } from "../../src/engine/journal-types.ts";
import { startTestApp } from "../fixtures/app.ts";
import { scriptedAgent, waitForStatus } from "../fixtures/runs.ts";

const KEY = "sk-ant-wiring-0123456789abcdefghij";

function anthropicStream(texts: readonly string[]): string[] {
  const event = (type: string, data: object): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  return [
    event("message_start", { message: { usage: { input_tokens: 40, output_tokens: 1 } } }),
    event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    ...texts.map((text) => event("content_block_delta", { index: 0, delta: { type: "text_delta", text } })),
    event("content_block_stop", { index: 0 }),
    event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 12 } }),
    event("message_stop", {}),
  ];
}

test("an Anthropic model gets its key from the secrets service and streams deltas to the run's SSE stream", { timeout: 30_000 }, async (t) => {
  const calls: { url: string; key: string | null }[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), key: new Headers(init?.headers).get("x-api-key") });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        await gate;
        for (const chunk of anthropicStream(["Hello", ", world"])) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;

  const { client, logLines } = await startTestApp(t, { app: { fetch: fakeFetch } });
  await client.setSecret("ANTHROPIC_API_KEY", KEY);
  const { agent } = await client.saveAgent({
    name: "Streamer", instructions: "Say hello.", model: { provider: "anthropic", name: "claude-test-1", maxOutputTokens: 64 },
    tools: [], limits: {}, learning: false,
  }, "streamer");
  const { run } = await client.startRun({ agentId: agent.id, message: "hi" });

  const events: TimelineEvent[] = [];
  for await (const event of client.followTimeline(run.id)) {
    events.push(event);
    if (event.event === "model.started") release();
  }
  const deltas = events.filter((event) => event.event === "delta");
  assert.deepEqual(deltas.map((event) => (event.data as { text?: string }).text), ["Hello", ", world"]);
  assert.ok(deltas.every((event) => event.id === null), "deltas carry no event id");
  assert.equal(events.at(-1)?.event, "end");

  const { run: done } = await waitForStatus(client, run.id, "completed");
  assert.deepEqual(done.output, { text: "Hello, world" });
  assert.equal(calls.length, 1);
  assert.match(calls[0]?.url ?? "", /\/v1\/messages$/);
  assert.equal(calls[0]?.key, KEY, "the key was unsealed from the secrets service");
  assert.equal(done.usage.costUnknown, true, "claude-test-1 has no price");
  assert.ok(!logLines.some((line) => line.includes(KEY)), "the key never reaches the log");
});

test("the server deny list, price overrides and allowUnpricedModels from config reach the engine", { timeout: 30_000 }, async (t) => {
  const { client, app } = await startTestApp(t, {
    configure: (config) => {
      config.tools.deny = ["write_file"];
      config.models.prices["scripted/house-1"] = { inputPerMTok: 2, outputPerMTok: 10 };
      config.models.allowUnpricedModels = true;
    },
  });

  const { agent: writer } = await client.saveAgent(scriptedAgent({
    name: "Writer", tools: [{ name: "write_file", policy: "allow" }],
    script: { turns: [{ toolCalls: [{ name: "write_file", args: { path: "out.txt", content: "x" } }] }, { text: "{{last_result}}" }] },
  }), "writer");
  const { run: denied } = await client.startRun({ agentId: writer.id, message: "write" });
  await waitForStatus(client, denied.id, "completed");
  const finished = (await client.timeline(denied.id)).records.find((record) => record.type === "tool.finished");
  assert.equal((finished?.data as JournalDataMap["tool.finished"] | undefined)?.outcome, "denied");
  assert.equal(existsSync(join(app.config.dataDir, "workspaces", denied.id, "out.txt")), false, "the denied tool never ran");

  const { agent: priced } = await client.saveAgent(scriptedAgent({
    name: "Priced", model: { name: "house-1" }, script: { turns: [{ text: "done", usage: { inputTokens: 1000, outputTokens: 100 } }] },
  }), "priced");
  const { run: pricedRun } = await client.startRun({ agentId: priced.id, message: "go" });
  const { run: pricedDone } = await waitForStatus(client, pricedRun.id, "completed");
  assert.equal(pricedDone.usage.costUnknown, false);
  assert.equal(pricedDone.usage.costMicros, 3000, "1000 x $2/MTok + 100 x $10/MTok");

  const { agent: unpriced } = await client.saveAgent(scriptedAgent({
    name: "Unpriced", model: { name: "unpriced-1" }, script: { turns: [{ text: "done" }] },
  }), "unpriced");
  const { run: unpricedRun } = await client.startRun({ agentId: unpriced.id, message: "go", limits: { maxCostMicros: 1000 } });
  const { run: unpricedDone } = await waitForStatus(client, unpricedRun.id, ["completed", "waiting"]);
  assert.equal(unpricedDone.status, "completed", "allowed by models.allowUnpricedModels");
  assert.equal(unpricedDone.usage.costUnknown, true);
});

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

/** Every .ts file under src/, as a path relative to the repository root with "/" separators. */
async function sourceFiles(): Promise<{ path: string; text: string }[]> {
  const names = (await readdir(SRC, { recursive: true })).filter((name) => name.endsWith(".ts"));
  return Promise.all(names.map(async (name) => ({
    path: `src/${relative(SRC, join(SRC, name)).split(sep).join("/")}`,
    text: await readFile(join(SRC, name), "utf8"),
  })));
}

/**
 * The places outside src/store that may open a bare SQLite store, each with the reason it needs no redacting
 * wrapper. A new call site fails the test until it is listed here with a reason (or wraps its store).
 */
const BARE_STORE_SITES: Record<string, string> = {
  "src/app/app.ts": "wraps it with redactingStore at once; only the secrets service sees the bare handle",
  "src/bench/compose.ts": "the benchmark creates its own agents and runs with generated text: no secrets, no callers",
  "src/cli/commands/host.ts": "retention archive reads journals and calls archiveJournal; it writes no caller text",
};

test("only the listed files open a SQLite store, and no server, trigger, engine or learning file imports it", async () => {
  const files = await sourceFiles();
  assert.ok(files.length > 50, "the source tree was read");
  const callers = files.filter((file) => !file.path.startsWith("src/store/") && file.text.includes("openSqliteStore(")).map((file) => file.path).sort();
  assert.deepEqual(callers, Object.keys(BARE_STORE_SITES).sort());
  const forbidden = files.filter((file) => /^src\/(server|triggers|engine|learning)\//.test(file.path))
    .filter((file) => /from\s+["'][^"']*store\/sqlite\.ts["']/.test(file.text) || /import\(\s*["'][^"']*store\/sqlite\.ts/.test(file.text))
    .map((file) => file.path);
  assert.deepEqual(forbidden, [], "these parts only ever receive a Store");
  const app = files.find((file) => file.path === "src/app/app.ts")?.text ?? "";
  assert.match(app, /redactingStore\(raw, createWriteRedaction\(secrets\)\)/);
});

test("createApp(...).store redacts: a named secret in a run's message is stored as the placeholder", { timeout: 30_000 }, async (t) => {
  const { app, client } = await startTestApp(t);
  const value = "wiring-secret-value-0042";
  await client.setSecret("WIRED_KEY", value);
  await app.store.saveAgent({ id: "wired", definition: scriptedAgent({ name: "Wired", secrets: ["WIRED_KEY"], script: { turns: [{ text: "ok" }] } }) });
  const { run } = await app.store.createRun({ agentId: "wired", input: { message: `use ${value}`, data: { [value]: value } } });
  assert.deepEqual(run.input, { message: "use [redacted]", data: { "[redacted]": "[redacted]" } });
  const created = (await app.store.readJournal(run.id)).find((record) => record.type === "run.created");
  assert.ok(created !== undefined && !JSON.stringify(created.data).includes(value));
});
