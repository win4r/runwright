/**
 * What `limitToolResult` finds under a saved result's final name (finding R12-01): the name is predictable, so a
 * `shell` call can plant a FIFO, a symbolic link or a directory there. Only a regular file with exactly the
 * result's bytes is kept; anything else is replaced, and a FIFO never blocks the call.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isRunwrightError } from "../../src/core/errors.ts";
import { limitToolResult, savedResultName } from "../../src/engine/results.ts";
import { makeFifo, printedJson, runBounded, specialFilesFixture } from "../helpers/special-files.ts";
import { claimWorkspaceStage } from "../../src/tools/workspace-stage.ts";
import { makeTempDir } from "../helpers/tmp.ts";

const KEY = "t1.c0";
const BYTES = 40;
/** The content `publish-result.ts` saves: "r" repeated BYTES times. */
const CONTENT = "r".repeat(BYTES);
const RELATIVE = `.runwright/tool-results/${savedResultName(KEY, createHash("sha256").update(CONTENT).digest("hex"))}.txt`;

async function setup(t: TestContext): Promise<{ root: string; outside: string; final: string }> {
  const base = await makeTempDir(t, "runwright-results-special-");
  const root = join(base, "ws");
  const outside = join(base, "outside");
  await mkdir(join(root, ".runwright", "tool-results"), { recursive: true });
  await claimWorkspaceStage(root, 1);
  await mkdir(outside);
  return { root, outside, final: join(root, RELATIVE) };
}

function publish(root: string): ReturnType<typeof limitToolResult> {
  return limitToolResult({
    workspace: root, epoch: 1, key: KEY, limitBytes: 16, outcome: "ok", content: CONTENT, data: null, isError: false, untrusted: false,
  });
}

async function assertRegularWithContent(final: string): Promise<void> {
  const info = await lstat(final);
  assert.ok(info.isFile(), "the final name holds a regular file");
  assert.equal(await readFile(final, "utf8"), CONTENT);
}

test("a FIFO planted under the final name does not block the save and is replaced by the result", { skip: process.platform === "win32" }, async (t) => {
  const { root, final } = await setup(t);
  makeFifo(final);
  const printed = printedJson(await runBounded(specialFilesFixture("publish-result.ts"), [root, KEY, String(BYTES)]));
  assert.deepEqual(printed, {
    fullResultPath: RELATIVE, fullResultSha256: createHash("sha256").update(CONTENT).digest("hex"), fullResultBytes: BYTES,
  });
  await assertRegularWithContent(final);
});

test("a symbolic link to an outside file with the same bytes is replaced; the outside file is unchanged", async (t) => {
  const { root, outside, final } = await setup(t);
  const target = join(outside, "same.txt");
  await writeFile(target, CONTENT);
  await symlink(target, final);
  const shaped = await publish(root);
  assert.equal(shaped.fullResultPath, RELATIVE);
  assert.ok(!(await lstat(final)).isSymbolicLink(), "the link is not left under the journalled name");
  await assertRegularWithContent(final);
  assert.equal(await readFile(target, "utf8"), CONTENT);
  assert.ok((await lstat(target)).isFile());
});

test("a symbolic link to other bytes, and a regular file with other bytes, are replaced", async (t) => {
  const { root, outside, final } = await setup(t);
  const target = join(outside, "other.txt");
  await writeFile(target, "other bytes entirely");
  await symlink(target, final);
  await publish(root);
  await assertRegularWithContent(final);
  assert.equal(await readFile(target, "utf8"), "other bytes entirely");

  const second = await setup(t);
  await writeFile(second.final, "r".repeat(BYTES - 1) + "s");
  await publish(second.root);
  await assertRegularWithContent(second.final);
});

test("a longer regular file that starts with the same bytes is replaced", async (t) => {
  const { root, final } = await setup(t);
  await writeFile(final, `${CONTENT}and more`);
  await publish(root);
  await assertRegularWithContent(final);
});

test("a regular file with the same bytes is left untouched (same inode)", async (t) => {
  const { root, final } = await setup(t);
  await writeFile(final, CONTENT);
  const before = await lstat(final);
  await publish(root);
  const after = await lstat(final);
  assert.equal(after.ino, before.ino);
  assert.equal(after.dev, before.dev);
  await assertRegularWithContent(final);
});

test("a directory planted under the final name is the existing internal error", async (t) => {
  const { root, final } = await setup(t);
  await mkdir(final);
  await assert.rejects(publish(root), (error) => isRunwrightError(error) && error.code === "internal"
    && error.message.startsWith(`could not save the full result of step ${KEY}: `));
  assert.ok((await lstat(final)).isDirectory());
});
