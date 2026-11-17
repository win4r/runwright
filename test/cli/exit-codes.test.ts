import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTempDir } from "../helpers/tmp.ts";
import { bin, cli, cliServer, finish, openPendings, parsed, seed } from "./support.ts";

function assertNoSqliteWarning(stderr: string): void {
  assert.doesNotMatch(stderr, /SQLite|ExperimentalWarning/);
}

test("runs wait exits 0 for a completed run (real child process)", async (t) => {
  const s = await cliServer(t);
  const run = await seed(s.store);
  await finish(s.store, run.id, "completed");
  const result = await bin(["runs", "wait", run.id], { dataDir: s.dir });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parsed<{ run: { id: string; status: string } }>(result).run.status, "completed");
  assertNoSqliteWarning(result.stderr);
});

test("runs wait exits 1 for a failed run and for a cancelled run (real child process)", async (t) => {
  const s = await cliServer(t);
  const failed = await seed(s.store);
  await finish(s.store, failed.id, "failed");
  const cancelled = await seed(s.store);
  await finish(s.store, cancelled.id, "cancelled");
  const one = await bin(["runs", "wait", failed.id], { dataDir: s.dir });
  assert.equal(one.code, 1);
  assert.equal(parsed<{ run: { status: string } }>(one).run.status, "failed");
  assertNoSqliteWarning(one.stderr);
  const two = await bin(["runs", "wait", cancelled.id], { dataDir: s.dir });
  assert.equal(two.code, 1);
  assert.equal(parsed<{ run: { status: string } }>(two).run.status, "cancelled");
});

test("runs wait exits 8 for a run waiting on a question and lists the pending (real child process)", async (t) => {
  const s = await cliServer(t);
  const run = await seed(s.store);
  const [question] = await openPendings(s.store, run.id, ["question"]);
  const child = await bin(["runs", "wait", run.id], { dataDir: s.dir });
  assert.equal(child.code, 8, child.stderr);
  const body = parsed<{ run: { status: string }; pendings: { id: string; kind: string }[] }>(child);
  assert.equal(body.run.status, "waiting");
  assert.deepEqual(body.pendings.map((p) => [p.id, p.kind]), [[question?.id, "question"]]);
  assertNoSqliteWarning(child.stderr);

  const human = await cli(["runs", "wait", run.id], { dataDir: s.dir, isTTY: true });
  assert.equal(human.code, 8);
  assert.match(human.stdout, new RegExp(`question  ${question?.id}  ${question?.title}`));
  assert.match(human.stdout, /Cost: \$0\.0000/);
});

test("runs wait exits 8 for a paused run", async (t) => {
  const s = await cliServer(t);
  const run = await seed(s.store);
  await finish(s.store, run.id, "paused");
  const child = await bin(["runs", "wait", "@last"], { dataDir: s.dir });
  assert.equal(child.code, 8);
  assert.equal(parsed<{ run: { status: string } }>(child).run.status, "paused");
});

test("a usage error exits 2 with the usage on stderr (real child process)", async (t) => {
  const dir = await makeTempDir(t);
  const unknownFlag = await bin(["runs", "wait", "r1", "--bogus"], { dataDir: dir });
  assert.equal(unknownFlag.code, 2);
  assert.match(unknownFlag.stderr, /Usage: runwright runs wait <run>/);
  assertNoSqliteWarning(unknownFlag.stderr);
  const missing = await cli(["runs", "wait"], { dataDir: dir });
  assert.equal(missing.code, 2);
  const unknownCommand = await cli(["fly"], { dataDir: dir });
  assert.equal(unknownCommand.code, 2);
  assert.match(unknownCommand.stderr, /unknown command "fly"/);
});

test("no server exits 1 with a clear message (real child process)", async (t) => {
  const dir = await makeTempDir(t);
  const result = await bin(["runs", "list", "--connect-timeout", "0.2"], { dataDir: dir, env: { RUNWRIGHT_URL: "" } });
  assert.equal(result.code, 1);
  const body = parsed<{ error: { code: string; message: string } }>(result);
  assert.equal(body.error.code, "unavailable");
  assert.equal(body.error.message, `no Runwright server found for ${dir}; start one with: runwright serve`);
  assertNoSqliteWarning(result.stderr);
});

test("runs wait gives up after --timeout with exit 1", async (t) => {
  const s = await cliServer(t);
  const run = await seed(s.store);
  const result = await cli(["runs", "wait", run.id, "--timeout", "0.2"], { dataDir: s.dir, isTTY: true });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /still queued.*\(unavailable\)/);
});
