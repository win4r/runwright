import { randomBytes } from "node:crypto";
import type { LearningEffects, LearningItem, LearningKind, LearningPut, Store } from "../../src/store/types.ts";
import type { WorkflowDocument } from "../../src/workflow/types.ts";

/**
 * Commits learning effects the only way a store accepts them: through a lease-fenced commit of a run of
 * `agentId`. Creates a run, claims it (releasing any other run the claim picked up), commits `learning` and ends
 * the run `cancelled` (so it never counts as a completed run). Needs a store no runner is claiming from.
 */
async function commitAsRun(store: Store, agentId: string, purpose: string, learning: LearningEffects): Promise<void> {
  const { run } = await store.createRun({ agentId, input: { message: purpose, data: null } });
  const claimed = await store.claimRuns({ runnerId: "seed", limit: 50, leaseMs: 60_000 });
  const mine = claimed.find((c) => c.run.id === run.id);
  for (const other of claimed) {
    if (other !== mine) {
      await store.commit(other.lease, { records: [{ type: "run.released", data: { reason: purpose } }], transition: { to: "queued" } });
    }
  }
  if (mine === undefined) throw new Error(`the seeding run ${run.id} could not be claimed`);
  await store.commit(mine.lease, {
    records: [{ type: "run.cancelled", data: { reason: purpose } }],
    transition: { to: "cancelled" },
    learning,
  });
}

/**
 * Stores learning items through a fenced commit (see `commitAsRun`). Existing items are updated at their current
 * version. Returns the stored items in input order.
 */
export async function seedLearningItems(
  store: Store, agentId: string,
  items: { kind: LearningKind; name: string; title: string; description: string; body: string; status: "active" | "held" }[],
): Promise<LearningItem[]> {
  const existing = await store.listLearningItems({ agentId });
  const versionOf = (kind: LearningKind, name: string): number | null =>
    existing.find((item) => item.kind === kind && item.name === name)?.version ?? null;
  const puts: LearningPut[] = items.map((item) => ({
    id: `li_${randomBytes(8).toString("hex")}`,
    ...item,
    expectedVersion: versionOf(item.kind, item.name),
  }));
  await commitAsRun(store, agentId, "seed learning items", { puts });

  const stored = await store.listLearningItems({ agentId });
  return items.map((item) => {
    const found = stored.find((s) => s.kind === item.kind && s.name === item.name);
    if (found === undefined) throw new Error(`learning ${item.kind} ${item.name} was not stored`);
    return found;
  });
}

/** Promotes an active skill to `workflow` (saved under `name`) through a fenced commit; returns the promoted item. */
export async function promoteSkill(store: Store, skill: LearningItem, name: string, workflow: WorkflowDocument): Promise<LearningItem> {
  await commitAsRun(store, skill.agentId, "promote a skill", {
    promotions: [{ itemId: skill.id, expectedVersion: skill.version, workflow: { name, document: workflow }, note: "promoted by a test" }],
  });
  const promoted = await store.getLearningItem(skill.id);
  if (promoted === null) throw new Error(`learning item ${skill.id} disappeared`);
  return promoted;
}
