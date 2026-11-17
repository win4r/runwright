import { test } from "node:test";
import assert from "node:assert/strict";
import { samplePattern } from "../../src/schema/pattern-sample.ts";

function codePoints(text: string): number {
  return [...text].length;
}

function assertSample(pattern: string, length?: { min?: number; max?: number }): string {
  const sample = samplePattern(pattern, length);
  assert.notEqual(sample, null, `no sample for ${pattern}`);
  const s = sample as string;
  assert.ok(new RegExp(pattern, "u").test(s), `${JSON.stringify(s)} does not match ${pattern}`);
  if (length?.min !== undefined) assert.ok(codePoints(s) >= length.min, `${JSON.stringify(s)} shorter than ${length.min}`);
  if (length?.max !== undefined) assert.ok(codePoints(s) <= length.max, `${JSON.stringify(s)} longer than ${length.max}`);
  return s;
}

const supported: { construct: string; pattern: string; expected?: string }[] = [
  { construct: "literal characters", pattern: "^abc$", expected: "abc" },
  { construct: "non-ASCII literals", pattern: "^é😀$", expected: "é😀" },
  { construct: "escaped punctuation", pattern: "^a\\.bc\\/d\\\\e\\(f\\)\\[g\\]\\{h\\}\\*\\+\\?\\|\\^\\$$" },
  { construct: "dot", pattern: "^.$", expected: "A" },
  { construct: "\\d", pattern: "^\\d$", expected: "0" },
  { construct: "\\w", pattern: "^\\w$", expected: "A" },
  { construct: "\\s", pattern: "^\\s$", expected: " " },
  { construct: "class escapes inside brackets", pattern: "^[\\s\\d]$", expected: "0" },
  { construct: "bracket class with ranges", pattern: "^[a-f0-9]$", expected: "a" },
  { construct: "bracket class with a literal dash", pattern: "^[_-]$", expected: "-" },
  { construct: "negated bracket class", pattern: "^[^A-Z]$", expected: "a" },
  { construct: "negated class without letters or digits", pattern: "^[^A-Za-z0-9]$", expected: " " },
  { construct: "class without printable ASCII", pattern: "^[é-ë]$", expected: "é" },
  { construct: "escaped punctuation inside brackets", pattern: "^[\\]\\-]$" },
  { construct: "group", pattern: "^(ab)+$", expected: "ab" },
  { construct: "non-capturing group", pattern: "^(?:xy){2}$", expected: "xyxy" },
  { construct: "alternation in order", pattern: "^(bug|idea)-[0-9]+$", expected: "bug-0" },
  { construct: "top-level alternation", pattern: "^a$|^b$", expected: "a" },
  { construct: "alternative after one that cannot match", pattern: "^(?:a$b|c)$", expected: "c" },
  { construct: "?", pattern: "^a?b$", expected: "b" },
  { construct: "*", pattern: "^a*$", expected: "" },
  { construct: "+", pattern: "^a+$", expected: "a" },
  { construct: "{n}", pattern: "^\\d{4}-\\d{2}-\\d{2}$", expected: "0000-00-00" },
  { construct: "{n,}", pattern: "^a{3,}$", expected: "aaa" },
  { construct: "{n,m}", pattern: "^a{2,5}$", expected: "aa" },
  { construct: "lazy quantifiers", pattern: "^a+?b*?c??d{1,2}?$", expected: "ad" },
  { construct: "unanchored", pattern: "[A-F]", expected: "A" },
  { construct: "empty pattern", pattern: "", expected: "" },
];

for (const c of supported) {
  test(`samplePattern supports ${c.construct}`, () => {
    const s = assertSample(c.pattern);
    if (c.expected !== undefined) assert.equal(s, c.expected);
  });
}

test("samplePattern lengthens at a repeatable element when min asks for more", () => {
  assert.equal(assertSample("^[a-z0-9-]+$", { min: 5 }), "aaaaa");
  assert.equal(assertSample("^(?:ab|c)*$", { min: 5, max: 5 }), "ccccc");
  assert.equal(assertSample("^x\\d{2,}y$", { min: 6 }), "x0000y");
  assert.equal(assertSample("^a{2,4}b*$", { min: 6 }), "aaaabb");
  assert.equal(assertSample("[A-F]", { min: 3 }), "Axx");
});

test("samplePattern honours max and returns null when the bounds cannot be met", () => {
  assert.equal(assertSample("^[A-Z]{2}$", { min: 2, max: 2 }), "AA");
  assert.equal(assertSample("^(?:abc|d)$", { max: 1 }), "d");
  assert.equal(samplePattern("^[A-Z]{2}$", { min: 3 }), null);
  assert.equal(samplePattern("^[A-Z]{2}$", { max: 1 }), null);
  assert.equal(samplePattern("^a{2,3}$", { min: 4 }), null);
  assert.equal(samplePattern("^a*$", { min: 3, max: 2 }), null);
});

const unsupported: { construct: string; pattern: string }[] = [
  { construct: "look-ahead", pattern: "^(?=a)a$" },
  { construct: "negative look-ahead", pattern: "^(?!b)a$" },
  { construct: "look-behind", pattern: "(?<=a)b" },
  { construct: "negative look-behind", pattern: "(?<!a)b" },
  { construct: "back-reference", pattern: "^(a)\\1$" },
  { construct: "named group", pattern: "^(?<x>a)$" },
  { construct: "named back-reference", pattern: "^(?<x>a)\\k<x>$" },
  { construct: "word boundary", pattern: "\\ba" },
  { construct: "non-word boundary", pattern: "a\\B" },
  { construct: "unicode property", pattern: "^\\p{L}$" },
  { construct: "negated unicode property", pattern: "^\\P{L}$" },
  { construct: "negated class escape", pattern: "^\\D$" },
  { construct: "control escape", pattern: "^\\n$" },
  { construct: "code escape", pattern: "^\\u0041$" },
  { construct: "hex escape", pattern: "^\\x41$" },
  { construct: "backspace in a class", pattern: "^[\\b]$" },
  { construct: "empty class", pattern: "^[]$" },
];

for (const c of unsupported) {
  test(`samplePattern returns null for ${c.construct}`, () => {
    assert.doesNotThrow(() => new RegExp(c.pattern, "u"));
    assert.equal(samplePattern(c.pattern), null);
  });
}

test("samplePattern returns null for an invalid pattern and never throws", () => {
  for (const pattern of ["(", "[a", "a{2,1}", "\\", "*a", "a{", "]", "\\-"]) {
    assert.equal(samplePattern(pattern), null, pattern);
  }
});

test("samplePattern is deterministic", () => {
  for (const pattern of ["^[a-z]{3}-\\d+$", "(x|y)*z", "^.+$"]) {
    assert.equal(samplePattern(pattern, { min: 7 }), samplePattern(pattern, { min: 7 }));
  }
});

test("samplePattern size bounds: pattern length and sample length", () => {
  assert.equal(samplePattern("a".repeat(1001)), null);
  assert.equal(assertSample("a".repeat(1000)), "a".repeat(1000));
  const started = Date.now();
  assert.equal(samplePattern("^a{1000000000}$"), null);
  assert.equal(samplePattern("^(?:a{100}){100}$"), null);
  assert.equal(samplePattern("^a+$", { min: 1_000_000_000 }), null);
  assert.equal(samplePattern("^a+$", { min: 4097 }), null);
  assert.equal(assertSample("^a+$", { min: 4096 }).length, 4096);
  assert.equal(assertSample("^a{4096}$").length, 4096);
  assert.equal(samplePattern("^a{4097}$"), null);
  assert.ok(Date.now() - started < 1000);
});

test("samplePattern gives up promptly when a term can never be built", () => {
  const started = Date.now();
  for (const tail of ["[]", "a{5000}", "[^ -~]"]) {
    const pattern = "(a|b)".repeat(40) + tail;
    assert.doesNotThrow(() => new RegExp(pattern, "u"));
    assert.equal(samplePattern(pattern), null, tail);
  }
  assert.equal(samplePattern("^a*$", { min: Infinity }), null);
  assert.equal(samplePattern("^a*$", { min: Number.NaN }), null);
  assert.ok(Date.now() - started < 1000);
});
