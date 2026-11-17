import { test } from "node:test";
import assert from "node:assert/strict";
import { createGrowingRedactor, createRedactor, MIN_SECRET_BYTES, redactJsonWith, secretForms, type Redactor } from "../../src/core/redact.ts";
import type { Json } from "../../src/core/json.ts";

const KEY = "sk-test-0123456789abcdef?+/=";

function encodedForms(value: string): string[] {
  const bytes = Buffer.from(value, "utf8");
  const base64 = bytes.toString("base64");
  return [value, base64, base64.replace(/=+$/, ""), bytes.toString("base64url"), encodeURIComponent(value)];
}

/** Pushes every chunk, then flushes; returns each released piece. */
function streamPieces(r: Redactor, chunks: readonly string[]): string[] {
  const stream = r.stream();
  const pieces = chunks.map((chunk) => stream.push(chunk));
  pieces.push(stream.flush());
  return pieces;
}

/** A small deterministic generator (mulberry32), so the randomized cases are the same on every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

test("replaces plain, base64, base64url and percent-encoded forms", () => {
  const r = createRedactor({ API_KEY: KEY });
  const b64 = Buffer.from(KEY).toString("base64");
  const b64url = Buffer.from(KEY).toString("base64url");
  const pct = encodeURIComponent(KEY);
  assert.notEqual(b64, b64url);
  assert.equal(r.text(`key=${KEY}.`), "key=[redacted:API_KEY].");
  assert.equal(r.text(`auth ${b64}`), "auth [redacted:API_KEY]");
  assert.equal(r.text(`auth ${b64url}`), "auth [redacted:API_KEY]");
  assert.equal(r.text(`?k=${pct}&x=1`), "?k=[redacted:API_KEY]&x=1");
  for (const form of [KEY, b64, b64url, pct]) assert.equal(r.contains(`..${form}..`), true);
  assert.equal(r.contains("nothing here"), false);
  assert.deepEqual(r.names, ["API_KEY"]);
});

test("short values are ignored", () => {
  const r = createRedactor({ SHORT: "abc1234", LONG: "abcdefgh" });
  assert.deepEqual(r.names, ["LONG"]);
  assert.equal(r.text("abc1234 abcdefgh"), "abc1234 [redacted:LONG]");
});

test("the registration threshold is in UTF-8 bytes, not characters", () => {
  assert.equal(MIN_SECRET_BYTES, 8);
  const r = createRedactor({ NINE_BYTES: "1234567é", FOUR_CHARS: "é".repeat(4), SEVEN_BYTES: "é".repeat(3) + "a" });
  assert.deepEqual(r.names, ["FOUR_CHARS", "NINE_BYTES"]);
  assert.equal(r.text("éééé"), "[redacted:FOUR_CHARS]");
  assert.equal(r.text("1234567é"), "[redacted:NINE_BYTES]");
  assert.equal(r.text("ééé" + "a"), "ééé" + "a");
});

for (const [label, secret] of [["CJK", "秘密口令"], ["emoji", "🔑🗝️🔐"]] as const) {
  test(`a multibyte secret of fewer than 8 characters (${label}) is registered and redacted in every form`, () => {
    assert.ok(secret.length < 8 && Buffer.byteLength(secret, "utf8") >= 8);
    const r = createRedactor({ PASS: secret });
    assert.deepEqual(r.names, ["PASS"]);
    assert.equal(r.text(secret), "[redacted:PASS]", "a text shorter than 8 characters that is the secret");
    for (const form of encodedForms(secret)) {
      assert.equal(r.text(`<${form}>`), "<[redacted:PASS]>", `form ${form}`);
      assert.equal(r.contains(`x${form}y`), true, `contains ${form}`);
    }
    assert.deepEqual(r.json({ [secret]: [`a ${secret} b`, { k: Buffer.from(secret).toString("base64") }] }), {
      "[redacted:PASS]": ["a [redacted:PASS] b", { k: "[redacted:PASS]" }],
    });
    assert.equal(r.contains("秘密 口令"), false);
  });
}

test("the JSON-escaped form is redacted, and serialized JSON stays valid", () => {
  const secret = 'pa"ss\\wo\nrd\tend';
  const r = createRedactor({ PEM: secret });
  const escaped = JSON.stringify(secret).slice(1, -1);
  assert.notEqual(escaped, secret);
  const out = r.text(JSON.stringify({ k: secret, list: [`before ${secret} after`] }));
  assert.equal(out.includes(secret), false);
  assert.equal(out.includes(escaped), false);
  assert.deepEqual(JSON.parse(out), { k: "[redacted:PEM]", list: ["before [redacted:PEM] after"] });
  assert.equal(r.contains(JSON.stringify({ message: secret })), true);
});

test("secretForms lists every form once, and nothing for a short value", () => {
  const value = "sk-test value/+?";
  const bytes = Buffer.from(value, "utf8");
  assert.deepEqual(secretForms(value), [
    value,
    bytes.toString("base64"),
    bytes.toString("base64").replace(/=+$/, ""),
    bytes.toString("base64url"),
    encodeURIComponent(value),
  ].filter((form, index, all) => all.indexOf(form) === index));
  assert.deepEqual(secretForms("plainvalue12"), ["plainvalue12", "cGxhaW52YWx1ZTEy"]);
  const withQuote = 'say "hi" now';
  assert.ok(secretForms(withQuote).includes('say \\"hi\\" now'));
  for (const sample of ["plainvalue12", withQuote, "秘密口令", KEY]) {
    const forms = secretForms(sample);
    assert.equal(new Set(forms).size, forms.length, `duplicates for ${sample}`);
  }
  assert.deepEqual(secretForms("1234567"), []);
  assert.deepEqual(secretForms("ééé"), []);
});

test("a value with a lone surrogate is registered without a percent-encoded form", () => {
  const value = "abc\ud800defgh";
  assert.throws(() => encodeURIComponent(value), URIError);
  const forms = secretForms(value);
  assert.ok(forms.includes(value));
  assert.ok(forms.includes("abc\\ud800defgh"));
  const r = createRedactor({ LONE: value });
  assert.deepEqual(r.names, ["LONE"]);
  assert.equal(r.text(`x ${value} y`), "x [redacted:LONE] y");
  assert.equal(r.text(JSON.stringify(value)), '"[redacted:LONE]"');
});

test("longest secret is replaced first", () => {
  const r = createRedactor({ A: "password", B: "password-extended" });
  assert.equal(r.text("x password-extended y password"), "x [redacted:B] y [redacted:A]");
});

test("json walks nested arrays and objects, including keys, and returns a new value", () => {
  const r = createRedactor({ TOKEN: "tok_secret_value" });
  const input: Json = { list: ["a", { tok_secret_value: "x tok_secret_value" }], n: 3, ok: true, none: null };
  const out = r.json(input);
  assert.deepEqual(out, { list: ["a", { "[redacted:TOKEN]": "x [redacted:TOKEN]" }], n: 3, ok: true, none: null });
  assert.notEqual(out, input);
  assert.deepEqual(input, { list: ["a", { tok_secret_value: "x tok_secret_value" }], n: 3, ok: true, none: null });
  assert.equal(r.json("tok_secret_value"), "[redacted:TOKEN]");
});

test("a redactor with no secrets leaves inputs unchanged", () => {
  const r = createRedactor({});
  const value: Json = { a: "b" };
  assert.equal(r.json(value), value);
  assert.equal(r.text("anything"), "anything");
  assert.equal(r.contains("anything"), false);
  const stream = r.stream();
  assert.equal(stream.push("any"), "any");
  assert.equal(stream.push("thing"), "thing");
  assert.equal(stream.flush(), "");
});

test("secrets containing regex characters are matched literally", () => {
  const r = createRedactor({ RX: "a.b*c+d?(e)" });
  assert.equal(r.text("aXbbbcdde a.b*c+d?(e)"), "aXbbbcdde [redacted:RX]");
});

/** Texts that put secrets in every form and every awkward position. */
function streamCases(): { r: Redactor; texts: string[] } {
  const secrets = { AA: "abcdefgh", AB: "abcdefgh-longer", CJK: "秘密口令", QUOTE: 'q"uo\\te\nline', SAME: "zzzzzzzz" };
  const r = createRedactor(secrets);
  const texts: string[] = [];
  for (const value of Object.values(secrets)) {
    for (const form of secretForms(value)) {
      texts.push(form, `${form} tail`, `head ${form}`, `head ${form} tail`, `${form}${form}`, `${form}=`, `${form}==x`);
      texts.push(form.slice(0, -1), `x ${form.slice(0, Math.ceil(form.length / 2))}`);
    }
  }
  texts.push(
    "abcdefgh-longer and abcdefgh and abcdefgh-long",
    "abcdefgh-longe",
    "abcdefghabcdefgh-longer",
    "aaaaaaaaaaaa",
    "abababababcabcd",
    "zzzzzzzzzzzzzzzzz",
    "z".repeat(7),
    "秘密口秘密口令令",
    "nothing secret in here at all",
    "",
  );
  return { r, texts };
}

test("stream law: every two-way and three-way split equals text() of the whole", () => {
  const { r, texts } = streamCases();
  let cases = 0;
  for (const whole of texts) {
    const expected = r.text(whole);
    for (let a = 0; a <= whole.length; a += 1) {
      assert.equal(streamPieces(r, [whole.slice(0, a), whole.slice(a)]).join(""), expected, `${JSON.stringify(whole)} @${a}`);
      cases += 1;
      for (let b = a; b <= whole.length; b += 1) {
        const pieces = streamPieces(r, [whole.slice(0, a), whole.slice(a, b), whole.slice(b)]);
        assert.equal(pieces.join(""), expected, `${JSON.stringify(whole)} @${a},${b}`);
        cases += 1;
      }
    }
  }
  assert.ok(cases > 10_000, `${cases} cases`);
});

test("stream law: seeded random chunkings, including one-character chunks", () => {
  const { r, texts } = streamCases();
  const random = seeded(20_261_113);
  const alphabet = ["a", "b", "z", " ", "=", "秘", "密", "\"", "\\", "\n", "abcdefgh", "-longer", "YWJj", "%22"];
  for (let n = 0; n < 4000; n += 1) {
    let whole: string;
    if (n % 2 === 0) {
      whole = texts[Math.floor(random() * texts.length)] ?? "";
    } else {
      whole = "";
      const parts = 1 + Math.floor(random() * 12);
      for (let p = 0; p < parts; p += 1) {
        whole += random() < 0.3 ? texts[Math.floor(random() * texts.length)] : alphabet[Math.floor(random() * alphabet.length)];
      }
    }
    const count = 1 + Math.floor(random() * 20);
    const cuts = new Set<number>();
    for (let c = 1; c < count; c += 1) cuts.add(random() < 0.3 ? c : Math.floor(random() * (whole.length + 1)));
    const sorted = [0, ...[...cuts].filter((cut) => cut <= whole.length).sort((x, y) => x - y), whole.length];
    const chunks: string[] = [];
    for (let k = 1; k < sorted.length; k += 1) chunks.push(whole.slice(sorted[k - 1], sorted[k]));
    assert.equal(streamPieces(r, chunks).join(""), r.text(whole), `${JSON.stringify(chunks)}`);
  }
});

test("a secret split into two pushes is held whole and never released", () => {
  const secret = "abcdefgh12345678";
  const r = createRedactor({ PROBE: secret });
  for (let at = 1; at < secret.length; at += 1) {
    const stream = r.stream();
    assert.equal(stream.push(secret.slice(0, at)), "", `held at ${at}`);
    assert.equal(stream.push(secret.slice(at)), "[redacted:PROBE]", `released at ${at}`);
    assert.equal(stream.flush(), "");
  }
  const whole = `key: ${secret} end`;
  for (let at = 0; at <= whole.length; at += 1) {
    const pieces = streamPieces(r, [whole.slice(0, at), whole.slice(at)]);
    for (let k = 0; k < pieces.length; k += 1) {
      assert.equal(pieces[k]?.includes(secret), false, `piece ${k} at ${at}`);
      assert.equal(pieces.slice(0, k + 1).join("").includes(secret), false, `prefix ${k} at ${at}`);
    }
    assert.equal(pieces.join(""), r.text(whole));
    assert.equal(pieces.join(""), "key: [redacted:PROBE] end");
  }
});

test("text that cannot start a secret passes through with no delay", () => {
  const stream = createRedactor({ PROBE: "abcdefgh12345678" }).stream();
  assert.equal(stream.push("Hello"), "Hello");
  assert.equal(stream.push(", world"), ", world");
  assert.equal(stream.push(" ab"), " ");
  assert.equal(stream.push("x!"), "abx!");
  assert.equal(stream.flush(), "");
});

test("flush on an empty stream returns nothing, and a stream is reusable after flush", () => {
  const r = createRedactor({ PROBE: "abcdefgh12345678" });
  const stream = r.stream();
  assert.equal(stream.flush(), "");
  assert.equal(stream.push("abcdefgh"), "");
  assert.equal(stream.flush(), "abcdefgh");
  assert.equal(stream.push("abcdefgh1234"), "");
  assert.equal(stream.push("5678 done"), "[redacted:PROBE] done");
  assert.equal(stream.flush(), "");
  const other = r.stream();
  assert.equal(other.push("abcd"), "");
  assert.equal(stream.push("efgh"), "efgh", "streams do not share their held text");
  assert.equal(other.flush(), "abcd");
});

test("creating a redactor for a 16 384-byte secret and streaming 2 000 small chunks through it is fast", () => {
  const random = seeded(7);
  const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let secret = "";
  while (secret.length < 16_384) secret += charset[Math.floor(random() * charset.length)];
  const started = performance.now();
  const r = createRedactor({ BIG: secret });
  let text = "";
  for (let k = 0; k < 400; k += 1) text += `line ${k} of the model's answer with some ordinary words. `;
  text = `${text}${secret}${Buffer.from(secret).toString("base64").slice(0, 9000)}${text}`;
  const size = Math.ceil(text.length / 2000);
  const chunks: string[] = [];
  for (let at = 0; at < text.length; at += size) chunks.push(text.slice(at, at + size));
  assert.ok(chunks.length >= 1900);
  const out = streamPieces(r, chunks).join("");
  const elapsed = performance.now() - started;
  assert.equal(out, r.text(text));
  assert.equal(out.includes(secret), false);
  assert.ok(elapsed < 2000, `took ${elapsed.toFixed(0)} ms`);
});

test("text() matches a reference regular expression: leftmost match, longest form at a position", () => {
  const random = seeded(99);
  const values = ["abcdefgh", "abcdefghij", "bcdefghi", "hhhhhhhh", "a\"b\\c\nd1234"];
  const r = createRedactor({ V0: values[0] ?? "", V1: values[1] ?? "", V2: values[2] ?? "", V3: values[3] ?? "", V4: values[4] ?? "" });
  const owner = new Map<string, string>();
  values.forEach((value, index) => {
    for (const form of secretForms(value)) if (!owner.has(form)) owner.set(form, `V${index}`);
  });
  const ordered = [...owner.keys()].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  const reference = new RegExp(ordered.map((form) => form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  const pieces = [...ordered, "a", "b", "h", "x", " ", "\\", "\""];
  for (let n = 0; n < 2000; n += 1) {
    let whole = "";
    const parts = 1 + Math.floor(random() * 8);
    for (let p = 0; p < parts; p += 1) {
      const piece = pieces[Math.floor(random() * pieces.length)] ?? "";
      whole += random() < 0.5 ? piece : piece.slice(0, Math.floor(random() * (piece.length + 1)));
    }
    const expected = whole.replace(reference, (match) => `[redacted:${owner.get(match) ?? "?"}]`);
    assert.equal(r.text(whole), expected, JSON.stringify(whole));
    reference.lastIndex = 0;
    assert.equal(r.contains(whole), reference.test(whole), JSON.stringify(whole));
    reference.lastIndex = 0;
  }
});

// ------------------------------------------------------------------ growing redactor

const LATER = `late "quoted" \\ back/slash ~~? value!`;

test("growing: a value added later is replaced in text, json values and keys, and found by contains, in every form", () => {
  const r = createGrowingRedactor();
  assert.equal(r.contains(LATER), false);
  assert.equal(r.text(LATER), LATER);
  assert.equal(r.add("LATE", LATER), true);
  const forms = secretForms(LATER);
  assert.equal(forms.length, 6, "plain, base64 padded and unpadded, base64url, percent-encoded, JSON-escaped are distinct here");
  for (const form of forms) {
    assert.equal(r.text(`<${form}>`), "<[redacted:LATE]>", form);
    assert.equal(r.contains(`x${form}y`), true, form);
    const redacted = r.json({ [form]: [form, { inner: `a ${form} b` }] } as Json);
    assert.deepEqual(redacted, { "[redacted:LATE]": ["[redacted:LATE]", { inner: "a [redacted:LATE] b" }] }, form);
  }
});

test("growing: two values under one name are both replaced; names are sorted and list a name once", () => {
  const r = createGrowingRedactor({ ZED: "zed-secret-value" });
  assert.equal(r.add("KEY", "first-key-value-A"), true);
  assert.equal(r.add("KEY", "second-key-value-B"), true);
  assert.equal(r.add("ALPHA", "alpha-secret-value"), true);
  assert.deepEqual(r.names, ["ALPHA", "KEY", "ZED"]);
  assert.equal(r.text("first-key-value-A / second-key-value-B / zed-secret-value"), "[redacted:KEY] / [redacted:KEY] / [redacted:ZED]");
});

test("growing: add refuses a repeated value and a value under the byte threshold, which then stays unredacted", () => {
  const r = createGrowingRedactor();
  assert.equal(r.add("K", "repeat-me-value"), true);
  assert.equal(r.add("K", "repeat-me-value"), false);
  const short = "x".repeat(MIN_SECRET_BYTES - 1);
  assert.equal(r.add("SHORT", short), false);
  assert.deepEqual(r.names, ["K"]);
  assert.equal(r.text(`a ${short} b`), `a ${short} b`);
  assert.equal(r.contains(short), false);
  assert.equal(r.add("OTHER", "repeat-me-value"), true, "the same value under another name is a new registration");
  assert.equal(r.text("repeat-me-value"), "[redacted:K]", "a form under two names goes to the alphabetically first");
});

test("growing: a form registered under two names is replaced under the alphabetically first, whatever the order of add", () => {
  const r = createGrowingRedactor();
  r.add("ZULU", "shared-value-123");
  assert.equal(r.text("shared-value-123"), "[redacted:ZULU]");
  r.add("ALPHA", "shared-value-123");
  assert.equal(r.text("shared-value-123"), "[redacted:ALPHA]");
});

test("growing: a reference taken before add (a bound method, the object itself) redacts the new value afterwards", () => {
  const r = createGrowingRedactor();
  const use = r.text;
  const json = r.json;
  const contains = r.contains;
  const asRedactor: Redactor = r;
  assert.equal(use("token-added-later"), "token-added-later");
  r.add("LATER", "token-added-later");
  assert.equal(use("token-added-later"), "[redacted:LATER]");
  assert.deepEqual(json({ v: "token-added-later" }), { v: "[redacted:LATER]" });
  assert.equal(contains("token-added-later"), true);
  assert.deepEqual(asRedactor.names, ["LATER"]);
});

test("growing: a stream created after add holds back and replaces a value split across pushes at every position", () => {
  const r = createGrowingRedactor();
  const value = "stream-secret-value";
  r.add("S", value);
  const whole = `before ${value} after`;
  for (let i = 1; i < whole.length; i++) {
    const pieces = streamPieces(r, [whole.slice(0, i), whole.slice(i)]);
    assert.equal(pieces.join(""), "before [redacted:S] after", `split at ${i}`);
    for (const piece of pieces) assert.equal(piece.includes(value.slice(0, 8)) && piece.includes(value), false);
  }
  for (let i = 1; i < value.length; i++) {
    const stream = r.stream();
    const first = stream.push(`x ${value.slice(0, i)}`);
    assert.equal(first.includes(value.slice(0, i)), false, `prefix of length ${i} is held`);
    assert.equal(first + stream.push(value.slice(i)) + stream.flush(), "x [redacted:S]");
  }
});

test("growing: a stream is over the values registered when it was created", () => {
  const r = createGrowingRedactor();
  const before = r.stream();
  r.add("S", "added-after-stream");
  assert.equal(before.push("added-after-stream") + before.flush(), "added-after-stream");
  const after = r.stream();
  assert.equal(after.push("added-after-stream") + after.flush(), "[redacted:S]");
});

test("growing: json keeps __proto__ keys as own properties and returns the input itself while nothing is registered", () => {
  const r = createGrowingRedactor();
  const input = JSON.parse('{"__proto__": {"a": "b"}, "x": ["y"]}') as Json;
  assert.equal(r.json(input), input);
  r.add("P", "proto-secret-value");
  const out = r.json(JSON.parse('{"__proto__": "proto-secret-value"}') as Json) as Record<string, Json>;
  assert.equal(Object.hasOwn(out, "__proto__"), true);
  assert.equal(out["__proto__"], "[redacted:P]");
});

test("createRedactor still redacts a fixed set and its names do not change", () => {
  const r = createRedactor({ B: "bravo-secret-value", A: "alpha-secret-value", S: "short" });
  assert.deepEqual(r.names, ["A", "B"]);
  assert.equal(r.text("alpha-secret-value bravo-secret-value"), "[redacted:A] [redacted:B]");
  assert.equal(Object.hasOwn(r, "add"), false);
});

// Structural redaction (redactJsonWith): values are redacted before they are serialized, so the output is JSON.

const NUMERIC = "12345678";

test("redactJsonWith redacts strings, keys, nested values and arrays, and keeps __proto__ an own key", () => {
  const r = createRedactor({ S: "string-secret-value", N: NUMERIC });
  const input = JSON.parse('{"__proto__": "string-secret-value", "a": ["x string-secret-value y", {"string-secret-value": true}], "b": {"c": null, "d": false}}') as Json;
  const out = redactJsonWith(input, r.text) as Record<string, Json>;
  assert.equal(Object.hasOwn(out, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.equal(out["__proto__"], "[redacted:S]");
  assert.deepEqual(out["a"], ["x [redacted:S] y", { "[redacted:S]": true }]);
  assert.deepEqual(out["b"], { c: null, d: false });
  assert.equal(redactJsonWith("string-secret-value", r.text), "[redacted:S]");
});

test("redactJsonWith drops undefined properties and reads values the way JSON.stringify does", () => {
  const identity = (text: string): string => text;
  const when = new Date(Date.UTC(2026, 0, 2));
  const samples: unknown[] = [
    { a: undefined, b: 1, f: () => 1, s: Symbol("x"), big: 1n },
    [undefined, () => 1, Symbol("y"), 1n, Number.NaN, Number.POSITIVE_INFINITY, -0],
    { when, boxed: [new String("s"), new Number(2), new Boolean(false)], nested: { toJSON: () => ({ replaced: true }) } },
    undefined,
    Number.NaN,
    { shared: [{ k: 1 }, { k: 1 }] },
  ];
  for (const sample of samples) {
    const plain = JSON.stringify(sample, (_k, v: unknown) => (typeof v === "bigint" ? undefined : v));
    assert.equal(JSON.stringify(redactJsonWith(sample, identity, { numbers: true })), plain ?? "null");
  }
  const out = redactJsonWith({ a: undefined, b: 2 }, identity) as Record<string, Json>;
  assert.equal(Object.hasOwn(out, "a"), false);
  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic["self"] = cyclic;
  assert.throws(() => redactJsonWith(cyclic, identity), TypeError);
  const reused = { k: "v" };
  assert.deepEqual(redactJsonWith({ x: reused, y: [reused] }, identity), { x: { k: "v" }, y: [{ k: "v" }] });
});

test("redactJsonWith with numbers: a number holding a secret's digits becomes the placeholder text", () => {
  const r = createRedactor({ PIN: NUMERIC });
  const out = redactJsonWith({ equal: 12345678, contains: 9123456789, other: 42, negative: -12345678, fraction: 0.12345678, big: 1.2345678e20, list: [12345678, 7] }, r.text, { numbers: true }) as Record<string, Json>;
  assert.equal(out["equal"], "[redacted:PIN]");
  assert.equal(typeof out["contains"], "string");
  assert.equal(out["contains"], "9[redacted:PIN]9");
  assert.equal(out["other"], 42);
  assert.equal(out["negative"], "-[redacted:PIN]");
  assert.equal(out["fraction"], "0.[redacted:PIN]");
  assert.equal(out["big"], "[redacted:PIN]0000000000000", "the digits are read as JSON.stringify writes them");
  assert.deepEqual(out["list"], ["[redacted:PIN]", 7]);
  const text = JSON.stringify(out);
  assert.equal(text.includes(NUMERIC), false);
  assert.deepEqual(JSON.parse(text), out);
  assert.equal(redactJsonWith(12345678, r.text, { numbers: true }), "[redacted:PIN]");
  assert.equal(redactJsonWith(-1.5, r.text, { numbers: true }), -1.5);
});

test("redactJsonWith without numbers returns every number unchanged, at rest", () => {
  const r = createRedactor({ PIN: NUMERIC });
  const input = { equal: 12345678, contains: 9123456789, negative: -12345678, fraction: 0.12345678, list: [12345678], "12345678": 12345678 };
  const out = redactJsonWith(input, r.text) as Record<string, Json>;
  assert.deepEqual(out, { equal: 12345678, contains: 9123456789, negative: -12345678, fraction: 0.12345678, list: [12345678], "[redacted:PIN]": 12345678 });
  assert.deepEqual(redactJsonWith(input, r.text, { numbers: false }), out);
  assert.deepEqual(r.json(input as Json), out, "the run redactor's json is the at-rest mode");
});

test("a redactor's payload: a number holding a secret's digits becomes the placeholder string; json keeps every number", () => {
  for (const r of [createRedactor({ PIN: NUMERIC }), createGrowingRedactor({ PIN: NUMERIC })]) {
    const input = {
      equal: 12345678, contains: 9123456789, negative: -12345678, fraction: 0.12345678, other: 42,
      list: [12345678, [7, { deep: 12345678 }]], nested: { a: { b: -0.12345678 } }, text: "pin 12345678", "12345678": 1,
    };
    assert.deepEqual(r.payload(input), {
      equal: "[redacted:PIN]", contains: "9[redacted:PIN]9", negative: "-[redacted:PIN]", fraction: "0.[redacted:PIN]", other: 42,
      list: ["[redacted:PIN]", [7, { deep: "[redacted:PIN]" }]], nested: { a: { b: "-0.[redacted:PIN]" } }, text: "pin [redacted:PIN]",
      "[redacted:PIN]": 1,
    });
    assert.equal(r.payload(12345678), "[redacted:PIN]");
    assert.equal(r.payload(42), 42);
    const { "12345678": one, ...rest } = input;
    assert.deepEqual(r.json(input), { ...rest, text: "pin [redacted:PIN]", "[redacted:PIN]": one });
  }
  const empty = createGrowingRedactor();
  const value = { n: 12345678 };
  assert.equal(empty.payload(value), value, "with no secret registered the value itself comes back");
  empty.add("PIN", NUMERIC);
  assert.deepEqual(empty.payload(value), { n: "[redacted:PIN]" }, "a later secret is used");
  assert.deepEqual(value, { n: 12345678 }, "the input is not changed");
});

test("redactJsonWith output always parses, whatever the secret looks like as JSON text", () => {
  const nasty = ['"level":', '{"ts":"2', '","msg":"', "null,true", "]}]}]}]}", '"],"x":"'];
  for (const value of nasty) assert.ok(secretForms(value).length > 0, `${value} is long enough to be a secret`);
  const r = createRedactor(Object.fromEntries(nasty.map((value, i) => [`K${i}`, value])));
  const input: Json = { level: "info", msg: 'a "level": b', ts: '{"ts":"2', nested: { '","msg":"': ["null,true", "]}]}]}]}", 'x"],"x":"y'] }, n: 1 };
  for (const numbers of [false, true]) {
    const text = JSON.stringify(redactJsonWith(input, r.text, { numbers }));
    const parsed = JSON.parse(text) as Record<string, Json>;
    assert.equal(parsed["level"], "info");
    const strings: string[] = [];
    const collect = (value: Json): void => {
      if (typeof value === "string") strings.push(value);
      else if (Array.isArray(value)) value.forEach(collect);
      else if (value !== null && typeof value === "object") for (const [key, item] of Object.entries(value)) { strings.push(key); collect(item); }
    };
    collect(parsed);
    for (const value of nasty) {
      assert.equal(strings.some((text) => text.includes(value)), false, `${value} is gone from every string and key (numbers: ${numbers})`);
    }
  }
});
