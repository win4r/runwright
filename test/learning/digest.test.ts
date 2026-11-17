import { test } from "node:test";
import assert from "node:assert/strict";
import type { JsonObject } from "../../src/core/json.ts";
import { buildDigest } from "../../src/learning/proposal.ts";
import type { JournalRecord } from "../../src/store/types.ts";

let seq = 0;
function record(type: string, key: string | null, data: JsonObject): JournalRecord {
  seq++;
  return { runId: "run_1", seq, epoch: 1, ts: 0, type, key, data };
}

function toolFinished(key: string, content: string, untrusted: boolean): JournalRecord {
  return record("tool.finished", key, {
    callId: key, tool: "fetch_page", outcome: "ok", content, data: null, isError: false, untrusted, truncated: false,
    fullResultPath: null, durationMs: 1,
  });
}

function nodeFinished(key: string, name: string, value: JsonObject): JournalRecord {
  return record("node.finished", key, { name, value, kind: "tool", scope: "" });
}

function linesOf(digest: string, prefix: string): string[] {
  return digest.split("\n").filter((line) => line.startsWith(prefix));
}

test("the node line of a workflow tool node whose tool result was untrusted is marked untrusted", () => {
  const journal = [
    toolFinished("wf/fetch#1", "the fetched page", true),
    nodeFinished("wf/fetch", "fetch", { ok: true, content: "the fetched page", data: null }),
    toolFinished("wf/local#1", "a local listing", false),
    nodeFinished("wf/local", "local", { ok: true, content: "a local listing", data: null }),
    nodeFinished("wf/sum", "sum", { total: 3 }),
    nodeFinished("wf/fetc", "fetc", { ok: true }),
  ];
  const digest = buildDigest(journal, "start", null);
  assert.deepEqual(linesOf(digest, "[node "), [
    '[node fetch] [untrusted] {"content":"the fetched page","data":null,"ok":true}',
    '[node local] {"content":"a local listing","data":null,"ok":true}',
    '[node sum] {"total":3}',
    '[node fetc] {"ok":true}',
  ]);
  assert.deepEqual(linesOf(digest, "[tool "), [
    "[tool wf/fetch#1] fetch_page → ok [untrusted]: the fetched page",
    "[tool wf/local#1] fetch_page → ok: a local listing",
  ]);
});

test("a retried tool node is marked by any of its attempts; a node without a key is never marked", () => {
  const journal = [
    toolFinished("wf/fetch#2", "second try", true),
    nodeFinished("wf/fetch", "fetch", { ok: true }),
    record("node.finished", null, { name: "loose", value: { ok: true } }),
  ];
  assert.deepEqual(linesOf(buildDigest(journal, "start", null), "[node "), ['[node fetch] [untrusted] {"ok":true}', '[node loose] {"ok":true}']);
});
