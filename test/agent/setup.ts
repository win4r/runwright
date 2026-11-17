import type { TestContext } from "node:test";
import { RunwrightError } from "../../src/core/errors.ts";
import { canonicalJson, type Json } from "../../src/core/json.ts";
import { createAgentLoop, type AgentLoopOptions } from "../../src/agent/loop.ts";
import type { AgentDefinition } from "../../src/agents/definition.ts";
import type { Driver, EngineConfig, LearningHooks } from "../../src/engine/types.ts";
import { createModelRegistry } from "../../src/models/registry.ts";
import type { ModelRef, ModelRegistry, ModelRequest, ScriptedScript } from "../../src/models/types.ts";
import { createBuiltinTools } from "../../src/tools/builtin.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import type { JournalRecord } from "../../src/store/types.ts";
import { createHarness, type Harness } from "../helpers/engine.ts";

export const LOOP_OPTIONS: AgentLoopOptions = { compactAtFraction: 0.8, keepRecentTurns: 2, defaultContextTokens: 200_000 };

function abortable(task: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new RunwrightError("aborted", "the model call was aborted"));
      return;
    }
    const onAbort = (): void => reject(new RunwrightError("aborted", "the model call was aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** A gate that holds back model calls for chosen keys until the test opens it. */
export function modelGate(keys: readonly string[]): { gate: (request: ModelRequest) => Promise<void>; open(): void } {
  let release: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    gate: (request) => (keys.includes(request.meta.key) ? opened : Promise.resolve()),
    open: () => release(),
  };
}

/** A model registry over the real scripted provider that records every request it is sent. */
export function recordingModels(gate?: (request: ModelRequest) => Promise<void>): { models: ModelRegistry; requests: ModelRequest[] } {
  const inner = createModelRegistry({ secrets: { reveal: async () => ({}) }, retry: { maxAttempts: 3, baseMs: 1, maxMs: 5 } });
  const requests: ModelRequest[] = [];
  return {
    requests,
    models: {
      ...(inner.retry === undefined ? {} : { retry: inner.retry }),
      async resolve(ref) {
        const provider = await inner.resolve(ref);
        return {
          async generate(request, options) {
            requests.push(structuredClone(request));
            if (gate !== undefined) await abortable(gate(request), options.signal);
            return provider.generate(request, options);
          },
        };
      },
    },
  };
}

export function builtinTools(): ToolDefinition[] {
  return createBuiltinTools({
    files: { maxReadBytes: 65_536, maxWriteBytes: 65_536 },
    shell: { enabled: false, timeoutMs: 1000, outputBytes: 1000 },
    webFetch: { timeoutMs: 1000, maxBytes: 1000, maxRedirects: 0, lookup: async () => [] },
  });
}

export interface AgentSetup {
  h: Harness;
  requests: ModelRequest[];
  driver: Driver;
  /** Saves a scripted agent and starts a run of it. */
  run(script: ScriptedScript, options?: { agent?: Partial<AgentDefinition>; model?: Partial<ModelRef>; message?: string; data?: Json }): Promise<string>;
}

export async function setupAgent(
  t: TestContext,
  options?: { gate?: (request: ModelRequest) => Promise<void>; loop?: Partial<AgentLoopOptions>; tools?: ToolDefinition[]; learning?: LearningHooks; engine?: Partial<EngineConfig>; driver?: Driver },
): Promise<AgentSetup> {
  const { models, requests } = recordingModels(options?.gate);
  const { driver } = createAgentLoop({ ...LOOP_OPTIONS, ...options?.loop });
  const used = options?.driver ?? driver;
  const h = await createHarness(t, {
    models,
    drivers: { agent: used },
    tools: [...builtinTools(), ...(options?.tools ?? [])],
    ...(options?.learning === undefined ? {} : { learning: options.learning }),
    ...(options?.engine === undefined ? {} : { engine: options.engine }),
  });
  return {
    h, requests, driver: used,
    async run(script, runOptions) {
      const agent = await h.saveAgent({
        ...runOptions?.agent,
        model: { provider: "scripted", name: "scripted-1", ...runOptions?.model, script },
      });
      const run = await h.start(agent.id, { message: runOptions?.message ?? "go", data: runOptions?.data ?? null });
      return run.id;
    },
  };
}

/** Requests whose meta.key is `key`, in the order they were sent. */
export function requestsFor(requests: readonly ModelRequest[], key: string): ModelRequest[] {
  return requests.filter((request) => request.meta.key === key);
}

/** The request without its run id, as canonical JSON, for byte comparison across runs. */
export function requestBytesOf(request: ModelRequest): string {
  const { meta, ...rest } = request;
  const { runId: _runId, ...metaRest } = meta;
  return canonicalJson({ ...rest, meta: metaRest } as unknown as Json);
}

/** Number of journal records of `type` per key. */
export function countByKey(journal: readonly JournalRecord[], type: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const record of journal) {
    if (record.type !== type || record.key === null) continue;
    counts.set(record.key, (counts.get(record.key) ?? 0) + 1);
  }
  return counts;
}
