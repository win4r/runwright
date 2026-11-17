import { test } from "node:test";
import assert from "node:assert/strict";
import { RunwrightError } from "../../src/core/errors.ts";
import { generateSealKey } from "../../src/security/seal.ts";
import { createSecretsService } from "../../src/security/secrets.ts";
import { createWriteRedaction, redactingStore } from "../../src/security/write-redaction.ts";
import type { WorkflowDocument } from "../../src/workflow/types.ts";
import { openTestStore } from "../helpers/store.ts";

function doc(name: string, description?: string): WorkflowDocument {
  return {
    format: "runwright.workflow/v1",
    name,
    ...(description === undefined ? {} : { description }),
    schemas: { out: { type: "string" } },
    output: "out",
    root: { id: "done", kind: "fail", message: "never" },
  } as unknown as WorkflowDocument;
}

test("check runs inside the save: resolve reads the latest stored version and null for an unknown name", async (t) => {
  const { store, dir } = await openTestStore(t);
  const { store: other } = await openTestStore(t, { dir });
  await store.saveWorkflow({ name: "a", document: doc("a", "v1"), source: "api" });
  await other.saveWorkflow({ name: "a", document: doc("a", "v2"), source: "api" });
  const seen: (string | null)[] = [];
  const saved = await store.saveWorkflow({
    name: "b",
    document: doc("b", "first"),
    source: "api",
    check: (resolve) => {
      seen.push((resolve("a") as { description?: string } | null)?.description ?? null);
      seen.push(resolve("b") === null ? "no b yet" : "b");
      seen.push(resolve("ghost") === null ? null : "ghost");
    },
  });
  assert.equal(saved.created, true);
  assert.deepEqual(seen, ["v2", "no b yet", null]);

  const second: (string | null)[] = [];
  await store.saveWorkflow({
    name: "b", document: doc("b", "changed"), source: "api",
    check: (resolve) => void second.push((resolve("b") as { description?: string } | null)?.description ?? null),
  });
  assert.deepEqual(second, ["first"], "resolve sees the version an earlier save stored, not the candidate");
});

test("a check that throws writes nothing and its error propagates unchanged", async (t) => {
  const { store } = await openTestStore(t);
  await store.saveWorkflow({ name: "a", document: doc("a", "v1"), source: "api" });
  const failure = new Error("not valid");
  await assert.rejects(
    store.saveWorkflow({ name: "a", document: doc("a", "v2"), source: "api", check: () => { throw failure; } }),
    (error: unknown) => error === failure,
  );
  const typed = new RunwrightError("workflow_invalid", "cycle", { status: 422 });
  await assert.rejects(
    store.saveWorkflow({ name: "fresh", document: doc("fresh"), source: "api", check: () => { throw typed; } }),
    (error: unknown) => error === typed,
  );
  assert.equal((await store.getWorkflow("a"))?.version, 1);
  assert.equal(await store.getWorkflow("a", 2), null);
  assert.equal(await store.getWorkflow("fresh"), null);
  assert.deepEqual((await store.listWorkflows()).map((w) => [w.name, w.version]), [["a", 1]]);
  const after = await store.saveWorkflow({ name: "a", document: doc("a", "v2"), source: "api", check: () => undefined });
  assert.equal(after.workflow.version, 2);
});

test("check runs before the ownership rule, and the redacting store forwards it", async (t) => {
  const { store: raw } = await openTestStore(t);
  const store = redactingStore(raw, createWriteRedaction(await createSecretsService({ store: raw, sealKey: generateSealKey() })));
  await raw.saveWorkflow({ name: "owned", document: doc("owned"), source: "promotion", skillItemId: "li_1" });
  const calls: string[] = [];
  const invalid = new RunwrightError("workflow_invalid", "invalid", { status: 422 });
  await assert.rejects(
    store.saveWorkflow({ name: "owned", document: doc("owned", "edit"), source: "api", check: () => { calls.push("check"); throw invalid; } }),
    (error: unknown) => error === invalid,
  );
  await assert.rejects(
    store.saveWorkflow({ name: "owned", document: doc("owned", "edit"), source: "api", check: () => void calls.push("check") }),
    (error: unknown) => error instanceof RunwrightError && error.code === "conflict",
  );
  assert.deepEqual(calls, ["check", "check"]);
  assert.equal((await raw.getWorkflow("owned"))?.version, 1);
});
