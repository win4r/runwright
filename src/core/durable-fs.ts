/**
 * Making directory entries durable. A file or directory survives a power loss only when the directory that holds
 * its entry was synced after the entry was made, and so on for every directory above it. Whether an entry is
 * durable is never inferred from which call created it: a function that must leave a path durable syncs the entry
 * of every directory on the way, every time it runs.
 */
import { access, constants, open, type FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { RunwrightError } from "./errors.ts";

/**
 * Errors that mean "this platform cannot sync a directory", not "the sync failed": Windows refuses to open or
 * flush a directory (EPERM, EISDIR), and some network and FUSE file systems reject fsync on one (EINVAL, ENOTSUP,
 * EBADF).
 */
export const DIR_SYNC_UNSUPPORTED: ReadonlySet<string> = new Set(["EINVAL", "EPERM", "EISDIR", "ENOTSUP", "EBADF"]);

/** Makes the entries of `dir` durable (open, fsync, close); a platform that cannot sync a directory is tolerated. */
export async function syncDirectoryOnDisk(dir: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(dir, "r");
    await handle.sync();
  } catch (error) {
    if (!DIR_SYNC_UNSUPPORTED.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
  } finally {
    await handle?.close();
  }
}

/**
 * `resolve(dir)`, then each parent, up to the file-system root inclusive (or up to `resolve(stopAt)` inclusive).
 * The walk is lexical (`resolve` and `dirname`); the root is the path whose `dirname` is itself. A `stopAt` that is
 * neither `dir` nor one of its ancestors is an `internal` error.
 */
export function directoryChain(dir: string, stopAt?: string): string[] {
  const end = stopAt === undefined ? undefined : resolve(stopAt);
  const chain: string[] = [];
  for (let current = resolve(dir); ; current = dirname(current)) {
    chain.push(current);
    if (current === end) return chain;
    if (dirname(current) === current) break;
  }
  if (end !== undefined) {
    throw new RunwrightError("internal", `${end} is not ${resolve(dir)} or a directory above it`);
  }
  return chain;
}

export interface EntrySync {
  /** Syncs one directory. Default: syncDirectoryOnDisk. */
  directory?: (dir: string) => Promise<void>;
  /** Whether this process may create entries in `dir`. Default: `access(dir, constants.W_OK)` resolves. */
  writable?: (dir: string) => Promise<boolean>;
}

function writableOnDisk(dir: string): Promise<boolean> {
  return access(dir, constants.W_OK).then(() => true, () => false);
}

/**
 * Syncs one directory that holds an entry of the path being made durable. A rejection with code `EACCES` (the
 * directory may not be opened) or `EROFS` (it is on a read-only file system) is tolerated only when `writable(dir)`
 * is false: a directory this process may not write to cannot hold an entry that this user created. Every other
 * rejection is rethrown unchanged, and `writable` is then not asked.
 */
export async function syncHolder(dir: string, sync: EntrySync = {}): Promise<void> {
  const directory = sync.directory ?? syncDirectoryOnDisk;
  try {
    await directory(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== "EACCES" && code !== "EROFS") throw error;
    if (await (sync.writable ?? writableOnDisk)(dir)) throw error;
  }
}

/**
 * Makes the entry of `dir`, and of every directory above it, durable: `syncHolder` for each element of
 * `directoryChain(dir, stopAt)` after the first, deepest first; stops at the first rejection, which propagates
 * unchanged. `dir` itself is not synced. Nothing is remembered between calls.
 */
export async function syncEntryChain(dir: string, options: EntrySync & { stopAt?: string } = {}): Promise<void> {
  for (const holder of directoryChain(dir, options.stopAt).slice(1)) await syncHolder(holder, options);
}
