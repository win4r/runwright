import type { Json } from "./json.ts";

/** A secret value is accepted, stored and redacted when it has at least this many UTF-8 bytes. */
export const MIN_SECRET_BYTES = 8;

/**
 * Every textual form of a secret value that is redacted: the value, its base64 (padded and unpadded), base64url,
 * percent-encoded (encodeURIComponent) and JSON-string-escaped (JSON.stringify(value).slice(1, -1)) forms,
 * without duplicates. Returns [] for a value shorter than MIN_SECRET_BYTES bytes.
 */
export function secretForms(value: string): string[] {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < MIN_SECRET_BYTES) return [];
  const bytes = Buffer.from(value, "utf8");
  const base64 = bytes.toString("base64");
  const forms = new Set<string>([value, base64, base64.replace(/=+$/, ""), bytes.toString("base64url")]);
  try {
    forms.add(encodeURIComponent(value));
  } catch {
    // A lone surrogate has no percent-encoding; the value is still redacted in every other form.
  }
  forms.add(JSON.stringify(value).slice(1, -1));
  return [...forms];
}

/** Redaction of text that arrives in pieces. */
export interface StreamRedactor {
  /** Adds a piece; returns the text that is now safe to release (possibly ""). */
  push(chunk: string): string;
  /** Releases what is still held (redacted as a whole) and resets the stream. */
  flush(): string;
}

export interface Redactor {
  readonly names: readonly string[];
  text(value: string): string;
  /**
   * Engine mode: `text` over every string and every object key; numbers are kept. Used for the fields of a run's
   * log lines and for a promoted workflow document (whose numbers are structure). Journal records are not redacted
   * with it: they are redacted field by field (`redactBySpec` in `src/store/record-fields.ts`).
   */
  json<T extends Json>(value: T): T;
  /**
   * Payload mode: `json`, and a number whose digits hold a secret becomes the redacted text (a string). For caller,
   * model, tool and driver values, a field of a record the field specification does not name, and a record of a
   * type the engine does not write.
   */
  payload(value: Json): Json;
  contains(value: string): boolean;
  /** A new stream over the same secrets. */
  stream(): StreamRedactor;
}

/** Replaces registered forms in text: leftmost position first, the longest form that matches at a position. */
export interface FormMatcher {
  text(value: string): string;
  contains(value: string): boolean;
  stream(): StreamRedactor;
}

/** One registered form and the text that replaces it. */
interface Form { readonly text: string; readonly placeholder: string }

/** Longest first; equal lengths in code-unit order, so the order is deterministic. */
function longestFirst(a: Form, b: Form): number {
  return b.text.length - a.text.length || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0);
}

const passThrough: StreamRedactor = { push: (chunk) => chunk, flush: () => "" };

/**
 * A matcher over `placeholders` (form -> replacement). Candidate positions are found by a native scan for the
 * first code units of the forms; only there are whole forms compared. A large form therefore costs nothing until
 * its first character shows up, and no regular expression is built from the forms themselves.
 */
export function createFormMatcher(placeholders: ReadonlyMap<string, string>): FormMatcher {
  const byFirst = new Map<number, Form[]>();
  for (const [text, placeholder] of placeholders) {
    if (text === "") continue;
    const first = text.charCodeAt(0);
    const group = byFirst.get(first);
    if (group === undefined) byFirst.set(first, [{ text, placeholder }]);
    else group.push({ text, placeholder });
  }
  if (byFirst.size === 0) return { text: (value) => value, contains: () => false, stream: () => passThrough };
  for (const group of byFirst.values()) group.sort(longestFirst);
  const classBody = [...byFirst.keys()].map((code) => `\\u${code.toString(16).padStart(4, "0")}`).join("");
  const starts = new RegExp(`[${classBody}]`, "g");

  /** The next position at or after `from` whose code unit starts some form, or -1. */
  const nextStart = (buffer: string, from: number): number => {
    starts.lastIndex = from;
    const found = starts.exec(buffer);
    return found === null ? -1 : found.index;
  };

  /**
   * Scans `buffer`. With `final` false, stops at the first position where the rest of the buffer is a proper
   * prefix of a form (a match may still start there) and reports it as `heldFrom`.
   */
  const scan = (buffer: string, final: boolean): { out: string; heldFrom: number | null } => {
    let out = "";
    let plainFrom = 0;
    let i = nextStart(buffer, 0);
    while (i !== -1) {
      const restLength = buffer.length - i;
      let match: Form | null = null;
      for (const form of byFirst.get(buffer.charCodeAt(i)) ?? []) {
        if (form.text.length > restLength) {
          if (!final && form.text.startsWith(buffer.slice(i))) return { out: out + buffer.slice(plainFrom, i), heldFrom: i };
        } else if (buffer.startsWith(form.text, i)) {
          match = form;
          break;
        }
      }
      if (match === null) {
        i = nextStart(buffer, i + 1);
        continue;
      }
      out += buffer.slice(plainFrom, i) + match.placeholder;
      plainFrom = i + match.text.length;
      i = nextStart(buffer, plainFrom);
    }
    return { out: plainFrom === 0 ? buffer : out + buffer.slice(plainFrom), heldFrom: null };
  };

  const text = (value: string): string => scan(value, true).out;

  return {
    text,
    contains(value: string): boolean {
      for (let i = nextStart(value, 0); i !== -1; i = nextStart(value, i + 1)) {
        for (const form of byFirst.get(value.charCodeAt(i)) ?? []) if (value.startsWith(form.text, i)) return true;
      }
      return false;
    },
    stream(): StreamRedactor {
      let held = "";
      return {
        push(chunk: string): string {
          const buffer = held + chunk;
          const { out, heldFrom } = scan(buffer, false);
          held = heldFrom === null ? "" : buffer.slice(heldFrom);
          return out;
        },
        flush(): string {
          const rest = held;
          held = "";
          return rest === "" ? "" : text(rest);
        },
      };
    },
  };
}

/** What `JSON.stringify` makes of a value in an array or at the top: `undefined` for a value it leaves out. */
function jsonReplacement(value: unknown, key: string): unknown {
  let current = value;
  if (current !== null && typeof current === "object" && typeof (current as { toJSON?: unknown }).toJSON === "function") {
    current = (current as { toJSON: (key: string) => unknown }).toJSON(key);
  }
  if (current instanceof Number || current instanceof String || current instanceof Boolean) current = current.valueOf();
  return current;
}

/**
 * `value` with `text` applied to every string and every object key, at any depth. Booleans and null are kept.
 * Own enumerable string keys only; a key named "__proto__" stays an own property; `undefined` properties are
 * dropped. Numbers: kept as they are, unless `options.numbers` is true; then a number whose JSON text is
 * changed by `text` (its digits hold a secret) is replaced by that redacted text, as a string. The result
 * always serializes to valid JSON. Every output boundary and every stored caller, model, tool or driver value
 * uses `numbers: true` (payload mode); numbers are kept (engine mode) for a run's log fields and a promoted
 * workflow document. A journal record is not redacted whole: it is walked field by field by its specification
 * (`src/store/record-fields.ts`), which calls this function only for its payload values.
 *
 * The value is read the way `JSON.stringify` reads it: `toJSON` is called, boxed primitives are unboxed, a
 * non-finite number is null, a function, symbol, bigint or `undefined` is dropped from an object and null in an
 * array or at the top, and a cycle throws a TypeError. When two keys redact to the same text the later one wins.
 */
export function redactJsonWith(value: unknown, text: (value: string) => string, options?: { numbers?: boolean }): Json {
  const numbers = options?.numbers === true;
  const ancestors: object[] = [];

  /** The redacted JSON of `raw`, or `undefined` when JSON.stringify would leave it out. */
  const walk = (raw: unknown, key: string): Json | undefined => {
    const current = jsonReplacement(raw, key);
    switch (typeof current) {
      case "string":
        return text(current);
      case "boolean":
        return current;
      case "number": {
        if (!Number.isFinite(current)) return null;
        if (!numbers) return current;
        const serialized = JSON.stringify(current);
        const redacted = text(serialized);
        return redacted === serialized ? current : redacted;
      }
      case "object":
        break;
      default:
        return undefined;
    }
    if (current === null) return null;
    if (ancestors.includes(current)) throw new TypeError("Converting circular structure to JSON");
    ancestors.push(current);
    try {
      if (Array.isArray(current)) {
        return current.map((item: unknown, index) => walk(item, String(index)) ?? null);
      }
      const out: { [key: string]: Json } = {};
      for (const name of Object.keys(current)) {
        const item = walk((current as Record<string, unknown>)[name], name);
        if (item === undefined) continue;
        Object.defineProperty(out, text(name), { value: item, enumerable: true, writable: true, configurable: true });
      }
      return out;
    } finally {
      ancestors.pop();
    }
  };

  return walk(value, "") ?? null;
}

/** A Redactor that can learn more values. Values are never removed. */
export interface GrowingRedactor extends Redactor {
  /**
   * Registers `value` under `name`. Returns true when it was added; false when that exact value is already
   * registered under that name or the value has fewer than MIN_SECRET_BYTES UTF-8 bytes. One name can hold
   * several values (a rotated secret); every form of each is replaced by `[redacted:<name>]`.
   */
  add(name: string, value: string): boolean;
}

/**
 * One redactor object that changes in place: `text`, `json`, `payload` and `contains` use every value registered
 * at the moment they are called, so code that kept a reference sees later additions. The matcher is rebuilt lazily, on
 * the first use after an `add` that registered something new. `stream()` is over the values registered when it is
 * called. A form registered under two names is replaced under the alphabetically first name.
 */
export function createGrowingRedactor(initial?: Readonly<Record<string, string>>): GrowingRedactor {
  const valuesByName = new Map<string, Set<string>>();
  let sortedNames: readonly string[] = [];
  let current: { matcher: FormMatcher; empty: boolean } | null = null;

  const matcherNow = (): { matcher: FormMatcher; empty: boolean } => {
    if (current !== null) return current;
    const formToName = new Map<string, string>();
    for (const [name, values] of valuesByName) {
      for (const value of values) {
        for (const form of secretForms(value)) {
          const existing = formToName.get(form);
          if (existing === undefined || name < existing) formToName.set(form, name);
        }
      }
    }
    const placeholders = new Map<string, string>();
    for (const [form, name] of formToName) placeholders.set(form, `[redacted:${name}]`);
    current = { matcher: createFormMatcher(placeholders), empty: placeholders.size === 0 };
    return current;
  };

  const text = (value: string): string => matcherNow().matcher.text(value);

  const add = (name: string, value: string): boolean => {
    if (secretForms(value).length === 0) return false;
    let values = valuesByName.get(name);
    if (values === undefined) {
      values = new Set<string>();
      valuesByName.set(name, values);
      sortedNames = Object.freeze([...valuesByName.keys()].sort());
    }
    if (values.has(value)) return false;
    values.add(value);
    current = null;
    return true;
  };

  for (const [name, value] of Object.entries(initial ?? {})) add(name, value);

  return {
    get names(): readonly string[] {
      return sortedNames;
    },
    text,
    json<T extends Json>(value: T): T {
      const { matcher, empty } = matcherNow();
      if (empty) return value;
      return redactJsonWith(value, matcher.text) as T;
    },
    payload(value: Json): Json {
      const { matcher, empty } = matcherNow();
      if (empty) return value;
      return redactJsonWith(value, matcher.text, { numbers: true });
    },
    contains: (value: string): boolean => matcherNow().matcher.contains(value),
    stream: (): StreamRedactor => matcherNow().matcher.stream(),
    add,
  };
}

/** A redactor over a fixed set of secrets (a growing redactor that is never added to). */
export function createRedactor(secrets: Readonly<Record<string, string>>): Redactor {
  const growing = createGrowingRedactor(secrets);
  return {
    names: growing.names, text: growing.text, json: growing.json, payload: growing.payload, contains: growing.contains, stream: growing.stream,
  };
}
