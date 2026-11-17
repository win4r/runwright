/**
 * One claimed run: rebuild its state from the journal, run the driver through the durable primitives, apply
 * the commands people send while it runs, and leave `running` exactly once (completed, failed, cancelled,
 * waiting, paused or released) — or write nothing more once the lease is lost.
 *
 * Every commit goes through one per-session lock, so commits never interleave and the "nothing new arrived"
 * checks before leaving `running` are atomic with respect to command application.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { intervalMs, startTimer, type TimerHandle } from "../core/clock.ts";
import { RunwrightError, errorInfo, isRunwrightError } from "../core/errors.ts";
import type { Json, JsonObject } from "../core/json.ts";
import { createGrowingRedactor, type GrowingRedactor, type Redactor } from "../core/redact.ts";
import type { Logger } from "../log/logger.ts";
import type { AgentDefinition } from "../agents/definition.ts";
import { apiKeySecretName } from "../models/util.ts";
import { redactCommitBatch } from "../store/batch-redaction.ts";
import type { ClaimedRun, CommitBatch, JournalRecord, Lease, NewJournalRecord, NewUsage, RunRecord } from "../store/types.ts";
import { claimWorkspaceStage, STAGE_DIR } from "../tools/workspace-stage.ts";
import { ControlSignal, isControlSignal } from "./control.ts";
import { newRecord } from "./journal-types.ts";
import type { EngineDeps, LearningContext, RunContext } from "./types.ts";
import { MESSAGE_UNDELIVERED, planCommands } from "./commands.ts";
import {
  createRunContext, holdRepairTurn, interruptedBatch, openRepairs, unfinishedModelStarts, type AbortCause, type CallHandle,
  type Hold, type SessionCore,
} from "./context.ts";
import {
  applyRecord, createReplayState, openPendings, pendingExpiry, replayJournal, type PendingEntry, type ReplayState,
} from "./state.ts";

const JOURNAL_PAGE = 1000;

export interface Session {
  readonly runId: string;
  /** Resolves when the session has unwound (it never rejects). */
  readonly done: Promise<void>;
  /** True once the run left `running` through this session, or the session was fenced. */
  ended(): boolean;
  /** Stop at the next step boundary and release the run (running → queued). */
  requestStop(): void;
  /** Abort in-flight calls now, then release. */
  forceStop(): void;
  /** The lease is gone: abort everything and write nothing more. */
  fence(reason: "lease_lost" | "abandoned"): void;
  /** A command for this run arrived (store event). */
  onCommand(): void;
  /**
   * The wake time the session stored when it last left the run `waiting` (the earliest `expiresAt` of the open
   * pendings), or null when it left in any other way or the run waits for a command only.
   */
  wakeAt(): number | null;
}

interface Registered { controller: AbortController; onPause: boolean; onStop: boolean; cause: AbortCause | null }

function redactingLogger(inner: Logger, redactor: Redactor): Logger {
  const clean = (fields?: JsonObject): JsonObject | undefined => (fields === undefined ? undefined : redactor.json(fields));
  return {
    debug: (message, fields) => inner.debug(redactor.text(message), clean(fields)),
    info: (message, fields) => inner.info(redactor.text(message), clean(fields)),
    warn: (message, fields) => inner.warn(redactor.text(message), clean(fields)),
    error: (message, fields) => inner.error(redactor.text(message), clean(fields)),
    child: (fields) => redactingLogger(inner.child(redactor.json(fields)), redactor),
  };
}

type Leave = "done" | "again";
type EndKind = "completed" | "failed" | "cancelled" | "released";

/** One `message.undelivered` record for every applied message the driver never took. */
export function undeliveredRecords(state: ReplayState): NewJournalRecord[] {
  const records: NewJournalRecord[] = [];
  for (const m of state.messages) records.push(newRecord("message.undelivered", { commandId: m.commandId, reason: MESSAGE_UNDELIVERED }));
  return records;
}

/**
 * What a run that ends for good (completed, failed, cancelled) settles in its final commit, before its end record:
 * the crash charge of every model attempt still unfinished (invariant M: a request sent in this session whose
 * closing commit failed), a `message.undelivered` for every message no driver took, and the closing of every
 * pending still open, so the run leaves "what needs you". Built with loops, never by spreading an unbounded list
 * into a call.
 */
export function settlementBatch(state: ReplayState, kind: "completed" | "failed" | "cancelled"): {
  records: NewJournalRecord[]; usage: NewUsage[]; resolvePendings: NonNullable<CommitBatch["resolvePendings"]>;
} {
  const charged = interruptedBatch(unfinishedModelStarts(state));
  const records = charged.records.concat(undeliveredRecords(state));
  const resolution = { closed: kind };
  const resolvePendings: NonNullable<CommitBatch["resolvePendings"]> = [];
  for (const p of openPendings(state)) {
    records.push(newRecord("pending.resolved", { pendingId: p.id, kind: p.kind, resolution, commandId: null }, p.stepKey));
    resolvePendings.push({ id: p.id, resolution });
  }
  return { records, usage: charged.usage, resolvePendings };
}
interface EndExtra { output?: Json; error?: unknown }

class RunSession implements SessionCore, Session {
  readonly deps: EngineDeps;
  readonly runId: string;
  readonly done: Promise<void>;
  readonly run: RunRecord;
  readonly inflight = new Map<string, Promise<unknown>>();
  readonly reserved = { micros: 0, turns: 0, toolStarts: 0 };
  readonly repairTurns = new Map<string, Hold>();
  definition!: AgentDefinition;
  workspace = "";
  readonly logger: Logger;
  /** The run's redactor: one object for the whole session, it only learns values (setup, every model step). */
  readonly redactor: GrowingRedactor = createGrowingRedactor();
  toolSecrets: Readonly<Record<string, string>> = {};
  state: ReplayState;
  learning: LearningContext | null = null;

  private readonly lease: Lease;
  private readonly runnerId: string;
  private readonly runAbort = new AbortController();
  private readonly handles = new Set<Registered>();
  private abortCause: AbortCause | null = null;
  private lockTail: Promise<void> = Promise.resolve();
  private fenced = false;
  private stopping = false;
  private forced = false;
  private finished = false;
  private appliedCount = 0;
  private applyScheduled = false;
  /**
   * Set once setup has replayed the journal and committed the claim. Commands are planned against the replayed
   * state only: one that arrives earlier is applied by the main loop's first step, never against the empty state
   * of a session still claiming its workspace and reading its journal.
   */
  private ready = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastWakeAt: number | null = null;

  constructor(deps: EngineDeps, claimed: ClaimedRun, runnerId: string, onEnd: (session: Session) => void) {
    this.deps = deps;
    this.run = claimed.run;
    this.runId = claimed.run.id;
    this.lease = claimed.lease;
    this.runnerId = runnerId;
    this.logger = redactingLogger(deps.logger.child({ runId: this.runId, agentId: this.run.agentId, runnerId }), this.redactor);
    this.state = createReplayState(claimed.run.limits);
    this.done = this.main().finally(() => {
      this.stopWatching();
      onEnd(this);
    });
  }

  get signal(): AbortSignal {
    return this.runAbort.signal;
  }

  // ---------------------------------------------------------------- Session

  ended(): boolean {
    return this.finished || this.fenced;
  }

  requestStop(): void {
    this.stopping = true;
    for (const handle of this.handles) if (handle.onStop) this.abortHandle(handle, "stop");
  }

  forceStop(): void {
    this.forced = true;
    this.requestStop();
    this.abortRun("shutdown");
  }

  fence(reason: "lease_lost" | "abandoned"): void {
    if (this.fenced) return;
    this.fenced = true;
    this.stopWatching();
    this.abortRun("lease_lost");
    if (reason === "lease_lost" && !this.finished) this.logger.warn("runner.fenced", { runId: this.runId, epoch: this.lease.epoch });
    else this.logger.debug("session.abandoned", { runId: this.runId });
  }

  wakeAt(): number | null {
    return this.lastWakeAt;
  }

  onCommand(): void {
    if (!this.ready || this.applyScheduled || this.ended()) return;
    this.applyScheduled = true;
    setImmediate(() => {
      this.applyScheduled = false;
      this.applyCommandsInBackground();
    });
  }

  // ---------------------------------------------------------------- SessionCore

  checkControl(): void {
    if (this.fenced) throw new ControlSignal("lease_lost");
    if (this.state.cancelled !== null) throw new ControlSignal("cancelled");
    if (this.stopping || this.forced) throw new ControlSignal("released");
    if (this.state.paused !== null) throw new ControlSignal("paused");
  }

  commit(batch: CommitBatch | (() => CommitBatch | null), onApplied?: () => void): Promise<JournalRecord[]> {
    return this.withLock(async () => {
      if (typeof batch !== "function") return this.commitUnlocked(batch, onApplied);
      if (this.fenced) throw new ControlSignal("lease_lost");
      const built = batch();
      return built === null ? [] : this.commitUnlocked(built, onApplied);
    });
  }

  register(options: { onPause: boolean; onStop: boolean; deadlineMs?: number }): CallHandle {
    const entry: Registered = { controller: new AbortController(), onPause: options.onPause, onStop: options.onStop, cause: null };
    const onRunAbort = (): void => this.abortHandle(entry, this.abortCause ?? "shutdown");
    let timer: TimerHandle | null = null;
    if (this.runAbort.signal.aborted) onRunAbort();
    else this.runAbort.signal.addEventListener("abort", onRunAbort, { once: true });
    if (options.onStop && this.stopping) this.abortHandle(entry, "stop");
    if (options.onPause && this.state.paused !== null) this.abortHandle(entry, "pause");
    if (options.deadlineMs !== undefined) {
      timer = startTimer(() => this.abortHandle(entry, "deadline"), options.deadlineMs);
    }
    this.handles.add(entry);
    return {
      signal: entry.controller.signal,
      cause: () => entry.cause,
      dispose: () => {
        this.runAbort.signal.removeEventListener("abort", onRunAbort);
        if (timer !== null) timer.clear();
        this.handles.delete(entry);
      },
    };
  }

  deadlineAt(): number | null {
    return null;
  }

  toolScope(): ReadonlySet<string> | null {
    return null;
  }

  expirePendings(): Promise<void> {
    return this.withLock(() => this.expirePendingsUnlocked());
  }

  // ---------------------------------------------------------------- internals

  /**
   * Under the lock: the commands that arrived are applied first (an answer created before the instant wins), then
   * one batch, built from the state as it is now, closes every open pending whose `expiresAt` has passed.
   */
  private async expirePendingsUnlocked(): Promise<void> {
    await this.applyCommandsUnlocked();
    if (this.ended()) return;
    const now = this.deps.clock.now();
    const expired: { pending: PendingEntry; expiresAt: number }[] = [];
    for (const pending of openPendings(this.state)) {
      const expiresAt = pendingExpiry(pending);
      if (expiresAt !== null && expiresAt <= now) expired.push({ pending, expiresAt });
    }
    if (expired.length === 0) return;
    await this.commitUnlocked({
      records: expired.map(({ pending, expiresAt }) => newRecord("pending.resolved", {
        pendingId: pending.id, kind: pending.kind, resolution: { expired: true, expiresAt }, commandId: null,
      }, pending.stepKey)),
      resolvePendings: expired.map(({ pending, expiresAt }) => ({ id: pending.id, resolution: { expired: true, expiresAt } })),
    });
    this.logger.debug("pendings.expired", { pendingIds: expired.map((e) => e.pending.id) });
  }

  private abortHandle(entry: Registered, cause: AbortCause): void {
    if (entry.cause !== null) return;
    entry.cause = cause;
    entry.controller.abort(new RunwrightError("aborted", `aborted: ${cause}`));
  }

  private abortRun(cause: "cancel" | "shutdown" | "lease_lost"): void {
    if (this.abortCause === null) this.abortCause = cause;
    if (!this.runAbort.signal.aborted) this.runAbort.abort(new RunwrightError("aborted", `run aborted: ${cause}`));
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.lockTail.then(fn);
    this.lockTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async commitUnlocked(batch: CommitBatch, onApplied?: () => void): Promise<JournalRecord[]> {
    if (this.fenced) throw new ControlSignal("lease_lost");
    let result;
    try {
      result = await this.deps.store.commit(this.lease, redactCommitBatch(batch, this.redactor));
    } catch (error) {
      if (isRunwrightError(error) && error.code === "lease_lost") {
        this.fence("lease_lost");
        throw new ControlSignal("lease_lost");
      }
      throw error;
    }
    for (const record of result.records) applyRecord(this.state, record);
    onApplied?.();
    return result.records;
  }

  /** Applies the unconsumed commands; false when there was nothing to apply. */
  private async applyCommandsUnlocked(): Promise<boolean> {
    if (this.ended()) return false;
    const commands = await this.deps.store.listCommands(this.runId, { unconsumedOnly: true });
    const plan = planCommands(this.state, commands);
    if (plan === null) return false;
    await this.commitUnlocked(plan.batch);
    this.appliedCount += plan.applied.length;
    for (const command of plan.applied) {
      this.logger.debug("command.applied", { type: command.type });
      if (command.type === "cancel" || (command.type === "resolve_interrupted" && command.action === "cancel")) {
        this.abortRun("cancel");
      } else if (command.type === "pause") {
        for (const handle of this.handles) if (handle.onPause) this.abortHandle(handle, "pause");
      }
    }
    return true;
  }

  private async applyCommands(): Promise<void> {
    await this.withLock(() => this.applyCommandsUnlocked());
  }

  private applyCommandsInBackground(): void {
    this.applyCommands().catch((error: unknown) => {
      if (!isControlSignal(error) && !this.ended()) this.logger.warn("commands.apply_failed", { message: errorInfo(error).message });
    });
  }

  private startWatching(): void {
    this.pollTimer = setInterval(() => this.applyCommandsInBackground(), intervalMs(this.deps.config.pollMs));
    this.pollTimer.unref();
  }

  private stopWatching(): void {
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /**
   * Creates the workspace and claims its stage for this lease's epoch (rule F, `src/tools/workspace-stage.ts`), so
   * the folder of the previous claim is renamed away before this session replays a step and no file write of a
   * runner that lost the run can land after that. A stage folder of a later epoch means this lease was taken over:
   * the session ends like a fenced commit, writing nothing. Unless the store still shows this very lease: a claim
   * creates its folder only after its store claim, so a later folder the store knows no claim of was not made by a
   * claim (`shell` or a host tool wrote it), and the run fails with an error that says so instead of being claimed
   * and fenced again after every lease period.
   */
  private async claimWorkspace(): Promise<void> {
    this.workspace = join(this.deps.config.workspacesDir, this.runId);
    await mkdir(this.workspace, { recursive: true });
    try {
      await claimWorkspaceStage(this.workspace, this.lease.epoch);
    } catch (error) {
      if (!isRunwrightError(error) || error.code !== "lease_lost") throw error;
      const current = await this.deps.store.getRun(this.runId);
      if (current !== null && current.status === "running" && current.epoch === this.lease.epoch && current.leaseOwner === this.runnerId) {
        throw new RunwrightError("internal", `${join(this.workspace, STAGE_DIR)} holds a folder of a later epoch than ` +
          `this run's lease (${this.lease.epoch}) that no claim made`);
      }
      this.fence("lease_lost");
      throw new ControlSignal("lease_lost");
    }
  }

  private async setup(): Promise<void> {
    const { deps } = this;
    await this.claimWorkspace();
    const records: JournalRecord[] = [];
    for (;;) {
      const page = await deps.store.readJournal(this.runId, { afterSeq: records.length === 0 ? 0 : (records[records.length - 1] as JournalRecord).seq, limit: JOURNAL_PAGE });
      for (const record of page) records.push(record);
      if (page.length < JOURNAL_PAGE) break;
    }
    this.state = replayJournal(records, this.run.limits);
    // An open repair's turn was admitted by an earlier session and is counted only when its step finishes: it is
    // reserved before any step of this session is admitted, so no other step can take it meanwhile.
    for (const key of openRepairs(this.state)) holdRepairTurn(this, key);
    const revision = await deps.store.getRevision(this.run.agentId, this.run.revision);
    if (revision === null) {
      throw new RunwrightError("not_found", `agent ${this.run.agentId} has no revision ${this.run.revision}`);
    }
    this.definition = revision.definition;
    const toolSecretNames = this.definition.secrets ?? [];
    const keyName = apiKeySecretName(this.definition.model);
    const names = [...new Set([...toolSecretNames, ...(keyName === null ? [] : [keyName])])];
    const revealed = names.length === 0 ? {} : await deps.secrets.reveal(names);
    for (const [name, value] of Object.entries(revealed)) this.redactor.add(name, value);
    const toolSecrets: Record<string, string> = {};
    for (const name of toolSecretNames) {
      const value = revealed[name];
      if (value !== undefined) toolSecrets[name] = value;
    }
    this.toolSecrets = Object.freeze(toolSecrets);
    // Nothing of this run is in flight yet, so every attempt still unfinished was left by a crash: it is charged
    // in the claim's own commit, before any command is applied (invariant M), and exactly once, since its key's
    // last model record is then the model.interrupted.
    const crashed = unfinishedModelStarts(this.state);
    const charged = interruptedBatch(crashed);
    await this.commit({
      records: [newRecord("run.claimed", { runnerId: this.runnerId })].concat(charged.records),
      ...(charged.usage.length > 0 ? { usage: charged.usage } : {}),
    });
    this.logger.info("run.claimed", { epoch: this.lease.epoch, replayedRecords: records.length });
    for (const entry of crashed) this.logger.debug("model.interrupted", { key: entry.key, reason: "crash", attempt: entry.attempt });
  }

  private async main(): Promise<void> {
    try {
      await this.setup();
    } catch (error) {
      if (isControlSignal(error)) return;
      await this.finish("failed", { error });
      return;
    }
    this.ready = true;
    this.startWatching();
    const context = createRunContext(this, "");
    for (;;) {
      let mark: number;
      try {
        await this.applyCommands();
        if (this.state.cancelled !== null) {
          await this.finish("cancelled");
          return;
        }
        if (this.stopping) {
          await this.finish("released");
          return;
        }
        mark = this.appliedCount;
        if (this.state.paused !== null) {
          if ((await this.leave("paused", mark)) === "again") continue;
          return;
        }
      } catch (error) {
        if (isControlSignal(error)) return;
        this.logger.error("session.error", { message: errorInfo(error).message });
        return;
      }
      try {
        const output = await this.drive(context);
        // A pause that arrived while the run was finishing leaves it paused; it completes on resume.
        if ((await this.finish("completed", { output })) === "again") continue;
        return;
      } catch (error) {
        const next = await this.afterThrow(error, mark);
        if (next === "again") continue;
        return;
      }
    }
  }

  private async afterThrow(error: unknown, mark: number): Promise<Leave> {
    try {
      if (isControlSignal(error)) {
        switch (error.reason) {
          case "waiting":
            return await this.leave("waiting", mark);
          case "paused":
            return await this.leave("paused", mark);
          case "cancelled":
            return await this.finish("cancelled");
          case "released":
            return await this.finish("released");
          case "lease_lost":
            // Also when no commit saw it yet: a step whose file write found the workspace stage taken over.
            this.fence("lease_lost");
            return "done";
        }
      }
      if (this.fenced) return "done";
      if (this.state.cancelled !== null) return await this.finish("cancelled");
      if (this.forced) return await this.finish("released");
      return await this.finish("failed", { error });
    } catch (failure) {
      if (!isControlSignal(failure)) this.logger.error("session.error", { message: errorInfo(failure).message });
      return "done";
    }
  }

  private async drive(context: RunContext): Promise<Json> {
    const { deps, definition } = this;
    const hooks = definition.learning ? deps.learning : null;
    let output: Json;
    if (this.state.output === null) {
      if (hooks !== null) this.learning = await hooks.prepare(context);
      const driver = definition.workflow !== undefined ? deps.drivers.workflow : deps.drivers.agent;
      const produced = await driver(context);
      // Built under the lock: no message can be applied between reading the undelivered ones and this commit.
      await this.withLock(() => this.commitUnlocked({
        records: [newRecord("run.output", { output: produced === undefined ? null : produced })].concat(undeliveredRecords(this.state)),
      }));
      output = this.state.output === null ? null : (this.state.output as { output: Json }).output;
    } else {
      output = this.state.output.output;
      if (hooks !== null) this.learning = await hooks.prepare(context);
    }
    if (hooks !== null) {
      try {
        await hooks.afterRun(context, { output });
      } catch (error) {
        if (isControlSignal(error)) throw error;
        const reason = errorInfo(error).message;
        this.logger.warn("learning.skipped", { reason });
        await context.emit("learning", "learning.skipped", { reason });
      }
    }
    return output;
  }

  /**
   * Leave `running` for waiting or paused unless a command arrived meanwhile (then the caller runs again). Waiting
   * stores the earliest `expiresAt` of the open pendings as the run's wake time. A due wake is never stored: when
   * an open pending has already expired, it is closed (with the commands that arrived applied first) and the
   * caller runs again, so the step that waits on it fails instead of waiting.
   */
  private leave(to: "waiting" | "paused", mark: number): Promise<Leave> {
    this.lastWakeAt = null;
    return this.withLock(async () => {
      if (this.ended()) return "done";
      if (this.appliedCount !== mark) return "again";
      if (to === "paused" && this.state.paused === null) return "again";
      let batch: CommitBatch;
      let wakeAt: number | null = null;
      if (to === "waiting") {
        const open = openPendings(this.state);
        if (open.length === 0) {
          return this.finishUnlocked("failed", { error: new RunwrightError("internal", "the driver suspended with nothing to wait for") });
        }
        for (const pending of open) {
          const at = pendingExpiry(pending);
          if (at !== null && (wakeAt === null || at < wakeAt)) wakeAt = at;
        }
        if (wakeAt !== null && wakeAt <= this.deps.clock.now()) {
          await this.expirePendingsUnlocked();
          return "again";
        }
        const transition: NonNullable<CommitBatch["transition"]> = wakeAt === null ? { to } : { to, wakeAt };
        batch = { records: [newRecord("run.waiting", { pendingIds: open.map((p) => p.id) })], transition };
      } else {
        batch = { records: [newRecord("run.paused", { commandId: this.state.paused?.commandId ?? null })], transition: { to } };
      }
      try {
        await this.commitUnlocked(batch);
      } catch (error) {
        if (isRunwrightError(error) && error.code === "commands_pending") return "again";
        throw error;
      }
      this.finished = true;
      this.lastWakeAt = wakeAt;
      this.logger.info(`run.${to}`, wakeAt === null ? {} : { wakeAt });
      return "done";
    });
  }

  private endBatch(kind: EndKind, extra?: EndExtra): CommitBatch {
    let batch: CommitBatch;
    switch (kind) {
      case "completed": {
        const output = extra?.output ?? null;
        batch = { records: [newRecord("run.completed", { output })], transition: { to: "completed", output } };
        break;
      }
      case "failed": {
        const error = errorInfo(extra?.error);
        batch = { records: [newRecord("run.failed", { error })], transition: { to: "failed", error } };
        break;
      }
      case "cancelled":
        batch = {
          records: [newRecord("run.cancelled", { reason: this.state.cancelled?.reason ?? null })],
          transition: { to: "cancelled" },
        };
        break;
      case "released":
        return {
          records: [newRecord("run.released", { reason: this.forced ? "forced shutdown" : "shutdown" })],
          transition: { to: "queued" },
        };
    }
    // Built from the state as it is now (endBatch runs again after every commands_pending refusal).
    const settled = settlementBatch(this.state, kind);
    batch.records = settled.records.concat(batch.records);
    if (settled.usage.length > 0) batch.usage = settled.usage;
    if (settled.resolvePendings.length > 0) batch.resolvePendings = settled.resolvePendings;
    return batch;
  }

  private finish(kind: EndKind, extra?: EndExtra): Promise<Leave> {
    return this.withLock(() => this.finishUnlocked(kind, extra));
  }

  /**
   * Leaves `running` for good, or releases the run. The store refuses the commit while a command is unconsumed
   * (plan 4.2); then the waiting commands are applied and the end decided again. Before every attempt: an applied
   * cancel makes the run cancelled, an applied pause stops a completion ("again": the main loop leaves the run
   * paused, and it completes on resume); anything else tries the same end once more. "done" means the run left `running` or the session is
   * fenced or gave up.
   */
  private async finishUnlocked(kind: EndKind, extra?: EndExtra): Promise<Leave> {
    this.lastWakeAt = null;
    let end = kind;
    try {
      for (;;) {
        if (this.ended()) return "done";
        if (end !== "released" && this.state.cancelled !== null) end = "cancelled";
        else if (end === "completed" && this.state.paused !== null) return "again";
        try {
          await this.commitUnlocked(this.endBatch(end, extra));
          break;
        } catch (error) {
          if (!isRunwrightError(error) || error.code !== "commands_pending") throw error;
        }
        if (!(await this.applyCommandsUnlocked())) {
          throw new RunwrightError("internal", "the store reports unconsumed commands that cannot be applied");
        }
      }
    } catch (error) {
      if (!isControlSignal(error)) this.logger.error("session.finish_failed", { message: errorInfo(error).message });
      return "done";
    }
    this.finished = true;
    this.logger.info(`run.${end}`, end === "failed" ? { code: errorInfo(extra?.error).code } : {});
    return "done";
  }
}

/** Starts executing a claimed run; `onEnd` is called once the session has unwound. */
export function startSession(deps: EngineDeps, claimed: ClaimedRun, runnerId: string, onEnd: (session: Session) => void): Session {
  return new RunSession(deps, claimed, runnerId, onEnd);
}
