/**
 * Every operation of the API description has a CLI command (findings R09D-spec-06 and R09D-docs-03). The route ids
 * come from the test server's own `GET /v1/api`, so a new route without a row here fails the test. Each row is run
 * against the test server, and the requests the CLI makes are recorded through a wrapping `fetch`; the row passes
 * when one of them is the row's route.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { COMMANDS } from "../../src/cli/main.ts";
import type { ApiOperation } from "../../src/server/describe.ts";
import { cli } from "./support.ts";
import { buildWorld, type World } from "./world.ts";

/** Operations that are deliberately not commands (docs/cli.md says why). */
const EXCLUDED: Readonly<Record<string, string>> = {
  console: "the web console page itself",
  "hooks.receive": "a signed webhook delivery: its caller is the sender; `triggers fire` starts a run by hand",
};

interface Row { command: string; argv: (w: World) => string[] }

const ROWS: Readonly<Record<string, Row>> = {
  health: { command: "status", argv: () => [] },
  ready: { command: "status", argv: () => [] },
  "api.describe": { command: "api", argv: () => [] },
  "agents.list": { command: "agents list", argv: () => [] },
  "agents.create": { command: "agents save", argv: (w) => [w.files.agent] },
  "agents.put": { command: "agents save", argv: (w) => [w.files.agent, "--id", "put-agent"] },
  "agents.get": { command: "agents get", argv: (w) => [w.agentId] },
  "agents.revisions": { command: "agents revisions", argv: (w) => [w.agentId] },
  "agents.revision": { command: "agents get", argv: (w) => [w.agentId, "--revision", "1"] },
  "agents.learningMetrics": { command: "agents metrics", argv: (w) => [w.agentId] },
  "runs.create": { command: "runs start", argv: (w) => [w.agentId, "--revision", "1"] },
  "runs.list": { command: "runs list", argv: (w) => ["--trigger", w.triggerId] },
  "runs.get": { command: "runs get", argv: (w) => [w.done.id] },
  "runs.cancel": { command: "runs cancel", argv: (w) => [w.waiting.id] },
  "runs.pause": { command: "runs pause", argv: (w) => [w.waiting.id] },
  "runs.resume": { command: "runs resume", argv: (w) => [w.waiting.id] },
  "runs.message": { command: "runs message", argv: (w) => [w.waiting.id, "hello"] },
  "runs.limits": { command: "runs raise", argv: (w) => [w.waiting.id, "--max-turns", "40"] },
  "runs.timeline": { command: "runs timeline", argv: (w) => [w.done.id] },
  "runs.events": { command: "runs timeline", argv: (w) => [w.done.id, "--follow"] },
  "runs.files": { command: "runs files", argv: (w) => [w.done.id] },
  "runs.file": { command: "runs files", argv: (w) => [w.done.id, "greeting.txt"] },
  "runs.learning": { command: "runs learning", argv: (w) => [w.done.id] },
  "pendings.list": { command: "pendings list", argv: () => [] },
  "pendings.get": { command: "pendings get", argv: (w) => [w.question.id] },
  "pendings.answer": { command: "runs answer", argv: (w) => [w.waiting.id, "blue"] },
  "pendings.approve": { command: "runs approve", argv: (w) => [w.waiting.id] },
  "pendings.deny": { command: "runs deny", argv: (w) => [w.waiting.id] },
  "pendings.resolve": { command: "runs resolve", argv: (w) => [w.waiting.id, "--action", "retry"] },
  "workflows.validate": { command: "workflows validate", argv: (w) => [w.files.workflow] },
  "workflows.dryRun": { command: "workflows dry-run", argv: (w) => [w.files.workflow, "--input", '{"path": "a.txt"}'] },
  "workflows.graph": { command: "workflows graph", argv: (w) => [w.files.workflow] },
  "workflows.list": { command: "workflows list", argv: () => [] },
  "workflows.put": { command: "workflows save", argv: (w) => ["reader-copy", w.files.workflow] },
  "workflows.get": { command: "workflows get", argv: (w) => [w.workflowName] },
  "workflows.savedGraph": { command: "workflows graph", argv: (w) => ["--name", w.workflowName] },
  "learning.list": { command: "learning list", argv: () => [] },
  "learning.get": { command: "learning show", argv: (w) => [w.active.id] },
  "learning.history": { command: "learning history", argv: (w) => [w.active.id] },
  "learning.retire": { command: "learning retire", argv: (w) => [w.active.id] },
  "learning.restore": { command: "learning restore", argv: (w) => [w.active.id] },
  "learning.approve": { command: "learning approve", argv: (w) => [w.held.id] },
  "learning.edit": { command: "learning edit", argv: (w) => [w.active.id, "--title", "Printer"] },
  "usage.summary": { command: "usage", argv: () => ["--from", "2026-01-01"] },
  "secrets.list": { command: "secrets status", argv: () => [] },
  "secrets.get": { command: "secrets status", argv: () => ["MODEL_KEY"] },
  "secrets.put": { command: "secrets set", argv: () => ["OTHER_KEY", "--value", "another-value"] },
  "secrets.delete": { command: "secrets delete", argv: () => ["OTHER_KEY"] },
  "triggers.list": { command: "triggers list", argv: () => [] },
  "triggers.create": { command: "triggers create", argv: (w) => [w.files.trigger] },
  "triggers.get": { command: "triggers get", argv: (w) => [w.triggerId] },
  "triggers.update": { command: "triggers update", argv: (w) => [w.triggerId, w.files.triggerPatch] },
  "triggers.fire": { command: "triggers fire", argv: (w) => [w.triggerId] },
  "triggers.delete": { command: "triggers delete", argv: (w) => [w.triggerId] },
};

/** How many literal segments of `pattern` match `parts`, or null when the path does not match the pattern. */
function literalMatches(pattern: readonly string[], parts: readonly string[]): number | null {
  let literals = 0;
  for (let i = 0; i < pattern.length; i += 1) {
    const segment = pattern[i] as string;
    if (segment.startsWith("*")) return parts.length > i ? literals : null;
    if (i >= parts.length) return null;
    if (segment.startsWith(":")) continue;
    if (segment !== parts[i]) return null;
    literals += 1;
  }
  return pattern.length === parts.length ? literals : null;
}

/** The operation a request reached: the same method and a matching path; the most literal segments win. */
function routeOf(operations: readonly ApiOperation[], method: string, path: string): string | null {
  const parts = path.split("/").filter((p) => p !== "");
  let best: { id: string; literals: number } | null = null;
  for (const operation of operations) {
    if (operation.method !== method) continue;
    const literals = literalMatches(operation.path.split("/").filter((p) => p !== ""), parts);
    if (literals !== null && (best === null || literals > best.literals)) best = { id: operation.id, literals };
  }
  return best?.id ?? null;
}

test("every API operation maps to a command, and running that command reaches the operation", async (t) => {
  const w = await buildWorld(t);
  const operations = (await w.s.client.describeApi()).operations;
  const names = new Set(COMMANDS.map((c) => c.name));
  const ids = operations.map((o) => o.id);
  assert.deepEqual(ids.filter((id) => !Object.hasOwn(ROWS, id) && !Object.hasOwn(EXCLUDED, id)), [], "operations with no command");
  assert.deepEqual(Object.keys(ROWS).filter((id) => !ids.includes(id)), [], "rows for operations that do not exist");
  assert.deepEqual(Object.keys(EXCLUDED).filter((id) => !ids.includes(id)), [], "exclusions for operations that do not exist");
  assert.deepEqual([...new Set(Object.values(ROWS).map((r) => r.command))].filter((name) => !names.has(name)), [], "rows naming no command");

  const original = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const route = routeOf(operations, method, url.pathname);
    if (route !== null) seen.push(route);
    return original(input, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  for (const [id, row] of Object.entries(ROWS)) {
    seen.length = 0;
    const argv = [...row.command.split(" "), ...row.argv(w)];
    const result = await cli(argv, { dataDir: w.s.dir });
    assert.ok(seen.includes(id), `${argv.join(" ")} did not reach ${id} (it reached ${seen.join(", ")}; exit ${result.code}: ${result.stdout})`);
    if (id === "health" || id === "ready") {
      assert.equal(result.code, 0);
      const body = JSON.parse(result.stdout) as { health: { status: string }; ready: { status: string } };
      assert.deepEqual([body.health.status, body.ready.status], ["ok", "ready"], "status prints both answers");
    }
  }
});
