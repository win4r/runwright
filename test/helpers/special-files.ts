/**
 * Special files for the tests of regular-file reads: FIFOs, and child processes that run code which might block
 * inside `open()` (a blocked open keeps a process alive and cannot be cancelled from inside it, so such code runs
 * in a child that is killed after a bound).
 */
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Creates a FIFO at `path` (`mkfifo` is not in Node's API). */
export function makeFifo(path: string): void {
  execFileSync("mkfifo", [path]);
}

/** The path of a script under `test/fixtures/special-files/`. */
export function specialFilesFixture(name: string): string {
  return fileURLToPath(new URL(`../fixtures/special-files/${name}`, import.meta.url));
}

export interface BoundedRun { code: number | null; timedOut: boolean; stdout: string; stderr: string }

/** Runs `node <script> ...args` as a child process and kills it with SIGKILL after `timeoutMs`. */
export function runBounded(script: string, args: readonly string[], timeoutMs = 5000): Promise<BoundedRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", script, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, stdout, stderr });
    });
  });
}

/** The one JSON line a fixture printed; fails with the child's stderr when it timed out, failed or printed nothing. */
export function printedJson(run: BoundedRun): unknown {
  if (run.timedOut) throw new Error(`the child was killed after its bound (it blocked); stderr: ${run.stderr}`);
  if (run.code !== 0) throw new Error(`the child exited with ${String(run.code)}; stderr: ${run.stderr}`);
  return JSON.parse(run.stdout.trim()) as unknown;
}
