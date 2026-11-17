/**
 * The contract sentences of round 14 in README.md and docs/, each checked against the code that backs it:
 * the policy order and its reasons (C2), the hand-off scope (C3), rule T and rule S of learning, the forced exit
 * (C7), the complete listings and the files page bounds (C8), saturating totals (C9) and the SSE drain timeout.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { AgentDefinition } from "../../src/agents/definition.ts";
import {
  LEARNING_GRANT_REASON, SCOPE_DENY_REASON, SERVER_DENY_REASON, UNGRANTED_REASON, resolvePolicy, type PolicyInput,
} from "../../src/engine/policy.ts";
import { startTestServer } from "../server/support.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function doc(name: string): Promise<string> {
  return readFile(join(ROOT, name), "utf8");
}

/** The text of a `## heading` section, up to the next `## ` heading. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n## ${heading}\n`);
  assert.ok(start >= 0, `section "${heading}" exists`);
  const end = text.indexOf("\n## ", start + 1);
  return text.slice(start, end === -1 ? undefined : end);
}

/** Markdown wraps lines; compare with every run of whitespace as one space. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

function definition(tools: AgentDefinition["tools"]): AgentDefinition {
  return { name: "Docs", instructions: "", model: { provider: "scripted", name: "scripted-1" }, tools, limits: {}, learning: true };
}

function policy(overrides: Partial<PolicyInput>): ReturnType<typeof resolvePolicy> {
  return resolvePolicy({
    tool: "recall", definition: definition([]), registryDefault: undefined, denyTools: [], scope: null, granted: ["recall"],
    approvedAlways: [], ...overrides,
  });
}

test("the policy order of the README, security.md and architecture.md is the order resolvePolicy applies", async () => {
  const readme = flat(section(await doc("docs/reference.md"), "Control and cost"));
  assert.match(readme, /\(1\) a tool on the server's deny list \(`tools\.deny`\) is denied; \(2\) inside an `agent` hand-off with `tools`, a tool outside that subset is denied; \(3\) a tool the agent lists gets the agent's policy for it, else the tool's own default \(`shell` defaults to `ask`\), else `allow`, and `ask` becomes `allow` once a person approved it "always" for the run, for a call that has no approval of its own; \(4\) a tool the agent does not list but the learning context grants \(`recall`\) is allowed; \(5\) any other tool is denied/);
  assert.match(readme, /A call whose own approval was resolved is decided by that resolution: a call already denied stays denied, whatever is approved later\. "Approve always" approves that call, also approves, in the same commit, every other call of that tool that is waiting for approval in the run \(one whose approval had not expired when the command was sent\), and makes the tool `allow` for the run's later calls\./);
  const security = flat(section(await doc("docs/security.md"), "Tool policy"));
  assert.match(security, /for a call that has no approval of its own \(a call whose own approval was denied stays denied, and "approve always" also approves the tool's other open approvals in the run that had not expired, in the same commit\)/);
  assert.match(security, /1\. the server-level deny list .* 2\. inside an `agent` hand-off with `tools`, a tool outside that subset → `deny`.* 3\. the agent's own entry for the tool .* 4\. a tool the agent does not list that the learning context grants \(`recall`\) → `allow`.* 5\. any other tool → `deny`/);
  const architecture = flat(section(await doc("docs/architecture.md"), "Policy, caps and budgets"));
  for (const reason of [SERVER_DENY_REASON, SCOPE_DENY_REASON, LEARNING_GRANT_REASON, UNGRANTED_REASON]) {
    assert.ok(architecture.includes(reason), `architecture.md quotes "${reason}"`);
  }

  // Each step, in order: an earlier step wins over every later one.
  const scope = new Set(["read_file"]);
  assert.deepEqual(policy({ denyTools: ["recall"], scope, definition: definition([{ name: "recall", policy: "allow" }]) }),
    { policy: "deny", reason: SERVER_DENY_REASON });
  assert.deepEqual(policy({ scope, definition: definition([{ name: "recall", policy: "allow" }]) }), { policy: "deny", reason: SCOPE_DENY_REASON });
  assert.equal(policy({ definition: definition([{ name: "recall", policy: "deny" }]) }).policy, "deny");
  assert.equal(policy({ definition: definition([{ name: "recall", policy: "ask" }]) }).policy, "ask");
  assert.equal(policy({ definition: definition([{ name: "recall", policy: "ask" }]), approvedAlways: ["recall"] }).policy, "allow");
  assert.equal(policy({ tool: "shell", granted: [], definition: definition([{ name: "shell" }]), registryDefault: "ask" }).policy, "ask");
  assert.deepEqual(policy({}), { policy: "allow", reason: LEARNING_GRANT_REASON });
  assert.deepEqual(policy({ granted: [] }), { policy: "deny", reason: UNGRANTED_REASON });
});

test("the README states rule T, rule S2, the hand-off scope and the forced exit as docs/ and the code have them", async () => {
  const readme = await doc("README.md");
  const fits = flat(section(await doc("docs/reference.md"), "How it fits together"));
  assert.match(fits, /in a run that read untrusted content \(or was started by a webhook\) every other item is \*\*held for a person\*\* whenever the journal cannot prove that the item's text is the run's own earlier text \(journalled before the first untrusted record\) or a person's/);
  assert.match(fits, /when they do not all fit whole but one line for every item fits, every item is given, at least as its line, and in order of BM25 relevance to the run's first message each item is given whole instead when the difference still fits; only when even the lines do not all fit are items taken in relevance order, each whole if it fits, otherwise as one line if that fits, otherwise left out/);
  assert.match(fits, /An `agent` hand-off's `tools` is enforced on every call made inside the hand-off \(by its loop, by a workflow it starts with `run_workflow`, by a nested hand-off\)/);
  const learning = flat((await doc("docs/learning.md")).replace(/^> ?/gm, ""));
  assert.match(learning, /Every other item of a tainted run is \*\*held for a person\*\* unless the journal proves where its text came from/);
  assert.match(learning, /an item is given whole if it still fits in what is left of the budget, otherwise as one line if the line fits, otherwise it is left out/);
  assert.match(flat(await doc("docs/workflows.md")), /a call to any other tool made inside the hand-off — by the loop itself, by a workflow it starts with `run_workflow`, or by a nested hand-off — is refused/);

  assert.match(flat(section(readme, "Quickstart")), /A second signal \(a second Ctrl-C\) ends the process at once with exit code 1/);
  assert.match(flat(await doc("docs/cli.md")), /then ends the process immediately with exit code 1/);
  const host = await readFile(join(ROOT, "src/cli/commands/host.ts"), "utf8");
  assert.ok(host.includes("ctx.io.exit?.(1)"), "hostApp ends the process with 1 on the second signal");
  assert.match(await readFile(join(ROOT, "bin/runwright.ts"), "utf8"), /await main\(process\.argv\.slice\(2\), processIo\(\)\)/);
  assert.match(await readFile(join(ROOT, "src/cli/main.ts"), "utf8"), /\n\s+exit: process\.exit,\n/, "the real process's io passes process.exit");
});

test("usage totals saturate at Number.MAX_SAFE_INTEGER as the README, configuration.md and architecture.md say", async () => {
  assert.equal(Number.MAX_SAFE_INTEGER, 2 ** 53 - 1);
  assert.match(flat(section(await doc("docs/reference.md"), "Control and cost")),
    /\*\*Totals saturate\.\*\* Every stored or reported total of tokens, cost micros, tool calls and turns .* is an integer from 0 to 2\^53 − 1 \(`Number\.MAX_SAFE_INTEGER`\); an addition that would pass it yields exactly that value/);
  assert.ok(flat(await doc("docs/configuration.md")).includes(`is an integer from 0 to ${Number.MAX_SAFE_INTEGER}`));
  assert.match(flat(await doc("docs/architecture.md")), /integer from 0 to 2\^53 − 1 \(`Number\.MAX_SAFE_INTEGER`\), in the replay state as in the store/);
});

test("the files page bounds and the complete pendings of the docs are the route's, and the route holds to them", async (t) => {
  const s = await startTestServer(t);
  const { operations } = await s.client.describeApi();
  const files = operations.find((o) => o.id === "runs.files");
  assert.equal(files?.query["limit"], "1-1000, default 200");
  assert.match(operations.find((o) => o.id === "runs.get")?.response ?? "", /all open pendings of the run/);
  const api = flat(await doc("docs/api.md"));
  assert.match(api, /`GET \/v1\/runs\/:id\/files` is paged the same way with its own bounds: `limit` 1–1000, default 200/);
  assert.match(api, /`\{run, pendings\}`: every open pending of the run, oldest first/);
  assert.match(flat(section(await doc("docs/reference.md"), "How it fits together")),
    /A run's detail \(`GET \/v1\/runs\/:id`, `runwright runs get`\) lists every open pending of that run, however many there are.* A run's file listing \(`GET \/v1\/runs\/:id\/files`\) is paged by path \(`limit` 1 to 1 000, default 200, and a `cursor`\); the client and `runwright runs files <run>` follow the pages and return every file/);

  const { run } = await s.store.createRun({ agentId: (await s.store.saveAgent({ id: "docs", definition: definition([]) })).agent.id, input: { message: "", data: null } });
  const status = async (limit: string): Promise<number> =>
    (await fetch(`${s.url}/v1/runs/${run.id}/files?limit=${limit}`, { headers: { authorization: `Bearer ${s.token}` } })).status;
  assert.equal(await status("1000"), 200);
  assert.equal(await status("1"), 200);
  assert.equal(await status("1001"), 400);
  assert.equal(await status("0"), 400);
});

test("the SSE drain timeout the API docs give is the hub's default", async () => {
  const sse = await readFile(join(ROOT, "src/server/sse.ts"), "utf8");
  const match = /const DEFAULT_DRAIN_TIMEOUT_MS = ([\d_]+);/.exec(sse);
  assert.ok(match !== null);
  const seconds = Number((match[1] as string).replaceAll("_", "")) / 1000;
  assert.ok(flat(await doc("docs/api.md")).includes(`A client whose buffer stays full for ${seconds} s is disconnected as too slow`));
});

test("security.md states the policy order, rule T and the file-tool queue with its limit", async () => {
  const security = flat(await doc("docs/security.md"));
  assert.match(security, /rule T holds for a person every other item of a run that read untrusted content \(or was started by a webhook\) unless each of its texts occurs in a \*trusted text\*/);
  assert.match(security, /A paraphrase of a page is therefore held, not kept/);
  assert.match(security, /\*\*Mutations of one workspace are serialised\.\*\* Inside one runner process, `write_file`, `edit_file` and `delete_file` share one queue per workspace/);
  assert.match(security, /`shell` and host tools are outside this queue/);
  const fs = await readFile(join(ROOT, "src/tools/fs.ts"), "utf8");
  assert.match(fs, /writeFileTool\(options, oneAtATime\), editFileTool\(options, oneAtATime\), listFilesTool\(\),\s*deleteFileTool\(options, oneAtATime\)/,
    "the three mutating tools share the one queue");
});
