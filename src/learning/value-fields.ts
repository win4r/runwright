/**
 * The field specifications of learning's journalled step values and of the structured outputs it reads back by
 * field name (rule H, `src/store/record-fields.ts`). `hooks.ts` passes them as `valueFields` and `outputFields`,
 * so both redaction passes keep Runwright's own field names and redact only the text inside.
 *
 * "keep" marks only what learning's code computed: a boolean, a counter, a version or a timestamp the store
 * computed, an id Runwright generated, or a word of a closed list that code chose (an item's kind from its
 * folder, a mode, a provenance verdict and field, a promotion outcome). Names, titles, descriptions, bodies,
 * paths, reasons, problems and the prompt section came from a model or a person, so they are text. What a model
 * answered in a field learning reads as a word or a boolean (`verdict`, `job_finished`) stays text or payload: a
 * check decides it after the read.
 */
import { fieldList, fieldMap, fieldObject, type ArraySpec, type ObjectSpec } from "../store/record-fields.ts";

/** AppliedItem (`src/learning/apply.ts`). */
const REF = fieldObject({ itemId: "keep", path: "text", version: "keep" });
/** `{ path: string; reason: string }[]`. */
const PATH_REASON = fieldList(fieldObject({ path: "text", reason: "text" }));

/** LearningContext (`src/engine/types.ts`), the value of `learning/given`. */
export const GIVEN_VALUE_FIELDS: ObjectSpec = fieldObject({
  promptSection: "text",
  given: fieldList(fieldObject({ itemId: "keep", version: "keep", kind: "keep", name: "text", mode: "keep" })),
  tools: fieldList("text"),
});

/** CheckedValue (`src/learning/hooks.ts`), the value of `learning/check`. */
export const CHECKED_VALUE_FIELDS: ObjectSpec = fieldObject({
  dropAll: "text",
  jobFinished: "keep",
  items: fieldList(fieldObject({ path: "text", kind: "keep", name: "text", title: "text", description: "text", body: "text" })),
  dropped: PATH_REASON,
  heldPaths: fieldList("text"),
  versions: fieldMap("keep"),
});

/** ProvenanceVerdict[] (`src/learning/provenance.ts`), the value of `learning/provenance`. */
export const PROVENANCE_VALUE_FIELDS: ArraySpec = fieldList(fieldObject({
  path: "text", verdict: "keep", field: "keep", overlap: "keep", verbatimRun: "keep", reason: "text",
}));

/** AppliedValue (`src/learning/apply.ts`), the value of `learning/apply`. */
export const APPLIED_VALUE_FIELDS: ObjectSpec = fieldObject({ kept: fieldList(REF), held: fieldList(REF), conflicts: PATH_REASON });

/** LearningItem | null (`src/store/types.ts`), the value of `learning/promote/pick`. */
export const PICKED_VALUE_FIELDS: ObjectSpec = fieldObject({
  id: "keep",
  agentId: "keep",
  kind: "keep",
  name: "text",
  title: "text",
  description: "text",
  body: "text",
  status: "keep",
  version: "keep",
  etag: "keep",
  sourceRunId: "keep",
  promotedWorkflow: "text",
  promotedWorkflowVersion: "keep",
  promotionAttempts: "keep",
  createdAt: "keep",
  updatedAt: "keep",
});

/** PromotionValue (`src/learning/hooks.ts`), the value of `learning/promote/apply`. */
export const PROMOTION_VALUE_FIELDS: ObjectSpec = fieldObject({ outcome: "keep", workflow: "text", problems: fieldList("text") });

/** The output of `learning/propose`, PROPOSAL_SCHEMA (`src/learning/proposal.ts`): `{job_finished, files: [{path, content}]}`. */
export const PROPOSAL_OUTPUT_FIELDS: ObjectSpec = fieldObject({
  job_finished: "payload",
  files: fieldList(fieldObject({ path: "text", content: "text" })),
});

/** The output of `learning/grade`, GRADES_SCHEMA (`src/learning/grader.ts`): `{job_finished, decisions: [{path, verdict, reason}]}`. */
export const GRADES_OUTPUT_FIELDS: ObjectSpec = fieldObject({
  job_finished: "payload",
  decisions: fieldList(fieldObject({ path: "text", verdict: "text", reason: "text" })),
});

/** The output of `learning/promote/draft`, DRAFT_SCHEMA (`src/learning/promotion.ts`): `{document}`, a workflow document the model wrote. */
export const DRAFT_OUTPUT_FIELDS: ObjectSpec = fieldObject({ document: "payload" });
