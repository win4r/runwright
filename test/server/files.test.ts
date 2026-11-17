import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { RunwrightError } from "../../src/core/errors.ts";
import { makeFifo } from "../helpers/special-files.ts";
import { authed, errorOf, rawRequest, seedRun, startTestServer, type TestServer } from "./support.ts";
import { waitFor } from "../helpers/wait.ts";

async function withWorkspace(s: TestServer): Promise<{ runId: string; workspace: string }> {
  const run = await seedRun(s.store);
  const workspace = join(s.dir, "workspaces", run.id);
  await mkdir(join(workspace, "docs", "deep"), { recursive: true });
  await writeFile(join(workspace, "notes.txt"), "hello notes\n");
  await writeFile(join(workspace, "page.html"), "<script>alert(1)</script>");
  await writeFile(join(workspace, "docs", "deep", "a b.md"), "# spaced\n");
  await writeFile(join(workspace, "data.bin"), Buffer.from([0, 1, 2, 3]));
  await writeFile(join(s.dir, "outside-secret.txt"), "TOP SECRET OUTSIDE");
  await symlink(join(s.dir, "outside-secret.txt"), join(workspace, "escape.txt"));
  await symlink(join(workspace, "notes.txt"), join(workspace, "inside-link.txt"));
  return { runId: run.id, workspace };
}

test("files are listed; a run without a workspace has none", async (t) => {
  const s = await startTestServer(t);
  const { runId } = await withWorkspace(s);
  const files = await s.client.listFiles(runId);
  assert.deepEqual(files.map((f) => f.path), ["data.bin", "docs/deep/a b.md", "notes.txt", "page.html"]);
  assert.equal(files.find((f) => f.path === "notes.txt")?.size, 12);
  const empty = await seedRun(s.store, "other");
  assert.deepEqual(await s.client.listFiles(empty.id), []);
  assert.equal((await authed(s, "/v1/runs/run_nope/files")).status, 404);
});

test("a text file is served inline as text with the safety headers", async (t) => {
  const s = await startTestServer(t);
  const { runId } = await withWorkspace(s);
  const response = await authed(s, `/v1/runs/${runId}/files/notes.txt`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "hello notes\n");
  assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(response.headers.get("content-disposition"), "inline");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("content-security-policy"), "sandbox; default-src 'none'");
  const nested = await s.client.readFile(runId, "docs/deep/a b.md");
  assert.equal(Buffer.from(nested.body).toString("utf8"), "# spaced\n");
});

test("an .html file comes back as text/plain with nosniff; binaries are attachments", async (t) => {
  const s = await startTestServer(t);
  const { runId } = await withWorkspace(s);
  const html = await s.client.readFile(runId, "page.html");
  assert.equal(html.contentType, "text/plain; charset=utf-8");
  const binary = await authed(s, `/v1/runs/${runId}/files/data.bin`);
  assert.equal(binary.headers.get("content-type"), "application/octet-stream");
  assert.equal(binary.headers.get("content-disposition"), 'attachment; filename="data.bin"');
  assert.deepEqual(new Uint8Array(await binary.arrayBuffer()), new Uint8Array([0, 1, 2, 3]));
});

test("traversal, encoded traversal, absolute paths, NUL and an escaping symlink are 404 with no content", async (t) => {
  const s = await startTestServer(t);
  const { runId } = await withWorkspace(s);
  const paths = [
    `/v1/runs/${runId}/files/../../outside-secret.txt`,
    `/v1/runs/${runId}/files/docs/../../../outside-secret.txt`,
    `/v1/runs/${runId}/files/%2e%2e/%2e%2e/outside-secret.txt`,
    `/v1/runs/${runId}/files/%2E%2E%2F%2E%2E%2Foutside-secret.txt`,
    `/v1/runs/${runId}/files/%2F${s.dir.slice(1).split("/").join("%2F")}%2Foutside-secret.txt`,
    `/v1/runs/${runId}/files//etc/passwd`,
    `/v1/runs/${runId}/files/notes.txt%00.png`,
    `/v1/runs/${runId}/files/escape.txt`,
    `/v1/runs/${runId}/files/docs`,
    `/v1/runs/${runId}/files/missing.txt`,
    `/v1/runs/${runId}/files/%zz`,
  ];
  for (const path of paths) {
    const response = await rawRequest(s.url, { path, headers: { Authorization: `Bearer ${s.token}` } });
    assert.equal(response.status, 404, path);
    assert.equal(JSON.parse(response.body).error.code, "not_found", path);
    assert.ok(!response.body.includes("TOP SECRET"), path);
    assert.ok(!response.body.includes("escape") && !response.body.includes("symbolic"), `${path} reveals the reason`);
  }
  const error = await s.client.readFile(runId, "../outside-secret.txt").catch((e: unknown) => e);
  assert.ok(error instanceof RunwrightError);
  assert.equal(error.code, "not_found");
});

test("a symlink that stays inside the workspace is served", async (t) => {
  const s = await startTestServer(t);
  const { runId } = await withWorkspace(s);
  const file = await s.client.readFile(runId, "inside-link.txt");
  assert.equal(Buffer.from(file.body).toString("utf8"), "hello notes\n");
});

test("a FIFO in the workspace is 404 at once, without a blocking open", { skip: process.platform === "win32" }, async (t) => {
  const s = await startTestServer(t);
  const { runId, workspace } = await withWorkspace(s);
  makeFifo(join(workspace, "pipe"));
  const response = await authed(s, `/v1/runs/${runId}/files/pipe`);
  assert.equal(response.status, 404);
  assert.equal(((await response.json()) as { error: { code: string } }).error.code, "not_found");
  const after = await authed(s, `/v1/runs/${runId}/files/notes.txt`);
  assert.equal(await after.text(), "hello notes\n");
});

test("a zero-byte file is 200 with Content-Length 0 and an empty body", async (t) => {
  const s = await startTestServer(t);
  const { runId, workspace } = await withWorkspace(s);
  await writeFile(join(workspace, "empty.txt"), "");
  const response = await authed(s, `/v1/runs/${runId}/files/empty.txt`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-length"), "0");
  assert.equal(await response.text(), "");
});

test("a symlink inside the workspace is served from the file it resolves to, with that file's length", async (t) => {
  const s = await startTestServer(t);
  const { runId } = await withWorkspace(s);
  const response = await authed(s, `/v1/runs/${runId}/files/inside-link.txt`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-length"), "12");
  assert.equal(await response.text(), "hello notes\n");
});

test("a file of several chunks is served whole, byte for byte, with the right Content-Length", async (t) => {
  const s = await startTestServer(t);
  const { runId, workspace } = await withWorkspace(s);
  const bytes = Buffer.alloc(200_000);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 31 + 7) % 251;
  await writeFile(join(workspace, "large.bin"), bytes);
  const response = await authed(s, `/v1/runs/${runId}/files/large.bin`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-length"), "200000");
  assert.ok(Buffer.from(await response.arrayBuffer()).equals(bytes));
});

test("a file that shrinks while it is served ends the connection instead of leaving the client waiting", async (t) => {
  const s = await startTestServer(t);
  const { runId, workspace } = await withWorkspace(s);
  const path = join(workspace, "shrinks.bin");
  const size = 64 * 2 ** 20;
  await writeFile(path, "");
  await truncate(path, size);
  const response = await authed(s, `/v1/runs/${runId}/files/shrinks.bin`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-length"), String(size));
  const body = response.body;
  assert.ok(body !== null);
  const reader = body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  await truncate(path, 1000);
  let received = first.value?.length ?? 0;
  const drained = (async (): Promise<string> => {
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) return "ended normally";
        received += next.value.length;
      }
    } catch {
      return "connection ended";
    }
  })();
  // Without the check the server ends the body short and the client waits until the keep-alive timeout (5 s).
  let timer: NodeJS.Timeout | undefined;
  const waiting = new Promise<string>((resolve) => { timer = setTimeout(() => resolve("left waiting"), 3000); });
  const outcome = await Promise.race([drained, waiting]);
  clearTimeout(timer);
  await reader.cancel().catch(() => undefined);
  assert.equal(outcome, "connection ended");
  assert.ok(received < size);
});

// ------------------------------------------------------------------ the listing is paged, never cut (R13D-docs-04)

/** A run whose workspace holds `count` files named f0000.txt, f0001.txt, ... */
async function manyFiles(s: TestServer, count: number): Promise<{ runId: string; names: string[] }> {
  const run = await seedRun(s.store);
  const workspace = join(s.dir, "workspaces", run.id);
  await mkdir(workspace, { recursive: true });
  const names = Array.from({ length: count }, (_, i) => `f${String(i).padStart(4, "0")}.txt`);
  for (let i = 0; i < names.length; i += 200) {
    await Promise.all(names.slice(i, i + 200).map((name) => writeFile(join(workspace, name), "x")));
  }
  return { runId: run.id, names };
}

interface FilesPage { files: { path: string }[]; nextCursor: string | null }

test("a workspace of 2 001 files is listed in pages; the last file is found by following nextCursor", async (t) => {
  const s = await startTestServer(t);
  const { runId, names } = await manyFiles(s, 2001);
  const first = (await (await authed(s, `/v1/runs/${runId}/files`)).json()) as FilesPage;
  assert.equal(first.files.length, 200, "the default page is 200");
  assert.equal(first.nextCursor, Buffer.from("f0199.txt").toString("base64url"), "the cursor is the base64url of the last path");
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const query: string = cursor === null ? "?limit=1000" : `?limit=1000&cursor=${cursor}`;
    const page = (await (await authed(s, `/v1/runs/${runId}/files${query}`)).json()) as FilesPage;
    seen.push(...page.files.map((f) => f.path));
    cursor = page.nextCursor;
    pages += 1;
  } while (cursor !== null);
  assert.equal(pages, 3);
  assert.deepEqual(seen, names);
  assert.equal(seen[seen.length - 1], "f2000.txt");
});

test("the files listing refuses a cursor that does not decode and a limit out of bounds", async (t) => {
  const s = await startTestServer(t);
  const { runId } = await manyFiles(s, 3);
  for (const cursor of ["%%%", "not+base64", "abc=", "Zh", Buffer.from([0xff, 0xfe]).toString("base64url")]) {
    const error = await errorOf(await authed(s, `/v1/runs/${runId}/files?cursor=${encodeURIComponent(cursor)}`));
    assert.equal(error.status, 400, cursor);
    assert.equal(error.code, "bad_request", cursor);
  }
  for (const limit of ["0", "1001", "-1", "x"]) {
    assert.equal((await errorOf(await authed(s, `/v1/runs/${runId}/files?limit=${limit}`))).code, "bad_request", limit);
  }
  const one = (await (await authed(s, `/v1/runs/${runId}/files?limit=1`)).json()) as FilesPage;
  assert.deepEqual(one.files.map((f) => f.path), ["f0000.txt"]);
  const max = (await (await authed(s, `/v1/runs/${runId}/files?limit=1000`)).json()) as FilesPage;
  assert.deepEqual([max.files.length, max.nextCursor], [3, null]);
  const empty = await seedRun(s.store, "no-workspace");
  assert.deepEqual(await (await authed(s, `/v1/runs/${empty.id}/files?cursor=${one.nextCursor}`)).json(), { files: [], nextCursor: null });
});

/** Open file descriptors of this process (where the platform lists them). */
async function openDescriptors(): Promise<number | null> {
  for (const dir of ["/proc/self/fd", "/dev/fd"]) {
    try {
      return (await readdir(dir)).length;
    } catch {
      continue;
    }
  }
  return null;
}

test("a client that goes away in the middle of a large file leaves no file handle open", { skip: process.platform === "win32" }, async (t) => {
  const s = await startTestServer(t);
  const run = await seedRun(s.store);
  const workspace = join(s.dir, "workspaces", run.id);
  await mkdir(workspace, { recursive: true });
  const big = join(workspace, "big.txt");
  await writeFile(big, Buffer.alloc(5 * 1024 * 1024, 0x61));
  await authed(s, `/v1/runs/${run.id}/files/notes-missing.txt`).then((r) => r.text());
  const baseline = await openDescriptors();
  const port = Number(new URL(s.url).port);
  const socket = connect(port, "127.0.0.1");
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  let received = 0;
  const enough = new Promise<void>((resolve) => socket.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (received >= 64 * 1024) resolve();
  }));
  socket.write(`GET /v1/runs/${run.id}/files/big.txt HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${s.token}\r\n\r\n`);
  await enough;
  socket.destroy();
  assert.ok(received < 5 * 1024 * 1024, "the client left before the end of the file");
  if (baseline !== null) {
    await waitFor(async () => (await openDescriptors()) === baseline, { timeoutMs: 5000, message: "a file handle stayed open" });
  }
  await rm(big);
  const after = await authed(s, `/v1/runs/${run.id}/files/notes.txt`);
  assert.equal(after.status, 404, "the server keeps serving");
  await after.text();
});
