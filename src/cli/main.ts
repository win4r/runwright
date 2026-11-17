import { decodeUtf8, GLOBAL_FLAGS, jsonFlagInTokens, parseCommandArgs, splitCommandWords, UsageError, type FlagTable, type FlagValues } from "./args.ts";
import { createContext, positionalBounds, readGlobals, type CliIo, type CommandSpec } from "./context.ts";
import { describeError, errorDetailLines } from "./output.ts";
import { agentCommands } from "./commands/agents.ts";
import { runCommands } from "./commands/runs.ts";
import { workflowCommands } from "./commands/workflows.ts";
import { learningCommands } from "./commands/learning.ts";
import { pendingCommands, secretCommands, statusCommands, triggerCommands, usageCommands } from "./commands/admin.ts";
import { hostCommands } from "./commands/host.ts";

export type { CliIo } from "./context.ts";
export type { CommandSpec } from "./context.ts";

const helpCommand: CommandSpec = {
  name: "help", summary: "Show the command list, or one command's usage", args: "[<command>...]", flags: {},
  async handler(ctx) {
    const words = [...ctx.positionals];
    const name = words.join(" ");
    const spec = COMMANDS.find((c) => c.name === name);
    let text: string;
    if (words.length === 0) text = commandList();
    else if (spec !== undefined) text = commandUsage(spec);
    else if (COMMANDS.some((c) => c.name.startsWith(`${name} `))) text = groupUsage(name);
    else throw new UsageError(`unknown command ${JSON.stringify(name)}`, null);
    ctx.print({ help: text }, () => text.slice(0, -1));
    return 0;
  },
};

/** Every command, in the order help lists them. `help` output and usage errors are generated from this table. */
export const COMMANDS: readonly CommandSpec[] = [
  ...hostCommands.filter((c) => c.name === "serve" || c.name === "runner"),
  ...agentCommands,
  ...runCommands,
  ...pendingCommands,
  ...workflowCommands,
  ...learningCommands,
  ...triggerCommands,
  ...secretCommands,
  ...usageCommands,
  ...statusCommands,
  ...hostCommands.filter((c) => c.name !== "serve" && c.name !== "runner"),
  helpCommand,
];

function flagLines(flags: FlagTable): string[] {
  const entries = Object.entries(flags).map(([name, spec]) => {
    const left = `${spec.short === undefined ? "" : `-${spec.short}, `}--${name}${spec.value === undefined ? "" : ` <${spec.value}>`}`;
    return [left, spec.description] as const;
  });
  const width = Math.max(0, ...entries.map(([left]) => left.length));
  return entries.map(([left, description]) => `  ${left.padEnd(width)}  ${description}`);
}

function synopsis(spec: CommandSpec): string {
  return `${spec.name}${spec.args === "" ? "" : ` ${spec.args}`}`;
}

function commandUsage(spec: CommandSpec): string {
  const lines = [`Usage: runwright ${synopsis(spec)}${Object.keys(spec.flags).length > 0 ? " [options]" : ""}`, "", spec.summary];
  if (Object.keys(spec.flags).length > 0) lines.push("", "Options:", ...flagLines(spec.flags));
  lines.push("", "Global options:", ...flagLines(GLOBAL_FLAGS));
  return `${lines.join("\n")}\n`;
}

function groupUsage(group: string): string {
  const members = COMMANDS.filter((c) => c.name.startsWith(`${group} `));
  const width = Math.max(...members.map((c) => synopsis(c).length));
  return `Usage: runwright ${group} <command>\n\nCommands:\n${members.map((c) => `  ${synopsis(c).padEnd(width)}  ${c.summary}`).join("\n")}\n\nRun "runwright help ${group} <command>" for a command's options.\n`;
}

function commandList(): string {
  const width = Math.max(...COMMANDS.map((c) => synopsis(c).length));
  return [
    "Runwright: durable runs, control, learning and typed workflows around LLM agents.",
    "",
    "Usage: runwright [<command>] [options]     (no command: same as `runwright serve`)",
    "",
    "Commands:",
    ...COMMANDS.map((c) => `  ${synopsis(c).padEnd(width)}  ${c.summary}`),
    "",
    "Global options:",
    ...flagLines(GLOBAL_FLAGS),
    "",
    "Wherever a run id is expected, @last means the most recently created run.",
    "When stdout is not a terminal or --json is given, every command prints exactly one JSON document",
    "(runs timeline --follow prints one per line).",
    "Exit codes: 0 success, 1 failure (a failed or cancelled run too), 2 usage error, 8 the run is waiting on a person.",
    "",
  ].join("\n");
}

function isCommandPrefix(words: readonly string[]): boolean {
  const name = words.join(" ");
  return COMMANDS.some((c) => c.name === name || c.name.startsWith(`${name} `));
}

function usageFor(command: string | null): string {
  if (command === null) return commandList();
  const spec = COMMANDS.find((c) => c.name === command);
  return spec === undefined ? groupUsage(command) : commandUsage(spec);
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  return decodeUtf8(Buffer.concat(chunks), "standard input");
}

/**
 * The io of the real process, as `bin/runwright.ts` passes it: the process's streams and environment, and `exit`
 * set to `process.exit`, so a second shutdown signal can end the process (`hostApp`).
 */
export function processIo(): CliIo {
  return {
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    stdin: readAllStdin,
    env: process.env,
    isTTY: process.stdout.isTTY === true,
    exit: process.exit,
  };
}

/**
 * The io `main` runs with: `processIo()` when none is given; otherwise the given parts over the process's own.
 * A partial io has `exit` only when it brings one, so a test that passes its own io is never ended by the CLI.
 */
export function defaultIo(io: Partial<CliIo> | undefined): CliIo {
  if (io === undefined) return processIo();
  const real = processIo();
  const cli: CliIo = {
    stdout: io.stdout ?? real.stdout,
    stderr: io.stderr ?? real.stderr,
    stdin: io.stdin ?? real.stdin,
    env: io.env ?? real.env,
    isTTY: io.isTTY ?? real.isTTY,
  };
  if (io.exit !== undefined) cli.exit = io.exit;
  return cli;
}

/** Commands that never talk to a server: the connection flags would be accepted and then not used. */
const LOCAL_COMMANDS: ReadonlySet<string> = new Set(["serve", "runner", "retention archive", "bench", "version", "help"]);
const CONNECTION_FLAGS = ["url", "token", "connect-timeout"] as const;

/** Usage text as printed: `{"help": text}` in JSON mode, the text itself on a terminal. */
function helpOutput(json: boolean, text: string): string {
  return json ? `${JSON.stringify({ help: text }, null, 2)}\n` : text;
}

/** A command group's options, parsed with the global flags only; null when they do not parse. */
function groupOptions(rest: readonly string[], group: string): { values: FlagValues; positionals: string[] } | null {
  try {
    return parseCommandArgs(rest, {}, group);
  } catch (error) {
    // A flag of one of the group's commands (`runs nope --limit 3`): what to report is the missing command.
    if (error instanceof UsageError) return null;
    throw error;
  }
}

/**
 * Runs the CLI; returns the exit code (0 ok, 1 failure, 2 usage error, 8 waiting on a person). The only place that
 * ends the process itself is a second shutdown signal while hosting (`hostApp`, through `io.exit`).
 */
export async function main(argv: readonly string[], io?: Partial<CliIo>): Promise<number> {
  const cli = defaultIo(io);
  let json = !cli.isTTY || jsonFlagInTokens(argv);
  let command: string | null = null;
  try {
    const { words, rest } = splitCommandWords(argv, isCommandPrefix);
    const name = words.join(" ");
    const exact = COMMANDS.find((c) => c.name === name);
    if (words.length > 0 && exact === undefined) {
      command = name;
      const group = groupOptions(rest, name);
      if (group !== null) json = group.values["json"] === true || !cli.isTTY;
      if (group?.values["help"] === true) {
        cli.stdout(helpOutput(json, groupUsage(name)));
        return 0;
      }
      const next = group === null ? rest.find((token) => !token.startsWith("-")) : group.positionals[0];
      throw new UsageError(next === undefined ? `"${name}" needs a command` : `unknown command "${name} ${next}"`, name);
    }
    const spec = exact ?? (COMMANDS.find((c) => c.name === "serve") as CommandSpec);
    command = exact === undefined ? null : spec.name;
    const { values, positionals } = parseCommandArgs(rest, spec.flags, command);
    json = values["json"] === true || !cli.isTTY;
    if (values["help"] === true) {
      cli.stdout(helpOutput(json, exact === undefined ? commandList() : commandUsage(spec)));
      return 0;
    }
    if (exact === undefined && positionals.length > 0) throw new UsageError(`unknown command ${JSON.stringify(positionals[0])}`, null);
    const unused = LOCAL_COMMANDS.has(spec.name) ? CONNECTION_FLAGS.find((flag) => values[flag] !== undefined) : undefined;
    if (unused !== undefined) throw new UsageError(`--${unused} has no effect on ${spec.name}: it does not talk to a server`, command);
    const bounds = positionalBounds(spec.args);
    const variadic = spec.args.includes("...");
    if (positionals.length < bounds.min) throw new UsageError(`missing argument: ${spec.args}`, spec.name);
    if (!variadic && positionals.length > bounds.max) throw new UsageError(`unexpected argument ${JSON.stringify(positionals[bounds.max])}`, spec.name);
    const ctx = createContext({ io: cli, spec, values, positionals, globals: readGlobals(values, cli.env, command) });
    return await spec.handler(ctx);
  } catch (error) {
    if (error instanceof UsageError) {
      if (json) cli.stdout(`${JSON.stringify({ error: { code: "usage", message: error.message } }, null, 2)}\n`);
      cli.stderr(`error: ${error.message}\n\n${usageFor(error.command ?? command)}`);
      return 2;
    }
    const { code, message, details } = describeError(error);
    if (json) {
      cli.stdout(`${JSON.stringify({ error: details === undefined ? { code, message } : { code, message, details } }, null, 2)}\n`);
    } else {
      cli.stderr(`error: ${message} (${code})\n${errorDetailLines(details).map((line) => `${line}\n`).join("")}`);
    }
    return 1;
  }
}
