import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { ModelRequest } from "../../src/models/types.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import type { Driver } from "../../src/engine/types.ts";
import { createHarness, fakeModels, miniAgentDriver, reply } from "../helpers/engine.ts";
import { waitFor } from "../helpers/wait.ts";

const SECRET = "tok-SECRET-value-42";
const MODEL_KEY = "mk-another-secret-99";
const forms = (value: string): string[] => [value, Buffer.from(value).toString("base64"), Buffer.from(value).toString("base64url")];

const noArgs = { type: "object", properties: {} };
const tools: ToolDefinition[] = [
  {
    name: "echo_secret", description: "Echoes the token.", parameters: noArgs, effect: "read",
    handler: async (_args, context) => ({
      content: `token is ${context.secrets["API_TOKEN"] ?? "missing"}; handed: ${Object.keys(context.secrets).join(",")}`,
      data: { token: context.secrets["API_TOKEN"] ?? null },
    }),
  },
  {
    name: "boom", description: "Fails.", parameters: noArgs, effect: "read",
    handler: async (_args, context) => {
      context.logger.info("about to fail", { using: context.secrets["API_TOKEN"] ?? null });
      throw new Error(`upstream refused ${context.secrets["API_TOKEN"] ?? ""}`);
    },
  },
  {
    name: "careful", description: "Needs approval.", parameters: { type: "object", properties: { value: { type: "string" } } }, effect: "write",
    handler: async (args) => ({ content: `stored ${String(args["value"])}` }),
  },
];

const models = fakeModels((request: ModelRequest) => {
  if (request.meta.turn === 1) {
    return reply({
      text: `thinking about ${SECRET}`,
      toolCalls: [
        { id: "a", name: "echo_secret", args: {} },
        { id: "b", name: "boom", args: {} },
        { id: "c", name: "careful", args: { value: `my ${SECRET}` } },
      ],
    });
  }
  const results = request.messages.flatMap((m) => (m.role === "tool" ? [m.content] : []));
  return reply({ text: `done: ${SECRET} / ${Buffer.from(SECRET).toString("base64")} / ${MODEL_KEY} / ${results.join(" | ")}` });
});

const driver: Driver = async (ctx) => {
  if (ctx.run.input.message === "fail") throw new Error(`could not use ${SECRET}`);
  return miniAgentDriver(ctx);
};

test("secrets handed to a run never reach the journal, pendings, run rows or logs", async (t) => {
  const h = await createHarness(t, {
    models, tools, drivers: { agent: driver }, secrets: { API_TOKEN: SECRET, MODEL_KEY, UNRELATED: "not-handed-1234" },
  });
  const agent = await h.saveAgent({
    model: { provider: "scripted", name: "scripted-1", apiKeySecret: "MODEL_KEY" },
    secrets: ["API_TOKEN"],
    tools: [{ name: "echo_secret" }, { name: "boom" }, { name: "careful", policy: "ask" }],
  });

  const run = await h.start(agent.id);
  await h.until(run.id, "waiting");
  const [approval] = await h.pendings(run.id);
  assert.ok(approval !== undefined);
  assert.match(approval.title, /\[redacted:API_TOKEN\]/);
  await h.send(run.id, { type: "approve", pendingId: approval.id, always: false });
  const done = await h.until(run.id, "completed");

  const failing = await h.start(agent.id, { message: "fail" });
  const failed = await h.until(failing.id, "failed");
  assert.match(failed.error?.message ?? "", /\[redacted:API_TOKEN\]/);

  const finished = await h.records(run.id, "tool.finished");
  assert.equal(finished[0]?.content, "token is [redacted:API_TOKEN]; handed: API_TOKEN");
  assert.equal(finished[1]?.outcome, "error");
  assert.equal(finished[1]?.content, "internal: upstream refused [redacted:API_TOKEN]");
  assert.match((done.output as { text: string }).text, /\[redacted:MODEL_KEY\]/);

  const everything = JSON.stringify({
    journals: [await h.journal(run.id), await h.journal(failing.id)],
    pendings: await h.store.listPendings({}, { limit: 100 }),
    runs: [await h.store.getRun(run.id), await h.store.getRun(failing.id)],
    logs: h.logLines,
  });
  for (const value of [SECRET, MODEL_KEY]) {
    for (const form of forms(value)) assert.ok(!everything.includes(form), `found ${form}`);
  }
  assert.ok(h.logLines.some((line) => line.includes("[redacted:API_TOKEN]")), "the tool's log line was written, redacted");
});

// ---------------------------------------------------------------- streamed deltas (R01-03)

const SPLIT_SECRET = "abcdefgh12345678";

/** Runs one turn whose provider streams `deltas` and answers `text`; returns the published delta texts and the run. */
async function streamed(t: TestContext, deltas: readonly string[], text: string) {
  const models = fakeModels(async (_request, options) => {
    for (const delta of deltas) options.onDelta?.(delta);
    return reply({ text });
  });
  const h = await createHarness(t, { models, secrets: { TOKEN: SPLIT_SECRET }, autoStart: false });
  const agent = await h.saveAgent({ secrets: ["TOKEN"] });
  const run = await h.start(agent.id);
  const published: string[] = [];
  const stop = h.events.subscribe(run.id, (event) => published.push(event.text));
  t.after(stop);
  h.runner.start();
  const done = await h.until(run.id, "completed");
  const [finished] = await h.records(run.id, "model.finished");
  return { published, finished: finished?.text ?? null, done };
}

test("a secret split across two deltas is never published, and the deltas add up to the redacted text", async (t) => {
  const { published, finished } = await streamed(t, ["abcdefgh", "12345678"], SPLIT_SECRET);
  assert.equal(finished, "[redacted:TOKEN]");
  assert.equal(published.join(""), finished);
  for (const text of published) {
    assert.ok(!text.includes(SPLIT_SECRET), `published ${text}`);
    assert.ok(!text.includes("abcdefgh"), "the first half was held back, not released");
  }
});

test("the base64 form split in three is redacted in the stream too", async (t) => {
  const encoded = Buffer.from(SPLIT_SECRET).toString("base64");
  const parts = [`key=${encoded.slice(0, 5)}`, encoded.slice(5, 14), `${encoded.slice(14)} end`];
  const { published, finished } = await streamed(t, parts, `key=${encoded} end`);
  assert.equal(finished, "key=[redacted:TOKEN] end");
  assert.equal(published.join(""), finished);
  for (const text of published) assert.ok(!text.includes(encoded) && !text.includes(SPLIT_SECRET));
});

test("text ending in a strict prefix of the secret is released at the end of the call", async (t) => {
  const { published, finished } = await streamed(t, ["the code is ", "abcd"], "the code is abcd");
  assert.equal(finished, "the code is abcd");
  assert.deepEqual(published, ["the code is ", "abcd"]);
  assert.equal(published.join(""), finished);
});

test("deltas with no secret prefix are published one to one, unchanged", async (t) => {
  const deltas = ["Hello ", "there, ", "friend!"];
  const { published, finished } = await streamed(t, deltas, deltas.join(""));
  assert.deepEqual(published, deltas);
  assert.equal(finished, deltas.join(""));
});

// ---------------------------------------------------------------- re-claim (round 4)

test("after a crash and a re-claim the definition's own secrets are registered again before the tool runs", async (t) => {
  let calls = 0;
  const echo: ToolDefinition = {
    name: "echo_later", description: "Hangs once, then echoes the token.", parameters: noArgs, effect: "read",
    handler: async (_args, context) => {
      calls++;
      if (calls === 1) {
        await new Promise((_resolve, reject) => context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true }));
      }
      return { content: `second session sees ${context.secrets["API_TOKEN"] ?? "missing"}` };
    },
  };
  const models = fakeModels((request) => (request.meta.turn === 1
    ? reply({ toolCalls: [{ id: "a", name: "echo_later", args: {} }] })
    : reply({ text: "done" })));
  const h = await createHarness(t, { models, tools: [echo], secrets: { API_TOKEN: SECRET } });
  const agent = await h.saveAgent({ secrets: ["API_TOKEN"], tools: [{ name: "echo_later" }] });
  const run = await h.start(agent.id);
  await waitFor(() => calls === 1);
  await h.crashAndReplace();
  await h.until(run.id, "completed");
  assert.equal(calls, 2);
  const finished = await h.records(run.id, "tool.finished");
  assert.deepEqual(finished.map((f) => f.content), ["second session sees [redacted:API_TOKEN]"]);
  const everything = JSON.stringify({ journal: await h.journal(run.id), run: await h.store.getRun(run.id), logs: h.logLines });
  for (const form of forms(SECRET)) assert.ok(!everything.includes(form), `found ${form}`);
});

// ---------------------------------------------------------------- numbers in payload values (R10-04)

const PIN_DIGITS = "12345678";
const PIN = 12345678;
const PIN_TEXT = "[redacted:PIN]";

const pinData: ToolDefinition = {
  name: "pin_data", description: "Returns a number it holds.", parameters: noArgs, effect: "read",
  handler: async () => ({ content: "ok", data: { pin: PIN, other: 42 } }),
};

/** Calls pin_data once and returns what ctx.tool handed back. */
const toolDriver: Driver = async (ctx) => {
  const result = await ctx.tool("only", { name: "pin_data", args: {}, callId: "c1" });
  return { data: result.data, content: result.content };
};

test("a tool's data holding the secret's digits is journalled, and handed back to the driver, as the placeholder", async (t) => {
  const h = await createHarness(t, {
    models: fakeModels(() => reply({ text: "unused" })), tools: [pinData], drivers: { agent: toolDriver }, secrets: { PIN: PIN_DIGITS },
  });
  const agent = await h.saveAgent({ secrets: ["PIN"], tools: [{ name: "pin_data" }] });
  const run = await h.start(agent.id);
  const done = await h.until(run.id, "completed");
  const [finished] = await h.records(run.id, "tool.finished");
  assert.deepEqual(finished?.data, { pin: PIN_TEXT, other: 42 });
  assert.equal(typeof finished?.durationMs, "number");
  assert.deepEqual((done.output as { data: unknown }).data, { pin: PIN_TEXT, other: 42 }, "the driver got the stored value");
  assert.ok(!JSON.stringify(await h.journal(run.id)).includes(PIN_DIGITS));
});

test("with a small result limit the saved full-data file holds the placeholder, never the digits", async (t) => {
  const h = await createHarness(t, {
    models: fakeModels(() => reply({ text: "unused" })), tools: [pinData], drivers: { agent: toolDriver }, secrets: { PIN: PIN_DIGITS },
    engine: { toolResultBytes: 8 },
  });
  const agent = await h.saveAgent({ secrets: ["PIN"], tools: [{ name: "pin_data" }] });
  const run = await h.start(agent.id);
  await h.until(run.id, "completed");
  const [finished] = await h.records(run.id, "tool.finished");
  assert.equal(finished?.data, null);
  assert.ok(typeof finished?.fullDataPath === "string");
  const saved = await readFile(join(h.dir, "workspaces", run.id, finished.fullDataPath), "utf8");
  assert.deepEqual(JSON.parse(saved), { other: 42, pin: PIN_TEXT });
  const files = (await readdir(join(h.dir, "workspaces", run.id), { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile());
  assert.ok(files.length >= 1);
  for (const file of files) assert.ok(!(await readFile(join(file.parentPath, file.name), "utf8")).includes(PIN_DIGITS), file.name);
});

test("a model's tool-call args and structured output holding the digits are journalled as the placeholder", async (t) => {
  const models = fakeModels((request) => (request.meta.turn === 1
    ? reply({ toolCalls: [{ id: "a", name: "take_code", args: { code: PIN, keep: 42 } }], output: { total: PIN, list: [PIN] } })
    : reply({ text: "done" })));
  const seen: unknown[] = [];
  const takeCode: ToolDefinition = {
    name: "take_code", description: "Takes a code.", parameters: noArgs, effect: "read",
    handler: async (args) => {
      seen.push(args["code"]);
      return { content: "taken" };
    },
  };
  const h = await createHarness(t, { models, tools: [takeCode], secrets: { PIN: PIN_DIGITS } });
  const agent = await h.saveAgent({ secrets: ["PIN"], tools: [{ name: "take_code" }] });
  const run = await h.start(agent.id);
  await h.until(run.id, "completed");
  const [first] = await h.records(run.id, "model.finished");
  assert.deepEqual(first?.toolCalls[0]?.args, { code: PIN_TEXT, keep: 42 });
  assert.deepEqual(first?.output, { total: PIN_TEXT, list: [PIN_TEXT] });
  assert.equal(typeof first?.usage.inputTokens, "number");
  const [started] = await h.records(run.id, "tool.started");
  assert.deepEqual(started?.args, { code: PIN_TEXT, keep: 42 });
  assert.equal(started?.attempt, 1);
  assert.deepEqual(seen, [PIN_TEXT], "the tool runs on the stored args, the same before and after a resume");
  assert.ok(!JSON.stringify(await h.journal(run.id)).includes(PIN_DIGITS));
});
