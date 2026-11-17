/**
 * Shared setup for learning flow tests: the engine harness with real learning hooks, the real `recall` tool and
 * the real scripted model (wrapped so tests can see every model request).
 */
import type { TestContext } from "node:test";
import type { AgentDefinition } from "../../src/agents/definition.ts";
import type { Config } from "../../src/config/types.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import { createIdSource } from "../../src/core/ids.ts";
import type { LearningHooks } from "../../src/engine/types.ts";
import { createLearning } from "../../src/learning/index.ts";
import { createLogger } from "../../src/log/logger.ts";
import { createModelRegistry } from "../../src/models/registry.ts";
import type { ModelRegistry, ModelRequest, ScriptedScript } from "../../src/models/types.ts";
import type { AgentRecord } from "../../src/store/types.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import type { EngineConfig } from "../../src/engine/types.ts";
import { createHarness, type Harness } from "../helpers/engine.ts";
import type { TwoLayerWiring } from "../helpers/two-layer.ts";

export interface LearningHarness extends Harness {
  readonly requests: ModelRequest[];
  agent(script: ScriptedScript, definition?: Partial<AgentDefinition>): Promise<AgentRecord>;
}

/** Called with every model request before the scripted model answers it; the answer waits for it. */
export type BeforeModel = (request: ModelRequest) => Promise<void>;

function recordingModels(requests: ModelRequest[], beforeModel: BeforeModel | undefined): ModelRegistry {
  const inner = createModelRegistry({
    secrets: { reveal: async () => ({}) }, retry: { maxAttempts: 1, baseMs: 1, maxMs: 1 }, random: () => 0,
  });
  return {
    async resolve(ref) {
      const provider = await inner.resolve(ref);
      return {
        generate: async (request, options) => {
          requests.push(request);
          if (beforeModel !== undefined) await beforeModel(request);
          return provider.generate(request, options);
        },
      };
    },
  };
}

/**
 * `twoLayer`: the run's redactor and the store wrapper of `createApp` (`twoLayerWiring()`), with `values` (name ->
 * value) set as stored secrets before the runner starts. A run is handed one of them only when its agent lists
 * the name in `secrets`. It replaces `secrets`. `beforeModel`: see BeforeModel (a test acts at a known request).
 */
export async function learningHarness(t: TestContext, options?: {
  config?: Partial<Config["learning"]>; tools?: readonly ToolDefinition[]; secrets?: Record<string, string>; engine?: Partial<EngineConfig>;
  twoLayer?: { wiring: TwoLayerWiring; values: Readonly<Record<string, string>> }; beforeModel?: BeforeModel;
}): Promise<LearningHarness> {
  const requests: ModelRequest[] = [];
  let real: LearningHooks | null = null;
  const live = (): LearningHooks => {
    if (real === null) throw new Error("learning hooks are not ready");
    return real;
  };
  const hooks: LearningHooks = {
    prepare: (context) => live().prepare(context),
    afterRun: (context, outcome) => live().afterRun(context, outcome),
  };
  const h = await createHarness(t, {
    models: recordingModels(requests, options?.beforeModel), learning: hooks, autoStart: false,
    ...(options?.tools === undefined ? {} : { tools: options.tools }),
    ...(options?.secrets === undefined ? {} : { secrets: options.secrets }),
    ...(options?.engine === undefined ? {} : { engine: options.engine }),
    ...(options?.twoLayer === undefined ? {} : options.twoLayer.wiring.options),
  });
  const learning = createLearning({
    store: h.store, tools: h.tools, ids: createIdSource(), config: { ...defaultConfig(h.dir).learning, ...options?.config },
    logger: createLogger({ level: "error", write: () => undefined }),
  });
  real = learning.hooks;
  h.tools.register(learning.recallTool);
  if (options?.twoLayer === undefined) h.runner.start();
  else await options.twoLayer.wiring.attach(h, options.twoLayer.values);
  return Object.assign(h, {
    requests,
    agent(script: ScriptedScript, definition?: Partial<AgentDefinition>) {
      return h.saveAgent({ learning: true, ...definition, model: { provider: "scripted", name: "scripted-1", maxOutputTokens: 512, script } });
    },
  });
}

/** A learning file in the proposal format. */
export function itemFile(title: string, description: string, body: string): string {
  return `---\ntitle: ${title}\ndescription: ${description}\n---\n${body}`;
}

export function keepAll(paths: readonly string[]): { output: { job_finished: boolean; decisions: { path: string; verdict: string; reason: string }[] } } {
  return { output: { job_finished: true, decisions: paths.map((path) => ({ path, verdict: "keep", reason: "useful" })) } };
}
