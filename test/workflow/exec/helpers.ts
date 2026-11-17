/**
 * Shared setup for the workflow executor tests: a real engine harness whose workflow driver is the runtime
 * under test, the scripted model, the built-in tools, `run_workflow`, and inline counting tools that record
 * every real handler invocation (so a test can prove that nothing ran twice).
 *
 * Counting tools (args `{label, value?, delayMs?, failTimes?}`):
 * - `count`: effect "write", not idempotent. Returns `{content: label, data: value ?? label}`.
 * - `flaky`: effect "write", idempotent. Same, retry-safe.
 * - `probe`: effect "read". Same.
 * With `failTimes: n` the first n invocations for that label throw. With `delayMs` the handler waits (abortable).
 */
import type { TestContext } from "node:test";
import { RunwrightError } from "../../../src/core/errors.ts";
import { isJsonObject, type Json, type JsonObject } from "../../../src/core/json.ts";
import type { AgentDefinition } from "../../../src/agents/definition.ts";
import type { AgentLoopFn, Driver, EngineConfig } from "../../../src/engine/types.ts";
import { createModelRegistry } from "../../../src/models/registry.ts";
import type { ModelRegistry, ScriptedScript } from "../../../src/models/types.ts";
import type { JournalRecord, RunRecord } from "../../../src/store/types.ts";
import { createBuiltinTools } from "../../../src/tools/builtin.ts";
import type { ToolRegistry } from "../../../src/tools/registry.ts";
import type { ToolDefinition } from "../../../src/tools/types.ts";
import { createWorkflowRuntime, type WorkflowRuntime } from "../../../src/workflow/exec/index.ts";
import { WORKFLOW_FORMAT, type WorkflowDocument, type WorkflowNode } from "../../../src/workflow/types.ts";
import { createHarness, miniAgentDriver, type Harness, type HarnessOptions } from "../../helpers/engine.ts";
import type { TwoLayerWiring } from "../../helpers/two-layer.ts";

export interface Counters {
  /** Real handler invocations per `<tool>:<label>`. */
  calls: Map<string, number>;
  /** Highest number of counting-tool handlers in flight at once, per tool name. */
  highWater: Map<string, number>;
  get(tool: string, label: string): number;
  total(tool: string): number;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new RunwrightError("aborted", "aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new RunwrightError("aborted", "aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function countingTools(): { tools: ToolDefinition[]; counters: Counters } {
  const calls = new Map<string, number>();
  const inFlight = new Map<string, number>();
  const highWater = new Map<string, number>();
  const make = (name: string, effect: "read" | "write", idempotent: boolean): ToolDefinition => ({
    name,
    description: `counting tool ${name}`,
    effect,
    idempotent,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["label"],
      properties: {
        label: { type: "string" },
        value: {},
        delayMs: { type: "integer", minimum: 0 },
        failTimes: { type: "integer", minimum: 0 },
      },
    },
    async handler(args, context) {
      const label = String(args["label"]);
      const slot = `${name}:${label}`;
      const n = (calls.get(slot) ?? 0) + 1;
      calls.set(slot, n);
      const now = (inFlight.get(name) ?? 0) + 1;
      inFlight.set(name, now);
      highWater.set(name, Math.max(highWater.get(name) ?? 0, now));
      try {
        const wait = args["delayMs"];
        if (typeof wait === "number" && wait > 0) await delay(wait, context.signal);
        const failTimes = args["failTimes"];
        if (typeof failTimes === "number" && n <= failTimes) {
          throw new RunwrightError("tool_failed", `${label} failed on call ${n}`);
        }
        const value: Json = Object.hasOwn(args, "value") ? (args["value"] ?? null) : label;
        return { content: label, data: value };
      } finally {
        inFlight.set(name, (inFlight.get(name) ?? 1) - 1);
      }
    },
  });
  const counters: Counters = {
    calls,
    highWater,
    get: (tool, label) => calls.get(`${tool}:${label}`) ?? 0,
    total: (tool) => [...calls.entries()].filter(([k]) => k.startsWith(`${tool}:`)).reduce((sum, [, v]) => sum + v, 0),
  };
  return { tools: [make("count", "write", false), make("flaky", "write", true), make("probe", "read", false)], counters };
}

/** A small agent loop for `agent` nodes: one model call under key `t1` with `meta.step` = the node id. */
export function fakeAgentLoop(onCall?: (message: string) => void): AgentLoopFn {
  return async (ctx, params) => {
    onCall?.(params.message);
    const reply = await ctx.model("t1", {
      purpose: "run",
      system: params.instructions,
      messages: [{ role: "user", content: params.message }],
      turn: 1,
      ...(params.step === undefined ? {} : { step: params.step }),
      ...(params.output === undefined ? {} : { output: params.output }),
    });
    return { text: reply.text, data: params.output === undefined ? null : reply.output, turns: 1 };
  };
}

export interface WorkflowSetup {
  h: Harness;
  runtime: WorkflowRuntime;
  counters: Counters;
  /** Saves an agent running `workflow` with the given script and the listed tools (default: the counting tools). */
  agent(options: { workflow?: WorkflowDocument; script?: ScriptedScript; tools?: AgentDefinition["tools"];
    limits?: AgentDefinition["limits"]; instructions?: string;
    /** Names of stored secrets the run is handed (the first redaction layer); needs `twoLayer`. */
    secrets?: string[] }): Promise<string>;
  /** Starts a run with input data and waits for one of the statuses. */
  run(agentId: string, data: Json, statuses?: RunRecord["status"] | RunRecord["status"][], limits?: Parameters<Harness["start"]>[2]): Promise<RunRecord>;
}

export async function setupWorkflow(t: TestContext, options?: {
  agentLoop?: AgentLoopFn; engine?: Partial<EngineConfig>; agentDriver?: Driver;
  /** The model registry; default: the scripted provider with one engine attempt per call. */
  models?: ModelRegistry;
  /**
   * Both redaction layers as `createApp` wires them: the wiring's options go to the harness, and `secrets`
   * (name -> value) are set as stored secrets before the runner starts.
   */
  twoLayer?: { wiring: TwoLayerWiring; secrets: Readonly<Record<string, string>> };
  /** Passed to the harness as they are: a clock and timer driven by hand, a store wrapper, no runner. */
  harness?: Pick<HarnessOptions, "clock" | "sleep" | "wrapStore" | "autoStart">;
}): Promise<WorkflowSetup> {
  const { tools: counting, counters } = countingTools();
  let harness: Harness | null = null;
  const lazyTools: ToolRegistry = {
    register: (tool) => (harness as Harness).tools.register(tool),
    get: (name) => (harness as Harness).tools.get(name),
    list: () => (harness as Harness).tools.list(),
  };
  const runtime = createWorkflowRuntime({
    agentLoop: options?.agentLoop ?? fakeAgentLoop(),
    store: { getWorkflow: (name, version) => (harness as Harness).store.getWorkflow(name, version) },
    tools: lazyTools,
  });
  const builtins = createBuiltinTools({
    files: { maxReadBytes: 65_536, maxWriteBytes: 65_536 },
    shell: { enabled: false, timeoutMs: 1000, outputBytes: 1024 },
    webFetch: { timeoutMs: 1000, maxBytes: 1024, maxRedirects: 0, lookup: async () => [{ address: "127.0.0.1", family: 4 }] },
  });
  const h = await createHarness(t, {
    models: options?.models ?? createModelRegistry({ secrets: { reveal: async () => ({}) }, retry: { maxAttempts: 1, baseMs: 1, maxMs: 1 } }),
    drivers: { workflow: runtime.driver, agent: options?.agentDriver ?? miniAgentDriver },
    tools: [...builtins, runtime.runWorkflowTool, ...counting],
    ...(options?.engine === undefined ? {} : { engine: options.engine }),
    ...(options?.twoLayer === undefined ? {} : options.twoLayer.wiring.options),
    ...options?.harness,
  });
  harness = h;
  if (options?.twoLayer !== undefined) await options.twoLayer.wiring.attach(h, options.twoLayer.secrets);
  const defaultTools = [{ name: "count" }, { name: "flaky" }, { name: "probe" }];
  return {
    h,
    runtime,
    counters,
    async agent(o) {
      const definition: Partial<AgentDefinition> = {
        instructions: o.instructions ?? "Follow the workflow.",
        model: { provider: "scripted", name: "scripted-1", script: o.script ?? {} },
        tools: o.tools ?? defaultTools,
        limits: o.limits ?? {},
      };
      if (o.workflow !== undefined) definition.workflow = o.workflow;
      if (o.secrets !== undefined) definition.secrets = o.secrets;
      return (await h.saveAgent(definition)).id;
    },
    async run(agentId, data, statuses = ["completed", "failed", "cancelled"], limits) {
      const run = await h.start(agentId, { data }, limits);
      return h.until(run.id, statuses);
    },
  };
}

/** A workflow document with permissive schemas unless given. */
export function doc(root: WorkflowNode, result: Json, extra?: Partial<WorkflowDocument>): WorkflowDocument {
  return {
    format: WORKFLOW_FORMAT,
    name: "test_flow",
    schemas: { Input: { type: "object" }, Output: {} },
    input: "Input",
    output: "Output",
    root,
    result,
    ...extra,
  };
}

/** `node.finished` records of a run, as `{key, name, value}`. */
export function nodeFinished(journal: readonly JournalRecord[]): { key: string; name: string; value: Json }[] {
  return journal.filter((r) => r.type === "node.finished").map((r) => ({
    key: r.key ?? "", name: String(r.data["name"]), value: (r.data["value"] ?? null) as Json,
  }));
}

/** Asserts no step key has two records of the same finished type. */
export function duplicateFinishes(journal: readonly JournalRecord[]): string[] {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const r of journal) {
    if (!["node.finished", "tool.finished", "model.finished", "step.finished"].includes(r.type)) continue;
    const slot = `${r.type} ${r.key ?? ""}`;
    if (seen.has(slot)) dupes.push(slot);
    seen.add(slot);
  }
  return dupes;
}

/** Waits until the run's journal has a record matching `match`. */
export async function untilRecord(h: Harness, runId: string, match: (r: JournalRecord) => boolean, timeoutMs = 5000): Promise<JournalRecord> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = (await h.journal(runId)).find(match);
    if (found !== undefined) return found;
    if (Date.now() >= deadline) {
      const run = await h.store.getRun(runId);
      throw new Error(`no matching record in run ${runId} within ${timeoutMs} ms (status ${run?.status ?? "missing"})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function asObject(value: Json | undefined): JsonObject {
  if (!isJsonObject(value)) throw new Error(`expected an object, got ${JSON.stringify(value)}`);
  return value;
}
