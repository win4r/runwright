import type { Redactor } from "../core/redact.ts";
import { REDACTED_MARKER, SECRET_NAME_PATTERN } from "../security/secrets.ts";

/** Patterns of credential-shaped strings. A finding reports the label only, never the matched text. */
const SECRET_PATTERNS: readonly { label: string; pattern: RegExp }[] = Object.freeze([
  { label: "an Anthropic-style API key (sk-ant-…)", pattern: /sk-ant-[A-Za-z0-9_-]{16,}/ },
  { label: "an API key (sk-…)", pattern: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/ },
  { label: "an AWS access key id (AKIA…)", pattern: /(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Z0-9])/ },
  { label: "a GitHub token (ghp_…)", pattern: /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}/ },
  { label: "a GitHub token (github_pat_…)", pattern: /github_pat_[A-Za-z0-9_]{20,}/ },
  { label: "a Slack token (xox…-)", pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { label: "a private key block", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { label: "a bearer token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i },
  { label: "a JWT", pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
]);

/**
 * Every marker a redactor in Runwright writes in place of a secret: the process-wide set's `[redacted]`
 * (REDACTED_MARKER, also what a provider error text gets in place of its key) and the run's redactor's
 * `[redacted:NAME]` (`createGrowingRedactor` in `src/core/redact.ts`), whatever characters NAME has (up to 128,
 * on one line). Text that is checked has usually been
 * stored already, so a marker is the trace of a secret that was there: it is itself a finding. Anchored on the
 * literal brackets, no nested repetition, so the scan is linear in the text.
 */
const MARKER_WORD = REDACTED_MARKER.slice(1, -1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const REDACTION_MARKER = new RegExp(`\\[${MARKER_WORD}(?::([^\\]\\r\\n]{1,128}))?\\]`);

/**
 * The finding for a marker in `text`, or null. The name inside a marker is model text like the rest, so it is
 * quoted only when it is a secret name (SECRET_NAME_PATTERN) and not itself credential-shaped; any other named
 * marker is reported as "a redacted secret".
 */
function markerFinding(text: string): string | null {
  const marker = REDACTION_MARKER.exec(text);
  if (marker === null) return null;
  const name = marker[1];
  if (name === undefined || !SECRET_NAME_PATTERN.test(name) || SECRET_PATTERNS.some(({ pattern }) => pattern.test(name))) {
    return "a redacted secret";
  }
  return `the handed secret ${name}`;
}

/**
 * The label of the first secret found in `text`, or null. Checks for a redaction marker (any form a redactor
 * writes), then the secrets handed to the run (raw or in an encoded form the redactor knows), then the
 * credential patterns.
 */
export function scanForSecrets(text: string, redactor?: Redactor): string | null {
  const marker = markerFinding(text);
  if (marker !== null) return marker;
  if (redactor !== undefined && redactor.contains(text)) {
    return markerFinding(redactor.text(text)) ?? "a secret handed to this run";
  }
  for (const { label, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) return label;
  }
  return null;
}

/**
 * Hidden by itself: a control character (C0, DEL, C1) other than tab, line feed and carriage return; the line and
 * paragraph separators; a bidirectional control; a default-ignorable code point (zero-width characters, joiners,
 * invisible operators, BOM, soft hyphen, Hangul fillers, variation selectors, tag characters, …); the
 * interlinear annotation controls U+FFF9–U+FFFB; and an unpaired surrogate (text that is not well-formed Unicode,
 * which the store could not keep as it was sent).
 */
const HIDDEN = /^(?:(?![\t\n\r])\p{Cc}|[\u2028\u2029\uFFF9-\uFFFB]|\p{Bidi_Control}|\p{Default_Ignorable_Code_Point}|\p{Cs})$/u;
const PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u;
const TEXT_SELECTOR = 0xfe0e;
const EMOJI_SELECTOR = 0xfe0f;

/**
 * Code points of hidden or bidirectional-control characters in `text`, distinct, in order of first occurrence.
 * Reported: a C0 or C1 control or DEL other than U+0009, U+000A and U+000D; U+2028 and U+2029; every code point
 * with the Unicode property Bidi_Control or Default_Ignorable_Code_Point; U+FFF9–U+FFFB; and an unpaired surrogate
 * (U+D800–U+DFFF not part of a pair). One exception:
 * U+FE0E or U+FE0F directly after a code point with the property Extended_Pictographic is not reported (it picks
 * text or emoji presentation, as in "⚠️"); a variation selector anywhere else is reported, a second one after an
 * allowed one included.
 */
export function findHiddenCharacters(text: string): number[] {
  const found: number[] = [];
  let previous = "";
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    const presentation = (code === TEXT_SELECTOR || code === EMOJI_SELECTOR) && PICTOGRAPHIC.test(previous);
    if (!presentation && HIDDEN.test(char) && !found.includes(code)) found.push(code);
    previous = char;
  }
  return found;
}

export function formatCodePoint(code: number): string {
  return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
}
