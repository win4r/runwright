// Regression coverage for R11-01 at the third publish site: a saved tool result's folder and every directory above
// it up to the workspace's parent are synced, every time, also when the file was already in place.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { RunwrightError } from "../../src/core/errors.ts";
import { directoryChain } from "../../src/core/durable-fs.ts";
import { limitToolResult, savedResultName } from "../../src/engine/results.ts";
import { claimWorkspaceStage } from "../../src/tools/workspace-stage.ts";
import { makeTempDir } from "../helpers/tmp.ts";

/** A workspace laid out as the app lays it out: `<data dir>/workspaces/<run>`, its stage claimed for epoch 1. */
async function workspaceDir(t: TestContext): Promise<string> {
  const tmp = await makeTempDir(t);
  const workspace = join(tmp, "data", "workspaces", "run_1");
  await mkdir(workspace, { recursive: true });
  await claimWorkspaceStage(workspace, 1);
  return workspace;
}

function recorder(): { synced: string[]; syncDirectory: (dir: string) => Promise<void> } {
  const synced: string[] = [];
  return { synced, syncDirectory: async (dir) => void synced.push(dir) };
}

const base = { epoch: 1, limitBytes: 16, outcome: "ok" as const, isError: false };

test("content over the limit: the folder, then every directory up to and including the workspace's parent", async (t) => {
  for (const untrusted of [false, true]) {
    const workspace = await workspaceDir(t);
    const { synced, syncDirectory } = recorder();
    const shaped = await limitToolResult({ ...base, workspace, key: "t1.c0", content: "x".repeat(100), data: null, untrusted, syncDirectory });
    assert.ok(shaped.fullResultPath !== null);
    const folder = dirname(join(workspace, shaped.fullResultPath));
    assert.equal(folder, join(workspace, ".runwright", "tool-results", ...(untrusted ? ["untrusted"] : [])));
    const expected = directoryChain(folder, dirname(workspace));
    assert.deepEqual(synced, expected, `untrusted: ${untrusted}`);
    assert.equal(synced[synced.length - 1], dirname(workspace), "the last sync is <data dir>/workspaces");
    assert.ok(synced.includes(workspace));
    assert.ok(!synced.includes(dirname(dirname(workspace))), "nothing above the workspace's parent");
  }
});

test("structured data over the limit is synced the same way, and content and data each sync the whole chain", async (t) => {
  const workspace = await workspaceDir(t);
  const data = { rows: Array.from({ length: 20 }, (_, i) => `row ${i}`) };
  const folder = join(workspace, ".runwright", "tool-results");
  const chain = directoryChain(folder, dirname(workspace));

  const dataOnly = recorder();
  const shaped = await limitToolResult({ ...base, workspace, key: "t2.c0", content: "short", data, untrusted: false, syncDirectory: dataOnly.syncDirectory });
  assert.ok(shaped.fullDataPath !== null && shaped.fullResultPath === null);
  assert.deepEqual(dataOnly.synced, chain);

  const both = recorder();
  const two = await limitToolResult({ ...base, workspace, key: "t3.c0", content: "y".repeat(100), data, untrusted: false, syncDirectory: both.syncDirectory });
  assert.ok(two.fullDataPath !== null && two.fullResultPath !== null);
  assert.deepEqual(both.synced, [...chain, ...chain]);
});

test("a file already in place with the same bytes still has its whole chain synced", async (t) => {
  const workspace = await workspaceDir(t);
  const call = async (): Promise<string[]> => {
    const { synced, syncDirectory } = recorder();
    await limitToolResult({ ...base, workspace, key: "t1.c0", content: "z".repeat(100), data: null, untrusted: false, syncDirectory });
    return synced;
  };
  const chain = directoryChain(join(workspace, ".runwright", "tool-results"), dirname(workspace));
  assert.deepEqual(await call(), chain);
  assert.deepEqual(await call(), chain, "the second call found the file and synced everything again");
});

test("a file renamed over other bytes at the final name has its whole chain synced", async (t) => {
  const workspace = await workspaceDir(t);
  const content = "w".repeat(100);
  const sha = createHash("sha256").update(content).digest("hex");
  const folder = join(workspace, ".runwright", "tool-results");
  const final = join(folder, `${savedResultName("t1.c0", sha)}.txt`);
  await mkdir(folder, { recursive: true });
  await writeFile(final, "other bytes");
  const { synced, syncDirectory } = recorder();
  const shaped = await limitToolResult({ ...base, workspace, key: "t1.c0", content, data: null, untrusted: false, syncDirectory });
  assert.equal(join(workspace, shaped.fullResultPath ?? ""), final);
  assert.equal(await readFile(final, "utf8"), content);
  assert.deepEqual(synced, directoryChain(folder, dirname(workspace)));
});

test("a relative workspace walks the resolved chain and stops at the workspace's parent", async (t) => {
  const workspace = await workspaceDir(t);
  const { synced, syncDirectory } = recorder();
  await limitToolResult({ ...base, workspace: relative(process.cwd(), workspace), key: "t1.c0", content: "r".repeat(100), data: null, untrusted: false, syncDirectory });
  assert.deepEqual(synced.slice(1), directoryChain(join(workspace, ".runwright", "tool-results"), dirname(workspace)).slice(1));
  assert.equal(synced[synced.length - 1], dirname(workspace));
});

test("a rejecting sync of the folder or of any directory above it is an internal error", async (t) => {
  const workspace = await workspaceDir(t);
  const folder = join(workspace, ".runwright", "tool-results");
  const chain = directoryChain(folder, dirname(workspace));
  for (const failing of chain) {
    const synced: string[] = [];
    await assert.rejects(
      limitToolResult({
        ...base, workspace, key: "t9.c1", content: "f".repeat(100), data: null, untrusted: false,
        syncDirectory: async (dir) => {
          synced.push(dir);
          if (dir === failing) throw Object.assign(new Error(`cannot sync ${dir}`), { code: "EIO" });
        },
      }),
      (error: unknown) => error instanceof RunwrightError && error.code === "internal"
        && error.message.startsWith("could not save the full result of step t9.c1") && error.message.includes(`cannot sync ${failing}`),
      failing,
    );
    assert.equal(synced[synced.length - 1], failing, "nothing after the failing sync");
  }
});

test("without an injected sync the real directory sync is used and the call resolves", async (t) => {
  const workspace = await workspaceDir(t);
  const shaped = await limitToolResult({ ...base, workspace, key: "t1.c0", content: "d".repeat(100), data: null, untrusted: true });
  assert.ok(shaped.fullResultPath !== null);
  assert.equal(await readFile(join(workspace, shaped.fullResultPath), "utf8"), "d".repeat(100));
});
