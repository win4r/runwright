import { spawn } from "node:child_process";
import { startTimer } from "../core/clock.ts";
import { RunwrightError } from "../core/errors.ts";
import type { ToolDefinition } from "./types.ts";

export interface ShellToolOptions { timeoutMs: number; outputBytes: number }

const KILL_GRACE_MS = 1000;

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone (ESRCH); there is nothing left to signal.
  }
}

interface ShellResult { exitCode: number | null; signal: NodeJS.Signals | null; timedOut: boolean; aborted: boolean; output: Buffer; dropped: number }

function runCommand(command: string, input: { cwd: string; env: Record<string, string>; timeoutMs: number; outputBytes: number; signal: AbortSignal }): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd: input.cwd, detached: true, env: input.env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let kept = 0;
    let dropped = 0;
    let timedOut = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | null = null;
    let drainTimer: NodeJS.Timeout | null = null;
    const collect = (chunk: Buffer): void => {
      const room = input.outputBytes - kept;
      if (room >= chunk.length) {
        chunks.push(chunk);
        kept += chunk.length;
      } else {
        if (room > 0) chunks.push(chunk.subarray(0, room));
        kept += Math.max(room, 0);
        dropped += chunk.length - Math.max(room, 0);
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const terminate = (): void => {
      if (child.pid === undefined || killTimer !== null) return;
      const pid = child.pid;
      killGroup(pid, "SIGTERM");
      killTimer = setTimeout(() => {
        killGroup(pid, "SIGKILL");
        // A process that left the group (its own session) can still hold the output pipes open; stop waiting
        // for it one more grace period after the kill, so the call ends.
        drainTimer = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
        }, KILL_GRACE_MS);
      }, KILL_GRACE_MS);
    };
    const clearTimers = (): void => {
      timer.clear();
      if (killTimer !== null) clearTimeout(killTimer);
      if (drainTimer !== null) clearTimeout(drainTimer);
      input.signal.removeEventListener("abort", onAbort);
    };
    const timer = startTimer(() => {
      timedOut = true;
      terminate();
    }, input.timeoutMs);
    const onAbort = (): void => {
      aborted = true;
      terminate();
    };
    if (input.signal.aborted) onAbort();
    else input.signal.addEventListener("abort", onAbort, { once: true });
    child.once("exit", () => {
      if (child.pid !== undefined) killGroup(child.pid, "SIGKILL");
    });
    child.once("error", (error) => {
      clearTimers();
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimers();
      resolve({ exitCode, signal, timedOut, aborted, output: Buffer.concat(chunks, kept), dropped });
    });
  });
}

/**
 * shell: runs `/bin/sh -c <command>` in the workspace in its own process group, with a minimal environment
 * (PATH, HOME = the workspace, LANG, and the run's secrets as variables). A timeout or an abort kills the whole
 * group (SIGTERM, then SIGKILL after one second; a process that left the group and still holds the output open is
 * no longer waited for one second after that); output is capped, keeping the head. Its output is declared
 * untrusted (`untrustedOutput`): a command can print anything from anywhere (`curl`, `cat` of a downloaded file).
 */
export function createShellTool(options: ShellToolOptions): ToolDefinition {
  return {
    name: "shell",
    description:
      "Run a shell command with /bin/sh in the workspace folder and return its exit status and combined " +
      `stdout/stderr. Commands are stopped after ${options.timeoutMs} ms (or the smaller \`timeout_ms\` you give) and ` +
      `output beyond ${options.outputBytes} bytes is dropped. HOME is the workspace; the secrets this run was ` +
      "given are available as environment variables.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["command"],
      properties: {
        command: { type: "string", minLength: 1, maxLength: 65536, description: "The command line to run." },
        timeout_ms: { type: "integer", minimum: 1, description: "A shorter timeout for this command, in milliseconds." },
      },
    },
    effect: "write",
    untrustedOutput: true,
    defaultPolicy: "ask",
    async handler(args, context) {
      const command = typeof args["command"] === "string" ? args["command"] : "";
      const requested = typeof args["timeout_ms"] === "number" ? args["timeout_ms"] : options.timeoutMs;
      const timeoutMs = Math.max(1, Math.min(options.timeoutMs, requested));
      const env: Record<string, string> = {
        ...context.secrets,
        PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: context.workspace,
        LANG: process.env["LANG"] ?? "C.UTF-8",
      };
      const result = await runCommand(command, { cwd: context.workspace, env, timeoutMs, outputBytes: options.outputBytes, signal: context.signal });
      if (result.aborted) throw new RunwrightError("aborted", "the shell command was aborted");
      const status = result.timedOut
        ? "timeout"
        : result.exitCode !== null ? `exit ${result.exitCode}` : `signal ${result.signal ?? "unknown"}`;
      const note = result.dropped > 0 ? `\n[output truncated: ${result.dropped} more bytes dropped]` : "";
      const output = result.output.toString("utf8");
      const failed = result.timedOut || result.exitCode !== 0;
      return {
        content: `${status}\n${output}${note}`,
        isError: failed,
        data: {
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
          outputBytes: result.output.length,
          droppedBytes: result.dropped,
        },
      };
    },
  };
}
