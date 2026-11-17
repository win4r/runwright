import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { RunwrightError } from "../../src/core/errors.ts";
import { directoryChain, syncDirectoryOnDisk, syncEntryChain, syncHolder } from "../../src/core/durable-fs.ts";
import { makeTempDir } from "../helpers/tmp.ts";

const ROOT = parse(process.cwd()).root;

function fsError(code: string, message = `${code} error`): Error {
  return Object.assign(new Error(message), { code });
}

/** Every ancestor of `dir`, by repeated dirname, as an independent oracle for directoryChain. */
function ancestors(dir: string): string[] {
  const out = [dir];
  while (dirname(out[out.length - 1] as string) !== out[out.length - 1]) out.push(dirname(out[out.length - 1] as string));
  return out;
}

test("directoryChain: an absolute path runs up to the root inclusive", () => {
  const dir = join(ROOT, "a", "b", "c");
  assert.deepEqual(directoryChain(dir), [dir, join(ROOT, "a", "b"), join(ROOT, "a"), ROOT]);
});

test("directoryChain: relative and non-normalised paths are resolved first", () => {
  assert.deepEqual(directoryChain("x/y"), ancestors(resolve("x/y")));
  assert.equal(directoryChain("x/y")[0], resolve(process.cwd(), "x", "y"));
  const odd = directoryChain("a/../b/./c");
  assert.equal(odd[0], resolve("b/c"));
  assert.deepEqual(odd, ancestors(resolve("b", "c")));
});

test("directoryChain: stopAt ends the chain there, inclusive; stopAt equal to dir gives dir alone", () => {
  const dir = join(ROOT, "a", "b", "c");
  assert.deepEqual(directoryChain(dir, join(ROOT, "a")), [dir, join(ROOT, "a", "b"), join(ROOT, "a")]);
  assert.deepEqual(directoryChain(dir, join(ROOT, "a", "b", "..")), [dir, join(ROOT, "a", "b"), join(ROOT, "a")], "stopAt is resolved");
  assert.deepEqual(directoryChain(dir, dir), [dir]);
  assert.deepEqual(directoryChain("p/q/../r", "p/r"), [resolve("p/r")]);
  assert.deepEqual(directoryChain(dir, ROOT), [dir, join(ROOT, "a", "b"), join(ROOT, "a"), ROOT]);
});

test("directoryChain: the root itself is a chain of one", () => {
  assert.deepEqual(directoryChain(ROOT), [ROOT]);
  assert.deepEqual(directoryChain(ROOT, ROOT), [ROOT]);
});

test("directoryChain: a stopAt off the chain is an internal error naming both paths", () => {
  const dir = join(ROOT, "a", "b", "c");
  for (const stopAt of [join(ROOT, "x"), join(ROOT, "a", "bb"), join(dir, "deeper")]) {
    assert.throws(() => directoryChain(dir, stopAt), (error: unknown) =>
      error instanceof RunwrightError && error.code === "internal" && error.message.includes(dir) && error.message.includes(stopAt), stopAt);
  }
});

test("syncEntryChain syncs every directory after the first, deepest first, and never the first", async () => {
  const dir = join(ROOT, "a", "b", "c", "d");
  const synced: string[] = [];
  await syncEntryChain(dir, { directory: async (d) => void synced.push(d) });
  assert.deepEqual(synced, directoryChain(dir).slice(1));
  assert.ok(!synced.includes(dir));
});

test("syncEntryChain with stopAt ends at stopAt inclusive", async () => {
  const dir = join(ROOT, "a", "b", "c", "d");
  const synced: string[] = [];
  await syncEntryChain(dir, { directory: async (d) => void synced.push(d), stopAt: join(ROOT, "a", "b") });
  assert.deepEqual(synced, [join(ROOT, "a", "b", "c"), join(ROOT, "a", "b")]);
  synced.length = 0;
  await syncEntryChain(dir, { directory: async (d) => void synced.push(d), stopAt: dir });
  assert.deepEqual(synced, [], "a chain of one syncs nothing");
});

test("syncEntryChain: a rejection stops the walk and propagates unchanged; nothing after it is synced", async () => {
  const dir = join(ROOT, "a", "b", "c", "d");
  const chain = directoryChain(dir);
  for (let i = 1; i < chain.length; i++) {
    const failing = chain[i] as string;
    const failure = fsError("EIO", `cannot sync ${failing}`);
    const synced: string[] = [];
    await assert.rejects(
      syncEntryChain(dir, {
        directory: async (d) => {
          synced.push(d);
          if (d === failing) throw failure;
        },
        writable: async () => assert.fail("writable is not asked for EIO"),
      }),
      (error: unknown) => error === failure,
    );
    assert.deepEqual(synced, chain.slice(1, i + 1), failing);
  }
});

for (const code of ["EACCES", "EROFS"]) {
  test(`rule E, ${code}: a directory this process may not write to is skipped and the walk goes on`, async () => {
    const dir = join(ROOT, "a", "b", "c");
    const asked: string[] = [];
    const synced: string[] = [];
    await syncEntryChain(dir, {
      directory: async (d) => {
        synced.push(d);
        if (d === join(ROOT, "a")) throw fsError(code);
      },
      writable: async (d) => {
        asked.push(d);
        return false;
      },
    });
    assert.deepEqual(synced, directoryChain(dir).slice(1), "the directories above the skipped one are still synced");
    assert.deepEqual(asked, [join(ROOT, "a")]);
    await syncHolder(join(ROOT, "a"), { directory: async () => { throw fsError(code); }, writable: async () => false });
  });

  test(`rule E, ${code}: a directory this process may write to rejects`, async () => {
    const failure = fsError(code);
    const dir = join(ROOT, "a", "b", "c");
    const synced: string[] = [];
    await assert.rejects(
      syncEntryChain(dir, {
        directory: async (d) => {
          synced.push(d);
          if (d === join(ROOT, "a", "b")) throw failure;
        },
        writable: async () => true,
      }),
      (error: unknown) => error === failure,
    );
    assert.deepEqual(synced, [join(ROOT, "a", "b")]);
    await assert.rejects(syncHolder(dir, { directory: async () => { throw failure; }, writable: async () => true }), (error: unknown) => error === failure);
  });
}

test("rule E does not cover other codes: EIO rejects and writable is never asked", async () => {
  let asked = 0;
  const failure = fsError("EIO");
  await assert.rejects(
    syncHolder(join(ROOT, "a"), { directory: async () => { throw failure; }, writable: async () => { asked++; return false; } }),
    (error: unknown) => error === failure,
  );
  const plain = new Error("no code at all");
  await assert.rejects(
    syncHolder(join(ROOT, "a"), { directory: async () => { throw plain; }, writable: async () => { asked++; return false; } }),
    (error: unknown) => error === plain,
  );
  assert.equal(asked, 0);
});

test("the real functions sync a real nested temp directory and every directory above it", async (t) => {
  const tmp = await makeTempDir(t);
  const dir = join(tmp, "a", "b", "c");
  await mkdir(dir, { recursive: true });
  await syncDirectoryOnDisk(dir);
  await syncEntryChain(dir);
  await syncEntryChain(dir, { stopAt: tmp });
  for (const holder of directoryChain(dir).slice(1)) await syncHolder(holder);
});

test("syncDirectoryOnDisk rejects a directory that does not exist", async (t) => {
  const tmp = await makeTempDir(t);
  await assert.rejects(syncDirectoryOnDisk(join(tmp, "missing")), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
});
