// Regression coverage for R11-01: the data directory's entries are synced up to the root on every start.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, readFile, readdir, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { join, parse } from "node:path";
import { RunwrightError } from "../../src/core/errors.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import { ensureDataDir } from "../../src/config/datadir.ts";
import { directoryChain } from "../../src/core/durable-fs.ts";
import { generateSealKey, parseSealKey } from "../../src/security/seal.ts";
import { makeTempDir } from "../helpers/tmp.ts";

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

test("creates the directories 0700 and the token and seal key 0600, once", async (t) => {
  const root = await makeTempDir(t);
  const dataDir = join(root, "nested", "data");
  const config = defaultConfig(dataDir);

  const first = await ensureDataDir(config, {});
  for (const dir of [dataDir, join(dataDir, "workspaces"), join(dataDir, "archive")]) {
    assert.equal(await modeOf(dir), 0o700, dir);
  }
  assert.equal(first.tokenPath, join(dataDir, "token"));
  assert.equal(await modeOf(first.tokenPath), 0o600);
  assert.equal(await modeOf(join(dataDir, "seal.key")), 0o600);
  assert.match(first.token, /^rw_[A-Za-z0-9_-]{43}$/);
  assert.equal((await readFile(first.tokenPath, "utf8")).trim(), first.token);
  assert.equal(first.sealKey.length, 32);
  assert.deepEqual(parseSealKey(await readFile(join(dataDir, "seal.key"), "utf8")), first.sealKey);

  const second = await ensureDataDir(config, {});
  assert.equal(second.token, first.token);
  assert.deepEqual(second.sealKey, first.sealKey);
  assert.deepEqual((await readdir(dataDir)).sort(), ["archive", "seal.key", "token", "workspaces"]);
});

test("RUNWRIGHT_TOKEN and RUNWRIGHT_SEAL_KEY are used without writing files", async (t) => {
  const dataDir = await makeTempDir(t);
  const key = generateSealKey();
  const result = await ensureDataDir(defaultConfig(dataDir), {
    RUNWRIGHT_TOKEN: "token-from-the-environment",
    RUNWRIGHT_SEAL_KEY: key.toString("base64url"),
  });
  assert.equal(result.token, "token-from-the-environment");
  assert.deepEqual(result.sealKey, key);
  assert.deepEqual((await readdir(dataDir)).sort(), ["archive", "workspaces"]);

  await assert.rejects(
    ensureDataDir(defaultConfig(dataDir), { RUNWRIGHT_SEAL_KEY: "too-short" }),
    (error: unknown) => error instanceof RunwrightError && error.code === "config_invalid" && /RUNWRIGHT_SEAL_KEY/.test(error.message),
  );
});

test("a token or key file readable by others is tightened to 0600", async (t) => {
  const dataDir = await makeTempDir(t);
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, "token"), "existing-token\n", { mode: 0o644 });
  await chmod(join(dataDir, "token"), 0o644);
  const key = generateSealKey();
  await writeFile(join(dataDir, "seal.key"), key.toString("base64"));
  await chmod(join(dataDir, "seal.key"), 0o666);

  const result = await ensureDataDir(defaultConfig(dataDir), {});
  assert.equal(result.token, "existing-token");
  assert.deepEqual(result.sealKey, key);
  assert.equal(await modeOf(join(dataDir, "token")), 0o600);
  assert.equal(await modeOf(join(dataDir, "seal.key")), 0o600);
});

test("a corrupt seal key file or an empty token file is config_invalid", async (t) => {
  const dataDir = await makeTempDir(t);
  await writeFile(join(dataDir, "seal.key"), "garbage!", { mode: 0o600 });
  await assert.rejects(ensureDataDir(defaultConfig(dataDir), {}), (error: unknown) =>
    error instanceof RunwrightError && error.code === "config_invalid" && /seal\.key/.test(error.message));

  const other = await makeTempDir(t);
  await writeFile(join(other, "token"), "\n", { mode: 0o600 });
  await assert.rejects(ensureDataDir(defaultConfig(other), {}), (error: unknown) =>
    error instanceof RunwrightError && error.code === "config_invalid");
});

test("concurrent first starts agree on one token and one key", async (t) => {
  const dataDir = await makeTempDir(t);
  const config = defaultConfig(dataDir);
  const results = await Promise.all(Array.from({ length: 8 }, () => ensureDataDir(config, {})));
  const first = results[0];
  assert.ok(first !== undefined);
  for (const result of results) {
    assert.equal(result.token, first.token);
    assert.deepEqual(result.sealKey, first.sealKey);
  }
  assert.equal((await readFile(join(dataDir, "token"), "utf8")).trim(), first.token);
  assert.deepEqual((await readdir(dataDir)).sort(), ["archive", "seal.key", "token", "workspaces"]);
});

test("on first creation the token and seal key are synced, the data directory after each link, then the whole chain", async (t) => {
  const root = await makeTempDir(t);
  const dataDir = join(root, "data");
  const events: string[] = [];
  const durability = {
    file: async (handle: { sync: () => Promise<void> }, path: string): Promise<void> => {
      events.push(`file ${path.replace(/\.\d+\.[0-9a-f]+\.tmp$/, ".tmp")}`);
      await handle.sync();
    },
    directory: async (dir: string): Promise<void> => {
      if (dir !== dataDir && dir !== root) return void events.push(`dir ${dir}`);
      const names = (await readdir(dir)).filter((name) => !name.endsWith(".tmp")).sort();
      events.push(`dir ${dir} [${names.join(",")}]`);
    },
  };
  const above = directoryChain(root).slice(1).map((dir) => `dir ${dir}`);
  const first = await ensureDataDir(defaultConfig(dataDir), {}, durability);
  assert.deepEqual(events, [
    `file ${join(dataDir, "token.tmp")}`,
    `dir ${dataDir} [archive,token,workspaces]`,
    `file ${join(dataDir, "seal.key.tmp")}`,
    `dir ${dataDir} [archive,seal.key,token,workspaces]`,
    `dir ${dataDir} [archive,seal.key,token,workspaces]`,
    `dir ${root} [data]`,
    ...above,
  ]);

  events.length = 0;
  const tokenIno = (await stat(join(dataDir, "token"))).ino;
  const keyIno = (await stat(join(dataDir, "seal.key"))).ino;
  const again = await ensureDataDir(defaultConfig(dataDir), {}, durability);
  assert.deepEqual(events, [
    `dir ${dataDir} [archive,seal.key,token,workspaces]`,
    `dir ${root} [data]`,
    ...above,
  ], "existing files are not rewritten, and the data directory and its whole chain are synced on every start");
  assert.equal(again.token, first.token);
  assert.deepEqual(again.sealKey, first.sealKey);
  assert.equal((await stat(join(dataDir, "token"))).ino, tokenIno);
  assert.equal((await stat(join(dataDir, "seal.key"))).ino, keyIno);
});

test("a start over a complete data directory syncs the data directory and then every directory up to the root", async (t) => {
  const root = await makeTempDir(t);
  const dataDir = join(root, "data");
  await mkdir(join(dataDir, "workspaces"), { recursive: true, mode: 0o700 });
  await mkdir(join(dataDir, "archive"), { mode: 0o700 });
  await writeFile(join(dataDir, "token"), "rw_existing\n", { mode: 0o600 });
  await writeFile(join(dataDir, "seal.key"), generateSealKey().toString("base64"), { mode: 0o600 });
  const synced: string[] = [];
  const files: string[] = [];
  const result = await ensureDataDir(defaultConfig(dataDir), {}, {
    file: async (_handle, path) => void files.push(path),
    directory: async (dir) => void synced.push(dir),
  });
  assert.equal(result.token, "rw_existing");
  assert.deepEqual(files, [], "nothing is written");
  assert.deepEqual(synced, directoryChain(dataDir));
  assert.equal(synced[synced.length - 1], parse(dataDir).root);
});

test("with the token and seal key from the environment, the data directory and its whole chain are still synced", async (t) => {
  const root = await makeTempDir(t);
  const dataDir = join(root, "data");
  const env = { RUNWRIGHT_TOKEN: "token-from-the-environment", RUNWRIGHT_SEAL_KEY: generateSealKey().toString("base64url") };
  const synced: string[] = [];
  await ensureDataDir(defaultConfig(dataDir), env, async (dir) => void synced.push(dir));
  assert.deepEqual(synced, directoryChain(dataDir), "a first start: nothing is linked, so only the trailing walk");
  synced.length = 0;
  await ensureDataDir(defaultConfig(dataDir), env, async (dir) => void synced.push(dir));
  assert.deepEqual(synced, directoryChain(dataDir));
});

test("a start after one whose ancestor sync failed syncs every ancestor up to the root", async (t) => {
  const tmp = await makeTempDir(t);
  const dataDir = join(tmp, "a", "b", "data");
  const chain = directoryChain(dataDir);
  assert.ok(chain.includes(tmp));
  for (const failing of chain) {
    await rm(join(tmp, "a"), { recursive: true, force: true });
    await assert.rejects(
      ensureDataDir(defaultConfig(dataDir), {}, async (dir) => {
        if (dir === failing) throw Object.assign(new Error(`cannot sync ${dir}`), { code: "EIO" });
      }),
      (error: unknown) => error instanceof Error && error.message === `cannot sync ${failing}`,
      failing,
    );
    const synced: string[] = [];
    await ensureDataDir(defaultConfig(dataDir), {}, async (dir) => void synced.push(dir));
    assert.deepEqual(synced.slice(-chain.length), chain, `after a failure at ${failing}: the data directory, then the whole chain`);
    assert.ok(synced.slice(0, -chain.length).every((dir) => dir === dataDir), "before the walk only the data directory (after a link)");
    assert.ok(synced.includes(tmp));
  }
});

test("a failing sync of any directory of the chain on a later start rejects it", async (t) => {
  const root = await makeTempDir(t);
  const dataDir = join(root, "data");
  await ensureDataDir(defaultConfig(dataDir), {});
  for (const failing of directoryChain(dataDir)) {
    const synced: string[] = [];
    await assert.rejects(
      ensureDataDir(defaultConfig(dataDir), {}, async (dir) => {
        synced.push(dir);
        if (dir === failing) throw Object.assign(new Error(`cannot sync ${dir}`), { code: "EIO" });
      }),
      (error: unknown) => error instanceof Error && error.message === `cannot sync ${failing}`,
      failing,
    );
    assert.equal(synced[synced.length - 1], failing, "nothing above the failing directory is synced");
  }
});

for (const code of ["EACCES", "EROFS"]) {
  test(`rule E through ensureDataDir (${code}): an unwritable ancestor is skipped, a writable one rejects`, async (t) => {
    const root = await makeTempDir(t);
    const dataDir = join(root, "data");
    await ensureDataDir(defaultConfig(dataDir), {});
    const chain = directoryChain(dataDir);
    for (const failing of chain.slice(1)) {
      const synced: string[] = [];
      const asked: string[] = [];
      const directory = async (dir: string): Promise<void> => {
        synced.push(dir);
        if (dir === failing) throw Object.assign(new Error(`cannot open ${dir}`), { code });
      };
      await ensureDataDir(defaultConfig(dataDir), {}, { directory, writable: async (dir) => { asked.push(dir); return false; } });
      assert.deepEqual(synced, chain, `${failing} skipped, every directory above it still synced`);
      assert.deepEqual(asked, [failing]);
      synced.length = 0;
      await assert.rejects(
        ensureDataDir(defaultConfig(dataDir), {}, { directory, writable: async () => true }),
        (error: unknown) => error instanceof Error && error.message === `cannot open ${failing}`,
      );
      assert.equal(synced[synced.length - 1], failing);
    }
    for (const writable of [false, true]) {
      let asked = 0;
      await assert.rejects(
        ensureDataDir(defaultConfig(dataDir), {}, {
          directory: async (dir) => {
            if (dir === dataDir) throw Object.assign(new Error(`cannot open ${dir}`), { code });
          },
          writable: async () => { asked++; return writable; },
        }),
        (error: unknown) => error instanceof Error && error.message === `cannot open ${dataDir}`,
        "the data directory itself is never skipped",
      );
      assert.equal(asked, 0);
    }
  });
}

test("a failing file sync stops the start and leaves no token behind", async (t) => {
  const dataDir = await makeTempDir(t);
  await assert.rejects(
    ensureDataDir(defaultConfig(dataDir), {}, { file: async () => { throw Object.assign(new Error("input/output error"), { code: "EIO" }); } }),
    /input\/output error/,
  );
  assert.deepEqual((await readdir(dataDir)).sort(), ["archive", "workspaces"]);
});

test("a bare function replaces the directory sync alone, and is called for the whole chain", async (t) => {
  const root = await makeTempDir(t);
  const dataDir = join(root, "data");
  const synced: string[] = [];
  await ensureDataDir(defaultConfig(dataDir), {}, async (dir) => void synced.push(dir));
  assert.deepEqual(synced, [dataDir, dataDir, ...directoryChain(dataDir)], "after the token link, after the key link, then the walk");
});
