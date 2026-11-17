/**
 * Findings R01-03 and R01-04 through the real SSE stream: a secret handed to a run is split across several model
 * deltas. No delta, and no concatenation of deltas, carries the secret (plain or base64); the deltas put together
 * are exactly the journalled model text, which has the run's own placeholder. It runs for an ASCII secret and for
 * a multibyte one that is shorter than 8 characters but longer than 8 bytes at its start.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { startTestApp } from "../fixtures/app.ts";
import { fullTimeline, scriptedAgent, waitForStatus } from "../fixtures/runs.ts";

const NAME = "STREAM_SECRET";

function forms(value: string): string[] {
  const base64 = Buffer.from(value, "utf8").toString("base64");
  return [value, base64, base64.replace(/=+$/, ""), Buffer.from(value, "utf8").toString("base64url")];
}

const VALUES: readonly { label: string; make: () => string }[] = [
  { label: "ASCII", make: () => `rw-split-${randomBytes(12).toString("hex")}` },
  { label: "multibyte", make: () => `秘密口令${randomBytes(3).toString("hex")}` },
];

for (const { label, make } of VALUES) {
  test(`a secret split across streamed deltas is never released (${label})`, { timeout: 20_000 }, async (t) => {
    const secret = make();
    const { client } = await startTestApp(t);
    await client.setSecret(NAME, secret);
    const agent = await client.saveAgent(scriptedAgent({
      name: "Streamer", secrets: [NAME],
      script: { turns: [{ text: `the value is ${secret} and nothing else`, chunks: 7, delayMs: 400 }] },
    }), "streamer");
    const { run } = await client.startRun({ agentId: agent.agent.id, message: "go" });

    const deltas: string[] = [];
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 15_000);
    t.after(() => clearTimeout(timer));
    for await (const event of client.followTimeline(run.id, { after: 0, signal: abort.signal })) {
      if (event.event === "delta") {
        const data = event.data as { text?: unknown };
        if (typeof data.text === "string") deltas.push(data.text);
      }
    }
    const done = await waitForStatus(client, run.id, ["completed", "failed", "cancelled"]);
    assert.equal(done.run.status, "completed");

    assert.ok(deltas.length >= 2, `expected several deltas, got ${deltas.length}`);
    const joined = deltas.join("");
    for (const form of forms(secret)) {
      for (const delta of deltas) assert.equal(delta.includes(form), false, "a delta carries the secret");
      assert.equal(joined.includes(form), false, "the deltas put together carry the secret");
    }
    const finished = (await fullTimeline(client, run.id)).filter((r) => r.type === "model.finished");
    assert.equal(finished.length, 1);
    const text = finished[0]?.data["text"];
    assert.equal(text, `the value is [redacted:${NAME}] and nothing else`);
    assert.equal(joined, text, "the deltas are exactly the journalled text");
  });
}
