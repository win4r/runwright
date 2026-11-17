/**
 * The workspace stage (rule F, plan 2.1): a claim renames the folder of every lower epoch away, and a writer whose
 * folder is gone cannot change the workspace however late it runs its rename (finding R15D-tools-01).
 */
import assert from "node:assert/strict";
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { isRunwrightError } from "../../src/core/errors.ts";
import {
  claimWorkspaceStage, STAGE_DIR, stagedRemove, stagedWrite, stagePath, UNSTAGE_DIR,
} from "../../src/tools/workspace-stage.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { holdingSeams } from "../helpers/tool-context.ts";

const leaseLost = (error: unknown): boolean => isRunwrightError(error) && error.code === "lease_lost";
const bytes = (text: string): Uint8Array => Buffer.from(text, "utf8");

async function workspace(t: TestContext): Promise<string> {
  const root = join(await makeTempDir(t, "runwright-stage-"), "ws");
  await mkdir(root);
  return root;
}

/** Every file under `dir` whose name ends with `.tmp` or `.del`, as paths relative to `dir`. */
async function leftovers(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && (entry.name.endsWith(".tmp") || entry.name.endsWith(".del"))) found.push(join(entry.parentPath, entry.name));
  }
  return found;
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false);
}

test("(R15D-tools-01) a claim creates its folder; a higher claim removes the lower folder; a lower claim is lease_lost", async (t) => {
  const root = await workspace(t);
  await claimWorkspaceStage(root, 1);
  assert.equal(stagePath(root, 1), join(root, STAGE_DIR, "1"));
  assert.deepEqual(await readdir(join(root, STAGE_DIR)), ["1"]);
  await claimWorkspaceStage(root, 1);
  assert.deepEqual(await readdir(join(root, STAGE_DIR)), ["1"], "a claim of the same epoch again is harmless");
  await claimWorkspaceStage(root, 3);
  assert.deepEqual(await readdir(join(root, STAGE_DIR)), ["3"]);
  await assert.rejects(claimWorkspaceStage(root, 2), leaseLost);
  assert.deepEqual(await readdir(join(root, STAGE_DIR)), ["3"], "the refused claim leaves no folder of its own");
  assert.deepEqual(await readdir(join(root, UNSTAGE_DIR)), []);
});

test("(R15D-tools-01) a claim also removes names in stage/ that are not epochs and leftovers in unstage/", async (t) => {
  const root = await workspace(t);
  await mkdir(join(root, STAGE_DIR, "junk", "deep"), { recursive: true });
  await writeFile(join(root, STAGE_DIR, "007"), "not an epoch name");
  await mkdir(join(root, UNSTAGE_DIR, "left-by-a-crash"), { recursive: true });
  await writeFile(join(root, UNSTAGE_DIR, "left-by-a-crash", "x.tmp"), "x");
  await claimWorkspaceStage(root, 5);
  assert.deepEqual(await readdir(join(root, STAGE_DIR)), ["5"]);
  assert.deepEqual(await readdir(join(root, UNSTAGE_DIR)), []);
});

test("(R15D-tools-01) a writer stopped after its temp file exists cannot rename once a higher epoch claimed", async (t) => {
  const root = await workspace(t);
  const target = join(root, "notes.txt");
  await claimWorkspaceStage(root, 1);
  const held = holdingSeams();
  const stale = stagedWrite(root, 1, target, bytes("stale"), held.seams);
  await held.reached;
  assert.equal((await readdir(stagePath(root, 1))).length, 1, "the stale writer's temp file is in its stage");
  await claimWorkspaceStage(root, 2);
  await stagedWrite(root, 2, target, bytes("successor"));
  held.release();
  await assert.rejects(stale, leaseLost);
  assert.equal(await readFile(target, "utf8"), "successor");
  assert.deepEqual(await leftovers(root), [], "no temp file is left anywhere under the workspace");
});

test("(R15D-tools-01) a writer that had not created its temp file when the higher claim happened is lease_lost too", async (t) => {
  const root = await workspace(t);
  const target = join(root, "notes.txt");
  await claimWorkspaceStage(root, 1);
  await claimWorkspaceStage(root, 2);
  await stagedWrite(root, 2, target, bytes("successor"));
  await assert.rejects(stagedWrite(root, 1, target, bytes("stale")), leaseLost);
  assert.equal(await readFile(target, "utf8"), "successor");
  assert.equal(await exists(stagePath(root, 1)), false, "a fenced writer never creates its staging folder");
  assert.deepEqual(await leftovers(root), []);
});

test("(R15D-tools-01) stagedRemove: fenced it is lease_lost and the file stays; current it removes, absent is false", async (t) => {
  const root = await workspace(t);
  const file = join(root, "doomed.txt");
  await writeFile(file, "kept");
  await claimWorkspaceStage(root, 1);
  const held = holdingSeams();
  const stale = stagedRemove(root, 1, file, held.seams);
  await held.reached;
  await claimWorkspaceStage(root, 2);
  held.release();
  await assert.rejects(stale, leaseLost);
  assert.equal(await readFile(file, "utf8"), "kept");
  await assert.rejects(stagedRemove(root, 1, file), leaseLost);
  assert.equal(await readFile(file, "utf8"), "kept");

  assert.equal(await stagedRemove(root, 2, file), true);
  assert.equal(await exists(file), false);
  assert.equal(await stagedRemove(root, 2, file), false, "an absent file was already removed");
  assert.equal(await stagedRemove(root, 2, join(root, "missing-folder", "x.txt")), false);
  assert.deepEqual(await readdir(stagePath(root, 2)), [], "the removed file does not stay in the stage");
});

test("(R15D-tools-01) stagedWrite creates a missing parent; a fenced writer creates no directory", async (t) => {
  const root = await workspace(t);
  await claimWorkspaceStage(root, 1);
  await stagedWrite(root, 1, join(root, "a", "b", "c.txt"), bytes("deep"));
  assert.equal(await readFile(join(root, "a", "b", "c.txt"), "utf8"), "deep");
  await claimWorkspaceStage(root, 2);
  await assert.rejects(stagedWrite(root, 1, join(root, "x", "y", "z.txt"), bytes("stale")), leaseLost);
  assert.equal(await exists(join(root, "x")), false);
});

test("(R15D-tools-01) a stage destroyed by something other than a claim is the file-system error, not lease_lost", async (t) => {
  const root = await workspace(t);
  await claimWorkspaceStage(root, 1);
  await rm(join(root, ".runwright"), { recursive: true });
  await writeFile(join(root, ".runwright"), "a file where the folder was");
  await assert.rejects(stagedWrite(root, 1, join(root, "f.txt"), bytes("x")), (error: unknown) => !leaseLost(error));
  assert.equal(await exists(join(root, "f.txt")), false);
});

test("(R15D-tools-01) after 50 claims in ascending order one folder is left in stage/ and unstage/ is empty", async (t) => {
  const root = await workspace(t);
  for (let epoch = 1; epoch <= 50; epoch += 1) {
    await claimWorkspaceStage(root, epoch);
    await stagedWrite(root, epoch, join(root, "f.txt"), bytes(String(epoch)));
  }
  assert.deepEqual(await readdir(join(root, STAGE_DIR)), ["50"]);
  assert.deepEqual(await readdir(join(root, UNSTAGE_DIR)), []);
  assert.equal(await readFile(join(root, "f.txt"), "utf8"), "50");
});

test("(R15D-tools-01) concurrent claims of many epochs leave only the highest folder, and only it can write", async (t) => {
  const root = await workspace(t);
  const epochs = Array.from({ length: 20 }, (_, i) => i + 1);
  const outcomes = await Promise.allSettled(epochs.map((epoch) => claimWorkspaceStage(root, epoch)));
  for (const outcome of outcomes) if (outcome.status === "rejected") assert.ok(leaseLost(outcome.reason), String(outcome.reason));
  assert.equal(outcomes[19]?.status, "fulfilled", "the highest claim never fails");
  assert.deepEqual(await readdir(join(root, STAGE_DIR)), ["20"]);
  for (const epoch of epochs.slice(0, -1)) await assert.rejects(stagedWrite(root, epoch, join(root, "f.txt"), bytes("stale")), leaseLost);
  await stagedWrite(root, 20, join(root, "f.txt"), bytes("current"));
  assert.equal(await readFile(join(root, "f.txt"), "utf8"), "current");
});

test("(R15D-tools-01) stagedRemove of an entry that is a directory puts it back and fails with EISDIR", async (t) => {
  const root = await workspace(t);
  await mkdir(join(root, "dir"));
  await writeFile(join(root, "dir", "inner.txt"), "inside");
  await claimWorkspaceStage(root, 1);
  await assert.rejects(stagedRemove(root, 1, join(root, "dir")), { code: "EISDIR" });
  assert.equal(await readFile(join(root, "dir", "inner.txt"), "utf8"), "inside");
  assert.deepEqual(await readdir(stagePath(root, 1)), []);
});
