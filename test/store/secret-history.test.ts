/**
 * Retired secret values (plan 2.3): putSecret and deleteSecret keep the value they replace or remove in
 * `secret_history`, in the same transaction; pruneRetiredSecrets deletes a retired value once no unfinished run
 * that was created at or before its retirement exists.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createFakeClock, type FakeClock } from "../../src/core/clock.ts";
import { isRunwrightError } from "../../src/core/errors.ts";
import type { RunStatus, Store } from "../../src/store/types.ts";
import { generateSealKey } from "../../src/security/seal.ts";
import { createSecretsService } from "../../src/security/secrets.ts";
import { createWriteRedaction, redactingStore } from "../../src/security/write-redaction.ts";
import { openTestStore, testAgentDefinition } from "../helpers/store.ts";

const A = new Uint8Array([1, 1, 1]);
const B = new Uint8Array([2, 2, 2, 2]);
const C = new Uint8Array([3]);

test("putSecret with different bytes retires the earlier value; the same bytes again retire nothing", async (t) => {
  const clock = createFakeClock(1_000);
  const { store } = await openTestStore(t, { clock });
  await store.putSecret("KEY", A);
  assert.deepEqual(await store.listRetiredSecrets(), [], "a first value replaces nothing");
  clock.advance(5);
  await store.putSecret("KEY", A);
  assert.deepEqual(await store.listRetiredSecrets(), [], "identical bytes are not a change");
  clock.advance(5);
  await store.putSecret("KEY", B);
  assert.deepEqual(await store.listRetiredSecrets(), [{ name: "KEY", sealed: A, retiredAt: 1_010 }]);
  assert.deepEqual((await store.getSecret("KEY"))?.sealed, B);
  clock.advance(5);
  await store.putSecret("OTHER", C);
  await store.putSecret("KEY", C);
  assert.deepEqual(await store.listRetiredSecrets(), [
    { name: "KEY", sealed: A, retiredAt: 1_010 }, { name: "KEY", sealed: B, retiredAt: 1_015 },
  ], "oldest first");
  assert.deepEqual(await store.listRetiredSecrets("OTHER"), []);
  assert.deepEqual((await store.listRetiredSecrets("KEY")).map((r) => [...r.sealed]), [[1, 1, 1], [2, 2, 2, 2]]);
});

test("deleteSecret moves the value to the retired values; deleting a missing name retires nothing", async (t) => {
  const clock = createFakeClock(2_000);
  const { store } = await openTestStore(t, { clock });
  await store.putSecret("KEY", A);
  clock.advance(7);
  assert.equal(await store.deleteSecret("KEY"), true);
  assert.equal(await store.getSecret("KEY"), null);
  assert.deepEqual(await store.listSecrets(), []);
  assert.deepEqual(await store.listRetiredSecrets("KEY"), [{ name: "KEY", sealed: A, retiredAt: 2_007 }]);
  assert.equal(await store.deleteSecret("KEY"), false);
  assert.equal(await store.deleteSecret("NEVER_SET"), false);
  assert.equal((await store.listRetiredSecrets()).length, 1);
});

/** A trigger on the secrets table, created over a second connection, that aborts every `kind` statement on it. */
function failSecrets(path: string, kind: "UPDATE" | "DELETE"): () => void {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TRIGGER inject_failure BEFORE ${kind} ON secrets BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
  return () => {
    db.exec("DROP TRIGGER inject_failure");
    db.close();
  };
}

test("putSecret and deleteSecret are atomic: a failure after the history row is written leaves neither change", async (t) => {
  const { store, path } = await openTestStore(t);
  await store.putSecret("KEY", A);

  let restore = failSecrets(path, "UPDATE");
  await assert.rejects(store.putSecret("KEY", B), (e: unknown) => isRunwrightError(e) && e.code === "store_error");
  restore();
  assert.deepEqual(await store.listRetiredSecrets(), [], "the retired row was rolled back with the failed update");
  assert.deepEqual((await store.getSecret("KEY"))?.sealed, A);

  restore = failSecrets(path, "DELETE");
  await assert.rejects(store.deleteSecret("KEY"), (e: unknown) => isRunwrightError(e) && e.code === "store_error");
  restore();
  assert.deepEqual(await store.listRetiredSecrets(), [], "the retired row was rolled back with the failed delete");
  assert.deepEqual((await store.getSecret("KEY"))?.sealed, A);

  await store.putSecret("KEY", B);
  assert.deepEqual((await store.listRetiredSecrets()).map((r) => [...r.sealed]), [[1, 1, 1]], "it works again once nothing fails");
});

/** A run of agent "a" created at the clock's current time, moved to `status`. */
async function runIn(store: Store, status: RunStatus): Promise<string> {
  const { run } = await store.createRun({ agentId: "a", input: { message: "go", data: null } });
  if (status === "queued") return run.id;
  const claimed = (await store.claimRuns({ runnerId: "r", limit: 100, leaseMs: 600_000 })).find((c) => c.run.id === run.id);
  assert.ok(claimed !== undefined, `run ${run.id} was claimed`);
  if (status !== "running") {
    const end = status === "completed" ? { to: status, output: null } : status === "failed"
      ? { to: status, error: { code: "x", message: "x" } } : { to: status };
    await store.commit(claimed.lease, { records: [{ type: "run.note", data: {} }], transition: end as never });
  }
  return run.id;
}

async function setup(t: Parameters<typeof openTestStore>[0]): Promise<{ store: Store; clock: FakeClock }> {
  const clock = createFakeClock(10_000);
  const { store } = await openTestStore(t, { clock });
  await store.saveAgent({ id: "a", definition: testAgentDefinition() });
  return { store, clock };
}

test("with no runs at all every retired value is pruned", async (t) => {
  const { store, clock } = await setup(t);
  await store.putSecret("KEY", A);
  clock.advance(1);
  await store.putSecret("KEY", B);
  await store.deleteSecret("KEY");
  assert.equal((await store.listRetiredSecrets()).length, 2);
  assert.equal(await store.pruneRetiredSecrets(), 2);
  assert.deepEqual(await store.listRetiredSecrets(), []);
  assert.equal(await store.pruneRetiredSecrets(), 0);
});

for (const status of ["queued", "running", "waiting", "paused"] as const) {
  test(`a retired value is kept while a ${status} run created before it was retired exists`, async (t) => {
    const { store, clock } = await setup(t);
    await store.putSecret("KEY", A);
    await runIn(store, status);
    clock.advance(10);
    await store.putSecret("KEY", B);
    assert.equal(await store.pruneRetiredSecrets(), 0);
    assert.equal((await store.listRetiredSecrets("KEY")).length, 1);
  });
}

for (const status of ["completed", "failed", "cancelled"] as const) {
  test(`a ${status} run created before the retirement does not keep the retired value`, async (t) => {
    const { store, clock } = await setup(t);
    await store.putSecret("KEY", A);
    await runIn(store, status);
    clock.advance(10);
    await store.putSecret("KEY", B);
    assert.equal(await store.pruneRetiredSecrets(), 1);
    assert.deepEqual(await store.listRetiredSecrets(), []);
  });
}

test("a waiting run keeps the row until it is terminal; then the next prune deletes it", async (t) => {
  const { store, clock } = await setup(t);
  await store.putSecret("KEY", A);
  const runId = await runIn(store, "waiting");
  clock.advance(10);
  await store.deleteSecret("KEY");
  assert.equal(await store.pruneRetiredSecrets(), 0);
  await store.enqueueCommand(runId, { type: "cancel", reason: null });
  const [claimed] = await store.claimRuns({ runnerId: "r", limit: 1, leaseMs: 600_000 });
  assert.equal(claimed?.run.id, runId);
  assert.equal(await store.pruneRetiredSecrets(), 0, "running again: still unfinished");
  const commands = (await store.listCommands(runId, { unconsumedOnly: true })).map((c) => c.id);
  await store.commit((claimed as NonNullable<typeof claimed>).lease, {
    records: [{ type: "run.cancelled", data: {} }], transition: { to: "cancelled" }, consumeCommands: commands,
  });
  assert.equal(await store.pruneRetiredSecrets(), 1);
});

test("a run created after the retirement does not keep the row; one created at the same instant does", async (t) => {
  const { store, clock } = await setup(t);
  await store.putSecret("KEY", A);
  clock.advance(10);
  await store.putSecret("KEY", B);
  clock.advance(1);
  await runIn(store, "waiting");
  assert.equal(await store.pruneRetiredSecrets(), 1, "created after retired_at: it can only have been handed B");

  await store.putSecret("KEY", C);
  await runIn(store, "queued");
  assert.equal(await store.pruneRetiredSecrets(), 0, "created_at === retired_at keeps it");
  assert.deepEqual((await store.listRetiredSecrets()).map((r) => [...r.sealed]), [[2, 2, 2, 2]]);
});

test("the redacting store wrapper passes the retired-value methods through", async (t) => {
  const { store } = await setup(t);
  await store.putSecret("KEY", A);
  await runIn(store, "waiting");
  const wrapped = redactingStore(store, createWriteRedaction(await createSecretsService({ store, sealKey: generateSealKey() })));
  await wrapped.putSecret("KEY", B);
  assert.deepEqual(await wrapped.listRetiredSecrets("KEY"), await store.listRetiredSecrets("KEY"));
  assert.equal((await wrapped.listRetiredSecrets()).length, 1);
  assert.equal(await wrapped.pruneRetiredSecrets(), 0);
});
