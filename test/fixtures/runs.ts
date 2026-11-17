/**
 * Helpers the end-to-end tests share (not a test file): scripted agent definitions, waiting for a run status
 * over the API, reading a whole timeline, and reading the host tools' effects file.
 */
import { readFile } from "node:fs/promises";
import type { AgentDefinition, AgentToolEntry } from "../../src/agents/definition.ts";
import type { JsonObject } from "../../src/core/json.ts";
import type { RunwrightClient } from "../../src/client/index.ts";
import type { ModelRef, ScriptedScript, ScriptedTurn } from "../../src/models/types.ts";
import type { JournalRecord, PendingRecord, RunRecord, RunStatus } from "../../src/store/types.ts";
import { waitFor } from "../helpers/wait.ts";

/** An agent on the scripted model: no learning, no limits unless given. */
export function scriptedAgent(input: {
  name: string; script: ScriptedScript; tools?: AgentToolEntry[]; instructions?: string;
  limits?: AgentDefinition["limits"]; model?: Partial<ModelRef>; secrets?: string[]; learning?: boolean;
}): AgentDefinition {
  const definition: AgentDefinition = {
    name: input.name,
    instructions: input.instructions ?? `You are the ${input.name} test agent.`,
    model: { provider: "scripted", name: "scripted-1", ...input.model, script: input.script },
    tools: input.tools ?? [],
    limits: input.limits ?? {},
    learning: input.learning ?? false,
  };
  if (input.secrets !== undefined) definition.secrets = input.secrets;
  return definition;
}

/** A turn that calls one tool. */
export function callTurn(name: string, args: JsonObject, extra?: Partial<ScriptedTurn>): ScriptedTurn {
  return { toolCalls: [{ name, args }], ...extra };
}

/** Polls the run over the API until it has one of `statuses`. */
export async function waitForStatus(
  client: RunwrightClient, runId: string, statuses: RunStatus | readonly RunStatus[], timeoutMs = 15_000,
): Promise<{ run: RunRecord; pendings: PendingRecord[] }> {
  const wanted = typeof statuses === "string" ? [statuses] : statuses;
  let last: RunStatus | null = null;
  try {
    return await waitFor(async () => {
      const result = await client.getRun(runId);
      last = result.run.status;
      return wanted.includes(result.run.status) ? result : null;
    }, { timeoutMs, intervalMs: 25 });
  } catch (error) {
    const records = await fullTimeline(client, runId).catch(() => []);
    throw new Error(`run ${runId} did not reach ${wanted.join("|")} (last ${String(last)}): ${(error as Error).message}\n` +
      records.map((r) => `${r.seq} e${r.epoch} ${r.type} ${r.key ?? ""} ${JSON.stringify(r.data).slice(0, 200)}`).join("\n"));
  }
}

/** Every journal record of the run, in order. */
export async function fullTimeline(client: RunwrightClient, runId: string): Promise<JournalRecord[]> {
  const out: JournalRecord[] = [];
  let after = 0;
  for (;;) {
    const page = await client.timeline(runId, { after, limit: 1000 });
    out.push(...page.records);
    if (page.nextAfter === null || page.records.length === 0) return out;
    after = page.nextAfter;
  }
}

/** Lines of the effects file ([] when it does not exist yet). */
export async function effectLines(file: string): Promise<string[]> {
  try {
    return (await readFile(file, "utf8")).split("\n").filter((line) => line !== "");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Step keys that have more than one record of `type` (a finished step that ran twice). */
export function duplicateSteps(records: readonly JournalRecord[], type: string): string[] {
  const seen = new Map<string, number>();
  for (const record of records) {
    if (record.type !== type || record.key === null) continue;
    seen.set(record.key, (seen.get(record.key) ?? 0) + 1);
  }
  return [...seen].filter(([, count]) => count > 1).map(([key]) => key);
}
