/**
 * Invariant R1 (round 4, finding R03-01): before a provider request of a run is sent, every secret value that
 * request carries is registered with the run's redactor, and stays registered for the session. Driven through
 * the real model registry and providers (with a fake fetch), reading the raw SQLite rows.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RunwrightError } from "../../src/core/errors.ts";
import type { Redactor } from "../../src/core/redact.ts";
import { secretForms } from "../../src/core/redact.ts";
import { createModelRegistry } from "../../src/models/registry.ts";
import type {
  GenerateOptions, ModelCredential, ModelProvider, ModelRef, ModelRegistry, ModelRequest, ModelResponse, ModelRetry,
} from "../../src/models/types.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import type { Driver, ModelStepRequest, SecretsReader } from "../../src/engine/types.ts";
import { createHarness, reply, type Harness } from "../helpers/engine.ts";
import { waitFor } from "../helpers/wait.ts";
import { fakeFetch, fragment, sse, type CapturedRequest, type FakeReply } from "../models/fake-fetch.ts";

const GRADER_KEY = "grader-key/value+with=marks";
const GRADER_REF: ModelRef = { provider: "openai-compatible", name: "grader", baseUrl: "http://127.0.0.1:9/v1", apiKeySecret: "GRADER_KEY" };
const answerSchema = { type: "object", required: ["echo"], properties: { echo: { type: "string" } } };
const noRetry = { maxAttempts: 1, baseMs: 1, maxMs: 1 };

/** A secrets reader over mutable values that counts how often each name was revealed. */
function countingReader(values: Record<string, string>): { reader: SecretsReader; reveals: Map<string, number> } {
  const reveals = new Map<string, number>();
  return {
    reveals,
    reader: {
      async reveal(names) {
        const out: Record<string, string> = {};
        for (const name of names) {
          reveals.set(name, (reveals.get(name) ?? 0) + 1);
          const value = values[name];
          if (value !== undefined) out[name] = value;
        }
        return out;
      },
    },
  };
}

const bearerOf = (call: CapturedRequest | undefined): string => (call?.headers["authorization"] ?? "").replace(/^Bearer /, "");
const b64 = (value: string): string => Buffer.from(value, "utf8").toString("base64");
const b64url = (value: string): string => Buffer.from(value, "utf8").toString("base64url");

/** An OpenAI-compatible streamed reply: text deltas, then tool calls, then usage. */
function openAiReply(deltas: readonly string[], calls: readonly { name: string; args: object }[] = []): FakeReply {
  const events: { data: unknown }[] = deltas.map((content) => ({ data: { choices: [{ index: 0, delta: { content }, finish_reason: null }] } }));
  calls.forEach((call, index) => {
    events.push({
      data: { choices: [{ index: 0, delta: { tool_calls: [{ index, id: `c${index}`, function: { name: call.name, arguments: JSON.stringify(call.args) } }] }, finish_reason: null }] },
    });
  });
  events.push({ data: { choices: [{ index: 0, delta: {}, finish_reason: calls.length > 0 ? "tool_calls" : "stop" }] } });
  events.push({ data: { choices: [], usage: { prompt_tokens: 3, completion_tokens: 4 } } });
  events.push({ data: "[DONE]" });
  return { chunks: fragment(sse(events), 7) };
}

/** Every raw row of the run in the journal, runs and pendings tables, and the harness log lines. */
function rawRows(h: Harness, runId: string): { journal: string[]; run: string; pendings: string; logs: string } {
  const db = new DatabaseSync(join(h.dir, "runwright.db"), { readOnly: true });
  try {
    const journal = db.prepare("SELECT data FROM journal WHERE run_id = ? ORDER BY seq").all(runId).map((row) => String(row["data"]));
    const run = JSON.stringify(db.prepare("SELECT * FROM runs WHERE id = ?").all(runId));
    const pendings = JSON.stringify(db.prepare("SELECT * FROM pendings WHERE run_id = ?").all(runId));
    return { journal, run, pendings, logs: h.logLines.join("\n") };
  } finally {
    db.close();
  }
}

function assertAbsent(where: string, text: string, ...values: string[]): void {
  for (const value of values) {
    for (const form of secretForms(value)) assert.equal(text.includes(form), false, `${where} holds ${JSON.stringify(form)}`);
  }
}

function assertNoKeyAnywhere(h: Harness, runId: string, ...values: string[]): void {
  const rows = rawRows(h, runId);
  assert.ok(rows.journal.length > 0);
  rows.journal.forEach((row, i) => assertAbsent(`journal row ${i + 1}`, row, ...values));
  assertAbsent("runs row", rows.run, ...values);
  assertAbsent("pendings rows", rows.pendings, ...values);
  assertAbsent("log lines", rows.logs, ...values);
}

const extraStep = (model: ModelRef, extra: Partial<ModelStepRequest> = {}): ModelStepRequest => ({
  purpose: "step", system: "Echo.", messages: [{ role: "user", content: "go" }], model, ...extra,
});

/** A harness on the real registry: the agent's own model is scripted, the grader key exists only in secrets. */
async function graderHarness(t: TestContext, replyFor: (key: string, call: number) => FakeReply, driver: Driver, autoStart = true) {
  const secrets = countingReader({ GRADER_KEY });
  let ff: ReturnType<typeof fakeFetch> | null = null;
  ff = fakeFetch((call) => replyFor(bearerOf(ff?.calls[call]), call));
  const models = createModelRegistry({ secrets: secrets.reader, retry: noRetry, fetch: ff.fetch, sleep: async () => undefined });
  const h = await createHarness(t, { models, secretsReader: secrets.reader, drivers: { agent: driver }, autoStart });
  return { h, ff, reveals: secrets.reveals };
}

test("the reviewer's probe: another model's key echoed in text, structured output and a tool call is never stored", async (t) => {
  const driver: Driver = async (ctx) => {
    const result = await ctx.model("extra", extraStep(GRADER_REF, {
      output: { name: "Answer", schema: answerSchema },
      tools: [{ name: "lookup", description: "Looks up.", parameters: { type: "object", properties: { q: { type: "string" } } } }],
    }));
    const { answer } = await ctx.ask("confirm", { question: `Keep this? ${result.text} ${JSON.stringify(result.toolCalls)}` });
    return { text: result.text, output: result.output, toolArgs: result.toolCalls.map((call) => call.args), answer };
  };
  const { h, ff, reveals } = await graderHarness(t, (key) => openAiReply(
    [`the key is ${key} `, `and in base64 ${b64(key)}`],
    [{ name: "Answer", args: { echo: `${key} ${encodeURIComponent(key)}` } }, { name: "lookup", args: { q: `${key} ${b64url(key)}` } }],
  ), driver);
  const agent = await h.saveAgent();
  const run = await h.start(agent.id);
  await h.until(run.id, "waiting");
  assert.equal(bearerOf(ff.calls[0]), GRADER_KEY, "the provider was sent the grader key");
  const revealsBefore = reveals.get("GRADER_KEY") ?? 0;
  assert.ok(revealsBefore >= 1);
  const [pending] = await h.pendings(run.id);
  assert.ok(pending !== undefined);
  assert.match(pending.title, /\[redacted:GRADER_KEY\]/);
  await h.send(run.id, { type: "answer", pendingId: pending.id, answer: "yes" });
  const done = await h.until(run.id, "completed");

  assertNoKeyAnywhere(h, run.id, GRADER_KEY);
  const [finished] = await h.records(run.id, "model.finished");
  assert.ok(finished !== undefined);
  assert.equal(finished.text, "the key is [redacted:GRADER_KEY] and in base64 [redacted:GRADER_KEY]");
  assert.deepEqual(finished.output, { echo: "[redacted:GRADER_KEY] [redacted:GRADER_KEY]" });
  assert.deepEqual(finished.toolCalls.map((c) => c.args), [{ q: "[redacted:GRADER_KEY] [redacted:GRADER_KEY]" }]);
  assert.match(JSON.stringify(done.output), /\[redacted:GRADER_KEY\]/);
  assert.equal(ff.calls.length, 1);
  // Pin: the second session replays the finished step from the journal and reveals the step's key no more.
  assert.equal(reveals.get("GRADER_KEY"), revealsBefore);
  assert.equal((await h.records(run.id, "run.claimed")).length, 2, "a second session replayed the finished step");
});

test("deltas that split another model's key at every position are never published in any form", async (t) => {
  const key = GRADER_KEY;
  const deltas: string[] = [];
  for (let i = 1; i < key.length; i++) deltas.push(`<${key.slice(0, i)}`, `${key.slice(i)}>`);
  deltas.push(`[${b64(key).slice(0, 5)}`, `${b64(key).slice(5)}]`);
  const driver: Driver = async (ctx) => ({ text: (await ctx.model("extra", extraStep(GRADER_REF))).text });
  const { h } = await graderHarness(t, () => openAiReply(deltas), driver, false);
  const agent = await h.saveAgent();
  const run = await h.start(agent.id);
  const published: string[] = [];
  t.after(h.events.subscribe(run.id, (event) => published.push(event.text)));
  h.runner.start();
  await h.until(run.id, "completed");

  const all = published.join("");
  assertAbsent("published deltas", all, key);
  const [finished] = await h.records(run.id, "model.finished");
  assert.equal(all, finished?.text);
  assert.equal(all, `${"<[redacted:GRADER_KEY]>".repeat(key.length - 1)}[[redacted:GRADER_KEY]]`);
  assertNoKeyAnywhere(h, run.id, key);
});

test("a provider error whose body echoes another model's key leaves no form of it in model.failed or the run error", async (t) => {
  const driver: Driver = async (ctx) => ({ text: (await ctx.model("extra", extraStep(GRADER_REF))).text });
  const { h } = await graderHarness(t, (key) => ({
    status: 400, text: JSON.stringify({ error: { message: `invalid key ${key} (base64 ${b64(key)}, url ${encodeURIComponent(key)})` } }),
  }), driver);
  const agent = await h.saveAgent();
  const run = await h.start(agent.id);
  const failed = await h.until(run.id, "failed");

  const [record] = await h.records(run.id, "model.failed");
  assert.ok(record !== undefined);
  assertAbsent("model.failed message", record.error.message, GRADER_KEY);
  assert.match(record.error.message, /\[redacted:GRADER_KEY\]/);
  assertAbsent("run error", failed.error?.message ?? "", GRADER_KEY);
  assert.match(failed.error?.message ?? "", /HTTP 400/);
  assertNoKeyAnywhere(h, run.id, GRADER_KEY);
});

test("a key rotated between two model steps of one session: neither value is stored", async (t) => {
  const KEY_A = "openai-key-value-AAAA";
  const KEY_B = "openai-key-value-BBBB";
  const values: Record<string, string> = { OPENAI_API_KEY: KEY_A };
  const secrets = countingReader(values);
  const rotate: ToolDefinition = {
    name: "rotate", description: "Rotates the key.", parameters: { type: "object", properties: {} }, effect: "read",
    handler: async () => {
      values["OPENAI_API_KEY"] = KEY_B;
      return { content: "rotated" };
    },
  };
  let ff: ReturnType<typeof fakeFetch> | null = null;
  ff = fakeFetch((call) => {
    const key = bearerOf(ff?.calls[call]);
    return call === 0 ? openAiReply([`turn one sent ${key}`], [{ name: "rotate", args: {} }]) : openAiReply([`turn two sent ${key}, before it ${KEY_A}`]);
  });
  const models = createModelRegistry({ secrets: secrets.reader, retry: noRetry, fetch: ff.fetch });
  const h = await createHarness(t, { models, secretsReader: secrets.reader, tools: [rotate] });
  const agent = await h.saveAgent({ model: { provider: "openai-compatible", name: "gpt" }, tools: [{ name: "rotate" }] });
  const run = await h.start(agent.id);
  await h.until(run.id, "completed");

  assert.deepEqual(ff.calls.map(bearerOf), [KEY_A, KEY_B], "each turn sent the key current at its resolve");
  assertNoKeyAnywhere(h, run.id, KEY_A, KEY_B);
  const finished = await h.records(run.id, "model.finished");
  assert.deepEqual(finished.map((f) => f.text), [
    "turn one sent [redacted:OPENAI_API_KEY]",
    "turn two sent [redacted:OPENAI_API_KEY], before it [redacted:OPENAI_API_KEY]",
  ]);
});

/** A registry whose providers expose no credentials, answering with `respond`. */
function bareRegistry(respond: (request: ModelRequest) => ModelResponse): ModelRegistry {
  return { resolve: async () => ({ generate: async (request: ModelRequest) => respond(request) }) };
}

test("a key the step's ref names is registered even when the provider object does not expose it", async (t) => {
  const VALUE = "scripted-grader-secret-1";
  const models = bareRegistry(() => reply({ text: `I was configured with ${VALUE}` }));
  const driver: Driver = async (ctx) => ({
    text: (await ctx.model("extra", extraStep({ provider: "scripted", name: "g", apiKeySecret: "GRADER_KEY" }))).text,
  });
  const h = await createHarness(t, { models, drivers: { agent: driver }, secrets: { GRADER_KEY: VALUE } });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id);
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, { text: "I was configured with [redacted:GRADER_KEY]" });
  assertNoKeyAnywhere(h, run.id, VALUE);
});

test("credentials are registered before every provider request: first attempt, retry, repair, and a step nested in a tool", async (t) => {
  const credentialFor = (ref: ModelRef): ModelCredential => ({ name: `CRED_${ref.name.toUpperCase()}`, value: `credential-of-${ref.name}-0042` });
  let runRedactor: Redactor | null = null;
  const checks: { name: string; attempt: number; repair: boolean; registered: boolean }[] = [];
  const retry: ModelRetry = { policy: { maxAttempts: 3, baseMs: 1, maxMs: 1 }, random: () => 0, sleep: async () => undefined };
  const models: ModelRegistry = {
    retry,
    async resolve(ref) {
      const credential = credentialFor(ref);
      const provider: ModelProvider = {
        credentials: [credential],
        async generate(request: ModelRequest, options: GenerateOptions): Promise<ModelResponse> {
          const repair = request.messages.length > 1;
          checks.push({ name: ref.name, attempt: request.meta.attempt, repair, registered: runRedactor?.contains(credential.value) === true });
          if (ref.name === "main" && request.meta.attempt === 1 && !repair) {
            throw new RunwrightError("model_transient", `overloaded for ${credential.value}`, { details: { status: 503, billing: "none" } });
          }
          options.onDelta?.(credential.value.slice(0, 9));
          options.onDelta?.(credential.value.slice(9));
          if (ref.name === "main" && !repair) return reply({ output: { wrong: credential.value } });
          return reply({ text: `uses ${credential.value}`, output: { echo: credential.value } });
        },
      };
      return provider;
    },
  };
  const nested: ToolDefinition = {
    name: "nested", description: "Calls a model.", parameters: { type: "object", properties: {} }, effect: "write", resumable: true,
    async handler(_args, context) {
      const inner = await context.steps.model("inner", extraStep({ provider: "scripted", name: "inner" }));
      return { content: inner.text };
    },
  };
  const driver: Driver = async (ctx) => {
    runRedactor = ctx.redactor;
    const main = await ctx.model("main", extraStep({ provider: "scripted", name: "main" }, { output: { name: "Answer", schema: answerSchema } }));
    const tool = await ctx.tool("call", { name: "nested", args: {} });
    return { main: main.output, tool: tool.content };
  };
  const h = await createHarness(t, { models, tools: [nested], drivers: { agent: driver }, autoStart: false });
  const agent = await h.saveAgent({ tools: [{ name: "nested" }] });
  const run = await h.start(agent.id);
  const published: string[] = [];
  t.after(h.events.subscribe(run.id, (event) => published.push(event.text)));
  h.runner.start();
  const done = await h.until(run.id, "completed");

  assert.deepEqual(checks, [
    { name: "main", attempt: 1, repair: false, registered: true },
    { name: "main", attempt: 2, repair: false, registered: true },
    { name: "main", attempt: 1, repair: true, registered: true },
    { name: "inner", attempt: 1, repair: false, registered: true },
  ]);
  assert.deepEqual(done.output, { main: { echo: "[redacted:CRED_MAIN]" }, tool: "uses [redacted:CRED_INNER]" });
  const main = credentialFor({ provider: "scripted", name: "main" }).value;
  const inner = credentialFor({ provider: "scripted", name: "inner" }).value;
  assertAbsent("published deltas", published.join(""), main, inner);
  assertNoKeyAnywhere(h, run.id, main, inner);
  const [retried] = await h.records(run.id, "model.retry");
  assert.equal(retried?.message, "overloaded for [redacted:CRED_MAIN]");
});

test("a reveal that fails ends the model step like a failed resolve: model.failed journalled, nothing sent", async (t) => {
  let sent = 0;
  const models = bareRegistry(() => {
    sent++;
    return reply({ text: "never" });
  });
  const reader: SecretsReader = {
    async reveal(names) {
      if (names.includes("GRADER_KEY")) throw new RunwrightError("internal", "the secret blob for GRADER_KEY is unreadable");
      return {};
    },
  };
  const driver: Driver = async (ctx) => ({
    text: (await ctx.model("extra", extraStep({ provider: "scripted", name: "g", apiKeySecret: "GRADER_KEY" }))).text,
  });
  const h = await createHarness(t, { models, secretsReader: reader, drivers: { agent: driver } });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id);
  const failed = await h.until(run.id, "failed");
  assert.equal(sent, 0);
  const [record] = await h.records(run.id, "model.failed");
  assert.deepEqual(record?.error, { code: "internal", message: "the secret blob for GRADER_KEY is unreadable" });
  assert.equal(failed.error?.code, "internal");
  assert.equal((await h.records(run.id, "model.started")).length, 0);
});

test("a step resumed by a new session after a crash registers the credential again before it is re-sent", async (t) => {
  const credential: ModelCredential = { name: "CRED_RESUMED", value: "resumed-credential-0099" };
  let runRedactor: Redactor | null = null;
  const sends: boolean[] = [];
  const models: ModelRegistry = {
    async resolve() {
      return {
        credentials: [credential],
        async generate(_request: ModelRequest, options: GenerateOptions): Promise<ModelResponse> {
          sends.push(runRedactor?.contains(credential.value) === true);
          if (sends.length === 1) {
            await new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
          }
          return reply({ text: `resumed with ${credential.value}` });
        },
      };
    },
  };
  const driver: Driver = async (ctx) => {
    runRedactor = ctx.redactor;
    return { text: (await ctx.model("extra", extraStep({ provider: "scripted", name: "resumed" }))).text };
  };
  const h = await createHarness(t, { models, drivers: { agent: driver } });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id);
  await waitFor(() => sends.length === 1);
  await h.crashAndReplace();
  const done = await h.until(run.id, "completed");
  assert.deepEqual(sends, [true, true]);
  assert.equal((await h.records(run.id, "run.claimed")).length, 2);
  assert.deepEqual((await h.records(run.id, "model.interrupted")).map((r) => r.reason), ["crash"]);
  assert.deepEqual(done.output, { text: "resumed with [redacted:CRED_RESUMED]" });
  assertNoKeyAnywhere(h, run.id, credential.value);
});
