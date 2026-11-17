import { randomBytes } from "node:crypto";
import { chmod, link, mkdir, open, readFile, stat, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { syncDirectoryOnDisk, syncEntryChain, type EntrySync } from "../core/durable-fs.ts";
import { RunwrightError } from "../core/errors.ts";
import { generateSealKey, parseSealKey } from "../security/seal.ts";
import { generateToken } from "../security/token.ts";
import type { Config } from "./types.ts";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** How `ensureDataDir` makes what it creates durable; each default is the real sync. */
export interface DataDirSync {
  /** Syncs a newly written file (default: `handle.sync()`). */
  file?: (handle: FileHandle, path: string) => Promise<void>;
  /** Syncs a directory's entries (default: `syncDirectoryOnDisk`). */
  directory?: (dir: string) => Promise<void>;
  /** Whether this process may create entries in a directory above the data directory (default: `access` with W_OK). */
  writable?: (dir: string) => Promise<boolean>;
}

interface Syncs {
  file: (handle: FileHandle, path: string) => Promise<void>;
  directory: (dir: string) => Promise<void>;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

async function tightenMode(path: string): Promise<void> {
  const info = await stat(path);
  if ((info.mode & 0o077) !== 0) await chmod(path, FILE_MODE);
}

/**
 * Reads `path`, or creates it with `create()` when absent. Creation is exclusive and atomic: the content is
 * written to a private temp file (opened with `wx`, mode 0600) and hard-linked into place, so a concurrent
 * creator either wins or reads the complete file of the one that did. The temp file is synced before the link and
 * the directory after it, so a created file and its directory entry survive a power loss. A file that is found
 * (already there, or linked by a concurrent creator that won) is returned without a sync here: its bytes were
 * synced before its link, and `ensureDataDir` syncs the data directory, which holds its entry, on every call.
 */
async function readOrCreate(path: string, create: () => string, sync: Syncs): Promise<string> {
  try {
    const existing = await readFile(path, "utf8");
    await tightenMode(path);
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const content = create();
  try {
    const handle = await open(temp, "wx", FILE_MODE);
    try {
      await handle.writeFile(`${content}\n`);
      await handle.chmod(FILE_MODE);
      await sync.file(handle, temp);
    } finally {
      await handle.close();
    }
    try {
      await link(temp, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const winner = await readFile(path, "utf8");
      await tightenMode(path);
      return winner;
    }
    await sync.directory(dirname(path));
    return content;
  } finally {
    // Normally the temporary file was renamed into place, so there is nothing to remove (ENOENT).
    await unlink(temp).catch(() => undefined);
  }
}

/**
 * Creates the data directory (with `workspaces/` and `archive/`, mode 0700) and returns the API token and the
 * seal key. `RUNWRIGHT_TOKEN` and `RUNWRIGHT_SEAL_KEY` are used as given, with no file written; otherwise
 * `<dataDir>/token` and `<dataDir>/seal.key` are read, or generated once with mode 0600.
 * `tokenPath` is always `<dataDir>/token`; that file does not exist when `RUNWRIGHT_TOKEN` is set.
 * Each new file is synced before it is linked into place, and the data directory after each link. Then, on every
 * call, after the token and the seal key exist (created, found, or given in the environment), the data directory is
 * synced, and then the entry of every directory above it, up to the file-system root, deepest first: whoever
 * created those directories and whether or not an earlier start already synced them, so a start that was
 * interrupted between creating an entry and syncing it is repaired by the next start. A directory above the data
 * directory whose sync fails with EACCES or EROFS is skipped only when this process may not write to it (it cannot
 * hold an entry this user created); the data directory itself is never skipped. Any other failing sync rejects the
 * start.
 * `durability` replaces the syncs (a function replaces the directory sync alone).
 */
export async function ensureDataDir(
  config: Config,
  env: NodeJS.ProcessEnv,
  durability: DataDirSync | ((dir: string) => Promise<void>) = {},
): Promise<{ token: string; tokenPath: string; sealKey: Buffer }> {
  const given: DataDirSync = typeof durability === "function" ? { directory: durability } : durability;
  const sync: Syncs = {
    file: given.file ?? ((handle) => handle.sync()),
    directory: given.directory ?? syncDirectoryOnDisk,
  };
  const dataDir = config.dataDir;
  await mkdir(dataDir, { recursive: true, mode: DIR_MODE });
  for (const child of ["workspaces", "archive"]) await mkdir(join(dataDir, child), { recursive: true, mode: DIR_MODE });

  const tokenPath = join(dataDir, "token");
  let token = envValue(env, "RUNWRIGHT_TOKEN");
  if (token === undefined) {
    token = (await readOrCreate(tokenPath, generateToken, sync)).trim();
    if (token === "") throw new RunwrightError("config_invalid", `the token file ${tokenPath} is empty`);
  }

  const keyText = envValue(env, "RUNWRIGHT_SEAL_KEY");
  let sealKey: Buffer;
  if (keyText !== undefined) {
    try {
      sealKey = parseSealKey(keyText);
    } catch (error) {
      throw new RunwrightError("config_invalid", `RUNWRIGHT_SEAL_KEY: ${(error as Error).message}`);
    }
  } else {
    const keyPath = join(dataDir, "seal.key");
    const stored = await readOrCreate(keyPath, () => generateSealKey().toString("base64"), sync);
    try {
      sealKey = parseSealKey(stored);
    } catch (error) {
      throw new RunwrightError("config_invalid", `${keyPath}: ${(error as Error).message}`);
    }
  }
  await sync.directory(dataDir);
  const entries: EntrySync = { directory: sync.directory };
  if (given.writable !== undefined) entries.writable = given.writable;
  await syncEntryChain(dataDir, entries);
  return { token, tokenPath, sealKey };
}
