/**
 * Shaping step results: tool outcomes from handler results and errors, the size limit on tool results (with
 * the full text and the full structured data saved in the workspace), and the step results a replay hands back
 * to the driver.
 */
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { syncDirectoryOnDisk, syncEntryChain } from "../core/durable-fs.ts";
import { canonicalJson, type Json, type JsonObject } from "../core/json.ts";
import { HTTP_STATUS, RunwrightError, isRunwrightError, type ErrorCode } from "../core/errors.ts";
import { readRegularFile } from "../core/regular-file.ts";
import type { SchemaProblem } from "../schema/validate.ts";
import type { ToolOutput } from "../tools/types.ts";
import { stagedPublish } from "../tools/workspace-stage.ts";
import { saturatingAdd } from "./budget.ts";
import { ControlSignal } from "./control.ts";
import type { JournalDataMap } from "./journal-types.ts";
import type { ModelStepResult, ToolOutcome, ToolStepResult } from "./types.ts";

const TOOL_RESULTS_DIR = ".runwright/tool-results";

export interface ShapedToolResult {
  outcome: ToolOutcome; content: string; data: Json; isError: boolean; untrusted: boolean;
  truncated: boolean; fullResultPath: string | null;
  /** Lower-case hex SHA-256 of the bytes written to fullResultPath; null when nothing was saved. */
  fullResultSha256: string | null;
  /** Byte length of that file; null when nothing was saved. */
  fullResultBytes: number | null;
  /** Workspace-relative path of the file holding the canonical JSON of `data`, saved because it was over the limit (data is then null); null when nothing was saved. */
  fullDataPath: string | null;
  /** Lower-case hex SHA-256 of the bytes written to fullDataPath; null when nothing was saved. */
  fullDataSha256: string | null;
  /** Byte length of that file; null when nothing was saved. */
  fullDataBytes: number | null;
}

export function deniedContent(tool: string, reason: string): string {
  return `tool "${tool}" was denied: ${reason}`;
}

export function unknownToolContent(tool: string): string {
  return `unknown tool "${tool}"`;
}

export function invalidArgsContent(tool: string, problems: readonly SchemaProblem[]): string {
  return [`invalid arguments for tool "${tool}":`, ...problems.map((p) => `- ${p.path}: ${p.message}`)].join("\n");
}

/** Maps what a handler threw to an outcome and the content the model sees. */
export function errorContent(error: unknown): string {
  if (error instanceof RunwrightError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return `internal: ${error.message}`;
  return `internal: ${String(error)}`;
}

/** A recorded error code as a typed RunwrightError (unknown codes become `fallback`), with `details` when given. */
export function errorFromRecord(error: { code: string; message: string }, fallback: ErrorCode, details?: JsonObject): RunwrightError {
  const code = Object.hasOwn(HTTP_STATUS, error.code) ? (error.code as ErrorCode) : fallback;
  return details === undefined ? new RunwrightError(code, error.message) : new RunwrightError(code, error.message, { details });
}

function cutUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  // Step back over UTF-8 continuation bytes so the cut lands on a character boundary.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The file name, without extension, of a saved result: `<label>-<key16>-<sha256>`.
 * - `<sha256>`: the argument, the lower-case hex SHA-256 (64 characters) of the bytes the file holds.
 * - `<key16>`: the first 16 hex characters of the SHA-256 of the UTF-8 bytes of `key`.
 * - `<label>`: a readable hint only. `key` with every character outside [A-Za-z0-9._-] replaced by "_",
 *   lower-cased, cut to its LAST 40 characters, then leading characters outside [a-z0-9] removed; "result" when
 *   nothing is left.
 * Pure: no file system access.
 */
export function savedResultName(key: string, sha256: string): string {
  const label = key.replace(/[^A-Za-z0-9._-]/gu, "_").toLowerCase().slice(-40).replace(/^[^a-z0-9]+/, "");
  return `${label === "" ? "result" : label}-${sha256Hex(Buffer.from(key, "utf8")).slice(0, 16)}-${sha256}`;
}

/**
 * True when `path` is a regular file (no link followed, no blocking open) that holds exactly `bytes`. Anything
 * else is false: not a regular file, a longer file, and a read that fails (it vanished, a symbolic link, a socket,
 * no permission); the caller then replaces what is there, and that replacement reports its own failure.
 */
async function holdsBytes(path: string, bytes: Buffer): Promise<boolean> {
  try {
    const read = await readRegularFile(path, { maxBytes: bytes.length });
    return read.kind === "bytes" && read.bytes.equals(bytes);
  } catch {
    return false;
  }
}

/**
 * Publishes `bytes` at `relative` under the workspace without ever replacing another result (rule F,
 * `stagedPublish`): the bytes go to a synced temporary file in the staging folder of the writer's lease epoch,
 * which is then linked to the final name. A final name that already holds the same bytes, read as a regular file
 * only (no symbolic link followed, no blocking open, at most `bytes.length` bytes), is left untouched; anything
 * else under that name (other bytes, a symbolic link, a FIFO) is replaced with one rename of the temporary file.
 * Then, in each of the three cases, the folder is synced (its entry for the file) and the entry of every directory
 * above it up to the workspace's parent inclusive (`<data dir>/workspaces`, which holds the workspace's entry): a
 * name found already in place may have been linked by an attempt that died before any sync. A runner whose lease
 * was taken over finds its staging folder gone, so its open, link and rename all fail: that is the control signal
 * `lease_lost`, and nothing is written. Any other failure, a sync included, is an `internal` error. The temporary
 * file's name is always removed.
 */
async function publishBytes(
  workspace: string, epoch: number, folder: string, relative: string, bytes: Buffer, key: string,
  syncDirectory: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = join(workspace, folder);
  try {
    await stagedPublish(workspace, epoch, join(workspace, relative), bytes, (final) => holdsBytes(final, bytes));
    await syncDirectory(dir);
    await syncEntryChain(dir, { directory: syncDirectory, stopAt: dirname(resolve(workspace)) });
  } catch (error) {
    if (isRunwrightError(error) && error.code === "lease_lost") throw new ControlSignal("lease_lost");
    const message = error instanceof Error ? error.message : String(error);
    throw new RunwrightError("internal", `could not save the full result of step ${key}: ${message}`);
  }
}

/**
 * Applies the result size limit. Both files go to `<workspace>/<folder>/`, where `<folder>` is
 * `.runwright/tool-results/untrusted` for an untrusted result and `.runwright/tool-results` otherwise.
 * - Content over `limitBytes`: the full content is saved to `<folder>/<name>.txt` and the content is cut on a
 *   character boundary with the note `\n[truncated: <shown> of <total> bytes; full result saved to <path>]`.
 * - Structured data whose canonical JSON is over `limitBytes`: the UTF-8 bytes of that JSON are saved to
 *   `<folder>/<name>.data.json`, `data` becomes null and the note
 *   `\n[data omitted: <bytes> bytes of structured data; saved to <path>]` is appended to the content (after the
 *   truncation note when the content was cut too).
 * `<name>` is `savedResultName(key, <sha256 of the file's bytes>)`, so a path holds only its own bytes (two
 * results share a file only when they are identical) and is at most 132 bytes long whatever the key. A file is
 * published with `link()` from a synced temporary file in the staging folder of lease epoch `epoch` (rule F,
 * `src/tools/workspace-stage.ts`), so a final name never holds a partial file and never loses another result; a name already taken is kept only when it holds a regular file with exactly these bytes
 * (read without following a link, without blocking, at most their length), and anything else there is replaced;
 * then its folder and every directory above it up to `<data dir>/workspaces` are synced,
 * also when the file was already there (`syncDirectory`, default `syncDirectoryOnDisk`, replaces that sync).
 * Readers take the path from the journal and never rebuild it. If a file cannot be saved or synced the call throws
 * an `internal` error, so no cut result is journalled without a durable file; a writer whose lease was taken over
 * gets the control signal `lease_lost` instead and writes nothing. A result within the limit touches no file. The SHA-256 and the
 * length of exactly the bytes saved are returned with each path (all null when nothing was saved).
 */
export async function limitToolResult(input: {
  workspace: string;
  /** The lease epoch of the session saving the result: its files are published through `stage/<epoch>`. */
  epoch: number;
  key: string; limitBytes: number;
  outcome: ToolOutcome; content: string; data: Json; isError: boolean; untrusted: boolean;
  syncDirectory?: (dir: string) => Promise<void>;
}): Promise<ShapedToolResult> {
  const syncDirectory = input.syncDirectory ?? syncDirectoryOnDisk;
  const folder = input.untrusted ? `${TOOL_RESULTS_DIR}/untrusted` : TOOL_RESULTS_DIR;
  const total = Buffer.byteLength(input.content, "utf8");
  let content = input.content;
  let truncated = false;
  let fullResultPath: string | null = null;
  let fullResultSha256: string | null = null;
  let fullResultBytes: number | null = null;
  if (total > input.limitBytes) {
    const bytes = Buffer.from(input.content, "utf8");
    fullResultSha256 = sha256Hex(bytes);
    const relative = `${folder}/${savedResultName(input.key, fullResultSha256)}.txt`;
    await publishBytes(input.workspace, input.epoch, folder, relative, bytes, input.key, syncDirectory);
    fullResultBytes = bytes.length;
    const shown = cutUtf8(input.content, input.limitBytes);
    content = `${shown}\n[truncated: ${Buffer.byteLength(shown, "utf8")} of ${total} bytes; full result saved to ${relative}]`;
    truncated = true;
    fullResultPath = relative;
  }
  let data = input.data;
  let fullDataPath: string | null = null;
  let fullDataSha256: string | null = null;
  let fullDataBytes: number | null = null;
  if (data !== null) {
    const bytes = Buffer.from(canonicalJson(data), "utf8");
    if (bytes.length > input.limitBytes) {
      fullDataSha256 = sha256Hex(bytes);
      const relative = `${folder}/${savedResultName(input.key, fullDataSha256)}.data.json`;
      await publishBytes(input.workspace, input.epoch, folder, relative, bytes, input.key, syncDirectory);
      fullDataBytes = bytes.length;
      fullDataPath = relative;
      content = `${content}\n[data omitted: ${bytes.length} bytes of structured data; saved to ${relative}]`;
      data = null;
    }
  }
  return {
    outcome: input.outcome, content, data, isError: input.isError, untrusted: input.untrusted, truncated, fullResultPath,
    fullResultSha256, fullResultBytes, fullDataPath, fullDataSha256, fullDataBytes,
  };
}

/** Normalises a handler's return value. */
export function fromToolOutput(output: ToolOutput, untrustedTool: boolean): { outcome: ToolOutcome; content: string; data: Json; isError: boolean; untrusted: boolean } {
  const isError = output.isError === true;
  return {
    outcome: isError ? "error" : "ok",
    content: typeof output.content === "string" ? output.content : String(output.content),
    data: output.data === undefined ? null : output.data,
    isError,
    untrusted: untrustedTool || output.untrusted === true,
  };
}

export function toolStepResult(data: JournalDataMap["tool.finished"]): ToolStepResult {
  return { content: data.content, data: data.data, isError: data.isError, outcome: data.outcome, untrusted: data.untrusted };
}

/**
 * The step result of a finished model step: usage and cost are the totals, the invalid first reply's included.
 * The totals saturate at 2^53 − 1 like every other usage total (C9).
 */
export function modelStepResult(data: JournalDataMap["model.finished"], invalid: JournalDataMap["model.invalid"] | null): ModelStepResult {
  const usage = invalid === null ? data.usage : {
    inputTokens: saturatingAdd(data.usage.inputTokens, invalid.usage.inputTokens),
    outputTokens: saturatingAdd(data.usage.outputTokens, invalid.usage.outputTokens),
    cacheReadTokens: saturatingAdd(data.usage.cacheReadTokens, invalid.usage.cacheReadTokens),
    cacheWriteTokens: saturatingAdd(data.usage.cacheWriteTokens, invalid.usage.cacheWriteTokens),
  };
  const costMicros = invalid === null ? data.costMicros
    : data.costMicros === null || invalid.costMicros === null ? null : saturatingAdd(data.costMicros, invalid.costMicros);
  return { text: data.text, toolCalls: data.toolCalls, output: data.output, stopReason: data.stopReason, usage, costMicros };
}

/** The first `max` characters of the canonical JSON of the arguments, for pending titles. */
export function argsPreview(args: JsonObject, max = 80): string {
  const text = canonicalJson(args);
  return text.length <= max ? text : text.slice(0, max);
}
