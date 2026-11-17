import { RunwrightError } from "../core/errors.ts";

/** One Server-Sent Event as it arrived: `id` is null when the event carried no id field. */
export interface RawSseEvent { id: string | null; event: string; data: string }

const DEFAULT_MAX_EVENT_CHARS = 16 * 1024 * 1024;

/**
 * Incremental Server-Sent Events parser (the text/event-stream format): feed it decoded text in chunks of any
 * size; it returns the events completed so far. Handles CRLF / CR / LF line ends, comments, multi-line data,
 * fields without a value and a chunk boundary anywhere, including inside a CRLF pair.
 *
 * The text held for one event is bounded: a line that has not ended, or the data of an event that has not been
 * dispatched, longer than `maxEventChars` (default 16 Mi UTF-16 code units) fails the stream with
 * RunwrightError("unavailable") instead of growing without bound.
 */
export class SseParser {
  private readonly maxEventChars: number;
  private buffer = "";
  private dataChars = 0;
  private data: string[] = [];
  private event = "";
  private id: string | null = null;
  private hasData = false;
  private pendingCr = false;

  constructor(options?: { maxEventChars?: number }) {
    const max = options?.maxEventChars ?? DEFAULT_MAX_EVENT_CHARS;
    if (!Number.isFinite(max) || max < 1) {
      throw new RunwrightError("bad_request", `maxEventChars must be a finite number >= 1, got ${String(max)}`);
    }
    this.maxEventChars = max;
  }

  push(text: string): RawSseEvent[] {
    let input = text;
    if (this.pendingCr) {
      if (input.startsWith("\n")) input = input.slice(1);
      this.pendingCr = false;
    }
    this.buffer += input;
    const events: RawSseEvent[] = [];
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer);
      if (match === null) break;
      if (match[0] === "\r" && match.index === this.buffer.length - 1) {
        // A CR at the very end may be the first half of CRLF: take the line, skip a following LF.
        this.pendingCr = true;
      }
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const event = this.line(line);
      if (event !== null) events.push(event);
    }
    if (this.buffer.length > this.maxEventChars) this.tooLong();
    return events;
  }

  /** Last id seen (the value to send as Last-Event-ID on reconnect). */
  lastEventId: string | null = null;

  private line(line: string): RawSseEvent | null {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "data":
        this.dataChars += value.length + 1;
        if (this.dataChars > this.maxEventChars) this.tooLong();
        this.data.push(value);
        this.hasData = true;
        break;
      case "event":
        this.event = value;
        break;
      case "id":
        if (!value.includes("\0")) this.id = value;
        break;
      default:
        break;
    }
    return null;
  }

  private tooLong(): never {
    this.buffer = "";
    this.data = [];
    this.dataChars = 0;
    throw new RunwrightError("unavailable", `the event stream sent an event longer than ${this.maxEventChars} characters`);
  }

  private dispatch(): RawSseEvent | null {
    const id = this.id;
    const out: RawSseEvent | null = this.hasData ? { id, event: this.event === "" ? "message" : this.event, data: this.data.join("\n") } : null;
    if (id !== null) this.lastEventId = id;
    this.data = [];
    this.dataChars = 0;
    this.event = "";
    this.id = null;
    this.hasData = false;
    return out;
  }
}
