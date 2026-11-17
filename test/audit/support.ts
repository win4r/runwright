/**
 * Helpers for the audit tests (not a test file).
 *
 * `recordingStore()` wraps the store the runners use and records, at the store boundary, every claim (who, which
 * run, epoch, when, until when) and every commit attempt (the lease, the record types, when, and how the store
 * answered: "ok", "lease_lost" or the error code), so a test can see a write being attempted and refused instead
 * of inferring it from a log line.
 */
import { isRunwrightError } from "../../src/core/errors.ts";
import type { Lease, Store } from "../../src/store/types.ts";
import { storeWith } from "../helpers/engine.ts";

export interface RecordedClaim { runnerId: string; runId: string; epoch: number; claimedAt: number; expiresAt: number }
export interface RecordedCommit { lease: Lease; types: string[]; at: number; outcome: Promise<string> }

export function recordingStore(): { claims: RecordedClaim[]; commits: RecordedCommit[]; wrap(store: Store): Store } {
  const claims: RecordedClaim[] = [];
  const commits: RecordedCommit[] = [];
  return {
    claims,
    commits,
    wrap: (store) => storeWith(store, {
      async claimRuns(input) {
        const claimed = await store.claimRuns(input);
        for (const c of claimed) {
          const expiresAt = c.run.leaseExpiresAt ?? Number.NaN;
          claims.push({ runnerId: input.runnerId, runId: c.run.id, epoch: c.lease.epoch, claimedAt: expiresAt - input.leaseMs, expiresAt });
        }
        return claimed;
      },
      commit(lease, batch) {
        const attempt = store.commit(lease, batch);
        commits.push({
          lease: { ...lease }, types: batch.records.map((r) => r.type), at: Date.now(),
          outcome: attempt.then(() => "ok", (error: unknown) => (isRunwrightError(error) ? error.code : "error")),
        });
        return attempt;
      },
    }),
  };
}
