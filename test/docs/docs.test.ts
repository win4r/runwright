/**
 * The docs say what the code does: every API operation, CLI command, workflow node kind, validator code and run
 * state transition is documented; every relative link resolves; the README states the scope and the benchmark
 * caveats. The lists come from the code, so adding a route or a command without documenting it fails here.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../../src/app/app.ts";
import { COMMANDS } from "../../src/cli/main.ts";
import { createClient } from "../../src/client/index.ts";
import { loadConfig } from "../../src/config/load.ts";
import { TRANSITIONS } from "../../src/store/state-machine.ts";
import { NODE_KINDS, WORKFLOW_PROBLEM_CODES } from "../../src/workflow/types.ts";
import { makeTempDir } from "../helpers/tmp.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function doc(name: string): Promise<string> {
  return readFile(join(ROOT, name), "utf8");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("every operation of the API description is in docs/api.md", { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t, "runwright-docs-");
  const config = await loadConfig({ env: {}, overrides: { dataDir: join(dir, "data"), port: 0 } });
  const app = await createApp({ config, env: {}, logWrite: () => undefined });
  t.after(() => app.stop({ graceMs: 100 }));
  await app.start();
  const description = await createClient({ baseUrl: app.url, token: app.token }).describeApi();
  assert.ok(description.operations.length > 40, "the description lists the whole route table");
  const api = await doc("docs/api.md");
  const missing = description.operations
    .map((operation) => `${operation.method} ${operation.path.replace(/\/\*([A-Za-z]+)$/, "/<$1>")}`)
    .filter((route) => !api.includes(`\`${route}\``));
  assert.deepEqual(missing, [], "operations missing from docs/api.md");
});

test("every CLI command is in docs/cli.md", async () => {
  const cli = await doc("docs/cli.md");
  const missing = COMMANDS.map((command) => command.name)
    .filter((name) => !new RegExp(`runwright ${escapeRegExp(name)}(?![\\w-])`).test(cli));
  assert.deepEqual(missing, [], "commands missing from docs/cli.md");
});

test("each command's synopsis in docs/cli.md lists exactly the flags the command takes", async () => {
  const lines = (await doc("docs/cli.md")).split("\n");
  const problems: string[] = [];
  for (const command of COMMANDS) {
    const at = lines.findIndex((line) => new RegExp(`^runwright ${escapeRegExp(command.name)}(?![\\w-])`).test(line));
    let synopsis = lines[at] ?? "";
    for (let next = at + 1; lines[next]?.startsWith(" ") === true; next += 1) synopsis += lines[next];
    const documented = new Set([...synopsis.matchAll(/--([a-z][a-z-]*)/g)].map((match) => match[1]));
    for (const flag of Object.keys(command.flags)) if (!documented.has(flag)) problems.push(`${command.name}: --${flag} undocumented`);
    for (const flag of documented) if (flag !== undefined && !Object.hasOwn(command.flags, flag)) problems.push(`${command.name}: --${flag} does not exist`);
  }
  assert.deepEqual(problems, []);
});

test("every node kind and validator code is in docs/workflows.md", async () => {
  const workflows = await doc("docs/workflows.md");
  assert.deepEqual(NODE_KINDS.filter((kind) => !new RegExp(`^### .*\`${kind}\``, "m").test(workflows)), [], "node kinds without a section");
  assert.deepEqual(WORKFLOW_PROBLEM_CODES.filter((code) => !workflows.includes(`\`${code}\``)), []);
});

test("every legal run state transition is in docs/architecture.md", async () => {
  const architecture = await doc("docs/architecture.md");
  const rows = new Set<string>();
  for (const match of architecture.matchAll(/^\| `([a-z]+)` \| `([a-z]+)` \|/gm)) rows.add(`${match[1]}->${match[2]}`);
  const missing: string[] = [];
  for (const [from, targets] of Object.entries(TRANSITIONS)) {
    for (const to of targets) if (!rows.has(`${from}->${to}`)) missing.push(`${from}->${to}`);
  }
  assert.deepEqual(missing, [], "transitions missing from the state table in docs/architecture.md");
  assert.match(architecture, /\| \(none\) \| `queued` \|/);
});

test("every relative Markdown link in README.md and docs/ points at an existing file", async () => {
  const files = ["README.md", ...(await readdir(join(ROOT, "docs"))).filter((name) => name.endsWith(".md")).map((name) => `docs/${name}`)];
  const broken: string[] = [];
  for (const file of files) {
    const text = await doc(file);
    for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1] ?? "";
      if (/^[a-z]+:/i.test(target) || target.startsWith("#")) continue;
      const path = target.split("#")[0] ?? "";
      if (!existsSync(resolve(dirname(join(ROOT, file)), path))) broken.push(`${file}: ${target}`);
    }
  }
  assert.deepEqual(broken, []);
});

test("the README states the scope and the benchmark caveats", async () => {
  const readme = await doc("README.md");
  const out = readme.slice(readme.indexOf("**Deliberately out:**"));
  assert.ok(readme.includes("**Deliberately out:**"), "the README has an out-of-scope list");
  for (const item of [
    /Docker/, /cloud sandboxes/, /desktops/, /phones/, /hosted\s+browsers/, /agent harnesses/, /Postgres/, /MCP servers/,
    /OAuth sign-ins/, /GitHub-app triggers/, /hosted deployment\s+recipes/, /languages other than TypeScript/,
  ]) {
    assert.match(out, item);
  }
  assert.match(readme, /No head-to-head comparison with any other platform was run/);
  assert.match(readme, /Measured with `npm run bench` on the build machine/);
  assert.doesNotMatch(readme, /The integration step replaces this line/);
  assert.doesNotMatch(readme, /<machine line>/);
  const bench = /<!-- bench:begin -->([\s\S]*?)<!-- bench:end -->/.exec(readme);
  assert.ok(bench !== null, "the README keeps the bench markers");
  assert.match(bench[1] ?? "", /runs\/s|runs per second/i);
});
