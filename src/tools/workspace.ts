import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import { RunwrightError } from "../core/errors.ts";

export interface WorkspaceEntry { path: string; size: number; modifiedAt: number }

function escape(path: string, reason: string): RunwrightError {
  return new RunwrightError("workspace_escape", `path ${JSON.stringify(path)} is not allowed: ${reason}`, {
    details: { path, reason },
  });
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

function errorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/**
 * Splits a workspace-relative path into its segments after the textual checks: no empty path, no NUL, no absolute
 * path (POSIX or drive letter), no backslash, no `..` segment. Empty and `.` segments are dropped, so `.` is the root.
 */
export function workspaceSegments(path: string): string[] {
  if (path.length === 0) throw escape(path, "empty path");
  if (path.includes("\0")) throw escape(path, "NUL byte in path");
  if (path.includes("\\")) throw escape(path, "backslashes are not allowed");
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) throw escape(path, "absolute paths are not allowed");
  const segments = path.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.includes("..")) throw escape(path, "'..' segments are not allowed");
  return segments;
}

/**
 * Resolves `path` inside the workspace `root` and returns the absolute path, or throws
 * RunwrightError("workspace_escape"). Every existing component is checked with lstat; a symbolic link is followed
 * with realpath and must stay inside the real root. A dangling link is refused. Missing trailing components are
 * allowed, so the result can be the target of a write.
 */
export async function resolveInWorkspace(root: string, path: string): Promise<string> {
  const segments = workspaceSegments(path);
  const realRoot = await realpath(root);
  let current = realRoot;
  for (let index = 0; index < segments.length; index += 1) {
    const candidate = join(current, segments[index] as string);
    let info;
    try {
      info = await lstat(candidate);
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") return join(candidate, ...segments.slice(index + 1));
      throw error;
    }
    if (info.isSymbolicLink()) {
      let target: string;
      try {
        target = await realpath(candidate);
      } catch {
        throw escape(path, "dangling symbolic link");
      }
      if (!isInside(realRoot, target)) throw escape(path, "symbolic link leads outside the workspace");
      current = target;
    } else {
      current = candidate;
    }
  }
  return current;
}

/** The workspace folder that belongs to Runwright (saved tool results live below it). */
const RESERVED_DIR = ".runwright";

/** Where the engine saves over-long results of untrusted tools, relative to the workspace root. */
export const UNTRUSTED_RESULTS_DIR = `${RESERVED_DIR}/tool-results/untrusted`;

/** Device and inode of `path` (symbolic links followed), or null when it does not exist or is not reachable. */
async function identity(path: string): Promise<{ dev: bigint; ino: bigint } | null> {
  try {
    const info = await stat(path, { bigint: true });
    return { dev: info.dev, ino: info.ino };
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP" || code === "ENAMETOOLONG") return null;
    throw error;
  }
}

/**
 * True when the absolute `target` (as `resolveInWorkspace` returns it) is the existing directory `<root>/<dir>`
 * or lies under it, decided by file identity rather than by spelling: from `target` up to (not including) the
 * real workspace root, every component that exists is compared by device and inode with `<root>/<dir>`. So
 * another letter case on a case-insensitive file system, another Unicode normalisation and a symbolic link into
 * the directory all count; a different directory with a similar name does not. A `<root>/<dir>` that does not
 * exist gives false, and so does a target outside the real root.
 */
export async function isUnderWorkspaceDir(root: string, dir: string, target: string): Promise<boolean> {
  const realRoot = await realpath(root);
  const wanted = await identity(join(realRoot, dir));
  if (wanted === null) return false;
  const rel = relative(realRoot, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
  const parts = rel.split(sep).filter((part) => part.length > 0);
  for (let length = parts.length; length > 0; length -= 1) {
    const found = await identity(join(realRoot, ...parts.slice(0, length)));
    if (found !== null && found.dev === wanted.dev && found.ino === wanted.ino) return true;
  }
  return false;
}

/**
 * True when the workspace-relative `path`, resolved to the absolute `target`, names Runwright's reserved folder
 * `<root>/.runwright` or something in it: its first segment equals `.runwright` after NFC normalisation and
 * lower-casing (this covers a folder that does not exist yet), or `isUnderWorkspaceDir` says the target is that
 * folder or under it (other spellings and symbolic links into it). Throws like `workspaceSegments` for a path
 * that is not a valid workspace path.
 */
export async function isReservedWorkspacePath(root: string, path: string, target: string): Promise<boolean> {
  const first = workspaceSegments(path)[0];
  if (first !== undefined && first.normalize("NFC").toLowerCase() === RESERVED_DIR) return true;
  return isUnderWorkspaceDir(root, RESERVED_DIR, target);
}

/** The folders of `.runwright/` that hold the workspace stage (`./workspace-stage.ts`), in lower case. */
const STAGE_FOLDERS: ReadonlySet<string> = new Set(["stage", "unstage"]);

/**
 * True when the workspace-relative POSIX `path` lies in `.runwright/stage/` or `.runwright/unstage/` (or is one of
 * them), compared after NFC normalisation and lower-casing. Those folders hold only the temp files of writes in
 * progress and the folders of earlier claims being removed, never a run file: they are not listed as run files and
 * must not be served as one.
 */
export function isStagePath(path: string): boolean {
  const [first, second] = path.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (first === undefined || second === undefined) return false;
  return first.normalize("NFC").toLowerCase() === RESERVED_DIR && STAGE_FOLDERS.has(second.normalize("NFC").toLowerCase());
}

function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Regular files under `root`, recursive, as relative POSIX paths sorted by code unit. Symbolic links are skipped,
 * and so are the stage folders of `.runwright/` (`isStagePath`).
 * One page: the entries whose path sorts after `after` (absent: from the first), at most `limit` of them (absent:
 * all). `more` is true when entries after the last one returned exist, so a caller pages by passing the last path
 * as the next `after` and never sees a duplicate or misses an entry.
 */
export async function listWorkspaceFiles(
  root: string,
  options?: { after?: string; limit?: number },
): Promise<{ files: WorkspaceEntry[]; more: boolean }> {
  const after = options?.after;
  const limit = options?.limit;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
    throw new RunwrightError("bad_request", `limit must be a safe integer >= 0, got ${String(limit)}`);
  }
  const realRoot = await realpath(root);
  const found: WorkspaceEntry[] = [];
  const pending: { dir: string; prefix: string }[] = [{ dir: realRoot, prefix: "" }];
  while (pending.length > 0) {
    const { dir, prefix } = pending.pop() as { dir: string; prefix: string };
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw error;
    }
    for (const entry of entries) {
      const relative = prefix + entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (isStagePath(relative)) continue;
        pending.push({ dir: join(dir, entry.name), prefix: `${relative}/` });
      } else if (entry.isFile()) {
        try {
          const info = await lstat(join(dir, entry.name));
          if (info.isFile()) found.push({ path: relative, size: info.size, modifiedAt: Math.floor(info.mtimeMs) });
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
        }
      }
    }
  }
  const remaining = after === undefined ? found : found.filter((entry) => comparePaths(entry.path, after) > 0);
  remaining.sort((a, b) => comparePaths(a.path, b.path));
  if (limit === undefined || remaining.length <= limit) return { files: remaining, more: false };
  return { files: remaining.slice(0, limit), more: true };
}

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".json", ".csv", ".log", ".yaml", ".yml", ".xml", ".ts", ".js", ".py", ".sh", ".html", ".htm",
  ".svg", ".css", ".tsv", ".toml", ".ini", ".cfg", ".conf", ".jsonl", ".ndjson", ".mjs", ".cjs", ".tsx", ".jsx",
  ".rs", ".go", ".java", ".c", ".h", ".cpp", ".hpp", ".rb", ".sql", ".diff", ".patch", ".markdown", ".rst",
]);
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * A content type that is safe to serve a run's file with. Text formats, including HTML, SVG, JS and CSS, and files
 * without an extension are served as inline `text/plain`; common raster images inline with their own type; PDF
 * as an attachment; everything else as an `application/octet-stream` attachment.
 */
export function safeContentType(path: string): { contentType: string; disposition: "inline" | "attachment" } {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const extension = extname(base).toLowerCase();
  if (extension === "" || TEXT_EXTENSIONS.has(extension)) return { contentType: "text/plain; charset=utf-8", disposition: "inline" };
  const image = IMAGE_TYPES[extension];
  if (image !== undefined) return { contentType: image, disposition: "inline" };
  if (extension === ".pdf") return { contentType: "application/pdf", disposition: "attachment" };
  return { contentType: "application/octet-stream", disposition: "attachment" };
}
