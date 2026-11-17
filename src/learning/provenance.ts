import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { isJsonObject, type Json } from "../core/json.ts";
import { openRegularFile, type OpenedRegularFile } from "../core/regular-file.ts";
import type { JournalRecord } from "../store/types.ts";
import { words } from "./words.ts";

export type Verdict = "keep" | "hold" | "drop";
/**
 * Which text of an item an assessment looked at; "whole" is title, description and body joined by a line break.
 * "evidence": the item was not compared against everything it had to be, because a saved file of an untrusted
 * result (the full text of a truncated one, or its over-long structured data) could not be verified.
 * "origin": the run read untrusted content and the journal does not show that one of the item's texts is the
 * run's own earlier text or a person's (rule T).
 */
export type ProvenanceField = "name" | "title" | "description" | "body" | "whole" | "evidence" | "origin";
export interface ProvenanceVerdict {
  path: string;
  verdict: Verdict;
  /** The assessment that decided the verdict (for "keep": "whole"; for an unproven origin: "origin"). */
  field: ProvenanceField;
  /** Of the deciding assessment: share of its distinct 5-word shingles found in untrusted tool output, 0..1 (1 for a short phrase found whole). */
  overlap: number;
  /** Of the deciding assessment: true when 12 or more consecutive words appear verbatim in untrusted output. */
  verbatimRun: boolean;
  reason: string;
}
/** The texts of an item that are retained and shown to later runs. */
export interface ProvenanceItem { path: string; name: string; title: string; description: string; body: string }

/** Words per shingle; a text of at least this many words is compared by shingles. */
const SHINGLE_WORDS = 5;
/** A verbatim run of this many words holds a body (and a whole). */
const VERBATIM_RUN_WORDS = 12;
/** Shingle overlap at or above which any text is dropped. */
const DROP_OVERLAP = 0.5;
/** Shingle overlap at or above which a body (and a whole) is held. Title, description and name are held at any overlap. */
const HOLD_OVERLAP = 0.2;
/** A short title, description or name of at least this many words is held when found whole; one word is not assessed. */
const SHORT_FIELD_MIN_WORDS = 2;

const RANK: Readonly<Record<Verdict, number>> = { keep: 0, hold: 1, drop: 2 };
const FIELD_LABEL: Readonly<Record<ProvenanceField, string>> = {
  body: "the body", description: "the description", title: "the title", name: "the name", whole: "the text",
  evidence: "the evidence", origin: "the origin",
};
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The words of a text by the one tokeniser of learning (`words`, `src/learning/words.ts`). */
export function normalizeWords(text: string): string[] {
  return words(text);
}

/**
 * The character form of a text: every run of white space replaced by one space, then trimmed. A text with no
 * words (`normalizeWords` finds none) is compared in this form; an empty result is the only trivially fine text.
 */
export function collapseSpace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** True when `needle` (in character form, not empty) occurs in one of `texts` (each in character form). */
export function charactersFound(texts: readonly string[], needle: string): boolean {
  return texts.some((text) => text.includes(needle));
}

function grams(words: readonly string[], size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i + size <= words.length; i++) out.push(words.slice(i, i + size).join(" "));
  return out;
}

/** Why a saved file of an untrusted result (full text or structured data) does not count as evidence. */
type Unverifiable =
  | "no digest was journalled" | "no saved file was journalled" | "outside the workspace"
  | "missing" | "not a regular file" | "changed";
interface UnverifiedResult { path: string; why: Unverifiable }

/** Objects deeper than this are not walked by structuredTexts (journalled JSON is never this deep). */
const MAX_DATA_DEPTH = 64;

function errorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** Reads exactly `bytes` bytes from the start of the file; null when the file holds fewer or more. */
async function readExactly(handle: FileHandle, bytes: number): Promise<Buffer | null> {
  const buffer = Buffer.alloc(bytes + 1);
  let filled = 0;
  while (filled < buffer.length) {
    const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return filled === bytes ? buffer.subarray(0, bytes) : null;
}

/**
 * Verifies a file the engine saved for an over-long result against the digest journalled with it: the path stays
 * inside the workspace, the file is opened once without following a symbolic link and without blocking on a FIFO
 * (`openRegularFile`), is a regular file of exactly `bytes` bytes (checked on the handle before reading) and its
 * SHA-256 is `digest`.
 * Never throws: an unexpected file-system error counts as "missing".
 */
async function verifySavedFile(workspace: string, path: unknown, digest: unknown, bytes: unknown): Promise<{ text: string } | UnverifiedResult> {
  if (typeof path !== "string") return { path: "(no path)", why: "no saved file was journalled" };
  const target = resolve(workspace, path);
  const rel = relative(workspace, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return { path, why: "outside the workspace" };
  if (typeof digest !== "string" || !SHA256_HEX.test(digest) || typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) {
    return { path, why: "no digest was journalled" };
  }
  let opened: OpenedRegularFile | null;
  try {
    opened = await openRegularFile(target);
  } catch (error) {
    return { path, why: errorCode(error) === "ELOOP" ? "not a regular file" : "missing" };
  }
  if (opened === null) return { path, why: "not a regular file" };
  const { handle } = opened;
  try {
    if (opened.size !== bytes) return { path, why: "changed" };
    const content = await readExactly(handle, bytes);
    if (content === null || createHash("sha256").update(content).digest("hex") !== digest) return { path, why: "changed" };
    return { text: content.toString("utf8") };
  } catch {
    return { path, why: "missing" };
  } finally {
    // Only the bytes read matter; a failed close of a read-only handle changes no verdict.
    await handle.close().catch(() => undefined);
  }
}

/**
 * The texts a structured value contributes to the untrusted corpus. null → []. A string → [it]. Otherwise, in
 * document order (array order; object keys in the order Object.keys gives): (1) every non-empty string leaf on
 * its own; (2) all string leaves joined by "\n"; (3) every object key and every scalar leaf (a string as it is,
 * a number or boolean as its JSON text, null left out), each key before its value, joined by "\n". Decoded
 * values, never JSON text. Duplicates are removed (and so is an empty text). Values nested deeper than 64 levels
 * are not walked.
 */
export function structuredTexts(data: Json): string[] {
  if (data === null) return [];
  if (typeof data === "string") return [data];
  const strings: string[] = [];
  const tokens: string[] = [];
  const walk = (value: Json, depth: number): void => {
    if (value === null) return;
    if (typeof value === "string") {
      strings.push(value);
      tokens.push(value);
      return;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      tokens.push(JSON.stringify(value));
      return;
    }
    if (depth >= MAX_DATA_DEPTH) return;
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry, depth + 1);
      return;
    }
    for (const key of Object.keys(value)) {
      tokens.push(key);
      walk(value[key] as Json, depth + 1);
    }
  };
  walk(data, 0);
  const texts = [...strings, strings.join("\n"), tokens.join("\n")];
  return [...new Set(texts.filter((text) => text !== ""))];
}

/** The parsed JSON of a saved data file, or its text as one string when it does not parse. */
function savedDataTexts(text: string): string[] {
  let value: Json;
  try {
    value = JSON.parse(text) as Json;
  } catch {
    return [text];
  }
  return structuredTexts(value);
}

/**
 * The texts every item is compared against, the saved files whose evidence could not be checked, and the taint
 * point (rule T): the smallest `seq` of an untrusted `tool.finished` or of a webhook `run.created`, whether or not
 * it contributed any text; null when there is none. The corpus is:
 * - for every `tool.finished` marked untrusted: its journalled content (also when it was cut); `structuredTexts` of
 *   its journalled structured `data`; when it is truncated, the saved full text at `fullResultPath`, but only when
 *   that file matches `fullResultSha256` / `fullResultBytes`; when `fullDataPath` is a string, the saved structured
 *   data (parsed as JSON and passed through `structuredTexts`; text that does not parse counts as one string), but
 *   only when that file matches `fullDataSha256` / `fullDataBytes`;
 * - for every `run.created` whose trigger is a webhook: `structuredTexts` of the run's input `data` (the delivery's
 *   payload). Runs without a trigger, or started by cron or a manual fire, contribute nothing.
 * A saved file (full text or data) that cannot be verified is listed in `unverified` instead; the journalled
 * content and data of its record still count.
 */
async function untrustedCorpus(
  journal: readonly JournalRecord[], workspace: string,
): Promise<{ texts: string[]; unverified: UnverifiedResult[]; taintPoint: number | null }> {
  const texts: string[] = [];
  const unverified: UnverifiedResult[] = [];
  let taintPoint: number | null = null;
  const taint = (seq: number): void => {
    if (taintPoint === null || seq < taintPoint) taintPoint = seq;
  };
  for (const record of journal) {
    const d = record.data;
    if (record.type === "run.created") {
      const trigger = d["trigger"];
      if (!isJsonObject(trigger) || trigger["kind"] !== "webhook") continue;
      taint(record.seq);
      const input = d["input"];
      if (isJsonObject(input)) for (const text of structuredTexts(input["data"] ?? null)) texts.push(text);
      continue;
    }
    if (record.type !== "tool.finished" || d["untrusted"] !== true) continue;
    taint(record.seq);
    texts.push(typeof d["content"] === "string" ? d["content"] : "");
    for (const text of structuredTexts(d["data"] ?? null)) texts.push(text);
    if (d["truncated"] === true) {
      const saved = await verifySavedFile(workspace, d["fullResultPath"], d["fullResultSha256"], d["fullResultBytes"]);
      if ("text" in saved) texts.push(saved.text);
      else unverified.push(saved);
    }
    if (typeof d["fullDataPath"] === "string") {
      const saved = await verifySavedFile(workspace, d["fullDataPath"], d["fullDataSha256"], d["fullDataBytes"]);
      if ("text" in saved) for (const text of savedDataTexts(saved.text)) texts.push(text);
      else unverified.push(saved);
    }
  }
  return { texts, unverified, taintPoint };
}

/**
 * Rule T's trusted texts, as they were journalled: `structuredTexts` of every record journalled before the taint
 * point, and, at any point, of the data of every `command.applied` record and of the resolution of every
 * `pending.resolved` record that carries a `commandId` (what a person sent).
 */
function trustedSources(journal: readonly JournalRecord[], taintPoint: number): string[] {
  const out: string[] = [];
  const add = (data: Json): void => {
    for (const text of structuredTexts(data)) out.push(text);
  };
  for (const record of journal) {
    if (record.seq < taintPoint) add(record.data);
    else if (record.type === "command.applied") add(record.data);
    else if (record.type === "pending.resolved" && typeof record.data["commandId"] === "string") add(record.data["resolution"] ?? null);
  }
  return out;
}

/** Computes `build()` once, on first use. */
function lazy<T>(build: () => T): () => T {
  let value: { built: T } | null = null;
  return () => {
    if (value === null) value = { built: build() };
    return value.built;
  };
}

/**
 * A corpus in both forms: `lists`, the words of every text that has words; `words`, the same as strings padded
 * with spaces; and `chars`, the character form of every text (`collapseSpace`, empty ones left out), built only
 * when a text without words is assessed.
 */
interface TextForms { lists: readonly (readonly string[])[]; words: readonly string[]; chars: () => readonly string[] }

function textForms(texts: readonly string[]): TextForms {
  const lists = texts.map(normalizeWords).filter((entry) => entry.length > 0);
  return {
    lists,
    words: lists.map((entry) => ` ${entry.join(" ")} `),
    chars: lazy(() => texts.map(collapseSpace).filter((text) => text !== "")),
  };
}

/**
 * A text is proven when it is empty after trimming, when its words are a contiguous run of whole words of one
 * trusted text, or, for a text without words, when its character form occurs in the character form of one
 * trusted text.
 */
function proven(trusted: TextForms, text: string): boolean {
  const found = normalizeWords(text);
  if (found.length === 0) {
    const needle = collapseSpace(text);
    return needle === "" || charactersFound(trusted.chars(), needle);
  }
  const needle = ` ${found.join(" ")} `;
  return trusted.words.some((candidate) => candidate.includes(needle));
}

interface Corpus { shingles: Set<string>; runs: Set<string>; joined: readonly string[]; chars: () => readonly string[]; trusted: TextForms }
interface Assessment { field: ProvenanceField; verdict: Verdict; overlap: number; verbatimRun: boolean }

function phraseFound(corpus: Corpus, words: readonly string[]): boolean {
  const needle = ` ${words.join(" ")} `;
  return corpus.joined.some((text) => text.includes(needle));
}

function shingleOverlap(corpus: Corpus, words: readonly string[]): number {
  const own = new Set(grams(words, SHINGLE_WORDS));
  let matched = 0;
  for (const gram of own) if (corpus.shingles.has(gram)) matched++;
  return matched / own.size;
}

/**
 * A text without words, judged on its characters: copied (its character form occurs in an untrusted text) and not
 * proven (it does not occur in a trusted one) → drop, the verdict of a short body found whole. Otherwise keep here;
 * rule T's proof then applies to it as to any text found nowhere in untrusted output.
 */
function assessWordless(corpus: Corpus, field: ProvenanceField, text: string): Assessment {
  const needle = collapseSpace(text);
  const copied = needle !== "" && charactersFound(corpus.chars(), needle) && !charactersFound(corpus.trusted.chars(), needle);
  return { field, verdict: copied ? "drop" : "keep", overlap: copied ? 1 : 0, verbatimRun: false };
}

/** body and whole: overlap >= 0.5 → drop; >= 0.2 or a 12-word verbatim run → hold. A short body found whole → drop. */
function assessLong(corpus: Corpus, field: "body" | "whole", text: string): Assessment {
  const words = normalizeWords(text);
  const none: Assessment = { field, verdict: "keep", overlap: 0, verbatimRun: false };
  if (words.length === 0) return assessWordless(corpus, field, text);
  if (words.length < SHINGLE_WORDS) {
    if (field === "whole" || !phraseFound(corpus, words)) return none;
    return { field, verdict: "drop", overlap: 1, verbatimRun: false };
  }
  const overlap = shingleOverlap(corpus, words);
  const verbatimRun = grams(words, VERBATIM_RUN_WORDS).some((gram) => corpus.runs.has(gram));
  const verdict: Verdict = overlap >= DROP_OVERLAP ? "drop" : overlap >= HOLD_OVERLAP || verbatimRun ? "hold" : "keep";
  return { field, verdict, overlap, verbatimRun };
}

/** title, description, name: overlap >= 0.5 → drop; any shared shingle → hold; 2 to 4 words found whole → hold. */
function assessShort(corpus: Corpus, field: "name" | "title" | "description", text: string): Assessment {
  const words = normalizeWords(text);
  if (words.length === 0) return assessWordless(corpus, field, text);
  if (words.length < SHORT_FIELD_MIN_WORDS) return { field, verdict: "keep", overlap: 0, verbatimRun: false };
  if (words.length < SHINGLE_WORDS) {
    const found = phraseFound(corpus, words);
    return { field, verdict: found ? "hold" : "keep", overlap: found ? 1 : 0, verbatimRun: false };
  }
  const overlap = shingleOverlap(corpus, words);
  const verdict: Verdict = overlap >= DROP_OVERLAP ? "drop" : overlap > 0 ? "hold" : "keep";
  return { field, verdict, overlap, verbatimRun: false };
}

function reasonFor(decided: Assessment): string {
  const label = FIELD_LABEL[decided.field];
  const percent = `${Math.round(decided.overlap * 100)}%`;
  if (decided.verdict === "drop") return `untrusted_origin: ${percent} of ${label} comes from untrusted tool output`;
  if (decided.field === "body" || decided.field === "whole") {
    const why = decided.verbatimRun ? `a run of ${VERBATIM_RUN_WORDS}+ words is copied` : `${percent} of ${label}`;
    return `${label} is partly from untrusted tool output (${why}); a person decides`;
  }
  return `${label} is copied from untrusted tool output; a person decides`;
}

const UNTAINTED_KEEP = "no overlap with untrusted tool output";
const PROVEN_KEEP = "every text of the item is in the run's trusted material";
/** Rule T: the order in which an item's texts are checked for proof; the first unproven one is named. */
const PROOF_ORDER = ["body", "description", "title", "name"] as const;

/**
 * Decides from the journal, not from the model, whether an item's retained texts came from untrusted tool output.
 *
 * The run is *tainted* once its journal holds an untrusted record: a `tool.finished` marked untrusted (whatever its
 * content, even empty or an error), or the `run.created` of a run started by a webhook. The taint point is the
 * `seq` of the first such record. A run that is not tainted keeps every item (reason "no overlap with untrusted
 * tool output").
 *
 * In a tainted run, first the lexical checks against the untrusted corpus: every text of external origin the run
 * journalled (for every `tool.finished` marked untrusted, its journalled content (also when it was cut) and
 * `structuredTexts` of its structured data; the saved full text of a cut one and the saved structured data of one
 * whose data was over the size limit, each only when the file's bytes match the SHA-256 and length journalled with
 * it; and, for a run started by a webhook, `structuredTexts` of the run's input data, from `run.created`). Each
 * text is normalised to words (`words`, `src/learning/words.ts`; the name's hyphens are word breaks) and assessed
 * on its own:
 * - body: 5+ words: shingle overlap >= 0.5 → drop; >= 0.2 or a verbatim run of 12+ words → hold. Fewer than 5
 *   words: found verbatim as whole words → drop.
 * - title, description, name: 5+ words: overlap >= 0.5 → drop; any shared 5-word shingle → hold. 2 to 4 words:
 *   found verbatim as whole words → hold. 1 word: not assessed.
 * - whole (title, description and body joined by a line break): the body rule for 5+ words, which catches text
 *   split across fields.
 * - A text with no words (only symbols, punctuation and white space; not empty after trimming), whatever its
 *   field: judged on its characters (`collapseSpace`: white space collapsed to one space, trimmed). It is
 *   *copied* when that form occurs in the same form of an untrusted text and *proven* when it occurs in a trusted
 *   one; copied and not proven → drop (as a short body found whole). Otherwise it passes the lexical checks and
 *   the proof below applies to it as to words found nowhere. A text with words is judged by its words only, even
 *   when it also holds long runs of symbols. A text that is empty after trimming is trivially fine.
 * The strictest verdict wins (drop > hold > keep; ties in the order body, description, title, name, whole), and
 * `field`, `overlap` and `verbatimRun` are those of the deciding assessment.
 *
 * An item that passes the lexical checks is then:
 * - held with `field: "evidence"` and overlap 0 when a saved file of at least one untrusted result (its full text or
 *   its structured data) cannot be verified (no digest journalled, no path, outside the workspace, missing, not a
 *   regular file, changed);
 * - otherwise held with `field: "origin"` unless the journal proves where its text came from: its body,
 *   description, title and name must each occur, as a run of whole words (a text without words: in character
 *   form), in one trusted text (`trustedSources`: every text journalled before the taint point, and what a person
 *   sent at any point). The reason names the first
 *   unproven field in the order body, description, title, name;
 * - otherwise kept (`field: "whole"`).
 * File-system errors never escape.
 */
export async function assessProvenance(
  items: readonly ProvenanceItem[], journal: readonly JournalRecord[], workspace: string,
): Promise<ProvenanceVerdict[]> {
  const found = await untrustedCorpus(journal, workspace);
  const taintPoint = found.taintPoint;
  if (taintPoint === null) {
    return items.map((item) => ({ path: item.path, verdict: "keep", field: "whole", overlap: 0, verbatimRun: false, reason: UNTAINTED_KEEP }));
  }
  const untrusted = textForms(found.texts);
  const trusted = textForms(trustedSources(journal, taintPoint));
  const corpus: Corpus = { shingles: new Set(), runs: new Set(), joined: untrusted.words, chars: untrusted.chars, trusted };
  for (const entry of untrusted.lists) {
    for (const gram of grams(entry, SHINGLE_WORDS)) corpus.shingles.add(gram);
    for (const gram of grams(entry, VERBATIM_RUN_WORDS)) corpus.runs.add(gram);
  }
  const first = found.unverified[0];
  const n = found.unverified.length;
  const evidenceReason = first === undefined
    ? null
    : `the saved full text of ${n} truncated untrusted result${n === 1 ? "" : "s"} is missing or was changed (${first.path}: ${first.why}); a person decides`;

  return items.map((item): ProvenanceVerdict => {
    // In tie order: an equally strict earlier assessment decides.
    const assessments: Assessment[] = [
      assessLong(corpus, "body", item.body),
      assessShort(corpus, "description", item.description),
      assessShort(corpus, "title", item.title),
      assessShort(corpus, "name", item.name),
      assessLong(corpus, "whole", [item.title, item.description, item.body].join("\n")),
    ];
    let decided: Assessment | null = null;
    for (const assessment of assessments) {
      if (RANK[assessment.verdict] > RANK[decided?.verdict ?? "keep"]) decided = assessment;
    }
    if (decided !== null) {
      return { path: item.path, verdict: decided.verdict, field: decided.field, overlap: decided.overlap, verbatimRun: decided.verbatimRun, reason: reasonFor(decided) };
    }
    if (evidenceReason !== null) {
      return { path: item.path, verdict: "hold", field: "evidence", overlap: 0, verbatimRun: false, reason: evidenceReason };
    }
    const unproven = PROOF_ORDER.find((field) => !proven(trusted, item[field]));
    if (unproven !== undefined) {
      return {
        path: item.path, verdict: "hold", field: "origin", overlap: 0, verbatimRun: false,
        reason: `the run read untrusted content and the journal does not show that ${FIELD_LABEL[unproven]} is the run's own earlier text or a person's; a person decides`,
      };
    }
    const whole = assessments[assessments.length - 1] as Assessment;
    return { path: item.path, verdict: "keep", field: "whole", overlap: whole.overlap, verbatimRun: whole.verbatimRun, reason: PROVEN_KEEP };
  });
}
