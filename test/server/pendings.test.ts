import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { RunwrightError } from "../../src/core/errors.ts";
import { createAskPersonTool } from "../../src/tools/ask-person.ts";
import { columnValues, formsIn } from "../security/at-rest.ts";
import { createHarness, fakeModels, reply, toolReply } from "../helpers/engine.ts";
import { startTestApp } from "../fixtures/app.ts";
import { scriptedAgent, waitForStatus } from "../fixtures/runs.ts";
import { authed, commitAs, errorOf, openPending, seedRun, startTestServer } from "./support.ts";

test("pendings are listed in one place and fetched one by one", async (t) => {
  const s = await startTestServer(t);
  const r1 = await seedRun(s.store, "one");
  const r2 = await seedRun(s.store, "two");
  const question = await openPending(s.store, r1.id, "question", { question: "Name?", choices: [] });
  const approval = await openPending(s.store, r2.id, "approval", { tool: "shell", args: { command: "ls" } });
  const all = await s.client.listPendings();
  assert.deepEqual(all.pendings.map((p) => p.id), [question.id, approval.id]);
  assert.equal(all.nextCursor, null);
  assert.deepEqual((await s.client.listPendings({ kind: "approval" })).pendings.map((p) => p.id), [approval.id]);
  assert.deepEqual((await s.client.listPendings({ agentId: "one" })).pendings.map((p) => p.id), [question.id]);
  assert.deepEqual((await s.client.listPendings({ runId: r2.id })).pendings.map((p) => p.id), [approval.id]);
  assert.deepEqual((await s.client.listPendings({ status: "resolved" })).pendings, []);
  const page = await s.client.listPendings({ limit: 1 });
  assert.equal(page.pendings.length, 1);
  assert.notEqual(page.nextCursor, null);
  assert.equal((await s.client.getPending(question.id)).kind, "question");
  assert.equal((await errorOf(await authed(s, "/v1/pendings/pnd_nope"))).status, 404);
  assert.equal((await errorOf(await authed(s, "/v1/pendings?kind=hunch"))).code, "bad_request");
});

test("answer, approve, deny and resolve queue the matching command on the pending's run", async (t) => {
  const s = await startTestServer(t);
  const cases = [
    { kind: "question" as const, act: (id: string) => s.client.answer(id, "blue"), expect: { type: "answer", answer: "blue" } },
    { kind: "approval" as const, act: (id: string) => s.client.approve(id, { always: true }), expect: { type: "approve", always: true } },
    { kind: "approval" as const, act: (id: string) => s.client.approve(id), expect: { type: "approve", always: false } },
    { kind: "approval" as const, act: (id: string) => s.client.deny(id, "too risky"), expect: { type: "deny", reason: "too risky" } },
    { kind: "approval" as const, act: (id: string) => s.client.deny(id), expect: { type: "deny", reason: null } },
    { kind: "interrupted" as const, act: (id: string) => s.client.resolveInterrupted(id, "skip", "done by hand"), expect: { type: "resolve_interrupted", action: "skip", result: "done by hand" } },
    { kind: "interrupted" as const, act: (id: string) => s.client.resolveInterrupted(id, "retry"), expect: { type: "resolve_interrupted", action: "retry", result: null } },
  ];
  let n = 0;
  for (const item of cases) {
    n += 1;
    const run = await seedRun(s.store, `agent-${n}`);
    const pending = await openPending(s.store, run.id, item.kind);
    const command = await item.act(pending.id);
    assert.equal(command.runId, run.id);
    assert.deepEqual(command.command, { ...item.expect, pendingId: pending.id });
    assert.equal((await s.store.getRun(run.id))?.status, "queued", "a command re-queues a waiting run");
  }
});

test("the wrong kind of answer, or a resolved pending, is 409 pending_not_open", async (t) => {
  const s = await startTestServer(t);
  const run = await seedRun(s.store);
  const question = await openPending(s.store, run.id, "question");
  for (const [path, json] of [["approve", {}], ["deny", {}], ["resolve", { action: "retry" }]] as const) {
    const error = await errorOf(await authed(s, `/v1/pendings/${question.id}/${path}`, { method: "POST", json }));
    assert.equal(error.status, 409, path);
    assert.equal(error.code, "pending_not_open", path);
  }
  const { lease } = await (async () => {
    await s.client.answer(question.id, "x");
    const claimed = await s.store.claimRuns({ runnerId: "r", limit: 1, leaseMs: 60_000 });
    return claimed[0] as (typeof claimed)[number];
  })();
  const answers = await s.store.listCommands(run.id, { unconsumedOnly: true });
  await s.store.commit(lease, {
    records: [{ type: "pending.resolved", key: question.stepKey, data: {} }],
    resolvePendings: [{ id: question.id, resolution: { answer: "x" } }],
    consumeCommands: answers.map((c) => c.id),
    transition: { to: "waiting" },
  });
  const again = await errorOf(await authed(s, `/v1/pendings/${question.id}/answer`, { method: "POST", json: { answer: "y" } }));
  assert.equal(again.code, "pending_not_open");
  const badAction = await errorOf(await authed(s, `/v1/pendings/${question.id}/resolve`, { method: "POST", json: { action: "explode" } }));
  assert.equal(badAction.code, "validation_failed");
});

test("a pending of a finished run is 409", async (t) => {
  const s = await startTestServer(t);
  const run = await seedRun(s.store);
  const pending = await openPending(s.store, run.id, "question");
  await s.client.cancelRun(run.id);
  const cancels = await s.store.listCommands(run.id, { unconsumedOnly: true });
  await commitAs(s.store, run.id, { records: [{ type: "run.cancelled", data: {} }], consumeCommands: cancels.map((c) => c.id), transition: { to: "cancelled" } });
  const error = await errorOf(await authed(s, `/v1/pendings/${pending.id}/answer`, { method: "POST", json: { answer: "late" } }));
  assert.equal(error.status, 409);
});

test("with a runner attached, answering a question through the API really continues the run", async (t) => {
  const h = await createHarness(t, {
    tools: [createAskPersonTool()],
    models: fakeModels((request) => {
      const answered = request.messages.find((m) => m.role === "tool");
      return answered === undefined ? toolReply("ask_person", { question: "Which colour?" }) : reply({ text: `painting it ${answered.content}` });
    }),
  });
  const s = await startTestServer(t, { store: h.store, dir: h.dir });
  const agent = await h.saveAgent({ tools: [{ name: "ask_person" }] });
  const { run } = await s.client.startRun({ agentId: agent.id, message: "paint the fence" });
  const waiting = await s.client.waitForRun(run.id, { timeoutMs: 5000, pollMs: 10 });
  assert.equal(waiting.run.status, "waiting");
  const [pending] = waiting.pendings;
  assert.ok(pending !== undefined);
  assert.equal(pending.kind, "question");
  assert.equal(pending.detail["question"], "Which colour?");
  await s.client.answer(pending.id, "green");
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, { text: "painting it green" });
  assert.deepEqual((await s.client.listPendings()).pendings, []);
});

test("an answer, a deny reason and a resolve result carrying a secret are returned and stored with the placeholder", async (t) => {
  const s = await startTestServer(t);
  const value = "pending-secret-0123456789";
  await s.client.setSecret("PENDING_KEY", value);
  const cases = [
    { kind: "question" as const, act: (id: string) => s.client.answer(id, `it is ${value}`), expect: { type: "answer", answer: "it is [redacted]" } },
    { kind: "approval" as const, act: (id: string) => s.client.deny(id, `no: ${value}`), expect: { type: "deny", reason: "no: [redacted]" } },
    { kind: "interrupted" as const, act: (id: string) => s.client.resolveInterrupted(id, "skip", `got ${encodeURIComponent(value)}`),
      expect: { type: "resolve_interrupted", action: "skip", result: "got [redacted]" } },
  ];
  let n = 0;
  for (const item of cases) {
    n += 1;
    const run = await seedRun(s.store, `secret-agent-${n}`);
    const pending = await openPending(s.store, run.id, item.kind);
    const command = await item.act(pending.id);
    assert.deepEqual(command.command, { ...item.expect, pendingId: pending.id });
    const payloads = columnValues(join(s.dir, "runwright.db"), "SELECT payload FROM commands WHERE run_id = ?", run.id);
    assert.equal(payloads.length, 1);
    assert.deepEqual(formsIn(payloads[0] as string, value), [], `the stored ${item.kind} command holds no form of the secret`);
  }
});

test("a pending past its detail.expiresAt is 409 pending_not_open with the instant, and nothing is queued", async (t) => {
  const s = await startTestServer(t);
  const routes = [
    { kind: "question" as const, path: "answer", json: { answer: "late" } },
    { kind: "approval" as const, path: "approve", json: {} },
    { kind: "approval" as const, path: "deny", json: { reason: "late" } },
    { kind: "interrupted" as const, path: "resolve", json: { action: "retry" } },
  ];
  let n = 0;
  for (const route of routes) {
    n += 1;
    const run = await seedRun(s.store, `expired-${n}`);
    const expiresAt = Date.now() - 1000;
    const pending = await openPending(s.store, run.id, route.kind, { expiresAt });
    const error = await errorOf(await authed(s, `/v1/pendings/${pending.id}/${route.path}`, { method: "POST", json: route.json }));
    assert.equal(error.status, 409, route.path);
    assert.equal(error.code, "pending_not_open", route.path);
    assert.equal(error.message, `pending ${pending.id} expired at ${new Date(expiresAt).toISOString()}`, route.path);
    assert.deepEqual(error.details, { pendingId: pending.id, status: "open", kind: route.kind, expiresAt }, route.path);
    assert.deepEqual(await s.store.listCommands(run.id, { unconsumedOnly: true }), [], `${route.path}: no command was queued`);
    assert.equal((await s.store.getRun(run.id))?.status, "waiting", `${route.path}: the run is still waiting`);
  }
});

test("a pending answered before its detail.expiresAt is 202, and an expiresAt that is not a finite number is ignored", async (t) => {
  const s = await startTestServer(t);
  const cases = [
    { name: "future", detail: { expiresAt: Date.now() + 60_000 } },
    { name: "string", detail: { expiresAt: "2000-01-01T00:00:00.000Z" } },
    { name: "null", detail: { expiresAt: null } },
  ];
  for (const item of cases) {
    const run = await seedRun(s.store, `open-${item.name}`);
    const pending = await openPending(s.store, run.id, "question", item.detail);
    const response = await authed(s, `/v1/pendings/${pending.id}/answer`, { method: "POST", json: { answer: "in time" } });
    assert.equal(response.status, 202, item.name);
    const commands = await s.store.listCommands(run.id, { unconsumedOnly: true });
    assert.deepEqual(commands.map((c) => c.command), [{ type: "answer", pendingId: pending.id, answer: "in time" }], item.name);
  }
});

test("an expiresAt far outside the range of a date is still refused, with the instant in milliseconds", async (t) => {
  const s = await startTestServer(t);
  const run = await seedRun(s.store);
  const pending = await openPending(s.store, run.id, "question", { expiresAt: -1e20 });
  const error = await errorOf(await authed(s, `/v1/pendings/${pending.id}/answer`, { method: "POST", json: { answer: "x" } }));
  assert.deepEqual([error.status, error.code, error.message], [409, "pending_not_open", `pending ${pending.id} expired at -100000000000000000000 ms since the epoch`]);
});

test("a workflow wait with a deadline opens its question with detail.expiresAt; after the instant the API refuses the answer", async (t) => {
  const { client } = await startTestApp(t);
  const { agent } = await client.saveAgent({
    ...scriptedAgent({ name: "Asker", script: { turns: [{ text: "unused" }] } }),
    workflow: {
      format: "runwright.workflow/v1", name: "asks", input: "In", output: "Out", schemas: { In: { type: "object" }, Out: {} },
      root: { id: "ask", kind: "wait", question: "Ship it?", deadlineMs: 300 }, result: { $ref: "steps.ask.answer" },
    },
  }, "asker");
  const before = Date.now();
  const { run } = await client.startRun({ agentId: agent.id, data: {} });
  const waiting = await waitForStatus(client, run.id, ["waiting", "completed", "failed", "cancelled"]);
  assert.equal(waiting.run.status, "waiting");
  const [pending] = waiting.pendings;
  assert.ok(pending !== undefined);
  const expiresAt = pending.detail["expiresAt"];
  assert.ok(typeof expiresAt === "number" && expiresAt >= before + 300 && expiresAt <= Date.now() + 300, `expiresAt ${String(expiresAt)}`);
  const failed = await waitForStatus(client, run.id, ["completed", "failed", "cancelled"], 5000);
  assert.equal(failed.run.status, "failed");
  await assert.rejects(client.answer(pending.id, "too late"), (error: unknown) =>
    error instanceof RunwrightError && error.code === "pending_not_open" && error.status === 409);
  assert.deepEqual((await client.getPending(pending.id)).resolution, { expired: true, expiresAt });
});
