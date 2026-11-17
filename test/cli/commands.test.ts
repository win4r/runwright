import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { COMMANDS } from "../../src/cli/main.ts";
import type { Json } from "../../src/core/json.ts";
import type { LearningItem } from "../../src/store/types.ts";
import { promoteSkill, seedLearningItems } from "../helpers/learning.ts";
import { claim } from "../server/support.ts";
import { cli, cliServer, finish, openPendings, parsed, seed } from "./support.ts";

const definition = {
  name: "Writer", instructions: "Write things.", model: { provider: "scripted", name: "scripted-1" }, tools: [], limits: {}, learning: false,
};

function reader(tool = "read_file"): Json {
  return {
    format: "runwright.workflow/v1",
    name: "reader",
    schemas: { in: { type: "object", required: ["path"], properties: { path: { type: "string" } } }, out: { type: "string" } },
    input: "in",
    output: "out",
    root: { id: "read", kind: "tool", tool, args: { path: { $ref: "input.path" } } },
    result: { $ref: "steps.read.content" },
  };
}

test("every verb of the CLI reference exists in the command table", () => {
  const names = new Set(COMMANDS.map((c) => c.name));
  for (const name of [
    "serve", "runner", "agents list", "agents get", "agents save", "agents revisions", "runs start", "runs get", "runs list",
    "runs wait", "runs message", "runs answer", "runs approve", "runs deny", "runs raise", "runs resolve", "runs cancel",
    "runs pause", "runs resume", "runs timeline", "runs files", "pendings list", "workflows validate", "workflows dry-run",
    "workflows graph", "workflows save", "workflows list", "workflows get", "learning list", "learning show", "learning history",
    "learning retire", "learning restore", "learning approve", "triggers list", "triggers create", "triggers get",
    "triggers enable", "triggers disable", "triggers delete", "triggers fire", "secrets set", "secrets delete", "secrets status",
    "usage", "retention archive", "bench", "api", "version", "help",
  ]) assert.ok(names.has(name), `missing ${name}`);
  assert.equal(names.size, COMMANDS.length, "command names are unique");
});

test("agents save (bare definition and {id, definition}), get, list, revisions", async (t) => {
  const s = await cliServer(t);
  const bare = join(s.dir, "bare.json");
  await writeFile(bare, JSON.stringify(definition));
  const wrapped = join(s.dir, "wrapped.json");
  await writeFile(wrapped, JSON.stringify({ id: "wrapped-agent", definition: { ...definition, name: "Wrapped" } }));

  const first = await cli(["agents", "save", bare, "--id", "writer"], { dataDir: s.dir });
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual([parsed<{ agent: { id: string } }>(first).agent.id, parsed<{ created: boolean }>(first).created], ["writer", true]);
  const again = await cli(["agents", "save", bare, "--id", "writer"], { dataDir: s.dir, isTTY: true });
  assert.match(again.stdout, /Unchanged: agent writer revision 1/);
  await writeFile(bare, JSON.stringify({ ...definition, instructions: "Write better things." }));
  const changed = await cli(["agents", "save", bare, "--id", "writer"], { dataDir: s.dir });
  assert.equal(parsed<{ revision: { revision: number } }>(changed).revision.revision, 2);

  const fromFile = await cli(["agents", "save", wrapped], { dataDir: s.dir });
  assert.equal(parsed<{ agent: { id: string } }>(fromFile).agent.id, "wrapped-agent");
  const overridden = await cli(["agents", "save", wrapped, "--id", "other-id"], { dataDir: s.dir });
  assert.equal(parsed<{ agent: { id: string } }>(overridden).agent.id, "other-id");

  const get = await cli(["agents", "get", "writer"], { dataDir: s.dir, isTTY: true });
  assert.match(get.stdout, /^Revision: +2$/m);
  assert.match(get.stdout, /^Model: +scripted\/scripted-1$/m);
  const list = parsed<{ agents: { agent: { id: string } }[] }>(await cli(["agents", "list"], { dataDir: s.dir }));
  assert.deepEqual(list.agents.map((a) => a.agent.id).sort(), ["other-id", "wrapped-agent", "writer"]);
  const revisions = parsed<{ revisions: { revision: number }[] }>(await cli(["agents", "revisions", "writer"], { dataDir: s.dir }));
  assert.deepEqual(revisions.revisions.map((r) => r.revision), [2, 1]);
  const metrics = parsed<{ metrics: { agentId: string } }>(await cli(["agents", "metrics", "writer"], { dataDir: s.dir }));
  assert.equal(metrics.metrics.agentId, "writer");
  const invalid = join(s.dir, "invalid.json");
  await writeFile(invalid, "[1, 2]");
  assert.equal((await cli(["agents", "save", invalid], { dataDir: s.dir })).code, 2);
});

test("runs start (dollars → micros, --data @file, idempotency key), get, list, @last", async (t) => {
  const s = await cliServer(t);
  await seed(s.store, "cli-agent");
  const dataFile = join(s.dir, "data.json");
  await writeFile(dataFile, JSON.stringify({ ticket: "printer on fire" }));
  const argv = ["runs", "start", "cli-agent", "--message", "hello", "--data", `@${dataFile}`, "--max-cost", "0.25",
    "--max-tool-calls", "3", "--max-turns", "4", "--idempotency-key", "key-1"];
  const started = await cli(argv, { dataDir: s.dir });
  assert.equal(started.code, 0, started.stderr);
  const { run, created } = parsed<{ run: { id: string; input: { message: string; data: Json }; limits: { maxCostMicros: number; maxToolCalls: number; maxTurns: number } }; created: boolean }>(started);
  assert.equal(created, true);
  assert.deepEqual(run.input, { message: "hello", data: { ticket: "printer on fire" } });
  assert.deepEqual([run.limits.maxCostMicros, run.limits.maxToolCalls, run.limits.maxTurns], [250_000, 3, 4]);
  const repeat = parsed<{ run: { id: string }; created: boolean }>(await cli(argv, { dataDir: s.dir }));
  assert.deepEqual([repeat.run.id, repeat.created], [run.id, false]);
  const inline = await cli(["runs", "start", "cli-agent", "--data", '{"n": 1}'], { dataDir: s.dir, isTTY: true });
  assert.match(inline.stdout, /^Started run run_\S+ \(agent cli-agent\)$/m);
  assert.equal((await cli(["runs", "start", "cli-agent", "--data", "{bad"], { dataDir: s.dir })).code, 2);
  assert.equal((await cli(["runs", "start", "cli-agent", "--max-cost", "lots"], { dataDir: s.dir })).code, 2);

  const last = parsed<{ run: { id: string; input: { data: Json } } }>(await cli(["runs", "get", "@last"], { dataDir: s.dir }));
  assert.deepEqual(last.run.input.data, { n: 1 });
  const list = parsed<{ runs: { id: string }[]; nextCursor: string | null }>(await cli(["runs", "list", "--limit", "1"], { dataDir: s.dir }));
  assert.equal(list.runs.length, 1);
  assert.notEqual(list.nextCursor, null);
  const next = parsed<{ runs: { id: string }[] }>(await cli(["runs", "list", "--cursor", list.nextCursor as string, "--agent", "cli-agent", "--status", "queued"], { dataDir: s.dir }));
  assert.equal(next.runs[0]?.id, run.id);
  assert.equal((await cli(["runs", "list", "--status", "sleeping"], { dataDir: s.dir })).code, 2);

  const waited = await cli(["runs", "start", "cli-agent", "--wait", "--timeout", "0.1"], { dataDir: s.dir });
  assert.equal(waited.code, 1, "no runner: the run stays queued and the wait times out");
});

test("@last with no runs is an error", async (t) => {
  const s = await cliServer(t);
  const result = await cli(["runs", "get", "@last"], { dataDir: s.dir, isTTY: true });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /no runs yet \(not_found\)/);
});

test("runs message, raise, cancel, pause, resume queue commands", async (t) => {
  const s = await cliServer(t);
  const run = await seed(s.store);
  const message = parsed<{ command: { command: Json } }>(await cli(["runs", "message", run.id, "more detail"], { dataDir: s.dir }));
  assert.deepEqual(message.command.command, { type: "message", text: "more detail" });
  const raise = parsed<{ command: { command: { type: string; limits: Json } } }>(
    await cli(["runs", "raise", run.id, "--max-cost", "1.5", "--max-turns", "9", "--allow-unpriced"], { dataDir: s.dir }),
  );
  assert.deepEqual(raise.command.command.limits, { maxCostMicros: 1_500_000, maxTurns: 9, allowUnpriced: true });
  assert.equal((await cli(["runs", "raise", run.id], { dataDir: s.dir })).code, 2);
  for (const verb of ["pause", "resume", "cancel"]) {
    const result = await cli(["runs", verb, run.id], { dataDir: s.dir });
    assert.equal(result.code, 0, `${verb}: ${result.stdout}${result.stderr}`);
    assert.equal(parsed<{ command: { command: { type: string } } }>(result).command.command.type, verb);
  }
  const done = await seed(s.store);
  await finish(s.store, done.id, "completed");
  const terminal = await cli(["runs", "cancel", done.id], { dataDir: s.dir });
  assert.equal(terminal.code, 1);
  assert.equal(parsed<{ error: { code: string } }>(terminal).error.code, "run_terminal");
});

test("answer, approve, deny and resolve pick the only open pending of their kind, or need --pending", async (t) => {
  const s = await cliServer(t);
  const asking = await seed(s.store);
  const [question] = await openPendings(s.store, asking.id, ["question"]);
  assert.equal((await cli(["runs", "approve", asking.id], { dataDir: s.dir })).code, 2, "no approval pending");
  const answered = await cli(["runs", "answer", asking.id, "blue"], { dataDir: s.dir });
  assert.equal(answered.code, 0, answered.stderr);
  assert.deepEqual(parsed<{ command: { command: Json } }>(answered).command.command, { type: "answer", pendingId: question?.id ?? "", answer: "blue" });

  const gated = await seed(s.store);
  const [first, second] = await openPendings(s.store, gated.id, ["approval", "approval"]);
  const ambiguous = await cli(["runs", "approve", gated.id], { dataDir: s.dir, isTTY: true });
  assert.equal(ambiguous.code, 2);
  assert.match(ambiguous.stderr, /has 2 open approval pendings/);
  assert.ok(ambiguous.stderr.includes(first?.id ?? "?") && ambiguous.stderr.includes(second?.id ?? "?"));
  const approved = parsed<{ command: { command: Json } }>(await cli(["runs", "approve", gated.id, "--pending", first?.id ?? "", "--always"], { dataDir: s.dir }));
  assert.deepEqual(approved.command.command, { type: "approve", pendingId: first?.id ?? "", always: true });
  const denied = parsed<{ command: { command: Json } }>(await cli(["runs", "deny", gated.id, "--pending", second?.id ?? "", "--reason", "too risky"], { dataDir: s.dir }));
  assert.deepEqual(denied.command.command, { type: "deny", pendingId: second?.id ?? "", reason: "too risky" });

  const crashed = await seed(s.store);
  const [interrupted] = await openPendings(s.store, crashed.id, ["interrupted"]);
  assert.equal((await cli(["runs", "resolve", crashed.id], { dataDir: s.dir })).code, 2, "--action is required");
  const resolved = parsed<{ command: { command: Json } }>(await cli(["runs", "resolve", crashed.id, "--action", "skip", "--result", "already written"], { dataDir: s.dir }));
  assert.deepEqual(resolved.command.command, { type: "resolve_interrupted", pendingId: interrupted?.id ?? "", action: "skip", result: "already written" });

  const pendings = parsed<{ pendings: { id: string }[] }>(await cli(["pendings", "list", "--kind", "approval"], { dataDir: s.dir }));
  assert.deepEqual(pendings.pendings.map((p) => p.id).sort(), [first?.id, second?.id].sort());
  const human = await cli(["pendings", "list", "--run", crashed.id], { dataDir: s.dir, isTTY: true });
  assert.match(human.stdout, new RegExp(`${interrupted?.id} +interrupted +${crashed.id}`));
  assert.equal((await cli(["pendings", "list", "--kind", "nap"], { dataDir: s.dir })).code, 2);
});

test("runs timeline prints records; --follow streams until the run ends", async (t) => {
  const s = await cliServer(t);
  const run = await seed(s.store);
  const { lease } = await claim(s.store, run.id);
  await s.store.commit(lease, { records: [{ type: "run.claimed", data: { runnerId: "test-runner" } }, { type: "model.started", key: "t1", data: { model: "scripted/scripted-1" } }] });
  const plain = await cli(["runs", "timeline", run.id], { dataDir: s.dir, isTTY: true });
  assert.match(plain.stdout, /^1  run\.created  -  /m);
  assert.match(plain.stdout, /^3  model\.started  t1  /m);
  const json = parsed<{ records: { seq: number }[]; archived: boolean }>(await cli(["runs", "timeline", run.id, "--after", "1"], { dataDir: s.dir }));
  assert.deepEqual(json.records.map((r) => r.seq), [2, 3]);

  const following = cli(["runs", "timeline", run.id, "--follow"], { dataDir: s.dir });
  await new Promise((resolve) => setTimeout(resolve, 150));
  await s.store.commit(lease, { records: [{ type: "model.finished", key: "t1", data: { text: "hi" } }] });
  await s.store.commit(lease, { records: [{ type: "run.completed", data: {} }], transition: { to: "completed", output: "hi" } });
  const followed = await following;
  assert.equal(followed.code, 0, followed.stderr);
  const lines = followed.stdout.trimEnd().split("\n").map((line) => JSON.parse(line) as { seq?: number; event?: string; data?: { status?: string } });
  assert.deepEqual(lines.slice(0, -1).map((l) => l.seq), [1, 2, 3, 4, 5], "every record exactly once, in order");
  assert.deepEqual(lines[lines.length - 1], { event: "end", data: { status: "completed" } });
});

test("runs files lists, prints and saves a run's files", async (t) => {
  const s = await cliServer(t);
  const run = await seed(s.store);
  const workspace = join(s.dir, "workspaces", run.id);
  await mkdir(join(workspace, "notes"), { recursive: true });
  await writeFile(join(workspace, "notes", "out.txt"), "the answer is 42\n");
  const list = parsed<{ files: { path: string; size: number }[] }>(await cli(["runs", "files", run.id], { dataDir: s.dir }));
  assert.deepEqual(list.files.map((f) => [f.path, f.size]), [["notes/out.txt", 17]]);
  const printed = await cli(["runs", "files", run.id, "notes/out.txt"], { dataDir: s.dir });
  assert.deepEqual(parsed(printed), { path: "notes/out.txt", contentType: "text/plain; charset=utf-8", bytes: 17, encoding: "utf8", content: "the answer is 42\n" });
  const onTerminal = await cli(["runs", "files", run.id, "notes/out.txt"], { dataDir: s.dir, isTTY: true });
  assert.equal(onTerminal.stdout, "the answer is 42\n");
  const asJson = parsed<{ content: string }>(await cli(["runs", "files", run.id, "notes/out.txt", "--json"], { dataDir: s.dir, isTTY: true }));
  assert.equal(asJson.content, "the answer is 42\n");
  const out = join(s.dir, "copy.txt");
  const saved = await cli(["runs", "files", "@last", "notes/out.txt", "--out", out], { dataDir: s.dir, isTTY: true });
  assert.match(saved.stdout, /Wrote 17 bytes/);
  assert.equal(await readFile(out, "utf8"), "the answer is 42\n");
  const escape = await cli(["runs", "files", run.id, "../../token"], { dataDir: s.dir });
  assert.equal(escape.code, 1);
  const learning = parsed<{ uses: unknown[] }>(await cli(["runs", "learning", run.id], { dataDir: s.dir }));
  assert.deepEqual(learning.uses, []);
});

test("workflows validate (exit 1 with paths), dry-run, graph --mermaid, save, list, get", async (t) => {
  const s = await cliServer(t);
  const good = join(s.dir, "good.json");
  await writeFile(good, JSON.stringify(reader()));
  const bad = join(s.dir, "bad.json");
  await writeFile(bad, JSON.stringify(reader("not_a_tool")));

  const valid = await cli(["workflows", "validate", good], { dataDir: s.dir, isTTY: true });
  assert.equal(valid.code, 0);
  assert.match(valid.stdout, /Valid/);
  const invalid = await cli(["workflows", "validate", bad], { dataDir: s.dir, isTTY: true });
  assert.equal(invalid.code, 1);
  assert.match(invalid.stdout, /^error \$\.root\S* unknown_tool: /m);
  assert.equal(parsed<{ ok: boolean }>(await cli(["workflows", "validate", bad], { dataDir: s.dir })).ok, false);

  const dry = await cli(["workflows", "dry-run", good, "--input", '{"path": "a.txt"}'], { dataDir: s.dir, isTTY: true });
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /^ {2}tool {2}read_file {2}\(read\)$/m);
  const dryJson = parsed<{ report: { ok: boolean; wouldCall: { name: string }[] } }>(await cli(["workflows", "dry-run", good, "--input", '{"path": "a.txt"}'], { dataDir: s.dir }));
  assert.deepEqual(dryJson.report.wouldCall.map((c) => c.name), ["read_file"]);
  const dryBad = await cli(["workflows", "dry-run", bad], { dataDir: s.dir, isTTY: true });
  assert.equal(dryBad.code, 1);
  assert.match(dryBad.stderr, /\(workflow_invalid\)\n {2}error \$/);

  const mermaid = await cli(["workflows", "graph", good, "--mermaid"], { dataDir: s.dir });
  assert.match(parsed<{ mermaid: string }>(mermaid).mermaid, /read/);
  const mermaidText = await cli(["workflows", "graph", good, "--mermaid"], { dataDir: s.dir, isTTY: true });
  assert.match(mermaidText.stdout, /read/);
  assert.throws(() => JSON.parse(mermaidText.stdout));
  const graph = await cli(["workflows", "graph", good], { dataDir: s.dir, isTTY: true });
  assert.match(graph.stdout, /^Nodes:\nNODE +KIND +LABEL\nread +tool/m);

  const saved = parsed<{ workflow: { name: string; version: number }; created: boolean }>(await cli(["workflows", "save", "reader", good], { dataDir: s.dir }));
  assert.deepEqual([saved.workflow.name, saved.workflow.version, saved.created], ["reader", 1, true]);
  assert.equal((await cli(["workflows", "save", "reader", bad], { dataDir: s.dir })).code, 1);
  const list = parsed<{ workflows: { name: string }[] }>(await cli(["workflows", "list"], { dataDir: s.dir }));
  assert.deepEqual(list.workflows.map((w) => w.name), ["reader"]);
  const get = await cli(["workflows", "get", "reader", "--version", "1"], { dataDir: s.dir, isTTY: true });
  assert.match(get.stdout, /^Workflow: +reader$/m);
  assert.match(get.stdout, /"format": "runwright.workflow\/v1"/);
});

test("learning list, show, history, retire, restore and approve (reading the ETag first)", async (t) => {
  const s = await cliServer(t);
  await seed(s.store);
  const [active, held] = await seedLearningItems(s.store, "cli-agent", [
    { kind: "note", name: "printer", title: "The printer", description: "It is on floor 2.", body: "Floor 2, by the window.", status: "active" },
    { kind: "skill", name: "reboot", title: "Reboot", description: "How to reboot it.", body: "Hold the button.", status: "held" },
  ]) as [LearningItem, LearningItem];
  const list = parsed<{ items: { id: string }[] }>(await cli(["learning", "list", "--agent", "cli-agent", "--status", "active"], { dataDir: s.dir }));
  assert.deepEqual(list.items.map((i) => i.id), [active.id]);
  assert.equal((await cli(["learning", "list", "--status", "lost"], { dataDir: s.dir })).code, 2);
  const show = await cli(["learning", "show", active.id], { dataDir: s.dir, isTTY: true });
  assert.match(show.stdout, /^Title: +The printer$/m);
  assert.match(show.stdout, /Floor 2, by the window\.$/m);

  const retired = parsed<{ item: { status: string; version: number } }>(await cli(["learning", "retire", active.id], { dataDir: s.dir }));
  assert.equal(retired.item.status, "retired");
  const stale = await cli(["learning", "restore", active.id, "--etag", active.etag], { dataDir: s.dir });
  assert.equal(stale.code, 1);
  assert.equal(parsed<{ error: { code: string } }>(stale).error.code, "etag_mismatch");
  const restored = parsed<{ item: { status: string } }>(await cli(["learning", "restore", active.id], { dataDir: s.dir }));
  assert.equal(restored.item.status, "active");
  const approved = parsed<{ item: { status: string } }>(await cli(["learning", "approve", held.id], { dataDir: s.dir }));
  assert.equal(approved.item.status, "active");
  const edited = parsed<{ item: { title: string } }>(await cli(["learning", "edit", active.id, "--title", "Printer"], { dataDir: s.dir }));
  assert.equal(edited.item.title, "Printer");

  const history = parsed<{ history: { action: string }[] }>(await cli(["learning", "history", active.id], { dataDir: s.dir }));
  assert.deepEqual(history.history.map((h) => h.action), ["created", "retired", "restored", "edited"]);
});

test("learning show names a promoted skill's workflow with its version", async (t) => {
  const s = await cliServer(t);
  await seed(s.store);
  const [skill] = await seedLearningItems(s.store, "cli-agent", [
    { kind: "skill", name: "report", title: "Report", description: "How to write the report.", body: "Collect, then write.", status: "active" },
  ]) as [LearningItem];
  const plain = await cli(["learning", "show", skill.id], { dataDir: s.dir, isTTY: true });
  assert.doesNotMatch(plain.stdout, /^Workflow:/m);
  const workflow = {
    format: "runwright.workflow/v1", name: "skill-report-x", schemas: { In: {}, Out: {} }, input: "In", output: "Out",
    root: { id: "stop", kind: "fail", message: "x" }, result: null,
  } as never;
  await promoteSkill(s.store, skill, "skill-report-x", workflow);
  const show = await cli(["learning", "show", skill.id], { dataDir: s.dir, isTTY: true });
  assert.match(show.stdout, /^Workflow: +skill-report-x v1$/m);
});

test("triggers create, list, get, disable, enable, fire, delete", async (t) => {
  const s = await cliServer(t);
  await seed(s.store);
  const file = join(s.dir, "trigger.json");
  await writeFile(file, JSON.stringify({
    name: "Nightly", kind: "cron", agentId: "cli-agent", cron: { expression: "0 3 * * *", timeZone: "UTC" }, message: "tidy up",
    limits: { maxCostMicros: 50_000 },
  }));
  const created = parsed<{ trigger: { id: string; enabled: boolean } }>(await cli(["triggers", "create", file], { dataDir: s.dir }));
  const id = created.trigger.id;
  assert.equal(created.trigger.enabled, true);
  const list = await cli(["triggers", "list"], { dataDir: s.dir, isTTY: true });
  assert.match(list.stdout, new RegExp(`${id} +Nightly +cron +cli-agent +yes`));
  const get = await cli(["triggers", "get", id], { dataDir: s.dir, isTTY: true });
  assert.match(get.stdout, /^Schedule: +0 3 \* \* \* \(UTC\)$/m);
  assert.match(get.stdout, /^Cap: +\$0\.0500$/m);
  assert.equal(parsed<{ trigger: { enabled: boolean } }>(await cli(["triggers", "disable", id], { dataDir: s.dir })).trigger.enabled, false);
  const refused = await cli(["triggers", "fire", id], { dataDir: s.dir });
  assert.equal(refused.code, 1);
  assert.equal(parsed<{ error: { code: string } }>(refused).error.code, "trigger_disabled");
  assert.equal(parsed<{ trigger: { enabled: boolean } }>(await cli(["triggers", "enable", id], { dataDir: s.dir })).trigger.enabled, true);
  const fired = parsed<{ run: { input: { data: Json }; limits: { maxCostMicros: number } } }>(await cli(["triggers", "fire", id, "--data", '{"why": "now"}'], { dataDir: s.dir }));
  assert.equal(fired.run.limits.maxCostMicros, 50_000);
  assert.deepEqual(parsed<{ deleted: string }>(await cli(["triggers", "delete", id], { dataDir: s.dir })), { deleted: id });
  assert.equal((await cli(["triggers", "get", id], { dataDir: s.dir })).code, 1);
});

test("secrets set reads stdin and never echoes the value; status and delete", async (t) => {
  const s = await cliServer(t);
  const value = "sk-very-secret-value-123";
  const set = await cli(["secrets", "set", "MODEL_KEY"], { dataDir: s.dir, isTTY: true, stdin: `${value}\n` });
  assert.equal(set.code, 0, set.stderr);
  assert.equal(set.stdout, "Secret MODEL_KEY is set\n");
  assert.ok(!set.stdout.includes(value) && !set.stderr.includes(value));
  assert.deepEqual(await s.secrets.reveal(["MODEL_KEY"]), { MODEL_KEY: value }, "one trailing newline is removed");
  const flagged = await cli(["secrets", "set", "OTHER_KEY", "--value", "another-value"], { dataDir: s.dir });
  assert.ok(!flagged.stdout.includes("another-value"));
  const one = parsed<{ secret: { name: string; set: boolean } }>(await cli(["secrets", "status", "MODEL_KEY"], { dataDir: s.dir }));
  assert.deepEqual([one.secret.name, one.secret.set], ["MODEL_KEY", true]);
  const all = await cli(["secrets", "status"], { dataDir: s.dir, isTTY: true });
  assert.match(all.stdout, /^MODEL_KEY +yes/m);
  assert.match(all.stdout, /^OTHER_KEY +yes/m);
  assert.ok(!all.stdout.includes(value));
  assert.deepEqual(parsed(await cli(["secrets", "delete", "OTHER_KEY"], { dataDir: s.dir })), { deleted: "OTHER_KEY" });
  const gone = await cli(["secrets", "status", "OTHER_KEY"], { dataDir: s.dir, isTTY: true });
  assert.equal(gone.stdout, "OTHER_KEY: missing\n");
});

test("usage, api, version and help", async (t) => {
  const s = await cliServer(t);
  const run = await seed(s.store);
  await finish(s.store, run.id, "completed");
  const usage = parsed<{ groupBy: string; rows: { key: string; costMicros: number }[] }>(await cli(["usage", "--by", "agent"], { dataDir: s.dir }));
  assert.equal(usage.groupBy, "agent");
  assert.deepEqual(usage.rows.map((r) => [r.key, r.costMicros]), [["cli-agent", 1500]]);
  assert.equal((await cli(["usage", "--by", "week"], { dataDir: s.dir })).code, 2);

  const api = parsed<{ name: string; operations: { path: string }[] }>(await cli(["api"], { dataDir: s.dir }));
  assert.equal(api.name, "runwright");
  assert.ok(api.operations.some((o) => o.path === "/v1/runs"));

  const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  assert.deepEqual(parsed(await cli(["version"], { dataDir: s.dir })), { name: "runwright", version: pkg.version });
  assert.equal((await cli(["version"], { dataDir: s.dir, isTTY: true })).stdout, `runwright ${pkg.version}\n`);

  const help = await cli(["help"], { dataDir: s.dir, isTTY: true });
  assert.equal(help.code, 0);
  for (const spec of COMMANDS) assert.ok(help.stdout.includes(spec.name), `help lists ${spec.name}`);
  assert.deepEqual(parsed(await cli(["--help"], { dataDir: s.dir })), { help: help.stdout });
  const one = parsed<{ help: string }>(await cli(["help", "runs", "wait"], { dataDir: s.dir }));
  assert.match(one.help, /^Usage: runwright runs wait <run> \[options\]$/m);
  assert.match(one.help, /--timeout <sec>/);
  assert.equal((await cli(["runs", "start", "--help"], { dataDir: s.dir })).code, 0);
  const group = await cli(["triggers", "--help"], { dataDir: s.dir });
  assert.equal(group.code, 0);
  assert.match(group.stdout, /triggers fire <id>/);
  assert.equal((await cli(["help", "nothing"], { dataDir: s.dir })).code, 2);
});

// ------------------------------------------------------------------ arguments mean what the user typed
// (findings R09D-cli-03: help and JSON read from raw tokens; R09D-cli-02: --pending not checked against the run)

test("a token after -- or the value of an option is never read as --help, -h or --json", async (t) => {
  const s = await cliServer(t);
  const run = await seed(s.store);
  const [question] = await openPendings(s.store, run.id, ["question"]);
  const messaged = await cli(["runs", "message", run.id, "--", "--help"], { dataDir: s.dir });
  assert.equal(messaged.code, 0, messaged.stderr);
  assert.deepEqual(parsed<{ command: { command: Json } }>(messaged).command.command, { type: "message", text: "--help" });
  const answered = await cli(["runs", "answer", run.id, "--", "-h"], { dataDir: s.dir });
  assert.equal(answered.code, 0, answered.stderr);
  assert.deepEqual(parsed<{ command: { command: Json } }>(answered).command.command, { type: "answer", pendingId: question?.id ?? "", answer: "-h" });
  const human = await cli(["runs", "message", run.id, "--", "--json"], { dataDir: s.dir, isTTY: true });
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, new RegExp(`^Sent the message to run ${run.id} \\(command cmd_\\S+\\)\\n$`), "still human output on a terminal");
  const texts = (await s.store.listCommands(run.id)).map((c) => (c.command as { text?: string }).text).filter((x) => x !== undefined);
  assert.deepEqual(texts, ["--help", "--json"]);

  const gated = await seed(s.store);
  await openPendings(s.store, gated.id, ["approval"]);
  const denied = await cli(["runs", "deny", gated.id, "--reason=--help"], { dataDir: s.dir });
  assert.equal(denied.code, 0, denied.stderr);
  assert.equal((parsed<{ command: { command: { reason: string } } }>(denied)).command.command.reason, "--help");
  const ambiguous = await cli(["runs", "deny", gated.id, "--reason", "--help"], { dataDir: s.dir, isTTY: true });
  assert.equal(ambiguous.code, 2, "a flag-like value must be written --reason=--help");
  assert.equal(ambiguous.stdout, "");
  assert.equal((await s.store.listCommands(gated.id)).length, 1, "only the first deny was sent");

  for (const argv of [["runs", "start", "--help"], ["runs", "--help"], ["--help"], ["-h"], ["help", "runs", "start"]]) {
    const result = await cli(argv, { dataDir: s.dir, isTTY: true });
    assert.equal(result.code, 0, argv.join(" "));
    assert.match(result.stdout, /^(Usage: runwright|Runwright: )/, argv.join(" "));
  }
  const unknown = await cli(["runs", "list", "--bogus"], { dataDir: s.dir, isTTY: true });
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /Unknown option '--bogus'/);
  const late = await cli(["runs", "list", "--bogus", "--", "--json"], { dataDir: s.dir, isTTY: true });
  assert.equal(late.code, 2);
  assert.equal(late.stdout, "", "a --json after -- does not switch a usage error to JSON");
  const early = await cli(["runs", "list", "--bogus", "--json"], { dataDir: s.dir, isTTY: true });
  assert.equal(parsed<{ error: { code: string } }>(early).error.code, "usage");
});

test("answer, approve, deny and resolve refuse a --pending of another run and send nothing to either run", async (t) => {
  const s = await cliServer(t);
  const a = await seed(s.store);
  const b = await seed(s.store);
  const [aQuestion, aApproval, aInterrupted] = await openPendings(s.store, a.id, ["question", "approval", "interrupted"]);
  const [bQuestion, bApproval, bInterrupted] = await openPendings(s.store, b.id, ["question", "approval", "interrupted"]);
  const verbs: [string[], string][] = [
    [["runs", "answer", a.id, "blue", "--pending", bQuestion?.id ?? ""], bQuestion?.id ?? ""],
    [["runs", "approve", a.id, "--pending", bApproval?.id ?? ""], bApproval?.id ?? ""],
    [["runs", "deny", a.id, "--pending", bApproval?.id ?? ""], bApproval?.id ?? ""],
    [["runs", "resolve", a.id, "--action", "cancel", "--pending", bInterrupted?.id ?? ""], bInterrupted?.id ?? ""],
  ];
  for (const [argv, pendingId] of verbs) {
    const result = await cli(argv, { dataDir: s.dir, isTTY: true });
    assert.equal(result.code, 2, argv.join(" "));
    assert.match(result.stderr, new RegExp(`pending ${pendingId} belongs to run ${b.id}, not ${a.id}`));
    assert.deepEqual(await s.store.listCommands(a.id), [], `${argv[1]}: nothing reached run A`);
    assert.deepEqual(await s.store.listCommands(b.id), [], `${argv[1]}: nothing reached run B`);
  }
  const wrongKind = await cli(["runs", "approve", a.id, "--pending", aQuestion?.id ?? ""], { dataDir: s.dir, isTTY: true });
  assert.equal(wrongKind.code, 2);
  assert.match(wrongKind.stderr, new RegExp(`pending ${aQuestion?.id} is a question, not a approval`));
  const resolveWrongKind = await cli(["runs", "resolve", a.id, "--action", "retry", "--pending", aApproval?.id ?? ""], { dataDir: s.dir, isTTY: true });
  assert.match(resolveWrongKind.stderr, /is a approval, not a interrupted/);
  assert.deepEqual(await s.store.listCommands(a.id), []);

  const viaLast = await seed(s.store);
  const [lastQuestion] = await openPendings(s.store, viaLast.id, ["question"]);
  const answered = await cli(["runs", "answer", "@last", "green", "--pending", lastQuestion?.id ?? ""], { dataDir: s.dir });
  assert.equal(answered.code, 0, answered.stderr);
  assert.equal(parsed<{ command: { runId: string } }>(answered).command.runId, viaLast.id);
  const { lease } = await claim(s.store, viaLast.id);
  const commands = await s.store.listCommands(viaLast.id);
  await s.store.commit(lease, {
    records: [{ type: "pending.resolved", data: {} }], resolvePendings: [{ id: lastQuestion?.id ?? "", resolution: { answer: "green" } }],
    consumeCommands: commands.map((c) => c.id), transition: { to: "running" },
  } as never);
  const resolved = await cli(["runs", "answer", viaLast.id, "again", "--pending", lastQuestion?.id ?? ""], { dataDir: s.dir, isTTY: true });
  assert.equal(resolved.code, 2, resolved.stderr);
  assert.match(resolved.stderr, new RegExp(`pending ${lastQuestion?.id} is already resolved`));

  const unknownRun = await cli(["runs", "approve", "run_missing", "--pending", aApproval?.id ?? ""], { dataDir: s.dir });
  assert.equal(unknownRun.code, 1);
  assert.equal(parsed<{ error: { code: string } }>(unknownRun).error.code, "not_found");
  const unknownPending = await cli(["runs", "approve", a.id, "--pending", "pnd_missing"], { dataDir: s.dir });
  assert.equal(unknownPending.code, 1);
  assert.equal(parsed<{ error: { code: string } }>(unknownPending).error.code, "not_found");
  const own = await cli(["runs", "resolve", a.id, "--action", "retry", "--pending", aInterrupted?.id ?? ""], { dataDir: s.dir });
  assert.equal(own.code, 0, own.stderr);
});

test("numeric flags have bounds that fit what they feed, and flags that would be ignored are refused", async (t) => {
  const s = await cliServer(t);
  const run = await seed(s.store);
  await finish(s.store, run.id, "completed");
  const refused: string[][] = [
    ["runs", "wait", run.id, "--timeout", "2147484"],
    ["runs", "start", "cli-agent", "--wait", "--timeout", "99999999"],
    ["runs", "start", "cli-agent", "--timeout", "5"],
    ["runs", "start", "cli-agent", "--revision", "0"],
    ["runs", "list", "--limit", "201"],
    ["runs", "list", "--limit", "0"],
    ["runs", "list", "--connect-timeout", "3000000"],
    ["runs", "timeline", run.id, "--after", "99999999999999999"],
    ["runs", "resolve", run.id, "--action", "retry", "--result", "x"],
    ["pendings", "list", "--limit", "0"],
    ["workflows", "get", "reader", "--version", "0"],
    ["serve", "--concurrency", "2000"],
    ["serve", "--port", "65536"],
    ["serve", "--lease-ms", "2147483648"],
    ["retention", "archive", "--older-than", "999999999999"],
    ["retention", "archive", "--older-than", "1", "--limit", "0"],
    ["usage", "--from", "2026-02-30"],
    ["usage", "--from", "yesterday"],
    ["usage", "--from", "2026-03-02", "--to", "2026-03-01"],
  ];
  for (const argv of refused) {
    const result = await cli(argv, { dataDir: s.dir, isTTY: true });
    assert.equal(result.code, 2, `${argv.join(" ")}: ${result.stderr}`);
  }
  for (const argv of [["serve", "--token", "x"], ["--url", "http://127.0.0.1:1"], ["runner", "--connect-timeout", "1"], ["version", "--url", "x"],
    ["retention", "archive", "--older-than", "1", "--token", "x"], ["bench", "--url", "x"], ["help", "--token", "x"]]) {
    const result = await cli(argv, { dataDir: s.dir, isTTY: true });
    assert.equal(result.code, 2, argv.join(" "));
    assert.match(result.stderr, /has no effect on \S+(?: archive)?: it does not talk to a server/, argv.join(" "));
  }
  assert.equal((await s.store.listRuns({}, { limit: 10 })).items.length, 1, "no refused runs start was sent");
  const longest = await cli(["runs", "wait", run.id, "--timeout", "2147483"], { dataDir: s.dir });
  assert.equal(longest.code, 0, "the longest timeout one timer holds is accepted");
});

// ------------------------------------------------------------------ pendings list prints one page and the cursor hint
// (finding R15D-cli-03; it replaces the earlier "every page" contract of R09D-cli-01)

test("(R15D-cli-03) pendings list prints one page and the cursor hint; --cursor continues without a gap or a repeat; filters apply", async (t) => {
  const s = await cliServer(t);
  const one = await seed(s.store, "cli-agent");
  const two = await seed(s.store, "other-agent");
  await openPendings(s.store, one.id, Array.from({ length: 215 }, () => "question" as const));
  await openPendings(s.store, two.id, Array.from({ length: 15 }, () => "approval" as const));
  const everything: string[] = [];
  for (let cursor: string | null | undefined; cursor !== null;) {
    const page = await s.store.listPendings({ status: "open" }, { limit: 200, ...(cursor === undefined ? {} : { cursor }) });
    for (const pending of page.items) everything.push(pending.id);
    cursor = page.nextCursor;
  }
  assert.equal(everything.length, 230);

  const first = parsed<{ pendings: { id: string }[]; nextCursor: string | null }>(await cli(["pendings", "list"], { dataDir: s.dir }));
  assert.deepEqual(first.pendings.map((p) => p.id), everything.slice(0, 50), "one page of the API's default size, oldest first");
  assert.equal(typeof first.nextCursor, "string");
  const human = await cli(["pendings", "list"], { dataDir: s.dir, isTTY: true });
  const lines = human.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 52, "a header, 50 rows and the hint");
  assert.equal(lines[51], `More: --cursor ${first.nextCursor}`);

  const walked: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const argv: string[] = ["pendings", "list", "--limit", "60", ...(cursor === null ? [] : ["--cursor", cursor])];
    const page: { pendings: { id: string }[]; nextCursor: string | null } = parsed(await cli(argv, { dataDir: s.dir }));
    assert.ok(page.pendings.length <= 60);
    for (const pending of page.pendings) walked.push(pending.id);
    cursor = page.nextCursor;
    pages += 1;
  } while (cursor !== null);
  assert.equal(pages, 4);
  assert.deepEqual(walked, everything, "the pages put together are every pending, without a gap or a repeat");
  const last = await cli(["pendings", "list", "--limit", "200", "--cursor", first.nextCursor as string], { dataDir: s.dir, isTTY: true });
  assert.equal(last.stdout.trimEnd().split("\n").length, 181, "the last page: a header and 180 rows, and no hint");
  assert.doesNotMatch(last.stdout, /More:/);
  assert.equal((await cli(["pendings", "list", "--limit", "201"], { dataDir: s.dir })).code, 2, "a page holds at most 200");

  const questions = parsed<{ pendings: { kind: string }[]; nextCursor: string | null }>(await cli(["pendings", "list", "--kind", "question", "--limit", "200"], { dataDir: s.dir }));
  assert.equal(questions.pendings.length, 200);
  assert.ok(questions.pendings.every((p) => p.kind === "question"));
  const ofRun = parsed<{ pendings: { runId: string }[] }>(await cli(["pendings", "list", "--run", one.id], { dataDir: s.dir }));
  assert.equal(ofRun.pendings.length, 50);
  assert.ok(ofRun.pendings.every((p) => p.runId === one.id));
  const ofAgent = parsed<{ pendings: { agentId: string }[]; nextCursor: string | null }>(await cli(["pendings", "list", "--agent", "other-agent"], { dataDir: s.dir }));
  assert.equal(ofAgent.pendings.length, 15);
  assert.equal(ofAgent.nextCursor, null);
  assert.ok(ofAgent.pendings.every((p) => p.agentId === "other-agent"));
});

// ------------------------------------------------------------------ every API operation has a command
// (findings R09D-spec-06, R09D-docs-03)

test("triggers update, runs start --revision, agents get --revision, pendings get, runs list --trigger", async (t) => {
  const s = await cliServer(t);
  await seed(s.store);
  const current = (await s.store.getRevision("cli-agent", undefined))?.definition;
  assert.ok(current !== undefined);
  await s.store.saveAgent({ id: "cli-agent", definition: { ...current, instructions: "Version two." } });
  const triggerFile = join(s.dir, "trigger.json");
  await writeFile(triggerFile, JSON.stringify({
    name: "Nightly", kind: "cron", agentId: "cli-agent", cron: { expression: "0 3 * * *", timeZone: "UTC" }, message: "tidy up", limits: { maxCostMicros: 50_000 },
  }));
  const id = parsed<{ trigger: { id: string } }>(await cli(["triggers", "create", triggerFile], { dataDir: s.dir })).trigger.id;
  const patch = join(s.dir, "patch.json");
  await writeFile(patch, JSON.stringify({ name: "Weekly", cron: { expression: "0 3 * * 1", timeZone: "UTC" }, enabled: false }));
  const updated = parsed<{ trigger: { name: string; enabled: boolean; cron: { expression: string } } }>(await cli(["triggers", "update", id, patch], { dataDir: s.dir }));
  assert.deepEqual([updated.trigger.name, updated.trigger.enabled, updated.trigger.cron.expression], ["Weekly", false, "0 3 * * 1"]);
  const human = await cli(["triggers", "update", id, patch], { dataDir: s.dir, isTTY: true });
  assert.match(human.stdout, /^Updated trigger \S+\nTrigger: /);
  await writeFile(patch, "[1]");
  assert.equal((await cli(["triggers", "update", id, patch], { dataDir: s.dir })).code, 2);
  await writeFile(patch, JSON.stringify({ limits: { maxCostMicros: -1 } }));
  assert.equal((await cli(["triggers", "update", id, patch], { dataDir: s.dir })).code, 1, "the API validates the patch");

  const pinned = parsed<{ run: { id: string; revision: number } }>(await cli(["runs", "start", "cli-agent", "--revision", "1"], { dataDir: s.dir }));
  assert.equal(pinned.run.revision, 1);
  assert.equal(parsed<{ run: { revision: number } }>(await cli(["runs", "start", "cli-agent"], { dataDir: s.dir })).run.revision, 2);
  const missing = await cli(["runs", "start", "cli-agent", "--revision", "9"], { dataDir: s.dir });
  assert.equal(missing.code, 1);
  assert.equal(parsed<{ error: { code: string } }>(missing).error.code, "not_found");

  const old = parsed<{ agent: { id: string; currentRevision: number }; revision: { revision: number; definition: { instructions: string } } }>(
    await cli(["agents", "get", "cli-agent", "--revision", "1"], { dataDir: s.dir }),
  );
  assert.deepEqual([old.agent.currentRevision, old.revision.revision, old.revision.definition.instructions], [2, 1, "Do the job."]);
  const oldHuman = await cli(["agents", "get", "cli-agent", "--revision", "1"], { dataDir: s.dir, isTTY: true });
  assert.match(oldHuman.stdout, /^Revision: +1 \(current: 2\)$/m);
  assert.equal((await cli(["agents", "get", "cli-agent", "--revision", "7"], { dataDir: s.dir })).code, 1);

  const [question] = await openPendings(s.store, pinned.run.id, ["question"]);
  const pending = parsed<{ pending: { id: string; runId: string } }>(await cli(["pendings", "get", question?.id ?? ""], { dataDir: s.dir }));
  assert.deepEqual([pending.pending.id, pending.pending.runId], [question?.id, pinned.run.id]);
  const pendingHuman = await cli(["pendings", "get", question?.id ?? ""], { dataDir: s.dir, isTTY: true });
  assert.match(pendingHuman.stdout, new RegExp(`^Pending: +${question?.id}$`, "m"));
  assert.equal((await cli(["pendings", "get", "pnd_missing"], { dataDir: s.dir })).code, 1);

  await cli(["triggers", "enable", id], { dataDir: s.dir });
  const fired = parsed<{ run: { id: string } }>(await cli(["triggers", "fire", id], { dataDir: s.dir }));
  const byTrigger = parsed<{ runs: { id: string }[] }>(await cli(["runs", "list", "--trigger", id], { dataDir: s.dir }));
  assert.deepEqual(byTrigger.runs.map((r) => r.id), [fired.run.id]);
});

test("workflows graph takes a file or --name (exactly one); usage takes --from and --to", async (t) => {
  const s = await cliServer(t);
  const file = join(s.dir, "reader.json");
  await writeFile(file, JSON.stringify(reader()));
  await cli(["workflows", "save", "reader", file], { dataDir: s.dir });
  const fromFile = parsed<{ graph: Json; mermaid: string }>(await cli(["workflows", "graph", file], { dataDir: s.dir }));
  const saved = parsed<{ graph: Json; mermaid: string }>(await cli(["workflows", "graph", "--name", "reader"], { dataDir: s.dir }));
  assert.deepEqual(saved, fromFile);
  assert.deepEqual(parsed(await cli(["workflows", "graph", "--name", "reader", "--mermaid"], { dataDir: s.dir })), { mermaid: saved.mermaid });
  assert.equal((await cli(["workflows", "graph", file, "--name", "reader"], { dataDir: s.dir })).code, 2);
  assert.equal((await cli(["workflows", "graph"], { dataDir: s.dir })).code, 2);
  assert.equal((await cli(["workflows", "graph", "--name", "nothing"], { dataDir: s.dir })).code, 1);

  const run = await seed(s.store);
  await finish(s.store, run.id, "completed");
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const within = parsed<{ rows: { key: string }[] }>(await cli(["usage", "--from", today, "--to", tomorrow], { dataDir: s.dir }));
  assert.deepEqual(within.rows.map((r) => r.key), [today]);
  const before = parsed<{ rows: unknown[] }>(await cli(["usage", "--to", today], { dataDir: s.dir }));
  assert.deepEqual(before.rows, [], "--to is exclusive: the start of today");
  const after = parsed<{ rows: unknown[] }>(await cli(["usage", "--from", String(Date.now() + 86_400_000)], { dataDir: s.dir }));
  assert.deepEqual(after.rows, [], "--from takes epoch milliseconds too");
});

test("status prints health and readiness: exit 0 when ready, 1 when the server answers but is not ready", async (t) => {
  const s = await cliServer(t);
  const ready = await cli(["status"], { dataDir: s.dir });
  assert.equal(ready.code, 0, ready.stderr);
  const body = parsed<{ health: { status: string; version: string }; ready: { status: string } }>(ready);
  assert.deepEqual([body.health.status, body.health.version, body.ready.status], ["ok", "0.1.0-test", "ready"]);
  const human = await cli(["status"], { dataDir: s.dir, isTTY: true });
  assert.match(human.stdout, /^Ready: +yes$/m);

  const notReady = createHttpServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/health") {
      res.end(JSON.stringify({ status: "ok", version: "0.1.0-test" }));
      return;
    }
    res.statusCode = 503;
    res.end(JSON.stringify({ error: { code: "unavailable", message: "the store is not available" } }));
  });
  await new Promise<void>((resolve) => notReady.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => notReady.close(() => resolve())));
  const url = `http://127.0.0.1:${(notReady.address() as AddressInfo).port}`;
  const down = await cli(["status", "--url", url, "--token", "t"], { dataDir: s.dir });
  assert.equal(down.code, 1);
  const downBody = parsed<{ health: { status: string }; ready: { status: string; message: string } }>(down);
  assert.deepEqual([downBody.health.status, downBody.ready.status, downBody.ready.message], ["ok", "unavailable", "the store is not available"]);
  const downHuman = await cli(["status", "--url", url, "--token", "t"], { dataDir: s.dir, isTTY: true });
  assert.equal(downHuman.code, 1);
  assert.match(downHuman.stdout, /^Ready: +no: the store is not available$/m);
});
