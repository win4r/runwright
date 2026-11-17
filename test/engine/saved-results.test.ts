/**
 * Saved result files through the real engine: results that finish at the same moment under step keys that
 * sanitize alike keep their own files (finding R06-01, the reviewer's probe), long step keys save, a retried
 * call saves its file once, and the size limit cuts every `tool.finished`, a person's skip result included.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, type JsonObject } from "../../src/core/json.ts";
import type { ModelRequest } from "../../src/models/types.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import type { Driver } from "../../src/engine/types.ts";
import type { JournalDataMap } from "../../src/engine/journal-types.ts";
import { newRecord } from "../../src/engine/journal-types.ts";
import { savedResultName } from "../../src/engine/results.ts";
import { createHarness, fakeModels, reply, toolReply, type Harness } from "../helpers/engine.ts";

type Finished = JournalDataMap["tool.finished"];

const FILL = 40_000;
const TRUSTED = ".runwright/tool-results";
const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const noModels = fakeModels(() => reply({ text: "unused" }));

/** A read tool `big` with args `{fill}` whose invocations wait until `parties` of them have arrived. */
function barrierTool(parties: number): ToolDefinition {
  let arrived = 0;
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    name: "big", description: "Returns a long result.", effect: "read",
    parameters: { type: "object", required: ["fill"], properties: { fill: { type: "string" } } },
    handler: async (args) => {
      const fill = String(args["fill"]);
      arrived++;
      if (arrived >= parties) open();
      await gate;
      return { content: fill.repeat(FILL), data: { blob: fill.repeat(FILL) } };
    },
  };
}

async function finishedByKey(h: Harness, runId: string): Promise<Map<string, Finished>> {
  const byKey = new Map<string, Finished>();
  for (const record of await h.journal(runId)) {
    if (record.type === "tool.finished") byKey.set(record.key ?? "", record.data as unknown as Finished);
  }
  return byKey;
}

/** The file at `path` exists, matches its journalled digest and length, and holds `expected`. */
async function verify(workspace: string, path: string | null | undefined, digest: string | undefined, bytes: number | undefined, expected: string): Promise<void> {
  assert.ok(typeof path === "string");
  const onDisk = await readFile(join(workspace, path));
  assert.equal(sha256(onDisk), digest, path);
  assert.equal(onDisk.length, bytes, path);
  assert.equal(onDisk.toString("utf8"), expected, path);
}

async function concurrentBigCalls(t: Parameters<typeof createHarness>[0], calls: ReadonlyArray<readonly [string, string]>) {
  const driver: Driver = async (ctx) => {
    const results = await Promise.all(calls.map(([key, fill]) => ctx.tool(key, { name: "big", args: { fill } })));
    return results.map((r) => r.outcome);
  };
  const h = await createHarness(t, { models: noModels, tools: [barrierTool(calls.length)], drivers: { agent: driver } });
  const agent = await h.saveAgent({ tools: [{ name: "big" }] });
  const run = await h.start(agent.id);
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, calls.map(() => "ok"));
  const workspace = join(h.dir, "workspaces", run.id);
  const byKey = await finishedByKey(h, run.id);
  const paths: string[] = [];
  for (const [key, fill] of calls) {
    const finished = byKey.get(key);
    assert.ok(finished !== undefined, key);
    assert.equal(finished.truncated, true);
    assert.equal(finished.data, null);
    const text = fill.repeat(FILL);
    const json = canonicalJson({ blob: fill.repeat(FILL) });
    await verify(workspace, finished.fullResultPath, finished.fullResultSha256, finished.fullResultBytes, text);
    await verify(workspace, finished.fullDataPath, finished.fullDataSha256, finished.fullDataBytes, json);
    assert.equal(finished.fullResultPath, `${TRUSTED}/${savedResultName(key, sha256(text))}.txt`);
    assert.equal(finished.fullDataPath, `${TRUSTED}/${savedResultName(key, sha256(json))}.data.json`);
    paths.push(finished.fullResultPath ?? "", finished.fullDataPath ?? "");
  }
  assert.equal(new Set(paths).size, calls.length * 2, "every result has its own two files");
  return { h, workspace };
}

test("R06-01: two over-long results finishing together under keys that sanitize alike keep their own files", async (t) => {
  await concurrentBigCalls(t, [["wf/a[0]/b#1", "A"], ["wf/a_0__b#1", "B"]]);
});

test("eight concurrent results under keys with the same readable label give sixteen intact files", async (t) => {
  const odd = ["/", "[", "]", "#", ">", "@", ":", " "];
  const calls = odd.map((c, i) => [`wf${c}a${odd[(i + 3) % odd.length]}1`, String.fromCharCode(67 + i)] as const);
  assert.equal(new Set(calls.map(([key]) => key)).size, 8);
  assert.equal(new Set(calls.map(([key]) => savedResultName(key, "0".repeat(64)).split("-")[0])).size, 1, "one label for all");
  const { workspace } = await concurrentBigCalls(t, calls);
  assert.equal((await readdir(join(workspace, TRUSTED))).length, 16);
});

test("a 400-character step key saves its full result and the run completes", async (t) => {
  const key = `${`wf/${"n".repeat(60)}[0]/`.repeat(6)}x#1`;
  assert.ok(key.length >= 400);
  const driver: Driver = async (ctx) => (await ctx.tool(key, { name: "big", args: { fill: "L" } })).outcome;
  const h = await createHarness(t, { models: noModels, tools: [barrierTool(1)], drivers: { agent: driver } });
  const agent = await h.saveAgent({ tools: [{ name: "big" }] });
  const run = await h.start(agent.id);
  const done = await h.until(run.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  const finished = (await finishedByKey(h, run.id)).get(key);
  assert.ok(finished !== undefined);
  const workspace = join(h.dir, "workspaces", run.id);
  await verify(workspace, finished.fullResultPath, finished.fullResultSha256, finished.fullResultBytes, "L".repeat(FILL));
  await verify(workspace, finished.fullDataPath, finished.fullDataSha256, finished.fullDataBytes, canonicalJson({ blob: "L".repeat(FILL) }));
  for (const path of [finished.fullResultPath ?? "", finished.fullDataPath ?? ""]) {
    assert.ok(Buffer.byteLength(path.slice(path.lastIndexOf("/") + 1)) <= 132, path);
  }
});

test("a retry-safe call run again after a crash before its finish saves its full result once", async (t) => {
  let invocations = 0;
  let harness: Harness | null = null;
  const tool: ToolDefinition = {
    name: "report", description: "A long deterministic report.", effect: "read", parameters: { type: "object", properties: {} },
    handler: async () => {
      invocations++;
      const result = { content: "r".repeat(FILL) };
      if (invocations === 1) await (harness as Harness).crashAndReplace();
      return result;
    },
  };
  const driver: Driver = async (ctx) => (await ctx.tool("wf/report#1", { name: "report", args: {} })).outcome;
  const h = await createHarness(t, { models: noModels, tools: [tool], drivers: { agent: driver } });
  harness = h;
  const agent = await h.saveAgent({ tools: [{ name: "report" }] });
  const run = await h.start(agent.id);
  const done = await h.until(run.id, ["completed", "failed"], 10_000);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.equal(invocations, 2);
  assert.deepEqual((await h.records(run.id, "tool.started")).map((r) => r.attempt), [1, 2]);
  const finishes = await h.records(run.id, "tool.finished");
  assert.equal(finishes.length, 1);
  const [finished] = finishes;
  assert.ok(finished !== undefined);
  const workspace = join(h.dir, "workspaces", run.id);
  await verify(workspace, finished.fullResultPath, finished.fullResultSha256, finished.fullResultBytes, "r".repeat(FILL));
  assert.deepEqual(await readdir(join(workspace, TRUSTED)), [
    `${savedResultName("wf/report#1", sha256("r".repeat(FILL)))}.txt`,
  ]);
});

// ---------------------------------------------------------------- the limit on every tool.finished

function lastToolContent(request: ModelRequest): string {
  const tools = request.messages.filter((m) => m.role === "tool");
  const last = tools[tools.length - 1];
  return last !== undefined && last.role === "tool" ? last.content : "";
}

function modelsCalling(tool: string, args: JsonObject = {}) {
  return fakeModels((request) => (request.meta.turn === 1 ? toolReply(tool, args) : reply({ text: lastToolContent(request).slice(0, 50) })));
}

const writeNote: ToolDefinition = {
  name: "write_note", description: "Writes a note.", effect: "write", parameters: { type: "object", properties: {} },
  handler: async () => ({ content: "written" }),
};

/** The journal of a runner that died between tool.started and tool.finished of a write tool. */
async function crashedRun(h: Harness, agentId: string): Promise<string> {
  const run = await h.start(agentId);
  const [claimed] = await h.store.claimRuns({ runnerId: "runner_dead", limit: 1, leaseMs: 50 });
  assert.ok(claimed !== undefined && claimed.run.id === run.id);
  const model = "scripted/scripted-1";
  await h.store.commit(claimed.lease, {
    records: [
      newRecord("run.claimed", { runnerId: "runner_dead" }),
      newRecord("model.started", {
        model, purpose: "run", step: null, turn: 1, countsAsTurn: true, inputTokensEstimate: 10, maxOutputTokens: 100, worstCaseMicros: 510,
      }, "t1"),
      newRecord("model.finished", {
        model, purpose: "run", text: "", toolCalls: [{ id: "call_1", name: "write_note", args: {} }], output: null, stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, costMicros: 35, durationMs: 1,
      }, "t1"),
      newRecord("tool.started", { callId: "call_1", tool: "write_note", args: {}, effect: "write", attempt: 1 }, "t1.c0"),
    ],
    counters: { toolCalls: 1, turns: 1 },
  });
  return run.id;
}

async function skipWith(t: Parameters<typeof createHarness>[0], result: string, secrets?: Record<string, string>) {
  const h = await createHarness(t, {
    models: modelsCalling("write_note"), tools: [writeNote], autoStart: false, ...(secrets === undefined ? {} : { secrets }),
  });
  const agent = await h.saveAgent({ tools: [{ name: "write_note" }], ...(secrets === undefined ? {} : { secrets: Object.keys(secrets) }) });
  const runId = await crashedRun(h, agent.id);
  h.runner.start();
  await h.until(runId, "waiting");
  const [pending] = await h.pendings(runId);
  assert.ok(pending !== undefined && pending.kind === "interrupted");
  await h.send(runId, { type: "resolve_interrupted", pendingId: pending.id, action: "skip", result });
  const done = await h.until(runId, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  const [finished] = await h.records(runId, "tool.finished");
  assert.ok(finished !== undefined);
  return { h, finished, workspace: join(h.dir, "workspaces", runId) };
}

test("L1: a person's 100 000-byte skip result is cut by the size limit and saved whole", async (t) => {
  const result = "R".repeat(100_000);
  const { finished, workspace } = await skipWith(t, result);
  assert.equal(finished.outcome, "skipped");
  assert.equal(finished.truncated, true);
  assert.equal(finished.untrusted, false);
  assert.equal(finished.fullResultPath, `${TRUSTED}/${savedResultName("t1.c0", sha256(result))}.txt`);
  assert.equal(finished.fullResultBytes, 100_000);
  await verify(workspace, finished.fullResultPath, finished.fullResultSha256, finished.fullResultBytes, result);
  const note = `\n[truncated: 16384 of 100000 bytes; full result saved to ${finished.fullResultPath}]`;
  assert.equal(finished.content, `${"R".repeat(16_384)}${note}`);
  assert.ok(Buffer.byteLength(finished.content) <= 16_384 + Buffer.byteLength(note));
  assert.equal(Object.hasOwn(finished, "fullDataPath"), false);
});

test("a skip result is redacted before it is cut and saved", async (t) => {
  const secret = "sk-test-0123456789abcdef";
  const result = `${"S".repeat(20_000)} key=${secret} ${"T".repeat(80_000)}`;
  const { finished, workspace } = await skipWith(t, result, { API_KEY: secret });
  assert.equal(finished.truncated, true);
  assert.ok(!finished.content.includes(secret));
  const onDisk = await readFile(join(workspace, finished.fullResultPath ?? ""), "utf8");
  assert.ok(!onDisk.includes(secret));
  assert.ok(onDisk.includes("key=[redacted:API_KEY]"), onDisk.slice(19_990, 20_040));
  assert.equal(sha256(onDisk), finished.fullResultSha256);
});

test("a short skip result, a denial and invalid arguments journal exactly the fields they always did", async (t) => {
  const { finished: skipped } = await skipWith(t, "the note was already written");
  assert.deepEqual(skipped, {
    callId: "call_1", tool: "write_note", outcome: "skipped", content: "the note was already written", data: null, isError: false,
    untrusted: false, truncated: false, fullResultPath: null, durationMs: 0,
  });

  const strict: ToolDefinition = {
    name: "strict", description: "Needs n.", effect: "read", handler: async () => ({ content: "ran" }),
    parameters: { type: "object", required: ["n"], properties: { n: { type: "integer" } } },
  };
  const models = fakeModels((request) => (request.meta.turn === 1
    ? reply({ toolCalls: [{ id: "1", name: "blocked", args: {} }, { id: "2", name: "strict", args: {} }] })
    : reply({ text: "ok" })));
  const h = await createHarness(t, { models, tools: [writeNote, strict, { ...writeNote, name: "blocked" }], engine: { denyTools: ["blocked"] } });
  const agent = await h.saveAgent({ tools: [{ name: "blocked" }, { name: "strict" }] });
  const run = await h.start(agent.id);
  await h.until(run.id, "completed");
  const [denied, invalid] = await h.records(run.id, "tool.finished");
  assert.ok(denied !== undefined && invalid !== undefined);
  for (const [record, outcome] of [[denied, "denied"], [invalid, "invalid_args"]] as const) {
    assert.equal(record.outcome, outcome);
    assert.deepEqual(Object.keys(record), [
      "callId", "tool", "outcome", "content", "data", "isError", "untrusted", "truncated", "fullResultPath", "durationMs",
    ]);
    assert.deepEqual([record.truncated, record.fullResultPath, record.data, record.isError, record.untrusted, record.durationMs],
      [false, null, null, true, false, 0]);
  }
});
