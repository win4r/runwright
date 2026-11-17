/**
 * The workspace stage: how a runner that lost its lease is kept from changing a workspace file (rule F).
 *
 * **Rule F.** Every change the built-in file tools and the engine make inside a workspace has, as its one effective
 * system call, a `rename` or `link` whose source or destination lies in `<workspace>/.runwright/stage/<epoch>`,
 * the staging folder of the writer's own lease epoch. That folder is created only by `claimWorkspaceStage`, never
 * by a writer, and the next claimant renames it away before its first step. A stale runner may check its lease,
 * its signal or a lock file and then freeze for any length of time after the check; what stops it is that the
 * system call itself fails (`ENOENT`: its folder is gone), however late it wakes up.
 *
 * A claim of epoch E runs three steps, in this order:
 *   1. `mkdir -p <ws>/.runwright/stage`, then `mkdir <ws>/.runwright/stage/<E>` (`EEXIST` is fine).
 *   2. List `stage/`. If a folder of an epoch above E exists, remove E's own folder (best effort) and fail with
 *      `lease_lost`.
 *   3. Rename every other entry (an epoch below E, or a name that is not an epoch) to
 *      `<ws>/.runwright/unstage/<random>` (one atomic rename; `ENOENT` means another claimant already did it), then
 *      delete it recursively, and delete whatever an earlier claimant left in `unstage/`.
 *
 * Why no stale writer gets through. Let E < M be two claims of the same workspace (M is the successor, and its
 * store claim, which made E's lease stale, precedes its stage claim).
 *   (a) If E's step 2 comes after M's step 1, E sees M's folder and stops: it never runs a step. M's folder is not
 *       removed meanwhile, because only a claim above M removes it, and then that claim's folder is seen instead.
 *   (b) If E's step 2 came before M's step 1, E's step 1 came earlier still, so E's folder existed when M's step 1
 *       ran; M's step 2 listing (after its step 1) sees it and M's step 3 renames it away before M's first step.
 *       From then on every path below `stage/<E>/` is gone: an open of a new temp file, a `rename` or `link` of a
 *       temp file that was written before, and a `rename` into it all fail with `ENOENT`. A call of E that took
 *       effect before that rename took effect before M's first step, which is what fencing allows.
 *   (c) A folder once renamed away is never created again: only step 1 creates it, step 2 follows, and every writer
 *       opens its temp file with `O_CREAT` in an existing folder and never creates the folder itself.
 * The folder of the highest epoch is never deleted, also not when its run ends: it is what makes a late step 2 of
 * an older epoch fail. So at most one folder stays in `stage/` per workspace.
 *
 * One effect is not staged: a write creates the missing parent directories of its target (`mkdir -p`) after its
 * temp file exists and before its rename. A writer fenced before it created its temp file creates nothing; one
 * that created it before the takeover and wakes up later can still leave empty directories, never content. (A
 * directory cannot be renamed into place without risk: `rename` replaces an existing empty directory, and a file
 * another writer is linking into that directory at the same moment would be lost.)
 *
 * `shell` and host tools are outside rule F: they write with their own system calls, and a stale runner's
 * command that is still running can still change files. They get `context.signal`.
 */
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import * as fsp from "node:fs/promises";
import { dirname, join } from "node:path";
import { RunwrightError } from "../core/errors.ts";

/** `.runwright/stage`, relative to the workspace. */
export const STAGE_DIR = ".runwright/stage";

/** Where a claimant moves the folders it removes, relative to the workspace, before it deletes them. */
export const UNSTAGE_DIR = ".runwright/unstage";

/** Injected file-system calls, for tests that stop a writer between its temp file and its rename. */
export interface StageSeams { rename?: typeof import("node:fs/promises").rename; link?: typeof import("node:fs/promises").link }

const EPOCH_NAME = /^(0|[1-9][0-9]*)$/;

function checkedEpoch(epoch: number): number {
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new RunwrightError("internal", `a workspace stage needs a lease epoch that is a safe integer >= 0, got ${String(epoch)}`);
  }
  return epoch;
}

/** The staging folder of one claim: `<workspace>/.runwright/stage/<epoch>`. */
export function stagePath(workspace: string, epoch: number): string {
  return join(workspace, STAGE_DIR, String(checkedEpoch(epoch)));
}

function codeOf(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function randomName(): string {
  return randomBytes(12).toString("hex");
}

function fenced(workspace: string, epoch: number): RunwrightError {
  return new RunwrightError("lease_lost", `the lease of epoch ${epoch} on this run was taken over: its workspace stage is gone`, {
    details: { workspace, epoch },
  });
}

/** True when `path` exists (an `lstat` that succeeds); `ENOENT` and `ENOTDIR` are false, anything else throws. */
async function present(path: string): Promise<boolean> {
  try {
    await fsp.lstat(path);
    return true;
  } catch (error) {
    const code = codeOf(error);
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

/** True when `stage/` holds the folder of an epoch above `epoch`: a later claim of this workspace happened. */
async function superseded(workspace: string, epoch: number): Promise<boolean> {
  let names: string[];
  try {
    names = await fsp.readdir(join(workspace, STAGE_DIR));
  } catch (error) {
    const code = codeOf(error);
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
  return names.some((name) => EPOCH_NAME.test(name) && Number(name) > epoch);
}

/**
 * Classifies a system call into or out of the stage that failed with `ENOENT` or `ENOTDIR`. The call had no
 * effect either way; this only names the cause. When this epoch's staging folder is gone and a later claim's
 * folder exists, the lease was taken over: `lease_lost` (by (c) the folder is gone for good, and the folder of the
 * highest claim is never removed, so a takeover always leaves one). Otherwise (the folder is there, so a path
 * outside the stage was missing, or the stage was destroyed by something other than a claim) the original error.
 */
async function fencedOr(workspace: string, epoch: number, error: unknown): Promise<unknown> {
  const code = codeOf(error);
  if (code !== "ENOENT" && code !== "ENOTDIR") return error;
  if (await present(stagePath(workspace, epoch))) return error;
  return (await superseded(workspace, epoch)) ? fenced(workspace, epoch) : error;
}

/** Moves `entry` (a name in `stage/`) to `unstage/` with one rename and deletes it there. */
async function unstage(workspace: string, entry: string): Promise<void> {
  const moved = join(workspace, UNSTAGE_DIR, randomName());
  try {
    await fsp.rename(join(workspace, STAGE_DIR, entry), moved);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return;
    throw error;
  }
  await fsp.rm(moved, { recursive: true, force: true });
}

/**
 * Called once per claim, before any step runs. Creates this epoch's staging folder, refuses (lease_lost) when a
 * folder of a higher epoch exists, and atomically renames away and deletes every folder of a lower epoch.
 */
export async function claimWorkspaceStage(workspace: string, epoch: number): Promise<void> {
  const own = stagePath(workspace, epoch);
  const stage = join(workspace, STAGE_DIR);
  await fsp.mkdir(stage, { recursive: true });
  try {
    await fsp.mkdir(own);
  } catch (error) {
    if (codeOf(error) !== "EEXIST") throw error;
  }
  const entries = await fsp.readdir(stage);
  const ownName = String(epoch);
  if (entries.some((name) => EPOCH_NAME.test(name) && Number(name) > epoch)) {
    await fsp.rm(own, { recursive: true, force: true }).catch(() => undefined);
    throw fenced(workspace, epoch);
  }
  await fsp.mkdir(join(workspace, UNSTAGE_DIR), { recursive: true });
  for (const name of entries) {
    if (name !== ownName) await unstage(workspace, name);
  }
  for (const name of await fsp.readdir(join(workspace, UNSTAGE_DIR))) {
    await fsp.rm(join(workspace, UNSTAGE_DIR, name), { recursive: true, force: true });
  }
}

/**
 * Creates a new temp file in this epoch's staging folder holding `bytes` (synced first when `sync` is true) and
 * returns its path. Never creates the folder: an open that finds it taken over is `lease_lost` (`fencedOr`).
 */
async function stagedTemp(workspace: string, epoch: number, bytes: Uint8Array, sync: boolean): Promise<string> {
  const temp = join(stagePath(workspace, epoch), `${randomName()}.tmp`);
  let handle;
  try {
    handle = await fsp.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  } catch (error) {
    throw await fencedOr(workspace, epoch, error);
  }
  try {
    try {
      await handle.writeFile(bytes);
      if (sync) await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    await fsp.unlink(temp).catch(() => undefined);
    throw error;
  }
  return temp;
}

/** Writes `bytes` to `target` through a temp file in the staging folder and one rename. lease_lost when fenced. */
export async function stagedWrite(workspace: string, epoch: number, target: string, bytes: Uint8Array, seams?: StageSeams): Promise<void> {
  const rename = seams?.rename ?? fsp.rename;
  const temp = await stagedTemp(workspace, epoch, bytes, false);
  try {
    await fsp.mkdir(dirname(target), { recursive: true });
    try {
      await rename(temp, target);
    } catch (error) {
      throw await fencedOr(workspace, epoch, error);
    }
  } catch (error) {
    await fsp.unlink(temp).catch(() => undefined);
    throw error;
  }
}

/**
 * Publishes `bytes` at `target` without replacing another file: a synced temp file in the staging folder is
 * linked to `target` (`link` never replaces). When `target` already exists, `keep(target)` decides: true leaves
 * it untouched, false replaces it with one rename of the temp file. The temp file's own name is removed in every
 * case. A fenced writer's `link` and `rename` both fail (lease_lost); so does the open of its temp file.
 */
export async function stagedPublish(
  workspace: string, epoch: number, target: string, bytes: Uint8Array, keep: (target: string) => Promise<boolean>, seams?: StageSeams,
): Promise<void> {
  const rename = seams?.rename ?? fsp.rename;
  const link = seams?.link ?? fsp.link;
  const temp = await stagedTemp(workspace, epoch, bytes, true);
  try {
    await fsp.mkdir(dirname(target), { recursive: true });
    try {
      await link(temp, target);
    } catch (error) {
      if (codeOf(error) !== "EEXIST") throw await fencedOr(workspace, epoch, error);
      if (!(await keep(target))) {
        try {
          await rename(temp, target);
        } catch (renameError) {
          throw await fencedOr(workspace, epoch, renameError);
        }
      }
    }
  } finally {
    // After a link the temp file is a second name of the published file; after a rename it is gone (ENOENT).
    await fsp.unlink(temp).catch(() => undefined);
  }
}

/** Removes the file `entry` by renaming it into the staging folder. false: it was already absent. lease_lost when fenced. */
export async function stagedRemove(workspace: string, epoch: number, entry: string, seams?: StageSeams): Promise<boolean> {
  const rename = seams?.rename ?? fsp.rename;
  const moved = join(stagePath(workspace, epoch), `${randomName()}.del`);
  try {
    await rename(entry, moved);
  } catch (error) {
    // The folder exists now, so by (c) it existed at the rename: the ENOENT was about `entry`.
    if (codeOf(error) === "ENOENT" && (await present(stagePath(workspace, epoch)))) return false;
    throw await fencedOr(workspace, epoch, error);
  }
  const info = await fsp.lstat(moved).catch(() => null);
  if (info !== null && info.isDirectory()) {
    // The entry became a directory after the caller checked it; only files are removed, so it goes back.
    await rename(moved, entry);
    throw Object.assign(new Error(`${entry}: is a directory`), { code: "EISDIR" });
  }
  // The rename was the effect; a successor may already have removed the staging folder with this file in it.
  await fsp.unlink(moved).catch(() => undefined);
  return true;
}
