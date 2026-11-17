/**
 * Rule R (R14-01, plan 2.1): an unfinished call of a tool declared idempotent with effect "write" is run again by
 * the engine itself only when no write call of the run finished after it started; otherwise it waits for a
 * person as an interrupted call. A read-only tool is always run again. The journals of crashed runs are built
 * the way `delete-recovery.test.ts` builds them; pause, forced shutdown and nested calls are driven live.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RunwrightError } from "../../src/core/errors.ts";
import type { Json, JsonObject } from "../../src/core/json.ts";
import { settleAll } from "../../src/engine/control.ts";
import { newRecord } from "../../src/engine/journal-types.ts";
import type { Driver, RunContext } from "../../src/engine/types.ts";
import type { NewJournalRecord } from "../../src/store/types.ts";
import { createFileTools } from "../../src/tools/fs.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import { createWorkflowRuntime } from "../../src/workflow/exec/index.ts";
import { WORKFLOW_FORMAT, type WorkflowDocument, type WorkflowNode } from "../../src/workflow/types.ts";
import { createHarness, fakeModels, reply, type Harness } from "../helpers/engine.ts";
import { waitFor } from "../helpers/wait.ts";

const fileTools = (): ToolDefinition[] => createFileTools({ maxReadBytes: 65_536, maxWriteBytes: 65_536 });

/** One tool step of the driver: its key, tool and arguments. */
interface Step { key: string; tool: string; args: JsonObject }

/** Runs every step at once (as parallel branches do) and returns `{key: content}`. */
function parallelDriver(steps: readonly Step[]): Driver {
  return async (ctx) => {
    const results = await settleAll(steps.map((s) => ctx.tool(s.key, { name: s.tool, args: s.args })));
    const out: JsonObject = {};
    steps.forEach((s, i) => {
      out[s.key] = results[i]?.content ?? null;
    });
    return out;
  };
}

const started = (s: Step, effect: "read" | "write", attempt = 1): NewJournalRecord =>
  newRecord("tool.started", { callId: s.key, tool: s.tool, args: s.args, effect, attempt }, s.key);

const finished = (s: Step, outcome: "ok" | "denied" | "invalid_args" | "skipped", content: string, data: Json = null): NewJournalRecord =>
  newRecord("tool.finished", {
    callId: s.key, tool: s.tool, outcome, content, data, isError: outcome === "denied" || outcome === "invalid_args",
    untrusted: false, truncated: false, fullResultPath: null, durationMs: 1,
  }, s.key);

/** The journal of a runner that died after committing `records` (claimed with a 50 ms lease, so it expires soon). */
async function crashedRun(h: Harness, agentId: string, records: NewJournalRecord[]): Promise<string> {
  const run = await h.start(agentId);
  const [claimed] = await h.store.claimRuns({ runnerId: "runner_dead", limit: 1, leaseMs: 50 });
  assert.ok(claimed !== undefined && claimed.run.id === run.id);
  const starts = records.filter((r) => r.type === "tool.started" && r.data["attempt"] === 1).length;
  await h.store.commit(claimed.lease, {
    records: [newRecord("run.claimed", { runnerId: "runner_dead" }), ...records],
    ...(starts > 0 ? { counters: { toolCalls: starts } } : {}),
  });
  return run.id;
}

async function workspaceWith(h: Harness, runId: string, files: Record<string, string>): Promise<string> {
  const workspace = join(h.dir, "workspaces", runId);
  await mkdir(workspace, { recursive: true });
  for (const [name, content] of Object.entries(files)) await writeFile(join(workspace, name), content);
  return workspace;
}

async function fileOf(workspace: string, name: string): Promise<string | null> {
  try {
    return await readFile(join(workspace, name), "utf8");
  } catch {
    return null;
  }
}

const del: Step = { key: "del", tool: "delete_file", args: { path: "x.txt" } };
const put: Step = { key: "put", tool: "write_file", args: { path: "x.txt", content: "new" } };
const look: Step = { key: "look", tool: "read_file", args: { path: "x.txt" } };

/** U1's journal: the delete started (and unlinked x), then a complete write of x ("new"), then the runner died. */
const deleteThenFinishedWrite = (): NewJournalRecord[] => [
  started(del, "write"), started(put, "write"), finished(put, "ok", "wrote x.txt (3 bytes)", { path: "x.txt", bytes: 3 }),
];

async function harnessFor(t: Parameters<typeof createHarness>[0], steps: readonly Step[], extra: ToolDefinition[] = []) {
  const h = await createHarness(t, {
    models: fakeModels(() => reply({})), tools: [...fileTools(), ...extra], drivers: { agent: parallelDriver(steps) }, autoStart: false,
  });
  const agent = await h.saveAgent({ tools: steps.map((s) => ({ name: s.tool })) });
  return { h, agentId: agent.id };
}

async function interruptedAt(h: Harness, runId: string, key: string) {
  const waiting = await h.until(runId, ["waiting", "completed", "failed"]);
  assert.equal(waiting.status, "waiting", JSON.stringify(waiting.error));
  const pendings = await h.pendings(runId);
  assert.equal(pendings.length, 1, JSON.stringify(pendings));
  const [pending] = pendings;
  assert.ok(pending !== undefined);
  assert.equal(pending.kind, "interrupted");
  assert.equal(pending.stepKey, key);
  return pending;
}

test("U1: a delete left unfinished before a finished write of the same file waits for a person; the file keeps the write", async (t) => {
  const { h, agentId } = await harnessFor(t, [del, put]);
  const runId = await crashedRun(h, agentId, deleteThenFinishedWrite());
  const workspace = await workspaceWith(h, runId, { "x.txt": "new" });
  h.runner.start();
  const pending = await interruptedAt(h, runId, "del");
  assert.equal(pending.detail["tool"], "delete_file");
  assert.equal(await fileOf(workspace, "x.txt"), "new", "the finished write was not undone");
  const journal = await h.journal(runId);
  assert.deepEqual(journal.filter((r) => r.type === "tool.interrupted").map((r) => r.key), ["del"]);
  assert.deepEqual(journal.filter((r) => r.type === "tool.finished").map((r) => r.key), ["put"], "exactly one finished write");
  assert.deepEqual(journal.filter((r) => r.type === "tool.started" && r.key === "del").map((r) => r.data["attempt"]), [1]);
});

for (const action of ["retry", "skip", "cancel"] as const) {
  test(`U2: the waiting delete resolved with ${action}`, async (t) => {
    const { h, agentId } = await harnessFor(t, [del, put]);
    const runId = await crashedRun(h, agentId, deleteThenFinishedWrite());
    const workspace = await workspaceWith(h, runId, { "x.txt": "new" });
    h.runner.start();
    const pending = await interruptedAt(h, runId, "del");
    await h.send(runId, { type: "resolve_interrupted", pendingId: pending.id, action, result: action === "skip" ? "left as is" : null });
    const done = await h.until(runId, ["completed", "cancelled", "failed", "waiting"]);
    const deletes = (await h.journal(runId)).filter((r) => r.type === "tool.finished" && r.key === "del");
    if (action === "retry") {
      assert.equal(done.status, "completed", JSON.stringify(done.error));
      assert.equal(await fileOf(workspace, "x.txt"), null, "the person chose to run the delete again");
      assert.equal(deletes[0]?.data["outcome"], "ok");
      assert.deepEqual(deletes[0]?.data["data"], { path: "x.txt", deleted: true });
    } else if (action === "skip") {
      assert.equal(done.status, "completed", JSON.stringify(done.error));
      assert.equal(await fileOf(workspace, "x.txt"), "new");
      assert.equal(deletes[0]?.data["outcome"], "skipped");
      assert.deepEqual(done.output, { del: "left as is", put: "wrote x.txt (3 bytes)" });
    } else {
      assert.equal(done.status, "cancelled");
      assert.equal(await fileOf(workspace, "x.txt"), "new");
      assert.equal(deletes.length, 0);
    }
  });
}

test("U3: with no later finished write the idempotent call runs again by itself (write_file and delete_file)", async (t) => {
  await t.test("write_file", async (t) => {
    const { h, agentId } = await harnessFor(t, [put]);
    const runId = await crashedRun(h, agentId, [started(put, "write")]);
    const workspace = await workspaceWith(h, runId, { "x.txt": "ne" });
    h.runner.start();
    const done = await h.until(runId, ["completed", "waiting", "failed"]);
    assert.equal(done.status, "completed", JSON.stringify(done.error));
    assert.equal(await fileOf(workspace, "x.txt"), "new");
    assert.deepEqual((await h.records(runId, "tool.started")).map((r) => r.attempt), [1, 2]);
    assert.equal((await h.records(runId, "pending.opened")).length, 0);
  });
  await t.test("a write finished before the delete started does not hold it back", async (t) => {
    const { h, agentId } = await harnessFor(t, [put, del]);
    const runId = await crashedRun(h, agentId, [
      started(put, "write"), finished(put, "ok", "wrote x.txt (3 bytes)", { path: "x.txt", bytes: 3 }), started(del, "write"),
    ]);
    const workspace = await workspaceWith(h, runId, {});
    h.runner.start();
    const done = await h.until(runId, ["completed", "waiting", "failed"]);
    assert.equal(done.status, "completed", JSON.stringify(done.error));
    assert.equal(await fileOf(workspace, "x.txt"), null);
    assert.deepEqual((await h.records(runId, "tool.started")).filter((r) => r.tool === "delete_file").map((r) => r.attempt), [1, 2]);
  });
});

test("U4: a later finished read, a denied call or a call with invalid arguments does not hold the delete back", async (t) => {
  const cases: { name: string; steps: Step[]; records: NewJournalRecord[] }[] = [
    { name: "read_file", steps: [del, look], records: [started(del, "write"), started(look, "read"), finished(look, "ok", "new")] },
    { name: "denied write", steps: [del, put], records: [started(del, "write"), finished(put, "denied", "denied")] },
    { name: "invalid arguments", steps: [del, put], records: [started(del, "write"), finished(put, "invalid_args", "bad args")] },
  ];
  for (const c of cases) {
    await t.test(c.name, async (t) => {
      const { h, agentId } = await harnessFor(t, c.steps);
      const runId = await crashedRun(h, agentId, c.records);
      const workspace = await workspaceWith(h, runId, { "x.txt": "new" });
      h.runner.start();
      const done = await h.until(runId, ["completed", "waiting", "failed"]);
      assert.equal(done.status, "completed", JSON.stringify(done.error));
      assert.equal(await fileOf(workspace, "x.txt"), null, "the delete ran again");
      assert.equal((await h.records(runId, "pending.opened")).length, 0);
    });
  }
});

const note: ToolDefinition = {
  name: "write_note", description: "a host write tool, not idempotent", effect: "write",
  parameters: { type: "object", properties: {} }, handler: async () => ({ content: "noted" }),
};

test("U5: a later finished host write, or a skipped finish of an interrupted write, holds the delete back", async (t) => {
  const noteStep: Step = { key: "note", tool: "write_note", args: {} };
  const cases: { name: string; records: NewJournalRecord[] }[] = [
    { name: "host write tool", records: [started(del, "write"), started(noteStep, "write"), finished(noteStep, "ok", "noted")] },
    {
      name: "skipped interrupted write",
      records: [
        started(del, "write"), started(noteStep, "write"),
        newRecord("tool.interrupted", { tool: "write_note", args: {}, attempt: 1, reason: "crash" }, "note"),
        finished(noteStep, "skipped", "a person skipped it"),
      ],
    },
  ];
  for (const c of cases) {
    await t.test(c.name, async (t) => {
      const { h, agentId } = await harnessFor(t, [del, noteStep], [note]);
      const runId = await crashedRun(h, agentId, c.records);
      const workspace = await workspaceWith(h, runId, { "x.txt": "new" });
      h.runner.start();
      await interruptedAt(h, runId, "del");
      assert.equal(await fileOf(workspace, "x.txt"), "new");
    });
  }
});

test("U9: a read-only call is run again whatever finished after it", async (t) => {
  const { h, agentId } = await harnessFor(t, [look, put]);
  const runId = await crashedRun(h, agentId, [
    started(look, "read"), started(put, "write"), finished(put, "ok", "wrote x.txt (3 bytes)", { path: "x.txt", bytes: 3 }),
  ]);
  await workspaceWith(h, runId, { "x.txt": "new" });
  h.runner.start();
  const done = await h.until(runId, ["completed", "waiting", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.deepEqual(done.output, { look: "new", put: "wrote x.txt (3 bytes)" });
  assert.deepEqual((await h.records(runId, "tool.started")).filter((r) => r.tool === "read_file").map((r) => r.attempt), [1, 2]);
});

// ---------------------------------------------------------------- live: pause, forced shutdown, nested calls

/** Resolves once; `wait()` gives the same promise to everyone. */
function latch(): { open(): void; wait(): Promise<void> } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, wait: () => promise };
}

/**
 * `slow_put`: a host tool declared idempotent with effect "write" that writes `slow.txt`; its first invocation
 * then waits until its call is aborted (and honours the abort), later ones return at once.
 */
function slowPut(): { tool: ToolDefinition; entered: ReturnType<typeof latch>; calls: () => number } {
  const entered = latch();
  let calls = 0;
  const tool: ToolDefinition = {
    name: "slow_put", description: "writes slow.txt", effect: "write", idempotent: true,
    parameters: { type: "object", properties: {} },
    async handler(_args, context) {
      calls++;
      await writeFile(join(context.workspace, "slow.txt"), `call ${calls}`);
      if (calls === 1) {
        entered.open();
        await new Promise((_resolve, reject) => {
          if (context.signal.aborted) reject(context.signal.reason);
          context.signal.addEventListener("abort", () => reject(new RunwrightError("aborted", "aborted")), { once: true });
        });
      }
      return { content: `slow_put ${calls}` };
    },
  };
  return { tool, entered, calls: () => calls };
}

/** `slow` (slow_put) and, when the run's message is "with-write", a `write_file` that finishes while slow waits. */
function slowAndWrite(entered: ReturnType<typeof latch>): Driver {
  return async (ctx) => {
    const branches: Promise<unknown>[] = [ctx.tool("slow", { name: "slow_put", args: {} })];
    if (ctx.run.input.message === "with-write") {
      branches.push(entered.wait().then(() => ctx.tool("put", { name: "write_file", args: put.args })));
    }
    await settleAll(branches);
    return "done";
  };
}

async function finishedRecord(h: Harness, runId: string, key: string): Promise<void> {
  await waitFor(async () => (await h.journal(runId)).some((r) => r.type === "tool.finished" && r.key === key), { timeoutMs: 5000 });
}

for (const withWrite of [true, false]) {
  test(`U6: a pause aborts an idempotent write; on resume it ${withWrite ? "waits for a person (a write finished meanwhile)" : "runs again"}`, async (t) => {
    const slow = slowPut();
    const h = await createHarness(t, {
      models: fakeModels(() => reply({})), tools: [...fileTools(), slow.tool], drivers: { agent: slowAndWrite(slow.entered) },
    });
    const agent = await h.saveAgent({ tools: [{ name: "slow_put" }, { name: "write_file" }] });
    const run = await h.start(agent.id, { message: withWrite ? "with-write" : "alone" });
    await slow.entered.wait();
    if (withWrite) await finishedRecord(h, run.id, "put");
    await h.send(run.id, { type: "pause" });
    await h.until(run.id, "paused");
    assert.equal((await h.records(run.id, "tool.interrupted")).length, 0, "the pause leaves the call unfinished");
    await h.send(run.id, { type: "resume" });
    if (withWrite) {
      await interruptedAt(h, run.id, "slow");
      assert.equal(slow.calls(), 1, "not run again by itself");
    } else {
      const done = await h.until(run.id, ["completed", "waiting", "failed"]);
      assert.equal(done.status, "completed", JSON.stringify(done.error));
      assert.equal(slow.calls(), 2);
    }
  });

  test(`U7: a forced shutdown aborts an idempotent write; the next session ${withWrite ? "makes it wait" : "runs it again"}`, async (t) => {
    const slow = slowPut();
    const h = await createHarness(t, {
      models: fakeModels(() => reply({})), tools: [...fileTools(), slow.tool], drivers: { agent: slowAndWrite(slow.entered) },
    });
    const agent = await h.saveAgent({ tools: [{ name: "slow_put" }, { name: "write_file" }] });
    const run = await h.start(agent.id, { message: withWrite ? "with-write" : "alone" });
    await slow.entered.wait();
    if (withWrite) await finishedRecord(h, run.id, "put");
    await h.runner.stop({ graceMs: 20 });
    const released = await h.until(run.id, "queued");
    assert.equal(released.status, "queued");
    assert.deepEqual((await h.records(run.id, "run.released")).map((r) => r.reason), ["forced shutdown"]);
    h.newRunner();
    if (withWrite) {
      await interruptedAt(h, run.id, "slow");
      assert.equal(slow.calls(), 1);
    } else {
      const done = await h.until(run.id, ["completed", "waiting", "failed"]);
      assert.equal(done.status, "completed", JSON.stringify(done.error));
      assert.equal(slow.calls(), 2);
    }
  });
}

/** A workflow document with permissive schemas. */
function workflowDoc(name: string, root: WorkflowNode): WorkflowDocument {
  return { format: WORKFLOW_FORMAT, name, schemas: { Input: { type: "object" }, Output: {} }, input: "Input", output: "Output", root, result: null };
}

/** A harness whose tools include `run_workflow` over the real workflow runtime, with `inner` and `writes` saved. */
async function nestedHarness(t: Parameters<typeof createHarness>[0], driver: Driver, slow: ToolDefinition): Promise<Harness> {
  let harness: Harness | null = null;
  const runtime = createWorkflowRuntime({
    agentLoop: async () => ({ text: "", data: null, turns: 0 }),
    store: { getWorkflow: (name, version) => (harness as Harness).store.getWorkflow(name, version) },
    tools: {
      register: (tool) => (harness as Harness).tools.register(tool),
      get: (name) => (harness as Harness).tools.get(name),
      list: () => (harness as Harness).tools.list(),
    },
  });
  const h = await createHarness(t, {
    models: fakeModels(() => reply({})), tools: [...fileTools(), slow, runtime.runWorkflowTool], drivers: { agent: driver },
  });
  harness = h;
  await h.store.saveWorkflow({ name: "inner", source: "api", document: workflowDoc("inner", { id: "s", kind: "tool", tool: "slow_put", args: {} }) });
  await h.store.saveWorkflow({
    name: "writes", source: "api",
    document: workflowDoc("writes", { id: "w", kind: "tool", tool: "write_file", args: { path: "x.txt", content: "nested" } }),
  });
  return h;
}

/** Runs `first`; once slow_put was entered, runs `second`, then crashes the runner (the second step finished). */
function crashAfter(h: () => Harness, entered: ReturnType<typeof latch>, first: (ctx: RunContext) => Promise<unknown>, second: (ctx: RunContext) => Promise<unknown>): Driver {
  let crashed = false;
  return async (ctx) => {
    await settleAll([
      first(ctx),
      entered.wait().then(async () => {
        await second(ctx);
        if (!crashed) {
          crashed = true;
          await h().crashAndReplace();
        }
      }),
    ]);
    return "done";
  };
}

test("U8: an unfinished idempotent write inside run_workflow waits when a top-level write finished after it", async (t) => {
  const slow = slowPut();
  let harness: Harness | null = null;
  const driver = crashAfter(() => harness as Harness, slow.entered,
    (ctx) => ctx.tool("wf", { name: "run_workflow", args: { name: "inner", input: {} } }),
    (ctx) => ctx.tool("put", { name: "write_file", args: put.args }));
  const h = await nestedHarness(t, driver, slow.tool);
  harness = h;
  const agent = await h.saveAgent({ tools: [{ name: "run_workflow" }, { name: "write_file" }, { name: "slow_put" }] });
  const run = await h.start(agent.id);
  const waiting = await h.until(run.id, ["waiting", "completed", "failed"], 8000);
  assert.equal(waiting.status, "waiting", JSON.stringify(waiting.error));
  const [pending] = await h.pendings(run.id);
  assert.equal(pending?.kind, "interrupted");
  assert.equal(pending?.detail["tool"], "slow_put");
  assert.match(pending?.stepKey ?? "", /^wf\//, "the nested call waits");
  assert.equal(slow.calls(), 1);
});

test("U8: an unfinished top-level idempotent write waits when a write inside run_workflow finished after it", async (t) => {
  const slow = slowPut();
  let harness: Harness | null = null;
  const driver = crashAfter(() => harness as Harness, slow.entered,
    (ctx) => ctx.tool("slow", { name: "slow_put", args: {} }),
    (ctx) => ctx.tool("wf", { name: "run_workflow", args: { name: "writes", input: {} } }));
  const h = await nestedHarness(t, driver, slow.tool);
  harness = h;
  const agent = await h.saveAgent({ tools: [{ name: "run_workflow" }, { name: "write_file" }, { name: "slow_put" }] });
  const run = await h.start(agent.id);
  const waiting = await h.until(run.id, ["waiting", "completed", "failed"], 8000);
  assert.equal(waiting.status, "waiting", JSON.stringify(waiting.error));
  const [pending] = await h.pendings(run.id);
  assert.equal(pending?.kind, "interrupted");
  assert.equal(pending?.stepKey, "slow");
  const nested = (await h.journal(run.id)).filter((r) => r.type === "tool.finished" && (r.key ?? "").startsWith("wf/"));
  assert.equal(nested.length, 1, "the nested write finished once");
  assert.equal(slow.calls(), 1);
});
