import type { IncomingMessage, ServerResponse } from "node:http";
import { intervalMs, startTimer, type TimerHandle } from "../core/clock.ts";
import { RunwrightError } from "../core/errors.ts";
import { redactJsonWith } from "../core/redact.ts";
import type { EphemeralEvent, EphemeralEvents } from "../core/events.ts";
import type { Logger } from "../log/logger.ts";
import { isTerminal } from "../store/state-machine.ts";
import type { JournalRecord, RunRecord, RunStatus, Store, StoreEvent } from "../store/types.ts";
import { baseHeaders } from "./http.ts";

export interface SseHubDeps {
  store: Store;
  events: EphemeralEvents | null;
  logger: Logger;
  pollMs: number;
  pingMs: number;
  redact: (text: string) => string;
  /**
   * A subscriber whose response stays above its high-water mark (a `write` returned false and no `drain` came)
   * for this long is dropped as too slow (default 30 000 ms; a finite number >= 0).
   */
  drainTimeoutMs?: number;
}

export interface SseHub {
  /** Streams the run's journal after `afterSeq`, then live records, until the run is terminal or the client leaves. */
  subscribe(req: IncomingMessage, res: ServerResponse, requestId: string, run: RunRecord, afterSeq: number): Promise<void>;
  /** Number of open streams (all runs). */
  size(): number;
  /** Ends every open stream and stops the timers. */
  close(): void;
}

interface Subscriber {
  res: ServerResponse;
  /** Seq of the last record written to this subscriber. */
  sent: number;
  catchingUp: boolean;
  closed: boolean;
  /** A write returned false: nothing more is written until the response drains (or the drain timer drops it). */
  blocked: boolean;
  drainTimer: TimerHandle | null;
  onDrain: (() => void) | null;
}

interface Channel {
  runId: string;
  subscribers: Set<Subscriber>;
  /** Highest seq seen for this run (events, polls, reads). */
  knownSeq: number;
  /** Set once the run is known to be terminal: its status and final journal seq. */
  terminal: { status: RunStatus; finalSeq: number } | null;
  stopDeltas: (() => void) | null;
  polling: boolean;
}

const PAGE = 500;
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

/** The data line of an event: the value is redacted (strings, keys, numbers holding a secret), then serialized. */
function dataLine(value: unknown, redact: (text: string) => string): string {
  return `data: ${JSON.stringify(redactJsonWith(value, redact, { numbers: true }))}`;
}

function formatRecord(record: JournalRecord, redact: (text: string) => string): string {
  return `id: ${record.seq}\nevent: ${record.type}\n${dataLine(record, redact)}\n\n`;
}

/**
 * One registry of subscribers per run, fed by a single store listener: a journal event is formatted once and the
 * same text written to every subscriber of the run. A subscriber only ever receives the record right after the
 * last one it was sent; on a gap it catches up from the store, so the backlog/live switch has no gaps and no
 * duplicates. A poll every `pollMs` covers runners in other processes. The channel's `knownSeq` and `terminal`
 * are shared, so whatever raises them (a poll, a store event, another subscriber connecting) also catches up
 * every subscriber of the channel whose `sent` is below `knownSeq` and that is not already catching up, and ends
 * every one that has been sent everything: no subscriber is left behind by another one's progress.
 *
 * Backpressure needs no queue, because every subscriber can be brought up to date from the store by its `sent`
 * seq: when a write returns false the subscriber is `blocked`, nothing more is written to it (journal records are
 * skipped by `deliver` and read again later; pings and deltas, which are not journalled, are simply not sent),
 * and on the response's `drain` it catches up from `sent`. So at most one high-water mark plus one event is
 * queued per subscriber. Only a subscriber that stays blocked for `drainTimeoutMs` is dropped.
 */
export function createSseHub(deps: SseHubDeps): SseHub {
  const channels = new Map<string, Channel>();
  const drainTimeoutMs = deps.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  if (typeof drainTimeoutMs !== "number" || !Number.isFinite(drainTimeoutMs) || drainTimeoutMs < 0) {
    throw new RunwrightError("bad_request", `drainTimeoutMs must be a finite number >= 0, got ${String(drainTimeoutMs)}`);
  }
  let closed = false;
  let unsubscribeStore: (() => void) | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let pingTimer: NodeJS.Timeout | null = null;

  /**
   * Writes `text` unless the subscriber is closed or blocked (then false: nothing was written). When the response
   * goes above its high-water mark the text was still accepted (true), and the subscriber becomes blocked.
   */
  const write = (channel: Channel, sub: Subscriber, text: string): boolean => {
    if (sub.closed || sub.blocked) return false;
    if (!sub.res.write(text)) block(channel, sub);
    return true;
  };

  /** Stops writing to `sub` until its response drains; drops it when that takes longer than `drainTimeoutMs`. */
  const block = (channel: Channel, sub: Subscriber): void => {
    sub.blocked = true;
    const onDrain = (): void => {
      sub.onDrain = null;
      sub.drainTimer?.clear();
      sub.drainTimer = null;
      sub.blocked = false;
      void catchUp(channel, sub);
    };
    sub.onDrain = onDrain;
    sub.res.once("drain", onDrain);
    sub.drainTimer = startTimer(() => {
      sub.drainTimer = null;
      if (sub.closed || !sub.blocked) return;
      deps.logger.warn("sse subscriber dropped: client too slow", { runId: channel.runId, drainTimeoutMs });
      drop(channel, sub, true);
    }, drainTimeoutMs).unref();
  };

  const drop = (channel: Channel, sub: Subscriber, destroy: boolean): void => {
    if (sub.closed) return;
    sub.closed = true;
    sub.drainTimer?.clear();
    sub.drainTimer = null;
    if (sub.onDrain !== null) sub.res.off("drain", sub.onDrain);
    sub.onDrain = null;
    channel.subscribers.delete(sub);
    if (destroy) sub.res.destroy();
    else sub.res.end();
    if (channel.subscribers.size === 0) {
      channel.stopDeltas?.();
      channels.delete(channel.runId);
    }
    if (channels.size === 0) stopTimers();
  };

  const maybeEnd = (channel: Channel, sub: Subscriber): void => {
    if (sub.closed || sub.catchingUp || sub.blocked || channel.terminal === null) return;
    if (sub.sent < channel.terminal.finalSeq) return;
    if (write(channel, sub, `event: end\ndata: ${JSON.stringify({ status: channel.terminal.status })}\n\n`)) drop(channel, sub, false);
  };

  /**
   * Marks the channel terminal from a run record. An archived journal has no records left to send, so its final
   * seq is 0 and every subscriber ends; otherwise it is the run's journal seq, which `knownSeq` is raised to.
   */
  const markTerminal = (channel: Channel, run: Pick<RunRecord, "status" | "journalSeq" | "journalArchivedAt">): void => {
    if (!isTerminal(run.status)) return;
    channel.terminal = { status: run.status, finalSeq: run.journalArchivedAt !== null ? 0 : run.journalSeq };
    if (run.journalSeq > channel.knownSeq && run.journalArchivedAt === null) channel.knownSeq = run.journalSeq;
  };

  const catchUp = async (channel: Channel, sub: Subscriber): Promise<void> => {
    if (sub.catchingUp || sub.closed || sub.blocked) return;
    sub.catchingUp = true;
    try {
      for (;;) {
        const knownBefore = channel.knownSeq;
        const sentBefore = sub.sent;
        const records = await deps.store.readJournal(channel.runId, { afterSeq: sub.sent, limit: PAGE });
        for (const record of records) {
          if (record.seq !== sub.sent + 1) continue;
          if (!write(channel, sub, formatRecord(record, deps.redact))) return;
          sub.sent = record.seq;
          if (record.seq > channel.knownSeq) channel.knownSeq = record.seq;
          // Above the high-water mark: the drain handler resumes from `sent`.
          if (sub.blocked) return;
        }
        const progressed = sub.sent > sentBefore;
        if (records.length === PAGE && progressed) continue;
        // Records committed while the read was in flight were skipped by deliver(); read again for them, as long
        // as a read makes progress or something new became known during it.
        if (channel.knownSeq > sub.sent && (progressed || channel.knownSeq !== knownBefore)) continue;
        break;
      }
    } catch (error) {
      deps.logger.warn("sse backlog read failed", { runId: channel.runId, error: error instanceof Error ? error.message : String(error) });
      drop(channel, sub, true);
      return;
    } finally {
      sub.catchingUp = false;
    }
    maybeEnd(channel, sub);
  };

  /**
   * After `knownSeq` or `terminal` changed: catches up every subscriber (but `except`) whose `sent` is below
   * `knownSeq` and that is not already catching up, and ends every other one that has been sent everything.
   */
  const advanceAll = (channel: Channel, except: Subscriber | null): Promise<void> => {
    const work: Promise<void>[] = [];
    for (const sub of [...channel.subscribers]) {
      if (sub === except || sub.closed || sub.catchingUp || sub.blocked) continue;
      if (sub.sent < channel.knownSeq) work.push(catchUp(channel, sub));
      else maybeEnd(channel, sub);
    }
    return Promise.all(work).then(() => undefined);
  };

  const deliver = (channel: Channel, records: readonly JournalRecord[]): void => {
    for (const record of records) {
      if (record.seq > channel.knownSeq) channel.knownSeq = record.seq;
      let text: string | null = null;
      for (const sub of [...channel.subscribers]) {
        if (sub.catchingUp || sub.closed || sub.blocked || record.seq <= sub.sent) continue;
        if (record.seq !== sub.sent + 1) {
          void catchUp(channel, sub);
          continue;
        }
        text ??= formatRecord(record, deps.redact);
        if (write(channel, sub, text)) sub.sent = record.seq;
      }
    }
  };

  const onStoreEvent = (event: StoreEvent): void => {
    if (event.type !== "journal") return;
    const channel = channels.get(event.runId);
    if (channel === undefined) return;
    const sorted = [...event.records].sort((a, b) => a.seq - b.seq);
    deliver(channel, sorted);
    if (isTerminal(event.status)) {
      const last = sorted[sorted.length - 1];
      channel.terminal = { status: event.status, finalSeq: Math.max(channel.knownSeq, last?.seq ?? 0) };
    }
    void advanceAll(channel, null);
  };

  const lagging = (channel: Channel): boolean => {
    const terminal = channel.terminal;
    if (terminal === null) return false;
    for (const sub of channel.subscribers) if (!sub.closed && !sub.catchingUp && !sub.blocked && sub.sent < terminal.finalSeq) return true;
    return false;
  };

  const poll = async (channel: Channel): Promise<void> => {
    if (channel.polling) return;
    channel.polling = true;
    try {
      for (;;) {
        const records = await deps.store.readJournal(channel.runId, { afterSeq: channel.knownSeq, limit: PAGE });
        deliver(channel, records);
        if (records.length < PAGE) break;
      }
      if (channel.terminal === null) {
        const run = await deps.store.getRun(channel.runId);
        if (run !== null) markTerminal(channel, run);
      }
      await advanceAll(channel, null);
      // A terminal run whose subscribers could not be caught up: its journal may have been archived since.
      if (lagging(channel)) {
        const run = await deps.store.getRun(channel.runId);
        if (run !== null) markTerminal(channel, run);
        await advanceAll(channel, null);
      }
    } catch (error) {
      deps.logger.warn("sse poll failed", { runId: channel.runId, error: error instanceof Error ? error.message : String(error) });
    } finally {
      channel.polling = false;
    }
  };

  const startTimers = (): void => {
    if (unsubscribeStore === null) unsubscribeStore = deps.store.subscribe(onStoreEvent);
    if (pollTimer === null) {
      pollTimer = setInterval(() => {
        for (const channel of channels.values()) void poll(channel);
      }, intervalMs(deps.pollMs, 5));
      pollTimer.unref();
    }
    if (pingTimer === null) {
      pingTimer = setInterval(() => {
        for (const channel of channels.values()) {
          for (const sub of [...channel.subscribers]) write(channel, sub, ": ping\n\n");
        }
      }, intervalMs(deps.pingMs, 5));
      pingTimer.unref();
    }
  };

  function stopTimers(): void {
    unsubscribeStore?.();
    unsubscribeStore = null;
    if (pollTimer !== null) clearInterval(pollTimer);
    if (pingTimer !== null) clearInterval(pingTimer);
    pollTimer = null;
    pingTimer = null;
  }

  const channelFor = (runId: string): Channel => {
    let channel = channels.get(runId);
    if (channel !== undefined) return channel;
    const created: Channel = { runId, subscribers: new Set(), knownSeq: 0, terminal: null, stopDeltas: null, polling: false };
    if (deps.events !== null) {
      created.stopDeltas = deps.events.subscribe(runId, (event: EphemeralEvent) => {
        const text = `event: delta\n${dataLine({ runId: event.runId, key: event.key, text: event.text }, deps.redact)}\n\n`;
        for (const sub of [...created.subscribers]) write(created, sub, text);
      });
    }
    channels.set(runId, created);
    channel = created;
    return channel;
  };

  return {
    async subscribe(req, res, requestId, run, afterSeq) {
      baseHeaders(res, requestId);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.writeHead(200);
      if (closed) {
        res.end();
        return;
      }
      res.write(": connected\n\n");
      startTimers();
      const channel = channelFor(run.id);
      const sub: Subscriber = { res, sent: afterSeq, catchingUp: false, closed: false, blocked: false, drainTimer: null, onDrain: null };
      channel.subscribers.add(sub);
      const knownBefore = channel.knownSeq;
      const terminalBefore = channel.terminal;
      if (run.journalSeq > channel.knownSeq && run.journalArchivedAt === null) channel.knownSeq = run.journalSeq;
      markTerminal(channel, run);
      const onClose = (): void => drop(channel, sub, false);
      req.once("close", onClose);
      res.once("close", onClose);
      if (channel.knownSeq !== knownBefore || channel.terminal !== terminalBefore) void advanceAll(channel, sub);
      await catchUp(channel, sub);
    },
    size() {
      let count = 0;
      for (const channel of channels.values()) count += channel.subscribers.size;
      return count;
    },
    close() {
      closed = true;
      for (const channel of [...channels.values()]) {
        for (const sub of [...channel.subscribers]) drop(channel, sub, false);
      }
      stopTimers();
    },
  };
}
