/**
 * Builds a sample string for a JSON Schema "pattern", for the placeholder generator.
 *
 * The sampler parses a subset of the pattern syntax, builds the shortest match it can (alternatives in order,
 * every quantifier at its minimum), lengthens it at a repeatable element when a minimum length asks for more,
 * and only ever returns a string that the compiled pattern accepts and whose length is within the bounds.
 */

const MAX_PATTERN_LENGTH = 1000;
const MAX_SAMPLE_LENGTH = 4096;
const MAX_SHAPES = 256;
const MAX_INNER_SHAPES = 16;
const MAX_STEPS = 20_000;
const PAD = "x";

class Unsupported extends Error {}

/** The work one call may do while building shapes; spending it all gives up. */
interface Budget { steps: number }

function spend(budget: Budget): void {
  if (--budget.steps < 0) throw new Unsupported();
}

type ClassEscape = "d" | "w" | "s";

interface CharSet {
  negated: boolean;
  ranges: [number, number][];
  escapes: ClassEscape[];
}

type Atom =
  | { kind: "char"; text: string }
  | { kind: "set"; set: CharSet }
  | { kind: "group"; alt: Alternation }
  | { kind: "anchor" };

interface Term { atom: Atom; min: number; max: number }
type Sequence = Term[];
type Alternation = Sequence[];

type Piece = { fixed: string; length: number } | { unit: string; unitLength: number; extra: number };
type Shape = Piece[];

const SYNTAX = new Set(["^", "$", "\\", ".", "*", "+", "?", "(", ")", "[", "]", "{", "}", "|", "/"]);
const LINE_TERMINATORS: [number, number][] = [[0x0a, 0x0a], [0x0d, 0x0d], [0x2028, 0x2029]];
const SPACE_RANGES: [number, number][] = [
  [0x09, 0x0d], [0x20, 0x20], [0xa0, 0xa0], [0x1680, 0x1680], [0x2000, 0x200a], [0x2028, 0x2029],
  [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000], [0xfeff, 0xfeff],
];

function inRanges(cp: number, ranges: readonly [number, number][]): boolean {
  return ranges.some(([lo, hi]) => cp >= lo && cp <= hi);
}

function escapeContains(escape: ClassEscape, cp: number): boolean {
  switch (escape) {
    case "d": return cp >= 0x30 && cp <= 0x39;
    case "w": return (cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || cp === 0x5f;
    case "s": return inRanges(cp, SPACE_RANGES);
  }
}

function setContains(set: CharSet, cp: number): boolean {
  const member = inRanges(cp, set.ranges) || set.escapes.some((e) => escapeContains(e, cp));
  return set.negated ? !member : member;
}

const ESCAPE_FIRST: Record<ClassEscape, number> = { d: 0x30, w: 0x41, s: 0x09 };

/** Upper-case letter, lower-case letter, digit, then the first printable ASCII character, then the set's first member. */
function pickChar(set: CharSet): string | null {
  const preferred: [number, number][] = [[0x41, 0x5a], [0x61, 0x7a], [0x30, 0x39], [0x20, 0x7e]];
  for (const [lo, hi] of preferred) {
    for (let cp = lo; cp <= hi; cp++) if (setContains(set, cp)) return String.fromCodePoint(cp);
  }
  if (set.negated) return null;
  const firsts = [...set.ranges.map(([lo]) => lo), ...set.escapes.map((e) => ESCAPE_FIRST[e])];
  for (const cp of firsts) if (setContains(set, cp)) return String.fromCodePoint(cp);
  return null;
}

class Parser {
  private readonly cps: string[];
  private pos = 0;

  constructor(pattern: string) {
    this.cps = [...pattern];
  }

  parse(): Alternation {
    const alt = this.parseAlternation();
    if (this.pos < this.cps.length) throw new Unsupported();
    return alt;
  }

  private peek(offset = 0): string | undefined {
    return this.cps[this.pos + offset];
  }

  private next(): string {
    const c = this.cps[this.pos];
    if (c === undefined) throw new Unsupported();
    this.pos++;
    return c;
  }

  private parseAlternation(): Alternation {
    const alt: Alternation = [this.parseSequence()];
    while (this.peek() === "|") {
      this.pos++;
      alt.push(this.parseSequence());
    }
    return alt;
  }

  private parseSequence(): Sequence {
    const seq: Sequence = [];
    for (;;) {
      const c = this.peek();
      if (c === undefined || c === "|" || c === ")") return seq;
      seq.push(this.parseTerm());
    }
  }

  private parseTerm(): Term {
    const atom = this.parseAtom();
    let min = 1;
    let max = 1;
    const c = this.peek();
    if (c === "*" || c === "+" || c === "?") {
      this.pos++;
      min = c === "+" ? 1 : 0;
      max = c === "?" ? 1 : Infinity;
    } else if (c === "{") {
      this.pos++;
      min = this.parseNumber();
      max = min;
      if (this.peek() === ",") {
        this.pos++;
        max = this.peek() === "}" ? Infinity : this.parseNumber();
      }
      if (this.next() !== "}") throw new Unsupported();
    } else {
      return { atom, min, max };
    }
    if (atom.kind === "anchor" || max < min) throw new Unsupported();
    if (this.peek() === "?") this.pos++;
    return { atom, min, max };
  }

  private parseNumber(): number {
    let digits = "";
    while (/^[0-9]$/.test(this.peek() ?? "")) digits += this.next();
    if (digits === "") throw new Unsupported();
    return Number(digits);
  }

  private parseAtom(): Atom {
    const c = this.next();
    switch (c) {
      case "^":
      case "$":
        return { kind: "anchor" };
      case ".":
        return { kind: "set", set: { negated: true, ranges: LINE_TERMINATORS, escapes: [] } };
      case "(": {
        if (this.peek() === "?") {
          if (this.peek(1) !== ":") throw new Unsupported();
          this.pos += 2;
        }
        const alt = this.parseAlternation();
        if (this.next() !== ")") throw new Unsupported();
        return { kind: "group", alt };
      }
      case "[":
        return { kind: "set", set: this.parseClass() };
      case "\\": {
        const e = this.next();
        if (e === "d" || e === "w" || e === "s") return { kind: "set", set: { negated: false, ranges: [], escapes: [e] } };
        if (SYNTAX.has(e)) return { kind: "char", text: e };
        throw new Unsupported();
      }
      default:
        if (SYNTAX.has(c) && c !== "/") throw new Unsupported();
        return { kind: "char", text: c };
    }
  }

  private parseClass(): CharSet {
    const set: CharSet = { negated: false, ranges: [], escapes: [] };
    if (this.peek() === "^") {
      set.negated = true;
      this.pos++;
    }
    while (this.peek() !== "]") {
      const first = this.parseClassAtom();
      if (typeof first !== "number") {
        set.escapes.push(first);
        continue;
      }
      if (this.peek() === "-" && this.peek(1) !== "]" && this.peek(1) !== undefined) {
        this.pos++;
        const last = this.parseClassAtom();
        if (typeof last !== "number" || last < first) throw new Unsupported();
        set.ranges.push([first, last]);
      } else {
        set.ranges.push([first, first]);
      }
    }
    this.pos++;
    return set;
  }

  private parseClassAtom(): number | ClassEscape {
    const c = this.next();
    if (c !== "\\") return c.codePointAt(0) ?? 0;
    const e = this.next();
    if (e === "d" || e === "w" || e === "s") return e;
    if (SYNTAX.has(e) || e === "-") return e.codePointAt(0) ?? 0;
    throw new Unsupported();
  }
}

function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

function render(shape: Shape): string {
  let out = "";
  for (const piece of shape) if ("fixed" in piece) out += piece.fixed;
  return out;
}

function* termShapes(term: Term, budget: Budget): Generator<Shape> {
  spend(budget);
  const { atom } = term;
  if (atom.kind === "anchor") {
    yield [];
    return;
  }
  let units: Iterable<Shape>;
  if (atom.kind === "char") units = [[{ fixed: atom.text, length: 1 }]];
  else if (atom.kind === "set") {
    const c = pickChar(atom.set);
    if (c === null) return;
    units = [[{ fixed: c, length: 1 }]];
  } else units = alternationShapes(atom.alt, budget);
  let tried = 0;
  for (const unitShape of units) {
    if (++tried > MAX_INNER_SHAPES) return;
    if (term.min === 1 && term.max === 1) {
      yield unitShape;
      continue;
    }
    const unit = render(unitShape);
    const unitLength = codePoints(unit);
    if (unitLength * term.min > MAX_SAMPLE_LENGTH) continue;
    const shape: Shape = [{ fixed: unit.repeat(term.min), length: unitLength * term.min }];
    if (term.max > term.min && unitLength > 0) shape.push({ unit, unitLength, extra: term.max - term.min });
    yield shape;
  }
}

function* sequenceShapes(seq: Sequence, index: number, budget: Budget): Generator<Shape> {
  spend(budget);
  const term = seq[index];
  if (term === undefined) {
    yield [];
    return;
  }
  for (const head of termShapes(term, budget)) {
    for (const tail of sequenceShapes(seq, index + 1, budget)) yield [...head, ...tail];
  }
}

function* alternationShapes(alt: Alternation, budget: Budget): Generator<Shape> {
  for (const seq of alt) yield* sequenceShapes(seq, 0, budget);
}

/** Lengthens a shape at its repeatable elements, in order, until it reaches `min`; null when it cannot fit. */
function fill(shape: Shape, min: number, max: number): string | null {
  let length = 0;
  for (const piece of shape) if ("fixed" in piece) length += piece.length;
  if (length > max) return null;
  const counts = shape.map(() => 0);
  shape.forEach((piece, i) => {
    if ("fixed" in piece) return;
    let room = piece.extra;
    while (length < min && room > 0 && length + piece.unitLength <= max) {
      const wanted = Math.ceil((min - length) / piece.unitLength);
      const fits = Math.floor((max - length) / piece.unitLength);
      const add = Math.max(1, Math.min(wanted, fits, room));
      counts[i] = (counts[i] ?? 0) + add;
      length += add * piece.unitLength;
      room -= add;
    }
  });
  let out = "";
  shape.forEach((piece, i) => {
    out += "fixed" in piece ? piece.fixed : piece.unit.repeat(counts[i] ?? 0);
  });
  if (length < min) out += PAD.repeat(min - length);
  return out;
}

/**
 * A string that matches `pattern` (as the validator compiles it: new RegExp(pattern, "u")) and whose length in
 * code points is within the bounds, or null when this sampler cannot make one. It supports a documented subset
 * of the pattern syntax and returns null for everything else. Every string it returns has been tested against
 * the compiled pattern and the bounds.
 *
 * Supported pattern syntax:
 * - literal characters, and punctuation escaped with a backslash (`\.`, `\/`, `\\`, `\(` and the like, and `\-`
 *   inside brackets);
 * - `.` (any character except a line terminator);
 * - the classes `\d`, `\w` and `\s`, on their own and inside brackets;
 * - bracket classes `[...]` with single characters, ranges (`a-z`) and negation (`[^...]`);
 * - groups `( )` and non-capturing groups `(?: )`;
 * - alternation `|` (alternatives are tried in order);
 * - the quantifiers `?`, `*`, `+`, `{n}`, `{n,}` and `{n,m}`, and their lazy forms (`??`, `*?`, `+?`, `{n,m}?`);
 * - the anchors `^` and `$`.
 *
 * Everything else gives null: look-ahead and look-behind, back-references, named groups, `\b` and `\B`,
 * `\p{...}` and `\P{...}`, `\D`, `\W`, `\S`, control and code escapes (`\n`, `\t`, `\uXXXX`, `\xHH`, ...), and
 * anything else the parser does not recognise. An invalid pattern gives null. A class contributes one character,
 * chosen deterministically: an upper-case letter, else a lower-case letter, else a digit, else the first
 * printable ASCII character it contains. When a minimum length asks for more than the shortest match, the sample
 * is lengthened at its repeatable elements, first to last, and then padded with "x" (which only helps a pattern
 * that is not anchored at its end; the final test rejects everything else). A pattern longer than 1 000
 * characters, or a sample that would be longer than 4 096 characters, gives null.
 */
export function samplePattern(pattern: string, length?: { min?: number; max?: number }): string | null {
  if (typeof pattern !== "string" || pattern.length > MAX_PATTERN_LENGTH) return null;
  const rawMin = length?.min;
  const rawMax = length?.max;
  if (rawMin !== undefined && (typeof rawMin !== "number" || Number.isNaN(rawMin))) return null;
  const min = rawMin === undefined ? 0 : Math.max(0, Math.ceil(rawMin));
  const max = Math.min(
    MAX_SAMPLE_LENGTH,
    typeof rawMax === "number" && !Number.isNaN(rawMax) ? Math.floor(rawMax) : MAX_SAMPLE_LENGTH,
  );
  if (min > max) return null;
  let regex: RegExp;
  let alternation: Alternation;
  try {
    regex = new RegExp(pattern, "u");
    alternation = new Parser(pattern).parse();
  } catch {
    return null;
  }
  let tried = 0;
  try {
    for (const shape of alternationShapes(alternation, { steps: MAX_STEPS })) {
      if (++tried > MAX_SHAPES) return null;
      const sample = fill(shape, min, max);
      if (sample === null) continue;
      const size = codePoints(sample);
      if (size >= min && size <= max && regex.test(sample)) return sample;
    }
  } catch {
    return null;
  }
  return null;
}
