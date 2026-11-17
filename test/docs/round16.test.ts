/**
 * The contract sentences of round 16 in README.md and docs/, each checked against the code that backs it: what a
 * reply is charged (rule U), approve-always, the `needed` of a count limit, limits that cannot be removed, rule F,
 * command order (migration 8), well-formed idempotency keys, the revision a trigger's run pins, wordless text and
 * stale drafts in learning, the dry run's rule A and the `embedded` option, the reply size limit, the archive page
 * and the CLI's paging.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../../src/app/app.ts";
import { COMMANDS } from "../../src/cli/main.ts";
import { createClient } from "../../src/client/index.ts";
import { loadConfig } from "../../src/config/load.ts";
import { RunwrightError } from "../../src/core/errors.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import { checkCount } from "../../src/engine/budget.ts";
import { MAX_REPLY_BYTES } from "../../src/models/sse-parse.ts";
import { JOURNAL_PAGE } from "../../src/ops/retention.ts";
import { idempotencyDigest } from "../../src/store/idempotency.ts";
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from "../../src/store/migrations.ts";
import { STAGE_DIR } from "../../src/tools/workspace-stage.ts";
import { makeTempDir } from "../helpers/tmp.ts";

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

/** Markdown with every run of white space collapsed to one space, so a sentence can be matched across line breaks. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

test("the README charges a reply its reported usage and a missing count its bound, never an estimate (rule U)", async () => {
  const readme = flat(section(await doc("docs/reference.md"), "Control and cost"));
  assert.match(readme, /\*\*What a reply is charged\.\*\* The usage the provider reported, priced\. A count the provider did not report .* is charged the bound the attempt was reserved with: the worst case's input tokens for a missing input count, `maxOutputTokens` for a missing output count\. It is recorded as assumed \(`usageAssumed` on the journal record, `assumed: true` on the usage row\)/);
  assert.match(readme, /retries included, and whether or not the provider reports its usage/);
  const everything = flat(`${await doc("README.md")} ${await doc("docs/architecture.md")} ${await doc("src/engine/budget.ts")}`);
  assert.doesNotMatch(everything, /bytes ?\/ ?4|visible (output|text)/i, "no text describes the old estimate of a reply without usage");
  const journalTypes = await doc("src/engine/journal-types.ts");
  assert.match(journalTypes, /usageAssumed/, "the journal record field the docs name exists");
});

test("a count limit's needed is what must be added, as the README's example says", async () => {
  const readme = flat(section(await doc("docs/reference.md"), "Control and cost"));
  assert.match(readme, /`needed = max\(1, used \+ 1 − limit\)` is exactly what must be added to the limit for the next call to go \(after five tool calls with the budget lowered to 2, `needed` is 4\)/);
  assert.doesNotMatch(readme, /needed: 1\b/);
  const pause = checkCount(2, 5);
  assert.equal(pause.ok, false);
  assert.equal(pause.ok ? null : pause.detail["needed"], 4);
  assert.equal(checkCount(2 + 4, 5).ok, true, "raising by exactly needed admits the next call");
  assert.equal(checkCount(2 + 3, 5).ok, false, "raising by less does not");
  const atLimit = checkCount(3, 3);
  assert.equal(atLimit.ok ? null : atLimit.detail["needed"], 1);
  assert.match(readme, /A limit can be changed over the API but not removed\./);
  assert.match(flat(await doc("docs/api.md")), /A limit cannot be removed over the API, only changed: `null` \(or any other value\) is 400 `validation_failed`/);
});

test("rule F is stated in the README with the stage folder the code uses, and shell is named as outside it", async () => {
  const fits = flat(section(await doc("docs/reference.md"), "How it fits together"));
  assert.equal(STAGE_DIR, ".runwright/stage");
  assert.ok(fits.includes(`one \`rename\` or \`link\` through \`${STAGE_DIR}/<epoch>\``), fits);
  assert.match(fits, /a zombie's late file write fails with `lease_lost` however late it wakes up\. The one effect that is not staged is the creation of a write's missing parent directories, so a fenced writer can leave empty directories behind, never content\. `shell` and host tools are outside rule F/);
  assert.match(flat(section(await doc("docs/reference.md"), "Security notes")), /\*\*Fencing\.\*\* The store rejects every journal append and state change of a runner that lost its lease, and the built-in file tools and saved tool results cannot be changed by such a runner after its successor claimed the run/);
  assert.match(flat(await doc("docs/security.md")), /The one effect that is not staged is the creation of a write's missing parent directories/);
  assert.doesNotMatch(fits, /cannot write anything/, "the store alone does not fence everything a zombie does");
});

test("commands are applied in arrival order (migration 8) and idempotency keys must be well-formed Unicode", async () => {
  const fits = flat(section(await doc("docs/reference.md"), "How it fits together"));
  assert.match(fits, /are applied in arrival order, the order in which their inserts committed \(`commands\.seq`\)/);
  assert.equal(MIGRATIONS.find((m) => m.version === 8)?.name, "command-seq");
  assert.equal(LATEST_SCHEMA_VERSION, 8);
  assert.match(fits, /a key must be well-formed Unicode \(one with an unpaired surrogate is 400 `bad_request`\)/);
  assert.match(flat(await doc("docs/api.md")), /A key that holds an unpaired surrogate \(in JSON, a lone `\\ud800` escape\) is refused with 400 `bad_request`/);
  assert.throws(() => idempotencyDigest("k-\ud800"), (error: unknown) => error instanceof RunwrightError && error.code === "bad_request");
  assert.match(idempotencyDigest("k-😀"), /^sha256:[0-9a-f]{64}$/, "a paired surrogate is one code point and is accepted");
});

test("a trigger's run pins the revision current when the fire was prepared, in the README and architecture.md", async () => {
  assert.match(flat(section(await doc("docs/reference.md"), "How it fits together")),
    /A run started by a trigger pins the agent revision that was current when the fire was prepared, the one its input was redacted against\./);
  assert.match(flat(section(await doc("docs/architecture.md"), "Triggers")),
    /It pins the agent revision that was current when the fire was prepared: the store wrapper reads that revision, redacts the run's input against its secrets and passes it as `run\.revision`/);
  const redaction = await doc("src/security/write-redaction.ts");
  assert.match(redaction, /run: \{ \.\.\.input\.run, input: runInput, requestFingerprint: fingerprint, revision: revision\.revision \}/);
});

test("learning's wordless text and stale drafts are stated with the default the config has", async () => {
  const fits = flat(section(await doc("docs/reference.md"), "How it fits together"));
  assert.match(fits, /Text without words \(only symbols and punctuation, such as `---`\) is judged on its characters/);
  const promoteAfter = defaultConfig("/data").learning.promoteAfterRuns;
  assert.ok(fits.includes(`\`learning.promoteAfterRuns\` completed runs (${promoteAfter} by default)`), fits);
  assert.match(fits, /an attempt counts only against the skill version it was drafted from, so a draft made stale by an edit of the skill uses up no attempt/);
  assert.match(flat(await doc("docs/learning.md")), /An attempt, kept or rejected, counts only against the skill version it was drafted from/);
});

test("the README states the dry run's rule A, the unknown numeric segment, `embedded` and the node backoff after a restart", async () => {
  const fits = flat(section(await doc("docs/reference.md"), "How it fits together"));
  assert.match(fits, /a `map` over a list the schema guarantees to have an item runs its body for certain/);
  assert.match(fits, /A numeric path segment into a value whose schema allows both an array and an object is not statically typed/);
  assert.match(fits, /`validate`, `dry-run` and `graph` take `embedded: true` \(`--embedded` in the CLI\)/);
  assert.match(fits, /after a restart or a resume it waits only what is left of it/);
  const workflows = flat(await doc("docs/workflows.md"));
  assert.match(workflows, /\*\*Rule A: assumed paths\.\*\*/);
  assert.match(workflows, /So after a restart or a resume, a node waits only what is left of its/);
  const cli = await doc("src/cli/commands/workflows.ts");
  assert.match(cli, /embedded/);
});

test("the reply size limit and the archive page are the code's constants", async () => {
  assert.equal(MAX_REPLY_BYTES, 64 * 1024 * 1024);
  const architecture = flat(await doc("docs/architecture.md"));
  assert.match(architecture, /\*\*One size limit per reply\.\*\* The Anthropic and OpenAI-compatible adapters read at most 64 MiB \(`MAX_REPLY_BYTES`, `src\/models\/sse-parse\.ts`\) of one response body, whether it is streamed or one JSON document/);
  assert.match(flat(section(await doc("README.md"), "Scope")), /one size limit per provider reply \(64 MiB, streamed or not\)/);
  const retention = flat(section(await doc("docs/architecture.md"), "Retention and archival"));
  assert.ok(retention.includes(`stream the journal, one page of ${JOURNAL_PAGE} records (\`JOURNAL_PAGE\`) at a time`), retention);
  assert.ok(retention.includes(`so it costs at most ${JOURNAL_PAGE} times the journal's largest record`), retention);
  assert.match(retention, /one record serialized at a time/);
  assert.doesNotMatch(retention, /1 000 records/);
});

test("the README says which CLI listings page and that runs timeline prints page by page", async () => {
  const quickstart = flat(section(await doc("README.md"), "Quickstart"));
  assert.match(quickstart, /`runs list` and `pendings list` print one page and the cursor of the next \(`--cursor`\); `runs timeline` prints the journal page by page as it reads it/);
  const runs = await doc("src/cli/commands/runs.ts");
  const admin = await doc("src/cli/commands/admin.ts");
  for (const source of [runs, admin]) assert.match(source, /cursor: \{ value: "c", description: "the next page, from a previous listing" \}/);
  assert.match(quickstart, /A client command waits up to 5 s \(`--connect-timeout`\) for a server that is still starting/);
  assert.match(await doc("src/cli/context.ts"), /const DEFAULT_CONNECT_TIMEOUT_MS = 5000;/);
});

/** The value at a dotted path of an object, or undefined. */
function at(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

test("every default in the key table of docs/configuration.md is the value src/config/defaults.ts has", async () => {
  const table = section(await doc("docs/configuration.md"), "Keys and defaults");
  const rows = [...table.matchAll(/^\| `([A-Za-z.]+)` \| `([^`]*)` \|/gm)].map((m) => ({ key: m[1] as string, text: m[2] as string }));
  assert.ok(rows.length > 40, `the table was read (${rows.length} rows)`);
  const config = defaultConfig("/data");
  const problems: string[] = [];
  for (const { key, text } of rows) {
    if (key === "dataDir") {
      if (text !== "~/.runwright") problems.push(`dataDir: ${text}`);
      continue;
    }
    const actual = at(config, key);
    if (actual === undefined) problems.push(`${key}: not a key of the defaults`);
    else assert.deepEqual([key, JSON.parse(text)], [key, actual]);
  }
  assert.deepEqual(problems, []);
  const keys = new Set(rows.map((row) => row.key));
  const leaves: string[] = [];
  const walk = (value: unknown, path: string): void => {
    if (value !== null && typeof value === "object" && !Array.isArray(value) && !["models.prices"].includes(path)) {
      for (const [name, child] of Object.entries(value)) walk(child, path === "" ? name : `${path}.${name}`);
    } else leaves.push(path);
  };
  walk(config, "");
  assert.deepEqual(leaves.filter((leaf) => !keys.has(leaf)), [], "every default is in the table");
});

test("every route in docs/api.md's tables is an operation of the API description, and every command in docs/cli.md exists", { timeout: 30_000 }, async (t) => {
  const api = await doc("docs/api.md");
  const documented = new Set([...api.matchAll(/^\| `(GET|POST|PUT|PATCH|DELETE) (\/[^`]*)` \|/gm)].map((m) => `${m[1]} ${m[2]}`));
  assert.ok(documented.size > 40, `the route rows were read (${documented.size})`);
  const dir = await makeTempDir(t, "runwright-docs16-");
  const config = await loadConfig({ env: {}, overrides: { dataDir: join(dir, "data"), port: 0 } });
  const app = await createApp({ config, env: {}, logWrite: () => undefined });
  t.after(() => app.stop({ graceMs: 100 }));
  await app.start();
  const description = await createClient({ baseUrl: app.url, token: app.token }).describeApi();
  const operations = new Set(description.operations
    .map((operation) => `${operation.method} ${operation.path.replace(/\/\*([A-Za-z]+)$/, "/<$1>")}`));
  assert.deepEqual([...documented].filter((route) => !operations.has(route)), [], "documented routes that do not exist");
  const names = new Set(COMMANDS.map((command) => command.name));
  const cli = await doc("docs/cli.md");
  const synopses = [...cli.matchAll(/^runwright ([a-z][a-z-]*(?: [a-z][a-z-]*)?)/gm)].map((m) => m[1] as string);
  assert.ok(synopses.length > 30, `the synopses were read (${synopses.length})`);
  const unknown = synopses.filter((text) => !names.has(text) && !names.has(text.split(" ")[0] as string));
  assert.deepEqual(unknown, [], "commands in docs/cli.md that the CLI does not have");
});
