/**
 * Conformance I1 of the idempotent contract (`ToolDefinition.idempotent`): every built-in tool declared
 * `idempotent: true`, invoked twice with the same arguments, returns a result that is not an error the second time
 * and leaves the same workspace state. The engine relies on this when it runs an unfinished call again after a
 * crash (R06-02: `delete_file` reported an error the second time). A built-in that is declared idempotent and has
 * no case here fails the test, so a new one cannot ship without being checked.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonObject } from "../../src/core/json.ts";
import { createBuiltinTools } from "../../src/tools/builtin.ts";
import type { ToolContext, ToolDefinition } from "../../src/tools/types.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { fileToolContext } from "../helpers/tool-context.ts";

interface IdempotentCase { prepare(workspace: string): Promise<void>; args: JsonObject }

const cases: Record<string, IdempotentCase> = {
  write_file: { prepare: async () => undefined, args: { path: "a/b.txt", content: "same" } },
  delete_file: {
    prepare: async (workspace) => {
      await writeFile(join(workspace, "gone.txt"), "bye");
      await writeFile(join(workspace, "stays.txt"), "kept");
    },
    args: { path: "gone.txt" },
  },
};

function builtins(): ToolDefinition[] {
  return createBuiltinTools({
    files: { maxReadBytes: 65_536, maxWriteBytes: 65_536 },
    shell: { enabled: true, timeoutMs: 1000, outputBytes: 1024 },
    webFetch: { timeoutMs: 1000, maxBytes: 1024, maxRedirects: 0, lookup: async () => [{ address: "127.0.0.1", family: 4 }] },
  });
}

/**
 * Every entry under `root` (directories with a trailing "/"), with the content of each file, except Runwright's own
 * `.runwright/` folder at the root (the workspace stage lives there).
 */
async function snapshot(root: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix + entry.name;
      if (relative === ".runwright") continue;
      if (entry.isDirectory()) {
        found[`${relative}/`] = "";
        await walk(join(dir, entry.name), `${relative}/`);
      } else {
        found[relative] = await readFile(join(dir, entry.name), "utf8");
      }
    }
  };
  await walk(root, "");
  return found;
}

async function contextIn(t: TestContext): Promise<ToolContext> {
  const workspace = join(await makeTempDir(t, "runwright-idem-"), "ws");
  await mkdir(workspace);
  return fileToolContext(workspace);
}

test("the idempotent built-ins are exactly delete_file and write_file; edit_file and shell are not", () => {
  const tools = builtins();
  assert.ok(tools.some((tool) => tool.name === "shell"), "the list includes shell");
  assert.deepEqual(tools.filter((tool) => tool.idempotent === true).map((tool) => tool.name).sort(), ["delete_file", "write_file"]);
  for (const name of ["edit_file", "shell"]) {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.ok(tool !== undefined, name);
    assert.notEqual(tool.idempotent, true, `${name} must not be declared idempotent`);
  }
});

test("every built-in declared idempotent succeeds when invoked again and leaves the same state", async (t) => {
  for (const tool of builtins().filter((candidate) => candidate.idempotent === true)) {
    const testCase = cases[tool.name];
    assert.ok(testCase !== undefined, `the built-in tool "${tool.name}" is declared idempotent but has no case in the conformance table`);
    const context = await contextIn(t);
    await testCase.prepare(context.workspace);
    const first = await tool.handler(testCase.args, context);
    assert.notEqual(first.isError, true, `${tool.name} first invocation: ${first.content}`);
    const afterFirst = await snapshot(context.workspace);
    const second = await tool.handler(testCase.args, context);
    assert.notEqual(second.isError, true, `${tool.name} second invocation: ${second.content}`);
    assert.deepEqual(await snapshot(context.workspace), afterFirst, `${tool.name} leaves the same workspace state`);
  }
});

test("the cases leave the end state each tool promises", async (t) => {
  const tools = new Map(builtins().map((tool) => [tool.name, tool]));
  const write = await contextIn(t);
  const writeFileTool = tools.get("write_file");
  assert.ok(writeFileTool !== undefined);
  await writeFileTool.handler({ path: "a/b.txt", content: "same" }, write);
  const again = await writeFileTool.handler({ path: "a/b.txt", content: "same" }, write);
  assert.deepEqual(again, {
    content: "wrote 4 bytes to a/b.txt",
    data: { path: "a/b.txt", bytes: 4, sha256: createHash("sha256").update("same").digest("hex") },
  });
  assert.deepEqual(await snapshot(write.workspace), { "a/": "", "a/b.txt": "same" });

  const del = await contextIn(t);
  const deleteFileTool = tools.get("delete_file");
  assert.ok(deleteFileTool !== undefined);
  await writeFile(join(del.workspace, "gone.txt"), "bye");
  assert.deepEqual((await deleteFileTool.handler({ path: "gone.txt" }, del)).data, { path: "gone.txt", deleted: true });
  assert.deepEqual((await deleteFileTool.handler({ path: "gone.txt" }, del)).data, { path: "gone.txt", deleted: false });
  assert.deepEqual(await snapshot(del.workspace), {});
});
