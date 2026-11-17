import { isJsonObject, type Json, type JsonObject } from "../core/json.ts";
import type { WorkflowDocument } from "../workflow/types.ts";
import { PENDING_DETAIL_FIELDS, PENDING_RESOLUTION_FIELDS, RECORD_FIELDS, isEngineRecordType, redactBySpec } from "./record-fields.ts";
import type { CommitBatch, LearningEffects, NewJournalRecord } from "./types.ts";

/**
 * A redactor over the shapes a commit carries: plain text, and JSON values in two modes. `payload` redacts every
 * string and object key and turns a number whose digits hold a secret into the redacted text (a string); it is
 * what a field of a record calls for (RECORD_FIELDS). `json` redacts strings and object keys and keeps numbers;
 * it is used for a promoted workflow document only. Satisfies FieldRedactor.
 */
export interface BatchRedactor {
  text(value: string): string;
  json<T extends Json>(value: T): T;
  payload(value: Json): Json;
}

/**
 * A record's data redacted by what each field is, in one walk over the data as the engine built it: by the
 * record's own `fields` when the engine attached a declared specification; else an engine record type by its
 * entry in RECORD_FIELDS; any other type (a host tool's or driver's own record) whole.
 */
function redactRecordData(record: NewJournalRecord, redact: BatchRedactor): JsonObject {
  const spec = record.fields ?? (isEngineRecordType(record.type) ? RECORD_FIELDS[record.type] : undefined);
  return asObject(spec === undefined ? redact.payload(record.data) : redactBySpec(record.data, spec, redact));
}

/**
 * The redaction of an object, which is an object for every redactor Runwright builds. A redactor that turns a
 * whole object into another JSON value has it stored under `value`, so a record's data stays an object.
 */
function asObject(value: Json): JsonObject {
  return isJsonObject(value) ? value : { value };
}

function redactLearning(learning: LearningEffects, redact: BatchRedactor): LearningEffects {
  const out: LearningEffects = { ...learning };
  if (learning.puts !== undefined) {
    out.puts = learning.puts.map((put) => ({
      ...put, title: redact.text(put.title), description: redact.text(put.description), body: redact.text(put.body),
      ...(typeof put.note === "string" ? { note: redact.text(put.note) } : {}),
    }));
  }
  if (learning.promotions !== undefined) {
    out.promotions = learning.promotions.map((promotion) => ({
      ...promotion,
      note: redact.text(promotion.note),
      ...(typeof promotion.workflow === "object" && promotion.workflow !== null ? {
        workflow: {
          name: promotion.workflow.name,
          document: redact.json(promotion.workflow.document as unknown as Json) as unknown as WorkflowDocument,
        },
      } : {}),
    }));
  }
  return out;
}

/**
 * `batch` with `redact` applied to every text a commit can carry, each part by what it is:
 *
 * - records[].data: for a type in RECORD_FIELDS, field by field by its entry (`redactBySpec`): free text by
 *   `text`; caller, model, tool and driver values by `payload`; Runwright's own field names, enumerated values,
 *   generated ids and engine numbers as they are; a field the entry does not name by `payload`, key included. A
 *   type outside RECORD_FIELDS (a host tool's or driver's own record) by `payload` as a whole. A record that
 *   carries `fields` (a declared specification the engine attached) is redacted by it instead, and the returned
 *   record keeps the same `fields`, so the next pass walks it by the same object.
 * - openPendings[].title by `text`; openPendings[].detail by PENDING_DETAIL_FIELDS.
 * - resolvePendings[].resolution by PENDING_RESOLUTION_FIELDS.
 * - transition.output by `payload`; transition.error.message by `text` (its code as it is).
 * - learning.puts[].title, .description, .body and .note by `text`; learning.promotions[].note by `text` and
 *   .workflow.document by `json` (a document's numbers are structure; it was built from an already redacted
 *   model output).
 *
 * Record types and keys, a pending's id, kind and step key, usage, counters, setLimits, consumeCommands, item
 * ids and names and workflow names are not touched. Because a field's mode is decided by its place in the value
 * as the engine built it and a listed field name is never rewritten, a second pass (the store wrapper's) treats
 * every field as the first did. Returns a new batch; the input is not changed.
 */
export function redactCommitBatch(batch: CommitBatch, redact: BatchRedactor): CommitBatch {
  const out: CommitBatch = {
    ...batch, records: batch.records.map((record) => ({ ...record, data: redactRecordData(record, redact) })),
  };
  if (batch.openPendings !== undefined) {
    out.openPendings = batch.openPendings.map((p) => ({
      ...p, title: redact.text(p.title), detail: asObject(redactBySpec(p.detail, PENDING_DETAIL_FIELDS, redact)),
    }));
  }
  if (batch.resolvePendings !== undefined) {
    out.resolvePendings = batch.resolvePendings.map((p) => ({ id: p.id, resolution: asObject(redactBySpec(p.resolution, PENDING_RESOLUTION_FIELDS, redact)) }));
  }
  if (batch.transition !== undefined) {
    const transition = { ...batch.transition };
    if (transition.output !== undefined) transition.output = redact.payload(transition.output);
    if (transition.error !== undefined) transition.error = { code: transition.error.code, message: redact.text(transition.error.message) };
    out.transition = transition;
  }
  if (batch.learning !== undefined) out.learning = redactLearning(batch.learning, redact);
  return out;
}
