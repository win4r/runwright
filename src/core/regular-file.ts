/**
 * Reading a path that a tool or a model can shape. The rule: such a path is opened exactly once, with
 * `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`; whether it is a regular file is decided on the opened handle (`fstat`),
 * never by a `stat` of the path before or after; and a bounded number of bytes is read from that same handle.
 *
 * Why `O_NONBLOCK`: opening a FIFO for reading waits for a writer otherwise, inside `open()` in a libuv worker
 * thread, where no signal, deadline or shutdown can end it (and a few such opens use up the worker pool of the
 * whole process). With the flag the open returns at once and `fstat` on the handle says FIFO. The flag changes
 * nothing for a regular file. `O_NOFOLLOW` refuses a final symbolic link (ELOOP), so what is read is what was
 * checked.
 */
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { RunwrightError } from "./errors.ts";

/** O_RDONLY | O_NOFOLLOW | O_NONBLOCK; a flag this platform does not have counts as 0. */
export const REGULAR_READ_FLAGS: number = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** Bytes read per call to `read`. */
const CHUNK_BYTES = 65_536;

export interface OpenedRegularFile { readonly handle: FileHandle; readonly size: number }

/**
 * Opens `path` once, without following a final symbolic link and without blocking, and returns the handle and
 * the size (from `fstat` on the handle) when what was opened is a regular file. Anything else (a FIFO, a device,
 * a directory, a socket the platform lets it open) gives null, with the handle closed. The file system's own
 * errors reject: ENOENT, ELOOP (a symbolic link), EACCES, ENXIO or EOPNOTSUPP (a socket), ... The caller closes
 * the handle.
 */
export async function openRegularFile(path: string): Promise<OpenedRegularFile | null> {
  const handle = await open(path, REGULAR_READ_FLAGS);
  let isFile: boolean;
  let size: number;
  try {
    const info = await handle.stat();
    isFile = info.isFile();
    size = info.size;
  } catch (error) {
    // The error being thrown is the one to report; a failed close of the same handle adds nothing.
    await handle.close().catch(() => undefined);
    throw error;
  }
  if (!isFile) {
    await handle.close();
    return null;
  }
  return { handle, size };
}

export type BoundedRead = { kind: "bytes"; bytes: Buffer } | { kind: "too_large"; size: number };

function checkMaxBytes(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RunwrightError("internal", `maxBytes must be a safe integer >= 0, got ${String(maxBytes)}`);
  }
}

/**
 * Reads the file behind `handle` from its start. `fstat` first: a size over `maxBytes` is `too_large` and
 * nothing is read. Otherwise chunks of at most 65 536 bytes are read until the end of the file or until
 * `maxBytes + 1` bytes were read; more than `maxBytes` (the file grew) is `too_large` with `size` the larger of
 * what was read and the size a second `fstat` reports. Memory in use never exceeds `maxBytes + 1` bytes plus one
 * chunk. `signal` is checked before each chunk; when it is aborted the call rejects with `signal.reason`.
 * `maxBytes` must be a safe integer >= 0 (RunwrightError "internal" otherwise).
 */
export async function readAtMost(handle: FileHandle, maxBytes: number, signal?: AbortSignal): Promise<BoundedRead> {
  checkMaxBytes(maxBytes);
  const announced = (await handle.stat()).size;
  if (announced > maxBytes) return { kind: "too_large", size: announced };
  const cap = maxBytes + 1;
  // One byte more than the announced size, so that a file that grew is seen without a read past the cap.
  let buffer = Buffer.alloc(Math.min(cap, announced + 1));
  let filled = 0;
  while (filled < cap) {
    signal?.throwIfAborted();
    if (filled === buffer.length) {
      const grown = Buffer.alloc(Math.min(cap, Math.max(buffer.length * 2, filled + CHUNK_BYTES)));
      buffer.copy(grown, 0, 0, filled);
      buffer = grown;
    }
    const length = Math.min(CHUNK_BYTES, buffer.length - filled);
    const { bytesRead } = await handle.read(buffer, filled, length, filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  if (filled > maxBytes) return { kind: "too_large", size: Math.max(filled, (await handle.stat()).size) };
  return { kind: "bytes", bytes: buffer.subarray(0, filled) };
}

export type RegularRead = BoundedRead | { kind: "not_regular" };

/** `openRegularFile`, then `readAtMost`; the handle is always closed. null from the open is `not_regular`. */
export async function readRegularFile(path: string, options: { maxBytes: number; signal?: AbortSignal }): Promise<RegularRead> {
  options.signal?.throwIfAborted();
  checkMaxBytes(options.maxBytes);
  const opened = await openRegularFile(path);
  if (opened === null) return { kind: "not_regular" };
  let read: BoundedRead;
  try {
    read = await readAtMost(opened.handle, options.maxBytes, options.signal);
  } catch (error) {
    // The read error is the one to report; a failed close of the same handle adds nothing.
    await opened.handle.close().catch(() => undefined);
    throw error;
  }
  await opened.handle.close();
  return read;
}
