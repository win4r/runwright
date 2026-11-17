import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { parseStrictJson, type Json } from "../core/json.ts";

/** A flag a command accepts. `value` names the argument in help text; absent means a boolean switch. */
export interface FlagSpec { description: string; value?: string; short?: string }
export type FlagTable = { readonly [name: string]: FlagSpec };
export type FlagValues = { readonly [name: string]: string | boolean | undefined };

/** A mistake in how the command was called: usage text on stderr, exit code 2. */
export class UsageError extends Error {
  readonly command: string | null;
  constructor(message: string, command: string | null) {
    super(message);
    this.name = "UsageError";
    this.command = command;
  }
}

export const GLOBAL_FLAGS: FlagTable = {
  json: { description: "print JSON (the default when stdout is not a terminal)" },
  "data-dir": { value: "dir", description: "the data directory (default RUNWRIGHT_DATA_DIR or ~/.runwright)" },
  url: { value: "url", description: "the server URL (default RUNWRIGHT_URL or <data-dir>/server.json)" },
  token: { value: "token", description: "the API token (default RUNWRIGHT_TOKEN or <data-dir>/token)" },
  "connect-timeout": { value: "sec", description: "how long to wait for a server to answer (default 5)" },
  help: { short: "h", description: "show help" },
};

type ParseOptions = { [name: string]: { type: "string" | "boolean"; short?: string } };

function parseOptions(flags: FlagTable): ParseOptions {
  const options: ParseOptions = {};
  for (const [name, spec] of Object.entries(flags)) {
    options[name] = spec.short === undefined
      ? { type: spec.value === undefined ? "boolean" : "string" }
      : { type: spec.value === undefined ? "boolean" : "string", short: spec.short };
  }
  return options;
}

/** Tokens of global flags that take a value, so the command words can be found around them. */
const GLOBAL_VALUE_FLAGS: ReadonlySet<string> = new Set(
  Object.entries(GLOBAL_FLAGS).filter(([, spec]) => spec.value !== undefined).map(([name]) => `--${name}`),
);

/**
 * Whether `--json` was given, read from the tokens alone, for the one case where parsing failed and the parsed
 * options do not exist. Only tokens before the first `--` count, and the value of a global flag that takes one is
 * skipped, so an argument that happens to read `--json` never switches the mode.
 */
export function jsonFlagInTokens(argv: readonly string[]): boolean {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (token === "--") return false;
    if (token === "--json") return true;
    if (GLOBAL_VALUE_FLAGS.has(token)) i += 1;
  }
  return false;
}

/**
 * Splits argv into the leading command words (up to `maxWords`, skipping global flags and their values) and the
 * rest. Words stop at the first token that is not a plain word.
 */
export function splitCommandWords(argv: readonly string[], isCommandPrefix: (words: readonly string[]) => boolean): { words: string[]; rest: string[] } {
  const words: string[] = [];
  const rest: string[] = [];
  let i = 0;
  let collecting = true;
  while (i < argv.length) {
    const token = argv[i] as string;
    if (token === "--") {
      for (let j = i; j < argv.length; j += 1) rest.push(argv[j] as string);
      break;
    }
    if (token.startsWith("-")) {
      rest.push(token);
      if (GLOBAL_VALUE_FLAGS.has(token) && i + 1 < argv.length) {
        rest.push(argv[i + 1] as string);
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (collecting && isCommandPrefix([...words, token])) words.push(token);
    else {
      collecting = false;
      rest.push(token);
    }
    i += 1;
  }
  return { words, rest };
}

/** Strict parse of one command's flags plus the global flags. Unknown flags and bad values are UsageErrors. */
export function parseCommandArgs(rest: readonly string[], flags: FlagTable, command: string | null): { values: FlagValues; positionals: string[] } {
  try {
    const parsed = parseArgs({
      args: [...rest], options: parseOptions({ ...GLOBAL_FLAGS, ...flags }), strict: true, allowPositionals: true,
    });
    return { values: parsed.values as FlagValues, positionals: parsed.positionals };
  } catch (error) {
    throw new UsageError((error as Error).message.replace(/\s*To specify a positional argument.*$/s, ""), command);
  }
}

export function stringFlag(values: FlagValues, name: string): string | undefined {
  const value = values[name];
  return typeof value === "string" ? value : undefined;
}

export function boolFlag(values: FlagValues, name: string): boolean {
  return values[name] === true;
}

/** A whole number flag from `min` to `max`, both inclusive (`max` at most Number.MAX_SAFE_INTEGER). */
export function intFlag(values: FlagValues, name: string, command: string, min: number, max: number): number | undefined {
  const text = stringFlag(values, name);
  if (text === undefined) return undefined;
  if (!/^\d{1,16}$/.test(text) || Number(text) < min || Number(text) > max) {
    throw new UsageError(`--${name} must be a whole number from ${min} to ${max} (got ${JSON.stringify(text)})`, command);
  }
  return Number(text);
}

/** A non-negative decimal number flag such as seconds or days, at most `max`. */
export function decimalFlag(values: FlagValues, name: string, command: string, max: number): number | undefined {
  const text = stringFlag(values, name);
  if (text === undefined) return undefined;
  if (!/^\d{1,12}(\.\d{1,9})?$/.test(text) || Number(text) > max) {
    throw new UsageError(`--${name} must be a number from 0 to ${max} (got ${JSON.stringify(text)})`, command);
  }
  return Number(text);
}

/** The longest wait one timer can hold, in whole seconds (2^31 - 1 ms, rounded down). */
export const MAX_TIMER_SECONDS = 2_147_483;

/** US dollars as decimal text ("0.25") → integer micro-dollars, exactly (no floating-point rounding). */
export function dollarsToMicros(text: string, flag: string, command: string): number {
  const match = /^(\d{1,9})(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (match === null) {
    throw new UsageError(`${flag} must be an amount in US dollars with at most 6 decimals, such as 0.50 (got ${JSON.stringify(text)})`, command);
  }
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(6, "0"));
  return whole * 1_000_000 + fraction;
}

/**
 * Decodes bytes that must be UTF-8 text, exactly: a leading byte order mark is kept (so the text re-encodes to the
 * same bytes) and bytes that are not UTF-8 are an error, never silently replaced.
 */
export function decodeUtf8(bytes: Uint8Array, what: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`${what} is not UTF-8 text`);
  }
}

/** The text of a UTF-8 file (`decodeUtf8`). */
export async function readUtf8File(path: string): Promise<string> {
  return decodeUtf8(await readFile(path), path);
}

/** JSON given inline or as `@path` to a file holding it. */
export async function readJsonArgument(text: string, what: string, command: string): Promise<Json> {
  let source = text;
  let origin = what;
  if (text.startsWith("@")) {
    const path = text.slice(1);
    try {
      source = await readUtf8File(path);
    } catch (error) {
      throw new UsageError(`cannot read ${what} file ${path}: ${(error as Error).message}`, command);
    }
    origin = path;
  }
  try {
    return parseStrictJson(source);
  } catch (error) {
    throw new UsageError(`${origin} is not valid JSON: ${(error as Error).message}`, command);
  }
}

/** A JSON file named by a positional argument. */
export async function readJsonFile(path: string, command: string): Promise<Json> {
  return readJsonArgument(`@${path}`, "the", command);
}
