/**
 * The built-in file tools on special files (finding R12-01): a FIFO with no writer must not block `read_file` or
 * `edit_file` inside `open()`. Every case that could block runs in a child process killed after a bound, so a
 * regression fails the test instead of hanging the suite.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import type { JsonObject } from "../../src/core/json.ts";
import { createFileTools } from "../../src/tools/fs.ts";
import type { ToolDefinition, ToolOutput } from "../../src/tools/types.ts";
import { makeFifo, printedJson, runBounded, specialFilesFixture } from "../helpers/special-files.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { fileToolContext } from "../helpers/tool-context.ts";

const noFifos = { skip: process.platform === "win32" };
const FILE_TOOL = specialFilesFixture("file-tool.ts");
const WAVES = specialFilesFixture("file-tool-waves.ts");

async function workspace(t: TestContext): Promise<string> {
  const root = join(await makeTempDir(t, "runwright-fs-special-"), "ws");
  await mkdir(root);
  return root;
}

async function toolInChild(root: string, tool: string, args: JsonObject): Promise<ToolOutput> {
  return printedJson(await runBounded(FILE_TOOL, [root, tool, JSON.stringify(args)])) as ToolOutput;
}

function tools(): Map<string, ToolDefinition> {
  return new Map(createFileTools({ maxReadBytes: 64, maxWriteBytes: 64 }).map((tool) => [tool.name, tool]));
}

async function call(root: string, tool: string, args: JsonObject, signal?: AbortSignal): Promise<ToolOutput> {
  const definition = tools().get(tool);
  assert.ok(definition !== undefined, tool);
  return definition.handler(args, await fileToolContext(root, signal === undefined ? {} : { signal }));
}

test("read_file on a FIFO with no writer answers 'not a regular file' at once", noFifos, async (t) => {
  const root = await workspace(t);
  makeFifo(join(root, "pipe"));
  assert.deepEqual(await toolInChild(root, "read_file", { path: "pipe" }), { content: "pipe: not a regular file", isError: true });
});

test("edit_file on a FIFO with no writer answers 'not a regular file' and leaves the FIFO in place", noFifos, async (t) => {
  const root = await workspace(t);
  makeFifo(join(root, "pipe"));
  const output = await toolInChild(root, "edit_file", { path: "pipe", old_text: "a", new_text: "b" });
  assert.deepEqual(output, { content: "pipe: not a regular file", isError: true });
  assert.ok((await lstat(join(root, "pipe"))).isFIFO());
});

test("read_file and edit_file on a socket answer 'not a regular file'", noFifos, async (t) => {
  const root = join(await makeTempDir(t, "rw-sock-"), "ws");
  await mkdir(root);
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(join(root, "s.sock"), resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  assert.deepEqual(await call(root, "read_file", { path: "s.sock" }), { content: "s.sock: not a regular file", isError: true });
  assert.deepEqual(await call(root, "edit_file", { path: "s.sock", old_text: "a", new_text: "b" }), {
    content: "s.sock: not a regular file", isError: true,
  });
});

test("four read_file calls on FIFOs at once do not use up the worker pool: a regular file is read after them", noFifos, async (t) => {
  const root = await workspace(t);
  for (const name of ["p1", "p2", "p3", "p4"]) makeFifo(join(root, name));
  await writeFile(join(root, "plain.txt"), "plain text");
  const waves = [
    ["p1", "p2", "p3", "p4"].map((path) => ["read_file", { path }]),
    [["read_file", { path: "plain.txt" }]],
  ];
  const outputs = printedJson(await runBounded(WAVES, [root, JSON.stringify(waves)])) as ToolOutput[][];
  assert.deepEqual(outputs[0]?.map((output) => output.content), [
    "p1: not a regular file", "p2: not a regular file", "p3: not a regular file", "p4: not a regular file",
  ]);
  assert.equal(outputs[1]?.[0]?.content, "plain text");
  assert.equal(outputs[1]?.[0]?.isError, undefined);
});

test("write_file onto a FIFO path is refused: exists and is not a regular file", noFifos, async (t) => {
  const root = await workspace(t);
  makeFifo(join(root, "pipe"));
  const output = await call(root, "write_file", { path: "pipe", content: "x" });
  assert.deepEqual(output, { content: "pipe: exists and is not a regular file", isError: true });
  assert.ok((await lstat(join(root, "pipe"))).isFIFO());
});

test("list_files lists a FIFO as (other); delete_file removes it", noFifos, async (t) => {
  const root = await workspace(t);
  makeFifo(join(root, "pipe"));
  await writeFile(join(root, "a.txt"), "abc");
  const listed = await call(root, "list_files", {});
  // `.runwright/` holds the workspace stage the call's context claimed (rule F).
  assert.equal(listed.content, ".runwright/\na.txt (3 bytes)\npipe (other)");
  assert.deepEqual(listed.data, {
    entries: [{ name: ".runwright", type: "directory", size: 0 }, { name: "a.txt", type: "file", size: 3 }, { name: "pipe", type: "other", size: 0 }],
    truncated: false, total: 3,
  });
  assert.deepEqual(await call(root, "delete_file", { path: "pipe" }), { content: "deleted pipe", data: { path: "pipe", deleted: true } });
  await assert.rejects(lstat(join(root, "pipe")), { code: "ENOENT" });
});

test("read_file and list_files with an aborted signal throw the signal's reason", async (t) => {
  const root = await workspace(t);
  await writeFile(join(root, "a.txt"), "abc");
  const controller = new AbortController();
  const reason = new Error("stop now");
  controller.abort(reason);
  await assert.rejects(call(root, "read_file", { path: "a.txt" }, controller.signal), (error) => error === reason);
  await assert.rejects(call(root, "list_files", {}, controller.signal), (error) => error === reason);
  await assert.rejects(call(root, "list_files", { path: "." }, controller.signal), (error) => error === reason);
});

test("list_files stops when its signal is aborted after the call started", async (t) => {
  const root = await workspace(t);
  for (const name of ["a", "b", "c"]) await writeFile(join(root, name), name);
  const controller = new AbortController();
  const reason = new Error("aborted while listing");
  const listing = call(root, "list_files", {}, controller.signal);
  controller.abort(reason);
  await assert.rejects(listing, (error) => error === reason);
});

test("edit_file with an empty old_text is refused before anything is read", async (t) => {
  const root = await workspace(t);
  await writeFile(join(root, "a.txt"), "abc");
  const output = await toolInChild(root, "edit_file", { path: "a.txt", old_text: "", new_text: "x" });
  assert.deepEqual(output, { content: "a.txt: old_text must not be empty", isError: true });
  const missing = await toolInChild(root, "edit_file", { path: "missing.txt", old_text: "", new_text: "x" });
  assert.deepEqual(missing, { content: "missing.txt: old_text must not be empty", isError: true });
});

test("a file larger than maxReadBytes is still refused with the existing message", async (t) => {
  const root = await workspace(t);
  await writeFile(join(root, "big.txt"), "z".repeat(65));
  assert.deepEqual(await call(root, "read_file", { path: "big.txt" }), {
    content: "big.txt: file is 65 bytes, larger than the read limit of 64 bytes", isError: true,
  });
  assert.deepEqual(await call(root, "edit_file", { path: "big.txt", old_text: "z", new_text: "y", replace_all: true }), {
    content: "big.txt: file is 65 bytes, larger than the read limit of 64 bytes", isError: true,
  });
  await writeFile(join(root, "edge.txt"), "z".repeat(64));
  assert.equal((await call(root, "read_file", { path: "edge.txt" })).content, "z".repeat(64));
});
