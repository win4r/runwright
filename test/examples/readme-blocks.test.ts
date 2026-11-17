/**
 * Every shell block of `examples/<name>/README.md` works as written (finding R15D-cli-01). The blocks are read out
 * of the READMEs (`blocks.ts`); each `runwright …` line is run with `sh` from the repository root, `runwright`
 * being `node bin/runwright.ts`, one after another against a fresh server (`serve --port 0` on a fresh temp data
 * directory, real child processes), and must end with the exit code its `# exit N` comment names (default 0). The
 * line that runs an example's `run.ts` is run by examples.test.ts; any other line fails here.
 *
 * Each block runs twice: against a server with its in-process runner, and against `serve --no-runner` whose runner
 * process is started only well after the block's `runs start` was sent. A block that answers a question right
 * after starting the run, without waiting for it, fails the second way whatever the timing.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { makeTempDir } from "../helpers/tmp.ts";
import { waitFor } from "../helpers/wait.ts";
import { exampleReadmes, isCliLine, isRunLine, parseBlock, ROOT, type BlockLine } from "./blocks.ts";

const BIN = join(ROOT, "bin", "runwright.ts");
const LINE_TIMEOUT_MS = 30_000;
/** How long after `runs start` was sent the late runner process is started. */
const LATE_RUNNER_DELAY_MS = 2500;

/** What the last line of an example's CLI block prints (one JSON document, stdout not being a terminal). */
const LAST_OUTPUT: Readonly<Record<string, (stdout: string) => void>> = {
  "ask-and-write": (stdout) => {
    const file = JSON.parse(stdout) as { path?: unknown; encoding?: unknown; content?: unknown };
    assert.deepEqual([file.path, file.encoding, file.content], ["greeting.txt", "utf8", "Hello, Ada!\n"], "greeting.txt holds the greeting");
  },
};

function env(dir: string, dataDir: string, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("RUNWRIGHT_") && !key.startsWith("NODE_TEST")) out[key] = value;
  return { ...out, HOME: join(dir, "home"), RUNWRIGHT_DATA_DIR: dataDir, ...extra };
}

interface Child { process: ChildProcess; stdout: () => string; stderr: () => string }

function startChild(children: ChildProcess[], argv: string[], childEnv: NodeJS.ProcessEnv): Child {
  const child = spawn(process.execPath, [BIN, ...argv], { cwd: ROOT, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  return { process: child, stdout: () => stdout, stderr: () => stderr };
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  await exited;
  clearTimeout(timer);
}

/**
 * A temp data directory, a server on port 0 serving it, and `startRunner` for a runner process on it. The children
 * are stopped when the test ends; once that began, `startRunner` starts nothing.
 */
async function freshServer(t: TestContext, runner: "in-process" | "late"): Promise<{ dir: string; dataDir: string; startRunner: () => Promise<void> }> {
  const children: ChildProcess[] = [];
  let ended = false;
  t.after(async () => {
    ended = true;
    await Promise.all(children.map(stopChild));
  });
  const dir = await makeTempDir(t, "runwright-readme-blocks-");
  const dataDir = join(dir, "data");
  const server = startChild(children, ["serve", "--port", "0", ...(runner === "late" ? ["--no-runner"] : [])], env(dir, dataDir));
  await waitFor(async () => (JSON.parse(await readFile(join(dataDir, "server.json"), "utf8")) as { url?: string }).url, {
    timeoutMs: 20_000, message: `serve did not write server.json; stderr:\n${server.stderr()}`,
  });
  const startRunner = async (): Promise<void> => {
    if (ended) return;
    const late = startChild(children, ["runner"], env(dir, dataDir, { RUNWRIGHT_POLL_MS: "100" }));
    await waitFor(() => late.stdout().includes("runnerId"), { timeoutMs: 20_000, message: `the runner did not start; stderr:\n${late.stderr()}` });
  };
  return { dir, dataDir, startRunner };
}

function runLine(line: BlockLine, lineEnv: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const command = line.command.replace(/^runwright(?=\s)/, `'${process.execPath.replaceAll("'", "'\\''")}' bin/runwright.ts`);
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", command], { cwd: ROOT, env: lineEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`\`${line.text}\` did not finish within ${LINE_TIMEOUT_MS} ms; stderr:\n${stderr}`));
    }, LINE_TIMEOUT_MS);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/** Runs a block's lines in order against a fresh server; returns the last line's stdout. */
async function runBlock(t: TestContext, lines: readonly BlockLine[], runner: "in-process" | "late"): Promise<string> {
  const { dir, dataDir, startRunner } = await freshServer(t, runner);
  const lineEnv = env(dir, dataDir);
  const starts = (line: BlockLine): boolean => /\bruns start\b/.test(line.command);
  // A late runner starts LATE_RUNNER_DELAY_MS after the block's first `runs start` was sent (before the block
  // when it starts no run).
  if (runner === "late" && !lines.some(starts)) await startRunner();
  // The late runner's start: its timer (cleared when the block ends first) and the start once the timer fired.
  const late: { timer: NodeJS.Timeout | null; started: Promise<void> | null } = { timer: null, started: null };
  let last = "";
  try {
    for (const line of lines) {
      if (runner === "late" && late.timer === null && late.started === null && starts(line)) {
        late.timer = setTimeout(() => {
          late.timer = null;
          late.started = startRunner();
        }, LATE_RUNNER_DELAY_MS);
      }
      const result = await runLine(line, lineEnv);
      assert.equal(result.code, line.expectedExit,
        `\`${line.text}\` (${runner} runner) exited ${result.code}, expected ${line.expectedExit}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      last = result.stdout;
    }
  } finally {
    if (late.timer !== null) clearTimeout(late.timer);
    await late.started?.catch(() => undefined);
  }
  await late.started;
  return last;
}

test("(R15D-cli-01) the line rules: comments, `# exit N` with or without a reason", () => {
  assert.deepEqual(parseBlock("\n# a comment\nrunwright a b\nrunwright c   # exit 8: waits\nrunwright d # exit 0\nrunwright e # note\n"), [
    { text: "runwright a b", command: "runwright a b", expectedExit: 0 },
    { text: "runwright c   # exit 8: waits", command: "runwright c", expectedExit: 8 },
    { text: "runwright d # exit 0", command: "runwright d", expectedExit: 0 },
    { text: "runwright e # note", command: "runwright e", expectedExit: 0 },
  ]);
});

test("(R15D-cli-01) every line of every example README's shell blocks is run by a test", async () => {
  const readmes = await exampleReadmes();
  assert.ok(readmes.length >= 3, "the three examples");
  const unrun: string[] = [];
  for (const readme of readmes) {
    assert.ok(readme.blocks.flat().some((line) => isRunLine(readme.name, line)), `${readme.name}: the README says how to run run.ts`);
    for (const line of readme.blocks.flat()) if (!isRunLine(readme.name, line) && !isCliLine(line)) unrun.push(`${readme.name}: ${line.text}`);
    const cliBlocks = readme.blocks.filter((block) => block.some(isCliLine));
    if (cliBlocks.length > 0) assert.ok(Object.hasOwn(LAST_OUTPUT, readme.name), `${readme.name}: its CLI block's result is checked`);
    for (const block of cliBlocks) {
      assert.ok(block.every(isCliLine), `${readme.name}: a CLI block holds only CLI lines: ${block.map((l) => l.text).join(" | ")}`);
    }
  }
  assert.deepEqual(unrun, [], "lines no test runs");
});

for (const runner of ["in-process", "late"] as const) {
  test(`(R15D-cli-01) the CLI blocks of the example READMEs work as written (${runner} runner)`, { timeout: 120_000 }, async (t) => {
    for (const readme of await exampleReadmes()) {
      for (const block of readme.blocks.filter((lines) => lines.some(isCliLine))) {
        const last = await runBlock(t, block, runner);
        (LAST_OUTPUT[readme.name] as (stdout: string) => void)(last);
      }
    }
  });
}
