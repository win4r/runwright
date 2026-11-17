/**
 * Shared boilerplate for the examples: a throwaway data directory, an app on a free port with the scripted
 * model (no key, no network), a client, readable progress lines, and a final JSON summary line.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app/app.ts";
import { createClient, type RunwrightClient } from "../src/client/index.ts";
import { loadConfig } from "../src/config/load.ts";
import type { AgentDefinition } from "../src/agents/definition.ts";
import type { Json } from "../src/core/json.ts";
import type { JournalRecord, PendingRecord, RunRecord } from "../src/store/types.ts";

export interface ExampleContext { app: App; client: RunwrightClient; dataDir: string }

/** Prints one readable progress line. */
export function say(text: string): void {
  process.stdout.write(`${text}\n`);
}

/** Prints the final machine-readable line every example ends with. */
export function summary(value: Json): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** Reads `<folder>/agent.json`: `{id, definition}`, the same file `runwright agents save` accepts. */
export async function loadAgentFile(folder: URL): Promise<{ id: string; definition: AgentDefinition }> {
  const text = await readFile(new URL("agent.json", folder), "utf8");
  return JSON.parse(text) as { id: string; definition: AgentDefinition };
}

/**
 * Runs `body` against a fresh app in a temp data directory, then stops the app and deletes the directory.
 * Warnings and errors from the app's log go to stderr; the exit code is 0 when `body` resolves true.
 */
export async function runExample(name: string, body: (context: ExampleContext) => Promise<boolean>): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), `runwright-example-${name}-`));
  let ok = false;
  let app: App | null = null;
  try {
    const config = await loadConfig({ env: {}, overrides: { dataDir, port: 0, pollMs: 50 } });
    config.log.level = "warn";
    app = await createApp({ config, env: {}, logWrite: (line) => process.stderr.write(`${line}\n`) });
    await app.start();
    ok = await body({ app, client: createClient({ baseUrl: app.url, token: app.token }), dataDir });
  } catch (error) {
    process.stderr.write(`example ${name} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    ok = false;
  } finally {
    await app?.stop({ graceMs: 1000 }).catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
  process.exitCode = ok ? 0 : 1;
}

/** Waits until the run completed, failed, was cancelled, or waits on a person. */
export async function settle(client: RunwrightClient, runId: string): Promise<{ run: RunRecord; pendings: PendingRecord[] }> {
  return client.waitForRun(runId, { timeoutMs: 30_000, pollMs: 25 });
}

/** Every journal record of a run, in order. */
export async function journal(client: RunwrightClient, runId: string): Promise<JournalRecord[]> {
  const out: JournalRecord[] = [];
  let after = 0;
  for (;;) {
    const page = await client.timeline(runId, { after, limit: 1000 });
    out.push(...page.records);
    if (page.nextAfter === null || page.records.length === 0) return out;
    after = page.nextAfter;
  }
}

/** "$0.001234" for a known cost, "unknown" otherwise. */
export function dollars(run: RunRecord): string {
  return run.usage.costUnknown ? "unknown" : `$${(run.usage.costMicros / 1_000_000).toFixed(6)}`;
}
