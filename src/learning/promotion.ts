import { canonicalJson, isJsonObject, type Json } from "../core/json.ts";
import type { Redactor } from "../core/redact.ts";
import type { JsonSchema } from "../schema/validate.ts";
import type { LearningItem } from "../store/types.ts";
import { dryRunWorkflow } from "../workflow/dryrun.ts";
import { WORKFLOW_FORMAT, type WorkflowDocument } from "../workflow/types.ts";
import { validateWorkflow } from "../workflow/validate.ts";
import { renderItem } from "./proposal.ts";
import { scanForSecrets } from "./secret-scan.ts";

const MAX_PROMOTION_ATTEMPTS = 2;
const NAME_PART_CHARS = 30;
const ID_PART_CHARS = 26;

export const DRAFT_SCHEMA: JsonSchema = {
  type: "object",
  required: ["document"],
  properties: { document: { type: "object" } },
};

export interface CatalogueTool { name: string; description: string; parameters: JsonSchema; retrySafe: boolean }

/** First active skill with no workflow yet, fewer than 2 attempts, that has served enough completed runs. Pure. */
export function pickPromotionCandidate(
  items: readonly LearningItem[], serveCounts: Readonly<Record<string, number>>, promoteAfterRuns: number,
): LearningItem | null {
  for (const item of items) {
    if (item.kind !== "skill" || item.status !== "active" || item.promotedWorkflow !== null) continue;
    if (item.promotionAttempts >= MAX_PROMOTION_ATTEMPTS) continue;
    if ((serveCounts[item.id] ?? 0) >= promoteAfterRuns) return item;
  }
  return null;
}

/**
 * The saved-workflow name of a skill's promotion: "skill-" + the first 30 characters of the skill name (trailing
 * hyphens removed) + "-" + the item id without its "li_" prefix, lower-cased, letters and digits only, last 26
 * characters. At most 63 characters, matches ^[a-z][a-z0-9_-]{0,63}$, and differs for any two items.
 */
export function promotedWorkflowName(item: { id: string; name: string }): string {
  const namePart = item.name.slice(0, NAME_PART_CHARS).replace(/-+$/, "");
  const idPart = item.id.replace(/^li_/, "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(-ID_PART_CHARS);
  return ["skill", namePart, idPart].filter((part) => part !== "").join("-");
}

const FORMAT_SUMMARY = [
  `A workflow is a JSON document: {"format": "${WORKFLOW_FORMAT}", "name", "description"?, "schemas": {<Name>: JSON Schema},`,
  `"input": <schema name>, "output": <schema name>, "root": <node>, "result": <expression>}.`,
  "Every node has a unique id matching ^[a-z][a-z0-9_]{0,63}$ and a kind:",
  "- tool {tool, args: {name: expression}, idempotent?, onError?: \"fail\"|\"continue\"} → {ok, content, data}",
  "- model {prompt (template), system?, output: <schema name>} → the typed object",
  "- decide {question, decision: {type: \"yes_no\"}|{type: \"pick_one\", options}|{type: \"score\", min, max}, lowConfidence?: {below, run, value?}}",
  "- branch {on: expression, cases: [{when: literal, run: node}], default?: node}",
  "- sequence {steps: [node]} · parallel {branches: [node]}",
  "- map {over: expression, as: name, concurrency: 1..64, maxItems, run: node} · loop {maxIterations, until: condition, run: node}",
  "- call {workflow, input} · agent {message, maxTurns, instructions?, tools?, output?} · wait {question, choices?} · fail {message}",
  "References: {\"$ref\": \"input.x\"} or {\"$ref\": \"steps.<nodeId>.content\"} keep the value's type; in strings use {{input.x}}.",
  "A node may only reference steps that ran before it in an enclosing sequence.",
].join("\n");

export function buildPromotionMessage(item: LearningItem, tools: readonly CatalogueTool[]): string {
  const toolLines = tools.length === 0
    ? "(this agent has no tools)"
    : tools.map((tool) => `- ${tool.name}: ${tool.description} Arguments schema: ${canonicalJson(tool.parameters as Json)}`).join("\n");
  return [
    "This skill has served several successful runs. Write it as a deterministic workflow document so later runs can",
    `follow it without an open-ended loop. It will be saved as the workflow "${promotedWorkflowName(item)}".`,
    "",
    "Skill:",
    renderItem(item),
    "",
    "Tools the agent may use:",
    toolLines,
    "",
    "Workflow format:",
    FORMAT_SUMMARY,
    "",
    "Reply with {document: <the workflow document>}.",
  ].join("\n");
}

export type DraftCheck = { ok: true; document: WorkflowDocument } | { ok: false; problems: string[] };

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** `path` extended by an object key, as `.key` or `["key"]`. */
function memberPath(path: string, key: string): string {
  return IDENTIFIER.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

/**
 * The first secret in any string or object key of `value`, in document order: where it is (for a key, the object
 * that holds it, since the key may be the secret) and the scan's label, never the text. Iterative, so a deep
 * document cannot exhaust the stack.
 */
function firstSecret(value: Json, root: string, redactor: Redactor | undefined): { path: string; label: string } | null {
  const stack: { value: Json; path: string }[] = [{ value, path: root }];
  while (stack.length > 0) {
    const { value: current, path } = stack.pop() as { value: Json; path: string };
    if (typeof current === "string") {
      const label = scanForSecrets(current, redactor);
      if (label !== null) return { path, label };
    } else if (Array.isArray(current)) {
      for (let i = current.length - 1; i >= 0; i -= 1) stack.push({ value: current[i] as Json, path: `${path}[${i}]` });
    } else if (isJsonObject(current)) {
      const entries = Object.entries(current);
      for (const [key] of entries) {
        const label = scanForSecrets(key, redactor);
        if (label !== null) return { path, label };
      }
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const [key, inner] = entries[i] as [string, Json];
        stack.push({ value: inner, path: memberPath(path, key) });
      }
    }
  }
  return null;
}

/**
 * A draft is kept only if it holds no secret, validates with no error and its dry run is ok. A secret is anything
 * `scanForSecrets` finds in any string or object key of the document (a redaction marker of any form, a value the
 * run's `redactor` knows, a credential-shaped string): the draft the check sees is the model step's stored, already
 * redacted output, so a marker there is the trace of a secret, and a workflow saved from it would hand that text to
 * every later run. Warnings (among them the dry run's
 * `placeholder_dependent` problems about values it made up) never reject a draft. A draft rejected by its dry run
 * lists the dry run's errors, or, when there is none, the last step note. The document's name is set to the name
 * it will be saved under, and both the validation and the dry run judge it under that name (`savedAs`), so a `call`
 * of that name is the draft itself. Pure.
 */
export function checkDraft(
  draft: Json,
  options: { name: string; tools: readonly CatalogueTool[]; resolveWorkflow: (name: string) => WorkflowDocument | null; redactor?: Redactor },
): DraftCheck {
  if (!isJsonObject(draft) || !isJsonObject(draft["document"])) return { ok: false, problems: ["$: the draft has no document object"] };
  const secret = firstSecret(draft["document"], "$.document", options.redactor);
  if (secret !== null) return { ok: false, problems: [`${secret.path}: ${secret.label} was found; a draft holding a secret is not kept`] };
  const document = { ...draft["document"], name: options.name };
  const validation = validateWorkflow(document, { tools: options.tools, resolveWorkflow: options.resolveWorkflow, savedAs: options.name });
  const errors = validation.problems.filter((p) => p.severity === "error");
  if (!validation.ok || errors.length > 0) {
    return { ok: false, problems: errors.map((p) => `${p.path}: ${p.message} (${p.code})`) };
  }
  const typed = document as unknown as WorkflowDocument;
  const report = dryRunWorkflow(typed, { resolveWorkflow: options.resolveWorkflow, savedAs: options.name });
  if (!report.ok) {
    const problems = report.problems.filter((p) => p.severity === "error").map((p) => `dry run ${p.path}: ${p.message} (${p.code})`);
    if (problems.length === 0) {
      const last = [...report.steps].reverse().find((s) => s.note !== null);
      problems.push(last === undefined ? "the dry run did not succeed" : `dry run ${last.path}: ${last.note as string}`);
    }
    return { ok: false, problems };
  }
  return { ok: true, document: typed };
}
