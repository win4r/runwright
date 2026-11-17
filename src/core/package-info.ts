/**
 * Where the runwright package lives and which version it is. The lookup walks up from a module instead of using a
 * fixed number of `..`, so it works both in a checkout (`src/core/package-info.ts`, two levels below the root) and
 * in the compiled package (`dist/src/core/package-info.js`, three levels below it).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RunwrightError } from "./errors.ts";

const PACKAGE_NAME = "runwright";
const MAX_LEVELS_UP = 6;

function startDirectory(from: string | URL): string {
  const path = from instanceof URL || from.startsWith("file:") ? fileURLToPath(from) : from;
  return dirname(path);
}

function readManifest(dir: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(join(dir, "package.json"), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The nearest directory at or above the directory of `from` (a module URL, a `file:` URL string or a file path),
 * at most 6 levels up, whose `package.json` parses and has `"name": "runwright"`. Throws `internal` when there is
 * none.
 */
export function packageRoot(from: string | URL = import.meta.url): string {
  const start = startDirectory(from);
  let dir = start;
  for (let level = 0; level <= MAX_LEVELS_UP; level += 1) {
    if (readManifest(dir)?.name === PACKAGE_NAME) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new RunwrightError("internal", `the runwright package root was not found above ${start}`);
}

/** The `version` of the runwright package's `package.json` ("0.0.0" when it is not a string). */
export function packageVersion(): string {
  const version = readManifest(packageRoot())?.version;
  return typeof version === "string" ? version : "0.0.0";
}
