/**
 * Saved result files through the real workflow executor: a map `a` whose body is node `b` beside a node named
 * `a_0__b` gives two step keys that sanitize alike, and both over-long results finishing together keep their
 * own files (finding R06-01); a deeply nested tool step with a key over 300 characters saves and completes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "../../../src/core/json.ts";
import type { JournalDataMap } from "../../../src/engine/journal-types.ts";
import { savedResultName } from "../../../src/engine/results.ts";
import type { ToolDefinition } from "../../../src/tools/types.ts";
import type { WorkflowNode } from "../../../src/workflow/types.ts";
import { doc, setupWorkflow } from "./helpers.ts";

type Finished = JournalDataMap["tool.finished"];

const FILL = 40_000;
const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

/** A read tool `big` with args `{fill}` whose invocations wait until `parties` of them have arrived. */
function barrierTool(parties: number): ToolDefinition {
  let arrived = 0;
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    name: "big", description: "Returns a long result.", effect: "read",
    parameters: { type: "object", required: ["fill"], properties: { fill: { type: "string" } } },
    handler: async (args) => {
      const fill = String(args["fill"]);
      arrived++;
      if (arrived >= parties) open();
      await gate;
      return { content: fill.repeat(FILL), data: { blob: fill.repeat(FILL) } };
    },
  };
}

async function verify(workspace: string, path: string | null | undefined, digest: string | undefined, bytes: number | undefined, expected: string): Promise<void> {
  assert.ok(typeof path === "string");
  const onDisk = await readFile(join(workspace, path));
  assert.equal(sha256(onDisk), digest, path);
  assert.equal(onDisk.length, bytes, path);
  assert.equal(onDisk.toString("utf8"), expected, path);
}

test("R06-01: map a (body b) beside node a_0__b, both over the limit and finishing together, keep their own files", async (t) => {
  const s = await setupWorkflow(t);
  s.h.tools.register(barrierTool(2));
  const workflow = doc({
    id: "root", kind: "parallel", branches: [
      {
        id: "a", kind: "map", over: { $ref: "input.items" }, as: "item", concurrency: 1, maxItems: 1,
        run: { id: "b", kind: "tool", tool: "big", args: { fill: "A" } },
      },
      { id: "a_0__b", kind: "tool", tool: "big", args: { fill: "B" } },
    ],
  }, null);
  const done = await s.run(await s.agent({ workflow, tools: [{ name: "big" }] }), { items: [0] });
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  const journal = await s.h.journal(done.id);
  const finishes = journal.filter((r) => r.type === "tool.finished");
  assert.deepEqual(finishes.map((r) => r.key).sort(), ["wf/a[0]/b#1", "wf/a_0__b#1"]);
  const workspace = join(s.h.dir, "workspaces", done.id);
  const paths: string[] = [];
  for (const record of finishes) {
    const finished = record.data as unknown as Finished;
    const key = record.key ?? "";
    const fill = key === "wf/a_0__b#1" ? "B" : "A";
    assert.equal(finished.truncated, true);
    assert.equal(finished.data, null);
    const text = fill.repeat(FILL);
    const json = canonicalJson({ blob: fill.repeat(FILL) });
    await verify(workspace, finished.fullResultPath, finished.fullResultSha256, finished.fullResultBytes, text);
    await verify(workspace, finished.fullDataPath, finished.fullDataSha256, finished.fullDataBytes, json);
    assert.equal(finished.fullResultPath, `.runwright/tool-results/${savedResultName(key, sha256(text))}.txt`);
    paths.push(finished.fullResultPath ?? "", finished.fullDataPath ?? "");
  }
  assert.equal(new Set(paths).size, 4);
});

test("a tool step nested deep enough for a key over 300 characters saves its full result and the run completes", async (t) => {
  const s = await setupWorkflow(t);
  s.h.tools.register(barrierTool(1));
  const id = (letter: string): string => `${letter}_${letter.repeat(58)}`;
  let node: WorkflowNode = { id: id("t"), kind: "tool", tool: "big", args: { fill: "D" } };
  for (const letter of ["e", "d", "c", "b"]) {
    node = { id: id(letter), kind: "map", over: { $ref: "input.items" }, as: `item_${letter}`, concurrency: 1, maxItems: 1, run: node };
  }
  const done = await s.run(await s.agent({ workflow: doc(node, null), tools: [{ name: "big" }] }), { items: [0] });
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  const [record] = (await s.h.journal(done.id)).filter((r) => r.type === "tool.finished");
  assert.ok(record !== undefined);
  const key = record.key ?? "";
  assert.ok(key.length > 300, `key of ${key.length} characters: ${key}`);
  const finished = record.data as unknown as Finished;
  const workspace = join(s.h.dir, "workspaces", done.id);
  await verify(workspace, finished.fullResultPath, finished.fullResultSha256, finished.fullResultBytes, "D".repeat(FILL));
  await verify(workspace, finished.fullDataPath, finished.fullDataSha256, finished.fullDataBytes, canonicalJson({ blob: "D".repeat(FILL) }));
  const name = (finished.fullDataPath ?? "").split("/").pop() ?? "";
  assert.ok(Buffer.byteLength(name) <= 132, name);
});
