import { test } from "node:test";
import assert from "node:assert/strict";
import type { JsonObject } from "../../src/core/json.ts";
import type { ModelRequest, ToolCall } from "../../src/models/types.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import { SERVER_DENY_REASON, resolvePolicy, serverDenial } from "../../src/engine/policy.ts";
import { testAgentDefinition } from "../helpers/store.ts";
import type { Driver, LearningHooks } from "../../src/engine/types.ts";
import { createHarness, fakeModels, reply, type Harness } from "../helpers/engine.ts";
import { waitFor } from "../helpers/wait.ts";

function tool(name: string, calls: string[], extra: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name, description: `The ${name} tool.`, effect: "write",
    parameters: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false },
    handler: async () => {
      calls.push(name);
      return { content: `${name} ok` };
    },
    ...extra,
  };
}

function toolResults(request: ModelRequest): string[] {
  return request.messages.flatMap((m) => (m.role === "tool" ? [`${m.name}: ${m.content}`] : []));
}

/** Turn n answers with the n-th list of tool calls, then with the tool results joined. */
function plannedModels(turns: { name: string; args?: JsonObject }[][], seen: ModelRequest[] = []) {
  return fakeModels((request) => {
    seen.push(request);
    const calls = turns[request.meta.turn - 1];
    if (calls === undefined) return reply({ text: toolResults(request).join("\n") });
    const toolCalls: ToolCall[] = calls.map((c, i) => ({ id: `c${request.meta.turn}_${i}`, name: c.name, args: c.args ?? {} }));
    return reply({ toolCalls });
  });
}

test("resolvePolicy: server deny list, agent entries, defaults, approve-always and unlisted tools", () => {
  const definition = testAgentDefinition({ tools: [{ name: "a", policy: "allow" }, { name: "b", policy: "ask" }, { name: "c" }, { name: "d" }] });
  const base = {
    definition, registryDefault: undefined, denyTools: [] as string[], scope: null, granted: [] as string[], approvedAlways: [] as string[],
  };
  assert.equal(resolvePolicy({ ...base, tool: "a" }).policy, "allow");
  assert.equal(resolvePolicy({ ...base, tool: "b" }).policy, "ask");
  assert.equal(resolvePolicy({ ...base, tool: "c" }).policy, "allow");
  assert.equal(resolvePolicy({ ...base, tool: "d", registryDefault: "ask" }).policy, "ask");
  assert.equal(resolvePolicy({ ...base, tool: "a", denyTools: ["a"] }).policy, "deny");
  assert.equal(resolvePolicy({ ...base, tool: "a", denyTools: ["a"], granted: ["a"] }).policy, "deny");
  const unlisted = resolvePolicy({ ...base, tool: "zzz" });
  assert.deepEqual(unlisted, { policy: "deny", reason: "not granted to this agent" });
  assert.equal(resolvePolicy({ ...base, tool: "b", approvedAlways: ["b"] }).policy, "allow");
  assert.equal(resolvePolicy({ ...base, tool: "d", registryDefault: "deny", approvedAlways: ["d"] }).policy, "deny");
  assert.deepEqual(resolvePolicy({ ...base, tool: "a", denyTools: ["a"] }), { policy: "deny", reason: SERVER_DENY_REASON });
  assert.equal(serverDenial(["a"], "a"), SERVER_DENY_REASON);
  assert.equal(serverDenial(["a"], "b"), null);
});

test("resolvePolicy: a learning grant is only a default for a tool the agent does not list (C2)", () => {
  const base = { registryDefault: undefined, denyTools: [] as string[], scope: null, granted: ["recall"], approvedAlways: [] as string[], tool: "recall" };
  const listed = (policy?: "allow" | "ask" | "deny") => testAgentDefinition({ tools: [policy === undefined ? { name: "recall" } : { name: "recall", policy }] });
  assert.deepEqual(resolvePolicy({ ...base, definition: testAgentDefinition({ tools: [] }) }), { policy: "allow", reason: "granted by the learning context" });
  assert.deepEqual(resolvePolicy({ ...base, definition: listed("deny") }), { policy: "deny", reason: 'denied by agent policy "deny"' });
  assert.equal(resolvePolicy({ ...base, definition: listed("ask") }).policy, "ask");
  assert.equal(resolvePolicy({ ...base, definition: listed("ask"), approvedAlways: ["recall"] }).policy, "allow");
  assert.equal(resolvePolicy({ ...base, definition: listed(), registryDefault: "ask" }).policy, "ask");
  assert.deepEqual(resolvePolicy({ ...base, definition: listed("allow"), denyTools: ["recall"] }), { policy: "deny", reason: SERVER_DENY_REASON });
  const outside = resolvePolicy({ ...base, definition: listed("allow"), scope: new Set(["read_file"]) });
  assert.deepEqual(outside, { policy: "deny", reason: "not among the tools of this hand-off" });
  assert.equal(resolvePolicy({ ...base, definition: listed("allow"), scope: new Set(["recall"]) }).policy, "allow");
  assert.deepEqual(
    resolvePolicy({ ...base, definition: listed("allow"), denyTools: ["recall"], scope: new Set(["read_file"]) }),
    { policy: "deny", reason: SERVER_DENY_REASON }, "the server deny list is checked before the scope",
  );
});

/** Learning hooks that grant `tools` and do nothing after the run. */
function grantingHooks(tools: string[]): LearningHooks {
  return {
    prepare: async () => ({ promptSection: "", given: [], tools }),
    afterRun: async () => undefined,
  };
}

test("a learning grant does not beat the agent's explicit deny: recall is not offered and its call is denied", async (t) => {
  const calls: string[] = [];
  const seen: ModelRequest[] = [];
  const h = await createHarness(t, {
    models: plannedModels([[{ name: "recall" }]], seen), tools: [tool("recall", calls, { effect: "read" })], learning: grantingHooks(["recall"]),
  });
  const agent = await h.saveAgent({ learning: true, tools: [{ name: "recall", policy: "deny" }] });
  const run = await h.start(agent.id);
  const done = await h.until(run.id, "completed");
  assert.deepEqual(calls, [], "the handler was never invoked");
  assert.deepEqual(seen[0]?.tools.map((s) => s.name), [], "recall is not among the tool specs");
  const [finished] = await h.records(run.id, "tool.finished");
  assert.equal(finished?.outcome, "denied");
  assert.equal(finished?.content, 'tool "recall" was denied: denied by agent policy "deny"');
  assert.equal(done.usage.toolCalls, 0);
});

test("a learning grant does not skip the agent's ask: recall waits for approval and runs only after it", async (t) => {
  const calls: string[] = [];
  const h = await createHarness(t, {
    models: plannedModels([[{ name: "recall" }]]), tools: [tool("recall", calls, { effect: "read" })], learning: grantingHooks(["recall"]),
  });
  const agent = await h.saveAgent({ learning: true, tools: [{ name: "recall", policy: "ask" }] });
  const run = await h.start(agent.id);
  await h.until(run.id, "waiting");
  assert.deepEqual(calls, []);
  const [approval] = await h.pendings(run.id);
  assert.equal(approval?.kind, "approval");
  assert.deepEqual(approval?.detail, { tool: "recall", args: {} });
  await h.send(run.id, { type: "approve", pendingId: (approval as { id: string }).id, always: false });
  await h.until(run.id, "completed");
  assert.deepEqual(calls, ["recall"]);
});

test("toolPolicy answers as a call would; assumeGranted matters only for a tool the agent does not list", async (t) => {
  const calls: string[] = [];
  let answers: JsonObject = {};
  const driver: Driver = async (ctx) => {
    const narrowed = ctx.withTools(["free", "careful", "recall"]).withTools(["careful", "blocked"]);
    answers = {
      free: ctx.toolPolicy("free"), careful: ctx.toolPolicy("careful"), blocked: ctx.toolPolicy("blocked"),
      banned: ctx.toolPolicy("banned"), recall: ctx.toolPolicy("recall"),
      recallAssumed: ctx.toolPolicy("recall", { assumeGranted: true }),
      blockedAssumed: ctx.toolPolicy("blocked", { assumeGranted: true }),
      carefulAssumed: ctx.toolPolicy("careful", { assumeGranted: true }),
      bannedAssumed: ctx.toolPolicy("banned", { assumeGranted: true }),
      ghost: ctx.toolPolicy("ghost", { assumeGranted: true }),
      narrowedFree: narrowed.toolPolicy("free"), narrowedCareful: narrowed.toolPolicy("careful"),
      narrowedBlocked: narrowed.toolPolicy("blocked"), narrowedRecallAssumed: narrowed.toolPolicy("recall", { assumeGranted: true }),
      narrowedSpecs: narrowed.toolSpecs().map((s) => s.name),
    };
    return { text: "done" };
  };
  const h = await createHarness(t, {
    models: fakeModels(() => reply({})), drivers: { agent: driver }, engine: { denyTools: ["banned"] },
    tools: [tool("free", calls), tool("careful", calls), tool("blocked", calls), tool("banned", calls), tool("recall", calls)],
  });
  const agent = await h.saveAgent({
    tools: [{ name: "free" }, { name: "careful", policy: "ask" }, { name: "blocked", policy: "deny" }, { name: "banned", policy: "allow" }],
  });
  const run = await h.start(agent.id);
  await h.until(run.id, "completed");
  assert.deepEqual(answers, {
    free: "allow", careful: "ask", blocked: "deny", banned: "deny", recall: "deny",
    recallAssumed: "allow", blockedAssumed: "deny", carefulAssumed: "ask", bannedAssumed: "deny", ghost: "deny",
    narrowedFree: "deny", narrowedCareful: "ask", narrowedBlocked: "deny", narrowedRecallAssumed: "deny",
    narrowedSpecs: ["careful"],
  });
  assert.equal((await h.journal(run.id)).some((r) => r.type.startsWith("tool.")), false, "toolPolicy journals nothing");
});

test("withTools scopes nest by intersection: a call outside the intersection is denied and journalled", async (t) => {
  const calls: string[] = [];
  const driver: Driver = async (ctx) => {
    const narrowed = ctx.withTools(["a", "b"]).withTools(["b", "c"]);
    const results: JsonObject = {};
    for (const name of ["a", "b", "c"]) results[name] = (await narrowed.child("n").tool(name, { name, args: {} })).outcome;
    return results;
  };
  const h = await createHarness(t, {
    models: fakeModels(() => reply({})), drivers: { agent: driver }, tools: [tool("a", calls), tool("b", calls), tool("c", calls)],
  });
  const agent = await h.saveAgent({ tools: [{ name: "a" }, { name: "b" }, { name: "c" }] });
  const run = await h.start(agent.id);
  const done = await h.until(run.id, "completed");
  assert.deepEqual(done.output, { a: "denied", b: "ok", c: "denied" });
  assert.deepEqual(calls, ["b"]);
  const denied = (await h.records(run.id, "tool.finished")).filter((r) => r.outcome === "denied").map((r) => r.content);
  assert.deepEqual(denied, ['tool "a" was denied: not among the tools of this hand-off', 'tool "c" was denied: not among the tools of this hand-off']);
});

test("allow runs, deny and unlisted are refused, ask waits for approval; toolSpecs leaves out denied tools", async (t) => {
  const calls: string[] = [];
  const seen: ModelRequest[] = [];
  const h = await createHarness(t, {
    models: plannedModels([[{ name: "free" }, { name: "blocked" }, { name: "stranger" }, { name: "careful" }]], seen),
    tools: [tool("free", calls), tool("blocked", calls), tool("stranger", calls), tool("careful", calls), tool("banned", calls)],
    engine: { denyTools: ["banned"] },
  });
  const agent = await h.saveAgent({
    tools: [{ name: "free", policy: "allow" }, { name: "blocked", policy: "deny" }, { name: "careful", policy: "ask" }, { name: "banned", policy: "allow" }],
  });
  const run = await h.start(agent.id);
  await h.until(run.id, "waiting");
  assert.deepEqual(calls, ["free"]);
  const [approval] = await h.pendings(run.id);
  assert.equal(approval?.kind, "approval");
  assert.equal(approval?.title, "Approve careful: {}");
  assert.deepEqual(approval?.detail, { tool: "careful", args: {} });
  assert.deepEqual(seen[0]?.tools.map((s) => s.name), ["careful", "free"]);

  await h.send(run.id, { type: "approve", pendingId: (approval as { id: string }).id, always: false });
  const done = await h.until(run.id, "completed");
  assert.deepEqual(calls, ["free", "careful"]);
  const text = (done.output as { text: string }).text;
  assert.match(text, /free: free ok/);
  assert.match(text, /blocked: tool "blocked" was denied: denied by agent policy "deny"/);
  assert.match(text, /stranger: tool "stranger" was denied: not granted to this agent/);
  assert.match(text, /careful: careful ok/);
  const outcomes = (await h.records(run.id, "tool.finished")).map((r) => [r.tool, r.outcome, r.isError]);
  assert.deepEqual(outcomes, [["free", "ok", false], ["blocked", "denied", true], ["stranger", "denied", true], ["careful", "ok", false]]);
  assert.equal(done.usage.toolCalls, 2, "refused calls do not count against the budget");
});

test("the server deny list beats an agent allow", async (t) => {
  const calls: string[] = [];
  const h = await createHarness(t, { models: plannedModels([[{ name: "banned" }]]), tools: [tool("banned", calls)], engine: { denyTools: ["banned"] } });
  const agent = await h.saveAgent({ tools: [{ name: "banned", policy: "allow" }] });
  const run = await h.start(agent.id);
  const done = await h.until(run.id, "completed");
  assert.deepEqual(calls, []);
  assert.match((done.output as { text: string }).text, /denied by the server's deny list/);
});

test("a person's denial reaches the driver as the tool result", async (t) => {
  const calls: string[] = [];
  const h = await createHarness(t, { models: plannedModels([[{ name: "careful" }]]), tools: [tool("careful", calls)] });
  const agent = await h.saveAgent({ tools: [{ name: "careful", policy: "ask" }] });
  const run = await h.start(agent.id);
  await h.until(run.id, "waiting");
  const [approval] = await h.pendings(run.id);
  await h.send(run.id, { type: "deny", pendingId: (approval as { id: string }).id, reason: "too risky today" });
  const done = await h.until(run.id, "completed");
  assert.deepEqual(calls, []);
  assert.equal((done.output as { text: string }).text, 'careful: tool "careful" was denied: denied by a person: too risky today');
});

test("approve always skips later approvals for that tool in that run only", async (t) => {
  const calls: string[] = [];
  const h = await createHarness(t, {
    models: plannedModels([[{ name: "careful" }, { name: "careful" }], [{ name: "careful" }]]),
    tools: [tool("careful", calls)],
  });
  const agent = await h.saveAgent({ tools: [{ name: "careful", policy: "ask" }] });
  const run = await h.start(agent.id);
  await h.until(run.id, "waiting");
  const [approval] = await h.pendings(run.id);
  await h.send(run.id, { type: "approve", pendingId: (approval as { id: string }).id, always: true });
  await h.until(run.id, "completed");
  assert.deepEqual(calls, ["careful", "careful", "careful"]);
  assert.equal((await h.records(run.id, "pending.opened")).length, 1);

  const second = await h.start(agent.id);
  await h.until(second.id, "waiting");
  assert.equal((await h.pendings(second.id))[0]?.kind, "approval");
});

test("invalid arguments never reach the handler and the result names the paths", async (t) => {
  const calls: string[] = [];
  const h = await createHarness(t, {
    models: plannedModels([[{ name: "writer", args: { path: 5, extra: true } }]]),
    tools: [tool("writer", calls)],
  });
  const agent = await h.saveAgent({ tools: [{ name: "writer" }] });
  const run = await h.start(agent.id);
  const done = await h.until(run.id, "completed");
  assert.deepEqual(calls, []);
  const [finished] = await h.records(run.id, "tool.finished");
  assert.equal(finished?.outcome, "invalid_args");
  assert.equal(finished?.isError, true);
  assert.match(finished?.content ?? "", /\$\.path/);
  assert.match(finished?.content ?? "", /\$\.extra/);
  assert.equal(done.usage.toolCalls, 0);
});

test("an unknown tool is reported to the driver", async (t) => {
  const h = await createHarness(t, { models: plannedModels([[{ name: "ghost" }]]) });
  const agent = await h.saveAgent({ tools: [{ name: "ghost" }] });
  const run = await h.start(agent.id);
  const done = await h.until(run.id, "completed");
  assert.equal((done.output as { text: string }).text, 'ghost: unknown tool "ghost"');
});

// ---------------------------------------------------------------- the deny list on recovery (R01-08)

/** A tool whose first call hangs until aborted and whose later calls return at once; counts invocations. */
function hangingFirst(name: string, extra: Partial<ToolDefinition> = {}): { tool: ToolDefinition; calls: () => number } {
  let calls = 0;
  const tool: ToolDefinition = {
    name, description: name, parameters: { type: "object", properties: {} }, effect: "write",
    handler: async (_args, context) => {
      calls++;
      if (calls === 1) {
        await new Promise((_resolve, reject) => context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true }));
      }
      return { content: `${name} ran` };
    },
    ...extra,
  };
  return { tool, calls: () => calls };
}

/** Starts a run whose turn 1 calls `name`, waits until the handler runs, kills the runner and starts one with `name` denied. */
async function crashThenDeny(h: Harness, name: string, calls: () => number): Promise<string> {
  const agent = await h.saveAgent({ tools: [{ name }] });
  const run = await h.start(agent.id);
  await waitFor(() => calls() === 1);
  await h.runner.abandon();
  h.runner = h.newRunner({ denyTools: [name] });
  return run.id;
}

const deniedText = (name: string): string => `tool "${name}" was denied: ${SERVER_DENY_REASON}`;

test("deny list on recovery: an unfinished read call is not retried once the tool is denied", async (t) => {
  const read = hangingFirst("lookup", { effect: "read" });
  const h = await createHarness(t, { models: plannedModels([[{ name: "lookup" }]]), tools: [read.tool] });
  const runId = await crashThenDeny(h, "lookup", read.calls);
  const done = await h.until(runId, "completed");
  assert.equal(read.calls(), 1, "the handler was not invoked again");
  const [finished] = await h.records(runId, "tool.finished");
  assert.equal(finished?.outcome, "denied");
  assert.equal(finished?.content, deniedText("lookup"));
  assert.equal((done.output as { text: string }).text, `lookup: ${deniedText("lookup")}`);
});

test("deny list on recovery: a person's retry of an interrupted write is denied", async (t) => {
  const write = hangingFirst("deploy");
  const h = await createHarness(t, { models: plannedModels([[{ name: "deploy" }]]), tools: [write.tool] });
  const runId = await crashThenDeny(h, "deploy", write.calls);
  await h.until(runId, "waiting");
  const [pending] = await h.pendings(runId);
  assert.equal(pending?.kind, "interrupted");
  await h.send(runId, { type: "resolve_interrupted", pendingId: (pending as { id: string }).id, action: "retry", result: null });
  const done = await h.until(runId, "completed");
  assert.equal(write.calls(), 1);
  const [finished] = await h.records(runId, "tool.finished");
  assert.equal(finished?.outcome, "denied");
  assert.equal((done.output as { text: string }).text, `deploy: ${deniedText("deploy")}`);
  assert.deepEqual((await h.records(runId, "tool.started")).map((r) => r.attempt), [1], "no new attempt was started");
});

test("deny list on recovery: a resumable tool is not invoked again", async (t) => {
  const resumable = hangingFirst("pipeline", { resumable: true });
  const h = await createHarness(t, { models: plannedModels([[{ name: "pipeline" }]]), tools: [resumable.tool] });
  const runId = await crashThenDeny(h, "pipeline", resumable.calls);
  await h.until(runId, "completed");
  assert.equal(resumable.calls(), 1);
  const [finished] = await h.records(runId, "tool.finished");
  assert.equal(finished?.outcome, "denied");
});

test("deny list on recovery: a step that finished before the deny list changed keeps its result", async (t) => {
  const calls: string[] = [];
  let gate: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    gate = resolve;
  });
  const hold = hangingFirst("hold", { effect: "read" });
  const h = await createHarness(t, {
    models: plannedModels([[{ name: "lookup" }], [{ name: "hold" }]]),
    tools: [tool("lookup", calls, { effect: "read", handler: async () => {
      calls.push("lookup");
      gate();
      return { content: "lookup ok" };
    } }), hold.tool],
  });
  const agent = await h.saveAgent({ tools: [{ name: "lookup" }, { name: "hold" }] });
  const run = await h.start(agent.id);
  await opened;
  await waitFor(() => hold.calls() === 1);
  await h.runner.abandon();
  h.runner = h.newRunner({ denyTools: ["lookup"] });
  const done = await h.until(run.id, "completed");
  assert.deepEqual(calls, ["lookup"]);
  const outcomes = (await h.records(run.id, "tool.finished")).map((r) => [r.tool, r.outcome]);
  assert.deepEqual(outcomes, [["lookup", "ok"], ["hold", "ok"]]);
  assert.match((done.output as { text: string }).text, /lookup: lookup ok/);
});
