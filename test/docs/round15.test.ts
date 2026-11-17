/**
 * The contract sentences of round 15 in README.md and docs/, each with one executable assertion against the code
 * that backs it: rule R and sentence D1, the deadline wake-up sentence D2, the signed delivery id and sentence D3
 * (the docs/api.md example sent exactly as written), retired secret values, rule S2 and its two worked examples,
 * the cost of choosing, the self-reference rule and tool arguments as a map.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { JsonObject } from "../../src/core/json.ts";
import { settleAll } from "../../src/engine/control.ts";
import { newRecord } from "../../src/engine/journal-types.ts";
import type { Driver } from "../../src/engine/types.ts";
import { selectItems, SECTION_HEADING } from "../../src/learning/select.ts";
import { textTokens } from "../../src/models/util.ts";
import { generateSealKey } from "../../src/security/seal.ts";
import { createSecretsService } from "../../src/security/secrets.ts";
import type { LearningItem, NewJournalRecord } from "../../src/store/types.ts";
import { createFileTools } from "../../src/tools/fs.ts";
import { nextFire, parseCron } from "../../src/triggers/cron.ts";
import { validateWorkflow } from "../../src/workflow/validate.ts";
import { startTestApp } from "../fixtures/app.ts";
import { scriptedAgent } from "../fixtures/runs.ts";
import { createHarness, fakeModels, reply, type Harness } from "../helpers/engine.ts";
import { openTestStore, testAgentDefinition } from "../helpers/store.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { fileToolContext } from "../helpers/tool-context.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function doc(name: string): Promise<string> {
  return readFile(join(ROOT, name), "utf8");
}

/** Markdown wraps lines and quotes blocks; compare with every run of whitespace as one space and no `>` prefix. */
function flat(text: string): string {
  return text.replace(/^> ?/gm, "").replace(/\s+/g, " ");
}

const D1 = "An unfinished call of a tool declared `idempotent` is run again by itself only when no write call of the run "
  + "finished after it started; otherwise repeating it could undo that finished work, so it waits for a person as an "
  + "interrupted call.";
const D2 = "(within one poll interval, `runner.pollMs`, of the instant when a runner has a free slot; a runner whose slots "
  + "are all busy does not look for work, so the wake-up then waits until a slot is free)";
const D3 = "The delivery id is the `delivery` member of the signed JSON body, so it is covered by the signature: a captured "
  + "request replayed with another `X-Runwright-Delivery` header is rejected, and replayed unchanged it is the same "
  + "delivery and starts no second run.";

// ---- D1: rule R ----

interface Step { key: string; tool: string; args: JsonObject }
const del: Step = { key: "del", tool: "delete_file", args: { path: "x.txt" } };
const put: Step = { key: "put", tool: "write_file", args: { path: "x.txt", content: "new" } };

const started = (s: Step): NewJournalRecord =>
  newRecord("tool.started", { callId: s.key, tool: s.tool, args: s.args, effect: "write", attempt: 1 }, s.key);
const finishedOk = (s: Step): NewJournalRecord => newRecord("tool.finished", {
  callId: s.key, tool: s.tool, outcome: "ok", content: "done", data: null, isError: false,
  untrusted: false, truncated: false, fullResultPath: null, durationMs: 1,
}, s.key);

function parallelDriver(steps: readonly Step[]): Driver {
  return async (ctx) => {
    await settleAll(steps.map((s) => ctx.tool(s.key, { name: s.tool, args: s.args })));
    return { done: true };
  };
}

/** A run of `steps` whose runner died after committing `records`; the workspace holds `files`. */
async function crashed(t: TestContext, steps: readonly Step[], records: NewJournalRecord[], files: Record<string, string>) {
  const h: Harness = await createHarness(t, {
    models: fakeModels(() => reply({})), tools: createFileTools({ maxReadBytes: 65_536, maxWriteBytes: 65_536 }),
    drivers: { agent: parallelDriver(steps) }, autoStart: false,
  });
  const agent = await h.saveAgent({ tools: steps.map((s) => ({ name: s.tool })) });
  const run = await h.start(agent.id);
  const [claimed] = await h.store.claimRuns({ runnerId: "runner_dead", limit: 1, leaseMs: 50 });
  assert.equal(claimed?.run.id, run.id);
  await h.store.commit((claimed as NonNullable<typeof claimed>).lease, {
    records: [newRecord("run.claimed", { runnerId: "runner_dead" }), ...records],
    counters: { toolCalls: records.filter((r) => r.type === "tool.started").length },
  });
  const workspace = join(h.dir, "workspaces", run.id);
  await mkdir(workspace, { recursive: true });
  for (const [name, content] of Object.entries(files)) await writeFile(join(workspace, name), content);
  h.runner.start();
  return { h, runId: run.id, workspace };
}

test("D1 (R14-01): an idempotent write with a later finished write is interrupted; without one it is run again", async (t) => {
  for (const name of ["README.md", "docs/architecture.md", "docs/workflows.md", "docs/security.md", "docs/cli.md"]) {
    assert.ok(flat(await doc(name)).includes(D1), `${name} states D1`);
  }

  const held = await crashed(t, [del, put], [started(del), started(put), finishedOk(put)], { "x.txt": "new" });
  const waiting = await held.h.until(held.runId, ["waiting", "completed", "failed"]);
  assert.equal(waiting.status, "waiting");
  assert.deepEqual((await held.h.pendings(held.runId)).map((p) => [p.kind, p.stepKey]), [["interrupted", "del"]]);
  assert.equal(await readFile(join(held.workspace, "x.txt"), "utf8"), "new", "the finished write was not undone");

  const retried = await crashed(t, [put], [started(put)], {});
  const done = await retried.h.until(retried.runId, ["waiting", "completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.deepEqual(await retried.h.pendings(retried.runId), []);
  assert.equal(await readFile(join(retried.workspace, "x.txt"), "utf8"), "new", "the write was run again by itself");
});

// ---- D2 ----

test("D2 (R14D-docs-02): the three documents that bound a deadline wake-up state D2 and none keeps the old words", async () => {
  for (const name of ["docs/workflows.md", "docs/api.md", "docs/architecture.md"]) {
    assert.ok(flat(await doc(name)).includes(D2), `${name} states D2`);
  }
  for (const name of ["README.md", "docs/workflows.md", "docs/api.md", "docs/architecture.md", "docs/configuration.md", "docs/cli.md", "docs/security.md", "docs/learning.md"]) {
    assert.doesNotMatch(flat(await doc(name)), /at most one poll interval|is at most `runner\.pollMs` late/, name);
  }
});

// ---- D3 ----

/** The `openssl` example of docs/api.md: its variables, its header lines and its URL. */
function signingExample(api: string): { secret: string; body: string; headers: string[]; url: string } {
  const start = api.indexOf("Signing a delivery with `openssl`:");
  assert.ok(start >= 0);
  const block = /```sh\n([\s\S]*?)```/.exec(api.slice(start))?.[1] ?? "";
  const variable = (name: string): string => {
    const match = new RegExp(`^${name}='([^']*)'$`, "m").exec(block);
    assert.ok(match !== null, `${name} is set in the example`);
    return match[1] as string;
  };
  assert.match(block, /^SIG=\$\(printf '%s\.%s' "\$TS" "\$BODY" \| openssl dgst -sha256 -hmac "\$SECRET" \| sed 's\/\^\.\*= \/\/'\)$/m,
    "the signature is the hex HMAC-SHA256 of \"$TS.$BODY\"");
  assert.match(block, /--data "\$BODY"$/m, "the body is sent as written");
  const headers = [...block.matchAll(/-H (?:'([^']*)'|"([^"]*)")/g)].map((m) => (m[1] ?? m[2]) as string);
  const url = /curl -sS -X POST "([^"]+)"/.exec(block)?.[1] ?? "";
  return { secret: variable("SECRET"), body: variable("BODY"), headers, url };
}

test("D3 (R14D-server-01): the webhook example of docs/api.md, signed and sent as written, starts one run; a replay with another header is refused", { timeout: 30_000 }, async (t) => {
  for (const name of ["docs/reference.md", "docs/api.md", "docs/security.md", "docs/configuration.md"]) {
    assert.ok(flat(await doc(name)).includes(D3), `${name} states D3`);
  }
  const api = await doc("docs/api.md");
  const example = signingExample(api);
  assert.deepEqual(example.headers.map((h) => h.slice(0, h.indexOf(":"))), ["Content-Type", "X-Runwright-Timestamp", "X-Runwright-Signature"]);

  const { app, client } = await startTestApp(t);
  await client.setSecret("HOOK_SECRET", example.secret);
  const { agent } = await client.saveAgent(scriptedAgent({ name: "Hook target", script: { turns: [{ text: "handled" }] } }), "hook-target");
  const trigger = await client.createTrigger({
    name: "builds", kind: "webhook", agentId: agent.id, webhook: { secretName: "HOOK_SECRET" }, message: "a build event",
    limits: { maxCostMicros: 50_000 },
  });
  const send = async (extra: Record<string, string> = {}): Promise<Response> => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac("sha256", example.secret).update(`${ts}.${example.body}`).digest("hex");
    const headers: Record<string, string> = {};
    for (const line of example.headers) {
      const colon = line.indexOf(":");
      headers[line.slice(0, colon)] = line.slice(colon + 1).trim().replace("$TS", ts).replace("$SIG", sig);
    }
    const url = example.url.replace("http://127.0.0.1:7411", app.url).replace("$TRIGGER", trigger.id);
    return fetch(url, { method: "POST", headers: { ...headers, ...extra }, body: example.body });
  };

  const first = await send();
  assert.equal(first.status, 202);
  const fired = (await first.json()) as { runId: string; duplicate: boolean };
  assert.equal(fired.duplicate, false);
  const documented = /The run this starts has `data` `([^`]+)`/.exec(flat(api))?.[1];
  assert.ok(documented !== undefined);
  assert.deepEqual((await client.getRun(fired.runId)).run.input.data, JSON.parse(documented));

  for (const delivery of ["build-43-failed", "another-id", "x"]) {
    const replay = await send({ "X-Runwright-Delivery": delivery });
    assert.equal(replay.status, 400, delivery);
    const error = (await replay.json()) as { error: { code: string; message: string } };
    assert.equal(error.error.code, "bad_request");
    assert.equal(error.error.message, "X-Runwright-Delivery does not match the \"delivery\" of the signed body");
  }
  assert.deepEqual(await (await send()).json(), { runId: fired.runId, duplicate: true }, "replayed unchanged it is the same delivery");
  assert.deepEqual(await (await send({ "X-Runwright-Delivery": "build-42-failed" })).json(), { runId: fired.runId, duplicate: true });
  assert.equal((await client.listRuns({ triggerId: trigger.id })).runs.length, 1, "no second run");

  const described = (await client.describeApi()).operations.find((op) => op.id === "hooks.receive");
  assert.ok(described !== undefined);
  assert.equal(described.auth, "signature");
  assert.match(described.summary, /the body is a JSON object whose "delivery" string is the delivery id; X-Runwright-Delivery is optional and must match it/);
});

// ---- Retired secret values ----

test("(R14D-spec-01) the retired-secret sentence: a rotation and a restart still redact the old value while an older run is unfinished", async (t) => {
  assert.ok(flat(await doc("docs/reference.md")).includes(
    "A replaced or deleted secret value is kept sealed as a retired value for as long as a run that started before the change is "
    + "unfinished, and is loaded again at start-up, so text containing the old value stays redacted (`[redacted]`) across a "
    + "rotation and a restart; once every such run has finished the retired value is deleted",
  ));
  const { store } = await openTestStore(t);
  const sealKey = generateSealKey();
  await store.saveAgent({ id: "a", definition: testAgentDefinition() });
  const before = await createSecretsService({ store, sealKey });
  await before.set("K", "old-secret-value-0001");
  await store.createRun({ agentId: "a", input: { message: "go", data: null } });
  await before.set("K", "new-secret-value-0002");
  const restarted = await createSecretsService({ store, sealKey });
  assert.equal(restarted.redactText("old-secret-value-0001 and new-secret-value-0002"), "[redacted] and [redacted]");
  assert.equal((await store.listRetiredSecrets("K")).length, 1, "the old value is kept while the older run is unfinished");
});

// ---- Rule S2 ----

function note(id: string, title: string, body: string): LearningItem {
  return {
    id, agentId: "a", kind: "note", name: id, title, description: `About ${title.toLowerCase()}.`, body, status: "active", version: 2,
    etag: "2-00000000", sourceRunId: null, promotedWorkflow: null, promotedWorkflowVersion: null, promotionAttempts: 0, createdAt: 1, updatedAt: 1,
  };
}

test("S2 (R14D-spec-03): the two worked examples of docs/learning.md produce exactly the documented selection", async () => {
  const learning = flat(await doc("docs/learning.md"));
  assert.match(learning, /\*\*rule S2\*\*/);
  assert.match(flat(await doc("docs/reference.md")), /\(rule S2\): when they do not all fit whole but one line for every item fits, every item is given, at least as its line/);

  // Case (a): alpha and beta, 173 / 160 whole, 10 / 9 as lines, heading 51, budget 226.
  assert.match(learning, /Two notes, `alpha` \(first in rank\) and `beta`, cost 173 and 160 tokens whole and 10 and 9 as lines; the heading costs 51 and the budget is 226/);
  assert.match(learning, /so `beta` is given whole/);
  const alpha = note("alpha", "Alpha", "useful alpha ".repeat(50));
  const beta = note("beta", "Beta", "useful beta ".repeat(50));
  const costs = new Map<string, number>();
  const result = selectItems([alpha, beta], "alpha", 226, {
    estimate: (text) => {
      const tokens = textTokens(text);
      costs.set(text, tokens);
      return tokens;
    },
  });
  const cost = (prefix: string): number[] => [...costs].filter(([text]) => text.startsWith(prefix)).map(([, n]) => n);
  assert.deepEqual(cost("## [note] alpha"), [173]);
  assert.deepEqual(cost("## [note] beta"), [160]);
  assert.deepEqual(cost("- [note] alpha"), [10]);
  assert.deepEqual(cost("- [note] beta"), [9]);
  assert.equal(Math.max(...cost(SECTION_HEADING)), 51);
  assert.deepEqual(result.given.map((g) => [g.itemId, g.mode]), [["beta", "full"], ["alpha", "line"]]);
  assert.deepEqual(result.tools, ["recall"], "recall opens alpha");

  // Case (b): the 101 notes of the example; the lines alone exceed the budget of 300.
  assert.match(learning, /With 101 notes whose lines alone take more than the budget of 300/);
  assert.match(learning, /`kiln-firing` comes first and is given whole \(51 \+ 38 = 89\); the next notes are given whole while they still fit \(`n0`, `n1`, `n10` and `n11`: 279\); `n12` no longer fits whole but its line does \(294\); no further item fits, so the other 95 notes are left out/);
  const topics = ["deploy", "staging", "invoice", "number", "database", "role", "release", "tag", "build", "cache", "token", "report",
    "weekly", "tests", "port", "migrate", "schema", "api", "gateway", "queue"];
  const notes = Array.from({ length: 100 }, (_, i) => {
    const topic = topics[i % topics.length] as string;
    return note(`n${i}`, `About ${topic} ${i}`, `${topic} notes number ${i}: ${"plain words of filler text ".repeat(4)}`);
  });
  const relevant = note("kiln-firing", "Kiln firing schedule", "Fire the kiln at 1240 degrees for six hours, then let it cool overnight.");
  const set = [...notes, relevant];
  const line = (item: LearningItem): number => textTokens(`- [note] ${item.name} — ${item.title}: ${item.description}\n`);
  assert.equal(set.reduce((sum, item) => sum + line(item), 0), 1459, "their lines take 1 459 tokens");
  assert.equal(textTokens(`## [note] kiln-firing — Kiln firing schedule\nAbout kiln firing schedule.\n\n${relevant.body}\n\n`), 38);
  const chosen = selectItems(set, "what is the kiln firing schedule", 300);
  assert.deepEqual(chosen.given.map((g) => [g.itemId, g.mode]),
    [["kiln-firing", "full"], ["n0", "full"], ["n1", "full"], ["n10", "full"], ["n11", "full"], ["n12", "line"]]);
  assert.ok(textTokens(chosen.promptSection) <= 300);
});

test("(R14D-docs-03) the cost sentence says O(N log N), and choosing makes at most 2 × N + 2 token estimates", async () => {
  const learning = flat(await doc("docs/learning.md"));
  assert.match(learning, /Choosing costs `O\(N log N\)` in the number of active items/);
  assert.match(learning, /at most `2 × N \+ 2` token estimates/);
  assert.doesNotMatch(learning, /selection is linear|costs linear/i);
  const set = Array.from({ length: 40 }, (_, i) => note(`n${i}`, `Topic ${i}`, `words ${i} `.repeat(30)));
  for (const budget of [0, 100, 400, 2000, 100_000]) {
    let calls = 0;
    selectItems(set, "words 7", budget, { estimate: (text) => { calls += 1; return textTokens(text); } });
    assert.ok(calls <= 2 * set.length + 2, `budget ${budget}: ${calls} estimates`);
  }
});

// ---- Workflow documents ----

const workflow = (root: unknown): unknown => ({
  format: "runwright.workflow/v1", name: "probe", input: "In", output: "Out",
  schemas: { In: { type: "object" }, Out: { type: "object" } }, root, result: {},
});

test("(R14D-docs-01) the visibility section's self-reference example is rejected by the validator", async () => {
  const workflows = flat(await doc("docs/workflows.md"));
  assert.match(workflows, /X is the referencing node itself: `a node cannot reference its own output` \(for example a `wait` node `w` whose `question` uses `\{\{steps\.w\.answer\}\}`/);
  assert.doesNotMatch(workflows, /when X is the node itself/);
  const result = validateWorkflow(workflow({ id: "w", kind: "wait", question: "Is {{steps.w.answer}} right?" }));
  assert.equal(result.ok, false);
  const problem = result.problems.find((p) => p.code === "unknown_reference");
  assert.ok(problem !== undefined, JSON.stringify(result.problems));
  assert.match(problem.message, /a node cannot reference its own output/);
});

test("(R14D-workflow-01) args given as a reference or a literal form is rejected with shape at the args path", async () => {
  const message = "`args` must be an object of argument expressions, not a reference or a literal form";
  assert.ok(flat(await doc("docs/workflows.md")).includes(message));
  for (const args of [{ $ref: "input" }, { $ref: "steps.missing" }, { $literal: { path: "x.txt" } }]) {
    const result = validateWorkflow(workflow({ id: "t", kind: "tool", tool: "read_file", args }));
    const shapes = result.problems.filter((p) => p.code === "shape");
    assert.deepEqual(shapes.map((p) => [p.path, p.message]), [["$.root.args", message]], JSON.stringify(args));
  }
  assert.deepEqual(validateWorkflow(workflow({ id: "t", kind: "tool", tool: "read_file", args: { path: { $ref: "input.path", default: "x" } } })).problems
    .filter((p) => p.code === "shape"), []);
});

// ---- Sentences for the tools package's fixes (it owned no docs) ----

test("(R14D-tools-02) configuration.md: the cron search covers a whole calendar cycle and a null next fire means never", async () => {
  const text = flat(await doc("docs/configuration.md"));
  assert.match(text, /`0 0 \*\/30 2 1`, February 1st when it is a Monday, fires in 2027 and next in 2038\); a trigger whose `nextFireAt` is `null` never fires \(`0 0 31 2 \*`, `0 0 30 2 \*`\)/);
  const schedule = parseCron("0 0 */30 2 1");
  const first = nextFire(schedule, Date.UTC(2026, 10, 16), "UTC");
  assert.equal(first, Date.UTC(2027, 1, 1));
  assert.equal(nextFire(schedule, first as number, "UTC"), Date.UTC(2038, 1, 1));
  for (const never of ["0 0 31 2 *", "0 0 30 2 *"]) assert.equal(nextFire(parseCron(never), Date.UTC(2026, 10, 16), "UTC"), null, never);
  for (const name of ["README.md", "docs/configuration.md", "docs/architecture.md", "docs/api.md"]) {
    assert.doesNotMatch(flat(await doc(name)), /within 5 years|five years|five-year/i, name);
  }
});

test("(R14D-tools-03) configuration.md: edit_file refuses an edit over the write limit with the documented message before building it", async (t) => {
  assert.match(flat(await doc("docs/configuration.md")),
    /refuses an edit over `maxWriteBytes` \(`the edited file would be <n> bytes, larger than the write limit of <limit> bytes`\) before it builds the new text/);
  const workspace = await makeTempDir(t, "runwright-docs-edit-");
  await writeFile(join(workspace, "a.txt"), "a".repeat(1024));
  const edit = createFileTools({ maxReadBytes: 4096, maxWriteBytes: 4096 }).find((tool) => tool.name === "edit_file");
  assert.ok(edit !== undefined);
  const context = await fileToolContext(workspace);
  const result = await edit.handler({ path: "a.txt", old_text: "a", new_text: "bbbbb", replace_all: true }, context);
  assert.equal(result.isError, true);
  assert.equal(result.content, "a.txt: the edited file would be 5120 bytes, larger than the write limit of 4096 bytes");
  assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "a".repeat(1024), "the file is unchanged");
});

test("(R14D-models-01, R14D-tools-01) architecture.md and security.md state the Anthropic final-usage rule and the closed web_fetch responses", async () => {
  // Executed through the engine in test/e2e/stream-error-retry.test.ts and test/tools/web-fetch.test.ts.
  assert.match(flat(await doc("docs/architecture.md")),
    /a `message_delta` with a `stop_reason` and a `usage\.output_tokens` token count .* A stream that ends without that final count is a reply failure with unknown billing, charged its worst case, never billed with the start's count/);
  assert.match(flat(await doc("docs/security.md")),
    /Every response the tool does not read to its end \(a redirect hop, a refused content type, a body cut at the size limit, a timeout, an abort, a response that arrives after the call gave up\) is destroyed, socket included/);
  const e2e = await readFile(join(ROOT, "test/e2e/stream-error-retry.test.ts"), "utf8");
  assert.match(e2e, /an Anthropic stream without final output_tokens is charged its worst case and fails the run/);
});
