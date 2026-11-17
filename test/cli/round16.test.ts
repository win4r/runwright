/**
 * Round 16 regressions of the CLI. R15D-cli-03: `runs timeline` prints each page of the journal before it asks for
 * the next one, in every mode, and then follows the stream after the last printed record (`pendings list` paging
 * is in commands.test.ts). The order of requests and writes is recorded by a wrapping `fetch` and by the CLI's own
 * stdout, both appending to one log, against a real server on port 0. R15D-server-02: the `--embedded` flag of
 * the three `workflows` commands that check a document.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { main } from "../../src/cli/main.ts";
import type { JournalRecord, RunRecord } from "../../src/store/types.ts";
import { claim, type TestServer } from "../server/support.ts";
import { cli, cliServer, parsed, seed } from "./support.ts";

/** Journal records the test adds after `run.created`: with the CLI's page of 1000, the journal has three pages. */
const ADDED = 2500;

interface Logged { code: number; stdout: string; stderr: string; log: string[] }

/**
 * Runs `main` in-process with a stdout that appends `write:<text>` to the log, while a wrapping `fetch` appends
 * `request:<path and query>` (and the Last-Event-ID of a stream). `fail` (given the log entry of a request) answers it with a 500 instead.
 */
async function logged(t: TestContext, s: TestServer, argv: string[], options: { isTTY: boolean; fail?: (path: string) => boolean }): Promise<Logged> {
  const log: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const headers = new Headers(init?.headers);
    const lastId = headers.get("last-event-id");
    const path = `${url.pathname}${url.search}`;
    log.push(`request:${path}${lastId === null ? "" : ` last-event-id=${lastId}`}`);
    if (options.fail?.(`request:${path}`) === true) {
      return new Response(JSON.stringify({ error: { code: "internal", message: "the page broke" } }), { status: 500, headers: { "content-type": "application/json" } });
    }
    return original(input, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let stdout = "";
  let stderr = "";
  try {
    const code = await main(argv, {
      stdout: (text) => {
        stdout += text;
        log.push(`write:${text}`);
      },
      stderr: (text) => {
        stderr += text;
      },
      stdin: async () => "",
      env: { HOME: s.dir, RUNWRIGHT_DATA_DIR: s.dir },
      isTTY: options.isTTY,
    });
    return { code, stdout, stderr, log };
  } finally {
    globalThis.fetch = original;
  }
}

/** A completed run whose journal holds `run.created`, ADDED records and `run.completed`. */
async function longRun(s: TestServer): Promise<{ run: RunRecord; journal: JournalRecord[] }> {
  const run = await seed(s.store);
  const { lease } = await claim(s.store, run.id);
  await s.store.commit(lease, {
    records: Array.from({ length: ADDED }, (_, i) => ({ type: "model.started", key: `t${i}`, data: { model: "scripted/scripted-1" } })),
  });
  await s.store.commit(lease, { records: [{ type: "run.completed", data: {} }], transition: { to: "completed", output: "done" } });
  const journal = await s.store.readJournal(run.id, { afterSeq: 0, limit: ADDED + 10 });
  assert.equal(journal.length, ADDED + 2);
  return { run, journal };
}

/** Index of the first log entry matching `match`; fails when there is none. */
function at(log: readonly string[], what: string, match: (entry: string) => boolean): number {
  const index = log.findIndex(match);
  assert.ok(index >= 0, `the log has ${what}:\n${log.map((entry) => entry.slice(0, 120)).join("\n")}`);
  return index;
}

const pageRequest = (runId: string, after: number) => (entry: string): boolean =>
  entry.startsWith(`request:/v1/runs/${runId}/timeline?`) && new URLSearchParams(entry.slice(entry.indexOf("?") + 1)).get("after") === String(after);

test("(R15D-cli-03) runs timeline on a terminal prints page 1 before it requests page 2, and every record once", { timeout: 60_000 }, async (t) => {
  const s = await cliServer(t);
  const { run, journal } = await longRun(s);
  const result = await logged(t, s, ["runs", "timeline", run.id], { isTTY: true });
  assert.equal(result.code, 0, result.stderr);
  const page1Written = at(result.log, "the last record of page 1 written", (e) => e.startsWith("write:") && /^1000  model\.started /m.test(e.slice(6)));
  const page2Requested = at(result.log, "the request of page 2", pageRequest(run.id, 1000));
  const page3Requested = at(result.log, "the request of page 3", pageRequest(run.id, 2000));
  assert.ok(page1Written < page2Requested, "page 1 was printed before page 2 was requested");
  const page2Written = at(result.log, "the last record of page 2 written", (e) => e.startsWith("write:") && /^2000  model\.started /m.test(e.slice(6)));
  assert.ok(page2Written < page3Requested, "page 2 was printed before page 3 was requested");
  const lines = result.stdout.trimEnd().split("\n");
  assert.deepEqual(lines.map((line) => Number(line.split("  ")[0])), journal.map((r) => r.seq));
});

test("(R15D-cli-03) runs timeline --json is still one document {records, archived}, written page by page", { timeout: 60_000 }, async (t) => {
  const s = await cliServer(t);
  const { run, journal } = await longRun(s);
  const result = await logged(t, s, ["runs", "timeline", run.id, "--json"], { isTTY: true });
  assert.equal(result.code, 0, result.stderr);
  const page1Written = at(result.log, "record 1000 written", (e) => e.startsWith("write:") && e.includes('"seq":1000,'));
  assert.ok(page1Written < at(result.log, "the request of page 2", pageRequest(run.id, 1000)), "page 1 was printed before page 2 was requested");
  const document = JSON.parse(result.stdout) as { records: JournalRecord[]; archived: boolean };
  assert.deepEqual(document, { records: journal, archived: false }, "the same document as the API's pages put together");

  const after = parsed<{ records: JournalRecord[]; archived: boolean }>(await cli(["runs", "timeline", run.id, "--after", "2400"], { dataDir: s.dir }));
  assert.deepEqual(after, { records: journal.slice(2400), archived: false });
  const none = parsed<{ records: JournalRecord[]; archived: boolean }>(await cli(["runs", "timeline", run.id, "--after", "999999"], { dataDir: s.dir }));
  assert.deepEqual(none, { records: [], archived: false });
  const human = await cli(["runs", "timeline", run.id, "--after", "999999"], { dataDir: s.dir, isTTY: true });
  assert.equal(human.stdout, "No records.\n");
});

test("(R15D-cli-03) a page that fails after the document started closes it with the error and exits 1", { timeout: 60_000 }, async (t) => {
  const s = await cliServer(t);
  const { run, journal } = await longRun(s);
  const result = await logged(t, s, ["runs", "timeline", run.id], { isTTY: false, fail: pageRequest(run.id, 1000) });
  assert.equal(result.code, 1);
  const document = JSON.parse(result.stdout) as { records: JournalRecord[]; archived: boolean; error: { code: string; message: string } };
  assert.deepEqual(document, { records: journal.slice(0, 1000), archived: false, error: { code: "internal", message: "the page broke" } });

  const human = await logged(t, s, ["runs", "timeline", run.id], { isTTY: true, fail: pageRequest(run.id, 1000) });
  assert.equal(human.code, 1);
  assert.equal(human.stdout.trimEnd().split("\n").length, 1000, "the printed page stays printed");
  assert.match(human.stderr, /^error: the page broke \(internal\)$/m);

  const first = await logged(t, s, ["runs", "timeline", run.id], { isTTY: false, fail: pageRequest(run.id, 0) });
  assert.equal(first.code, 1);
  assert.deepEqual(JSON.parse(first.stdout), { error: { code: "internal", message: "the page broke" } }, "nothing was printed yet: the usual error document");
});

test("(R15D-cli-03) runs timeline --follow prints page by page, then opens the stream after the last printed record", { timeout: 60_000 }, async (t) => {
  const s = await cliServer(t);
  const { run, journal } = await longRun(s);
  const result = await logged(t, s, ["runs", "timeline", run.id, "--follow"], { isTTY: false });
  assert.equal(result.code, 0, result.stderr);
  const page1Written = at(result.log, "record 1000 written", (e) => e.startsWith("write:") && e.includes('"seq":1000,'));
  assert.ok(page1Written < at(result.log, "the request of page 2", pageRequest(run.id, 1000)), "page 1 was printed before page 2 was requested");
  const lastSeq = journal[journal.length - 1]?.seq as number;
  const stream = at(result.log, "the event stream", (e) => e.startsWith(`request:/v1/runs/${run.id}/events`));
  assert.ok(result.log[stream]?.endsWith(` last-event-id=${lastSeq}`), `the stream starts after the last printed record: ${result.log[stream]}`);
  const lastWrite = at(result.log, "the last record written", (e) => e.startsWith("write:") && e.includes(`"seq":${lastSeq},`));
  assert.ok(lastWrite < stream, "the stream is opened after the backlog was printed");
  const lines = result.stdout.trimEnd().split("\n").map((line) => JSON.parse(line) as { seq?: number; event?: string });
  assert.deepEqual(lines.slice(0, -1).map((line) => line.seq), journal.map((r) => r.seq), "every record exactly once, in order");
  assert.deepEqual(lines[lines.length - 1], { event: "end", data: { status: "completed" } });

  const failing = await logged(t, s, ["runs", "timeline", run.id, "--follow"], { isTTY: false, fail: pageRequest(run.id, 2000) });
  assert.equal(failing.code, 1);
  const failedLines = failing.stdout.trimEnd().split("\n").map((line) => JSON.parse(line) as { seq?: number; error?: { code: string } });
  assert.equal(failedLines.length, 2001, "2000 records and one error line");
  assert.deepEqual(failedLines[2000], { error: { code: "internal", message: "the page broke" } });
});

test("(R15D-server-02) workflows validate, dry-run and graph --embedded check a document as an agent's embedded workflow", { timeout: 60_000 }, async (t) => {
  const s = await cliServer(t);
  const leaf = {
    format: "runwright.workflow/v1", name: "helper",
    schemas: { in: { type: "object", required: ["path"], properties: { path: { type: "string" } } }, out: { type: "string" } },
    input: "in", output: "out",
    root: { id: "read", kind: "tool", tool: "read_file", args: { path: { $ref: "input.path" } } },
    result: { $ref: "steps.read.content" },
  };
  await s.client.saveWorkflow("helper", leaf);
  const embedded = { ...leaf, root: { id: "sub", kind: "call", workflow: "helper", input: { path: { $ref: "input.path" } } }, result: { $ref: "steps.sub" } };
  const file = join(s.dir, "embedded.json");
  await writeFile(file, JSON.stringify(embedded));

  const graph = await cli(["workflows", "graph", file, "--embedded"], { dataDir: s.dir });
  assert.equal(graph.code, 0, graph.stdout);
  assert.ok(parsed<{ graph: { nodes: { id: string }[] } }>(graph).graph.nodes.some((n) => n.id === "sub"));
  const mermaid = await cli(["workflows", "graph", file, "--embedded", "--mermaid"], { dataDir: s.dir, isTTY: true });
  assert.match(mermaid.stdout, /^flowchart/);
  const asSaved = await cli(["workflows", "graph", file], { dataDir: s.dir });
  assert.equal(asSaved.code, 1);
  assert.equal(parsed<{ error: { code: string } }>(asSaved).error.code, "workflow_invalid", "without --embedded the document calls itself");
  assert.equal((await cli(["workflows", "graph", "--name", "helper", "--embedded"], { dataDir: s.dir })).code, 2, "--embedded is for a document file");

  const validate = await cli(["workflows", "validate", file, "--embedded"], { dataDir: s.dir });
  assert.equal(validate.code, 0, validate.stdout);
  assert.deepEqual(parsed(validate), { ok: true, problems: [] });
  assert.equal((await cli(["workflows", "validate", file], { dataDir: s.dir })).code, 1);
  const dry = await cli(["workflows", "dry-run", file, "--embedded", "--input", '{"path": "a.txt"}'], { dataDir: s.dir });
  assert.equal(dry.code, 0, dry.stdout);
  assert.equal(parsed<{ report: { ok: boolean } }>(dry).report.ok, true);
  assert.equal((await cli(["workflows", "dry-run", file, "--input", '{"path": "a.txt"}'], { dataDir: s.dir })).code, 1);
});
