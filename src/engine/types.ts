import type { Json, JsonObject } from "../core/json.ts";
import type { Clock } from "../core/clock.ts";
import type { IdSource } from "../core/ids.ts";
import type { Redactor } from "../core/redact.ts";
import type { EphemeralEvents } from "../core/events.ts";
import type { Logger } from "../log/logger.ts";
import type { AgentDefinition, ToolPolicy } from "../agents/definition.ts";
import type {
  JournalRecord, LearningEffects, LearningKind, ModelPurpose, RunLimits, RunRecord, RunUsage, Store,
} from "../store/types.ts";
import type {
  Message, ModelRef, ModelRegistry, Pricing, StopReason, StructuredOutputSpec, ToolCall, ToolSpec, Usage,
} from "../models/types.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { FieldSpec } from "../store/record-fields.ts";

export interface PersonQuestion {
  question: string; choices?: string[];
  /** The instant (ms since epoch) at which the question is closed unanswered. A finite number, else `bad_request`. */
  expiresAt?: number;
}
export interface InboxMessage { commandId: string; text: string; at: number }
export interface MemoMeta {
  recordType: "step" | "node"; name: string; info?: JsonObject;
  /**
   * The field specification of the step's value: which field names are Runwright's own (written as they are)
   * and which values are text or payload. For a value this code built and reads back by field name. Default:
   * the whole value is a payload (every string, object key and secret-holding number redacted).
   */
  valueFields?: FieldSpec;
}
/** What an effect step plans: the value to memoise and the store writes that commit with it. */
export interface StepPlan<T extends Json> { value: T; learning?: LearningEffects }
export interface ModelStepRequest {
  purpose: ModelPurpose;
  system: string;
  messages: Message[];
  tools?: ToolSpec[];
  /**
   * result.output is validated against schema. An invalid first reply is journalled (model.invalid) and one repair
   * call follows as a second, separately admitted phase of the same step; still invalid → model_output_invalid.
   */
  output?: StructuredOutputSpec;
  /** Default: the agent's model. */
  model?: ModelRef;
  /** Default: model ref's, else config. */
  maxOutputTokens?: number;
  /** meta.step for scripted models. */
  step?: string;
  /** meta.turn; default: number of turn-counting calls so far + 1. */
  turn?: number;
  /** Default: purpose === "run". */
  countsAsTurn?: boolean;
  /** Default "pause"; "skip" throws RunwrightError("limit_reached") instead of opening a pending. */
  onLimit?: "pause" | "skip";
  /**
   * Covers the whole invocation, repair call included. Exceeded → model.interrupted + RunwrightError("deadline_exceeded").
   * A finite number of milliseconds greater than 0; anything else is `bad_request` before the step journals anything.
   */
  deadlineMs?: number;
  /**
   * The field specification of `output`: which field names are Runwright's own (written as they are) and which
   * values are text or payload. For an output this code reads back by field name. Default: the whole output is
   * a payload (every string, object key and secret-holding number redacted).
   */
  outputFields?: FieldSpec;
}
/** usage and costMicros are the step's totals: the repair call's plus the invalid first reply's when there was one. */
export interface ModelStepResult { text: string; toolCalls: ToolCall[]; output: Json; stopReason: StopReason; usage: Usage; costMicros: number | null }
/** `deadlineMs`: a finite number of milliseconds greater than 0 (`bad_request` before anything is journalled otherwise). */
export interface ToolStepCall { name: string; args: JsonObject; callId?: string; deadlineMs?: number }
export type ToolOutcome = "ok" | "error" | "denied" | "invalid_args" | "unknown_tool" | "skipped" | "aborted" | "timeout";
export interface ToolStepResult { content: string; data: Json; isError: boolean; outcome: ToolOutcome; untrusted: boolean }
export interface LearningGiven { itemId: string; version: number; kind: LearningKind; name: string; mode: "full" | "line" }
/** tools: extra tool names granted "allow". */
export interface LearningContext { promptSection: string; given: LearningGiven[]; tools: string[] }

export interface RunContext {
  /** As claimed. */
  readonly run: RunRecord;
  /** The pinned revision's definition. */
  readonly definition: AgentDefinition;
  readonly workspace: string;
  /** Aborted on cancel, lease loss and forced shutdown. */
  readonly signal: AbortSignal;
  readonly logger: Logger;
  /**
   * Over the secrets the run was handed so far: the definition's secrets and its model's key, plus the
   * credentials of every model the run has called (registered before each provider request). It is one object
   * that learns values while the run goes on; a value once registered stays registered.
   */
  readonly redactor: Redactor;
  readonly learning: LearningContext | null;
  /** Same run, keys prefixed with prefix + "/". */
  child(prefix: string): RunContext;
  model(key: string, request: ModelStepRequest): Promise<ModelStepResult>;
  /** Never throws for a tool failure. */
  tool(key: string, call: ToolStepCall): Promise<ToolStepResult>;
  ask(key: string, question: PersonQuestion): Promise<{ answer: string }>;
  /**
   * A memoised step: on replay the journalled value is returned and `fn` is not called. `fn` is told
   * `step.startedAt`, the `ts` of the step's `<recordType>.started` record (the one found on replay or the one just
   * committed), so every session that runs the step sees the same instant.
   */
  memo<T extends Json>(key: string, meta: MemoMeta, fn: (step: { startedAt: number }) => Promise<T>): Promise<T>;
  /**
   * A memoised step whose store writes commit in the same lease-fenced transaction as its
   * `<recordType>.finished` record: both happen, exactly once, or neither does. `plan` must only read. It runs
   * again after a crash that happened before the commit, and again when the commit throws "learning_conflict"
   * (at most 3 plans in all; the third conflict is rethrown). On replay the journalled value is returned and
   * `plan` is not called.
   */
  effect<T extends Json>(key: string, meta: MemoMeta, plan: () => Promise<StepPlan<T>>): Promise<T>;
  inbox(key: string): Promise<InboxMessage[]>;
  /**
   * Once per (key, type): journals a record of `type` under `key` and returns the stored record, or returns the one
   * already journalled (on replay, or when an earlier call wrote it), unchanged, whatever `data` is now. Its `ts`
   * is the instant the record was first stored, the same in every session.
   */
  emit(key: string, type: string, data: JsonObject): Promise<JournalRecord>;
  /**
   * Runs `body` under a deadline that covers every step started through `scoped` (and through any context derived
   * from it with `child`, at any depth). `scoped` uses the same key prefix as this context. When the deadline
   * passes: no further step starts (it throws `deadline_exceeded` before it journals anything), steps in flight
   * are aborted and journalled as a deadline hit them directly (`tool.finished {outcome: "timeout"}`,
   * `model.interrupted {reason: "deadline"}`), and `deadline` rejects with `deadline_exceeded` whatever `body`
   * returned or threw, except a control signal, which passes through unchanged (but see below for `waiting`).
   * The scope journals nothing. With `options.startedAt` (the journalled start of the step that owns it) it
   * expires at `startedAt + deadlineMs` in every session, so it holds across waits, pauses, releases and crashes:
   * entered at or after that instant, it closes the expired pendings and rejects with `deadline_exceeded` without
   * calling `body`. Without it the deadline is measured from the call. Every pending opened inside carries
   * `detail.expiresAt` (the earliest enclosing instant); when `body` leaves with `waiting` after the scope expired,
   * the expired pendings are closed and `deadline` rejects with `deadline_exceeded`. `startedAt` must be a finite
   * number (`bad_request`).
   */
  deadline<T>(deadlineMs: number, body: (scoped: RunContext) => Promise<T>, options?: { startedAt?: number }): Promise<T>;
  /** Not durable; ends early with a ControlSignal on cancel/pause/shutdown (and `deadline_exceeded` in a deadline scope). */
  sleep(ms: number): Promise<void>;
  /**
   * Waits until the engine clock (`EngineDeps.clock`) reads `at`, and never longer than `options.maxMs` from the
   * call (the engine applies the cap with its own clock, so a clock that stepped back between sessions cannot
   * stretch the wait); returns at once when `at` has already passed. A wait that ends at a journalled instant
   * (`record.ts + delay`) is therefore waited once in all, however often the run is paused, released or claimed
   * again. Ends early like `sleep`. `at` must be a finite number and `maxMs` a finite number >= 0 (`bad_request`).
   */
  sleepUntil(at: number, options?: { maxMs?: number }): Promise<void>;
  /** Tools this run may call through this context (policy not "deny"), optionally narrowed. */
  toolSpecs(names?: readonly string[]): ToolSpec[];
  /**
   * The policy a call of `tool` would get from this context right now: "deny" for a tool that is not registered.
   * `assumeGranted: true` answers as if the learning context granted the tool (used before the grant exists).
   */
  toolPolicy(tool: string, options?: { assumeGranted?: boolean }): ToolPolicy;
  /**
   * The same run and key prefix, restricted to `names`: every tool call made through the returned context, through
   * its children, and through anything those calls run (a workflow started by `run_workflow`, a nested hand-off)
   * is denied unless the tool is in `names`. Scopes nest by intersection.
   */
  withTools(names: readonly string[]): RunContext;
  limits(): RunLimits;
  usage(): RunUsage;
  /** Every record of this run so far, in order. */
  journal(): readonly JournalRecord[];
}
export type Driver = (context: RunContext) => Promise<Json>;
/** workflow is used when definition.workflow is set. */
export interface Drivers { agent: Driver; workflow: Driver }

/** `toolNames`: the hand-off's tools; the loop runs under `ctx.withTools(toolNames)`, so calls outside it are denied. */
export interface AgentLoopParams { instructions: string; message: string; toolNames?: readonly string[];
  output?: StructuredOutputSpec; maxTurns?: number; step?: string }
export interface AgentLoopResult { text: string; data: Json; turns: number }
export type AgentLoopFn = (context: RunContext, params: AgentLoopParams) => Promise<AgentLoopResult>;

export interface LearningHooks {
  /** Before the driver, when definition.learning. */
  prepare(context: RunContext): Promise<LearningContext | null>;
  /** After run.output, before completed. */
  afterRun(context: RunContext, outcome: { output: Json }): Promise<void>;
}
/** Missing names are absent. */
export interface SecretsReader { reveal(names: readonly string[]): Promise<Record<string, string>> }

export interface EngineConfig {
  runnerId?: string; concurrency: number; leaseMs: number; heartbeatMs: number; pollMs: number;
  workspacesDir: string; denyTools: readonly string[]; allowUnpricedModels: boolean;
  toolResultBytes: number; defaultMaxOutputTokens: number;
}
export interface EngineDeps {
  store: Store; clock: Clock; ids: IdSource; logger: Logger;
  tools: ToolRegistry; models: ModelRegistry; pricing: Pricing; drivers: Drivers;
  learning: LearningHooks | null; secrets: SecretsReader; events: EphemeralEvents | null; config: EngineConfig;
  /**
   * The timer behind `RunContext.sleep` and `RunContext.sleepUntil`: resolves after `ms`, rejects once `signal`
   * aborts. Default: `delay` (`src/core/clock.ts`). Tests that drive `clock` by hand pass a timer that follows it.
   */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}
export interface Runner {
  readonly id: string;
  /** Begins claiming; registers in `runners`. */
  start(): void;
  /** Stop claiming; let steps finish, then release (running → queued); after graceMs abort. */
  stop(options?: { graceMs?: number }): Promise<void>;
  /** Hard stop: abort everything and write nothing more (leases are left to expire). */
  abandon(): Promise<void>;
  activeRunIds(): string[];
}
