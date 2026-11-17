import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isRunwrightError } from "../../src/core/errors.ts";
import type { JsonObject } from "../../src/core/json.ts";
import type { RunContext } from "../../src/engine/types.ts";
import { createLogger } from "../../src/log/logger.ts";
import { createBuiltinTools } from "../../src/tools/builtin.ts";
import { createShellTool } from "../../src/tools/shell.ts";
import type { ToolContext, ToolOutput } from "../../src/tools/types.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { waitFor } from "../helpers/wait.ts";
import { createHarness, fakeModels, reply } from "../helpers/engine.ts";

async function shell(t: TestContext, options?: { timeoutMs?: number; outputBytes?: number; secrets?: Record<string, string>; signal?: AbortSignal }): Promise<{ workspace: string; run(args: JsonObject): Promise<ToolOutput> }> {
  const workspace = await makeTempDir(t, "runwright-shell-");
  const tool = createShellTool({ timeoutMs: options?.timeoutMs ?? 10_000, outputBytes: options?.outputBytes ?? 4096 });
  const context: ToolContext = {
    runId: "run_1",
    agentId: "agent_1",
    workspace,
    signal: options?.signal ?? new AbortController().signal,
    logger: createLogger({ write: () => undefined }),
    secrets: options?.secrets ?? {},
    steps: { journal: () => [] } as unknown as RunContext,
  };
  return { workspace, run: (args) => tool.handler(args, context) };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("returns the exit code and combined output, run in the workspace with HOME set to it", async (t) => {
  const s = await shell(t);
  const ok = await s.run({ command: "echo out; echo err 1>&2; pwd; echo \"$HOME\"; echo hi > made.txt" });
  assert.equal(ok.isError, false);
  const lines = ok.content.split("\n");
  assert.equal(lines[0], "exit 0");
  assert.ok(lines.includes("out") && lines.includes("err"));
  assert.equal(lines.filter((line) => line === s.workspace).length, 2);
  assert.equal(await readFile(join(s.workspace, "made.txt"), "utf8"), "hi\n");
  const failed = await s.run({ command: "echo nope; exit 3" });
  assert.equal(failed.isError, true);
  assert.equal(failed.content, "exit 3\nnope\n");
  assert.equal((failed.data as JsonObject)["exitCode"], 3);
});

test("a timeout kills the whole process tree", async (t) => {
  const s = await shell(t, { timeoutMs: 10_000 });
  const started = Date.now();
  const result = await s.run({ command: "sleep 30 & echo $! > child.pid; sleep 30", timeout_ms: 300 });
  assert.ok(Date.now() - started < 5000);
  assert.equal(result.isError, true);
  assert.match(result.content, /^timeout\n/);
  assert.equal((result.data as JsonObject)["timedOut"], true);
  const pid = Number((await readFile(join(s.workspace, "child.pid"), "utf8")).trim());
  assert.ok(pid > 0);
  await waitFor(() => !isAlive(pid), { timeoutMs: 3000, message: "background child still alive" });
});

test("a timeout above the longest single timer still lets a command run to completion", async (t) => {
  const s = await shell(t, { timeoutMs: 3_000_000_000 });
  const result = await s.run({ command: "sleep 0.05; echo hi" });
  assert.equal(result.isError, false);
  assert.equal(result.content, "exit 0\nhi\n");
  assert.equal((result.data as JsonObject)["exitCode"], 0);
  assert.equal((result.data as JsonObject)["timedOut"], false);
});

test("a command that ignores SIGTERM is killed after the grace period", async (t) => {
  const s = await shell(t, { timeoutMs: 200 });
  const started = Date.now();
  const result = await s.run({ command: "trap '' TERM; sleep 30" });
  assert.match(result.content, /^timeout/);
  assert.ok(Date.now() - started < 4000);
});

test("a process that left the group and holds the output open does not hold the call past the timeout", { timeout: 15_000 }, async (t) => {
  const s = await shell(t, { timeoutMs: 200 });
  const script = "const c=require('child_process').spawn('sleep',['30'],{detached:true,stdio:['ignore','inherit','inherit']});" +
    "require('fs').writeFileSync('escaped.pid',String(c.pid));c.unref();";
  const started = Date.now();
  let result: ToolOutput;
  try {
    result = await s.run({ command: `"${process.execPath}" -e "${script}"; echo started` });
  } finally {
    const pid = Number((await readFile(join(s.workspace, "escaped.pid"), "utf8").catch(() => "0")).trim());
    if (pid > 0 && isAlive(pid)) process.kill(pid, "SIGKILL");
  }
  assert.ok(Date.now() - started < 6000, `took ${Date.now() - started} ms`);
  assert.match(result.content, /^timeout\nstarted\n/);
  assert.equal((result.data as JsonObject)["timedOut"], true);
});

test("output beyond the cap is dropped, keeping the head", async (t) => {
  const s = await shell(t, { outputBytes: 100 });
  const result = await s.run({ command: "printf 'H%.0s' $(seq 1 100); printf 'T%.0s' $(seq 1 400)" });
  assert.equal(result.isError, false);
  const [status, body] = result.content.split("\n");
  assert.equal(status, "exit 0");
  assert.equal(body, "H".repeat(100));
  assert.match(result.content, /\[output truncated: 400 more bytes dropped\]$/);
  assert.equal((result.data as JsonObject)["droppedBytes"], 400);
});

test("an abort signal stops the command and rejects with aborted", async (t) => {
  const controller = new AbortController();
  const s = await shell(t, { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  const started = Date.now();
  await assert.rejects(s.run({ command: "sleep 30" }), (e: unknown) => isRunwrightError(e) && e.code === "aborted");
  assert.ok(Date.now() - started < 4000);
});

test("the handed secrets are present in the environment, and the parent environment is not", async (t) => {
  process.env["RUNWRIGHT_SHELL_TEST_LEAK"] = "leaked";
  t.after(() => {
    delete process.env["RUNWRIGHT_SHELL_TEST_LEAK"];
  });
  const s = await shell(t, { secrets: { API_TOKEN: "tok-abcdefgh" } });
  const result = await s.run({ command: "echo \"token=$API_TOKEN\"; echo \"leak=${RUNWRIGHT_SHELL_TEST_LEAK:-none}\"" });
  assert.equal(result.content, "exit 0\ntoken=tok-abcdefgh\nleak=none\n");
});

test("shell is created only when enabled, and its default policy is ask", () => {
  const base = { files: { maxReadBytes: 10, maxWriteBytes: 10 }, webFetch: { timeoutMs: 10, maxBytes: 10, maxRedirects: 1 } };
  const off = createBuiltinTools({ ...base, shell: { enabled: false, timeoutMs: 10, outputBytes: 10 } });
  assert.deepEqual(off.map((tool) => tool.name), ["read_file", "write_file", "edit_file", "list_files", "delete_file", "ask_person", "web_fetch"]);
  const on = createBuiltinTools({ ...base, shell: { enabled: true, timeoutMs: 10, outputBytes: 10 } });
  const tool = on.find((entry) => entry.name === "shell");
  assert.ok(tool);
  assert.equal(tool.defaultPolicy, "ask");
  assert.equal(tool.effect, "write");
  assert.equal(tool.parameters["additionalProperties"], false);
  for (const entry of on) assert.ok(entry.description.length > 30, entry.name);
});

test("shell output is declared untrusted, and the engine journals its results untrusted", async (t) => {
  const tool = createShellTool({ timeoutMs: 10_000, outputBytes: 4096 });
  assert.equal(tool.untrustedOutput, true);
  const models = fakeModels((request) => (request.meta.turn === 1
    ? reply({ toolCalls: [{ id: "1", name: "shell", args: { command: "echo fetched page" } }] })
    : reply({ text: "ok" })));
  const h = await createHarness(t, { models, tools: [tool] });
  const agent = await h.saveAgent({ tools: [{ name: "shell", policy: "allow" }] });
  const run = await h.start(agent.id);
  await h.until(run.id, "completed");
  const [finished] = await h.records(run.id, "tool.finished");
  assert.equal(finished?.tool, "shell");
  assert.equal(finished?.content, "exit 0\nfetched page\n");
  assert.equal(finished?.untrusted, true);
});
