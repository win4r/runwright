/**
 * Engine test harness (plan 5.12). Everything stage 3 tests need to drive real runs through the real runner
 * and store, offline and hermetic:
 *
 *   const h = await createHarness(t, { models: fakeModels((req) => ({ text: "hi", ... })) });
 *   const agent = await h.saveAgent({ tools: [{ name: "echo" }] });
 *   const run = await h.start(agent.id, { message: "go" });
 *   const done = await h.until(run.id, "completed");
 *
 * - A fresh temp directory (`h.dir`) holds the SQLite store (`runwright.db`) and the run workspaces
 *   (`<dir>/workspaces/<runId>`). Runners and the store are closed when the test ends.
 * - Defaults: leaseMs 300, heartbeatMs 100, pollMs 20, concurrency 8, toolResultBytes 16 384,
 *   defaultMaxOutputTokens 4096, no deny list, unpriced models not allowed, drivers
 *   `{agent: miniAgentDriver, workflow: miniAgentDriver}`, pricing `fakePricing()`, learning hooks none.
 *   Override with `options.engine`, `options.drivers`, `options.pricing`, `options.learning`.
 * - `options.tools` are registered in `h.tools`; `options.secrets` is what the secrets reader reveals, unless
 *   `options.secretsReader` replaces that reader.
 * - `h.events` is the EphemeralEvents object every runner of the harness publishes model deltas to.
 * - Logs are captured as JSON lines in `h.logLines` (level debug, no logger-side redaction, so a test can check
 *   that the engine itself never logs a secret).
 * - `h.saveAgent(definition?, id?)` saves a definition on `scripted/scripted-1` with no tools and no limits,
 *   overridden by the fields you pass. `h.start(agentId, input?, limits?)` creates a run (message "go",
 *   data null by default).
 * - `h.until(runId, statuses, timeoutMs = 5000)` polls the run until it has one of the statuses; on timeout it
 *   rejects with the journal dumped in the message.
 * - `h.journal(runId)`, `h.records(runId, type)` (typed data of one record type), `h.pendings(runId)` (open
 *   ones), `h.send(runId, command)`.
 * - `options.wrapStore(store)` replaces the store the runners use (the raw store stays `h.store`, so a test reads
 *   the journal without going through its own wrapper); `storeWith(store, overrides)` builds such a wrapper.
 *   `h.deps(overrides?)` is the EngineDeps a runner of the harness gets, for a test that starts a session itself.
 * - `h.claimSession(runnerId?)` claims the oldest claimable run (a 30 s lease, no heartbeat) and starts a session on
 *   it directly, with no runner: `core` is the session as the SessionCore its steps use, and `violations` collects
 *   every breach of the turn invariant (`usage.turns + reserved.turns <= maxTurns` while a turn limit is set),
 *   checked whenever `reserved.turns` changes and after every commit. The event loop is held open until the
 *   session unwinds. Nothing claims the run again when it leaves `running`: a test calls `claimSession` once more.
 * - `h.newRunner(overrides?)` starts another runner on the same store. `h.crashAndReplace()` abandons the
 *   current runner (its sessions write nothing more, leases are left to expire, like a killed process) and
 *   starts a fresh one, which becomes `h.runner`. A takeover therefore needs `leaseMs` to pass.
 *
 * `miniAgentDriver` is a tiny agent loop for engine-level tests: system = instructions (+ the learning prompt
 * section), turn n is `ctx.model("t<n>", {purpose: "run", tools: ctx.toolSpecs(), turn: n})`, each tool call i
 * is `ctx.tool("t<n>.c<i>")` with its result appended as a tool message, and it returns `{text}` of the first
 * reply that has no tool calls.
 *
 * `commandGate()` makes a command land between a step's control check and its "started" (or pending) commit:
 * pass `gate.wrap` as `wrapStore`; in the driver, `await gate.hold(h.store, ctx.run.id, command)` (the session now
 * holds its commit lock on that command's application), request the step, then `gate.releaseSoon()`.
 *
 * `reply({...})` builds a ModelResponse (text "", no tool calls, output null, stopReason "end", zero usage by
 * default, `usageMissing` only when given); `toolReply(name, args, id?)` is a reply with one tool call.
 *
 * `fakeTimers(startMs?)` is a fake clock with timers that follow it: pass `clock` and `sleep` as
 * `options.clock` / `options.sleep` (the store's record times, leases and the engine's clock all read it, and
 * `ctx.sleep` / `ctx.sleepUntil` wait on its timers), or `sleep` as a ModelRetry's. `advance(ms)` moves the clock
 * and fires the timers that are due; `requested` lists every wait asked for; `pending()` the timers still waiting.
 * With a clock that only moves by hand, a lease expires only when the test advances the clock past it.
 *
 * `fakeModels(respond, retry?)` is a ModelRegistry whose every model answers with `respond(request, options)`;
 * missing usage fields default to 0. With `retry`, the engine retries transient failures under that policy
 * (attempt by attempt, `request.meta.attempt`); without it every model call is one attempt. `fakePricing()` prices every model at input 1.00 / output 5.00 USD per
 * million tokens (1 and 5 micro-dollars per token), except model names starting with "unpriced" (no price).
 */
import { join } from "node:path";
import type { JsonObject } from "../../src/core/json.ts";
import type { TestContext } from "node:test";
import { createIdSource } from "../../src/core/ids.ts";
import { createFakeClock, systemClock, type Clock, type FakeClock } from "../../src/core/clock.ts";
import { RunwrightError } from "../../src/core/errors.ts";
import { createEphemeralEvents, type EphemeralEvents } from "../../src/core/events.ts";
import { createLogger } from "../../src/log/logger.ts";
import type { AgentDefinition } from "../../src/agents/definition.ts";
import { openSqliteStore } from "../../src/store/sqlite.ts";
import type {
  AgentRecord, JournalRecord, PendingRecord, RunCommand, RunInput, RunLimits, RunRecord, RunStatus, Store,
} from "../../src/store/types.ts";
import type {
  GenerateOptions, Message, ModelPrice, ModelRegistry, ModelRequest, ModelResponse, ModelRetry, Pricing, Usage,
} from "../../src/models/types.ts";
import { createToolRegistry, type ToolRegistry } from "../../src/tools/registry.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import type { JournalDataMap, JournalType } from "../../src/engine/journal-types.ts";
import type { Driver, Drivers, EngineConfig, EngineDeps, LearningHooks, Runner, SecretsReader } from "../../src/engine/types.ts";
import { createRunner } from "../../src/engine/runner.ts";
import { startSession, type Session } from "../../src/engine/session.ts";
import type { SessionCore } from "../../src/engine/context.ts";
import { makeTempDir } from "./tmp.ts";
import { testAgentDefinition } from "./store.ts";

export interface HarnessOptions {
  models: ModelRegistry; drivers?: Partial<Drivers>; tools?: readonly ToolDefinition[];
  pricing?: Pricing; learning?: LearningHooks | null; secrets?: Record<string, string>; engine?: Partial<EngineConfig>; autoStart?: boolean;
  /** Replaces the reader built from `secrets` (for secrets that change while a run is in progress). */
  secretsReader?: SecretsReader;
  /** The store the runners use, built over the harness store (e.g. to act while a commit is in progress). */
  wrapStore?: (store: Store) => Store;
  /** The clock of the store and of every runner (default: the system clock); `fakeTimers().clock` drives both by hand. */
  clock?: Clock;
  /** The engine's timer (`EngineDeps.sleep`), e.g. `fakeTimers().sleep`. */
  sleep?: EngineDeps["sleep"];
}

/** A session a test started itself (Harness.claimSession). */
export interface ManualSession {
  readonly session: Session;
  /** The session as the core its steps use (its state, reservations and open repair turns). */
  readonly core: SessionCore;
  /** Breaches of `usage.turns + reserved.turns <= maxTurns`, as text; empty while the invariant holds. */
  readonly violations: string[];
}

export interface Harness {
  readonly dir: string; readonly store: Store; readonly tools: ToolRegistry; readonly logLines: string[];
  readonly events: EphemeralEvents; runner: Runner;
  saveAgent(definition?: Partial<AgentDefinition>, id?: string): Promise<AgentRecord>;
  start(agentId: string, input?: Partial<RunInput>, limits?: Partial<RunLimits>): Promise<RunRecord>;
  until(runId: string, statuses: RunStatus | readonly RunStatus[], timeoutMs?: number): Promise<RunRecord>;
  journal(runId: string): Promise<JournalRecord[]>;
  records<K extends JournalType>(runId: string, type: K): Promise<JournalDataMap[K][]>;
  pendings(runId: string): Promise<PendingRecord[]>;
  send(runId: string, command: RunCommand): Promise<void>;
  newRunner(overrides?: Partial<EngineConfig>): Runner;
  /** The dependencies a runner of this harness gets (with the wrapped store when `wrapStore` is given). */
  deps(overrides?: Partial<EngineConfig>): EngineDeps;
  crashAndReplace(): Promise<Runner>;
  claimSession(runnerId?: string): Promise<ManualSession>;
}

/**
 * Watches the turn invariant of `core`: whenever `reserved.turns` changes and after every commit of the core, the
 * counted and reserved turns together are at most the turn limit. Returns the list breaches are appended to.
 */
function watchTurns(core: SessionCore): string[] {
  const violations: string[] = [];
  const check = (where: string): void => {
    const max = core.state.limits.maxTurns;
    if (max === null) return;
    const counted = core.state.usage.turns;
    const reserved = core.reserved.turns;
    if (counted + reserved > max) violations.push(`${where}: ${counted} counted + ${reserved} reserved > ${max}`);
  };
  const watched = new Proxy(core.reserved, {
    set(target, property, value) {
      const done = Reflect.set(target, property, value);
      if (property === "turns") check("reserve");
      return done;
    },
  });
  const commit = core.commit.bind(core);
  Object.defineProperty(core, "reserved", { value: watched, writable: false, configurable: true });
  Object.defineProperty(core, "commit", {
    configurable: true,
    writable: true,
    value: async (...args: Parameters<SessionCore["commit"]>) => {
      const stored = await commit(...args);
      check("commit");
      return stored;
    },
  });
  return violations;
}

export const miniAgentDriver: Driver = async (ctx) => {
  const section = ctx.learning?.promptSection ?? "";
  const system = section === "" ? ctx.definition.instructions : `${ctx.definition.instructions}\n\n${section}`;
  const messages: Message[] = [{ role: "user", content: ctx.run.input.message }];
  for (let turn = 1; ; turn++) {
    const reply = await ctx.model(`t${turn}`, { purpose: "run", system, messages: [...messages], tools: ctx.toolSpecs(), turn });
    messages.push({ role: "assistant", content: reply.text, toolCalls: reply.toolCalls });
    if (reply.toolCalls.length === 0) return { text: reply.text };
    for (const [i, call] of reply.toolCalls.entries()) {
      const result = await ctx.tool(`t${turn}.c${i}`, { name: call.name, args: call.args, callId: call.id });
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: result.content, isError: result.isError });
    }
  }
};

function fullUsage(usage: Partial<Usage> | undefined): Usage {
  return {
    inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0,
    cacheReadTokens: usage?.cacheReadTokens ?? 0, cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
  };
}

export function reply(partial: Partial<Omit<ModelResponse, "usage">> & { usage?: Partial<Usage> }): ModelResponse {
  const toolCalls = partial.toolCalls ?? [];
  const response: ModelResponse = {
    text: partial.text ?? "", toolCalls, output: partial.output ?? null,
    stopReason: partial.stopReason ?? (toolCalls.length > 0 ? "tool_use" : "end"), usage: fullUsage(partial.usage),
  };
  if (partial.usageMissing !== undefined) response.usageMissing = partial.usageMissing;
  return response;
}

/** A fake clock with the timers that follow it (FakeTimers in the header). */
export interface FakeTimers {
  readonly clock: FakeClock;
  /** An `EngineDeps.sleep` / `ModelRetry.sleep` whose timer fires when the clock is advanced to its end. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /** Every wait asked for, in ms, in order (also those that were aborted). */
  readonly requested: number[];
  /** The end instants of the timers still waiting. */
  pending(): number[];
  /** Moves the clock forward and fires every timer whose end has come. */
  advance(ms: number): void;
  /** Resolves once a timer is waiting (at least `count` timers, default 1); rejects after `timeoutMs` real ms. */
  untilWaiting(count?: number, timeoutMs?: number): Promise<void>;
}

export function fakeTimers(startMs?: number): FakeTimers {
  const clock = createFakeClock(startMs);
  const timers: { at: number; fire: () => void }[] = [];
  const requested: number[] = [];
  const fireDue = (): void => {
    for (const timer of timers.filter((entry) => entry.at <= clock.now())) {
      timers.splice(timers.indexOf(timer), 1);
      timer.fire();
    }
  };
  return {
    clock,
    requested,
    sleep(ms, signal) {
      requested.push(ms);
      return new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(new RunwrightError("aborted", "the operation was aborted"));
          return;
        }
        const timer = {
          at: clock.now() + Math.max(0, ms),
          fire: () => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          },
        };
        const onAbort = (): void => {
          const index = timers.indexOf(timer);
          if (index >= 0) timers.splice(index, 1);
          reject(new RunwrightError("aborted", "the operation was aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        timers.push(timer);
        if (timer.at <= clock.now()) setImmediate(fireDue);
      });
    },
    pending: () => timers.map((timer) => timer.at),
    advance(ms) {
      clock.advance(ms);
      fireDue();
    },
    async untilWaiting(count = 1, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (timers.length < count) {
        if (Date.now() >= deadline) throw new Error(`no ${count} fake timer(s) waiting within ${timeoutMs} ms (requested: ${requested.join(", ")})`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
  };
}

export function toolReply(name: string, args: JsonObject, id?: string): ModelResponse {
  return reply({ toolCalls: [{ id: id ?? `call_${name}`, name, args }] });
}

export function fakeModels(
  respond: (request: ModelRequest, options: GenerateOptions) => ModelResponse | Promise<ModelResponse>,
  retry?: ModelRetry,
): ModelRegistry {
  return {
    ...(retry === undefined ? {} : { retry }),
    resolve: async () => ({
      generate: async (request: ModelRequest, options: GenerateOptions): Promise<ModelResponse> => {
        const response = await respond(request, options);
        return { ...response, usage: fullUsage(response.usage) };
      },
    }),
  };
}

const FAKE_PRICE: ModelPrice = { inputPerMTok: 1, outputPerMTok: 5 };

export function fakePricing(): Pricing {
  const priceFor = (ref: { provider: string; name: string }): ModelPrice | null => (ref.name.startsWith("unpriced") ? null : FAKE_PRICE);
  return {
    priceFor,
    costMicros(ref, usage) {
      const price = priceFor(ref);
      if (price === null) return null;
      const input = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
      return Math.ceil(input * price.inputPerMTok + usage.outputTokens * price.outputPerMTok);
    },
    worstCaseMicros(ref, inputTokens, maxOutputTokens) {
      const price = priceFor(ref);
      if (price === null) return null;
      return Math.ceil(inputTokens * price.inputPerMTok + maxOutputTokens * price.outputPerMTok);
    },
  };
}

/**
 * Holds the session's commit lock with a command application: once armed, the next `listCommands` of the session
 * waits for the release. A step requested meanwhile passes its control check and queues its commit behind the
 * application, so the command is applied after the check and before that commit.
 */
export function commandGate(): {
  wrap(store: Store): Store;
  hold(store: Store, runId: string, command: RunCommand): Promise<void>;
  releaseSoon(): void;
} {
  let armed = false;
  let reached!: () => void;
  let release!: () => void;
  const reachedPromise = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const releasePromise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    wrap: (store) => storeWith(store, {
      async listCommands(runId, options) {
        if (armed) {
          armed = false;
          reached();
          await releasePromise;
        }
        return store.listCommands(runId, options);
      },
    }),
    async hold(store, runId, command) {
      armed = true;
      await store.enqueueCommand(runId, command);
      await reachedPromise;
    },
    releaseSoon() {
      setImmediate(release);
    },
  };
}

/** `store` with some of its methods replaced; every other method is the store's own, bound to it. */
export function storeWith(store: Store, overrides: Partial<Store>): Store {
  return new Proxy(store, {
    get(target, property) {
      if (typeof property === "string" && Object.hasOwn(overrides, property)) return (overrides as Record<string, unknown>)[property];
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

export async function createHarness(t: TestContext, options: HarnessOptions): Promise<Harness> {
  const dir = await makeTempDir(t, "runwright-engine-");
  const clock = options.clock ?? systemClock;
  const store = await openSqliteStore({ path: join(dir, "runwright.db"), clock });
  const ids = createIdSource();
  const logLines: string[] = [];
  const logger = createLogger({ level: "debug", write: (line) => logLines.push(line) });
  const tools = createToolRegistry(options.tools ?? []);
  const secrets = options.secrets ?? {};
  const events = createEphemeralEvents();
  const baseConfig: EngineConfig = {
    concurrency: 8, leaseMs: 300, heartbeatMs: 100, pollMs: 20, workspacesDir: join(dir, "workspaces"),
    denyTools: [], allowUnpricedModels: false, toolResultBytes: 16_384, defaultMaxOutputTokens: 4096,
    ...options.engine,
  };
  const runnerStore = options.wrapStore === undefined ? store : options.wrapStore(store);
  const deps = (config: EngineConfig): EngineDeps => ({
    store: runnerStore, clock, ids, logger, tools, models: options.models, pricing: options.pricing ?? fakePricing(),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    drivers: { agent: miniAgentDriver, workflow: miniAgentDriver, ...options.drivers },
    learning: options.learning ?? null,
    secrets: options.secretsReader ?? {
      reveal: async (names) => Object.fromEntries(names.filter((n) => Object.hasOwn(secrets, n)).map((n) => [n, secrets[n] as string])),
    },
    events,
    config,
  });
  const runners: Runner[] = [];
  const abandoned = new Set<Runner>();
  const makeRunner = (overrides?: Partial<EngineConfig>): Runner => {
    const config: EngineConfig = { ...baseConfig, ...overrides };
    if (overrides?.runnerId === undefined) delete config.runnerId;
    const runner = createRunner(deps(config));
    runners.push(runner);
    return runner;
  };

  t.after(async () => {
    for (const runner of runners) {
      if (!abandoned.has(runner)) await runner.stop({ graceMs: 200 });
    }
    // Let sessions of abandoned runners unwind (their handlers see the abort) before the store closes.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await store.close();
  });

  const readJournal = async (runId: string): Promise<JournalRecord[]> => {
    const out: JournalRecord[] = [];
    for (;;) {
      const page = await store.readJournal(runId, { afterSeq: out.length === 0 ? 0 : (out[out.length - 1] as JournalRecord).seq, limit: 1000 });
      for (const record of page) out.push(record);
      if (page.length < 1000) return out;
    }
  };

  const harness: Harness = {
    dir, store, tools, logLines, events,
    runner: makeRunner(baseConfig.runnerId === undefined ? undefined : { runnerId: baseConfig.runnerId }),
    async saveAgent(definition, id) {
      const saved = await store.saveAgent({
        ...(id === undefined ? {} : { id }),
        definition: testAgentDefinition({ model: { provider: "scripted", name: "scripted-1" }, ...definition }),
      });
      return saved.agent;
    },
    async start(agentId, input, limits) {
      const created = await store.createRun({
        agentId, input: { message: "go", data: null, ...input }, ...(limits === undefined ? {} : { limits }),
      });
      return created.run;
    },
    async until(runId, statuses, timeoutMs = 5000) {
      const wanted: readonly RunStatus[] = typeof statuses === "string" ? [statuses] : statuses;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const run = await store.getRun(runId);
        if (run !== null && wanted.includes(run.status)) return run;
        if (Date.now() >= deadline) {
          const journal = await readJournal(runId);
          const dump = journal.map((r) => `${r.seq} e${r.epoch} ${r.type}${r.key === null ? "" : ` [${r.key}]`} ${JSON.stringify(r.data)}`).join("\n");
          throw new Error(`run ${runId} did not reach ${wanted.join("|")} within ${timeoutMs} ms (status ${run?.status ?? "missing"})\n${dump}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    journal: readJournal,
    async records<K extends JournalType>(runId: string, type: K): Promise<JournalDataMap[K][]> {
      return (await readJournal(runId)).filter((r) => r.type === type).map((r) => r.data as unknown as JournalDataMap[K]);
    },
    async pendings(runId) {
      return (await store.listPendings({ runId, status: "open" }, { limit: 100 })).items;
    },
    async send(runId, command) {
      await store.enqueueCommand(runId, command);
    },
    deps(overrides) {
      return deps({ ...baseConfig, ...overrides });
    },
    newRunner(overrides) {
      const runner = makeRunner(overrides);
      runner.start();
      return runner;
    },
    async claimSession(runnerId = "manual-runner") {
      const deadline = Date.now() + 5000;
      for (;;) {
        const [claimed] = await store.claimRuns({ runnerId, limit: 1, leaseMs: 30_000 });
        if (claimed !== undefined) {
          const session = startSession(deps(baseConfig), claimed, runnerId, () => undefined);
          // The session's own timers do not hold the event loop open; this one does, until the session unwinds.
          const alive = setInterval(() => undefined, 1000);
          void session.done.finally(() => clearInterval(alive));
          const core = session as unknown as SessionCore;
          return { session, core, violations: watchTurns(core) };
        }
        if (Date.now() >= deadline) throw new Error("no run could be claimed within 5000 ms");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    async crashAndReplace() {
      await harness.runner.abandon();
      abandoned.add(harness.runner);
      harness.runner = makeRunner();
      harness.runner.start();
      return harness.runner;
    },
  };
  if (options.autoStart ?? true) harness.runner.start();
  return harness;
}
