/**
 * `src/core/regular-file.ts`: a path is opened once, without following a final link and without blocking, and a
 * read never takes more than its limit plus one byte. The FIFO case runs in a child process killed after a
 * bound, because a blocking open cannot be interrupted from inside the process.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { appendFile, mkdir, open, symlink, writeFile, type FileHandle } from "node:fs/promises";
import { createServer } from "node:net";
import { constants as osConstants } from "node:os";
import { join } from "node:path";
import { isRunwrightError } from "../../src/core/errors.ts";
import { openRegularFile, readAtMost, readRegularFile, REGULAR_READ_FLAGS } from "../../src/core/regular-file.ts";
import { makeFifo, printedJson, runBounded, specialFilesFixture } from "../helpers/special-files.ts";
import { makeTempDir } from "../helpers/tmp.ts";

const internal = (error: unknown): boolean => isRunwrightError(error) && error.code === "internal";

test("REGULAR_READ_FLAGS is read-only, no final link followed, non-blocking", () => {
  assert.equal(REGULAR_READ_FLAGS & constants.O_NOFOLLOW, constants.O_NOFOLLOW);
  assert.equal(REGULAR_READ_FLAGS & constants.O_NONBLOCK, constants.O_NONBLOCK);
  assert.equal(REGULAR_READ_FLAGS & (constants.O_WRONLY | constants.O_RDWR), 0);
});

test("a regular file: openRegularFile gives its size, readRegularFile its bytes", async (t) => {
  const dir = await makeTempDir(t);
  const path = join(dir, "a.txt");
  await writeFile(path, "hello world");
  const opened = await openRegularFile(path);
  assert.ok(opened !== null);
  try {
    assert.equal(opened.size, 11);
  } finally {
    await opened.handle.close();
  }
  const read = await readRegularFile(path, { maxBytes: 100 });
  assert.equal(read.kind, "bytes");
  assert.equal(read.kind === "bytes" ? read.bytes.toString("utf8") : "", "hello world");
  const empty = join(dir, "empty");
  await writeFile(empty, "");
  const none = await readRegularFile(empty, { maxBytes: 0 });
  assert.equal(none.kind === "bytes" ? none.bytes.length : -1, 0);
});

test("a FIFO with no writer: openRegularFile gives null and readRegularFile not_regular, without blocking", { skip: process.platform === "win32" }, async (t) => {
  const dir = await makeTempDir(t);
  const fifo = join(dir, "pipe");
  makeFifo(fifo);
  const printed = printedJson(await runBounded(specialFilesFixture("open-regular.ts"), [fifo, "10"]));
  assert.deepEqual(printed, { opened: null, read: "not_regular" });
});

test("a directory gives null; a symbolic link rejects with ELOOP; a missing path with ENOENT", async (t) => {
  const dir = await makeTempDir(t);
  await mkdir(join(dir, "sub"));
  assert.equal(await openRegularFile(join(dir, "sub")), null);
  assert.deepEqual(await readRegularFile(join(dir, "sub"), { maxBytes: 10 }), { kind: "not_regular" });
  await writeFile(join(dir, "real.txt"), "real");
  await symlink(join(dir, "real.txt"), join(dir, "link.txt"));
  await assert.rejects(openRegularFile(join(dir, "link.txt")), { code: "ELOOP" });
  await assert.rejects(readRegularFile(join(dir, "link.txt"), { maxBytes: 10 }), { code: "ELOOP" });
  await assert.rejects(openRegularFile(join(dir, "missing")), { code: "ENOENT" });
  await assert.rejects(readRegularFile(join(dir, "missing"), { maxBytes: 10 }), { code: "ENOENT" });
});

test("a socket is refused by the open or gives null", { skip: process.platform === "win32" }, async (t) => {
  const dir = await makeTempDir(t, "rw-sock-");
  const path = join(dir, "s.sock");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(path, resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const outcome = await openRegularFile(path).then(
    async (opened) => {
      if (opened !== null) await opened.handle.close();
      return opened === null ? "null" : "opened";
    },
    (error: NodeJS.ErrnoException) => (error.errno === -osConstants.errno.EOPNOTSUPP ? "EOPNOTSUPP" : error.code),
  );
  assert.ok(["null", "ENXIO", "EOPNOTSUPP"].includes(String(outcome)), String(outcome));
});

test("readAtMost: exactly maxBytes is read; one byte more is too_large with that size", async (t) => {
  const dir = await makeTempDir(t);
  await writeFile(join(dir, "ten"), "0123456789");
  await writeFile(join(dir, "eleven"), "0123456789A");
  const ten = await open(join(dir, "ten"), "r");
  const eleven = await open(join(dir, "eleven"), "r");
  try {
    const exact = await readAtMost(ten, 10);
    assert.equal(exact.kind === "bytes" ? exact.bytes.toString() : "", "0123456789");
    assert.deepEqual(await readAtMost(eleven, 10), { kind: "too_large", size: 11 });
  } finally {
    await ten.close();
    await eleven.close();
  }
});

test("readAtMost reads from the start whatever the handle's position", async (t) => {
  const dir = await makeTempDir(t);
  await writeFile(join(dir, "f"), "abcdef");
  const handle = await open(join(dir, "f"), "r");
  try {
    await handle.read(Buffer.alloc(3), 0, 3, null);
    const read = await readAtMost(handle, 6);
    assert.equal(read.kind === "bytes" ? read.bytes.toString() : "", "abcdef");
  } finally {
    await handle.close();
  }
});

test("readAtMost: a file that grows after its first fstat is too_large, never read past the cap", async (t) => {
  const dir = await makeTempDir(t);
  const path = join(dir, "grows");
  await writeFile(path, "0123456789");
  const real = await open(path, "r");
  try {
    await appendFile(path, "x".repeat(100));
    let stats = 0;
    let largestRead = 0;
    const wrapped = {
      async stat() {
        stats += 1;
        const info = await real.stat();
        return stats === 1 ? { size: 10 } : info;
      },
      read(buffer: Buffer, offset: number, length: number, position: number) {
        largestRead = Math.max(largestRead, offset + length);
        return real.read(buffer, offset, length, position);
      },
    } as unknown as FileHandle;
    const read = await readAtMost(wrapped, 10);
    assert.equal(read.kind, "too_large");
    assert.ok(read.kind === "too_large" && read.size >= 11, JSON.stringify(read));
    assert.ok(largestRead <= 11, `read up to byte ${largestRead}`);
  } finally {
    await real.close();
  }
});

test("an aborted signal: readRegularFile rejects before opening; readAtMost stops between chunks", async (t) => {
  const dir = await makeTempDir(t);
  const controller = new AbortController();
  const reason = new Error("stop");
  controller.abort(reason);
  await assert.rejects(readRegularFile(join(dir, "does-not-exist"), { maxBytes: 10, signal: controller.signal }), (error) => error === reason);

  const path = join(dir, "big");
  await writeFile(path, Buffer.alloc(200_000, 7));
  const real = await open(path, "r");
  try {
    const midway = new AbortController();
    const late = new Error("aborted after the first chunk");
    let reads = 0;
    const wrapped = {
      stat: () => real.stat(),
      async read(buffer: Buffer, offset: number, length: number, position: number) {
        reads += 1;
        const result = await real.read(buffer, offset, length, position);
        midway.abort(late);
        return result;
      },
    } as unknown as FileHandle;
    await assert.rejects(readAtMost(wrapped, 300_000, midway.signal), (error) => error === late);
    assert.equal(reads, 1);
    const whole = await readAtMost(real, 300_000);
    assert.equal(whole.kind === "bytes" ? whole.bytes.length : -1, 200_000);
  } finally {
    await real.close();
  }
});

test("maxBytes that is not a safe integer >= 0 is an internal error", async (t) => {
  const dir = await makeTempDir(t);
  const path = join(dir, "f");
  await writeFile(path, "abc");
  const handle = await open(path, "r");
  try {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      await assert.rejects(readAtMost(handle, bad), internal, String(bad));
      await assert.rejects(readRegularFile(path, { maxBytes: bad }), internal, String(bad));
    }
  } finally {
    await handle.close();
  }
});
