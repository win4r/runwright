import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RunwrightError, isRunwrightError } from "../../src/core/errors.ts";
import { canonicalJson, type Json, type JsonObject } from "../../src/core/json.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import type { Driver, ModelStepRequest } from "../../src/engine/types.ts";
import { deniedContent, limitToolResult, modelStepResult, savedResultName, toolStepResult } from "../../src/engine/results.ts";
import { SERVER_DENY_REASON } from "../../src/engine/policy.ts";
import { createHarness, fakeModels, reply, toolReply } from "../helpers/engine.ts";
import { claimWorkspaceStage } from "../../src/tools/workspace-stage.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { waitFor } from "../helpers/wait.ts";

const big = "é".repeat(30) + "x".repeat(200);
const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const nameOf = (folder: string, key: string, bytes: Buffer | string, extension: ".txt" | ".data.json"): string =>
  `${folder}/${savedResultName(key, sha256(bytes))}${extension}`;

/** A fresh workspace whose stage is claimed for epoch 1, as a session claims it before its first step. */
async function stagedWorkspace(t: TestContext): Promise<string> {
  const workspace = await makeTempDir(t, "runwright-results-");
  await claimWorkspaceStage(workspace, 1);
  return workspace;
}

function bigTool(name: string, extra: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name, description: name, parameters: { type: "object", properties: {} }, effect: "read",
    handler: async () => ({ content: big, data: { blob: "y".repeat(500) } }), ...extra,
  };
}

test("an oversized tool result is cut on a character boundary with a note, and saved whole in the workspace", async (t) => {
  const models = fakeModels((request) => (request.meta.turn === 1
    ? reply({ toolCalls: [{ id: "1", name: "big", args: {} }, { id: "2", name: "web", args: {} }, { id: "3", name: "marked", args: {} }] })
    : reply({ text: "ok" })));
  const tools = [
    bigTool("big"),
    bigTool("web", { untrustedOutput: true }),
    bigTool("marked", { handler: async () => ({ content: big, untrusted: true }) }),
  ];
  const h = await createHarness(t, { models, tools, engine: { toolResultBytes: 25 } });
  const agent = await h.saveAgent({ tools: [{ name: "big" }, { name: "web" }, { name: "marked" }] });
  const run = await h.start(agent.id);
  await h.until(run.id, "completed");
  const [plain, web, marked] = await h.records(run.id, "tool.finished");
  assert.ok(plain !== undefined && web !== undefined && marked !== undefined);

  const shown = "é".repeat(12);
  assert.equal(Buffer.byteLength(shown), 24);
  const blob = canonicalJson({ blob: "y".repeat(500) });
  assert.equal(plain.content, `${shown}\n[truncated: 24 of ${Buffer.byteLength(big)} bytes; full result saved to ${plain.fullResultPath}]`
    + `\n[data omitted: ${Buffer.byteLength(blob)} bytes of structured data; saved to ${plain.fullDataPath}]`);
  assert.equal(plain.truncated, true);
  assert.equal(plain.data, null);
  assert.equal(plain.fullResultPath, nameOf(".runwright/tool-results", "t1.c0", big, ".txt"));
  assert.equal(plain.fullDataPath, nameOf(".runwright/tool-results", "t1.c0", blob, ".data.json"));
  const workspace = join(h.dir, "workspaces", run.id);
  assert.equal(await readFile(join(workspace, plain.fullResultPath ?? ""), "utf8"), big);

  assert.equal(web.untrusted, true);
  assert.equal(web.fullResultPath, nameOf(".runwright/tool-results/untrusted", "t1.c1", big, ".txt"));
  assert.equal(await readFile(join(workspace, web.fullResultPath ?? ""), "utf8"), big);
  assert.equal(web.fullDataPath, nameOf(".runwright/tool-results/untrusted", "t1.c1", blob, ".data.json"));
  assert.equal(await readFile(join(workspace, web.fullDataPath ?? ""), "utf8"), blob);
  assert.equal(marked.untrusted, true);
  assert.match(marked.fullResultPath ?? "", /\/untrusted\//);
  assert.equal(Object.hasOwn(marked, "fullDataPath"), false, "no data, nothing saved");
});

test("limitToolResult returns the SHA-256 and the byte length of the saved file, trusted or untrusted, multi-byte too", async (t) => {
  const workspace = await stagedWorkspace(t);
  for (const [untrusted, content] of [[false, big], [true, big], [false, "😀 ünïcödé ".repeat(40)], [true, "ascii only ".repeat(40)]] as const) {
    const shaped = await limitToolResult({
      workspace, epoch: 1, key: "t1.c0", limitBytes: 25, outcome: "ok", content, data: null, isError: false, untrusted,
    });
    assert.equal(shaped.truncated, true);
    assert.ok(shaped.fullResultPath !== null);
    const onDisk = await readFile(join(workspace, shaped.fullResultPath));
    assert.equal(onDisk.toString("utf8"), content);
    assert.equal(shaped.fullResultPath, nameOf(untrusted ? ".runwright/tool-results/untrusted" : ".runwright/tool-results", "t1.c0", content, ".txt"));
    assert.equal(shaped.fullResultSha256, sha256(onDisk));
    assert.match(shaped.fullResultSha256 ?? "", /^[0-9a-f]{64}$/);
    assert.equal(shaped.fullResultBytes, (await stat(join(workspace, shaped.fullResultPath))).size);
    assert.equal(shaped.fullResultBytes, Buffer.byteLength(content, "utf8"));
  }
});

test("limitToolResult within the limit saves nothing and returns null digest and length", async (t) => {
  const workspace = await makeTempDir(t, "runwright-results-");
  const shaped = await limitToolResult({
    workspace, epoch: 1, key: "k", limitBytes: 1000, outcome: "ok", content: "small é", data: null, isError: false, untrusted: true,
  });
  assert.deepEqual([shaped.truncated, shaped.fullResultPath, shaped.fullResultSha256, shaped.fullResultBytes], [false, null, null, null]);
});

test("limitToolResult saves structured data over the limit with a note, a digest and a length", async (t) => {
  const data: Json = { title: "Résumé", rows: [1, 2, 3], nested: { text: "z".repeat(200), flag: true, none: null } };
  const json = canonicalJson(data);
  const bytes = Buffer.byteLength(json, "utf8");
  for (const untrusted of [false, true]) {
    const workspace = await stagedWorkspace(t);
    const shaped = await limitToolResult({
      workspace, epoch: 1, key: "wf/fetch#1", limitBytes: 64, outcome: "ok", content: "short", data, isError: false, untrusted,
    });
    const folder = untrusted ? ".runwright/tool-results/untrusted" : ".runwright/tool-results";
    const path = nameOf(folder, "wf/fetch#1", json, ".data.json");
    assert.equal(path, `${folder}/wf_fetch_1-${sha256("wf/fetch#1").slice(0, 16)}-${sha256(json)}.data.json`);
    assert.equal(shaped.fullDataPath, path);
    assert.equal(shaped.data, null);
    assert.equal(shaped.content, `short\n[data omitted: ${bytes} bytes of structured data; saved to ${path}]`);
    const onDisk = await readFile(join(workspace, shaped.fullDataPath));
    assert.equal(onDisk.toString("utf8"), json, "exactly the canonical JSON");
    assert.equal(shaped.fullDataSha256, sha256(onDisk));
    assert.equal(shaped.fullDataBytes, onDisk.length);
    assert.equal(shaped.fullDataBytes, bytes);
    assert.deepEqual([shaped.truncated, shaped.fullResultPath, shaped.fullResultSha256, shaped.fullResultBytes], [false, null, null, null]);
  }
});

test("limitToolResult with content and data over the limit: two files, the truncation note first", async (t) => {
  const workspace = await stagedWorkspace(t);
  const content = "c".repeat(100);
  const data: Json = { blob: "d".repeat(100) };
  const shaped = await limitToolResult({
    workspace, epoch: 1, key: "t1.c0", limitBytes: 32, outcome: "ok", content, data, isError: false, untrusted: true,
  });
  const dir = ".runwright/tool-results/untrusted";
  const text = `${savedResultName("t1.c0", sha256(content))}.txt`;
  const json = `${savedResultName("t1.c0", sha256(canonicalJson(data)))}.data.json`;
  assert.equal(shaped.content, `${"c".repeat(32)}\n[truncated: 32 of 100 bytes; full result saved to ${dir}/${text}]`
    + `\n[data omitted: ${Buffer.byteLength(canonicalJson(data))} bytes of structured data; saved to ${dir}/${json}]`);
  assert.deepEqual((await readdir(join(workspace, dir))).sort(), [json, text].sort());
  assert.equal(await readFile(join(workspace, dir, text), "utf8"), content);
  assert.equal(await readFile(join(workspace, dir, json), "utf8"), canonicalJson(data));
  assert.equal(shaped.data, null);
  assert.equal(shaped.truncated, true);
});

test("limitToolResult with data within the limit changes nothing and saves nothing", async (t) => {
  const workspace = await makeTempDir(t, "runwright-results-");
  const data: Json = { ok: true, n: 1 };
  const shaped = await limitToolResult({
    workspace, epoch: 1, key: "k", limitBytes: canonicalJson(data).length, outcome: "ok", content: "fine", data, isError: false, untrusted: true,
  });
  assert.deepEqual(shaped.data, data);
  assert.equal(shaped.content, "fine");
  assert.deepEqual([shaped.fullDataPath, shaped.fullDataSha256, shaped.fullDataBytes], [null, null, null]);
  assert.deepEqual(await readdir(workspace), []);
});

test("tool.finished journals the saved data file's path, digest and length, and none of them for a small result", async (t) => {
  const models = fakeModels((request) => (request.meta.turn === 1
    ? reply({ toolCalls: [{ id: "1", name: "wide", args: {} }, { id: "2", name: "small", args: {} }] })
    : reply({ text: "ok" })));
  const tools = [
    bigTool("wide", { untrustedOutput: true, handler: async () => ({ content: "rows", data: { rows: Array.from({ length: 20 }, (_, i) => `row ${i}`) } }) }),
    bigTool("small", { handler: async () => ({ content: "tiny", data: { n: 1 } }) }),
  ];
  const h = await createHarness(t, { models, tools, engine: { toolResultBytes: 64 } });
  const agent = await h.saveAgent({ tools: [{ name: "wide" }, { name: "small" }] });
  const run = await h.start(agent.id);
  await h.until(run.id, "completed");
  const [wide, small] = await h.records(run.id, "tool.finished");
  assert.ok(wide !== undefined && small !== undefined);
  const workspace = join(h.dir, "workspaces", run.id);
  assert.equal(wide.data, null);
  assert.equal(wide.truncated, false);
  const onDisk = await readFile(join(workspace, wide.fullDataPath ?? ""));
  assert.equal(wide.fullDataPath, nameOf(".runwright/tool-results/untrusted", "t1.c0", onDisk, ".data.json"));
  assert.deepEqual(JSON.parse(onDisk.toString("utf8")), { rows: Array.from({ length: 20 }, (_, i) => `row ${i}`) });
  assert.equal(wide.fullDataSha256, sha256(onDisk));
  assert.equal(wide.fullDataBytes, onDisk.length);
  assert.equal(wide.content, `rows\n[data omitted: ${onDisk.length} bytes of structured data; saved to ${wide.fullDataPath}]`);
  assert.deepEqual(small.data, { n: 1 });
  for (const field of ["fullDataPath", "fullDataSha256", "fullDataBytes"]) assert.equal(Object.hasOwn(small, field), false, field);
});

test("tool.finished carries the digest and length of a saved full result, and neither field otherwise", async (t) => {
  const models = fakeModels((request) => (request.meta.turn === 1
    ? reply({ toolCalls: [{ id: "1", name: "big", args: {} }, { id: "2", name: "web", args: {} }, { id: "3", name: "small", args: {} }, { id: "4", name: "blocked", args: {} }] })
    : reply({ text: "ok" })));
  const tools = [
    bigTool("big"),
    bigTool("web", { untrustedOutput: true }),
    bigTool("small", { handler: async () => ({ content: "tiny" }) }),
    bigTool("blocked"),
  ];
  const h = await createHarness(t, { models, tools, engine: { toolResultBytes: 25, denyTools: ["blocked"] } });
  const agent = await h.saveAgent({ tools: [{ name: "big" }, { name: "web" }, { name: "small" }, { name: "blocked" }] });
  const run = await h.start(agent.id);
  await h.until(run.id, "completed");
  const [plain, web, small, denied] = await h.records(run.id, "tool.finished");
  assert.ok(plain !== undefined && web !== undefined && small !== undefined && denied !== undefined);
  const workspace = join(h.dir, "workspaces", run.id);
  for (const saved of [plain, web]) {
    assert.equal(saved.truncated, true);
    const onDisk = await readFile(join(workspace, saved.fullResultPath ?? ""));
    assert.equal(saved.fullResultSha256, sha256(onDisk));
    assert.equal(saved.fullResultBytes, onDisk.length);
  }
  assert.equal(denied.outcome, "denied");
  // A denial is cut by the same limit (25 bytes here) and its full text saved like any other result.
  const denial = deniedContent("blocked", SERVER_DENY_REASON);
  assert.equal(denied.truncated, true);
  assert.equal(denied.fullResultPath, nameOf(".runwright/tool-results", "t1.c3", denial, ".txt"));
  const deniedOnDisk = await readFile(join(workspace, denied.fullResultPath ?? ""));
  assert.equal(deniedOnDisk.toString("utf8"), denial);
  assert.equal(denied.fullResultSha256, sha256(deniedOnDisk));
  assert.equal(denied.fullResultBytes, deniedOnDisk.length);
  assert.equal(small.fullResultPath, null);
  assert.equal(Object.hasOwn(small, "fullResultSha256"), false);
  assert.equal(Object.hasOwn(small, "fullResultBytes"), false);
});

test("a tool.finished journalled without the digest fields (before round 4) still replays", () => {
  const old = {
    callId: "c", tool: "big", outcome: "ok" as const, content: "cut", data: null, isError: false, untrusted: true,
    truncated: true, fullResultPath: ".runwright/tool-results/untrusted/1-k.txt", durationMs: 1,
  };
  assert.deepEqual(toolStepResult(old), { content: "cut", data: null, isError: false, outcome: "ok", untrusted: true });
});

const S = "7ce100971f64e7001e8fe5a51973ecdfe1ced42befe7ee8d5fd6219506b5393c";
const NAME = /^[a-z0-9][a-z0-9._-]*-[0-9a-f]{16}-[0-9a-f]{64}$/;
const TRUSTED = ".runwright/tool-results";

test("savedResultName gives the documented vectors, a bounded name and a different name per key", () => {
  assert.equal(sha256("x".repeat(64)), S);
  const vectors: Array<[string, string]> = [
    ["t1.c0", "t1.c0-b6f32aa255cbdabb"],
    ["wf/a[0]/b#1", "wf_a_0__b_1-f3d9af4fb9981ab4"],
    ["wf/a_0__b#1", "wf_a_0__b_1-6e7eb816e78cefc6"],
    ["T1.C0", "t1.c0-da90da64fb930de0"],
    ["", "result-e3b0c44298fc1c14"],
    ["///", "result-732c4e9711639ed1"],
    ["é/ü#2", "2-383c77f2148e0132"],
    [`wf/${"n".repeat(60)}[0]/${"m".repeat(60)}#1`, `${"m".repeat(38)}_1-4d8d6d7fdf686c00`],
  ];
  for (const [key, prefix] of vectors) assert.equal(savedResultName(key, S), `${prefix}-${S}`, key);
  for (const length of [0, 1, 40, 41, 255, 5000]) {
    for (const key of ["k".repeat(length), "/".repeat(length), "é#".repeat(length).slice(0, length), "😀".repeat(length)]) {
      const name = savedResultName(key, S);
      assert.match(name, NAME, key.slice(0, 20));
      assert.ok(Buffer.byteLength(name) <= 122, `${length}: ${name.length}`);
      assert.ok(Buffer.byteLength(`${name}.data.json`) <= 132);
    }
  }
  assert.notEqual(savedResultName("wf/a[0]/b#1", S), savedResultName("wf/a_0__b#1", S));
  assert.equal(savedResultName("wf/a[0]/b#1", S), savedResultName("wf/a[0]/b#1", S));
});

async function assertSaved(workspace: string, path: string | null, digest: string | null, expected: string): Promise<void> {
  assert.ok(path !== null && digest !== null);
  const onDisk = await readFile(join(workspace, path));
  assert.equal(onDisk.toString("utf8"), expected);
  assert.equal(sha256(onDisk), digest);
}

async function noTemp(workspace: string, folder = TRUSTED): Promise<void> {
  assert.deepEqual((await readdir(join(workspace, folder))).filter((name) => name.endsWith(".tmp")), []);
}

test("concurrent results under keys that sanitize alike get their own files (four distinct paths, all intact)", async (t) => {
  const workspace = await stagedWorkspace(t);
  const call = (key: string, fill: string) => limitToolResult({
    workspace, epoch: 1, key, limitBytes: 16, outcome: "ok", content: fill.repeat(100), data: { blob: fill.repeat(100) }, isError: false, untrusted: false,
  });
  const [a, b] = await Promise.all([call("wf/a[0]/b#1", "A"), call("wf/a_0__b#1", "B")]);
  assert.ok(a !== undefined && b !== undefined);
  const paths = [a.fullResultPath, a.fullDataPath, b.fullResultPath, b.fullDataPath];
  assert.equal(new Set(paths).size, 4);
  for (const [shaped, fill, key] of [[a, "A", "wf/a[0]/b#1"], [b, "B", "wf/a_0__b#1"]] as const) {
    await assertSaved(workspace, shaped.fullResultPath, shaped.fullResultSha256, fill.repeat(100));
    await assertSaved(workspace, shaped.fullDataPath, shaped.fullDataSha256, canonicalJson({ blob: fill.repeat(100) }));
    assert.equal(shaped.fullResultPath, nameOf(TRUSTED, key, fill.repeat(100), ".txt"));
    assert.equal(shaped.data, null);
  }

  const many = await stagedWorkspace(t);
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => limitToolResult({
    workspace: many, epoch: 1, key: i % 2 === 0 ? "wf/a[0]/b#1" : "wf/a_0__b#1", limitBytes: 16, outcome: "ok",
    content: `content ${i} `.repeat(20), data: null, isError: false, untrusted: false,
  })));
  assert.equal(new Set(results.map((r) => r.fullResultPath)).size, 20);
  for (const [i, shaped] of results.entries()) await assertSaved(many, shaped.fullResultPath, shaped.fullResultSha256, `content ${i} `.repeat(20));
  assert.equal((await readdir(join(many, TRUSTED))).length, 20);
});

test("the same key and content saved twice, one after the other or together, is one untouched file", async (t) => {
  const workspace = await stagedWorkspace(t);
  const call = () => limitToolResult({ workspace, epoch: 1, key: "t1.c0", limitBytes: 16, outcome: "ok", content: "z".repeat(200), data: null, isError: false, untrusted: false });
  const first = await call();
  assert.ok(first.fullResultPath !== null);
  const before = await stat(join(workspace, first.fullResultPath));
  const second = await call();
  assert.equal(second.fullResultPath, first.fullResultPath);
  assert.equal((await stat(join(workspace, first.fullResultPath))).ino, before.ino, "not replaced");
  const together = await Promise.all([call(), call(), call()]);
  for (const shaped of together) assert.equal(shaped.fullResultPath, first.fullResultPath);
  assert.equal((await stat(join(workspace, first.fullResultPath))).ino, before.ino, "not replaced");
  assert.deepEqual(await readdir(join(workspace, TRUSTED)), [first.fullResultPath.slice(TRUSTED.length + 1)]);
  await assertSaved(workspace, first.fullResultPath, first.fullResultSha256, "z".repeat(200));
});

test("the same key with different content, or different keys with the same content, give separate intact files", async (t) => {
  const workspace = await stagedWorkspace(t);
  const call = (key: string, content: string) => limitToolResult({ workspace, epoch: 1, key, limitBytes: 16, outcome: "ok", content, data: null, isError: false, untrusted: false });
  const one = await call("t1.c0", "1".repeat(100));
  const two = await call("t1.c0", "2".repeat(100));
  assert.notEqual(one.fullResultPath, two.fullResultPath);
  await assertSaved(workspace, one.fullResultPath, one.fullResultSha256, "1".repeat(100));
  await assertSaved(workspace, two.fullResultPath, two.fullResultSha256, "2".repeat(100));
  const left = await call("t2.c0", "3".repeat(100));
  const right = await call("t2.c1", "3".repeat(100));
  assert.notEqual(left.fullResultPath, right.fullResultPath);
  assert.equal(left.fullResultSha256, right.fullResultSha256);
  await assertSaved(workspace, left.fullResultPath, left.fullResultSha256, "3".repeat(100));
  await assertSaved(workspace, right.fullResultPath, right.fullResultSha256, "3".repeat(100));
});

test("keys that differ only in letter case get separate files", async (t) => {
  const workspace = await stagedWorkspace(t);
  const call = (key: string, content: string) => limitToolResult({ workspace, epoch: 1, key, limitBytes: 16, outcome: "ok", content, data: null, isError: false, untrusted: false });
  const lower = await call("t1.c0", "l".repeat(100));
  const upper = await call("T1.C0", "u".repeat(100));
  assert.notEqual(lower.fullResultPath?.toLowerCase(), upper.fullResultPath?.toLowerCase());
  await assertSaved(workspace, lower.fullResultPath, lower.fullResultSha256, "l".repeat(100));
  await assertSaved(workspace, upper.fullResultPath, upper.fullResultSha256, "u".repeat(100));
});

test("a file with other bytes under the final name is replaced by the right bytes, and no temp file is left", async (t) => {
  const workspace = await stagedWorkspace(t);
  const content = "q".repeat(100);
  const path = nameOf(TRUSTED, "t1.c0", content, ".txt");
  await mkdir(join(workspace, TRUSTED), { recursive: true });
  await writeFile(join(workspace, path), "garbage");
  const shaped = await limitToolResult({ workspace, epoch: 1, key: "t1.c0", limitBytes: 16, outcome: "ok", content, data: null, isError: false, untrusted: false });
  assert.equal(shaped.fullResultPath, path);
  await assertSaved(workspace, shaped.fullResultPath, shaped.fullResultSha256, content);
  await noTemp(workspace);
});

test("a 400-character step key saves under a name of at most 132 bytes, trusted and untrusted", async (t) => {
  const workspace = await stagedWorkspace(t);
  const key = `${`wf/${"n".repeat(60)}[0]/`.repeat(6)}x#1`;
  assert.ok(key.length >= 400, String(key.length));
  for (const untrusted of [false, true]) {
    const shaped = await limitToolResult({
      workspace, epoch: 1, key, limitBytes: 16, outcome: "ok", content: "w".repeat(100), data: { blob: "v".repeat(100) }, isError: false, untrusted,
    });
    await assertSaved(workspace, shaped.fullResultPath, shaped.fullResultSha256, "w".repeat(100));
    await assertSaved(workspace, shaped.fullDataPath, shaped.fullDataSha256, canonicalJson({ blob: "v".repeat(100) }));
    for (const path of [shaped.fullResultPath ?? "", shaped.fullDataPath ?? ""]) {
      const name = path.slice(path.lastIndexOf("/") + 1);
      assert.ok(Buffer.byteLength(name) <= 132, name);
    }
    await noTemp(workspace, untrusted ? `${TRUSTED}/untrusted` : TRUSTED);
  }
});

test("a result that cannot be saved throws an internal error naming the step", async (t) => {
  const workspace = await makeTempDir(t, "runwright-results-");
  await writeFile(join(workspace, ".runwright"), "not a folder");
  await assert.rejects(
    limitToolResult({ workspace, epoch: 1, key: "wf/x#1", limitBytes: 16, outcome: "ok", content: "e".repeat(100), data: null, isError: false, untrusted: false }),
    (error: unknown) => {
      assert.ok(error instanceof RunwrightError);
      assert.equal(error.code, "internal");
      assert.ok(error.message.startsWith("could not save the full result of step wf/x#1: "), error.message);
      return true;
    },
  );
});

const answerSchema = { type: "object", required: ["n"], properties: { n: { type: "integer" } }, additionalProperties: false };
const structured: ModelStepRequest = {
  purpose: "step", system: "Count.", messages: [{ role: "user", content: "how many?" }],
  output: { name: "Answer", schema: answerSchema },
};

test("invalid structured output gets one repair call: two records, the step result carries both calls' usage", async (t) => {
  const requests: string[] = [];
  const models = fakeModels((request) => {
    const lastMessage = request.messages[request.messages.length - 1];
    requests.push(lastMessage?.content ?? "");
    const repaired = request.messages.length > 1;
    return reply({ output: repaired ? { n: 3 } : { n: "three" }, usage: { inputTokens: 10, outputTokens: 2 } });
  });
  const driver: Driver = async (ctx) => {
    const result = await ctx.model("count", structured);
    return { output: result.output, usage: result.usage as unknown as JsonObject, costMicros: result.costMicros };
  };
  const h = await createHarness(t, { models, drivers: { agent: driver } });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id);
  const done = await h.until(run.id, "completed");
  const both = { inputTokens: 20, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 };
  assert.deepEqual(done.output, { output: { n: 3 }, usage: both, costMicros: 40 });
  assert.equal(requests.length, 2);
  assert.match(requests[1] ?? "", /"Answer"/);
  assert.match(requests[1] ?? "", /\$\.n/);
  const one = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const [invalid] = await h.records(run.id, "model.invalid");
  assert.deepEqual(invalid?.output, { n: "three" });
  assert.deepEqual(invalid?.usage, one);
  assert.equal(invalid?.costMicros, 20);
  const [finished] = await h.records(run.id, "model.finished");
  assert.deepEqual(finished?.usage, one, "model.finished carries the repair call's usage only");
  assert.equal(finished?.costMicros, 20);
  assert.deepEqual((await h.records(run.id, "model.started")).map((r) => r.repair), [false, true]);
  assert.equal(done.usage.costMicros, 40);
  assert.equal(done.usage.inputTokens, 20);
});

test("structured output still invalid after the repair fails with model_output_invalid and is charged", async (t) => {
  const models = fakeModels(() => reply({ output: { n: "never" }, usage: { inputTokens: 10, outputTokens: 2 } }));
  const driver: Driver = async (ctx) => (await ctx.model("count", structured)).output;
  const h = await createHarness(t, { models, drivers: { agent: driver } });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id);
  const failed = await h.until(run.id, "failed");
  assert.equal(failed.error?.code, "model_output_invalid");
  const [record] = await h.records(run.id, "model.failed");
  assert.equal(record?.error.code, "model_output_invalid");
  assert.match(record?.error.message ?? "", /is invalid after one repair/);
  assert.equal((await h.records(run.id, "model.invalid"))[0]?.costMicros, 20);
  assert.equal(failed.usage.costMicros, 40);
});

test("a model.failed step is replayed as the same error without calling the provider again", async (t) => {
  let calls = 0;
  const models = fakeModels(() => {
    calls++;
    throw new RunwrightError("model_failed", "provider said no");
  });
  const driver: Driver = async (ctx) => {
    let code = "none";
    try {
      await ctx.model("m", { purpose: "step", system: "s", messages: [{ role: "user", content: "x" }] });
    } catch (error) {
      if (!isRunwrightError(error)) throw error;
      code = `${error.code}: ${error.message}`;
    }
    await ctx.ask("q", { question: "go on?" });
    return { code };
  };
  const h = await createHarness(t, { models, drivers: { agent: driver } });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id);
  await h.until(run.id, "waiting");
  const [pending] = await h.pendings(run.id);
  await h.send(run.id, { type: "answer", pendingId: (pending as { id: string }).id, answer: "yes" });
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, { code: "model_failed: provider said no" });
  assert.equal(calls, 1);
});

test("an interrupted model call is charged its worst case, flagged assumed", async (t) => {
  let calls = 0;
  const models = fakeModels(async (_request, options) => {
    calls++;
    if (calls === 1) {
      await new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
    }
    return reply({ text: "ok", usage: { inputTokens: 7, outputTokens: 1 } });
  });
  const h = await createHarness(t, { models, engine: { defaultMaxOutputTokens: 100 } });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id);
  await waitFor(async () => (await h.journal(run.id)).some((r) => r.type === "model.started"));
  await h.crashAndReplace();
  const done = await h.until(run.id, "completed");
  const [started] = await h.records(run.id, "model.started");
  const [interrupted] = await h.records(run.id, "model.interrupted");
  assert.ok(started !== undefined && interrupted !== undefined && started.worstCaseMicros !== null);
  assert.equal(interrupted.reason, "crash");
  assert.equal(interrupted.assumedCostMicros, started.worstCaseMicros);
  assert.equal(done.usage.costMicros, started.worstCaseMicros + 7 + 5);
  assert.equal(done.usage.inputTokens, started.inputTokensEstimate + 7);
  const [row] = await h.store.usageSummary({ groupBy: "model" });
  assert.equal(row?.calls, 2);
  assert.equal(row?.costMicros, done.usage.costMicros);
});

test("deadlines: a slow model step fails with deadline_exceeded, a slow tool times out", async (t) => {
  const models = fakeModels(async (request, options) => {
    if (request.meta.key === "slow") {
      await new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
    }
    return toolReply("never", {});
  });
  const sluggish: ToolDefinition = {
    name: "sluggish", description: "Slow.", parameters: { type: "object", properties: {} }, effect: "read",
    handler: async (_args, context) => {
      await new Promise((_resolve, reject) => context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true }));
      return { content: "never" };
    },
  };
  const driver: Driver = async (ctx) => {
    let model = "ok";
    try {
      await ctx.model("slow", { purpose: "step", system: "s", messages: [{ role: "user", content: "x" }], deadlineMs: 30 });
    } catch (error) {
      if (!isRunwrightError(error)) throw error;
      model = error.code;
    }
    const tool = await ctx.tool("t", { name: "sluggish", args: {}, deadlineMs: 30 });
    return { model, tool: tool.outcome, content: tool.content };
  };
  const h = await createHarness(t, { models, tools: [sluggish], drivers: { agent: driver } });
  const agent = await h.saveAgent({ tools: [{ name: "sluggish" }] });
  const run = await h.start(agent.id);
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, { model: "deadline_exceeded", tool: "timeout", content: 'tool "sluggish" timed out after 30 ms' });
  assert.deepEqual((await h.records(run.id, "model.interrupted")).map((r) => r.reason), ["deadline"]);
});

test("a provider retry is journalled as its own attempt: model.retry between two model.started records", async (t) => {
  const sleeps: number[] = [];
  const models = fakeModels((request) => {
    if (request.meta.attempt === 1) {
      throw new RunwrightError("model_transient", "429 slow down", { details: { status: 429, retryAfterMs: 5, billing: "none" } });
    }
    return reply({ text: "after retry" });
  }, { policy: { maxAttempts: 3, baseMs: 1, maxMs: 10 }, random: () => 0, sleep: async (ms) => { sleeps.push(ms); } });
  const h = await createHarness(t, { models });
  const agent = await h.saveAgent();
  const run = await h.start(agent.id);
  await h.until(run.id, "completed");
  assert.deepEqual(await h.records(run.id, "model.retry"), [
    { attempt: 1, delayMs: 5, code: "model_transient", message: "429 slow down", status: 429, billing: "none", retryAfterMs: 5 },
  ]);
  assert.deepEqual(sleeps, [5]);
  const models_ = (await h.journal(run.id)).filter((r) => r.type.startsWith("model."));
  assert.deepEqual(models_.map((r) => [r.type, r.data["attempt"] ?? null]), [
    ["model.started", 1], ["model.retry", 1], ["model.started", 2], ["model.finished", null],
  ]);
});

test("a repaired model step's totals, the invalid reply's included, saturate at 2^53 - 1 (C9)", () => {
  const MAX = Number.MAX_SAFE_INTEGER;
  const usage = { inputTokens: MAX, outputTokens: 7, cacheReadTokens: MAX - 1, cacheWriteTokens: 0 };
  const base = { model: "scripted/scripted-1", purpose: "run" as const, text: "", toolCalls: [], output: null, durationMs: 1 };
  const finished = { ...base, stopReason: "end" as const, usage, costMicros: MAX };
  const invalid = { ...base, problems: [], usage: { inputTokens: 1, outputTokens: 3, cacheReadTokens: MAX, cacheWriteTokens: 2 }, costMicros: 5 };
  const result = modelStepResult(finished, invalid);
  assert.deepEqual(result.usage, { inputTokens: MAX, outputTokens: 10, cacheReadTokens: MAX, cacheWriteTokens: 2 });
  assert.equal(result.costMicros, MAX);
  assert.equal(modelStepResult(finished, { ...invalid, costMicros: null }).costMicros, null, "an unknown part keeps the cost unknown");
});
