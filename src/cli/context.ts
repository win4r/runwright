import { discoverServer } from "../client/discover.ts";
import { createClient, type RunwrightClient } from "../client/index.ts";
import { defaultDataDir } from "../config/defaults.ts";
import { RunwrightError, isRunwrightError } from "../core/errors.ts";
import { decimalFlag, MAX_TIMER_SECONDS, stringFlag, UsageError, type FlagTable, type FlagValues } from "./args.ts";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  stdin: () => Promise<string>;
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
  /** Ends the process now with `code`. Absent in tests that only want the returned exit code. */
  exit?: (code: number) => void;
}

export interface Globals {
  dataDir: string; dataDirGiven: boolean; url: string | undefined; token: string | undefined; connectTimeoutMs: number;
}

/** What a command handler gets: output helpers, the server connection and its parsed arguments. */
export interface CommandContext {
  readonly io: CliIo;
  readonly name: string;
  /** JSON output: stdout is not a terminal, or --json was given. Then every command prints exactly one JSON document. */
  readonly json: boolean;
  readonly globals: Globals;
  readonly values: FlagValues;
  readonly positionals: readonly string[];
  /** Prints the result: one JSON document, or the human text. */
  print(value: unknown, human: () => string): void;
  /**
   * Writes text to stdout exactly as given: for output written as it arrives (`runs timeline`, one page at a time,
   * and its `--follow` stream) and for a file's own text (`runs files <run> <path>`, `workflows graph --mermaid`).
   */
  raw(text: string): void;
  /** The client for the local server, found on first use. */
  client(): Promise<RunwrightClient>;
  /** A run id, with `@last` resolved to the newest run. */
  runId(ref: string): Promise<string>;
}

export type Handler = (ctx: CommandContext) => Promise<number>;

export interface CommandSpec {
  /** One or two words, e.g. "runs start". */
  name: string;
  summary: string;
  /** Positional arguments as shown in usage, e.g. "<run> [<path>]". */
  args: string;
  flags: FlagTable;
  handler: Handler;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;

export function readGlobals(values: FlagValues, env: NodeJS.ProcessEnv, command: string | null): Globals {
  const dataDirFlag = stringFlag(values, "data-dir");
  const seconds = decimalFlag(values, "connect-timeout", command ?? "runwright", MAX_TIMER_SECONDS);
  return {
    dataDir: dataDirFlag ?? defaultDataDir(env),
    dataDirGiven: dataDirFlag !== undefined,
    url: stringFlag(values, "url"),
    token: stringFlag(values, "token"),
    connectTimeoutMs: seconds === undefined ? DEFAULT_CONNECT_TIMEOUT_MS : Math.round(seconds * 1000),
  };
}

/** Minimum and maximum positional counts from a usage string such as "<run> <text> [<path>]". */
export function positionalBounds(args: string): { min: number; max: number } {
  const tokens = args.split(/\s+/).filter((token) => token !== "");
  const min = tokens.filter((token) => token.startsWith("<")).length;
  return { min, max: tokens.length };
}

export function createContext(input: {
  io: CliIo; spec: CommandSpec; values: FlagValues; positionals: string[]; globals: Globals;
}): CommandContext {
  const { io, spec, values, positionals, globals } = input;
  const json = values["json"] === true || !io.isTTY;
  let client: Promise<RunwrightClient> | null = null;

  const connect = async (): Promise<RunwrightClient> => {
    const options: Parameters<typeof discoverServer>[0] = { env: io.env, dataDir: globals.dataDir, timeoutMs: globals.connectTimeoutMs };
    if (globals.url !== undefined) options.url = globals.url;
    if (globals.token !== undefined) options.token = globals.token;
    try {
      const found = await discoverServer(options);
      return createClient({ baseUrl: found.baseUrl, token: found.token });
    } catch (error) {
      if (isRunwrightError(error) && error.code === "unavailable" && error.details !== undefined) {
        throw new RunwrightError("unavailable", `no Runwright server found for ${globals.dataDir}; start one with: runwright serve`, {
          details: error.details, cause: error,
        });
      }
      throw error;
    }
  };

  const ctx: CommandContext = {
    io, name: spec.name, json, globals, values, positionals,
    print(value, human) {
      io.stdout(json ? `${JSON.stringify(value, null, 2)}\n` : `${human()}\n`);
    },
    raw(text) {
      io.stdout(text);
    },
    client() {
      client ??= connect();
      return client;
    },
    async runId(ref) {
      if (ref !== "@last") return ref;
      const { runs } = await (await ctx.client()).listRuns({ limit: 1 });
      const newest = runs[0];
      if (newest === undefined) throw new RunwrightError("not_found", "@last: there are no runs yet");
      return newest.id;
    },
  };
  return ctx;
}

/** The positional at `index`; the bounds were checked before the handler ran. */
export function arg(ctx: CommandContext, index: number): string {
  const value = ctx.positionals[index];
  if (value === undefined) throw new UsageError(`missing argument ${index + 1}`, ctx.name);
  return value;
}
