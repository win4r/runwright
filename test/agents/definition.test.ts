import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_ID_PATTERN, agentDefinitionSchema, validateAgentDefinition } from "../../src/agents/definition.ts";
import { checkSchema } from "../../src/schema/validate.ts";

const valid = {
  name: "Writer",
  instructions: "Write files.",
  model: { provider: "scripted", name: "scripted-1", script: { turns: [{ text: "hi" }] } },
  tools: [{ name: "write_file" }, { name: "shell", policy: "ask" }],
  limits: { maxCostMicros: 1000, maxTurns: 5 },
  learning: false,
};

test("a valid definition has no problems and the schema is well formed", () => {
  assert.deepEqual(checkSchema(agentDefinitionSchema), []);
  assert.deepEqual(validateAgentDefinition(valid), []);
  assert.deepEqual(validateAgentDefinition({ ...valid, workflow: { format: "x" }, secrets: ["GITHUB_TOKEN"] }), []);
});

test("required fields, types and bounds are reported with paths", () => {
  const paths = (value: unknown): string[] => validateAgentDefinition(value).map((p) => p.path).sort();
  assert.deepEqual(paths({}), ["$.instructions", "$.learning", "$.limits", "$.model", "$.name", "$.tools"]);
  assert.deepEqual(paths({ ...valid, name: "" }), ["$.name"]);
  assert.deepEqual(paths({ ...valid, name: "x".repeat(121) }), ["$.name"]);
  assert.deepEqual(paths({ ...valid, model: { provider: "other", name: "m" } }), ["$.model.provider"]);
  assert.deepEqual(paths({ ...valid, model: { provider: "scripted" } }), ["$.model.name"]);
  assert.deepEqual(paths({ ...valid, tools: [{ name: "Bad-Name" }, { name: "ok", policy: "maybe" }] }), ["$.tools[0].name", "$.tools[1].policy"]);
  assert.deepEqual(paths({ ...valid, limits: { maxTurns: -1, maxToolCalls: 1.5 } }), ["$.limits.maxToolCalls", "$.limits.maxTurns"]);
  assert.deepEqual(paths({ ...valid, learning: "yes" }), ["$.learning"]);
  assert.deepEqual(paths({ ...valid, workflow: [] }), ["$.workflow"]);
  assert.deepEqual(paths({ ...valid, secrets: ["lower"] }), ["$.secrets[0]"]);
  assert.deepEqual(paths({ ...valid, extra: 1 }), ["$.extra"]);
  assert.deepEqual(paths("nope"), ["$"]);
});

test("duplicate tool names are reported", () => {
  const problems = validateAgentDefinition({ ...valid, tools: [{ name: "read_file" }, { name: "read_file", policy: "deny" }] });
  assert.equal(problems.length, 1);
  assert.equal(problems[0]?.path, "$.tools[1].name");
  assert.match(problems[0]!.message, /read_file/);
});

test("AGENT_ID_PATTERN", () => {
  for (const ok of ["a", "writer", "my-agent_2", "0abc"]) assert.match(ok, AGENT_ID_PATTERN);
  for (const bad of ["", "-a", "A", "a b", "x".repeat(65)]) assert.doesNotMatch(bad, AGENT_ID_PATTERN);
});

// ---- The model object is closed and the scripted script is validated in full (R13D-docs-02) ----

const withModel = (model: unknown): unknown => ({ ...valid, model });
const scripted = (script: unknown): unknown => withModel({ provider: "scripted", name: "scripted-1", script });
const problemPaths = (value: unknown): string[] => validateAgentDefinition(value).map((p) => p.path).sort();

test("an unknown key in model is reported at its path", () => {
  assert.deepEqual(problemPaths(withModel({ provider: "openai-compatible", name: "m", maxOutputToken: 100 })), ["$.model.maxOutputToken"]);
  assert.deepEqual(problemPaths(withModel({
    provider: "openai-compatible", name: "m", baseUrl: "http://localhost:1/v1", apiKeySecret: "MY_KEY", maxOutputTokens: 5, contextTokens: 9,
  })), []);
});

test("a variant without when is reported at the variant, and when is closed", () => {
  assert.deepEqual(problemPaths(scripted({ variants: [{}] })), ["$.model.script.variants[0].when"]);
  assert.match(validateAgentDefinition(scripted({ variants: [{}] }))[0]?.message ?? "", /missing required property "when"/);
  assert.deepEqual(problemPaths(scripted({ variants: [{ when: {} }] })), ["$.model.script.variants[0].when.contains"]);
  assert.deepEqual(problemPaths(scripted({ variants: [{ when: { contains: "x", in: "body" } }] })), ["$.model.script.variants[0].when.in"]);
  assert.deepEqual(problemPaths(scripted({ variants: [{ when: { contains: "x", inside: "any" } }] })), ["$.model.script.variants[0].when.inside"]);
  assert.deepEqual(problemPaths(scripted({ variants: [{ when: { contains: "x" }, turn: [] }] })), ["$.model.script.variants[0].turn"]);
  assert.deepEqual(problemPaths(scripted({ turn: [] })), ["$.model.script.turn"]);
});

test("unknown keys in a turn, in fail, in usage and in a tool call are reported with their paths", () => {
  assert.deepEqual(problemPaths(scripted({ turns: [{ txt: "hi" }] })), ["$.model.script.turns[0].txt"]);
  assert.deepEqual(problemPaths(scripted({ turns: [{ fail: { attempts: 1, code: 503 } }] })), ["$.model.script.turns[0].fail.code"]);
  assert.deepEqual(problemPaths(scripted({ turns: [{ fail: { status: 503 } }] })), ["$.model.script.turns[0].fail.attempts"]);
  assert.deepEqual(problemPaths(scripted({ turns: [{ usage: { inputTokens: 1, input: 2 } }] })), ["$.model.script.turns[0].usage.input"]);
  assert.deepEqual(problemPaths(scripted({ turns: [{ toolCalls: [{ name: "x", args: {}, arguments: {} }] }] })), ["$.model.script.turns[0].toolCalls[0].arguments"]);
  assert.deepEqual(problemPaths(scripted({ turns: [{ toolCalls: [{ name: "x" }] }] })), ["$.model.script.turns[0].toolCalls[0].args"]);
  assert.deepEqual(problemPaths(scripted({ turns: [{ toolCalls: [{ name: "", args: {} }] }] })), ["$.model.script.turns[0].toolCalls[0].name"]);
  assert.deepEqual(problemPaths(scripted({ turns: [{ text: 3, chunks: 0, fail: { attempts: 1, billing: "maybe", network: "yes" } }] })), [
    "$.model.script.turns[0].chunks", "$.model.script.turns[0].fail.billing", "$.model.script.turns[0].fail.network", "$.model.script.turns[0].text",
  ]);
  assert.deepEqual(problemPaths(scripted({ steps: { classify: { txt: "x" } } })), ["$.model.script.steps.classify.txt"]);
  assert.deepEqual(problemPaths(scripted({ steps: { classify: [{ text: "ok" }, { txt: "x" }] } })), ["$.model.script.steps.classify[1].txt"]);
  assert.deepEqual(problemPaths(scripted({ steps: { classify: "text" } })), ["$.model.script.steps.classify"]);
  assert.deepEqual(problemPaths(scripted({ variants: [{ when: { contains: "a" }, steps: { s: { fail: { attempts: 1, x: 1 } } } }] })), [
    "$.model.script.variants[0].steps.s.fail.x",
  ]);
});

test("a tool call's args and a turn's output accept arbitrary JSON; a full script validates", () => {
  const anything = { nested: { deep: [1, "two", null, { three: true }] }, "odd key": -1.5 };
  assert.deepEqual(problemPaths(scripted({
    turns: [
      { text: "a", toolCalls: [{ name: "write_file", args: anything, id: "c1" }], usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      { output: anything, delayMs: 10, chunks: 3 },
      { output: [1, 2], fail: { attempts: 2, status: 503, network: false, retryAfterMs: 5, message: "busy", billing: "unknown" } },
      { output: "text" },
    ],
    steps: { pick: { output: null }, many: [{ text: "x" }, { output: 3 }] },
    variants: [{ when: { contains: "x", in: "messages" }, turns: [{ text: "v" }], steps: { pick: { text: "y" } } }],
  })), []);
  assert.deepEqual(problemPaths(scripted({ turns: [{ toolCalls: [{ name: "x", args: [] }] }] })), ["$.model.script.turns[0].toolCalls[0].args"]);
});

test("every agent.json under examples/ validates", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const root = join(import.meta.dirname, "..", "..", "examples");
  let checked = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(root, entry.name, "agent.json");
    const text = await readFile(file, "utf8").catch(() => null);
    if (text === null) continue;
    const parsed = JSON.parse(text) as { definition?: unknown };
    assert.deepEqual(validateAgentDefinition(parsed.definition ?? parsed), [], file);
    checked += 1;
  }
  assert.ok(checked >= 3, `checked ${checked} examples`);
});

/** Every object node of `schema` with its schema path. */
function objectNodes(schema: unknown, path: string, out: { path: string; node: Record<string, unknown> }[]): void {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return;
  const node = schema as Record<string, unknown>;
  const types = Array.isArray(node["type"]) ? node["type"] : [node["type"]];
  if (types.includes("object")) out.push({ path, node });
  const properties = node["properties"];
  if (properties !== null && typeof properties === "object") {
    for (const [key, value] of Object.entries(properties)) objectNodes(value, `${path}.properties.${key}`, out);
  }
  if (typeof node["additionalProperties"] === "object") objectNodes(node["additionalProperties"], `${path}.additionalProperties`, out);
  if (node["items"] !== undefined) objectNodes(node["items"], `${path}.items`, out);
  for (const keyword of ["anyOf", "oneOf", "allOf"]) {
    const list = node[keyword];
    if (Array.isArray(list)) list.forEach((item, index) => objectNodes(item, `${path}.${keyword}[${index}]`, out));
  }
}

/** The intentionally open payloads: a scripted tool call's args, and the embedded workflow document. */
const OPEN_PAYLOADS: readonly RegExp[] = [/\.toolCalls\.items\.properties\.args$/, /^definition\.properties\.workflow$/];

test("schema walk: every object node is closed, a map with a value schema, or an allow-listed open payload", async () => {
  const { configSchema } = await import("../../src/config/load.ts");
  const nodes: { path: string; node: Record<string, unknown> }[] = [];
  objectNodes(agentDefinitionSchema, "definition", nodes);
  objectNodes(configSchema, "config", nodes);
  assert.ok(nodes.length > 30, String(nodes.length));
  const open = nodes.filter(({ path, node }) => {
    const extra = node["additionalProperties"];
    if (extra === false || (extra !== null && typeof extra === "object")) return false;
    return !OPEN_PAYLOADS.some((pattern) => pattern.test(path));
  }).map(({ path }) => path);
  assert.deepEqual(open, []);
  const allowed = nodes.filter(({ path }) => OPEN_PAYLOADS.some((pattern) => pattern.test(path))).map(({ path }) => path);
  assert.ok(allowed.some((path) => path.endsWith(".args")) && allowed.includes("definition.properties.workflow"), JSON.stringify(allowed));
  assert.ok(nodes.some(({ path }) => path.startsWith("config.properties.learning.properties.graderModel.properties.script")));
});
