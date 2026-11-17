import { errorInfo, isRunwrightError } from "../core/errors.ts";
import type { IdSource } from "../core/ids.ts";
import { isJsonObject, type Json, type JsonObject } from "../core/json.ts";
import type { Config } from "../config/types.ts";
import { isControlSignal } from "../engine/control.ts";
import type {
  LearningContext, LearningGiven, LearningHooks, ModelStepRequest, RunContext, StepPlan,
} from "../engine/types.ts";
import type { FieldSpec } from "../store/record-fields.ts";
import type { LearningItem, Store } from "../store/types.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { WorkflowDocument } from "../workflow/types.ts";
import { itemPath, planApply } from "./apply.ts";
import { checkProposal, type CandidateItem } from "./checks.ts";
import { buildGraderMessage, combineVerdicts, GRADER_SYSTEM, GRADES_SCHEMA, type Decision } from "./grader.ts";
import {
  buildPromotionMessage, checkDraft, DRAFT_SCHEMA, pickPromotionCandidate, promotedWorkflowName, type CatalogueTool,
} from "./promotion.ts";
import { buildDigest, PROPOSAL_SCHEMA, PROPOSAL_SYSTEM } from "./proposal.ts";
import { assessProvenance, type ProvenanceVerdict } from "./provenance.ts";
import { RECALL_TOOL_NAME, selectItems } from "./select.ts";
import {
  APPLIED_VALUE_FIELDS, CHECKED_VALUE_FIELDS, DRAFT_OUTPUT_FIELDS, GIVEN_VALUE_FIELDS, GRADES_OUTPUT_FIELDS, PICKED_VALUE_FIELDS,
  PROMOTION_VALUE_FIELDS, PROPOSAL_OUTPUT_FIELDS, PROVENANCE_VALUE_FIELDS,
} from "./value-fields.ts";

export interface LearningDeps { store: Store; tools: ToolRegistry; config: Config["learning"]; ids: IdSource }

const PROMOTION_SYSTEM = "You turn a learned skill into a Runwright workflow document that does the same job deterministically.";
const SKILL_CHANGED = "the skill changed while its workflow was being drafted";

/** The journalled value of `learning/promote/apply` and the data of `learning.promotion` (with the item id). */
type PromotionValue = { outcome: "kept" | "rejected"; workflow: string | null; problems: string[] };

/** The journalled value of `learning/check`: the code checks, plus what the agent's items looked like then. */
interface CheckedValue {
  dropAll: string | null; jobFinished: boolean; items: CandidateItem[]; dropped: { path: string; reason: string }[];
  heldPaths: string[];
  /** Version of every existing item of the agent at check time, by path (absent in journals written by older versions). */
  versions?: Record<string, number>;
}
const isLimit = (error: unknown): boolean => isRunwrightError(error) && error.code === "limit_reached";
/** The meta of a learning step: its name and the field specification of its value (`src/learning/value-fields.ts`). */
const step = (name: string, valueFields: FieldSpec): { recordType: "step"; name: string; valueFields: FieldSpec } =>
  ({ recordType: "step", name, valueFields });

function readGiven(value: Json): LearningGiven[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isJsonObject).map((g) => ({
    itemId: String(g["itemId"]), version: Number(g["version"]), kind: g["kind"] === "skill" ? "skill" : "note",
    name: String(g["name"]), mode: g["mode"] === "full" ? "full" : "line",
  }));
}

function readContext(value: Json): LearningContext {
  const v: JsonObject = isJsonObject(value) ? value : {};
  return {
    promptSection: typeof v["promptSection"] === "string" ? v["promptSection"] : "",
    given: readGiven(v["given"] ?? null),
    tools: Array.isArray(v["tools"]) ? v["tools"].filter((t): t is string => typeof t === "string") : [],
  };
}

/** A learning phase already gave up in an earlier attempt of this run: do not start over. */
function alreadySkipped(context: RunContext): boolean {
  return context.journal().some((r) => r.type === "learning.skipped" && r.key !== null
    && r.key.startsWith("learning/") && r.key !== "learning/given");
}

/**
 * The tools a promotion draft may use: those the agent lists and that a call from this run would not be denied
 * (the engine's own answer, `RunContext.toolPolicy`: the server deny list, an explicit `deny`, a default policy of
 * `deny`).
 */
function catalogue(tools: ToolRegistry, context: RunContext): CatalogueTool[] {
  const listed = new Set(context.definition.tools.map((t) => t.name));
  return tools.list()
    .filter((tool) => listed.has(tool.name) && context.toolPolicy(tool.name) !== "deny")
    .map((tool) => ({
      name: tool.name, description: tool.description, parameters: tool.parameters,
      retrySafe: tool.effect === "read" || tool.idempotent === true,
    }));
}

export function createLearningHooks(deps: LearningDeps): LearningHooks {
  const { store, config } = deps;

  const structured = async (context: RunContext, key: string, request: ModelStepRequest): Promise<{ output: Json } | { unavailable: string }> => {
    try {
      const result = await context.model(key, request);
      return { output: result.output };
    } catch (error) {
      if (isControlSignal(error)) throw error;
      if (isLimit(error)) return { unavailable: "limit" };
      if (isRunwrightError(error) && (error.code === "model_output_invalid" || error.code === "model_failed")) {
        return { unavailable: `${error.code}: ${error.message}` };
      }
      throw error;
    }
  };

  const learnFromProposal = async (context: RunContext, digest: string): Promise<"done" | "skipped"> => {
    const agentId = context.run.agentId;
    const proposed = await structured(context, "learning/propose", {
      purpose: "learning", step: "learning.propose", countsAsTurn: false, onLimit: config.onLimit, system: PROPOSAL_SYSTEM,
      messages: [{ role: "user", content: digest }], output: { name: "learning_proposal", schema: PROPOSAL_SCHEMA }, outputFields: PROPOSAL_OUTPUT_FIELDS,
    });
    if ("unavailable" in proposed) {
      await context.emit("learning/propose", "learning.skipped", { reason: proposed.unavailable });
      return "skipped";
    }

    const checked = await context.memo("learning/check", step("learning.check", CHECKED_VALUE_FIELDS), async () => {
      const existing = await store.listLearningItems({ agentId });
      const statuses = Object.fromEntries(existing.map((item) => [itemPath(item), item.status]));
      const result = checkProposal(proposed.output, {
        redactor: context.redactor, maxNotes: config.maxNotes, maxSkills: config.maxSkills, existing: statuses,
      });
      const heldPaths = existing.filter((item) => item.status === "held").map(itemPath);
      const versions = Object.fromEntries(existing.map((item) => [itemPath(item), item.version]));
      const value: CheckedValue = { ...result, heldPaths, versions };
      return value as unknown as Json;
    }) as unknown as CheckedValue;
    await context.emit("learning/check", "learning.checked", {
      dropAll: checked.dropAll, dropped: checked.dropped, surviving: checked.items.map((item) => item.path),
    });
    if (checked.dropAll !== null || checked.items.length === 0) return "done";

    const origins = await context.memo("learning/provenance", step("learning.provenance", PROVENANCE_VALUE_FIELDS), async () =>
      (await assessProvenance(checked.items, context.journal(), context.workspace)) as unknown as Json) as unknown as ProvenanceVerdict[];
    const survivors = checked.items.filter((item) => origins.find((o) => o.path === item.path)?.verdict !== "drop");

    let graded: Decision[] = [];
    if (survivors.length > 0) {
      const grades = await structured(context, "learning/grade", {
        purpose: "grader", step: "learning.grade", countsAsTurn: false, onLimit: config.onLimit, system: GRADER_SYSTEM,
        ...(config.graderModel === null ? {} : { model: config.graderModel }),
        messages: [{ role: "user", content: buildGraderMessage(digest, survivors) }],
        output: { name: "learning_grades", schema: GRADES_SCHEMA }, outputFields: GRADES_OUTPUT_FIELDS,
      });
      graded = combineVerdicts({
        candidates: survivors, provenance: origins, proposalJobFinished: checked.jobFinished, heldPaths: checked.heldPaths,
        ...("output" in grades ? { grader: grades.output } : { grader: null, graderUnavailable: grades.unavailable }),
      });
    }
    const decisions: Decision[] = checked.items.map((item) => {
      const decided = graded.find((d) => d.path === item.path);
      if (decided !== undefined) return decided;
      const origin = origins.find((o) => o.path === item.path);
      return { path: item.path, verdict: "drop", reason: origin?.reason ?? "untrusted_origin", by: "provenance" };
    });
    await context.emit("learning/grade", "learning.graded", { decisions: decisions as unknown as Json[] });

    const applied = await context.effect("learning/apply", step("learning.apply", APPLIED_VALUE_FIELDS), async () => {
      const planned = planApply({
        decisions, candidates: checked.items, versions: checked.versions ?? {},
        current: await store.listLearningItems({ agentId }), newId: () => deps.ids.next("li"),
      });
      return { value: planned.value as unknown as JsonObject, ...(planned.puts.length > 0 ? { learning: { puts: planned.puts } } : {}) };
    });
    await context.emit("learning/apply", "learning.applied", applied);
    return "done";
  };

  const promote = async (context: RunContext): Promise<void> => {
    const agentId = context.run.agentId;
    const picked = await context.memo("learning/promote/pick", step("learning.promote.pick", PICKED_VALUE_FIELDS), async () => {
      const [skills, counts] = await Promise.all([
        store.listLearningItems({ agentId, kind: "skill", status: "active" }),
        store.skillServeCounts(agentId),
      ]);
      return pickPromotionCandidate(skills, counts, config.promoteAfterRuns) as unknown as Json;
    }) as unknown as LearningItem | null;
    if (picked === null) return;

    const tools = catalogue(deps.tools, context);
    const name = promotedWorkflowName(picked);
    const draft = await structured(context, "learning/promote/draft", {
      purpose: "promotion", step: "learning.promote", countsAsTurn: false, onLimit: config.onLimit, system: PROMOTION_SYSTEM,
      messages: [{ role: "user", content: buildPromotionMessage(picked, tools) }],
      output: { name: "workflow_draft", schema: DRAFT_SCHEMA }, outputFields: DRAFT_OUTPUT_FIELDS,
    });
    if ("unavailable" in draft && draft.unavailable === "limit") {
      await context.emit("learning/promote", "learning.skipped", { reason: "limit" });
      return;
    }

    // An attempt, kept or rejected, counts only against the skill version it was drafted from, while that skill is
    // active and not promoted: the skill is read first, and a changed one is rejected with no promotion at all.
    // The store checks the same in the commit's transaction for both outcomes (learning_conflict), and the effect
    // then plans again, so a change between this read and the commit also ends here.
    const outcome = await context.effect("learning/promote/apply", step("learning.promote.apply", PROMOTION_VALUE_FIELDS), async (): Promise<StepPlan<PromotionValue>> => {
      const now = await store.getLearningItem(picked.id);
      if (now === null || now.status !== "active" || now.promotedWorkflow !== null || now.version !== picked.version) {
        return { value: { outcome: "rejected", workflow: null, problems: [SKILL_CHANGED] } };
      }
      const rejected = (problems: string[], note: string): StepPlan<PromotionValue> => ({
        value: { outcome: "rejected", workflow: null, problems },
        learning: { promotions: [{ itemId: picked.id, expectedVersion: picked.version, workflow: null, note }] },
      });
      if ("unavailable" in draft) {
        const problems = [`the draft could not be produced (${draft.unavailable})`];
        return rejected(problems, problems.join("; "));
      }
      const saved = await store.listWorkflows();
      const resolveWorkflow = (wanted: string): WorkflowDocument | null => saved.find((w) => w.name === wanted)?.document ?? null;
      const check = checkDraft(draft.output, { name, tools, resolveWorkflow, redactor: context.redactor });
      if (!check.ok) return rejected(check.problems, check.problems.slice(0, 5).join("; "));
      const taken = await store.getWorkflow(name);
      if (taken !== null && !(taken.source === "promotion" && taken.skillItemId === picked.id)) {
        const problems = [`the workflow name ${name} is already used by a workflow this skill does not own`];
        return rejected(problems, problems[0] as string);
      }
      return {
        value: { outcome: "kept", workflow: name, problems: [] },
        learning: {
          promotions: [{
            itemId: picked.id, expectedVersion: picked.version, workflow: { name, document: check.document },
            note: `drafted by run ${context.run.id}, validated and dry-run`,
          }],
        },
      };
    });
    await context.emit("learning/promote", "learning.promotion", { itemId: picked.id, ...outcome });
  };

  return {
    async prepare(context: RunContext): Promise<LearningContext | null> {
      try {
        const value = await context.effect("learning/given", step("learning.given", GIVEN_VALUE_FIELDS), async () => {
          const items = await store.listLearningItems({ agentId: context.run.agentId, status: "active" });
          const recall = context.toolPolicy(RECALL_TOOL_NAME, { assumeGranted: true }) !== "deny";
          const selection = selectItems(items, context.run.input.message, config.budgetTokens, { recall });
          const given = selection.given.map((g) => ({ itemId: g.itemId, version: g.version, mode: g.mode }));
          return { value: selection as unknown as Json, ...(given.length > 0 ? { learning: { given } } : {}) };
        });
        const learning = readContext(value);
        if (learning.given.length > 0) await context.emit("learning/given", "learning.given", { items: learning.given as unknown as Json[] });
        return learning;
      } catch (error) {
        if (isControlSignal(error)) throw error;
        const reason = errorInfo(error).message;
        context.logger.warn("learning.prepare_failed", { reason });
        await context.emit("learning/given", "learning.skipped", { reason });
        return null;
      }
    },

    async afterRun(context: RunContext, outcome: { output: Json }): Promise<void> {
      if (alreadySkipped(context)) return;
      try {
        const digest = buildDigest(context.journal(), context.run.input.message, outcome.output);
        if ((await learnFromProposal(context, digest)) === "skipped") return;
        await promote(context);
      } catch (error) {
        if (isControlSignal(error)) throw error;
        const reason = errorInfo(error).message;
        context.logger.warn("learning.failed", { reason });
        await context.emit("learning/error", "learning.skipped", { reason });
      }
    },
  };
}
