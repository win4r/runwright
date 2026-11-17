import type { LearningItem, LearningKind, LearningPut } from "../store/types.ts";
import type { CandidateItem } from "./checks.ts";
import type { Decision } from "./grader.ts";

const FOLDER: Readonly<Record<LearningKind, string>> = { note: "notes", skill: "skills" };

/** The path of an item inside the agent's learning area: `notes/<name>.md` or `skills/<name>.md`. */
export const itemPath = (item: { kind: LearningKind; name: string }): string => `${FOLDER[item.kind]}/${item.name}.md`;

export interface AppliedItem { itemId: string; path: string; version: number }
/** The value of the `learning/apply` step and the data of `learning.applied`. */
export interface AppliedValue { kept: AppliedItem[]; held: AppliedItem[]; conflicts: { path: string; reason: string }[] }

export const CONFLICT_REASONS = {
  created: "created by someone else after this run checked it",
  changed: "changed after this run checked it",
  retired: "retired",
} as const;

export interface ApplyInput {
  decisions: readonly Decision[];
  candidates: readonly CandidateItem[];
  /** Version of every item of the agent when the run checked its proposal (journalled), by path. */
  versions: Readonly<Record<string, number>>;
  /** The agent's items as they are now. */
  current: readonly LearningItem[];
  /** Id for an item this run creates. */
  newId: () => string;
}

/**
 * Plans the item writes of a learning phase (plan 4.4). A write happens only when the item is exactly as the run
 * saw it at check time; anything that changed since is a conflict and keeps the newer version. Identical content
 * and status write nothing. Pure apart from `newId`.
 */
export function planApply(input: ApplyInput): { value: AppliedValue; puts: LearningPut[] } {
  const value: AppliedValue = { kept: [], held: [], conflicts: [] };
  const puts: LearningPut[] = [];
  for (const decision of input.decisions) {
    if (decision.verdict === "drop") continue;
    const candidate = input.candidates.find((c) => c.path === decision.path);
    if (candidate === undefined) continue;
    const status = decision.verdict === "keep" ? "active" : "held";
    const target = decision.verdict === "keep" ? value.kept : value.held;
    const existing = input.current.find((item) => item.kind === candidate.kind && item.name === candidate.name);
    const checkedVersion = Object.hasOwn(input.versions, candidate.path) ? input.versions[candidate.path] : undefined;
    const content = { title: candidate.title, description: candidate.description, body: candidate.body };
    const write = { kind: candidate.kind, name: candidate.name, ...content, status, note: decision.reason } as const;

    if (existing === undefined) {
      if (checkedVersion !== undefined) {
        value.conflicts.push({ path: candidate.path, reason: CONFLICT_REASONS.changed });
        continue;
      }
      const id = input.newId();
      puts.push({ id, ...write, expectedVersion: null });
      target.push({ itemId: id, path: candidate.path, version: 1 });
      continue;
    }
    if (existing.status === "retired") {
      value.conflicts.push({ path: candidate.path, reason: CONFLICT_REASONS.retired });
      continue;
    }
    if (checkedVersion === undefined) {
      value.conflicts.push({ path: candidate.path, reason: CONFLICT_REASONS.created });
      continue;
    }
    if (existing.version !== checkedVersion) {
      value.conflicts.push({ path: candidate.path, reason: CONFLICT_REASONS.changed });
      continue;
    }
    const same = existing.title === content.title && existing.description === content.description
      && existing.body === content.body && existing.status === status;
    if (same) {
      target.push({ itemId: existing.id, path: candidate.path, version: existing.version });
      continue;
    }
    puts.push({ id: existing.id, ...write, expectedVersion: existing.version });
    target.push({ itemId: existing.id, path: candidate.path, version: existing.version + 1 });
  }
  return { value, puts };
}
