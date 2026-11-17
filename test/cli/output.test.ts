import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { dollarsToMicros, UsageError } from "../../src/cli/args.ts";
import { hostApp, type HostedApp, type SignalSource } from "../../src/cli/commands/host.ts";
import { createContext, readGlobals } from "../../src/cli/context.ts";
import { COMMANDS } from "../../src/cli/main.ts";
import { labelled, table } from "../../src/cli/output.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import type { JsonObject } from "../../src/core/json.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { cli, cliServer, finish, parsed, seed, type CliResult } from "./support.ts";
import { buildWorld, GREETING, type World } from "./world.ts";

test("output is one JSON document when stdout is not a terminal, or with --json", async (t) => {
  const s = await cliServer(t);
  const run = await seed(s.store);
  const piped = await cli(["runs", "get", run.id], { dataDir: s.dir, isTTY: false });
  assert.equal(piped.code, 0);
  const body = parsed<{ run: { id: string }; pendings: unknown[] }>(piped);
  assert.equal(body.run.id, run.id);
  assert.deepEqual(body.pendings, []);
  const forced = await cli(["runs", "list", "--json"], { dataDir: s.dir, isTTY: true });
  assert.equal(parsed<{ runs: { id: string }[] }>(forced).runs[0]?.id, run.id);
  assert.equal(forced.stderr, "");
});

test("on a terminal the output is short human text: labelled lines and aligned tables", async (t) => {
  const s = await cliServer(t);
  const run = await seed(s.store);
  await finish(s.store, run.id, "completed");
  const one = await cli(["runs", "get", run.id], { dataDir: s.dir, isTTY: true });
  assert.equal(one.code, 0);
  assert.match(one.stdout, new RegExp(`^Run: +${run.id}$`, "m"));
  assert.match(one.stdout, /^Status: +completed$/m);
  assert.match(one.stdout, /^Cost: +\$0\.0015$/m);
  assert.throws(() => JSON.parse(one.stdout));
  const list = await cli(["runs", "list"], { dataDir: s.dir, isTTY: true });
  const lines = list.stdout.trimEnd().split("\n");
  assert.match(lines[0] ?? "", /^RUN +AGENT +STATUS +COST +CREATED$/);
  assert.equal(lines[1]?.indexOf("cli-agent"), lines[0]?.indexOf("AGENT"));
});

test("an unknown cost prints unknown, never $0", async (t) => {
  const s = await cliServer(t);
  const run = await seed(s.store);
  await finish(s.store, run.id, "completed", null);
  const one = await cli(["runs", "get", run.id], { dataDir: s.dir, isTTY: true });
  assert.match(one.stdout, /^Cost: +unknown$/m);
  const list = await cli(["runs", "list"], { dataDir: s.dir, isTTY: true });
  assert.match(list.stdout, /completed +unknown/);
  assert.doesNotMatch(list.stdout, /\$0\.0000/);
  const usage = await cli(["usage", "--by", "model"], { dataDir: s.dir, isTTY: true });
  assert.match(usage.stdout, /scripted\/unpriced-1 .* unknown$/m);
});

test("errors: `error: message (code)` on stderr for people, {error: {code, message}} on stdout for programs; exit 1", async (t) => {
  const s = await cliServer(t);
  const human = await cli(["runs", "get", "run_missing"], { dataDir: s.dir, isTTY: true });
  assert.equal(human.code, 1);
  assert.equal(human.stdout, "");
  assert.match(human.stderr, /^error: .+ \(not_found\)\n$/);
  const machine = await cli(["runs", "get", "run_missing"], { dataDir: s.dir, isTTY: false });
  assert.equal(machine.code, 1);
  const body = parsed<{ error: { code: string; message: string } }>(machine);
  assert.equal(body.error.code, "not_found");
  assert.equal(typeof body.error.message, "string");
});

test("usage errors exit 2 in both modes; in JSON mode the error is also on stdout", async (t) => {
  const s = await cliServer(t);
  const human = await cli(["runs", "list", "--limit", "zero"], { dataDir: s.dir, isTTY: true });
  assert.equal(human.code, 2);
  assert.equal(human.stdout, "");
  assert.match(human.stderr, /--limit must be a whole number/);
  const machine = await cli(["runs", "list", "--nope"], { dataDir: s.dir });
  assert.equal(machine.code, 2);
  assert.equal(parsed<{ error: { code: string } }>(machine).error.code, "usage");
});

test("helpers: dollars convert to integer micro-dollars exactly; tables and labels align", () => {
  assert.equal(dollarsToMicros("0.25", "--max-cost", "x"), 250_000);
  assert.equal(dollarsToMicros("1.000001", "--max-cost", "x"), 1_000_001);
  assert.equal(dollarsToMicros("3", "--max-cost", "x"), 3_000_000);
  assert.equal(dollarsToMicros("0.1", "--max-cost", "x"), 100_000);
  assert.throws(() => dollarsToMicros("-1", "--max-cost", "x"), UsageError);
  assert.throws(() => dollarsToMicros("0.0000001", "--max-cost", "x"), UsageError);
  assert.throws(() => dollarsToMicros("1e3", "--max-cost", "x"), UsageError);
  assert.equal(table(["A", "BB"], [["xxx", "y"], ["z", "w"]]), "A    BB\nxxx  y\nz    w");
  assert.equal(labelled([["Id", "1"], ["Status", "ok"], ["Gone", undefined]]), "Id:      1\nStatus:  ok");
});

// ------------------------------------------------------------------ Rule X: one JSON document off a terminal
// (findings R09D-spec-08 and R09D-docs-06: raw file text, raw Mermaid text and raw help text off a terminal)

/** The two ways to be in JSON mode: stdout is not a terminal, or --json on a terminal. */
const JSON_MODES: readonly { name: string; isTTY: boolean; extra: readonly string[] }[] = [
  { name: "piped", isTTY: false, extra: [] },
  { name: "--json on a terminal", isTTY: true, extra: ["--json"] },
];

/** Exactly one JSON document: the whole of stdout parses, and it is not empty. */
function oneDocument(result: CliResult, what: string): JsonObject {
  assert.notEqual(result.stdout.trim(), "", `${what}: printed nothing`);
  try {
    return JSON.parse(result.stdout) as JsonObject;
  } catch (error) {
    assert.fail(`${what}: stdout is not exactly one JSON document (${(error as Error).message}):\n${result.stdout}`);
  }
}

test("runs files <run> <path> in JSON mode is {path, contentType, bytes, encoding, content}; binary is base64", async (t) => {
  const w = await buildWorld(t);
  for (const mode of JSON_MODES) {
    const text = oneDocument(await cli(["runs", "files", w.done.id, "greeting.txt", ...mode.extra], { dataDir: w.s.dir, isTTY: mode.isTTY }), mode.name);
    assert.deepEqual(text, { path: "greeting.txt", contentType: "text/plain; charset=utf-8", bytes: GREETING.length, encoding: "utf8", content: GREETING }, mode.name);
    const blob = oneDocument(await cli(["runs", "files", w.done.id, "blob.bin", ...mode.extra], { dataDir: w.s.dir, isTTY: mode.isTTY }), mode.name);
    assert.equal(blob["encoding"], "base64", mode.name);
    assert.equal(blob["bytes"], w.binary.length);
    assert.deepEqual(Buffer.from(blob["content"] as string, "base64"), w.binary, `${mode.name}: the base64 round-trips`);
  }
  const terminal = await cli(["runs", "files", w.done.id, "greeting.txt"], { dataDir: w.s.dir, isTTY: true });
  assert.equal(terminal.stdout, GREETING, "on a terminal: the text itself");
  const binary = await cli(["runs", "files", w.done.id, "blob.bin"], { dataDir: w.s.dir, isTTY: true });
  assert.equal(binary.stdout, `blob.bin: ${w.binary.length} bytes of binary data; save it with --out <file>\n`);
  const out = join(w.s.dir, "copy.bin");
  for (const mode of [...JSON_MODES, { name: "terminal", isTTY: true, extra: [] }]) {
    const saved = await cli(["runs", "files", w.done.id, "blob.bin", "--out", out, ...mode.extra], { dataDir: w.s.dir, isTTY: mode.isTTY });
    assert.equal(saved.code, 0, saved.stderr);
    assert.deepEqual(await readFile(out), w.binary, `${mode.name}: --out writes the exact bytes`);
  }
  assert.equal((await cli(["runs", "files", w.done.id, "--out", out], { dataDir: w.s.dir })).code, 2, "--out without a path");
});

test("workflows graph --mermaid in JSON mode is {mermaid}; --out writes the text in every mode", async (t) => {
  const w = await buildWorld(t);
  const terminal = await cli(["workflows", "graph", w.files.workflow, "--mermaid"], { dataDir: w.s.dir, isTTY: true });
  assert.match(terminal.stdout, /^flowchart|^graph/m);
  for (const mode of JSON_MODES) {
    const doc = oneDocument(await cli(["workflows", "graph", w.files.workflow, "--mermaid", ...mode.extra], { dataDir: w.s.dir, isTTY: mode.isTTY }), mode.name);
    assert.deepEqual(Object.keys(doc), ["mermaid"]);
    assert.equal(`${doc["mermaid"] as string}`.trimEnd(), terminal.stdout.trimEnd(), "the same text as on a terminal");
  }
  const out = join(w.s.dir, "graph.mmd");
  const saved = await cli(["workflows", "graph", "--name", w.workflowName, "--out", out], { dataDir: w.s.dir });
  const written = await readFile(out, "utf8");
  assert.equal(written.trimEnd(), terminal.stdout.trimEnd());
  assert.deepEqual(oneDocument(saved, "--out"), { out, bytes: Buffer.byteLength(written) });
  const human = await cli(["workflows", "graph", w.files.workflow, "--out", out], { dataDir: w.s.dir, isTTY: true });
  assert.equal(human.stdout, `Wrote ${Buffer.byteLength(written)} bytes to ${out}\n`);
});

test("help, --help, -h, a group's --help and a command's --help are {help} in JSON mode and the text on a terminal", async (t) => {
  const dir = await makeTempDir(t);
  for (const argv of [["help"], ["--help"], ["-h"], ["runs", "--help"], ["runs", "start", "--help"], ["help", "runs", "start"], ["runs", "start", "-h"]]) {
    const terminal = await cli(argv, { dataDir: dir, isTTY: true });
    assert.equal(terminal.code, 0, argv.join(" "));
    assert.throws(() => JSON.parse(terminal.stdout), SyntaxError, `${argv.join(" ")}: text on a terminal`);
    for (const mode of JSON_MODES) {
      const result = await cli([...argv, ...mode.extra], { dataDir: dir, isTTY: mode.isTTY });
      assert.equal(result.code, 0, `${argv.join(" ")} ${mode.name}`);
      assert.deepEqual(oneDocument(result, `${argv.join(" ")} ${mode.name}`), { help: terminal.stdout });
    }
  }
  const usage = parsed<{ help: string }>(await cli(["runs", "start", "--help"], { dataDir: dir }));
  assert.match(usage.help, /^Usage: runwright runs start <agentId> \[options\]$/m);
  const group = parsed<{ help: string }>(await cli(["runs", "--help"], { dataDir: dir }));
  assert.match(group.help, /^Usage: runwright runs <command>$/m);
});

/**
 * Arguments for every command, against `buildWorld`. Every name in COMMANDS must have a row (or be in
 * SEPARATE), so a new command cannot be added without being swept.
 */
const SWEEP: Readonly<Record<string, (w: World) => string[]>> = {
  "agents list": () => [],
  "agents get": (w) => [w.agentId, "--revision", "1"],
  "agents save": (w) => [w.files.agent, "--id", "saved-agent"],
  "agents revisions": (w) => [w.agentId],
  "agents metrics": (w) => [w.agentId],
  "runs start": (w) => [w.agentId, "--message", "hi", "--revision", "1"],
  "runs get": (w) => [w.done.id],
  "runs list": (w) => ["--agent", w.agentId, "--limit", "5"],
  "runs wait": (w) => [w.done.id],
  "runs message": (w) => [w.waiting.id, "more"],
  "runs answer": (w) => [w.waiting.id, "blue"],
  "runs approve": (w) => [w.waiting.id],
  "runs deny": (w) => [w.waiting.id, "--pending", w.approval.id, "--reason", "no"],
  "runs raise": (w) => [w.waiting.id, "--max-turns", "50"],
  "runs resolve": (w) => [w.waiting.id, "--action", "skip", "--result", "done"],
  "runs cancel": (w) => [w.done.id],
  "runs pause": (w) => [w.waiting.id],
  "runs resume": (w) => [w.waiting.id],
  "runs timeline": (w) => [w.done.id],
  "runs files": (w) => [w.done.id, "greeting.txt"],
  "runs learning": (w) => [w.done.id],
  "pendings list": () => [],
  "pendings get": (w) => [w.question.id],
  "workflows validate": (w) => [w.files.workflow],
  "workflows dry-run": (w) => [w.files.workflow, "--input", '{"path": "a.txt"}'],
  "workflows graph": (w) => [w.files.workflow, "--mermaid"],
  "workflows save": (w) => ["reader-2", w.files.workflow],
  "workflows list": () => [],
  "workflows get": (w) => [w.workflowName],
  "learning list": () => [],
  "learning show": (w) => [w.active.id],
  "learning history": (w) => [w.active.id],
  "learning retire": (w) => [w.active.id],
  "learning restore": (w) => [w.active.id],
  "learning approve": (w) => [w.held.id],
  "learning edit": (w) => [w.active.id, "--title", "Printer"],
  "triggers list": () => [],
  "triggers create": (w) => [w.files.trigger],
  "triggers get": (w) => [w.triggerId],
  "triggers update": (w) => [w.triggerId, w.files.triggerPatch],
  "triggers enable": (w) => [w.triggerId],
  "triggers disable": (w) => [w.triggerId],
  "triggers fire": (w) => [w.triggerId],
  "triggers delete": (w) => [w.triggerId],
  "secrets set": () => ["OTHER_KEY", "--value", "another-value"],
  "secrets delete": () => ["OTHER_KEY"],
  "secrets status": () => [],
  usage: () => ["--by", "model"],
  status: () => [],
  "retention archive": () => ["--older-than", "3650"],
  api: () => [],
  version: () => [],
  help: () => ["runs", "files"],
};

/** Asserted on their own below: two hosts that run until a signal, and the benchmark. */
const SEPARATE = ["serve", "runner", "bench"];

test("the sweep table names every command, and only commands", () => {
  const names = COMMANDS.map((c) => c.name);
  assert.deepEqual(names.filter((name) => !Object.hasOwn(SWEEP, name) && !SEPARATE.includes(name)), [], "commands without a sweep row");
  assert.deepEqual(Object.keys(SWEEP).filter((name) => !names.includes(name)), [], "sweep rows for commands that do not exist");
});

test("off a terminal, every command prints exactly one JSON document", async (t) => {
  const w = await buildWorld(t);
  for (const spec of COMMANDS) {
    const row = SWEEP[spec.name];
    if (row === undefined) continue;
    const argv = [...spec.name.split(" "), ...row(w)];
    const result = await cli(argv, { dataDir: w.s.dir, isTTY: false });
    const doc = oneDocument(result, argv.join(" "));
    assert.equal(typeof doc, "object", argv.join(" "));
    if (result.code !== 0) assert.ok(Object.hasOwn(doc, "error"), `${argv.join(" ")} exited ${result.code} with ${result.stdout}`);
  }
  const follow = await cli(["runs", "timeline", w.done.id, "--follow"], { dataDir: w.s.dir, isTTY: false });
  assert.equal(follow.code, 0, follow.stderr);
  const lines = follow.stdout.trimEnd().split("\n").map((line) => JSON.parse(line) as JsonObject);
  assert.ok(lines.length >= 2, "the stream: one JSON document per line");
  assert.deepEqual(lines.at(-1), { event: "end", data: { status: "completed" } });
});

test("runner prints one JSON document off a terminal", async () => {
  const out: string[] = [];
  const spec = COMMANDS.find((c) => c.name === "runner");
  assert.ok(spec !== undefined);
  const io = { stdout: (text: string) => void out.push(text), stderr: () => undefined, stdin: async () => "", env: {}, isTTY: false };
  const ctx = createContext({ io, spec, values: {}, positionals: [], globals: readGlobals({}, { RUNWRIGHT_DATA_DIR: "/data/rw" }, "runner") });
  const config = defaultConfig("/data/rw");
  const app: HostedApp = {
    config, url: "", tokenPath: "/data/rw/token", runner: { id: "rnr_1", abandon: async () => undefined },
    start: async () => undefined, stop: async () => undefined,
  };
  const signals = new EventEmitter();
  const exit = hostApp(ctx, app, "runner", signals as SignalSource);
  await new Promise((resolve) => setImmediate(resolve));
  signals.emit("SIGTERM");
  assert.equal(await exit, 0);
  assert.deepEqual(JSON.parse(out.join("")), { runnerId: "rnr_1", dataDir: "/data/rw", concurrency: config.runner.concurrency });
});

test("bench prints one JSON document off a terminal", { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const result = await cli(["bench", "--quick"], { dataDir: dir, isTTY: false });
  assert.equal(result.code, 0, result.stderr);
  const report = oneDocument(result, "bench");
  assert.equal(report["quick"], true);
  assert.equal(typeof report["results"], "object");
});

test("runs files: a file that starts with a byte order mark keeps it, so text and bytes agree in every mode", async (t) => {
  const w = await buildWorld(t);
  const { writeFile: write } = await import("node:fs/promises");
  const bom = Buffer.from([0xef, 0xbb, 0xbf, 0x41]);
  await write(join(w.s.dir, "workspaces", w.done.id, "bom.txt"), bom);
  for (const mode of JSON_MODES) {
    const doc = oneDocument(await cli(["runs", "files", w.done.id, "bom.txt", ...mode.extra], { dataDir: w.s.dir, isTTY: mode.isTTY }), mode.name);
    assert.equal(doc["encoding"], "utf8", mode.name);
    assert.equal(doc["content"], "﻿A", mode.name);
    assert.equal(doc["bytes"], 4, mode.name);
    assert.equal(Buffer.byteLength(doc["content"] as string), 4, mode.name);
  }
  const terminal = await cli(["runs", "files", w.done.id, "bom.txt"], { dataDir: w.s.dir, isTTY: true });
  assert.deepEqual(Buffer.from(terminal.stdout, "utf8"), bom, "on a terminal: the same four bytes");
  const out = join(w.s.dir, "bom-copy.txt");
  const saved = await cli(["runs", "files", w.done.id, "bom.txt", "--out", out], { dataDir: w.s.dir });
  assert.equal(saved.code, 0, saved.stderr);
  assert.deepEqual(await readFile(out), bom, "--out writes the same four bytes");
});

test("files the CLI reads must be UTF-8: bytes that are not are an error, never silently replaced", async (t) => {
  const s = await cliServer(t);
  const run = await seed(s.store);
  const { writeFile: write } = await import("node:fs/promises");
  const bad = join(s.dir, "bad.json");
  await write(bad, Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]));
  const result = await cli(["runs", "start", run.agentId, "--data", `@${bad}`], { dataDir: s.dir });
  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /is not UTF-8 text/);
});

test("(R15D-cli-02) table() and labelled() take 300 000 rows without spreading them into a call", () => {
  const count = 300_000;
  const rows = Array.from({ length: count }, (_, i) => [`run_${i}`, i === count - 1 ? "the-widest-cell" : "x", "last"]);
  const lines = table(["RUN", "STATUS", "NOTE"], rows).split("\n");
  assert.equal(lines.length, count + 1);
  assert.equal(lines[0], `${"RUN".padEnd(`run_${count - 1}`.length)}  ${"STATUS".padEnd(15)}  NOTE`);
  assert.equal(lines[1], `${"run_0".padEnd(`run_${count - 1}`.length)}  ${"x".padEnd(15)}  last`);
  assert.equal(lines[count], `run_${count - 1}  the-widest-cell  last`);

  const pairs = Array.from({ length: count }, (_, i) => [i === count - 1 ? "the longest label" : `l${i % 10}`, String(i)] as const);
  const text = labelled(pairs).split("\n");
  assert.equal(text.length, count);
  assert.equal(text[0], `${"l0:".padEnd("the longest label:".length)}  0`);
  assert.equal(text[count - 1], `the longest label:  ${count - 1}`);
});
