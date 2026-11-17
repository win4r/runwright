import { lstat, opendir, realpath } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { join } from "node:path";
import { RunwrightError } from "../core/errors.ts";
import type { Json, JsonObject } from "../core/json.ts";
import { readRegularFile } from "../core/regular-file.ts";
import { isTrustedContent, sha256OfBytes } from "./file-trust.ts";
import type { ToolContext, ToolDefinition, ToolOutput } from "./types.ts";
import {
  isReservedWorkspacePath, isUnderWorkspaceDir, resolveInWorkspace, UNTRUSTED_RESULTS_DIR, workspaceSegments,
} from "./workspace.ts";
import { stagedRemove, stagedWrite, type StageSeams } from "./workspace-stage.ts";

export interface FileToolOptions {
  maxReadBytes: number; maxWriteBytes: number;
  /** The file-system calls of the workspace stage (tests stop a writer between its temp file and its rename). */
  stage?: StageSeams;
}

const LIST_LIMIT = 2000;
/** read_file treats an `offset` or `limit` (in lines) above this as this many. */
const MAX_LINES = 2147483647;
/** Said in the descriptions of the three write tools. */
const RESERVED_NOTE = " `.runwright/` is reserved for Runwright's own files and cannot be changed with this tool.";

function failure(content: string, data?: Json): ToolOutput {
  return data === undefined ? { content, isError: true } : { content, isError: true, data };
}

/**
 * The error result of a write tool for a path in the workspace's `.runwright/` folder. This guards against
 * accidents and against a model that has only the file tools; `shell` and host tools can still write there.
 */
function reserved(path: string): ToolOutput {
  return failure(`${path}: .runwright/ is reserved for Runwright's own files`);
}

/** Error names by number, for an errno that Node reports without a name (EOPNOTSUPP on macOS). */
const ERRNO_NAMES: ReadonlyMap<number, string> = new Map(
  Object.entries(osConstants.errno).reverse().map(([name, value]) => [value, name]),
);

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = "code" in error ? (error as { code: unknown }).code : undefined;
  if (typeof code === "string" && code.startsWith("E")) return code;
  const errno = "errno" in error ? (error as { errno: unknown }).errno : undefined;
  if (typeof errno === "number" && errno < 0) return ERRNO_NAMES.get(-errno) ?? (typeof code === "string" ? code : undefined);
  return typeof code === "string" ? code : undefined;
}

function describeFsError(path: string, error: unknown): string {
  switch (errorCode(error)) {
    case "ENOENT": return `${path}: no such file`;
    case "ENOTDIR": return `${path}: a parent of this path is not a directory`;
    case "EISDIR": return `${path}: is a directory`;
    case "ELOOP": return `${path}: refusing to follow a symbolic link`;
    case "ENXIO":
    case "EOPNOTSUPP":
    case "ENODEV": return `${path}: not a regular file`;
    case "EACCES":
    case "EPERM": return `${path}: permission denied`;
    default: return `${path}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Runs a file operation and turns ordinary file-system errors into error results; anything else propagates. */
async function guarded(path: string, run: () => Promise<ToolOutput>): Promise<ToolOutput> {
  try {
    return await run();
  } catch (error) {
    if (errorCode(error)?.startsWith("E")) return failure(describeFsError(path, error));
    throw error;
  }
}

function stringArg(args: JsonObject, name: string): string {
  const value = args[name];
  return typeof value === "string" ? value : "";
}

/** A non-negative integer argument, clamped to MAX_LINES (a larger count means the same); anything else counts as absent. */
function optionalLineCount(args: JsonObject, name: string): number | undefined {
  const value = args[name];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return undefined;
  return Math.min(value, MAX_LINES);
}

/** A UTF-16 code unit of a surrogate pair without its other half. */
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Refuses bytes that are not UTF-8 and keeps a leading byte order mark, so the text re-encodes to the bytes read. */
const fatalUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Reads a regular UTF-8 file (`readRegularFile`: one open that follows no final symbolic link and never blocks,
 * at most `maxBytes + 1` bytes read), refusing files larger than `maxBytes`. `sha256` is the digest of exactly
 * the bytes that were decoded. An aborted `signal` rejects with its reason.
 */
async function readTextFile(target: string, maxBytes: number, signal?: AbortSignal): Promise<{ text: string; bytes: number; sha256: string } | { tooLarge: number } | { notText: true } | { notFile: true }> {
  const read = await readRegularFile(target, signal === undefined ? { maxBytes } : { maxBytes, signal });
  if (read.kind === "not_regular") return { notFile: true };
  if (read.kind === "too_large") return { tooLarge: read.size };
  try {
    return { text: fatalUtf8.decode(read.bytes), bytes: read.bytes.length, sha256: sha256OfBytes(read.bytes) };
  } catch {
    return { notText: true };
  }
}

/** Counts the non-overlapping occurrences of `needle` in `text` without building a list of them. */
function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at < 0) return count;
    count += 1;
    from = at + needle.length;
  }
}

/**
 * The exact UTF-8 size of a file of `fileBytes` bytes after `count` occurrences of `oldText` are replaced by
 * `newText`, computed without building the result. Exact for a file of valid UTF-8 text (its text, a leading byte
 * order mark included, re-encodes to the bytes read) and well-formed `oldText` and `newText` (no unpaired
 * surrogate, which `edit_file` refuses): each replacement then removes the bytes of `oldText` and adds those of
 * `newText`.
 */
export function editedSize(fileBytes: number, count: number, oldText: string, newText: string): number {
  return fileBytes + count * (Buffer.byteLength(newText, "utf8") - Buffer.byteLength(oldText, "utf8"));
}

/**
 * Whether content read from `target` with digest `sha256` is the run's own work: never under
 * `.runwright/tool-results/untrusted/`, otherwise only when the run's journal shows that the run left exactly
 * these bytes (`isTrustedContent`).
 */
async function isOwnContent(context: ToolContext, target: string, sha256: string): Promise<boolean> {
  if (await isUnderWorkspaceDir(context.workspace, UNTRUSTED_RESULTS_DIR, target)) return false;
  return isTrustedContent(context.steps.journal(), sha256);
}

function sliceLines(text: string, offset: number | undefined, limit: number | undefined): string {
  if (offset === undefined && limit === undefined) return text;
  const lines = text.split("\n");
  const start = offset ?? 0;
  const end = limit === undefined ? lines.length : start + limit;
  return lines.slice(start, end).join("\n");
}

function readFileTool(options: FileToolOptions): ToolDefinition {
  return {
    name: "read_file",
    description:
      "Read a UTF-8 text file from the workspace. `path` is relative to the workspace root. Optional `offset` " +
      "(number of lines to skip) and `limit` (number of lines to return) read part of the file. " +
      `Files larger than ${options.maxReadBytes} bytes cannot be read.`,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: { type: "string", minLength: 1, description: "File path relative to the workspace root." },
        offset: { type: "integer", minimum: 0, description: "Lines to skip from the start of the file." },
        limit: { type: "integer", minimum: 1, description: "Maximum number of lines to return." },
      },
    },
    effect: "read",
    async handler(args, context) {
      const path = stringArg(args, "path");
      const target = await resolveInWorkspace(context.workspace, path);
      return guarded(path, async () => {
        const read = await readTextFile(target, options.maxReadBytes, context.signal);
        if ("notFile" in read) return failure(`${path}: not a regular file`);
        if ("tooLarge" in read) {
          return failure(`${path}: file is ${read.tooLarge} bytes, larger than the read limit of ${options.maxReadBytes} bytes`);
        }
        if ("notText" in read) return failure(`${path}: file is not UTF-8 text`);
        const output: ToolOutput = {
          content: sliceLines(read.text, optionalLineCount(args, "offset"), optionalLineCount(args, "limit")),
          data: { path, bytes: read.bytes, sha256: read.sha256 },
        };
        if (!(await isOwnContent(context, target, read.sha256))) output.untrusted = true;
        return output;
      });
    },
  };
}

/** The lease epoch this call writes under: the epoch of the run as its runner claimed it. */
function epochOf(context: ToolContext): number {
  const epoch = context.steps.run.epoch;
  if (!Number.isSafeInteger(epoch)) throw new RunwrightError("internal", "the tool context names no lease epoch for its run");
  return epoch;
}

/** Runs a mutation of one workspace after every earlier mutation of that workspace has settled. */
type MutationQueue = <T>(workspace: string, run: () => Promise<T>) => Promise<T>;

function writeFileTool(options: FileToolOptions, oneAtATime: MutationQueue): ToolDefinition {
  return {
    name: "write_file",
    description:
      "Create or overwrite a UTF-8 text file in the workspace with `content`. `path` is relative to the workspace " +
      `root; missing parent directories are created. At most ${options.maxWriteBytes} bytes.` + RESERVED_NOTE,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["path", "content"],
      properties: {
        path: { type: "string", minLength: 1, description: "File path relative to the workspace root." },
        content: { type: "string", description: "The complete new content of the file." },
      },
    },
    effect: "write",
    idempotent: true,
    async handler(args, context) {
      const path = stringArg(args, "path");
      const content = stringArg(args, "content");
      const target = await resolveInWorkspace(context.workspace, path);
      return oneAtATime(context.workspace, () => {
        context.signal.throwIfAborted();
        return guarded(path, async () => {
          if (await isReservedWorkspacePath(context.workspace, path, target)) return reserved(path);
          if (target === (await realpath(context.workspace))) return failure(`${path}: is a directory`);
          const bytes = Buffer.byteLength(content, "utf8");
          if (bytes > options.maxWriteBytes) {
            return failure(`${path}: content is ${bytes} bytes, larger than the write limit of ${options.maxWriteBytes} bytes`);
          }
          const encoded = Buffer.from(content, "utf8");
          const existing = await lstat(target).catch((error: unknown) => {
            if (errorCode(error) === "ENOENT") return null;
            throw error;
          });
          if (existing !== null && !existing.isFile()) return failure(`${path}: exists and is not a regular file`);
          // stagedWrite creates missing parent directories only once its temp file exists in this epoch's stage.
          await stagedWrite(context.workspace, epochOf(context), target, encoded, options.stage);
          return { content: `wrote ${bytes} bytes to ${path}`, data: { path, bytes, sha256: sha256OfBytes(encoded) } };
        });
      });
    },
  };
}

function editFileTool(options: FileToolOptions, oneAtATime: MutationQueue): ToolDefinition {
  return {
    name: "edit_file",
    description:
      "Replace text in an existing workspace file. `old_text` must occur exactly once in the file unless " +
      "`replace_all` is true, in which case every occurrence is replaced with `new_text`." + RESERVED_NOTE,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["path", "old_text", "new_text"],
      properties: {
        path: { type: "string", minLength: 1, description: "File path relative to the workspace root." },
        old_text: { type: "string", minLength: 1, description: "The exact text to find." },
        new_text: { type: "string", description: "The text to put in its place." },
        replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring exactly one." },
      },
    },
    effect: "write",
    async handler(args, context) {
      const path = stringArg(args, "path");
      const oldText = stringArg(args, "old_text");
      const newText = stringArg(args, "new_text");
      const replaceAll = args["replace_all"] === true;
      // An empty needle occurs everywhere and would never let countOccurrences finish; the schema refuses it too.
      if (oldText === "") return failure(`${path}: old_text must not be empty`);
      // An unpaired surrogate can match half of a character and leaves text that encodes to other bytes.
      for (const [name, value] of [["old_text", oldText], ["new_text", newText]] as const) {
        if (UNPAIRED_SURROGATE.test(value)) return failure(`${path}: ${name} contains an unpaired surrogate, which is not text`);
      }
      const target = await resolveInWorkspace(context.workspace, path);
      return oneAtATime(context.workspace, () => {
        // An edit that waited behind another mutation and was aborted meanwhile does not start. It then ends like a
        // write aborted in flight (a pause or a shutdown leaves it interrupted for a person to decide): that is the
        // conservative, correct outcome, since an aborted write cannot in general be told from one that took effect.
        context.signal.throwIfAborted();
        return guarded(path, async () => {
          if (await isReservedWorkspacePath(context.workspace, path, target)) return reserved(path);
          // Once started, an edit is not aborted: a read of at most maxReadBytes is short, and the edit then either
          // takes effect with its one rename or fails as a whole.
          const read = await readTextFile(target, options.maxReadBytes);
          if ("notFile" in read) return failure(`${path}: not a regular file`);
          if ("tooLarge" in read) {
            return failure(`${path}: file is ${read.tooLarge} bytes, larger than the read limit of ${options.maxReadBytes} bytes`);
          }
          if ("notText" in read) return failure(`${path}: file is not UTF-8 text`);
          const count = countOccurrences(read.text, oldText);
          if (count === 0) return failure(`${path}: old_text was not found (0 occurrences)`, { path, occurrences: 0 });
          if (count > 1 && !replaceAll) {
            return failure(
              `${path}: old_text occurs ${count} times; make it unique or set replace_all to true`,
              { path, occurrences: count },
            );
          }
          // The size is known before anything is built, so an edit over the limit allocates nothing for its result.
          const bytes = editedSize(read.bytes, count, oldText, newText);
          if (bytes > options.maxWriteBytes) {
            return failure(`${path}: the edited file would be ${bytes} bytes, larger than the write limit of ${options.maxWriteBytes} bytes`);
          }
          const updated = Buffer.from(read.text.split(oldText).join(newText), "utf8");
          const own = await isOwnContent(context, target, read.sha256);
          await stagedWrite(context.workspace, epochOf(context), target, updated, options.stage);
          const output: ToolOutput = {
            content: `replaced ${count} occurrence${count === 1 ? "" : "s"} in ${path}`,
            data: { path, replacements: count, bytes, sha256: sha256OfBytes(updated) },
          };
          if (!own) output.untrusted = true;
          return output;
        });
      });
    },
  };
}

/**
 * The first `limit` entry names of directory `dir` in name order (UTF-16 code unit order, as `Array.sort`), and how
 * many entries it holds. The directory is read as a stream, so memory holds at most `limit` names whatever its size.
 */
async function firstNames(dir: string, limit: number, signal: AbortSignal): Promise<{ names: string[]; total: number }> {
  const names: string[] = [];
  let total = 0;
  for await (const entry of await opendir(dir)) {
    total += 1;
    if (total % 1024 === 0) signal.throwIfAborted();
    const name = entry.name;
    if (names.length === limit && !(name < (names[limit - 1] as string))) continue;
    let low = 0;
    let high = names.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((names[middle] as string) < name) low = middle + 1;
      else high = middle;
    }
    names.splice(low, 0, name);
    if (names.length > limit) names.pop();
  }
  return { names, total };
}

function listFilesTool(): ToolDefinition {
  return {
    name: "list_files",
    description:
      "List the entries of one workspace directory (default: the workspace root) with their type and size in bytes. " +
      `Use it to discover files before reading them. At most ${LIST_LIMIT} entries are listed, in name order; ` +
      "`data.truncated` says whether more exist and `data.total` how many the directory holds.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", minLength: 1, description: "Directory path relative to the workspace root; default the root." },
      },
    },
    effect: "read",
    async handler(args, context) {
      const path = typeof args["path"] === "string" ? args["path"] : ".";
      const target = await resolveInWorkspace(context.workspace, path);
      return guarded(path, async () => {
        const info = await lstat(target);
        if (!info.isDirectory()) return failure(`${path}: not a directory`);
        context.signal.throwIfAborted();
        const { names, total } = await firstNames(target, LIST_LIMIT, context.signal);
        const entries: JsonObject[] = [];
        for (const name of names) {
          context.signal.throwIfAborted();
          // An entry removed between the listing and this lstat is no longer in the directory: it is not listed.
          const entryInfo = await lstat(join(target, name)).catch(() => null);
          if (entryInfo === null) continue;
          const type = entryInfo.isSymbolicLink() ? "symlink" : entryInfo.isDirectory() ? "directory" : entryInfo.isFile() ? "file" : "other";
          entries.push({ name, type, size: type === "file" ? entryInfo.size : 0 });
        }
        const lines = entries.map((entry) => (entry["type"] === "directory"
          ? `${String(entry["name"])}/`
          : entry["type"] === "file"
            ? `${String(entry["name"])} (${String(entry["size"])} bytes)`
            : `${String(entry["name"])} (${String(entry["type"])})`));
        if (total > LIST_LIMIT) lines.push(`[${total - LIST_LIMIT} more entries not shown]`);
        const content = lines.length === 0 ? `${path}: empty directory` : lines.join("\n");
        return { content, data: { entries, truncated: total > LIST_LIMIT, total } };
      });
    },
  };
}

/** Marks a file-system call that failed with `ENOENT`. */
const absent: unique symbol = Symbol("absent");

/** Runs one file-system call, turning exactly `ENOENT` into `absent`; every other error propagates. */
async function absentOr<T>(run: () => Promise<T>): Promise<T | typeof absent> {
  try {
    return await run();
  } catch (error) {
    if (errorCode(error) === "ENOENT") return absent;
    throw error;
  }
}

/**
 * The result of deleting a file that is not there. It is a success: the end state the caller asked for holds,
 * which is what makes `delete_file` safe to run again after a crash that followed a successful deletion.
 */
function alreadyAbsent(path: string): ToolOutput {
  return { content: `${path}: already absent, nothing to delete`, data: { path, deleted: false } };
}

/**
 * Runs `run` after every earlier call queued under the same `key` has settled, so calls for one key never
 * overlap. Keys whose queue has drained are forgotten.
 */
function createKeyedQueue(): <T>(key: string, run: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve();
    const result = previous.then(run, run);
    const tail = result.then(() => undefined, () => undefined);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return result;
  };
}

function deleteFileTool(options: FileToolOptions, oneAtATime: MutationQueue): ToolDefinition {
  return {
    name: "delete_file",
    description:
      "Delete one file from the workspace. Directories cannot be deleted. Deleting a file that is already absent " +
      "succeeds and reports that nothing was deleted." + RESERVED_NOTE,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: { type: "string", minLength: 1, description: "File path relative to the workspace root." },
      },
    },
    effect: "write",
    idempotent: true,
    async handler(args, context) {
      const path = stringArg(args, "path");
      await resolveInWorkspace(context.workspace, path);
      const segments = workspaceSegments(path);
      const last = segments.at(-1);
      if (last === undefined) return failure(`${path}: is a directory`);
      const parent = await resolveInWorkspace(context.workspace, segments.slice(0, -1).join("/") || ".");
      const entry = join(parent, last);
      return oneAtATime(context.workspace, () => {
        context.signal.throwIfAborted();
        return guarded(path, async () => {
          if (await isReservedWorkspacePath(context.workspace, path, entry)) return reserved(path);
          const info = await absentOr(() => lstat(entry));
          if (info === absent) return alreadyAbsent(path);
          if (info.isDirectory()) return failure(`${path}: is a directory; only files can be deleted`);
          if (!(await stagedRemove(context.workspace, epochOf(context), entry, options.stage))) return alreadyAbsent(path);
          return { content: `deleted ${path}`, data: { path, deleted: true } };
        });
      });
    },
  };
}

/**
 * read_file, write_file, edit_file, list_files and delete_file, all confined to the run's workspace.
 *
 * Inside one runner process, the three mutating tools share one queue keyed by the run's workspace: every mutation
 * of one workspace (for `edit_file` the read, the replacement and the rename together) runs after the previous one
 * has settled, so two parallel workflow branches that edit one file never lose an edit, whatever spelling of the
 * path they use (case-insensitive and normalising file systems, links). Overlapping removals, which can both
 * succeed on APFS, are serialised by the same queue, so exactly one of several concurrent deletions reports
 * `deleted: true`. A mutation that waited in the queue and whose signal aborted meanwhile does not start.
 * `read_file` and `list_files` are not queued: a file is only ever replaced by one rename, which protects readers.
 *
 * Across runners rule F applies (`./workspace-stage.ts`): a write is a temp file in
 * `.runwright/stage/<epoch>` and one rename out of it, a deletion one rename into it, and the next claimant of
 * the run renames that folder away before its first step. So a runner that lost its lease cannot change a file
 * after its successor started, however late it wakes up: the rename itself fails, with `lease_lost`.
 *
 * `shell` and host tools are outside both guarantees: what they write is not queued and not staged, and a stale
 * runner's shell command that is still running can still write.
 */
export function createFileTools(options: FileToolOptions): ToolDefinition[] {
  const oneAtATime: MutationQueue = createKeyedQueue();
  return [
    readFileTool(options), writeFileTool(options, oneAtATime), editFileTool(options, oneAtATime), listFilesTool(),
    deleteFileTool(options, oneAtATime),
  ];
}
