/**
 * The shell blocks of the examples' READMEs, read out of the files (not a test file): the tests run what the
 * READMEs say, so a README that changes is what gets tested.
 *
 * Line rules: blank and comment-only lines are skipped; a trailing `# exit N` comment, optionally followed by `:`
 * and a reason, is the exit code the line is expected to end with (default 0).
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));

export interface BlockLine {
  /** The line as written. */
  text: string;
  /** The command without its trailing comment. */
  command: string;
  expectedExit: number;
}

export interface ExampleReadme { name: string; path: string; blocks: BlockLine[][] }

/** The contents of every fenced block whose info string is exactly `sh`, in order. */
export function shellBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const fence = /^```([^\n]*)\n([\s\S]*?)^```[ \t]*$/gm;
  for (const match of markdown.matchAll(fence)) {
    if ((match[1] ?? "").trim() === "sh") blocks.push(match[2] ?? "");
  }
  return blocks;
}

export function parseBlock(block: string): BlockLine[] {
  const lines: BlockLine[] = [];
  for (const raw of block.split("\n")) {
    const text = raw.trim();
    if (text === "" || text.startsWith("#")) continue;
    const exit = /\s#\s*exit\s+(\d+)\b(?::[^\n]*)?$/.exec(text);
    const command = (exit === null ? text.replace(/\s#.*$/, "") : text.slice(0, exit.index)).trim();
    lines.push({ text, command, expectedExit: exit === null ? 0 : Number(exit[1]) });
  }
  return lines;
}

/** Every `examples/<name>/README.md` with its parsed `sh` blocks, by name. */
export async function exampleReadmes(): Promise<ExampleReadme[]> {
  const dir = join(ROOT, "examples");
  const names = (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const readmes: ExampleReadme[] = [];
  for (const name of names) {
    const path = join(dir, name, "README.md");
    const blocks = shellBlocks(await readFile(path, "utf8")).map(parseBlock);
    readmes.push({ name, path, blocks });
  }
  return readmes;
}

/** The line that runs the example's `run.ts`, as `node <flags> examples/<name>/run.ts`. */
export function isRunLine(name: string, line: BlockLine): boolean {
  return new RegExp(`^node( --[a-zA-Z=-]+)* examples/${name}/run\\.ts$`).test(line.command);
}

/** A line that runs the CLI: `runwright <arguments>`. */
export function isCliLine(line: BlockLine): boolean {
  return /^runwright\s/.test(line.command);
}
