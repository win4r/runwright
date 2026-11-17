import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isRunwrightError } from "../../src/core/errors.ts";
import type { Json, JsonObject } from "../../src/core/json.ts";
import type { JournalRecord } from "../../src/store/types.ts";
import { createFileTools, editedSize } from "../../src/tools/fs.ts";
import type { ToolDefinition, ToolOutput } from "../../src/tools/types.ts";
import { stagePath } from "../../src/tools/workspace-stage.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { fileToolContext, holdingSeams } from "../helpers/tool-context.ts";

const escaped = (e: unknown): boolean => isRunwrightError(e) && e.code === "workspace_escape";

interface Fixture {
  root: string; outside: string;
  /** The run's journal as `steps.journal()` returns it; `call` appends each result like the engine does. */
  records: JournalRecord[];
  call(name: string, args: JsonObject): Promise<ToolOutput>;
}

const sha256 = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");

/** A `tool.finished` record as the engine journals a handler's result. */
function finished(tool: string, output: { content?: string; data?: Json; isError?: boolean; untrusted?: boolean }, extra?: JsonObject): JournalRecord {
  return {
    runId: "run_1", seq: 1, epoch: 1, ts: 0, type: "tool.finished", key: `t${tool}`,
    data: {
      callId: "c1", tool, outcome: output.isError === true ? "error" : "ok", content: output.content ?? "", data: output.data ?? null,
      isError: output.isError === true, untrusted: output.untrusted === true, truncated: false, fullResultPath: null, durationMs: 1,
      ...extra,
    },
  };
}

async function fixture(t: TestContext, limits?: { maxReadBytes?: number; maxWriteBytes?: number }): Promise<Fixture> {
  const base = await makeTempDir(t, "runwright-fs-");
  const root = join(base, "ws");
  const outside = join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "outside content");
  const tools = new Map<string, ToolDefinition>(
    createFileTools({ maxReadBytes: limits?.maxReadBytes ?? 1024, maxWriteBytes: limits?.maxWriteBytes ?? 1024 }).map((tool) => [tool.name, tool]),
  );
  const records: JournalRecord[] = [];
  const context = await fileToolContext(root, { journal: () => records });
  return {
    root,
    outside,
    records,
    async call(name, args) {
      const tool = tools.get(name);
      if (tool === undefined) throw new Error(`no tool ${name}`);
      const output = await tool.handler(args, context);
      records.push(finished(name, output));
      return output;
    },
  };
}

test("the five file tools are defined with strict schemas and the right effects", async (t) => {
  const tools = createFileTools({ maxReadBytes: 10, maxWriteBytes: 10 });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  assert.deepEqual(Object.keys(byName).sort(), ["delete_file", "edit_file", "list_files", "read_file", "write_file"]);
  for (const tool of tools) {
    assert.equal(tool.parameters["additionalProperties"], false, tool.name);
    assert.ok(tool.description.length > 20, tool.name);
  }
  assert.equal(byName["read_file"]?.effect, "read");
  assert.equal(byName["list_files"]?.effect, "read");
  assert.equal(byName["write_file"]?.effect, "write");
  assert.equal(byName["write_file"]?.idempotent, true);
  assert.equal(byName["edit_file"]?.effect, "write");
  assert.notEqual(byName["edit_file"]?.idempotent, true);
  assert.equal(byName["delete_file"]?.idempotent, true);
  await fixture(t);
});

test("write_file creates parents and read_file reads back, with offset and limit", async (t) => {
  const f = await fixture(t);
  const written = await f.call("write_file", { path: "notes/day1/todo.md", content: "one\ntwo\nthree\n" });
  assert.equal(written.isError, undefined);
  assert.deepEqual(written.data, { path: "notes/day1/todo.md", bytes: 14, sha256: sha256("one\ntwo\nthree\n") });
  assert.equal(await readFile(join(f.root, "notes", "day1", "todo.md"), "utf8"), "one\ntwo\nthree\n");
  const read = await f.call("read_file", { path: "notes/day1/todo.md" });
  assert.equal(read.content, "one\ntwo\nthree\n");
  assert.deepEqual(read.data, { path: "notes/day1/todo.md", bytes: 14, sha256: sha256("one\ntwo\nthree\n") });
  assert.equal(read.untrusted, undefined);
  assert.equal((await f.call("read_file", { path: "notes/day1/todo.md", offset: 1, limit: 1 })).content, "two");
  assert.equal((await f.call("read_file", { path: "notes/day1/todo.md", offset: 2 })).content, "three\n");
  const again = await f.call("write_file", { path: "notes/day1/todo.md", content: "replaced" });
  assert.equal(again.isError, undefined);
  assert.equal(await readFile(join(f.root, "notes", "day1", "todo.md"), "utf8"), "replaced");
  assert.deepEqual((await readdir(join(f.root, "notes", "day1"))), ["todo.md"]);
});

test("read and write limits, missing files, directories and binary files give error results", async (t) => {
  const f = await fixture(t, { maxReadBytes: 8, maxWriteBytes: 8 });
  const tooBig = await f.call("write_file", { path: "big.txt", content: "123456789" });
  assert.equal(tooBig.isError, true);
  assert.match(tooBig.content, /9 bytes.*write limit of 8/);
  await assert.rejects(stat(join(f.root, "big.txt")));
  await writeFile(join(f.root, "large.txt"), "0123456789");
  const large = await f.call("read_file", { path: "large.txt" });
  assert.equal(large.isError, true);
  assert.match(large.content, /10 bytes.*read limit of 8/);
  const missing = await f.call("read_file", { path: "nope.txt" });
  assert.equal(missing.isError, true);
  assert.match(missing.content, /no such file/);
  await mkdir(join(f.root, "dir"));
  assert.equal((await f.call("read_file", { path: "dir" })).isError, true);
  assert.equal((await f.call("write_file", { path: "dir", content: "x" })).isError, true);
  await writeFile(join(f.root, "bin.dat"), Buffer.from([0xff, 0xfe, 0x00]));
  const binary = await f.call("read_file", { path: "bin.dat" });
  assert.equal(binary.isError, true);
  assert.match(binary.content, /not UTF-8/);
});

test("edit_file requires exactly one match unless replace_all", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "a.txt"), "cat dog cat bird cat");
  const many = await f.call("edit_file", { path: "a.txt", old_text: "cat", new_text: "cow" });
  assert.equal(many.isError, true);
  assert.match(many.content, /occurs 3 times/);
  assert.deepEqual(many.data, { path: "a.txt", occurrences: 3 });
  const none = await f.call("edit_file", { path: "a.txt", old_text: "fish", new_text: "cow" });
  assert.equal(none.isError, true);
  assert.match(none.content, /0 occurrences/);
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "cat dog cat bird cat");
  const one = await f.call("edit_file", { path: "a.txt", old_text: "dog", new_text: "$& $1" });
  assert.equal(one.isError, undefined);
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "cat $& $1 cat bird cat");
  const all = await f.call("edit_file", { path: "a.txt", old_text: "cat", new_text: "cow", replace_all: true });
  assert.equal(all.isError, undefined);
  assert.equal((all.data as JsonObject)["replacements"], 3);
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "cow $& $1 cow bird cow");
  const missing = await f.call("edit_file", { path: "missing.txt", old_text: "a", new_text: "b" });
  assert.equal(missing.isError, true);
});

test("write_file and edit_file handle a 240-byte file name and leave no temp file", async (t) => {
  const f = await fixture(t);
  const name = `${"n".repeat(236)}.txt`;
  const written = await f.call("write_file", { path: name, content: "one two" });
  assert.deepEqual(written, { content: `wrote 7 bytes to ${name}`, data: { path: name, bytes: 7, sha256: sha256("one two") } });
  const edited = await f.call("edit_file", { path: name, old_text: "one", new_text: "three" });
  assert.equal(edited.isError, undefined, edited.content);
  assert.equal(await readFile(join(f.root, name), "utf8"), "three two");
  assert.deepEqual(await readdir(f.root), [".runwright", name]);
  assert.deepEqual(await readdir(stagePath(f.root, 1)), [], "no temp file is left in the stage");
});

test("list_files lists one directory with types and sizes", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, "sub"));
  await writeFile(join(f.root, "b.txt"), "bbb");
  await writeFile(join(f.root, "sub", "inner.txt"), "i");
  await symlink("b.txt", join(f.root, "link"));
  const root = await f.call("list_files", {});
  assert.deepEqual((root.data as JsonObject)["entries"], [
    { name: ".runwright", type: "directory", size: 0 },
    { name: "b.txt", type: "file", size: 3 },
    { name: "link", type: "symlink", size: 0 },
    { name: "sub", type: "directory", size: 0 },
  ]);
  assert.match(root.content, /b\.txt \(3 bytes\)/);
  assert.match(root.content, /sub\//);
  const sub = await f.call("list_files", { path: "sub" });
  assert.deepEqual((sub.data as JsonObject)["entries"], [{ name: "inner.txt", type: "file", size: 1 }]);
  assert.equal((await f.call("list_files", { path: "b.txt" })).isError, true);
  assert.equal((await f.call("list_files", { path: "missing" })).isError, true);
});

test("delete_file removes files only; an absent file is a success, a directory is an error", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "gone.txt"), "x");
  await mkdir(join(f.root, "keep"));
  await writeFile(join(f.root, "target.txt"), "kept");
  await symlink("target.txt", join(f.root, "alias.txt"));
  const deleted = await f.call("delete_file", { path: "gone.txt" });
  assert.deepEqual(deleted, { content: "deleted gone.txt", data: { path: "gone.txt", deleted: true } });
  await assert.rejects(stat(join(f.root, "gone.txt")));
  assert.deepEqual(
    await f.call("delete_file", { path: "gone.txt" }),
    { content: "gone.txt: already absent, nothing to delete", data: { path: "gone.txt", deleted: false } },
  );
  assert.equal((await f.call("delete_file", { path: "keep" })).isError, true);
  assert.equal((await f.call("delete_file", { path: "." })).isError, true);
  assert.equal(await f.call("delete_file", { path: "alias.txt" }).then((r) => r.isError), undefined);
  assert.equal(await readFile(join(f.root, "target.txt"), "utf8"), "kept");
});

test("delete_file: a missing parent folder is an absent success; a file parent and .runwright/ stay errors", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "target.txt"), "kept");
  assert.deepEqual(
    await f.call("delete_file", { path: "nope/done.txt" }),
    { content: "nope/done.txt: already absent, nothing to delete", data: { path: "nope/done.txt", deleted: false } },
  );
  const underFile = await f.call("delete_file", { path: "target.txt/x" });
  assert.equal(underFile.isError, true);
  assert.equal(underFile.content, "target.txt/x: a parent of this path is not a directory");
  assert.equal(await readFile(join(f.root, "target.txt"), "utf8"), "kept");
  // A claimed workspace has `.runwright/` (its stage); without it the path is refused by its spelling.
  await rm(join(f.root, ".runwright"), { recursive: true });
  const reservedMissingFolder = await f.call("delete_file", { path: ".runwright/x.txt" });
  assert.deepEqual(reservedMissingFolder, { content: ".runwright/x.txt: .runwright/ is reserved for Runwright's own files", isError: true });
  await mkdir(join(f.root, ".runwright"));
  assert.deepEqual(
    await f.call("delete_file", { path: ".runwright/x.txt" }),
    { content: ".runwright/x.txt: .runwright/ is reserved for Runwright's own files", isError: true },
  );
});

test("delete_file: two deletions of one file started together both succeed and exactly one deleted it", async (t) => {
  const f = await fixture(t);
  for (let round = 0; round < 20; round += 1) {
    await writeFile(join(f.root, "race.txt"), "x");
    const results = await Promise.all([f.call("delete_file", { path: "race.txt" }), f.call("delete_file", { path: "race.txt" })]);
    for (const result of results) assert.equal(result.isError, undefined, JSON.stringify(result));
    const deleted = results.filter((result) => (result.data as JsonObject)["deleted"] === true);
    assert.equal(deleted.length, 1, JSON.stringify(results));
    await assert.rejects(stat(join(f.root, "race.txt")));
  }
});

test("delete_file's description says that an absent file succeeds", () => {
  const tool = createFileTools({ maxReadBytes: 10, maxWriteBytes: 10 }).find((candidate) => candidate.name === "delete_file");
  assert.ok(tool !== undefined);
  assert.equal(
    tool.description,
    "Delete one file from the workspace. Directories cannot be deleted. Deleting a file that is already absent " +
      "succeeds and reports that nothing was deleted. `.runwright/` is reserved for Runwright's own files and cannot " +
      "be changed with this tool.",
  );
  assert.match(tool.description, /already absent succeeds/);
  assert.doesNotMatch(tool.description, /is an error/);
});

test("escape attempts through every tool are refused and nothing outside changes", async (t) => {
  const f = await fixture(t);
  await symlink(join(f.outside, "secret.txt"), join(f.root, "out-file"));
  await symlink(f.outside, join(f.root, "out-dir"));
  const attempts: [string, JsonObject][] = [];
  for (const path of ["../outside/secret.txt", join(f.outside, "secret.txt"), "out-file", "out-dir/secret.txt", "out-dir/new.txt"]) {
    attempts.push(["read_file", { path }]);
    attempts.push(["write_file", { path, content: "pwned" }]);
    attempts.push(["edit_file", { path, old_text: "outside", new_text: "pwned" }]);
    attempts.push(["delete_file", { path }]);
  }
  attempts.push(["list_files", { path: "out-dir" }], ["list_files", { path: ".." }], ["list_files", { path: "/" }]);
  for (const [name, args] of attempts) {
    await assert.rejects(f.call(name, args), escaped, `${name} ${JSON.stringify(args)}`);
  }
  assert.deepEqual(await readdir(f.outside), ["secret.txt"]);
  assert.equal(await readFile(join(f.outside, "secret.txt"), "utf8"), "outside content");
});

test("read_file marks content from the untrusted results folder as untrusted", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, ".runwright", "tool-results", "untrusted"), { recursive: true });
  await writeFile(join(f.root, ".runwright", "tool-results", "untrusted", "call-1.txt"), "web page text");
  await writeFile(join(f.root, ".runwright", "tool-results", "call-2.txt"), "own result");
  f.records.push(finished("write_file", { data: { path: "x", bytes: 13, sha256: sha256("web page text") } }));
  const untrusted = await f.call("read_file", { path: ".runwright/tool-results/untrusted/call-1.txt" });
  assert.equal(untrusted.untrusted, true);
  assert.equal(untrusted.content, "web page text");
  assert.equal((await f.call("read_file", { path: "./.runwright//tool-results/untrusted/call-1.txt" })).untrusted, true);
  await symlink(".runwright/tool-results/untrusted/call-1.txt", join(f.root, "innocent.txt"));
  assert.equal((await f.call("read_file", { path: "innocent.txt" })).untrusted, true);
  assert.equal((await f.call("read_file", { path: ".runwright/tool-results/call-2.txt" })).untrusted, true, "no record vouches for it");
  f.records.push(finished("lookup", { content: "[saved]" }, { truncated: true, fullResultPath: ".runwright/tool-results/call-2.txt", fullResultSha256: sha256("own result"), fullResultBytes: 10 }));
  assert.equal((await f.call("read_file", { path: ".runwright/tool-results/call-2.txt" })).untrusted, undefined, "a trusted saved result");
});

const UNTRUSTED = ".runwright/tool-results/untrusted";
const RESERVED = /: \.runwright\/ is reserved for Runwright's own files$/;

/** True when the file system of `dir` treats names that differ only in letter case as the same entry. */
async function caseInsensitive(dir: string): Promise<boolean> {
  await writeFile(join(dir, "probe"), "");
  try {
    return await stat(join(dir, "PROBE")).then(() => true, () => false);
  } finally {
    await rm(join(dir, "probe"), { force: true });
  }
}

/** Every file under `dir` with its content, recursively (symbolic links listed as "->target"). */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const full = join(entry.parentPath, entry.name);
    const key = full.slice(dir.length + 1);
    if (entry.isSymbolicLink()) out[key] = `->${await readlink(full)}`;
    else if (entry.isFile()) out[key] = await readFile(full, "utf8");
    else out[`${key}/`] = "";
  }
  return out;
}

async function withSavedResults(f: Fixture): Promise<void> {
  await mkdir(join(f.root, ".runwright", "tool-results", "untrusted"), { recursive: true });
  await writeFile(join(f.root, ".runwright", "x.txt"), "runwright file");
  await writeFile(join(f.root, ".runwright", "tool-results", "untrusted", "1-a.txt"), "saved page");
}

function writes(path: string): [string, JsonObject][] {
  return [
    ["write_file", { path, content: "replaced" }],
    ["edit_file", { path, old_text: "saved page", new_text: "replaced" }],
    ["edit_file", { path, old_text: "runwright file", new_text: "replaced" }],
    ["delete_file", { path }],
  ];
}

test("write_file, edit_file and delete_file refuse .runwright/ in every spelling and change nothing", async (t) => {
  const f = await fixture(t);
  await withSavedResults(f);
  await symlink(".runwright", join(f.root, "alias"));
  const before = await snapshot(f.root);
  const paths = [
    ".runwright/x.txt", "./.runwright//tool-results/untrusted/1-a.txt", ".runwright/new/file.txt", ".runwright",
    "alias/x.txt", "alias/tool-results/untrusted/1-a.txt", "alias/new.txt",
    ".RUNWRIGHT/x.txt", ".Runwright/tool-results/untrusted/1-a.txt", ".RUNWRIGHT/fresh/new.txt",
  ];
  for (const path of paths) {
    for (const [name, args] of writes(path)) {
      const result = await f.call(name, args);
      assert.equal(result.isError, true, `${name} ${path}`);
      assert.equal(result.content, `${path}: .runwright/ is reserved for Runwright's own files`, `${name} ${path}`);
    }
  }
  assert.deepEqual(await snapshot(f.root), before);
});

test("a .runwright folder that does not exist yet is refused and not created", async (t) => {
  const f = await fixture(t);
  await rm(join(f.root, ".runwright"), { recursive: true });
  for (const path of [".runwright/new/file.txt", ".RUNWRIGHT/x.txt", ".Runwright/tool-results/untrusted/1-a.txt"]) {
    for (const [name, args] of writes(path)) assert.match((await f.call(name, args)).content, RESERVED, `${name} ${path}`);
  }
  assert.deepEqual(await readdir(f.root), []);
});

test("a workspace escape is still reported as an escape, not as reserved", async (t) => {
  const f = await fixture(t);
  await rm(join(f.root, ".runwright"), { recursive: true });
  await symlink(f.outside, join(f.root, ".runwright"));
  await assert.rejects(f.call("write_file", { path: ".runwright/secret.txt", content: "x" }), escaped);
  await assert.rejects(f.call("write_file", { path: "../ws/.runwright/x.txt", content: "x" }), escaped);
  assert.equal(await readFile(join(f.outside, "secret.txt"), "utf8"), "outside content");
});

test("read_file marks the untrusted folder as untrusted under another letter case when the file system folds case", async (t) => {
  const f = await fixture(t);
  await withSavedResults(f);
  const folds = await caseInsensitive(f.root);
  for (const path of [".RUNWRIGHT/tool-results/untrusted/1-a.txt", ".runwright/Tool-Results/UNTRUSTED/1-a.txt"]) {
    const read = await f.call("read_file", { path });
    if (folds) {
      assert.equal(read.isError, undefined, path);
      assert.equal(read.content, "saved page");
      assert.equal(read.untrusted, true, path);
    } else {
      assert.equal(read.isError, true, path);
      assert.match(read.content, /no such file/);
    }
  }
  await mkdir(join(f.root, "untrusted-lookalike", ".runwright", "tool-results", "untrusted"), { recursive: true });
  await writeFile(join(f.root, "untrusted-lookalike", ".runwright", "tool-results", "untrusted", "own.txt"), "own");
  f.records.push(finished("write_file", { data: { path: "untrusted-lookalike/.runwright/tool-results/untrusted/own.txt", bytes: 3, sha256: sha256("own") } }));
  const lookalike = await f.call("read_file", { path: "untrusted-lookalike/.runwright/tool-results/untrusted/own.txt" });
  assert.equal(lookalike.untrusted, undefined, "only the workspace's own folder is untrusted whatever the journal says");
});

test("read_file and list_files still work inside .runwright/", async (t) => {
  const f = await fixture(t);
  await withSavedResults(f);
  const read = await f.call("read_file", { path: ".runwright/x.txt" });
  assert.deepEqual([read.isError, read.content, read.untrusted], [undefined, "runwright file", true], "no record vouches for a file put there by hand");
  const listed = await f.call("list_files", { path: ".runwright" });
  assert.equal(listed.isError, undefined);
  assert.deepEqual((listed.data as JsonObject)["entries"], [
    { name: "stage", type: "directory", size: 0 },
    { name: "tool-results", type: "directory", size: 0 },
    { name: "unstage", type: "directory", size: 0 },
    { name: "x.txt", type: "file", size: 14 },
  ]);
  const inner = await f.call("list_files", { path: ".runwright/tool-results/untrusted" });
  assert.deepEqual((inner.data as JsonObject)["entries"], [{ name: "1-a.txt", type: "file", size: 10 }]);
});

test("folders with similar names are ordinary folders", async (t) => {
  const f = await fixture(t);
  await withSavedResults(f);
  for (const path of [".runwright-notes/a.txt", "x/.runwright/b.txt", ".runwrightx/c.txt", "runwright/d.txt"]) {
    const written = await f.call("write_file", { path, content: "hello world" });
    assert.equal(written.isError, undefined, path);
    assert.equal((await f.call("edit_file", { path, old_text: "world", new_text: "there" })).isError, undefined, path);
    assert.equal(await readFile(join(f.root, path), "utf8"), "hello there");
    assert.equal((await f.call("delete_file", { path })).isError, undefined, path);
    await assert.rejects(stat(join(f.root, path)));
  }
});

test("the three write tools say that .runwright/ is reserved", () => {
  for (const tool of createFileTools({ maxReadBytes: 10, maxWriteBytes: 10 })) {
    if (tool.effect === "write") assert.match(tool.description, /`\.runwright\/` is reserved/, tool.name);
    else assert.doesNotMatch(tool.description, /reserved/, tool.name);
  }
});

// ------------------------------------------------- Rule T: a file read is the run's own work only when the journal says so

test("Rule T: a file no record accounts for reads as untrusted, with the digest of its bytes", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "source.txt"), "a page someone downloaded\n");
  const read = await f.call("read_file", { path: "source.txt" });
  assert.equal(read.isError, undefined);
  assert.equal(read.untrusted, true);
  assert.equal(read.content, "a page someone downloaded\n");
  assert.deepEqual(read.data, { path: "source.txt", bytes: 26, sha256: sha256("a page someone downloaded\n") });
});

test("Rule T: a file written with write_file reads as trusted until it changes behind the tools", async (t) => {
  const f = await fixture(t);
  const written = await f.call("write_file", { path: "own.txt", content: "the run's own text" });
  assert.equal((written.data as JsonObject)["sha256"], sha256("the run's own text"));
  assert.equal(await readFile(join(f.root, "own.txt"), "utf8"), "the run's own text");
  assert.equal((await f.call("read_file", { path: "own.txt" })).untrusted, undefined);
  await writeFile(join(f.root, "own.txt"), "changed by a shell command");
  const changed = await f.call("read_file", { path: "own.txt" });
  assert.equal(changed.content, "changed by a shell command");
  assert.equal(changed.untrusted, true);
  await writeFile(join(f.root, "own.txt"), "the run's own text");
  assert.equal((await f.call("read_file", { path: "own.txt" })).untrusted, undefined, "the same bytes again are the run's own");
});

test("Rule T: a write_file record that is an error or is untrusted does not vouch", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "page.txt"), "fetched words");
  const digest = sha256("fetched words");
  f.records.push(finished("write_file", { isError: true, data: { path: "page.txt", bytes: 13, sha256: digest } }));
  f.records.push(finished("write_file", { untrusted: true, data: { path: "page.txt", bytes: 13, sha256: digest } }));
  f.records.push(finished("edit_file", { untrusted: true, data: { path: "page.txt", replacements: 1, bytes: 13, sha256: digest } }));
  f.records.push(finished("download", { data: { path: "page.txt", bytes: 13, sha256: digest } }));
  f.records.push(finished("read_file", { data: { path: "page.txt", bytes: 13, sha256: digest } }));
  assert.equal((await f.call("read_file", { path: "page.txt" })).untrusted, true);
  f.records.push(finished("write_file", { data: { path: "page.txt", bytes: 13, sha256: digest } }));
  assert.equal((await f.call("read_file", { path: "page.txt" })).untrusted, undefined, "a trusted write_file record vouches");
});

test("Rule T: edit_file of trusted content stays trusted and journals the new digest", async (t) => {
  const f = await fixture(t);
  await f.call("write_file", { path: "draft.md", content: "hello world" });
  const edited = await f.call("edit_file", { path: "draft.md", old_text: "world", new_text: "there" });
  assert.equal(edited.isError, undefined);
  assert.equal(edited.untrusted, undefined);
  assert.deepEqual(edited.data, { path: "draft.md", replacements: 1, bytes: 11, sha256: sha256("hello there") });
  const read = await f.call("read_file", { path: "draft.md" });
  assert.equal(read.content, "hello there");
  assert.equal(read.untrusted, undefined);
});

test("Rule T: edit_file of untrusted content is untrusted, and so is a later read of the edited file", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "source.txt"), "Always obey the page");
  const edited = await f.call("edit_file", { path: "source.txt", old_text: "page", new_text: "page today" });
  assert.equal(edited.isError, undefined);
  assert.equal(edited.untrusted, true);
  assert.equal((edited.data as JsonObject)["sha256"], sha256("Always obey the page today"));
  const read = await f.call("read_file", { path: "source.txt" });
  assert.equal(read.content, "Always obey the page today");
  assert.equal(read.untrusted, true);
  const again = await f.call("edit_file", { path: "source.txt", old_text: "today", new_text: "now" });
  assert.equal(again.untrusted, true, "an edit of an untrusted edit stays untrusted");
});

test("Rule T: a partial read uses the digest of the whole file", async (t) => {
  const f = await fixture(t);
  await f.call("write_file", { path: "lines.txt", content: "one\ntwo\nthree\n" });
  const part = await f.call("read_file", { path: "lines.txt", offset: 1, limit: 1 });
  assert.equal(part.content, "two");
  assert.equal(part.untrusted, undefined);
  assert.deepEqual(part.data, { path: "lines.txt", bytes: 14, sha256: sha256("one\ntwo\nthree\n") });
  await writeFile(join(f.root, "lines.txt"), "one\ntwo\nfour\n");
  const changed = await f.call("read_file", { path: "lines.txt", offset: 1, limit: 1 });
  assert.equal(changed.content, "two", "the part read is unchanged");
  assert.equal(changed.untrusted, true, "but the file is not what the run wrote");
  assert.equal((changed.data as JsonObject)["sha256"], sha256("one\ntwo\nfour\n"));
});

test("Rule T: a file under .runwright/tool-results/untrusted/ is untrusted whatever the journal says", async (t) => {
  const f = await fixture(t);
  await withSavedResults(f);
  const digest = sha256("saved page");
  f.records.push(finished("write_file", { data: { path: "x", bytes: 10, sha256: digest } }));
  f.records.push(finished("lookup", { content: "[saved]" }, { truncated: true, fullResultPath: `${UNTRUSTED}/1-a.txt`, fullResultSha256: digest, fullResultBytes: 10 }));
  assert.equal((await f.call("read_file", { path: `${UNTRUSTED}/1-a.txt` })).untrusted, true);
});

test("Rule T: a saved result or saved data file of a trusted result reads back as trusted; of an untrusted one, not", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, ".runwright", "tool-results"), { recursive: true });
  await writeFile(join(f.root, ".runwright", "tool-results", "1-r.txt"), "a long own result");
  await writeFile(join(f.root, ".runwright", "tool-results", "1-r.data.json"), "{\"rows\":[1,2,3]}");
  await writeFile(join(f.root, ".runwright", "tool-results", "2-r.txt"), "a long result of an untrusted host tool");
  f.records.push(finished("report", { content: "[saved]" }, {
    truncated: true, fullResultPath: ".runwright/tool-results/1-r.txt", fullResultSha256: sha256("a long own result"), fullResultBytes: 17,
    fullDataPath: ".runwright/tool-results/1-r.data.json", fullDataSha256: sha256("{\"rows\":[1,2,3]}"), fullDataBytes: 16,
  }));
  f.records.push(finished("lookup", { content: "[saved]", untrusted: true }, {
    truncated: true, fullResultPath: ".runwright/tool-results/2-r.txt", fullResultSha256: sha256("a long result of an untrusted host tool"), fullResultBytes: 39,
  }));
  assert.equal((await f.call("read_file", { path: ".runwright/tool-results/1-r.txt" })).untrusted, undefined);
  assert.equal((await f.call("read_file", { path: ".runwright/tool-results/1-r.data.json" })).untrusted, undefined);
  assert.equal((await f.call("read_file", { path: ".runwright/tool-results/2-r.txt" })).untrusted, true);
});

test("read_file: an offset or limit beyond any file reads like the largest one", async (t) => {
  const f = await fixture(t);
  await f.call("write_file", { path: "a.txt", content: "one\ntwo" });
  assert.equal((await f.call("read_file", { path: "a.txt", offset: 1e300 })).content, "");
  assert.equal((await f.call("read_file", { path: "a.txt", limit: 1e300 })).content, "one\ntwo");
  assert.equal((await f.call("read_file", { path: "a.txt", offset: 1, limit: Number.MAX_SAFE_INTEGER })).content, "two");
});

test("serialised mutations: two edit_file calls on one file started in the same tick both take effect", async (t) => {
  const f = await fixture(t);
  for (let round = 0; round < 10; round += 1) {
    await writeFile(join(f.root, "pets.txt"), "cat dog");
    const results = await Promise.all([
      f.call("edit_file", { path: "pets.txt", old_text: "cat", new_text: "cow" }),
      f.call("edit_file", { path: "pets.txt", old_text: "dog", new_text: "bird" }),
    ]);
    for (const result of results) assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(await readFile(join(f.root, "pets.txt"), "utf8"), "cow bird");
  }
});

test("serialised mutations: 50 concurrent edits of 50 distinct tokens in one file all take effect", async (t) => {
  const f = await fixture(t, { maxReadBytes: 4096, maxWriteBytes: 4096 });
  const tokens = Array.from({ length: 50 }, (_, i) => `tok${String(i).padStart(2, "0")}`);
  await writeFile(join(f.root, "many.txt"), tokens.join("\n"));
  const results = await Promise.all(tokens.map((token) => f.call("edit_file", { path: "many.txt", old_text: token, new_text: token.toUpperCase() })));
  for (const result of results) assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(await readFile(join(f.root, "many.txt"), "utf8"), tokens.map((token) => token.toUpperCase()).join("\n"));
});

test("serialised mutations: an edit_file racing a write_file ends in one of the two serial outcomes", async (t) => {
  const f = await fixture(t);
  for (let round = 0; round < 10; round += 1) {
    await writeFile(join(f.root, "race.txt"), "cat dog");
    const [edit, write] = await Promise.all([
      f.call("edit_file", { path: "race.txt", old_text: "cat", new_text: "cow" }),
      f.call("write_file", { path: "race.txt", content: "fresh cat" }),
    ]);
    // Both serial orders leave a "cat" for the edit to find, so both calls succeed whichever ran first.
    assert.equal(write.isError, undefined, JSON.stringify(write));
    assert.equal(edit.isError, undefined, JSON.stringify(edit));
    const final = await readFile(join(f.root, "race.txt"), "utf8");
    // Edit first: "cow dog" then overwritten → "fresh cat". Write first: "fresh cat" then edited → "fresh cow".
    assert.ok(final === "fresh cat" || final === "fresh cow", final);
    const editBytes = (edit.data as JsonObject)["sha256"];
    const writeBytes = (write.data as JsonObject)["sha256"];
    if (final === "fresh cow") {
      assert.equal(editBytes, sha256("fresh cow"));
      assert.equal(writeBytes, sha256("fresh cat"));
    } else {
      assert.equal(editBytes, sha256("cow dog"));
      assert.equal(writeBytes, sha256("fresh cat"));
    }
  }
});

test("serialised mutations: A.txt and a.txt edited concurrently lose no edit", async (t) => {
  const f = await fixture(t);
  const probe = join(f.root, "Probe.txt");
  await writeFile(probe, "x");
  const foldsCase = await stat(join(f.root, "probe.txt")).then(() => true, () => false);
  await rm(probe);
  for (let round = 0; round < 10; round += 1) {
    await writeFile(join(f.root, "A.txt"), "cat dog");
    if (!foldsCase) await writeFile(join(f.root, "a.txt"), "cat dog");
    const results = await Promise.all([
      f.call("edit_file", { path: "A.txt", old_text: "cat", new_text: "cow" }),
      f.call("edit_file", { path: "a.txt", old_text: "dog", new_text: "bird" }),
    ]);
    for (const result of results) assert.equal(result.isError, undefined, JSON.stringify(result));
    if (foldsCase) {
      assert.equal(await readFile(join(f.root, "A.txt"), "utf8"), "cow bird");
    } else {
      assert.equal(await readFile(join(f.root, "A.txt"), "utf8"), "cow dog");
      assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "cat bird");
    }
  }
});

test("serialised mutations: a failing mutation does not block the next one", async (t) => {
  const f = await fixture(t);
  const [missing, missingWrite, written] = await Promise.all([
    f.call("edit_file", { path: "nope.txt", old_text: "a", new_text: "b" }),
    f.call("write_file", { path: "dir", content: "" }).then(async () => f.call("write_file", { path: "dir/x", content: "y" })),
    f.call("write_file", { path: "ok.txt", content: "fine" }),
  ]);
  assert.equal(missing.isError, true);
  assert.equal(missingWrite.isError, true);
  assert.equal(written.isError, undefined);
  const after = await f.call("edit_file", { path: "ok.txt", old_text: "fine", new_text: "great" });
  assert.equal(after.isError, undefined);
  assert.equal(await readFile(join(f.root, "ok.txt"), "utf8"), "great");
});

test("serialised mutations: a handler that throws releases the queue", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "x.txt"), "abc");
  const tools = createFileTools({ maxReadBytes: 100, maxWriteBytes: 100 });
  const edit = tools.find((tool) => tool.name === "edit_file");
  const write = tools.find((tool) => tool.name === "write_file");
  assert.ok(edit !== undefined && write !== undefined);
  // A context whose journal throws makes edit_file reject (not an ordinary file-system error result).
  const broken = await fileToolContext(f.root, { journal: () => { throw new Error("journal unavailable"); } });
  const failing = edit.handler({ path: "x.txt", old_text: "a", new_text: "b" }, broken);
  const next = write.handler({ path: "y.txt", content: "after" }, broken);
  await assert.rejects(failing, /journal unavailable/);
  assert.equal((await next).isError, undefined);
  assert.equal(await readFile(join(f.root, "y.txt"), "utf8"), "after");
  assert.equal(await readFile(join(f.root, "x.txt"), "utf8"), "abc");
});

test("BOM: read_file returns the byte order mark and edit_file keeps it", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "bom.txt"), Buffer.from([0xef, 0xbb, 0xbf, 0x41]));
  const read = await f.call("read_file", { path: "bom.txt" });
  assert.equal(read.content, "﻿A");
  assert.equal((read.data as JsonObject)["bytes"], 4);
  assert.equal(Buffer.byteLength(read.content), 4);
  const edited = await f.call("edit_file", { path: "bom.txt", old_text: "A", new_text: "B" });
  assert.equal(edited.isError, undefined);
  assert.deepEqual([...(await readFile(join(f.root, "bom.txt")))], [0xef, 0xbb, 0xbf, 0x42]);
});

test("list_files over the limit reports truncated and the real total", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, "big"));
  await Promise.all(Array.from({ length: 2005 }, (_, i) => writeFile(join(f.root, "big", `f${String(i).padStart(4, "0")}`), "")));
  const listed = await f.call("list_files", { path: "big" });
  const data = listed.data as JsonObject;
  assert.equal(data["truncated"], true);
  assert.equal(data["total"], 2005);
  assert.equal((data["entries"] as Json[]).length, 2000);
  assert.match(listed.content, /\[5 more entries not shown\]/);
  const small = (await f.call("list_files", {})).data as JsonObject;
  assert.equal(small["truncated"], false);
  // `big` and `.runwright`, which holds the workspace stage claimed for the run (rule F).
  assert.equal(small["total"], 2);
  const tool = createFileTools({ maxReadBytes: 10, maxWriteBytes: 10 }).find((candidate) => candidate.name === "list_files");
  assert.match(tool?.description ?? "", /At most 2000 entries/);
});

// ---- No tool builds a value larger than its limit to find out that it is over it (R14D-tools-03) ----

test("(R14D-tools-03) editedSize is the byte length of the real replacement", () => {
  const cases: { text: string; oldText: string; newText: string }[] = [
    { text: "hello world, hello moon", oldText: "hello", newText: "bye" },
    { text: "hello world", oldText: "world", newText: "wide wonderful world" },
    { text: "aébéc", oldText: "é", newText: "漢字" },
    { text: "x\u{1F600}y\u{1F600}", oldText: "\u{1F600}", newText: "" },
    { text: "漢字漢", oldText: "漢", newText: "e" },
    { text: "﻿A BOM file, A", oldText: "A", newText: "ßß" },
    { text: "﻿starts with a BOM", oldText: "﻿", newText: "" },
    { text: "only once", oldText: "once", newText: "once more" },
  ];
  for (const { text, oldText, newText } of cases) {
    const count = text.split(oldText).length - 1;
    const expected = Buffer.byteLength(text.split(oldText).join(newText));
    assert.equal(editedSize(Buffer.byteLength(text), count, oldText, newText), expected, JSON.stringify({ text, oldText, newText }));
    const first = text.indexOf(oldText);
    const single = Buffer.byteLength(text.slice(0, first) + newText + text.slice(first + oldText.length));
    assert.equal(editedSize(Buffer.byteLength(text), 1, oldText, newText), single, `single: ${JSON.stringify({ text, oldText })}`);
  }
});

test("(R14D-tools-03) a replace_all that would pass the write limit is refused with the exact size, and the file is unchanged", async (t) => {
  const f = await fixture(t, { maxReadBytes: 65_536, maxWriteBytes: 65_536 });
  const original = "a".repeat(65_536);
  await writeFile(join(f.root, "a.txt"), original);
  const result = await f.call("edit_file", { path: "a.txt", old_text: "a", new_text: "b".repeat(4096), replace_all: true });
  assert.equal(result.isError, true);
  assert.equal(result.content, `a.txt: the edited file would be ${65_536 * 4096} bytes, larger than the write limit of 65536 bytes`);
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), original);
});

test("(R14D-tools-03) a refused edit whose result could not even be built returns the limit error, not a RangeError", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, { maxReadBytes: 1 << 20, maxWriteBytes: 1 << 20 });
  await writeFile(join(f.root, "many.txt"), "a,".repeat(2048));
  const newText = "z".repeat(1 << 20);
  const started = Date.now();
  const result = await f.call("edit_file", { path: "many.txt", old_text: "a", new_text: newText, replace_all: true });
  assert.equal(result.isError, true);
  assert.equal(result.content, `many.txt: the edited file would be ${4096 + 2048 * ((1 << 20) - 1)} bytes, larger than the write limit of ${1 << 20} bytes`);
  assert.ok(Date.now() - started < 2000, "refused before anything is built");
  assert.equal(await readFile(join(f.root, "many.txt"), "utf8"), "a,".repeat(2048));
});

test("(R14D-tools-03) an edit landing exactly on the write limit succeeds; one byte over fails", async (t) => {
  const f = await fixture(t, { maxReadBytes: 64, maxWriteBytes: 8 });
  await writeFile(join(f.root, "e.txt"), "abc");
  const exact = await f.call("edit_file", { path: "e.txt", old_text: "b", new_text: "éxyz" });
  assert.equal(exact.isError, undefined, exact.content);
  assert.equal((exact.data as JsonObject)["bytes"], 7);
  await writeFile(join(f.root, "e.txt"), "abc");
  const onLimit = await f.call("edit_file", { path: "e.txt", old_text: "b", new_text: "éwxyz" });
  assert.equal(onLimit.isError, undefined, onLimit.content);
  assert.equal(Buffer.byteLength(await readFile(join(f.root, "e.txt"), "utf8")), 8);
  await writeFile(join(f.root, "e.txt"), "abc");
  const over = await f.call("edit_file", { path: "e.txt", old_text: "b", new_text: "évwxyz" });
  assert.equal(over.content, "e.txt: the edited file would be 9 bytes, larger than the write limit of 8 bytes");
  assert.equal(await readFile(join(f.root, "e.txt"), "utf8"), "abc");
});

test("(R14D-tools-03) old_text or new_text with an unpaired surrogate is refused instead of splitting a character", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "emoji.txt"), "\u{1F600}\u{1F600}");
  for (const args of [{ old_text: "\ude00", new_text: "x" }, { old_text: "\u{1F600}", new_text: "\ud83d" }]) {
    const result = await f.call("edit_file", { path: "emoji.txt", replace_all: true, ...args });
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(result.content, /unpaired surrogate/);
  }
  assert.equal(await readFile(join(f.root, "emoji.txt"), "utf8"), "\u{1F600}\u{1F600}");
});

test("(R14D-tools-03 sweep) list_files keeps the first entries in name order however the directory lists them", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, "mixed"));
  const names = Array.from({ length: 2300 }, (_, i) => `${["b", "a", "é", "Z", "_"][i % 5]}${(i * 7919) % 2300}`);
  await Promise.all(names.map((name) => writeFile(join(f.root, "mixed", name), "x")));
  const listed = await f.call("list_files", { path: "mixed" });
  const data = listed.data as JsonObject;
  const expected = [...names].sort().slice(0, 2000);
  assert.deepEqual((data["entries"] as JsonObject[]).map((entry) => entry["name"]), expected);
  assert.equal(data["total"], 2300);
  assert.equal(data["truncated"], true);
});

// ---- Workspace writes are fenced by the lease epoch (R15D-tools-01) ----

/** The workspace `fixture` would build, without its context: for tests that build contexts of their own. */
async function bareWorkspace(t: TestContext): Promise<string> {
  const root = join(await makeTempDir(t, "runwright-fs-fence-"), "ws");
  await mkdir(root);
  return root;
}

function toolOf(tools: readonly ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool !== undefined, name);
  return tool;
}

/** Every `.tmp` or `.del` file under `dir`. */
async function stagedLeftovers(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && /\.(tmp|del)$/.test(entry.name)).map((entry) => join(entry.parentPath, entry.name));
}

const fencedCall = (error: unknown): boolean => isRunwrightError(error) && error.code === "lease_lost";

const FENCED_CALLS: { tool: string; args: JsonObject; initial: string | null }[] = [
  { tool: "write_file", args: { path: "shared.txt", content: "stale write" }, initial: null },
  { tool: "edit_file", args: { path: "shared.txt", old_text: "base", new_text: "stale edit" }, initial: "base" },
  { tool: "delete_file", args: { path: "shared.txt" }, initial: "base" },
];

for (const { tool, args, initial } of FENCED_CALLS) {
  test(`(R15D-tools-01) ${tool} stopped before its rename by epoch 1, then epoch 2 claims and writes: epoch 1 is fenced`, async (t) => {
    const root = await bareWorkspace(t);
    if (initial !== null) await writeFile(join(root, "shared.txt"), initial);
    const held = holdingSeams();
    const staleTools = createFileTools({ maxReadBytes: 1024, maxWriteBytes: 1024, stage: held.seams });
    const stale = toolOf(staleTools, tool);
    const staleContext = await fileToolContext(root, { epoch: 1 });
    const call = stale.handler(args, staleContext);
    await held.reached;

    const successor = createFileTools({ maxReadBytes: 1024, maxWriteBytes: 1024 });
    const successorContext = await fileToolContext(root, { epoch: 2 });
    const written = await toolOf(successor, "write_file").handler({ path: "shared.txt", content: "epoch 2" }, successorContext);
    assert.equal(written.isError, undefined, written.content);

    held.release();
    await assert.rejects(call, fencedCall);
    assert.equal(await readFile(join(root, "shared.txt"), "utf8"), "epoch 2", "the file holds epoch 2's content");
    assert.deepEqual(await stagedLeftovers(root), []);
    // A later write of the stale epoch is refused too: its temp file cannot even be created.
    await assert.rejects(toolOf(staleTools, "write_file").handler({ path: "shared.txt", content: "stale again" }, staleContext), fencedCall);
    assert.equal(await readFile(join(root, "shared.txt"), "utf8"), "epoch 2");
  });

  test(`(R15D-tools-01) a queued ${tool} whose signal aborts while it waits behind another mutation never touches the file`, async (t) => {
    const root = await bareWorkspace(t);
    if (initial !== null) await writeFile(join(root, "shared.txt"), initial);
    const held = holdingSeams();
    const tools = createFileTools({ maxReadBytes: 1024, maxWriteBytes: 1024, stage: held.seams });
    const first = toolOf(tools, "write_file").handler({ path: "first.txt", content: "first" }, await fileToolContext(root));
    await held.reached;
    const controller = new AbortController();
    const queued = toolOf(tools, tool).handler(args, await fileToolContext(root, { signal: controller.signal }));
    const reason = new Error("aborted while queued");
    controller.abort(reason);
    held.release();
    assert.equal((await first).isError, undefined);
    await assert.rejects(queued, (error: unknown) => error === reason);
    assert.equal(held.calls(), 1, "the queued call made no rename");
    if (initial === null) await assert.rejects(stat(join(root, "shared.txt")), { code: "ENOENT" });
    else assert.equal(await readFile(join(root, "shared.txt"), "utf8"), initial);
  });
}
