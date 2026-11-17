import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isRunwrightError } from "../../src/core/errors.ts";
import {
  isReservedWorkspacePath, isStagePath, isUnderWorkspaceDir, listWorkspaceFiles, resolveInWorkspace, safeContentType,
} from "../../src/tools/workspace.ts";
import { STAGE_DIR, UNSTAGE_DIR } from "../../src/tools/workspace-stage.ts";
import { makeTempDir } from "../helpers/tmp.ts";

const escaped = (e: unknown): boolean => isRunwrightError(e) && e.code === "workspace_escape";

async function setup(t: Parameters<typeof makeTempDir>[0]): Promise<{ root: string; outside: string }> {
  const base = await makeTempDir(t, "runwright-ws-");
  const root = join(base, "ws");
  const outside = join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "outside");
  return { root, outside };
}

test("resolves plain relative paths, including missing trailing components", async (t) => {
  const { root } = await setup(t);
  await mkdir(join(root, "a"));
  assert.equal(await resolveInWorkspace(root, "a/b.txt"), join(root, "a", "b.txt"));
  assert.equal(await resolveInWorkspace(root, "./a//c/d.txt"), join(root, "a", "c", "d.txt"));
  assert.equal(await resolveInWorkspace(root, "new/deep/file.txt"), join(root, "new", "deep", "file.txt"));
  assert.equal(await resolveInWorkspace(root, "."), root);
});

test("refuses traversal, absolute paths, backslashes, NUL and empty paths", async (t) => {
  const { root } = await setup(t);
  for (const path of ["", "..", "../outside/secret.txt", "a/../../x", "a/..", "/etc/passwd", "C:/Windows", "c:x",
    "a\\..\\b", "..\\x", "a\0b"]) {
    await assert.rejects(resolveInWorkspace(root, path), escaped, JSON.stringify(path));
  }
});

test("refuses a symlinked file that points outside", async (t) => {
  const { root, outside } = await setup(t);
  await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
  await assert.rejects(resolveInWorkspace(root, "link.txt"), escaped);
});

test("refuses a symlinked directory in the middle of the path", async (t) => {
  const { root, outside } = await setup(t);
  await mkdir(join(root, "a"));
  await symlink(outside, join(root, "a", "out"));
  await assert.rejects(resolveInWorkspace(root, "a/out/secret.txt"), escaped);
  await assert.rejects(resolveInWorkspace(root, "a/out/new-file.txt"), escaped);
});

test("refuses a dangling symlink to an outside path", async (t) => {
  const { root, outside } = await setup(t);
  await symlink(join(outside, "does-not-exist.txt"), join(root, "dangling"));
  await assert.rejects(resolveInWorkspace(root, "dangling"), escaped);
  await symlink("../outside/missing-dir", join(root, "relative-dangling"));
  await assert.rejects(resolveInWorkspace(root, "relative-dangling/x"), escaped);
});

test("allows a symlink that stays inside and returns its real target", async (t) => {
  const { root } = await setup(t);
  await mkdir(join(root, "real"));
  await writeFile(join(root, "real", "f.txt"), "x");
  await symlink("real", join(root, "alias"));
  await symlink(join(root, "real", "f.txt"), join(root, "f-link.txt"));
  assert.equal(await resolveInWorkspace(root, "alias/f.txt"), join(root, "real", "f.txt"));
  assert.equal(await resolveInWorkspace(root, "f-link.txt"), join(root, "real", "f.txt"));
});

test("works when the workspace's own path goes through a symlink", async (t) => {
  const created = await mkdtemp(join(tmpdir(), "runwright-ws-link-"));
  t.after(async () => {
    await rm(created, { recursive: true, force: true });
  });
  const real = join(created, "real-ws");
  await mkdir(real);
  await writeFile(join(real, "a.txt"), "a");
  const viaLink = join(created, "ws-link");
  await symlink(real, viaLink);
  const resolved = await resolveInWorkspace(viaLink, "a.txt");
  assert.match(resolved, /real-ws[/\\]a\.txt$/);
  await symlink(join(real, "a.txt"), join(real, "inside-link"));
  assert.equal(await resolveInWorkspace(viaLink, "inside-link"), resolved);
});

test("listWorkspaceFiles lists regular files recursively, sorted, skipping symlinks, paged", async (t) => {
  const { root, outside } = await setup(t);
  await mkdir(join(root, "b", "c"), { recursive: true });
  await writeFile(join(root, "z.txt"), "zz");
  await writeFile(join(root, "a.txt"), "a");
  await writeFile(join(root, "b", "c", "deep.md"), "deep");
  await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
  await symlink(outside, join(root, "linked-dir"));
  const all = await listWorkspaceFiles(root);
  assert.equal(all.more, false);
  assert.deepEqual(all.files.map((e) => e.path), ["a.txt", "b/c/deep.md", "z.txt"]);
  assert.deepEqual(all.files.map((e) => e.size), [1, 4, 2]);
  for (const entry of all.files) assert.ok(entry.modifiedAt > 0);
  const first = await listWorkspaceFiles(root, { limit: 2 });
  assert.deepEqual(first.files.map((e) => e.path), ["a.txt", "b/c/deep.md"]);
  assert.equal(first.more, true);
  const exact = await listWorkspaceFiles(root, { limit: 3 });
  assert.equal(exact.more, false, "exactly limit entries: nothing more");
  assert.deepEqual((await listWorkspaceFiles(root, { after: "b" })).files.map((e) => e.path), ["b/c/deep.md", "z.txt"], "after a name between two");
  assert.deepEqual((await listWorkspaceFiles(root, { after: "b/c/deep.md" })).files.map((e) => e.path), ["z.txt"], "after is exclusive");
  assert.deepEqual(await listWorkspaceFiles(root, { after: "zzz" }), { files: [], more: false });
  assert.deepEqual(await listWorkspaceFiles(root, { limit: 0 }), { files: [], more: true });
});

test("listWorkspaceFiles pages 2 500 files as 1 000 / 1 000 / 500 with no duplicate and no gap", async (t) => {
  const { root } = await setup(t);
  const expected: string[] = [];
  for (let d = 0; d < 5; d++) {
    await mkdir(join(root, `dir${d}`));
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 500; i++) {
      const name = `dir${d}/f${String(i).padStart(4, "0")}.txt`;
      expected.push(name);
      writes.push(writeFile(join(root, name), "x"));
    }
    await Promise.all(writes);
  }
  await symlink(join(root, "dir0", "f0000.txt"), join(root, "dir2", "a-link.txt"));
  expected.sort();
  const seen: string[] = [];
  const mores: boolean[] = [];
  const sizes: number[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await listWorkspaceFiles(root, { limit: 1000, ...(after === undefined ? {} : { after }) });
    sizes.push(page.files.length);
    mores.push(page.more);
    for (const entry of page.files) seen.push(entry.path);
    if (!page.more) break;
    after = page.files[page.files.length - 1]?.path;
  }
  assert.deepEqual(sizes, [1000, 1000, 500]);
  assert.deepEqual(mores, [true, true, false]);
  assert.deepEqual(seen, expected, "every file once, in order, the symlink skipped");
  const again = await listWorkspaceFiles(root, { limit: 1000 });
  assert.deepEqual(again.files.map((e) => e.path), expected.slice(0, 1000), "the order is stable");
});

test("safeContentType never yields an active content type", () => {
  const cases: [string, string, "inline" | "attachment"][] = [
    ["notes.txt", "text/plain; charset=utf-8", "inline"],
    ["page.html", "text/plain; charset=utf-8", "inline"],
    ["page.HTM", "text/plain; charset=utf-8", "inline"],
    ["icon.svg", "text/plain; charset=utf-8", "inline"],
    ["app.js", "text/plain; charset=utf-8", "inline"],
    ["style.css", "text/plain; charset=utf-8", "inline"],
    ["data.json", "text/plain; charset=utf-8", "inline"],
    ["Makefile", "text/plain; charset=utf-8", "inline"],
    ["dir/photo.PNG", "image/png", "inline"],
    ["photo.jpeg", "image/jpeg", "inline"],
    ["anim.gif", "image/gif", "inline"],
    ["pic.webp", "image/webp", "inline"],
    ["report.pdf", "application/pdf", "attachment"],
    ["archive.zip", "application/octet-stream", "attachment"],
    ["prog.exe", "application/octet-stream", "attachment"],
  ];
  for (const [path, contentType, disposition] of cases) {
    const result = safeContentType(path);
    assert.deepEqual(result, { contentType, disposition }, path);
    assert.doesNotMatch(result.contentType, /html|svg|javascript|xml/);
  }
});

test("isUnderWorkspaceDir compares directories by identity, not by spelling", async (t) => {
  const { root } = await setup(t);
  await mkdir(join(root, ".runwright", "tool-results", "untrusted"), { recursive: true });
  await writeFile(join(root, ".runwright", "tool-results", "untrusted", "1-a.txt"), "page");
  await mkdir(join(root, ".runwright-notes"));
  await mkdir(join(root, "x", ".runwright"), { recursive: true });
  await symlink(".runwright", join(root, "alias"));
  const real = await realpath(root);
  const under = (dir: string, path: string): Promise<boolean> => resolveInWorkspace(root, path).then((target) => isUnderWorkspaceDir(root, dir, target));

  assert.equal(await under(".runwright", ".runwright/tool-results/untrusted/1-a.txt"), true);
  assert.equal(await under(".runwright", ".runwright"), true);
  assert.equal(await under(".runwright", ".runwright/not-yet/deeper/file.txt"), true, "a target that does not exist yet");
  assert.equal(await under(".runwright", "alias/tool-results/new.txt"), true, "through a symbolic link");
  assert.equal(await isUnderWorkspaceDir(root, ".runwright", join(real, "alias", "x.txt")), true, "an unresolved link in the target");
  assert.equal(await under(".runwright/tool-results/untrusted", "alias/tool-results/untrusted/1-a.txt"), true);
  assert.equal(await under(".runwright/tool-results/untrusted", ".runwright/tool-results/other.txt"), false);
  assert.equal(await under(".runwright", ".runwright-notes/a.txt"), false, "a similar name is another directory");
  assert.equal(await under(".runwright", "x/.runwright/a.txt"), false, "a nested folder of the same name is another directory");
  assert.equal(await under(".runwright", "."), false, "the root itself");
  assert.equal(await isUnderWorkspaceDir(root, "missing", join(real, "missing", "a.txt")), false, "a directory that does not exist");
  assert.equal(await isUnderWorkspaceDir(root, ".runwright", join(dirname(real), "outside", ".runwright")), false, "a target outside the root");
});

test("isUnderWorkspaceDir follows another letter case exactly when the file system folds case", async (t) => {
  const { root } = await setup(t);
  await mkdir(join(root, ".runwright", "tool-results"), { recursive: true });
  await writeFile(join(root, "probe"), "");
  const folds = await stat(join(root, "PROBE")).then(() => true, () => false);
  const real = await realpath(root);
  assert.equal(await isUnderWorkspaceDir(root, ".runwright", join(real, ".RUNWRIGHT", "tool-results", "x.txt")), folds);
  assert.equal(await isUnderWorkspaceDir(root, ".runwright/tool-results", join(real, ".Runwright", "TOOL-RESULTS")), folds);
});

test("isReservedWorkspacePath: the first segment in any letter case, or the reserved folder by identity", async (t) => {
  const { root } = await setup(t);
  const reserved = async (path: string): Promise<boolean> => isReservedWorkspacePath(root, path, await resolveInWorkspace(root, path));
  for (const path of [".runwright/x.txt", "./.runwright//tool-results/untrusted/1-a.txt", ".RUNWRIGHT/x.txt", ".Runwright", ".runwright/new/file.txt"]) {
    assert.equal(await reserved(path), true, `${path} with no .runwright folder yet`);
  }
  await mkdir(join(root, ".runwright"));
  await mkdir(join(root, "real"));
  await symlink(".runwright", join(root, "alias"));
  await symlink("real", join(root, "fine"));
  assert.equal(await reserved("alias/x.txt"), true);
  assert.equal(await reserved("alias"), true);
  for (const path of [".runwright-notes/a.txt", "x/.runwright/a.txt", "runwright/a.txt", "fine/a.txt", "real", "."]) {
    assert.equal(await reserved(path), false, path);
  }
  await assert.rejects(isReservedWorkspacePath(root, "../x", join(root, "x")), escaped);
});

test("(R15D-tools-01) the run-files listing skips .runwright/stage and .runwright/unstage, never a leftover temp file", async (t) => {
  const { root } = await setup(t);
  await mkdir(join(root, STAGE_DIR, "3"), { recursive: true });
  await mkdir(join(root, UNSTAGE_DIR, "abc"), { recursive: true });
  await writeFile(join(root, STAGE_DIR, "3", "0123.tmp"), "half a write");
  await writeFile(join(root, STAGE_DIR, "3", "4567.del"), "a removed file");
  await writeFile(join(root, UNSTAGE_DIR, "abc", "89ab.tmp"), "an earlier claim");
  await mkdir(join(root, ".runwright", "tool-results"), { recursive: true });
  await writeFile(join(root, ".runwright", "tool-results", "saved.txt"), "saved");
  await writeFile(join(root, "out.txt"), "run file");
  const listed = await listWorkspaceFiles(root);
  assert.deepEqual(listed.files.map((file) => file.path), [".runwright/tool-results/saved.txt", "out.txt"]);
  for (const path of [".runwright/stage", ".runwright/stage/3/0123.tmp", ".RUNWRIGHT/Stage/3/x", "./.runwright//unstage/abc/89ab.tmp"]) {
    assert.equal(isStagePath(path), true, path);
  }
  for (const path of [".runwright", ".runwright/tool-results/saved.txt", "stage/3/x.tmp", "x/.runwright/stage/1/y.tmp", ".runwright/stages"]) {
    assert.equal(isStagePath(path), false, path);
  }
});
