import { isJsonObject, type Json } from "../core/json.ts";
import type { Redactor } from "../core/redact.ts";
import type { LearningKind, LearningStatus } from "../store/types.ts";
import { ITEM_LIMITS, parseItemFile, parseItemPath, readProposal, type ProposalEntry } from "./proposal.ts";
import { findHiddenCharacters, formatCodePoint, scanForSecrets } from "./secret-scan.ts";

/** An item that passed the code checks. */
export interface CandidateItem { path: string; kind: LearningKind; name: string; title: string; description: string; body: string }
export interface CheckOptions {
  redactor?: Redactor;
  maxNotes: number;
  maxSkills: number;
  /** Current status of the agent's existing items by path (`notes/x.md`); a retired path cannot be proposed again. */
  existing?: Readonly<Record<string, LearningStatus>>;
}
export interface CheckResult {
  /** Why the whole proposal was dropped, or null. Never contains the offending text. */
  dropAll: string | null;
  jobFinished: boolean;
  items: CandidateItem[];
  dropped: { path: string; reason: string }[];
}

function describePath(path: unknown, index: number): string {
  return typeof path === "string" && path.length > 0 ? path : `files[${index}]`;
}

/**
 * Every string of an entry, object keys included, at any depth, with where it is: `files[i].path` or
 * `files[i].content` for those two fields when they are strings, otherwise `files[i]` (a key is never named, since
 * it may be the offending text).
 */
function entryStrings(file: ProposalEntry): { text: string; where: string }[] {
  const out: { text: string; where: string }[] = [];
  const whole = `files[${file.index}]`;
  const stack: Json[] = [file.entry];
  while (stack.length > 0) {
    const value = stack.pop() as Json;
    if (typeof value === "string") out.push({ text: value, where: whole });
    else if (Array.isArray(value)) {
      for (const inner of value) stack.push(inner);
    }
    else if (isJsonObject(value)) {
      for (const [key, inner] of Object.entries(value)) {
        out.push({ text: key, where: whole });
        if (value === file.entry && (key === "path" || key === "content") && typeof inner === "string") {
          out.push({ text: inner, where: `${whole}.${key}` });
        } else {
          stack.push(inner);
        }
      }
    }
  }
  return out;
}

/** Any secret or hidden character in any string of any entry, whatever its shape, drops the whole proposal. */
function wholeProposalProblem(files: readonly ProposalEntry[], redactor: Redactor | undefined): string | null {
  for (const file of files) {
    for (const { text, where } of entryStrings(file)) {
      const secret = scanForSecrets(text, redactor);
      if (secret !== null) return `${secret} was found in ${where}`;
      const hidden = findHiddenCharacters(text);
      if (hidden.length > 0) return `a hidden or bidirectional-control character (${hidden.map(formatCodePoint).join(", ")}) was found in ${where}`;
    }
  }
  return null;
}

/** The entry's path and content when it has the shape {path: string, content: string}; else why not (never quoting it). */
function entryShape(file: ProposalEntry): { path: string; content: string } | { problem: string } {
  if (!isJsonObject(file.entry)) return { problem: "the entry is not an object {path, content}" };
  if (Object.keys(file.entry).some((key) => key !== "path" && key !== "content")) return { problem: "the entry has a key other than path and content" };
  if (typeof file.path !== "string" || typeof file.content !== "string") return { problem: "a file needs a string path and a string content" };
  return { path: file.path, content: file.content };
}

/**
 * The code checks of a learning proposal (plan 3.12): first the whole-proposal checks (secrets, hidden
 * characters, over every entry whatever its shape), then the per-entry rules, where a failing entry is dropped
 * alone: past the first ITEM_LIMITS.filesPerProposal entries, not an object, an extra key, a path or content that is
 * not a string, then the item rules. Pure.
 */
export function checkProposal(proposal: Json, options: CheckOptions): CheckResult {
  const read = readProposal(proposal);
  if (read === null) return { dropAll: "the proposal does not have the shape {job_finished, files}", jobFinished: false, items: [], dropped: [] };
  const whole = wholeProposalProblem(read.files, options.redactor);
  if (whole !== null) return { dropAll: whole, jobFinished: read.jobFinished, items: [], dropped: [] };

  const items: CandidateItem[] = [];
  const dropped: { path: string; reason: string }[] = [];
  const seen = new Set<string>();
  const counts: Record<LearningKind, number> = { note: 0, skill: 0 };
  for (const file of read.files) {
    const label = describePath(file.path, file.index);
    const drop = (reason: string): void => {
      dropped.push({ path: label, reason });
    };
    if (file.index >= ITEM_LIMITS.filesPerProposal) {
      drop(`over the limit of ${ITEM_LIMITS.filesPerProposal} files per proposal`);
      continue;
    }
    const shape = entryShape(file);
    if ("problem" in shape) {
      drop(shape.problem);
      continue;
    }
    const path = parseItemPath(shape.path);
    if (!path.ok) {
      drop(path.reason);
      continue;
    }
    if (seen.has(path.path)) {
      drop("duplicate of an earlier path in this proposal");
      continue;
    }
    seen.add(path.path);
    const parsed = parseItemFile(shape.content);
    if (!parsed.ok) {
      drop(parsed.reason);
      continue;
    }
    const reason = itemRuleProblem(path.kind, parsed, read.jobFinished);
    if (reason !== null) {
      drop(reason);
      continue;
    }
    if (options.existing !== undefined && Object.hasOwn(options.existing, path.path) && options.existing[path.path] === "retired") {
      drop("a person retired this item; it is not proposed again");
      continue;
    }
    const limit = path.kind === "note" ? options.maxNotes : options.maxSkills;
    if (counts[path.kind] >= limit) {
      drop(`over the limit of ${limit} ${path.kind}s per run`);
      continue;
    }
    counts[path.kind] += 1;
    items.push({ path: path.path, kind: path.kind, name: path.name, title: parsed.title, description: parsed.description, body: parsed.body });
  }
  return { dropAll: null, jobFinished: read.jobFinished, items, dropped };
}

function itemRuleProblem(kind: LearningKind, parsed: { title: string; description: string; body: string }, jobFinished: boolean): string | null {
  if (parsed.title.length === 0) return "the title is empty";
  if (parsed.title.includes("\n")) return "the title must be one line";
  if ([...parsed.title].length > ITEM_LIMITS.titleChars) return `the title is over ${ITEM_LIMITS.titleChars} characters`;
  if (parsed.description.length === 0) return "the description is empty";
  if (parsed.description.includes("\n")) return "the description must be one line";
  if ([...parsed.description].length > ITEM_LIMITS.descriptionChars) return `the description is over ${ITEM_LIMITS.descriptionChars} characters`;
  if (parsed.body.trim().length === 0) return "the body is empty";
  const maxBytes = kind === "note" ? ITEM_LIMITS.noteBodyBytes : ITEM_LIMITS.skillBodyBytes;
  if (Buffer.byteLength(parsed.body, "utf8") > maxBytes) return `the body is over ${maxBytes} bytes`;
  if (kind === "skill" && !jobFinished) return "a skill can only be written by a run that finished its job (job_finished is false)";
  return null;
}
