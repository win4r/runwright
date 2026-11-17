/**
 * The durable step primitives of a RunContext (plan 3.1, 3.4, 3.6). Each primitive looks its key up in the
 * replay index first and returns the journalled result when the step already finished; otherwise it does the
 * work behind the started/finished protocol. Everything is written through `core.commit`, which redacts the
 * batch, fences on a lost lease and applies the stored records to the index.
 */
import { delay, startTimer } from "../core/clock.ts";
import { RunwrightError, isRunwrightError } from "../core/errors.ts";
import { canonicalJson, type Json, type JsonObject } from "../core/json.ts";
import type { Logger } from "../log/logger.ts";
import type { GrowingRedactor } from "../core/redact.ts";
import type { AgentDefinition, ToolPolicy } from "../agents/definition.ts";
import { validateSchema, type SchemaProblem } from "../schema/validate.ts";
import { isFieldSpec, recordFieldsWith, redactBySpec, type FieldSpec, type ObjectSpec } from "../store/record-fields.ts";
import type {
  CommitBatch, JournalRecord, NewJournalRecord, NewPending, NewUsage, PendingKind, RunLimits, RunRecord, RunUsage,
} from "../store/types.ts";
import type {
  GenerateOptions, ModelProvider, ModelRef, ModelRequest, ModelResponse, ModelRetry, ToolSpec, Usage, UsageCount,
} from "../models/types.ts";
import { attemptBilling, backoffDelayMs, cooldownLeftMs, errorRetryAfterMs, errorStatus, retryAfterLimitMs } from "../models/retry.ts";
import { apiKeySecretName, modelKey, worstCaseInputTokens } from "../models/util.ts";
import type { ToolDefinition } from "../tools/types.ts";
import { ControlSignal, isControlSignal } from "./control.ts";
import { dataOf, newRecord, type InterruptedDetail, type JournalDataMap, type ToolInterruptReason } from "./journal-types.ts";
import type {
  EngineDeps, InboxMessage, LearningContext, MemoMeta, ModelStepRequest, ModelStepResult, PersonQuestion, RunContext,
  StepPlan, ToolStepCall, ToolStepResult,
} from "./types.ts";
import { checkCount, checkSpend, clampTotal, saturatingAdd, type SpendCheck } from "./budget.ts";
import { resolvePolicy, serverDenial } from "./policy.ts";
import {
  argsPreview, deniedContent, errorContent, errorFromRecord, fromToolOutput, invalidArgsContent, limitToolResult,
  modelStepResult, toolStepResult, unknownToolContent, type ShapedToolResult,
} from "./results.ts";
import {
  lastModelRecord, lastToolRecord, latestPending, latestRecord, pendingExpiry, type PendingEntry, type ReplayState,
} from "./state.ts";

/** Why an in-flight call was aborted. */
export type AbortCause = "cancel" | "shutdown" | "lease_lost" | "pause" | "stop" | "deadline";

export interface CallHandle {
  readonly signal: AbortSignal;
  /** The first cause that aborted this call, or null. */
  cause(): AbortCause | null;
  dispose(): void;
}

/** What the primitives need from the session that owns them. */
export interface SessionCore {
  readonly deps: EngineDeps;
  readonly run: RunRecord;
  readonly definition: AgentDefinition;
  readonly workspace: string;
  /** Aborted on cancel, lease loss and forced shutdown. */
  readonly signal: AbortSignal;
  readonly logger: Logger;
  /**
   * The run's redactor (invariant R1): one object for the session, never replaced. Every model step registers the
   * credentials it is about to send before its first provider request; values stay registered.
   */
  readonly redactor: GrowingRedactor;
  /** Secrets named by the definition (what tools receive). */
  readonly toolSecrets: Readonly<Record<string, string>>;
  readonly state: ReplayState;
  learning: LearningContext | null;
  /** Shared by every child context: one promise per in-flight step. */
  readonly inflight: Map<string, Promise<unknown>>;
  readonly reserved: { micros: number; turns: number; toolStarts: number };
  /**
   * The turn hold of every open repair (a structured-output step whose first reply was journalled model.invalid and
   * whose closing record is not yet applied), by step key. Exactly one entry per open repair: moved here when its
   * model.invalid is applied, or created when the session claims the run; removed only when its closing record
   * (model.finished, model.failed, model.interrupted {reason: "deadline"}) is applied. Shared by every derived core.
   */
  readonly repairTurns: Map<string, Hold>;
  /** Throws the ControlSignal that stops execution now, if any. */
  checkControl(): void;
  /**
   * Serialized, redacted commit; returns the stored records. Throws ControlSignal("lease_lost") when fenced.
   * `batch` may be a function: it is called inside the session's commit lock, after every earlier commit was
   * applied to the state, so a batch built from the state cannot be overtaken by another commit; when it returns
   * null nothing is committed and the result is []. `onApplied` runs synchronously right after the stored records
   * are applied to the state (not at all when nothing was committed).
   */
  commit(batch: CommitBatch | (() => CommitBatch | null), onApplied?: () => void): Promise<JournalRecord[]>;
  /** An abort handle linked to the run signal, and to pause / graceful stop / a deadline as requested. */
  register(options: { onPause: boolean; onStop: boolean; deadlineMs?: number }): CallHandle;
  /** The earliest instant at which an enclosing deadline scope expires, or null outside every scope. */
  deadlineAt(): number | null;
  /** Applies the commands that have arrived, then closes every open pending whose `detail.expiresAt` has passed. */
  expirePendings(): Promise<void>;
  /**
   * The tools a call made through this core may use (RunContext.withTools), or null when no scope restricts it.
   * Every core derived from this one (a child, a deadline scope, the steps of a tool call) has the same scope or,
   * when it is narrowed again, the intersection.
   */
  toolScope(): ReadonlySet<string> | null;
}

const ENGINE_TYPES = new Set<string>([
  "run.created", "run.claimed", "command.applied", "command.rejected", "limits.changed", "inbox.taken",
  "model.started", "model.invalid", "model.finished", "model.interrupted", "model.failed", "model.retry",
  "tool.started", "tool.finished", "tool.interrupted", "pending.opened", "pending.resolved",
  "step.started", "step.finished", "node.started", "node.finished",
  "run.output", "message.undelivered", "run.waiting", "run.paused", "run.released", "run.completed", "run.failed", "run.cancelled",
]);

function signalFor(cause: AbortCause): Error {
  switch (cause) {
    case "cancel":
      return new ControlSignal("cancelled");
    case "shutdown":
    case "stop":
      return new ControlSignal("released");
    case "lease_lost":
      return new ControlSignal("lease_lost");
    case "pause":
      return new ControlSignal("paused");
    case "deadline":
      return new RunwrightError("deadline_exceeded", "the step's deadline passed");
  }
}

function firstLine(text: string, max = 200): string {
  const line = text.split(/\r?\n/, 1)[0] ?? "";
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

function formatMicros(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(6)}`;
}

/** A provider's usage as whole counts from 0 to Number.MAX_SAFE_INTEGER (plan C9): anything else reads as 0. */
function normalUsage(usage: Partial<Usage> | undefined): Usage {
  const n = (v: number | undefined): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? clampTotal(Math.floor(v)) : 0);
  return {
    inputTokens: n(usage?.inputTokens),
    outputTokens: n(usage?.outputTokens),
    cacheReadTokens: n(usage?.cacheReadTokens),
    cacheWriteTokens: n(usage?.cacheWriteTokens),
  };
}

/**
 * A call handle aborted when either `own` or `enclosing` aborts. Its cause is its own, else the enclosing one, so
 * code that branches on `cause()` journals an abort that came from the enclosing call exactly as if it had hit
 * this call directly.
 */
function linkHandle(own: CallHandle, enclosing: CallHandle): CallHandle {
  return {
    signal: AbortSignal.any([own.signal, enclosing.signal]),
    cause: () => own.cause() ?? enclosing.cause(),
    dispose: () => own.dispose(),
  };
}

/** What a derived core replaces of the core it wraps; everything it does not name is the wrapped core's own. */
interface CoreOverrides {
  signal?: () => AbortSignal;
  checkControl?: () => void;
  register?: SessionCore["register"];
  deadlineAt?: () => number | null;
  toolScope?: () => ReadonlySet<string> | null;
}

/**
 * A core over `core` with `overrides` applied. Every member it does not override reads through to `core` at the
 * time of use (never a snapshot), so `learning`, `state` and the commit lock stay the session's own.
 */
function derivedCore(core: SessionCore, overrides: CoreOverrides): SessionCore {
  return {
    get deps() {
      return core.deps;
    },
    get run() {
      return core.run;
    },
    get definition() {
      return core.definition;
    },
    get workspace() {
      return core.workspace;
    },
    get signal() {
      return overrides.signal === undefined ? core.signal : overrides.signal();
    },
    get logger() {
      return core.logger;
    },
    get redactor() {
      return core.redactor;
    },
    get toolSecrets() {
      return core.toolSecrets;
    },
    get state() {
      return core.state;
    },
    get learning() {
      return core.learning;
    },
    set learning(value: LearningContext | null) {
      core.learning = value;
    },
    get inflight() {
      return core.inflight;
    },
    get reserved() {
      return core.reserved;
    },
    get repairTurns() {
      return core.repairTurns;
    },
    checkControl: overrides.checkControl ?? (() => core.checkControl()),
    commit: (batch, onApplied) => core.commit(batch, onApplied),
    register: overrides.register ?? ((options) => core.register(options)),
    deadlineAt: overrides.deadlineAt ?? (() => core.deadlineAt()),
    expirePendings: () => core.expirePendings(),
    toolScope: overrides.toolScope ?? (() => core.toolScope()),
  };
}

/**
 * The session core as seen by steps nested in a tool call (plan 4.6) or run inside a deadline scope: the step
 * boundary check also stops once the enclosing handle is aborted, every handle a nested step registers is linked
 * to the enclosing one, and the context's signal is the enclosing handle's signal. Everything else (the tool
 * scope included) is the wrapped core's. `core` may itself be derived, so tool calls and deadline scopes nest at
 * any depth.
 * `expiresAt`: the instant of the deadline scope this core wraps (absent for a tool call); `deadlineAt()` is the
 * earlier of it and the wrapped core's.
 */
function enclosedCore(core: SessionCore, enclosing: CallHandle, expiresAt?: number): SessionCore {
  return derivedCore(core, {
    signal: () => enclosing.signal,
    checkControl: () => {
      core.checkControl();
      const cause = enclosing.cause();
      if (cause !== null) throw signalFor(cause);
    },
    register: (options) => linkHandle(core.register(options), enclosing),
    deadlineAt: () => {
      const outer = core.deadlineAt();
      if (expiresAt === undefined) return outer;
      return outer === null ? expiresAt : Math.min(outer, expiresAt);
    },
  });
}

/**
 * The session core restricted to the tools in `names` (contract C3): its tool scope is `names` intersected with
 * the wrapped core's scope (just `names` when that has none). Everything else is the wrapped core's.
 */
function scopedCore(core: SessionCore, names: readonly string[]): SessionCore {
  const outer = core.toolScope();
  const scope: ReadonlySet<string> = new Set(names.filter((name) => outer === null || outer.has(name)));
  return derivedCore(core, { toolScope: () => scope });
}

/**
 * Creates the RunContext over a session core; keys are prefixed with `prefix` (empty at the root).
 * `enclosing`: the abort handle of the tool call whose handler owns this context (null at the root). Once it is
 * aborted no further step starts, and the steps in flight are aborted with its cause.
 */
export function createRunContext(core: SessionCore, prefix: string, enclosing: CallHandle | null = null): RunContext {
  return contextOver(enclosing === null ? core : enclosedCore(core, enclosing), prefix);
}

const BAD_DEADLINE = "a deadline must be a finite number of milliseconds greater than 0";
const BAD_STARTED_AT = "a deadline's startedAt must be a finite number";
const BAD_EXPIRES_AT = "a question's expiresAt must be a finite number";
const BAD_SLEEP_AT = "sleepUntil needs a finite instant";
const BAD_SLEEP_MAX = "sleepUntil's maxMs must be a finite number of milliseconds >= 0";

/** Messages of `deadline_exceeded` when a step finds its pending closed as expired (plan 3.5). */
const QUESTION_EXPIRED = "the question was not answered before its deadline";
const APPROVAL_EXPIRED = "the tool call was not approved before the deadline";
const INTERRUPTED_EXPIRED = "the interrupted tool call was not resolved before the deadline";
const LIMIT_EXPIRED = "the limit was not raised before the deadline";
/** A pending would have been opened at or after its instant: nothing is opened. */
const PENDING_TOO_LATE = "the deadline passed";

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validDeadline(deadlineMs: unknown): boolean {
  return typeof deadlineMs === "number" && Number.isFinite(deadlineMs) && deadlineMs > 0;
}

/** A step's optional `deadlineMs` is checked before the step journals anything. */
function checkStepDeadline(deadlineMs: number | undefined): void {
  if (deadlineMs !== undefined && !validDeadline(deadlineMs)) throw new RunwrightError("bad_request", BAD_DEADLINE);
}

/**
 * The `fields` of a `type` record whose `field` holds a value with the declared specification `spec` (rule H):
 * undefined when nothing was declared; `bad_request` with `message` when `spec` is not a field specification.
 * Called once, before the step journals anything; the result is a frozen copy, used for every commit of the step.
 */
function declaredFields(type: string, field: string, spec: FieldSpec | undefined, message: string): ObjectSpec | undefined {
  if (spec === undefined) return undefined;
  if (!isFieldSpec(spec)) throw new RunwrightError("bad_request", message);
  return recordFieldsWith(type, field, spec);
}

const BAD_VALUE_FIELDS = '"valueFields" is not a field specification';
const BAD_OUTPUT_FIELDS = '"outputFields" is not a field specification';

/**
 * The abort handle of a deadline scope: aborted by its own timer (cause "deadline") after `remainingMs` (what is
 * left until the scope's instant) and by whatever aborts a handle registered on `core` without pause or stop (a
 * cancel, a lost lease, a forced shutdown, an enclosing tool call or scope). `expired()` says whether this scope's
 * own timer fired, whatever aborted the handle first.
 */
function scopeHandle(core: SessionCore, remainingMs: number): { handle: CallHandle; expired(): boolean } {
  const base = core.register({ onPause: false, onStop: false });
  const own = new AbortController();
  let expired = false;
  let ownCause: AbortCause | null = null;
  const timer = startTimer(() => {
    expired = true;
    if (base.cause() === null) ownCause = "deadline";
    own.abort(new RunwrightError("aborted", "aborted: deadline"));
  }, remainingMs);
  return {
    handle: {
      signal: AbortSignal.any([own.signal, base.signal]),
      cause: () => ownCause ?? base.cause(),
      dispose: () => {
        timer.clear();
        base.dispose();
      },
    },
    expired: () => expired,
  };
}

/**
 * The wait of `ctx.sleep` and `ctx.sleepUntil`: `ms` on the engine's timer (`deps.sleep`, default `delay`), ended
 * early with the control signal of a cancel, pause, stop or shutdown (`deadline_exceeded` in a deadline scope).
 * The step boundary is checked again once it is over.
 */
async function pauseFor(core: SessionCore, ms: number): Promise<void> {
  const handle = core.register({ onPause: true, onStop: true });
  try {
    await (core.deps.sleep ?? delay)(ms, handle.signal);
  } catch (error) {
    const cause = handle.cause();
    if (cause !== null) throw signalFor(cause);
    throw error;
  } finally {
    handle.dispose();
  }
  core.checkControl();
}

function contextOver(core: SessionCore, prefix: string): RunContext {
  const full = (key: string): string => `${prefix}${key}`;

  const once = <T>(kind: string, key: string, work: () => Promise<T>): Promise<T> => {
    core.checkControl();
    const slot = `${kind}:${key}`;
    const existing = core.inflight.get(slot);
    if (existing !== undefined) return existing as Promise<T>;
    const promise = work().finally(() => {
      core.inflight.delete(slot);
    });
    core.inflight.set(slot, promise);
    return promise;
  };

  const context: RunContext = {
    get run() {
      return core.run;
    },
    get definition() {
      return core.definition;
    },
    get workspace() {
      return core.workspace;
    },
    get signal() {
      return core.signal;
    },
    get logger() {
      return core.logger;
    },
    get redactor() {
      return core.redactor;
    },
    get learning() {
      return core.learning;
    },
    child(childPrefix: string): RunContext {
      return contextOver(core, `${prefix}${childPrefix}/`);
    },
    async deadline<T>(deadlineMs: number, body: (scoped: RunContext) => Promise<T>, options?: { startedAt?: number }): Promise<T> {
      core.checkControl();
      if (!validDeadline(deadlineMs)) throw new RunwrightError("bad_request", BAD_DEADLINE);
      const startedAt = options?.startedAt;
      if (startedAt !== undefined && !finiteNumber(startedAt)) throw new RunwrightError("bad_request", BAD_STARTED_AT);
      const clock = core.deps.clock;
      const now = clock.now();
      const expiresAt = (startedAt ?? now) + deadlineMs;
      const exceeded = (): RunwrightError => new RunwrightError("deadline_exceeded", `the deadline of ${deadlineMs} ms passed`);
      // Entered at or after its instant (the run was away while it passed): close what expired, run nothing.
      if (now >= expiresAt) {
        await core.expirePendings();
        throw exceeded();
      }
      const scope = scopeHandle(core, expiresAt - now);
      let outcome: { ok: true; value: T } | { ok: false; error: unknown };
      try {
        outcome = { ok: true, value: await body(contextOver(enclosedCore(core, scope.handle, expiresAt), prefix)) };
      } catch (error) {
        outcome = { ok: false, error };
      } finally {
        scope.handle.dispose();
      }
      if (!outcome.ok && isControlSignal(outcome.error)) {
        // Waiting on a person past the scope's instant would only wake the run to fail it: fail it now.
        if (outcome.error.reason === "waiting" && (scope.expired() || clock.now() >= expiresAt)) {
          await core.expirePendings();
          throw exceeded();
        }
        throw outcome.error;
      }
      if (scope.expired()) throw exceeded();
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    },
    model(key: string, request: ModelStepRequest): Promise<ModelStepResult> {
      const k = full(key);
      return once("model", k, () => runModel(core, k, request));
    },
    tool(key: string, call: ToolStepCall): Promise<ToolStepResult> {
      const k = full(key);
      return once("tool", k, () => runTool(core, k, call));
    },
    ask(key: string, question: PersonQuestion): Promise<{ answer: string }> {
      const k = full(key);
      return once("ask", k, () => runAsk(core, k, question));
    },
    memo<T extends Json>(key: string, meta: MemoMeta, fn: (step: { startedAt: number }) => Promise<T>): Promise<T> {
      const k = full(key);
      return once("memo", k, () => runMemo(core, k, meta, fn));
    },
    effect<T extends Json>(key: string, meta: MemoMeta, plan: () => Promise<StepPlan<T>>): Promise<T> {
      const k = full(key);
      return once("effect", k, () => runEffect(core, k, meta, plan));
    },
    inbox(key: string): Promise<InboxMessage[]> {
      const k = full(key);
      return once("inbox", k, () => runInbox(core, k));
    },
    emit(key: string, type: string, data: JsonObject): Promise<JournalRecord> {
      const k = full(key);
      return once(`emit:${type}`, k, () => runEmit(core, k, type, data));
    },
    sleep(ms: number): Promise<void> {
      core.checkControl();
      return pauseFor(core, ms);
    },
    async sleepUntil(at: number, options?: { maxMs?: number }): Promise<void> {
      core.checkControl();
      if (!finiteNumber(at)) throw new RunwrightError("bad_request", BAD_SLEEP_AT);
      const maxMs = options?.maxMs;
      if (maxMs !== undefined && !(finiteNumber(maxMs) && maxMs >= 0)) throw new RunwrightError("bad_request", BAD_SLEEP_MAX);
      const left = at - core.deps.clock.now();
      const ms = maxMs === undefined ? left : Math.min(left, maxMs);
      if (ms > 0) await pauseFor(core, ms);
    },
    toolSpecs(names?: readonly string[]): ToolSpec[] {
      return allowedTools(core, names).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
    },
    toolPolicy(tool: string, options?: { assumeGranted?: boolean }): ToolPolicy {
      const registered = core.deps.tools.get(tool);
      if (registered === null) return "deny";
      return policyFor(core, tool, registered, options?.assumeGranted === true).policy;
    },
    withTools(names: readonly string[]): RunContext {
      return contextOver(scopedCore(core, names), prefix);
    },
    limits(): RunLimits {
      return { ...core.state.limits };
    },
    usage(): RunUsage {
      return { ...core.state.usage };
    },
    journal(): readonly JournalRecord[] {
      return core.state.records;
    },
  };
  return context;
}

/**
 * The policy of a call of `name` made through `core`: the one resolver (resolvePolicy, contract C2) over the
 * server deny list, the core's tool scope, the agent's entry and the learning grants. `assumeGranted`: as if the
 * learning context granted `name` as well.
 */
function policyFor(
  core: SessionCore, name: string, tool: ToolDefinition | null, assumeGranted = false,
): { policy: ToolPolicy; reason: string } {
  const granted = core.learning?.tools ?? [];
  return resolvePolicy({
    tool: name,
    definition: core.definition,
    registryDefault: tool?.defaultPolicy,
    denyTools: core.deps.config.denyTools,
    scope: core.toolScope(),
    granted: assumeGranted ? granted.concat([name]) : granted,
    approvedAlways: [...core.state.approvedAlways],
  });
}

/**
 * The registered tools the agent lists or the learning context grants, narrowed to `names` when given, whose
 * policy through `core` is not "deny" (so the tool scope applies too).
 */
function allowedTools(core: SessionCore, names?: readonly string[]): ToolDefinition[] {
  const listed = new Set<string>([...core.definition.tools.map((t) => t.name), ...(core.learning?.tools ?? [])]);
  const wanted = names === undefined ? null : new Set(names);
  return core.deps.tools.list().filter((tool) => listed.has(tool.name)
    && (wanted === null || wanted.has(tool.name))
    && policyFor(core, tool.name, tool).policy !== "deny");
}

/**
 * The instant a pending opened now would carry: the earlier of `own` (a question's own) and the enclosing
 * deadline scopes' `core.deadlineAt()`, or null when there is neither.
 */
function pendingInstant(core: SessionCore, own?: number): number | null {
  const enclosing = core.deadlineAt();
  if (own === undefined) return enclosing;
  return enclosing === null ? own : Math.min(own, enclosing);
}

/**
 * `detail` with the `expiresAt` of a pending opened now, or `deadline_exceeded` (PENDING_TOO_LATE, nothing
 * written) when that instant has already passed.
 */
function timedDetail(core: SessionCore, detail: JsonObject, own?: number): JsonObject {
  const at = pendingInstant(core, own);
  if (at === null) return detail;
  if (core.deps.clock.now() >= at) throw new RunwrightError("deadline_exceeded", PENDING_TOO_LATE);
  return { ...detail, expiresAt: at };
}

/**
 * The pending a step waits on (plan 3.5, one rule for every reader): the newest of `kind` at `key` (when `pick`
 * accepts it). Open and not expired: suspends (ControlSignal "waiting"). Open and expired: `core.expirePendings()`
 * (a command that arrived in time is applied first and wins), then it is read once more. Resolved with
 * `expired: true`: `deadline_exceeded` with `message`. Otherwise the resolved pending is returned for the caller's
 * own reading; null when there is no pending yet.
 */
async function settledPending(
  core: SessionCore, key: string, kind: PendingKind, message: string, pick?: (pending: PendingEntry) => boolean,
): Promise<PendingEntry | null> {
  const read = (): PendingEntry | null => {
    const latest = latestPending(core.state, key, kind);
    return latest !== null && (pick === undefined || pick(latest)) ? latest : null;
  };
  let pending = read();
  if (pending === null) return null;
  if (pending.status === "open") {
    const at = pendingExpiry(pending);
    if (at === null || core.deps.clock.now() < at) throw new ControlSignal("waiting");
    await core.expirePendings();
    pending = read();
    if (pending === null || pending.status === "open") throw new ControlSignal("waiting");
  }
  if (pending.resolution?.["expired"] === true) throw new RunwrightError("deadline_exceeded", message);
  return pending;
}

/**
 * Opens a pending and suspends the run. `still`, when given, is asked inside the commit lock whether the pending is
 * still needed; when it is not, nothing is written and the run is suspended all the same: what made it unneeded
 * was a command applied while this driver ran, so the session runs the driver again instead of leaving `running`.
 * Inside a deadline the detail carries `expiresAt` (with `own`, the earlier of the two instants); a pending whose
 * instant has already passed is not opened (`deadline_exceeded`).
 */
async function openPending(
  core: SessionCore, stepKey: string, kind: PendingKind, title: string, detail: JsonObject, still?: () => boolean, own?: number,
): Promise<never> {
  const pending: NewPending = { id: core.deps.ids.next("pend"), kind, stepKey, title, detail: timedDetail(core, detail, own) };
  const stored = await core.commit(() => (still !== undefined && !still()
    ? null
    : { records: [newRecord("pending.opened", { pending }, stepKey)], openPendings: [pending] }));
  if (stored.length > 0) core.logger.debug("pending.opened", { key: stepKey, kind, pendingId: pending.id });
  throw new ControlSignal("waiting");
}

/**
 * A limit check against `checked` (the limits object the check read) failed: skip → limit_reached; an open
 * pending → wait; one closed as expired → deadline_exceeded (it is not reopened); otherwise open a fresh pending
 * and wait. The pending is not opened when the limits changed before its commit: a limits command applied
 * meanwhile found no pending to resolve, so the step is checked again.
 */
async function limitPending(
  core: SessionCore, key: string, kind: PendingKind, title: string, detail: JsonObject, onLimit: "pause" | "skip", checked: RunLimits,
): Promise<never> {
  if (onLimit === "skip") throw new RunwrightError("limit_reached", title, { details: { kind, ...detail } });
  await settledPending(core, key, kind, LIMIT_EXPIRED);
  return openPending(core, key, kind, title, detail, () => core.state.limits === checked);
}

// ------------------------------------------------------------------ model

/** Part of core.reserved held by one in-flight call or open repair; release() is idempotent. */
export interface Hold { release(): void }

/** `micros` is a call's worst case (at most Number.MAX_SAFE_INTEGER); released by subtracting exactly what was added. */
function hold(core: Pick<SessionCore, "reserved">, micros: number, turns: number): Hold {
  core.reserved.micros += micros;
  core.reserved.turns += turns;
  let held = true;
  return {
    release(): void {
      if (!held) return;
      held = false;
      core.reserved.micros -= micros;
      core.reserved.turns -= turns;
    },
  };
}

/**
 * Reserves the turn of the open repair at `key` unless it already is (one hold per open repair): called by the
 * session for every open repair it finds when it claims the run, and by a repair entered through a core that has
 * no entry yet.
 */
export function holdRepairTurn(core: Pick<SessionCore, "reserved" | "repairTurns">, key: string): void {
  if (core.repairTurns.has(key)) return;
  core.repairTurns.set(key, hold(core, 0, 1));
}

/** Frees the turn of the open repair at `key`: only as the closing record of that key is applied. */
function releaseRepairTurn(core: Pick<SessionCore, "repairTurns">, key: string): void {
  const held = core.repairTurns.get(key);
  if (held === undefined) return;
  core.repairTurns.delete(key);
  held.release();
}

function releaseAll(...holds: (Hold | null)[]): () => void {
  return () => {
    for (const h of holds) h?.release();
  };
}

/** One provider call of a model step, as admitted. */
interface ModelCall {
  model: string;
  request: ModelRequest;
  estimate: number;
  worstCase: number | null;
  countsAsTurn: boolean;
  repair: boolean;
}

/**
 * A reply as it is charged (rule U): `usage` holds the reported counts with every count the provider did not
 * report replaced by its reserved bound, `assumed` names those counts (empty when everything was reported), and
 * `costMicros` prices that usage.
 */
interface CallOutcome {
  response: ModelResponse; usage: Usage; costMicros: number | null; durationMs: number; assumed: readonly UsageCount[];
}

/** The `usageAssumed` field of a billed record: present only when a count was assumed. */
function assumedField(outcome: CallOutcome): { usageAssumed?: UsageCount[] } {
  return outcome.assumed.length === 0 ? {} : { usageAssumed: [...outcome.assumed] };
}

/**
 * What a reply of `call` is charged (rule U). Reported counts are charged as reported. A count the provider did
 * not report (`response.usageMissing`) is charged the bound the attempt was reserved with: a missing input count
 * is `call.estimate` input tokens (no cache tokens) priced at the highest input-side rate, as the worst case
 * prices them; a missing output count is `maxOutputTokens`. So a reply is never charged more than its worst case
 * W unless the provider reported more, and a missing count is never charged less than its bound. An unpriced
 * model stays unpriced (null).
 */
function chargedReply(core: SessionCore, call: ModelCall, response: ModelResponse, durationMs: number): CallOutcome {
  const usage = normalUsage(response.usage);
  const named = Array.isArray(response.usageMissing) ? response.usageMissing : [];
  const assumed = (["input", "output"] as const).filter((count) => named.includes(count));
  if (assumed.includes("input")) {
    usage.inputTokens = call.estimate;
    usage.cacheReadTokens = 0;
    usage.cacheWriteTokens = 0;
  }
  if (assumed.includes("output")) usage.outputTokens = clampTotal(call.request.maxOutputTokens);
  const ref = call.request.model;
  const pricing = core.deps.pricing;
  const cost = assumed.includes("input")
    ? pricing.worstCaseMicros(ref, usage.inputTokens, usage.outputTokens)
    : pricing.costMicros(ref, usage);
  return { response, usage, costMicros: cost === null ? null : clampTotal(cost), durationMs, assumed };
}

function spendTitle(model: string, detail: JsonObject): string {
  const needed = detail["neededMicros"];
  return typeof needed === "number"
    ? `Spend cap reached: the next ${model} call needs ${formatMicros(needed)} more`
    : `Spend cap is set but ${model} has no known price`;
}

/**
 * What is wrong with a structured reply (plan 3.2, invariant O2): nothing without an output spec; a reply that
 * carried no output at all is one problem, never a null to validate; otherwise the schema's problems.
 */
function replyProblems(step: ModelStepRequest, response: ModelResponse): SchemaProblem[] {
  if (step.output === undefined) return [];
  if (response.outputMissing === true) return [{ path: "$", keyword: "output", message: "the reply carried no structured output" }];
  return validateSchema(step.output.schema, response.output);
}

function problemList(problems: readonly { path: string; message: string }[]): string {
  return problems.map((p) => `${p.path}: ${p.message}`).join("; ");
}

/** Where a model call resumes, decided by the last model record of its key (plan 4.1). */
export type ModelResume =
  | { kind: "attempt"; attempt: number }
  | { kind: "crashed"; attempt: number; started: JournalDataMap["model.started"] }
  | { kind: "finished"; data: JournalDataMap["model.finished"] }
  | { kind: "failed"; data: JournalDataMap["model.failed"] }
  | { kind: "deadline" };

/**
 * The resume point of a model call. `last` is the key's last model record (a `model.retry` counts only when it
 * carries `billing`, see ReplayState). After `model.retry {attempt: n}` the next attempt is n + 1; after an
 * unfinished `model.started {attempt: n}` (a crash) or `model.interrupted {attempt: n}` it is n again. A missing
 * `attempt` reads as 1; no record, or `model.invalid` (the repair phase starts), is attempt 1.
 */
export function modelResumePoint(last: JournalRecord | null): ModelResume {
  if (last === null) return { kind: "attempt", attempt: 1 };
  const finished = dataOf(last, "model.finished");
  if (finished !== null) return { kind: "finished", data: finished };
  const failed = dataOf(last, "model.failed");
  if (failed !== null) return { kind: "failed", data: failed };
  const interrupted = dataOf(last, "model.interrupted");
  if (interrupted !== null) {
    return interrupted.reason === "deadline" ? { kind: "deadline" } : { kind: "attempt", attempt: interrupted.attempt ?? 1 };
  }
  const started = dataOf(last, "model.started");
  if (started !== null) return { kind: "crashed", attempt: started.attempt ?? 1, started };
  const retry = dataOf(last, "model.retry");
  if (retry !== null) return { kind: "attempt", attempt: retry.attempt + 1 };
  return { kind: "attempt", attempt: 1 };
}

/** An attempt journalled as started whose closing record is missing (plan 4.1, invariant M). */
export interface UnfinishedModelStart { key: string; started: JournalDataMap["model.started"]; attempt: number }

/**
 * Every key whose last model record is a `model.started`: an attempt that may have been sent and was neither
 * answered nor charged. At a claim nothing is in flight yet, so each one was left by a crash.
 */
export function unfinishedModelStarts(state: ReplayState): UnfinishedModelStart[] {
  const out: UnfinishedModelStart[] = [];
  for (const [key, entry] of state.keys) {
    const resume = modelResumePoint(entry.lastModel);
    if (resume.kind === "crashed") out.push({ key, started: resume.started, attempt: resume.attempt });
  }
  return out;
}

/**
 * Every key with an open repair whose turn counts: a `model.invalid` and no closing record after it (its last
 * model record is not a model.finished, a model.failed or a model.interrupted {reason: "deadline"}), whose latest
 * model.started has `countsAsTurn`. Its turn was admitted in phase 1 and is counted only when the step finishes,
 * so a session that claims the run reserves it before any step is admitted.
 */
export function openRepairs(state: ReplayState): string[] {
  const out: string[] = [];
  for (const [key, entry] of state.keys) {
    if (!entry.latest.has("model.invalid")) continue;
    const resume = modelResumePoint(entry.lastModel);
    if (resume.kind === "finished" || resume.kind === "failed" || resume.kind === "deadline") continue;
    const started = entry.latest.get("model.started");
    const data = started === undefined ? null : dataOf(started, "model.started");
    if (data?.countsAsTurn === true) out.push(key);
  }
  return out;
}

/**
 * The closing records of unfinished attempts: per entry, `model.interrupted {reason: "crash"}` under its key,
 * charged the attempt's worst case, and its assumed usage row (the started record's estimates).
 */
export function interruptedBatch(entries: readonly UnfinishedModelStart[]): { records: NewJournalRecord[]; usage: NewUsage[] } {
  const records: NewJournalRecord[] = [];
  const usage: NewUsage[] = [];
  for (const { key, started, attempt } of entries) {
    records.push(newRecord("model.interrupted", {
      model: started.model, reason: "crash", assumedCostMicros: started.worstCaseMicros, attempt,
    }, key));
    usage.push({
      model: started.model, purpose: started.purpose, inputTokens: started.inputTokensEstimate,
      outputTokens: started.maxOutputTokens, cacheReadTokens: 0, cacheWriteTokens: 0,
      costMicros: started.worstCaseMicros, assumed: true,
    });
  }
  return { records, usage };
}

/** The assumed charge of one attempt of `call`: its worst case, as plan 3.2 defines the usage row. */
function assumedUsage(call: ModelCall, purpose: ModelStepRequest["purpose"]): NewUsage {
  return {
    model: call.model, purpose, inputTokens: call.estimate, outputTokens: call.request.maxOutputTokens,
    cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: call.worstCase, assumed: true,
  };
}

/**
 * A model step (plan 4.1, 4.2). Phase 1 is the first call; when its structured output is invalid it is journalled
 * as model.invalid and the step continues in the repair phase, whose call is admitted, reserved and journalled on
 * its own under the same key. Each call is a sequence of provider attempts (callWithAttempts). A resumed step picks
 * its phase and attempt from the journal, so no reply is requested twice and no attempt number is reused after a
 * provider failure.
 */
async function runModel(core: SessionCore, key: string, step: ModelStepRequest): Promise<ModelStepResult> {
  checkStepDeadline(step.deadlineMs);
  const outputFields = declaredFields("model.finished", "output", step.outputFields, BAD_OUTPUT_FIELDS);
  const { deps, state } = core;
  const invokedAt = deps.clock.now();
  const last = lastModelRecord(state, key);
  const resume = modelResumePoint(last);
  if (resume.kind === "finished") return modelStepResult(resume.data, invalidOf(state, key));
  if (resume.kind === "failed") {
    throw errorFromRecord(resume.data.error, "model_failed", replayedWaitDetails(last, resume.data, deps.clock.now()));
  }
  if (resume.kind === "deadline") throw new RunwrightError("deadline_exceeded", "the model step's deadline passed");
  if (resume.kind === "crashed") {
    // The session settles every unfinished attempt when it claims the run, so this is only reached by a core
    // that did not; it is settled through the same batch.
    await core.commit(interruptedBatch([{ key, started: resume.started, attempt: resume.attempt }]));
    core.logger.debug("model.interrupted", { key, reason: "crash", attempt: resume.attempt });
  }
  const resumeAttempt = resume.attempt;
  const resumeWait = providerWaitOf(last);

  const ref = step.model ?? core.definition.model;
  const model = modelKey(ref);
  const countsAsTurn = step.countsAsTurn ?? step.purpose === "run";
  const maxOutputTokens = clampTotal(step.maxOutputTokens ?? ref.maxOutputTokens ?? deps.config.defaultMaxOutputTokens);
  const onLimit = step.onLimit ?? "pause";
  const deadlineAt = step.deadlineMs === undefined ? null : invokedAt + step.deadlineMs;
  const remaining = (): number | undefined => (deadlineAt === null ? undefined : Math.max(0, deadlineAt - deps.clock.now()));
  const baseRequest = (turn: number): ModelRequest => ({
    model: ref,
    system: step.system,
    messages: step.messages,
    tools: step.tools ?? [],
    output: step.output ?? null,
    maxOutputTokens,
    meta: { runId: core.run.id, key, purpose: step.purpose, turn, step: step.step ?? null, attempt: 1 },
  });
  const callOf = (request: ModelRequest, repair: boolean): ModelCall => {
    const estimate = clampTotal(worstCaseInputTokens(request));
    const worstCase = deps.pricing.worstCaseMicros(ref, estimate, maxOutputTokens);
    return { model, request, estimate, worstCase: worstCase === null ? null : clampTotal(worstCase), countsAsTurn, repair };
  };

  let provider: ModelProvider;
  try {
    provider = await resolveRegistered(core, ref);
  } catch (error) {
    if (isControlSignal(error)) throw error;
    const info = isRunwrightError(error) ? error : new RunwrightError("model_failed", errorContent(error));
    await core.commit({ records: [newRecord("model.failed", { model, error: { code: info.code, message: info.message } }, key)] },
      () => releaseRepairTurn(core, key));
    throw info;
  }
  core.checkControl();

  let invalid = invalidOf(state, key);
  // The journalled attempt, and the provider wait it may still owe, belong to the repair phase only when this
  // session starts in it.
  const repairAttempt = invalid === null ? 1 : resumeAttempt;
  const repairWait = invalid === null ? null : resumeWait;
  let turnHold: Hold | null = null;
  let spendHold: Hold | null = null;
  try {
    if (invalid === null) {
      const call = callOf(baseRequest(step.turn ?? state.usage.turns + 1), false);
      // Limit checks and the reservation happen synchronously, so parallel branches cannot both pass a cap that fits one.
      // This early check pauses without journalling an attempt; the check inside each attempt's start commit decides.
      const refused = admissionRefusal(core, call, NO_HOLDS);
      if (refused !== null) return await limitPending(core, key, refused.kind, refused.title, refused.detail, onLimit, refused.checked);
      turnHold = countsAsTurn ? hold(core, 0, 1) : null;
      spendHold = hold(core, call.worstCase ?? 0, 0);
      // Phase 1: every end of the call frees both holds (an unfinished first call is checked again on entry).
      const release = releaseAll(turnHold, spendHold);
      const outcome = await callWithAttempts(core, key, step, provider, call, {
        firstAttempt: resumeAttempt, remaining, onLimit, release, close: release, ownMicros: call.worstCase ?? 0,
        resumeWait,
      });
      const problems = replyProblems(step, outcome.response);
      if (problems.length === 0) {
        return await commitFinished(core, key, step, call, outcome, null, release, outputFields);
      }
      const data: JournalDataMap["model.invalid"] = {
        model, purpose: step.purpose, text: outcome.response.text, toolCalls: outcome.response.toolCalls,
        output: outcome.response.output ?? null, problems: problems.map((p) => ({ path: p.path, message: p.message })),
        usage: outcome.usage, costMicros: outcome.costMicros, durationMs: outcome.durationMs, ...assumedField(outcome),
      };
      const firstSpend = spendHold;
      const stored = await core.commit({
        records: [newRecord("model.invalid", data, key)],
        usage: billedUsage(model, step.purpose, outcome),
      }, () => {
        firstSpend.release();
        // The admitted turn is counted only when the step finishes: from now on it belongs to the open repair, in
        // the session's map, and stays reserved whatever ends this invocation of the step.
        if (turnHold !== null) {
          core.repairTurns.set(key, turnHold);
          turnHold = null;
        }
      });
      core.logger.debug("model.invalid", { key, problems: problems.length });
      invalid = dataOf(stored[0] as JournalRecord, "model.invalid");
    } else if (countsAsTurn) {
      // The turn was admitted in phase 1 and is reserved for this open repair (the session reserved it when it
      // claimed the run); a core built without that setup reserves it now. It is never checked again here.
      holdRepairTurn(core, key);
    }
    if (invalid === null) throw new RunwrightError("internal", "the invalid reply was not journalled");

    // Repair phase: a step boundary, so a pause or stop that arrived during the first call takes effect here.
    core.checkControl();
    const startedData = latestRecord(state, key, "model.started");
    const turn = (startedData === null ? null : dataOf(startedData, "model.started"))?.turn ?? step.turn ?? state.usage.turns + 1;
    const call = callOf(repairRequest(baseRequest(turn), step.output?.name ?? "output", invalid), true);
    const refused = admissionRefusal(core, call, NO_HOLDS);
    if (refused !== null) return await limitPending(core, key, refused.kind, refused.title, refused.detail, onLimit, refused.checked);
    const repairSpend = hold(core, call.worstCase ?? 0, 0);
    spendHold = repairSpend;
    // An end that leaves the repair open frees only its spend; a closing record frees its turn as well.
    const close = (): void => {
      releaseRepairTurn(core, key);
      repairSpend.release();
    };
    const outcome = await callWithAttempts(core, key, step, provider, call, {
      firstAttempt: repairAttempt, remaining, onLimit, release: () => repairSpend.release(), close, ownMicros: call.worstCase ?? 0,
      resumeWait: repairWait,
    });
    const again = replyProblems(step, outcome.response);
    if (again.length === 0) return await commitFinished(core, key, step, call, outcome, invalid, close, outputFields);
    const failure = new RunwrightError("model_output_invalid",
      `structured output "${step.output?.name ?? "output"}" is invalid after one repair: ${problemList(again)}`);
    await core.commit({
      records: [newRecord("model.failed", {
        model, error: { code: failure.code, message: failure.message }, usage: outcome.usage, costMicros: outcome.costMicros,
        ...assumedField(outcome),
      }, key)],
      usage: billedUsage(model, step.purpose, outcome),
    }, close);
    core.logger.debug("model.failed", { key, code: failure.code });
    throw failure;
  } finally {
    // The holds of this invocation only: the turn of an open repair is in core.repairTurns and is not freed here.
    turnHold?.release();
    spendHold?.release();
  }
}

/**
 * Resolves the step's provider with its credentials registered first (invariant R1): the key the ref names, as
 * the secrets reader reveals it now (covers a provider that does not expose it), then every credential the
 * resolved provider object carries (exactly what it sends, even when the value changed between the two reads).
 * Called before the step's first provider request and before any attempt creates its delta stream.
 */
async function resolveRegistered(core: SessionCore, ref: ModelRef): Promise<ModelProvider> {
  const { deps, redactor } = core;
  const name = apiKeySecretName(ref);
  if (name !== null) {
    const revealed = await deps.secrets.reveal([name]);
    const value = Object.hasOwn(revealed, name) ? revealed[name] : undefined;
    if (typeof value === "string") redactor.add(name, value);
  }
  const provider = await deps.models.resolve(ref);
  for (const credential of provider.credentials ?? []) redactor.add(credential.name, credential.value);
  return provider;
}

/** A provider wait journalled with `model.retry {retryAfterMs}`: when it began (the record's `ts`) and how long it is. */
interface ProviderWait { recordedAt: number; retryAfterMs: number }

/** The provider wait a resumed call still owes: the key's last model record when it is a model.retry with a hint. */
function providerWaitOf(last: JournalRecord | null): ProviderWait | null {
  const retry = last === null ? null : dataOf(last, "model.retry");
  if (last === null || retry === null || typeof retry.retryAfterMs !== "number") return null;
  return { recordedAt: last.ts, retryAfterMs: retry.retryAfterMs };
}

/**
 * The details of a model.failed replayed as an error: what is left now of the provider wait the record names
 * (`retryAfterMs`, counted from the record's `ts`) and `retryAfterOverLimit` when the record has it. Undefined
 * when the record names no wait, so the error is rebuilt without details.
 */
function replayedWaitDetails(
  record: JournalRecord | null, data: JournalDataMap["model.failed"], nowMs: number,
): JsonObject | undefined {
  if (record === null || typeof data.retryAfterMs !== "number") return undefined;
  const details: JsonObject = { retryAfterMs: cooldownLeftMs(record.ts, data.retryAfterMs, nowMs) };
  if (data.retryAfterOverLimit === true) details["retryAfterOverLimit"] = true;
  return details;
}

function invalidOf(state: ReplayState, key: string): JournalDataMap["model.invalid"] | null {
  const record = latestRecord(state, key, "model.invalid");
  return record === null ? null : dataOf(record, "model.invalid");
}

/** What one call of a model step already holds of `core.reserved`, which its own admission does not count twice. */
interface OwnHolds { micros: number; turns: number }
const NO_HOLDS: OwnHolds = { micros: 0, turns: 0 };

/** A limit that refuses an attempt: the pending it opens, and the limits object the check read. */
interface Refusal { kind: "turn_limit" | "spend_cap"; title: string; detail: JsonObject; checked: RunLimits }

/**
 * Whether an attempt of `call` is admitted now, against `core.state.limits` and the usage and reservations as they
 * are: null when it is, else the refusal. A first call (not the repair) that counts as a turn is checked against
 * the turn limit first; every attempt against the spend cap. `own` is what this call already holds (its spend
 * hold, and in phase 1 its turn hold), left out of the reservations it is compared with. Synchronous: it is called
 * inside the commit that writes the attempt's `model.started`, so that record is written only when it passes.
 */
function admissionRefusal(core: SessionCore, call: ModelCall, own: OwnHolds): Refusal | null {
  const { state } = core;
  if (call.countsAsTurn && !call.repair) {
    const turns = checkCount(state.limits.maxTurns, saturatingAdd(state.usage.turns, clampTotal(core.reserved.turns - own.turns)));
    if (!turns.ok) {
      return {
        kind: "turn_limit", title: `Turn limit reached (${state.usage.turns} of ${String(state.limits.maxTurns)})`,
        detail: turns.detail, checked: state.limits,
      };
    }
  }
  const spend = checkSpend(spendInput(core, call, own.micros));
  if (!spend.ok) return { kind: "spend_cap", title: spendTitle(call.model, spend.detail), detail: spend.detail, checked: state.limits };
  return null;
}

/** `ownMicros`: the part of core.reserved held by this call itself, which a later attempt does not count twice. */
function spendInput(core: SessionCore, call: ModelCall, ownMicros: number): Parameters<typeof checkSpend>[0] {
  const { state, deps } = core;
  return {
    capMicros: state.limits.maxCostMicros,
    spentMicros: state.usage.costMicros,
    reservedMicros: clampTotal(core.reserved.micros - ownMicros),
    worstCaseMicros: call.worstCase,
    costUnknown: state.usage.costUnknown,
    allowUnpriced: state.limits.allowUnpriced || deps.config.allowUnpricedModels,
    model: call.model,
  };
}

/** The usage row of a reply: `assumed` when any of its counts is the reserved bound rather than a reported count. */
function billedUsage(model: string, purpose: ModelStepRequest["purpose"], outcome: CallOutcome): NewUsage[] {
  return [{ model, purpose, ...outcome.usage, costMicros: outcome.costMicros, assumed: outcome.assumed.length > 0 }];
}

/** The repair request: the original request, the recorded invalid reply, and what was wrong with it. */
function repairRequest(request: ModelRequest, schemaName: string, invalid: JournalDataMap["model.invalid"]): ModelRequest {
  return {
    ...request,
    messages: [
      ...request.messages,
      { role: "assistant", content: invalid.text !== "" ? invalid.text : canonicalJson(invalid.output), toolCalls: invalid.toolCalls },
      {
        role: "user",
        content: [
          `Your structured output did not match the schema "${schemaName}":`,
          ...invalid.problems.map((p) => `- ${p.path}: ${p.message}`),
          "Reply again with output that matches the schema exactly.",
        ].join("\n"),
      },
    ],
  };
}

/** `fields`: the record's declared specification (the step's `outputFields`), when it has one. */
async function commitFinished(
  core: SessionCore, key: string, step: ModelStepRequest, call: ModelCall, outcome: CallOutcome,
  invalid: JournalDataMap["model.invalid"] | null, release: () => void, fields: ObjectSpec | undefined,
): Promise<ModelStepResult> {
  const { response } = outcome;
  const stored = await core.commit({
    records: [newRecord("model.finished", {
      model: call.model, purpose: step.purpose, text: response.text, toolCalls: response.toolCalls,
      output: response.output ?? null, stopReason: response.stopReason,
      usage: outcome.usage, costMicros: outcome.costMicros, durationMs: outcome.durationMs, ...assumedField(outcome),
    }, key, fields)],
    usage: billedUsage(call.model, step.purpose, outcome),
    ...(call.countsAsTurn ? { counters: { turns: 1 } } : {}),
  }, release);
  core.logger.debug("model.finished", { key, costMicros: outcome.costMicros });
  return modelStepResult(dataOf(stored[0] as JournalRecord, "model.finished") as JournalDataMap["model.finished"], invalid);
}

interface AttemptPlan {
  /** The attempt this session sends first (it was admitted by the caller). */
  firstAttempt: number;
  /** The step's remaining deadline in ms, read anew for every attempt and wait. */
  remaining: () => number | undefined;
  onLimit: "pause" | "skip";
  /**
   * Frees what this call holds when it ends with the step still unfinished (an abort other than a deadline, a
   * provider wait cut short, a next attempt that does not fit): its spend hold, and in phase 1 its turn hold.
   * Idempotent.
   */
  release: () => void;
  /**
   * Frees the same and, in the repair phase, the turn of the open repair: called exactly as a closing record of the
   * step (model.finished, model.failed, model.interrupted {reason: "deadline"}) is applied. Idempotent.
   */
  close: () => void;
  /** The spend hold of this call, kept from its first admission to its last record. */
  ownMicros: number;
  /** The provider wait this session resumes inside of; what is left of it is waited before the first attempt. */
  resumeWait: ProviderWait | null;
}

function maxAttemptsOf(retry: ModelRetry | undefined): number {
  if (retry === undefined) return 1;
  const max = Math.floor(retry.policy.maxAttempts);
  return Number.isFinite(max) && max >= 1 ? max : 1;
}

/** `retryAfterMs`: the provider's hint on the last attempt, put into `details` when there was one. */
function exhaustedError(error: RunwrightError, attempts: number, retryAfterMs: number | null): RunwrightError {
  const status = errorStatus(error);
  const statusText = status === null ? "no status" : `status ${status}`;
  return new RunwrightError(
    "model_failed",
    `model call failed after ${attempts} attempt${attempts === 1 ? "" : "s"} (last error: ${statusText}): ${error.message}`,
    { details: retryAfterMs === null ? { status, attempts } : { status, attempts, retryAfterMs }, cause: error },
  );
}

/** The call is not retried: the provider asked for a wait longer than `models.retry.maxRetryAfterMs`. */
function stoppedError(error: RunwrightError, attempts: number, retryAfterMs: number, limitMs: number): RunwrightError {
  const status = errorStatus(error);
  const statusText = status === null ? "no status" : `status ${status}`;
  return new RunwrightError(
    "model_failed",
    `model call not retried after ${attempts} attempt${attempts === 1 ? "" : "s"} (last error: ${statusText}): ` +
      `the provider asked for a wait of ${retryAfterMs} ms, more than models.retry.maxRetryAfterMs (${limitMs} ms): ${error.message}`,
    { details: { status, attempts, retryAfterMs, maxRetryAfterMs: limitMs, retryAfterOverLimit: true }, cause: error },
  );
}

/**
 * One model call as a sequence of provider attempts (plan 4.1). Every attempt is journalled as its own
 * model.started before it is sent and ended by exactly one record that says what it was charged. A transient
 * failure with attempts left is journalled model.retry (with the assumed charge when billing is uncertain); the
 * next attempt is admitted against the cap on its own, with this call's hold kept and not counted twice, and sent
 * after the backoff wait, which is the provider's retry-after hint in full when it gave one. A hint longer than
 * the policy's limit (retryAfterLimitMs) is neither waited out nor shortened: the failure is journalled
 * model.failed {retryAfterOverLimit: true} and the call stops, whatever attempts are left. Any other failure is
 * journalled model.failed and thrown. A session that resumes after a `model.retry` (`plan.firstAttempt`) sends the
 * next attempt after what is left of the provider's hint (`plan.resumeWait`, counted from the record's `ts`) and
 * with no further backoff: the engine's own backoff is never slept again on replay. Every attempt is admitted
 * once more as its `model.started` is committed (sendAttempt).
 */
async function callWithAttempts(
  core: SessionCore, key: string, step: ModelStepRequest, provider: ModelProvider, call: ModelCall, plan: AttemptPlan,
): Promise<CallOutcome> {
  const retry = core.deps.models.retry;
  const maxAttempts = maxAttemptsOf(retry);
  const limitMs = retryAfterLimitMs(retry?.policy);
  if (plan.resumeWait !== null) {
    const left = cooldownLeftMs(plan.resumeWait.recordedAt, plan.resumeWait.retryAfterMs, core.deps.clock.now());
    if (left > 0) await waitBetweenAttempts(core, key, call, retry?.sleep ?? delay, { ms: left, hinted: true }, plan.firstAttempt - 1, plan);
  }
  for (let attempt = plan.firstAttempt; ; attempt++) {
    const result = await sendAttempt(core, key, step, provider, call, attempt, plan);
    if (result.ok) return result.outcome;
    const error = isRunwrightError(result.error) ? result.error : new RunwrightError("model_failed", errorContent(result.error), { cause: result.error });
    const billing = attemptBilling(result.error);
    const charge = billing === "unknown" ? [assumedUsage(call, step.purpose)] : [];
    const hint = error.code === "model_transient" ? errorRetryAfterMs(error) : null;

    if (hint !== null && hint > limitMs) {
      const failure = stoppedError(error, attempt, hint, limitMs);
      const data: JournalDataMap["model.failed"] = { model: call.model, error: { code: failure.code, message: failure.message }, attempts: attempt };
      if (billing === "unknown") data.assumedCostMicros = call.worstCase;
      data.retryAfterMs = hint;
      data.retryAfterOverLimit = true;
      await core.commit({ records: [newRecord("model.failed", data, key)], usage: charge }, plan.close);
      core.logger.debug("model.failed", { key, code: failure.code, attempts: attempt, billing, retryAfterMs: hint, limitMs });
      throw failure;
    }

    if (error.code === "model_transient" && retry !== undefined && attempt < maxAttempts) {
      const delayMs = backoffDelayMs(retry.policy, attempt, retry.random, hint);
      const data: JournalDataMap["model.retry"] = {
        attempt, delayMs, code: error.code, message: error.message, status: errorStatus(error), billing,
      };
      if (billing === "unknown") data.assumedCostMicros = call.worstCase;
      if (hint !== null) data.retryAfterMs = hint;
      // The next attempt is admitted on its own, synchronously as this attempt's charge is applied: the call's hold
      // now covers that next attempt, or is freed at once when it does not fit.
      let spend = null as SpendCheck | null;
      let checked = core.state.limits;
      await core.commit({ records: [newRecord("model.retry", data, key)], usage: charge }, () => {
        checked = core.state.limits;
        spend = checkSpend(spendInput(core, call, plan.ownMicros));
        if (!spend.ok) plan.release();
      });
      core.logger.debug("model.retry", { key, attempt, delayMs, billing });
      if (spend === null) throw new RunwrightError("internal", "the retry record was not applied");
      if (!spend.ok) return await limitPending(core, key, "spend_cap", spendTitle(call.model, spend.detail), spend.detail, plan.onLimit, checked);
      await waitBetweenAttempts(core, key, call, retry.sleep, { ms: delayMs, hinted: hint !== null }, attempt, plan);
      continue;
    }

    const failure = error.code === "model_transient" ? exhaustedError(error, attempt, hint) : error;
    const data: JournalDataMap["model.failed"] = { model: call.model, error: { code: failure.code, message: failure.message }, attempts: attempt };
    if (billing === "unknown") data.assumedCostMicros = call.worstCase;
    if (hint !== null) data.retryAfterMs = hint;
    await core.commit({ records: [newRecord("model.failed", data, key)], usage: charge }, plan.close);
    core.logger.debug("model.failed", { key, code: failure.code, attempts: attempt, billing });
    throw failure;
  }
}

/**
 * The wait before the next attempt: `wait.ms` long, `wait.hinted` when it serves a provider's retry-after hint.
 * `attempts` is the number of attempts the call has made. No request is in flight, so a pause, stop, shutdown or
 * cancel ends it with nothing written (the step resumes from model.retry); a deadline that passes is journalled
 * model.failed, with `retryAfterMs` (and the thrown error with `details.retryAfterMs`) when part of a provider's
 * wait is still to pass.
 */
async function waitBetweenAttempts(
  core: SessionCore, key: string, call: ModelCall, sleep: ModelRetry["sleep"], wait: { ms: number; hinted: boolean },
  attempts: number, plan: AttemptPlan,
): Promise<void> {
  const deadlineMs = plan.remaining();
  const endsAt = core.deps.clock.now() + wait.ms;
  const handle = core.register({ onPause: true, onStop: true, ...(deadlineMs === undefined ? {} : { deadlineMs }) });
  let cause: AbortCause | null;
  try {
    try {
      await sleep(wait.ms, handle.signal);
    } catch (error) {
      if (handle.cause() === null) throw error;
    }
    cause = handle.cause();
    if (cause === null && plan.remaining() === 0) cause = "deadline";
  } finally {
    handle.dispose();
  }
  if (cause === null) {
    core.checkControl();
    return;
  }
  if (cause === "lease_lost") throw new ControlSignal("lease_lost");
  if (cause !== "deadline") {
    plan.release();
    throw signalFor(cause);
  }
  const left = wait.hinted ? Math.max(0, endsAt - core.deps.clock.now()) : 0;
  const failure = left > 0
    ? new RunwrightError("deadline_exceeded", "the model step's deadline passed", { details: { retryAfterMs: left } })
    : new RunwrightError("deadline_exceeded", "the model step's deadline passed");
  const data: JournalDataMap["model.failed"] = { model: call.model, error: { code: failure.code, message: failure.message }, attempts };
  if (left > 0) data.retryAfterMs = left;
  await core.commit({ records: [newRecord("model.failed", data, key)] }, plan.close);
  core.logger.debug("model.failed", { key, code: failure.code, attempts });
  throw failure;
}

type AttemptResult = { ok: true; outcome: CallOutcome } | { ok: false; error: unknown };

/**
 * Journals model.started for one attempt and sends it. The attempt is admitted inside the commit that writes that
 * record (invariant: no await between the check that admits and the start record): the turn limit (a first call
 * that counts as a turn) and the spend cap are checked against the limits and usage in force then, so a `limits`
 * command applied during a backoff, a provider wait or the wait for the commit lock is seen. When the check fails
 * nothing is written, the call's holds are freed (`release`: an open repair keeps its turn) and the step pauses
 * (or, with `onLimit: "skip"`, fails with `limit_reached`). Deltas are published through a fresh streaming
 * redactor, flushed when the attempt ends. An abort is journalled here (model.interrupted, charged the worst case)
 * and the control signal thrown; the plan's `close` (a deadline) or `release` (any other cause) frees the call's
 * reservation as that record is applied. A provider error is returned to the attempt loop, which journals it.
 */
async function sendAttempt(
  core: SessionCore, key: string, step: ModelStepRequest, provider: ModelProvider, call: ModelCall, attempt: number,
  plan: AttemptPlan,
): Promise<AttemptResult> {
  const { deps } = core;
  const own: OwnHolds = { micros: plan.ownMicros, turns: call.countsAsTurn && !call.repair ? 1 : 0 };
  let refused = null as Refusal | null;
  await core.commit(() => {
    refused = admissionRefusal(core, call, own);
    if (refused !== null) return null;
    return {
      records: [newRecord("model.started", {
        model: call.model, purpose: step.purpose, step: step.step ?? null, turn: call.request.meta.turn, countsAsTurn: call.countsAsTurn,
        inputTokensEstimate: call.estimate, maxOutputTokens: call.request.maxOutputTokens, worstCaseMicros: call.worstCase, repair: call.repair,
        attempt,
      }, key)],
    };
  });
  if (refused !== null) {
    plan.release();
    return await limitPending(core, key, refused.kind, refused.title, refused.detail, plan.onLimit, refused.checked);
  }
  const deadlineMs = plan.remaining();
  const handle = core.register({ onPause: true, onStop: false, ...(deadlineMs === undefined ? {} : { deadlineMs }) });
  const early = handle.cause();
  if (early !== null) {
    handle.dispose();
    return await interruptAttempt(core, key, step, call, attempt, early, plan);
  }
  const stream = core.redactor.stream();
  const publish = (text: string): void => {
    if (text !== "") deps.events?.publish({ runId: core.run.id, type: "model.delta", key, text });
  };
  const options: GenerateOptions = { signal: handle.signal, onDelta: (text: string): void => publish(stream.push(text)) };
  const request: ModelRequest = { ...call.request, meta: { ...call.request.meta, attempt } };
  const startedAt = deps.clock.now();
  try {
    const response = await provider.generate(request, options);
    publish(stream.flush());
    return { ok: true, outcome: chargedReply(core, call, response, Math.max(0, deps.clock.now() - startedAt)) };
  } catch (error) {
    publish(stream.flush());
    if (isControlSignal(error)) throw error;
    const cause = handle.cause();
    if (cause === null) return { ok: false, error };
    return await interruptAttempt(core, key, step, call, attempt, cause, plan);
  } finally {
    handle.dispose();
  }
}

/**
 * How an attempt aborted by `cause` ends, the same whether the abort was observed before the request was sent or
 * while it was in flight: a lost lease writes nothing; any other cause is journalled model.interrupted and charged
 * the attempt's worst case (the journal cannot tell an unsent request from a sent one after a crash, so the cap
 * bound holds either way), then the cause's control signal (or deadline error) is thrown. A deadline ends the step
 * (`frees.close`); any other cause leaves it unfinished (`frees.release`: an open repair keeps its turn).
 */
async function interruptAttempt(
  core: SessionCore, key: string, step: ModelStepRequest, call: ModelCall, attempt: number, cause: AbortCause,
  frees: Pick<AttemptPlan, "release" | "close">,
): Promise<never> {
  if (cause === "lease_lost") throw new ControlSignal("lease_lost");
  const reason = cause === "cancel" ? "cancel" : cause === "pause" ? "pause" : cause === "deadline" ? "deadline" : "shutdown";
  await core.commit({
    records: [newRecord("model.interrupted", { model: call.model, reason, assumedCostMicros: call.worstCase, attempt }, key)],
    usage: [assumedUsage(call, step.purpose)],
  }, reason === "deadline" ? frees.close : frees.release);
  core.logger.debug("model.interrupted", { key, reason, attempt });
  throw signalFor(cause);
}

// ------------------------------------------------------------------ tools

/** The data of a `tool.finished` record from a shaped result; the digest fields only when their file was saved. */
function finishedData(callId: string, tool: string, limited: ShapedToolResult, durationMs: number): JournalDataMap["tool.finished"] {
  return {
    callId, tool, outcome: limited.outcome, content: limited.content, data: limited.data, isError: limited.isError,
    untrusted: limited.untrusted, truncated: limited.truncated, fullResultPath: limited.fullResultPath, durationMs,
    ...(limited.fullResultPath !== null && limited.fullResultSha256 !== null && limited.fullResultBytes !== null
      ? { fullResultSha256: limited.fullResultSha256, fullResultBytes: limited.fullResultBytes } : {}),
    ...(limited.fullDataPath !== null && limited.fullDataSha256 !== null && limited.fullDataBytes !== null
      ? { fullDataPath: limited.fullDataPath, fullDataSha256: limited.fullDataSha256, fullDataBytes: limited.fullDataBytes } : {}),
  };
}

async function finishWithout(
  core: SessionCore, key: string, callId: string, tool: string, outcome: "denied" | "unknown_tool" | "invalid_args" | "skipped",
  content: string, isError: boolean,
): Promise<ToolStepResult> {
  const limited = await limitToolResult({
    workspace: core.workspace, epoch: core.run.epoch, key, limitBytes: core.deps.config.toolResultBytes,
    outcome, content: core.redactor.text(content), data: null, isError, untrusted: false,
  });
  const stored = await core.commit({ records: [newRecord("tool.finished", finishedData(callId, tool, limited, 0), key)] });
  core.logger.debug("tool.finished", { key, tool, outcome });
  return toolStepResult(dataOf(stored[0] as JournalRecord, "tool.finished") as JournalDataMap["tool.finished"]);
}

async function runTool(core: SessionCore, key: string, call: ToolStepCall): Promise<ToolStepResult> {
  checkStepDeadline(call.deadlineMs);
  const { deps, state } = core;
  const finished = latestRecord(state, key, "tool.finished");
  if (finished !== null) return toolStepResult(dataOf(finished, "tool.finished") as JournalDataMap["tool.finished"]);
  const callId = call.callId ?? key;
  const tool = deps.tools.get(call.name);
  const last = lastToolRecord(state, key);

  const started = last === null ? null : dataOf(last, "tool.started");
  const interrupted = last === null ? null : dataOf(last, "tool.interrupted");
  if (started !== null || interrupted !== null) {
    const attempt = started?.attempt ?? interrupted?.attempt ?? 1;
    if (tool === null) return finishWithout(core, key, callId, call.name, "unknown_tool", unknownToolContent(call.name), true);
    if (started !== null && tool.resumable === true) return execute(core, key, callId, tool, call, attempt, false);
    if (started !== null && last !== null && repeatsByItself(state, tool, last.seq)) return execute(core, key, callId, tool, call, attempt + 1, true);
    return handleInterrupted(core, key, callId, tool, call, started !== null, attempt);
  }

  if (tool === null) return finishWithout(core, key, callId, call.name, "unknown_tool", unknownToolContent(call.name), true);
  const policy = policyFor(core, call.name, tool);
  if (policy.policy === "deny") {
    return finishWithout(core, key, callId, call.name, "denied", deniedContent(call.name, policy.reason), true);
  }
  // The call's own approval decides it whenever one was opened (invariant A): a run-wide "approve always" granted
  // later never turns this call's denial into a run. Only a call with no approval of its own is decided by the
  // policy, and its pending is opened only while the policy still says "ask" inside the commit lock.
  const approval = await settledPending(core, key, "approval", APPROVAL_EXPIRED);
  if (approval === null && policy.policy === "ask") {
    return openPending(core, key, "approval", `Approve ${call.name}: ${argsPreview(call.args)}`, { tool: call.name, args: call.args },
      () => policyFor(core, call.name, tool).policy === "ask");
  }
  if (approval !== null && approval.resolution?.["decision"] !== "approve") {
    const reason = approval.resolution?.["reason"];
    const text = typeof reason === "string" && reason !== "" ? `denied by a person: ${reason}` : "denied by a person";
    return finishWithout(core, key, callId, call.name, "denied", deniedContent(call.name, text), true);
  }
  // The early check pauses before anything is journalled; the check in execute's tool.started commit decides.
  const budget = toolBudgetCheck(core, core.reserved.toolStarts);
  if (!budget.ok) return limitPending(core, key, "tool_budget", toolBudgetTitle(core), budget.detail, "pause", state.limits);
  const problems = validateSchema(tool.parameters, call.args);
  if (problems.length > 0) {
    return finishWithout(core, key, callId, call.name, "invalid_args", invalidArgsContent(call.name, problems), true);
  }
  return execute(core, key, callId, tool, call, 1, true);
}

/** The tool-call budget against the calls counted so far and `otherStarts` first attempts being started. */
function toolBudgetCheck(core: SessionCore, otherStarts: number): ReturnType<typeof checkCount> {
  return checkCount(core.state.limits.maxToolCalls, saturatingAdd(core.state.usage.toolCalls, clampTotal(otherStarts)));
}

function toolBudgetTitle(core: SessionCore): string {
  return `Tool-call budget reached (${core.state.usage.toolCalls} of ${String(core.state.limits.maxToolCalls)})`;
}

/** A call of this tool may be run again on its own after it was left unfinished, depending on rule R. */
function safeToRepeat(tool: ToolDefinition): boolean {
  return tool.effect === "read" || tool.idempotent === true;
}

/**
 * Rule R (plan 2.1): an unfinished call whose latest `tool.started` has `startedSeq` is run again by the engine
 * itself only when repeating it cannot undo finished work. A read-only tool always; a tool declared idempotent
 * with effect "write" only when no write call of the run finished after that start (`lastWriteFinishedSeq`, read
 * from the journal as it is now, so a write finished earlier in this session counts too). Anything else waits
 * for a person as an interrupted call. Resumable tools are handled before this rule (they replay their own steps).
 */
function repeatsByItself(state: ReplayState, tool: ToolDefinition, startedSeq: number): boolean {
  if (tool.effect === "read") return true;
  return tool.idempotent === true && state.lastWriteFinishedSeq < startedSeq;
}

/**
 * Opens the "interrupted" pending of a call left unfinished (with its tool.interrupted record when asked). Inside a
 * deadline the pending's detail (not the record) carries `expiresAt`; when that instant has already passed only
 * the record is written and the step fails with `deadline_exceeded` (PENDING_TOO_LATE).
 */
async function openInterrupted(
  core: SessionCore, key: string, tool: ToolDefinition, call: ToolStepCall, attempt: number, reason: ToolInterruptReason, withRecord: boolean,
): Promise<void> {
  const detail: InterruptedDetail = { tool: tool.name, args: call.args, attempt, reason };
  const records = withRecord ? [newRecord("tool.interrupted", detail, key)] : [];
  let timed: JsonObject;
  try {
    timed = timedDetail(core, detail as unknown as JsonObject);
  } catch (error) {
    if (records.length > 0) await core.commit({ records });
    throw error;
  }
  const created: NewPending = {
    id: core.deps.ids.next("pend"), kind: "interrupted", stepKey: key,
    title: `Interrupted ${tool.name} call: ${argsPreview(call.args)}`, detail: timed,
  };
  records.push(newRecord("pending.opened", { pending: created }, key));
  await core.commit({ records, openPendings: [created] });
  core.logger.debug("tool.interrupted", { key, tool: tool.name, attempt, reason });
}

async function handleInterrupted(
  core: SessionCore, key: string, callId: string, tool: ToolDefinition, call: ToolStepCall, needRecord: boolean, attempt: number,
): Promise<ToolStepResult> {
  const pending = await settledPending(core, key, "interrupted", INTERRUPTED_EXPIRED, (p) => p.detail["attempt"] === attempt);
  if (pending === null) {
    await openInterrupted(core, key, tool, call, attempt, "crash", needRecord);
    throw new ControlSignal("waiting");
  }
  const action = pending.resolution?.["action"];
  if (action === "retry") return execute(core, key, callId, tool, call, attempt + 1, true);
  if (action === "skip") {
    const result = pending.resolution?.["result"];
    return finishWithout(core, key, callId, tool.name, "skipped", typeof result === "string" ? result : "", false);
  }
  if (action === "cancel") throw new ControlSignal("cancelled");
  throw new RunwrightError("internal", `the interrupted call at ${key} was resolved with an unknown action ${JSON.stringify(action ?? null)}`);
}

/**
 * A call aborted by a pause, a forced shutdown or a stop gets no tool.finished. A read-only, idempotent or
 * resumable tool keeps its unfinished tool.started: when the step is entered again, rule R decides (repeatsByItself)
 * whether it runs again by itself or waits for a person as an interrupted call. Any other call is journalled
 * interrupted with a pending for a person now. Then the control signal of the cause stops the run.
 */
async function leaveUnfinished(
  core: SessionCore, key: string, tool: ToolDefinition, call: ToolStepCall, attempt: number, cause: "pause" | "shutdown",
): Promise<never> {
  if (tool.resumable !== true && !safeToRepeat(tool)) await openInterrupted(core, key, tool, call, attempt, cause, true);
  else core.logger.debug("tool.unfinished", { key, tool: tool.name, attempt, cause });
  throw signalFor(cause);
}

type ShapedOutput = ReturnType<typeof fromToolOutput>;

/**
 * How a tool call aborted by `cause` ends, the same whether the abort was observed before the handler was invoked
 * or while it ran: a pause, a forced shutdown or a stop leaves it unfinished (leaveUnfinished); a lost lease
 * writes nothing; a cancel gives the "aborted" result, journalled before the run is cancelled (`rethrow`); a
 * deadline gives the "timeout" result, which is returned to the caller.
 */
async function abortedCall(
  core: SessionCore, key: string, tool: ToolDefinition, call: ToolStepCall, attempt: number, cause: AbortCause,
): Promise<{ shaped: ShapedOutput; rethrow: AbortCause | null }> {
  if (cause === "lease_lost") throw new ControlSignal("lease_lost");
  if (cause === "pause") return leaveUnfinished(core, key, tool, call, attempt, "pause");
  if (cause === "shutdown" || cause === "stop") return leaveUnfinished(core, key, tool, call, attempt, "shutdown");
  const base = { data: null, isError: true, untrusted: tool.untrustedOutput === true };
  if (cause === "cancel") return { shaped: { ...base, outcome: "aborted", content: `tool "${tool.name}" was aborted` }, rethrow: cause };
  const content = call.deadlineMs === undefined
    ? `tool "${tool.name}" was stopped: the deadline of the enclosing call passed`
    : `tool "${tool.name}" timed out after ${call.deadlineMs} ms`;
  return { shaped: { ...base, outcome: "timeout", content }, rethrow: null };
}

/**
 * The only place a tool handler is invoked: the server deny list is checked first, every time, and the handler is
 * not invoked when the call was already aborted once its tool.started was committed.
 */
async function execute(
  core: SessionCore, key: string, callId: string, tool: ToolDefinition, call: ToolStepCall, attempt: number, writeStarted: boolean,
): Promise<ToolStepResult> {
  const { deps } = core;
  const denied = serverDenial(deps.config.denyTools, tool.name);
  if (denied !== null) return finishWithout(core, key, callId, tool.name, "denied", deniedContent(tool.name, denied), true);
  if (writeStarted) {
    // A first attempt counts against the tool-call budget, checked again inside the commit that writes its
    // tool.started (its own reservation left out): a lowered budget applied before that commit is seen.
    const counted = attempt === 1;
    let refused = null as { detail: JsonObject; checked: RunLimits } | null;
    if (counted) core.reserved.toolStarts += 1;
    try {
      await core.commit(() => {
        if (counted) {
          const budget = toolBudgetCheck(core, core.reserved.toolStarts - 1);
          if (!budget.ok) {
            refused = { detail: budget.detail, checked: core.state.limits };
            return null;
          }
        }
        return {
          records: [newRecord("tool.started", { callId, tool: tool.name, args: call.args, effect: tool.effect, attempt }, key)],
          ...(counted ? { counters: { toolCalls: 1 } } : {}),
        };
      });
    } finally {
      if (counted) core.reserved.toolStarts -= 1;
    }
    if (refused !== null) return limitPending(core, key, "tool_budget", toolBudgetTitle(core), refused.detail, "pause", refused.checked);
    core.logger.debug("tool.started", { key, tool: tool.name, attempt });
  }
  const handle = core.register({ onPause: true, onStop: false, ...(call.deadlineMs === undefined ? {} : { deadlineMs: call.deadlineMs }) });
  const startedAt = deps.clock.now();
  let shaped: ShapedOutput;
  let opened: string[] = [];
  let dataFields: ObjectSpec | undefined;
  let abortCause: AbortCause | null = null;
  try {
    const early = handle.cause();
    if (early !== null) {
      ({ shaped, rethrow: abortCause } = await abortedCall(core, key, tool, call, attempt, early));
    } else {
      try {
        const output = await tool.handler(call.args, {
          runId: core.run.id,
          agentId: core.run.agentId,
          workspace: core.workspace,
          signal: handle.signal,
          logger: core.logger,
          secrets: core.toolSecrets,
          steps: createRunContext(core, `${key}/`, handle),
        });
        const declared = output.dataFields;
        if (declared !== undefined && !isFieldSpec(declared)) {
          shaped = {
            data: null, isError: true, untrusted: tool.untrustedOutput === true, outcome: "error",
            content: `tool "${tool.name}" returned "dataFields" that is not a field specification`,
          };
        } else {
          shaped = fromToolOutput(output, tool.untrustedOutput === true);
          opened = Array.isArray(output.learningOpened) ? output.learningOpened.filter((id) => typeof id === "string") : [];
          dataFields = declared === undefined ? undefined : recordFieldsWith("tool.finished", "data", declared);
        }
      } catch (error) {
        if (isControlSignal(error)) throw error;
        const cause = handle.cause();
        if (cause !== null) {
          ({ shaped, rethrow: abortCause } = await abortedCall(core, key, tool, call, attempt, cause));
        } else {
          if (!isRunwrightError(error)) core.logger.warn("tool.error", { key, tool: tool.name, message: core.redactor.text(errorContent(error)) });
          shaped = { data: null, isError: true, untrusted: tool.untrustedOutput === true, outcome: "error", content: errorContent(error) };
        }
      }
    }
  } finally {
    handle.dispose();
  }
  const dataSpec = dataFields?.fields["data"];
  const limited = await limitToolResult({
    workspace: core.workspace, epoch: core.run.epoch, key, limitBytes: deps.config.toolResultBytes,
    outcome: shaped.outcome, content: core.redactor.text(shaped.content),
    data: dataSpec === undefined ? core.redactor.payload(shaped.data) : redactBySpec(shaped.data, dataSpec, core.redactor),
    isError: shaped.isError, untrusted: shaped.untrusted,
  });
  const stored = await core.commit({
    records: [newRecord("tool.finished", finishedData(callId, tool.name, limited, Math.max(0, deps.clock.now() - startedAt)), key, dataFields)],
    ...(opened.length > 0 ? { learning: { opened } } : {}),
  });
  core.logger.debug("tool.finished", { key, tool: tool.name, outcome: limited.outcome });
  if (abortCause !== null) throw signalFor(abortCause);
  return toolStepResult(dataOf(stored[0] as JournalRecord, "tool.finished") as JournalDataMap["tool.finished"]);
}

// ------------------------------------------------------------------ people, memo, inbox, emit

/**
 * A question for a person. An answer (a string) is returned without a time check: the command was planned in time
 * (planCommands rejects one created at or after the instant). Otherwise the pending rule of settledPending
 * applies. With no question yet, one is opened, carrying the earlier of `question.expiresAt` and the enclosing
 * deadline as `expiresAt`, unless that instant has already passed (`deadline_exceeded`, nothing journalled).
 */
async function runAsk(core: SessionCore, key: string, question: PersonQuestion): Promise<{ answer: string }> {
  if (question.expiresAt !== undefined && !finiteNumber(question.expiresAt)) throw new RunwrightError("bad_request", BAD_EXPIRES_AT);
  const latest = latestPending(core.state, key, "question");
  const answered = latest?.status === "resolved" ? latest.resolution?.["answer"] : undefined;
  if (typeof answered === "string") return { answer: answered };
  const settled = await settledPending(core, key, "question", QUESTION_EXPIRED);
  if (settled !== null) {
    const answer = settled.resolution?.["answer"];
    return { answer: typeof answer === "string" ? answer : "" };
  }
  const own = pendingInstant(core, question.expiresAt);
  if (own !== null && core.deps.clock.now() >= own) throw new RunwrightError("deadline_exceeded", QUESTION_EXPIRED);
  return openPending(core, key, "question", firstLine(question.question), {
    question: question.question, choices: question.choices ?? [],
  }, undefined, question.expiresAt);
}

async function runMemo<T extends Json>(
  core: SessionCore, key: string, meta: MemoMeta, fn: (step: { startedAt: number }) => Promise<T>,
): Promise<T> {
  const finishedType = `${meta.recordType}.finished` as const;
  const startedType = `${meta.recordType}.started` as const;
  const fields = declaredFields(finishedType, "value", meta.valueFields, BAD_VALUE_FIELDS);
  const finished = latestRecord(core.state, key, finishedType);
  if (finished !== null) return finished.data["value"] as T;
  let started = latestRecord(core.state, key, startedType);
  if (started === null) {
    const stored = await core.commit({ records: [newRecord(startedType, { ...(meta.info ?? {}), name: meta.name }, key)] });
    started = stored[0] ?? null;
  }
  if (started === null) throw new RunwrightError("internal", `the ${startedType} record of ${key} was not journalled`);
  // A cancel, pause or stop applied while the started record was committed stops the step before its body runs.
  core.checkControl();
  const value = await fn({ startedAt: started.ts });
  const stored = await core.commit({ records: [newRecord(finishedType, { ...(meta.info ?? {}), name: meta.name, value }, key, fields)] });
  return (stored[0] as JournalRecord).data["value"] as T;
}

/** Plans tried for one effect step before a learning_conflict is rethrown. */
const EFFECT_ROUNDS = 3;

async function runEffect<T extends Json>(core: SessionCore, key: string, meta: MemoMeta, plan: () => Promise<StepPlan<T>>): Promise<T> {
  const finishedType = `${meta.recordType}.finished` as const;
  const fields = declaredFields(finishedType, "value", meta.valueFields, BAD_VALUE_FIELDS);
  const finished = latestRecord(core.state, key, finishedType);
  if (finished !== null) return finished.data["value"] as T;
  for (let round = 1; ; round++) {
    core.checkControl();
    const planned = await plan();
    try {
      const stored = await core.commit({
        records: [newRecord(finishedType, { ...(meta.info ?? {}), name: meta.name, value: planned.value }, key, fields)],
        ...(planned.learning === undefined ? {} : { learning: planned.learning }),
      });
      return (stored[0] as JournalRecord).data["value"] as T;
    } catch (error) {
      if (isRunwrightError(error) && error.code === "learning_conflict" && round < EFFECT_ROUNDS) {
        core.logger.debug("effect.conflict", { key, round });
        continue;
      }
      throw error;
    }
  }
}

/**
 * Hands the messages not yet taken to this key, once. The record is built inside the commit lock from the state as
 * it is then, so two takes under different keys never journal the same message, and a take of this key that was
 * journalled meanwhile is returned instead of a second one.
 */
async function runInbox(core: SessionCore, key: string): Promise<InboxMessage[]> {
  const takenMessages = (): InboxMessage[] | null => {
    const record = latestRecord(core.state, key, "inbox.taken");
    return record === null ? null : (dataOf(record, "inbox.taken") as JournalDataMap["inbox.taken"]).messages;
  };
  const before = takenMessages();
  if (before !== null) return before;
  await core.commit(() => (takenMessages() !== null ? null : {
    records: [newRecord("inbox.taken", { messages: core.state.messages.map((m) => ({ ...m })) }, key)],
  }));
  const after = takenMessages();
  if (after === null) throw new RunwrightError("internal", "the inbox take was not journalled");
  return after;
}

/**
 * Journals one record of `type` under `key` unless one is already there, and returns the stored record. The batch
 * is built inside the commit lock, so a record of this key and type journalled meanwhile is returned instead of a
 * second one.
 */
async function runEmit(core: SessionCore, key: string, type: string, data: JsonObject): Promise<JournalRecord> {
  if (ENGINE_TYPES.has(type)) {
    throw new RunwrightError("bad_request", `record type ${JSON.stringify(type)} is written by the engine and cannot be emitted`);
  }
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(type)) {
    throw new RunwrightError("bad_request", `invalid record type ${JSON.stringify(type)}`);
  }
  const before = latestRecord(core.state, key, type);
  if (before !== null) return before;
  await core.commit(() => (latestRecord(core.state, key, type) !== null ? null : { records: [{ type, key, data }] }));
  const after = latestRecord(core.state, key, type);
  if (after === null) throw new RunwrightError("internal", `the ${type} record of ${key} was not journalled`);
  return after;
}
