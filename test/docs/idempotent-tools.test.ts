/**
 * The docs state the idempotent contract where a workflow author looks for it ("Retry and deadlines" in
 * docs/workflows.md), and the sentence is checked against the tool that implements it: `delete_file` reports an
 * already absent file as a success with `deleted: false`, and its description says so.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createFileTools } from "../../src/tools/fs.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { fileToolContext } from "../helpers/tool-context.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function doc(name: string): Promise<string> {
  return readFile(join(ROOT, name), "utf8");
}

/** The text of a `## heading` section, up to the next `## ` heading. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n## ${heading}\n`);
  assert.ok(start >= 0, `section "${heading}" exists`);
  const end = text.indexOf("\n## ", start + 1);
  return text.slice(start, end === -1 ? undefined : end);
}

/** Markdown wraps lines; compare with every run of whitespace as one space. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

function deleteFile(): ToolDefinition {
  const tool = createFileTools({ maxReadBytes: 1024, maxWriteBytes: 1024 }).find((candidate) => candidate.name === "delete_file");
  assert.ok(tool !== undefined);
  return tool;
}

test("docs/workflows.md states the idempotent contract and what delete_file does with an absent file", async () => {
  const retry = flat(section(await doc("docs/workflows.md"), "Retry and deadlines"));
  assert.ok(retry.includes("**A tool declared `idempotent` must succeed when it is run again after it already took effect**"), retry);
  assert.ok(retry.includes("**deleting a file that is already absent gives `{ok: true}` with `data: {path, deleted: false}`**"), retry);
  assert.ok(retry.includes("A node's own `idempotent: true` only permits `retry` on a tool that is not declared retry-safe; it does not change what happens after a crash, which follows the tool's declaration."), retry);
});

/** Rule R and sentence D1 of the round-15 plan (2.1), verbatim. */
const RULE_R = "A tool call left unfinished (a `tool.started` with no `tool.finished`, after a crash, a pause or a forced shutdown) is " +
  "run again by the engine itself only when repeating it cannot undo finished work: a read-only tool always; a resumable tool always " +
  "(it replays its own steps); a tool declared `idempotent` with `effect: \"write\"` only if no write call of the run finished after this " +
  "call started. Otherwise the call is journalled `tool.interrupted` and waits for a person (retry, skip, cancel), like any other write.";
const D1 = "An unfinished call of a tool declared `idempotent` is run again by itself only when no write call of the run finished after " +
  "it started; otherwise repeating it could undo that finished work, so it waits for a person as an interrupted call.";

test("docs/workflows.md states rule R and sentence D1 where it says an idempotent tool is run again, and no longer says it always is", async () => {
  const text = flat(await doc("docs/workflows.md"));
  const retry = flat(section(await doc("docs/workflows.md"), "Retry and deadlines"));
  assert.ok(retry.includes(`**Rule R.** ${RULE_R}`), retry);
  assert.ok(retry.includes(D1), retry);
  assert.ok(retry.includes("a node's `retry` repeats it after a finished failure"), "a node's retry after a finished failure is unchanged");
  assert.ok(retry.includes("a tool declared `idempotent` is run again only when no write call of the run finished after it started"),
    "the pause and shutdown bullet follows rule R");
  assert.doesNotMatch(text, /runs such a call again by itself when a crash/);
  assert.doesNotMatch(text, /a read-only, idempotent or resumable tool is run again/);
});

test("behind the sentence: delete_file twice gives deleted: true, then deleted: false, never an error", async (t) => {
  const workspace = join(await makeTempDir(t, "runwright-doc-idem-"), "ws");
  await mkdir(workspace);
  await writeFile(join(workspace, "done.txt"), "x");
  const context = await fileToolContext(workspace);
  const tool = deleteFile();
  const first = await tool.handler({ path: "done.txt" }, context);
  const second = await tool.handler({ path: "done.txt" }, context);
  assert.equal(first.isError, undefined);
  assert.deepEqual(first.data, { path: "done.txt", deleted: true });
  assert.equal(second.isError, undefined);
  assert.deepEqual(second.data, { path: "done.txt", deleted: false });
});

test("the delete_file description says what the docs say", () => {
  const { description } = deleteFile();
  assert.match(description, /already absent succeeds/);
  assert.doesNotMatch(description, /is an error/);
});
