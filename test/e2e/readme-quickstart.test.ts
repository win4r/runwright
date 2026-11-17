/**
 * Brief, section 4, "README quickstart executed as a test": the fenced block marked `sh quickstart` in README.md
 * is run line by line from the repository root, exactly as written, with HOME pointed at a fresh temp directory.
 * Nothing else is set: no data directory (the default `~/.runwright` of that HOME is used), no port, no URL, no
 * token, so the default port with next-free search and the CLI's own discovery must make it work even while other
 * copies of the suite run. Every step's stdout is not a terminal, so each prints one JSON document; the last one,
 * `runs files`, holds the greeting as `content`. What `serve` prints on stdout (not a TTY here, so JSON) must hold the URL, the path of
 * the API token file and the data directory, as the README says.
 *
 * Line rules: blank and comment-only lines are skipped; a line ending in ` &` is started in the background and
 * killed at the end; a trailing `# exit N` is the expected exit code (default 0); `npm install` is not run (the
 * suite stays offline) but its result, the two development dependencies, must be present.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../helpers/tmp.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const LINE_TIMEOUT_MS = 30_000;

interface QuickstartLine {
  text: string;
  background: boolean;
  expectedExit: number;
}

/** The one fenced block whose info string is exactly `sh quickstart`. */
function quickstartBlock(markdown: string): string {
  const blocks: string[] = [];
  const fence = /^```([^\n]*)\n([\s\S]*?)^```[ \t]*$/gm;
  for (const match of markdown.matchAll(fence)) {
    if ((match[1] ?? "").trim() === "sh quickstart") blocks.push(match[2] ?? "");
  }
  if (blocks.length !== 1) throw new Error(`README.md must hold exactly one \`sh quickstart\` block, found ${blocks.length}`);
  return blocks[0] ?? "";
}

function parseQuickstart(block: string): QuickstartLine[] {
  const lines: QuickstartLine[] = [];
  for (const raw of block.split("\n")) {
    const text = raw.trim();
    if (text === "" || text.startsWith("#")) continue;
    const exit = /#\s*exit\s+(\d+)\s*$/.exec(text);
    const command = (exit === null ? text : text.slice(0, exit.index)).trim();
    lines.push({
      text,
      background: /\s&$/.test(command),
      expectedExit: exit === null ? 0 : Number(exit[1]),
    });
  }
  return lines;
}

function shellEnv(dir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("RUNWRIGHT_")) env[key] = value;
  }
  return { ...env, HOME: join(dir, "home") };
}

function runLine(text: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", text], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`\`${text}\` did not finish within ${LINE_TIMEOUT_MS} ms; stderr:\n${stderr}`));
    }, LINE_TIMEOUT_MS);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/** Stops a background job's whole process group: SIGTERM first (graceful stop), SIGKILL if it lingers. */
async function stopGroup(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const signal = (name: NodeJS.Signals): void => {
    try {
      process.kill(-(child.pid as number), name);
    } catch {
      // the group is already gone
    }
  };
  signal("SIGTERM");
  const timer = setTimeout(() => signal("SIGKILL"), 10_000);
  await exited;
  clearTimeout(timer);
}

test("parseQuickstart skips blanks and comments, finds background jobs and expected exit codes", () => {
  const lines = parseQuickstart("\n# a comment\nnpm install\nserve &\nwait   # exit 8\nwait\n");
  assert.deepEqual(lines, [
    { text: "npm install", background: false, expectedExit: 0 },
    { text: "serve &", background: true, expectedExit: 0 },
    { text: "wait   # exit 8", background: false, expectedExit: 8 },
    { text: "wait", background: false, expectedExit: 0 },
  ]);
  assert.throws(() => quickstartBlock("no block here"), /exactly one/);
  assert.throws(() => quickstartBlock("```sh quickstart\na\n```\n```sh quickstart\nb\n```\n"), /found 2/);
  assert.equal(quickstartBlock("```sh\nx\n```\n```sh quickstart\na\nb\n```\n"), "a\nb\n");
});

test("the README quickstart works exactly as written", { timeout: 120_000 }, async (t) => {
  const readme = await readFile(join(ROOT, "README.md"), "utf8");
  const lines = parseQuickstart(quickstartBlock(readme));
  const dir = await makeTempDir(t, "runwright-quickstart-");
  const env = shellEnv(dir);
  const background: { child: ChildProcess; text: string; stdout: string }[] = [];
  t.after(async () => {
    await Promise.all(background.map((job) => stopGroup(job.child)));
  });

  assert.ok(lines.some((line) => line.text === "npm install"), "the quickstart installs the development dependencies");
  const waits: number[] = [];
  let answer: string | null = null;
  let last: { text: string; stdout: string } | null = null;
  for (const line of lines) {
    if (line.text === "npm install") {
      assert.ok(existsSync(join(ROOT, "node_modules", "typescript")), "npm install has been run (typescript)");
      assert.ok(existsSync(join(ROOT, "node_modules", "@types", "node")), "npm install has been run (@types/node)");
      continue;
    }
    if (line.background) {
      const command = line.text.replace(/\s&$/, "");
      const child = spawn("sh", ["-c", command], { cwd: ROOT, env, stdio: ["ignore", "pipe", "ignore"], detached: true });
      const job = { child, text: line.text, stdout: "" };
      child.stdout?.on("data", (chunk: Buffer) => { job.stdout += chunk.toString("utf8"); });
      background.push(job);
      continue;
    }
    const result = await runLine(line.text, env);
    assert.equal(result.code, line.expectedExit,
      `\`${line.text}\` exited ${result.code}, expected ${line.expectedExit}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    if (/\bruns wait\b/.test(line.text)) waits.push(result.code ?? -1);
    const answered = /\bruns answer\s+\S+\s+"([^"]*)"/.exec(line.text);
    if (answered !== null) answer = answered[1] ?? null;
    last = { text: line.text, stdout: result.stdout };
  }

  assert.deepEqual(waits, [8, 0], "`runs wait` first reports a run waiting on a person, then a completed run");
  assert.ok(answer !== null && answer !== "", "the quickstart answers the question");
  assert.ok(last !== null);
  // Off a terminal the last step prints one JSON document; the file's text is its `content` (docs/cli.md, Output).
  const file = JSON.parse(last.stdout) as { path?: unknown; encoding?: unknown; content?: unknown };
  assert.equal(file.path, "greeting.txt", `the last command (\`${last.text}\`) prints the file`);
  assert.equal(file.encoding, "utf8");
  assert.equal(file.content, `Hello, ${answer}!\n`, `the last command (\`${last.text}\`) prints the greeting`);
  for (const job of background) {
    assert.equal(job.child.exitCode, null, "the background server is still running at the end");
  }
  const served = background.find((job) => /\bserve\b/.test(job.text));
  assert.ok(served !== undefined, "the quickstart starts `serve` in the background");
  const printed = JSON.parse(served.stdout) as { url?: unknown; tokenPath?: unknown; dataDir?: unknown };
  const dataDir = join(env["HOME"] as string, ".runwright");
  assert.match(String(printed.url), /^http:\/\/127\.0\.0\.1:\d+$/, "`serve` prints the URL");
  assert.equal(printed.tokenPath, join(dataDir, "token"), "`serve` prints the path of the API token file");
  assert.equal(printed.dataDir, dataDir, "`serve` prints the data directory, ~/.runwright by default");
  assert.ok(!served.stdout.includes((await readFile(join(dataDir, "token"), "utf8")).trim()), "the token itself is never printed");
});
