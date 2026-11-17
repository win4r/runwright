import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { Json } from "../../src/core/json.ts";
import { createGrowingRedactor, createRedactor } from "../../src/core/redact.ts";
import { cleanProviderText } from "../../src/models/sse-parse.ts";
import { generateSealKey } from "../../src/security/seal.ts";
import { createSecretsService, REDACTED_MARKER } from "../../src/security/secrets.ts";
import type { SecretsService } from "../../src/security/types.ts";
import { createWriteRedaction } from "../../src/security/write-redaction.ts";
import { openTestStore } from "../helpers/store.ts";
import { checkProposal } from "../../src/learning/checks.ts";
import { parseItemFile, parseItemPath, PROPOSAL_SCHEMA, PROPOSAL_SYSTEM } from "../../src/learning/proposal.ts";
import { validateSchema } from "../../src/schema/validate.ts";
import { findHiddenCharacters, scanForSecrets } from "../../src/learning/secret-scan.ts";

const LIMITS = { maxNotes: 5, maxSkills: 2 };

function file(title: string, description: string, body: string): string {
  return `---\ntitle: ${title}\ndescription: ${description}\n---\n${body}\n`;
}

const goodNote = { path: "notes/build-command.md", content: file("Build command", "The project builds with make all.", "Run `make all` from the root.") };
const goodSkill = { path: "skills/release.md", content: file("Cut a release", "How to cut a release.", "1. Bump the version.\n2. Tag it.") };

function proposal(files: { path: string; content: string }[], jobFinished = true): Json {
  return { job_finished: jobFinished, files };
}

// Credential-shaped strings, assembled so this file holds no literal token.
const SECRETS: Record<string, string> = {
  "sk- key": `sk-${"a1B2c3D4e5".repeat(3)}`,
  "sk-ant- key": `sk-ant-${"api03xYz".repeat(4)}`,
  "AWS id": `AKIA${"ABCDEFGH12345678"}`,
  "ghp token": `ghp_${"Ab1".repeat(12)}`,
  "github_pat token": `github_pat_${"11AB22cd".repeat(4)}`,
  "slack token": `xoxb-${"1234567890"}-abcdefghij`,
  "private key": `-----BEGIN ${"RSA PRIVATE"} KEY-----\nMIIB...`,
  "bearer token": `Authorization: Bearer ${"q8Zr4Tn2Lm".repeat(3)}`,
  "JWT": `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${"SflKxwRJSMeKKF2QT4f"}`,
};

test("each secret pattern anywhere drops the whole proposal, and the reason does not quote it", () => {
  for (const [name, secret] of Object.entries(SECRETS)) {
    const places: { path: string; content: string }[][] = [
      [goodNote, { path: "notes/other.md", content: file("Other", "Another fact.", `The key is ${secret} here.`) }],
      [{ ...goodNote, content: file("Build command", `uses ${secret.split("\n")[0] as string}`, "body") }, goodSkill],
    ];
    for (const files of places) {
      const result = checkProposal(proposal(files), LIMITS);
      assert.notEqual(result.dropAll, null, `${name} should drop the proposal`);
      assert.deepEqual(result.items, [], name);
      assert.ok(!(result.dropAll as string).includes(secret.slice(0, 12)), `${name}: reason must not contain the secret`);
    }
  }
});

test("a secret in a path drops the whole proposal", () => {
  const path = `notes/${SECRETS["sk- key"] as string}.md`;
  const result = checkProposal(proposal([goodNote, { path, content: goodNote.content }]), LIMITS);
  assert.match(result.dropAll ?? "", /files\[1\]\.path/);
});

test("a handed secret, plain or base64, anywhere drops the whole proposal", () => {
  const value = "handed-value-1234567";
  const redactor = createRedactor({ DEPLOY_TOKEN: value });
  for (const form of [value, Buffer.from(value).toString("base64")]) {
    const files = [goodNote, { path: "notes/deploy.md", content: file("Deploy", "Deploying.", `use ${form} to deploy`) }];
    const result = checkProposal(proposal(files), { ...LIMITS, redactor });
    assert.equal(result.dropAll, "the handed secret DEPLOY_TOKEN was found in files[1].content");
    assert.ok(!result.dropAll.includes(value));
  }
  const marker = checkProposal(proposal([{ ...goodNote, content: file("T", "D", "token [redacted:DEPLOY_TOKEN]") }]), LIMITS);
  assert.match(marker.dropAll ?? "", /handed secret DEPLOY_TOKEN/);
});

test("each hidden or bidirectional-control character class drops the whole proposal", () => {
  const samples = [0x200b, 0x200f, 0x202a, 0x202e, 0x2060, 0x2064, 0x2066, 0x2069, 0xfeff, 0x00ad, 0xe0001, 0xe007f, 0x00, 0x07, 0x1b, 0x7f, 0x85, 0x9f];
  for (const code of samples) {
    const char = String.fromCodePoint(code);
    const result = checkProposal(proposal([goodSkill, { ...goodNote, content: file("Build", "desc", `run make${char} all`) }]), LIMITS);
    assert.match(result.dropAll ?? "", /hidden or bidirectional-control character/, code.toString(16));
    assert.deepEqual(findHiddenCharacters(`a${char}b${char}`), [code]);
  }
  assert.deepEqual(findHiddenCharacters("tabs\tand\nnewlines\r\nare fine — ünïcode too"), []);
});

test("bidirectional controls, separators, default-ignorable code points and annotation controls drop the whole proposal", () => {
  const samples = [
    0x061c, 0x180e, 0x2028, 0x2029, 0x2065, 0x206a, 0x206f, 0xfff9, 0xfffa, 0xfffb, 0x115f, 0x1160, 0x3164, 0xffa0, 0x034f,
    0xfe00, 0xfe0e, 0xfe0f, 0xe0100, 0xe01ef, 0x1d173,
  ];
  for (const code of samples) {
    const char = String.fromCodePoint(code);
    const result = checkProposal(proposal([goodSkill, { ...goodNote, content: file("Build", "desc", `run make${char} all`) }]), LIMITS);
    assert.match(result.dropAll ?? "", /hidden or bidirectional-control character/, code.toString(16));
    assert.deepEqual(findHiddenCharacters(`a${char}b${char}`), [code], code.toString(16));
  }
});

test("a presentation selector directly after a pictograph is allowed; anywhere else it is reported", () => {
  for (const body of ["Watch for \u26A0\uFE0F before you deploy.", "We \u2764\uFE0E this build.", "Done \u2705 and shipped \u{1F680}."]) {
    assert.deepEqual(findHiddenCharacters(body), [], body);
    const result = checkProposal(proposal([goodSkill, { ...goodNote, content: file("Build", "desc", body) }]), LIMITS);
    assert.equal(result.dropAll, null, body);
  }
  assert.deepEqual(findHiddenCharacters("a\uFE0F"), [0xfe0f]);
  assert.deepEqual(findHiddenCharacters("\u26A0\uFE0F\uFE0F"), [0xfe0f], "a second selector after an allowed one");
  assert.deepEqual(findHiddenCharacters("\uFE0E at the start"), [0xfe0e]);
  assert.deepEqual(findHiddenCharacters("tab\tlf\ncr\r café naïve 日本語 中文 한국어 \u{1F600}"), []);
});

test("scanForSecrets ignores ordinary prose", () => {
  assert.equal(scanForSecrets("Ask the risk-averse reviewer; the bearer of bad news is the ask-person tool."), null);
  assert.equal(scanForSecrets("Use the sk-1 shortcut"), null);
});

test("each per-item rule drops only that item", () => {
  const long = "x".repeat(81);
  const cases: { name: string; entry: { path: string; content: string }; reason: RegExp; jobFinished?: boolean }[] = [
    { name: "traversal", entry: { path: "notes/../secrets.md", content: goodNote.content }, reason: /traversal/ },
    { name: "absolute", entry: { path: "/etc/notes/x.md", content: goodNote.content }, reason: /absolute/ },
    { name: "backslash", entry: { path: "notes\\x.md", content: goodNote.content }, reason: /backslash/ },
    { name: "wrong folder", entry: { path: "docs/x.md", content: goodNote.content }, reason: /outside the learning area/ },
    { name: "nested", entry: { path: "notes/a/b.md", content: goodNote.content }, reason: /notes\/<name>\.md/ },
    { name: "bad name", entry: { path: "notes/Bad_Name.md", content: goodNote.content }, reason: /name must match/ },
    { name: "not md", entry: { path: "notes/x.txt", content: goodNote.content }, reason: /\.md/ },
    { name: "missing front matter", entry: { path: "notes/x.md", content: "just a body" }, reason: /missing front matter/ },
    { name: "unclosed front matter", entry: { path: "notes/x.md", content: "---\ntitle: a\n" }, reason: /malformed/ },
    { name: "no description", entry: { path: "notes/x.md", content: "---\ntitle: a\n---\nbody" }, reason: /no description/ },
    { name: "unknown key", entry: { path: "notes/x.md", content: "---\ntitle: a\ndescription: b\nrun: c\n---\nbody" }, reason: /unknown key/ },
    { name: "long title", entry: { path: "notes/x.md", content: file(long, "d", "body") }, reason: /title is over 80/ },
    { name: "empty description", entry: { path: "notes/x.md", content: "---\ntitle: a\ndescription:\n---\nbody" }, reason: /description is empty/ },
    { name: "multi-line description", entry: { path: "notes/x.md", content: "---\ntitle: a\ndescription: one\n  two\n---\nbody" }, reason: /one line/ },
    { name: "long description", entry: { path: "notes/x.md", content: file("a", "d".repeat(161), "body") }, reason: /over 160/ },
    { name: "empty body", entry: { path: "notes/x.md", content: file("a", "d", "") }, reason: /body is empty/ },
    { name: "oversize note body", entry: { path: "notes/x.md", content: file("a", "d", "y".repeat(2001)) }, reason: /over 2000 bytes/ },
    { name: "oversize skill body", entry: { path: "skills/x.md", content: file("a", "d", "y".repeat(8001)) }, reason: /over 8000 bytes/ },
    { name: "duplicate", entry: { ...goodNote }, reason: /duplicate/ },
  ];
  for (const c of cases) {
    const result = checkProposal(proposal([goodNote, c.entry, goodSkill]), LIMITS);
    assert.equal(result.dropAll, null, c.name);
    assert.deepEqual(result.items.map((i) => i.path), ["notes/build-command.md", "skills/release.md"], c.name);
    assert.equal(result.dropped.length, 1, c.name);
    assert.match((result.dropped[0] as { reason: string }).reason, c.reason, c.name);
  }
});

test("a skill is dropped alone when job_finished is false", () => {
  const result = checkProposal(proposal([goodNote, goodSkill], false), LIMITS);
  assert.deepEqual(result.items.map((i) => i.path), ["notes/build-command.md"]);
  assert.match((result.dropped[0] as { reason: string }).reason, /job_finished/);
});

test("items over the count limits are dropped and the rest kept", () => {
  const notes = Array.from({ length: 7 }, (_, i) => ({ path: `notes/n${i}.md`, content: file(`N${i}`, "d", `fact ${i}`) }));
  const skills = Array.from({ length: 3 }, (_, i) => ({ path: `skills/s${i}.md`, content: file(`S${i}`, "d", `step ${i}`) }));
  const result = checkProposal(proposal([...notes, ...skills]), LIMITS);
  assert.deepEqual(result.items.map((i) => i.path), ["notes/n0.md", "notes/n1.md", "notes/n2.md", "notes/n3.md", "notes/n4.md", "skills/s0.md", "skills/s1.md"]);
  assert.deepEqual(result.dropped.map((d) => d.path), ["notes/n5.md", "notes/n6.md", "skills/s2.md"]);
});

test("a path a person retired is not proposed again", () => {
  const result = checkProposal(proposal([goodNote, goodSkill]), { ...LIMITS, existing: { "notes/build-command.md": "retired", "skills/release.md": "active" } });
  assert.deepEqual(result.items.map((i) => i.path), ["skills/release.md"]);
  assert.match((result.dropped[0] as { reason: string }).reason, /retired/);
});

test("a clean proposal passes whole", () => {
  const result = checkProposal(proposal([goodNote, goodSkill]), LIMITS);
  assert.equal(result.dropAll, null);
  assert.deepEqual(result.dropped, []);
  assert.deepEqual(result.items, [
    { path: "notes/build-command.md", kind: "note", name: "build-command", title: "Build command", description: "The project builds with make all.", body: "Run `make all` from the root." },
    { path: "skills/release.md", kind: "skill", name: "release", title: "Cut a release", description: "How to cut a release.", body: "1. Bump the version.\n2. Tag it." },
  ]);
  assert.equal(result.jobFinished, true);
});

test("a malformed proposal is dropped whole; malformed entries alone", () => {
  assert.notEqual(checkProposal({ notes: [] }, LIMITS).dropAll, null);
  const result = checkProposal({ job_finished: true, files: [goodNote, { path: 3, content: "x" }] }, LIMITS);
  assert.equal(result.items.length, 1);
  assert.equal((result.dropped[0] as { path: string }).path, "files[1]");
});

test("parseItemPath and parseItemFile", () => {
  assert.deepEqual(parseItemPath("skills/deploy-app.md"), { ok: true, kind: "skill", name: "deploy-app", path: "skills/deploy-app.md" });
  assert.equal(parseItemPath("C:/notes/x.md").ok, false);
  assert.deepEqual(parseItemFile("---\r\ntitle: T\r\ndescription: D\r\n---\r\n\r\nBody\r\n"), { ok: true, title: "T", description: "D", body: "Body" });
});

test("each malformed entry is dropped alone with its reason", () => {
  const cases: { name: string; entry: Json; label: string; reason: RegExp }[] = [
    { name: "a string", entry: "notes/x.md", label: "files[1]", reason: /^the entry is not an object \{path, content\}$/ },
    { name: "a number", entry: 7, label: "files[1]", reason: /not an object/ },
    { name: "null", entry: null, label: "files[1]", reason: /not an object/ },
    { name: "an array", entry: [goodNote.path, goodNote.content], label: "files[1]", reason: /not an object/ },
    { name: "an extra key", entry: { path: "notes/x.md", content: goodNote.content, title: "x" }, label: "notes/x.md", reason: /^the entry has a key other than path and content$/ },
    { name: "a numeric content", entry: { path: "notes/x.md", content: 42 }, label: "notes/x.md", reason: /string path and a string content/ },
    { name: "an object content", entry: { path: "notes/x.md", content: { body: "x" } }, label: "notes/x.md", reason: /string path and a string content/ },
    { name: "a missing content", entry: { path: "notes/x.md" }, label: "notes/x.md", reason: /string path and a string content/ },
    { name: "a numeric path", entry: { path: 3, content: goodNote.content }, label: "files[1]", reason: /string path and a string content/ },
  ];
  for (const c of cases) {
    const result = checkProposal({ job_finished: true, files: [goodNote, c.entry, goodSkill] }, LIMITS);
    assert.equal(result.dropAll, null, c.name);
    assert.deepEqual(result.items.map((i) => i.path), ["notes/build-command.md", "skills/release.md"], c.name);
    assert.deepEqual(result.dropped.map((d) => d.path), [c.label], c.name);
    assert.match((result.dropped[0] as { reason: string }).reason, c.reason, c.name);
  }
});

test("entries past the first 50 are dropped for the limit; the first 50 are judged as usual", () => {
  const notes = Array.from({ length: 53 }, (_, i) => ({ path: `notes/n${i}.md`, content: file(`N${i}`, "d", `fact ${i}`) }));
  const result = checkProposal(proposal(notes), { maxNotes: 60, maxSkills: 2 });
  assert.equal(result.items.length, 50);
  assert.deepEqual(result.dropped, [50, 51, 52].map((i) => ({ path: `notes/n${i}.md`, reason: "over the limit of 50 files per proposal" })));
  const malformedLate = checkProposal({ job_finished: true, files: [...notes.slice(0, 50), 9] }, { maxNotes: 60, maxSkills: 2 });
  assert.deepEqual(malformedLate.dropped, [{ path: "files[50]", reason: "over the limit of 50 files per proposal" }]);
});

test("a secret or hidden character in any string of any entry, whatever its shape, drops the whole proposal", () => {
  const secret = SECRETS["sk- key"] as string;
  const shapes: { name: string; entry: Json; where: string }[] = [
    { name: "nested content", entry: { path: "notes/x.md", content: { nested: { deeper: [`key ${secret}`] } } }, where: "files[1]" },
    { name: "an extra key's value", entry: { path: "notes/x.md", content: goodNote.content, extra: secret }, where: "files[1]" },
    { name: "an extra key's name", entry: { path: "notes/x.md", content: goodNote.content, [secret]: 1 }, where: "files[1]" },
    { name: "a bare string entry", entry: `note ${secret}`, where: "files[1]" },
    { name: "an array entry", entry: [1, [secret]], where: "files[1]" },
    { name: "the content", entry: { path: "notes/x.md", content: file("a", "b", secret) }, where: "files[1].content" },
  ];
  for (const s of shapes) {
    const result = checkProposal({ job_finished: true, files: [goodNote, s.entry] }, LIMITS);
    assert.ok(result.dropAll !== null, s.name);
    assert.ok(result.dropAll.endsWith(`was found in ${s.where}`), `${s.name}: ${result.dropAll}`);
    assert.ok(!result.dropAll.includes(secret.slice(3)), `${s.name}: the reason does not quote the secret`);
    assert.deepEqual([result.items, result.dropped], [[], []], s.name);
  }
  const late = Array.from({ length: 50 }, () => goodNote);
  const pastLimit = checkProposal({ job_finished: true, files: [...late, { path: "notes/y.md", content: { x: secret } }] }, LIMITS);
  assert.match(pastLimit.dropAll ?? "", /files\[50\]$/, "entries past the limit are scanned too");
  const hidden = checkProposal({ job_finished: true, files: [goodNote, { path: "notes/x.md", content: { text: "a‮b" } }] }, LIMITS);
  assert.match(hidden.dropAll ?? "", /hidden or bidirectional-control character \(U\+202E\) was found in files\[1\]$/);
  const hiddenKey = checkProposal({ job_finished: true, files: [{ ...goodNote, "x​y": "z" }] }, LIMITS);
  assert.match(hiddenKey.dropAll ?? "", /U\+200B\) was found in files\[0\]$/);
});

test("the proposal schema checks the envelope only; the system prompt states the entry shape", () => {
  const entries: Json[] = [goodNote, { path: "notes/x.md", content: 42 }, "text", { path: "notes/y.md", content: "c", extra: 1 }, ...Array.from({ length: 60 }, () => goodNote)];
  assert.deepEqual(validateSchema(PROPOSAL_SCHEMA, { job_finished: true, files: entries }), []);
  for (const bad of [{ files: [] }, { job_finished: true }, { job_finished: "yes", files: [] }, { job_finished: true, files: {} }, { job_finished: true, files: [], other: 1 }]) {
    assert.ok(validateSchema(PROPOSAL_SCHEMA, bad as Json).length > 0, JSON.stringify(bad));
  }
  assert.match(PROPOSAL_SYSTEM, /Each entry of "files" is an object with exactly two keys: a string "path" and a string "content" \(at most 50 entries\)/);
});

// ---------------------------------------------------------------- R13D-learning-03: a huge entry never aborts the checks

const HUGE = 150_000;

test("an entry that is an array of 150 000 values is dropped alone; the valid note survives", () => {
  const result = checkProposal({ job_finished: true, files: [goodNote, Array.from({ length: HUGE }, () => null)] } as Json, LIMITS);
  assert.equal(result.dropAll, null);
  assert.deepEqual(result.items.map((i) => i.path), [goodNote.path]);
  assert.deepEqual(result.dropped, [{ path: "files[1]", reason: "the entry is not an object {path, content}" }]);
});

test("a 150 000-element array nested inside an entry object is dropped alone", () => {
  const nested = { path: "notes/big.md", content: { rows: Array.from({ length: HUGE }, (_, i) => i) } };
  const result = checkProposal({ job_finished: true, files: [goodNote, nested] } as unknown as Json, LIMITS);
  assert.equal(result.dropAll, null);
  assert.deepEqual(result.items.map((i) => i.path), [goodNote.path]);
  assert.deepEqual(result.dropped, [{ path: "notes/big.md", reason: "a file needs a string path and a string content" }]);
});

test("a secret hidden as the last string of a 150 000-element array still drops the whole proposal", () => {
  const values: Json[] = Array.from({ length: HUGE }, () => null);
  values.push(`token ${SECRETS["sk- key"] as string}`);
  for (const entry of [values, { path: "notes/big.md", content: { rows: values } }] as Json[]) {
    const result = checkProposal({ job_finished: true, files: [goodNote, entry] } as Json, LIMITS);
    assert.match(result.dropAll ?? "", /was found in files\[1\]$/);
    assert.deepEqual(result.items, []);
  }
});

// ---------------------------------------------------------------- R14D-spec-02: every redaction marker is a secret

const STORED_KEY = `sk-${"Zq9Xw8Vu7T".repeat(3)}`;
const STORED_PLAIN = "another-agents-plain-value-4471";

/** A secrets service that holds two stored secrets the run's agent is not handed, as a process that set them would. */
async function processWide(t: TestContext): Promise<SecretsService> {
  const { store } = await openTestStore(t);
  const secrets = await createSecretsService({ store, sealKey: generateSealKey() });
  await secrets.set("OTHER_AGENT_KEY", STORED_KEY);
  await secrets.set("OTHER_PLAIN", STORED_PLAIN);
  return secrets;
}

/** The proposal as the learning step reads it back: committed through the store wrapper's batch redaction. */
function asStored(secrets: SecretsService, output: Json): Json {
  const batch = createWriteRedaction(secrets).batch({ records: [{ type: "model.finished", key: "learning/propose", data: { output } }] });
  return (batch.records[0]?.data as { output: Json }).output;
}

test("the reviewer's probe: a stored secret the agent was not handed, already redacted to [redacted], drops the whole proposal", async (t) => {
  const secrets = await processWide(t);
  const handed = createRedactor({ DEPLOY_TOKEN: "the-handed-token-0001" });
  for (const secret of [STORED_KEY, STORED_PLAIN]) {
    const raw = proposal([goodNote, { path: "notes/login.md", content: file("Login", "How to log in.", `Log in with ${secret} first.`) }, goodSkill]);
    const stored = asStored(secrets, raw);
    assert.ok(!JSON.stringify(stored).includes(secret), "the text the check sees is already redacted");
    assert.ok(JSON.stringify(stored).includes(REDACTED_MARKER));
    const result = checkProposal(stored, { ...LIMITS, redactor: handed });
    assert.equal(result.dropAll, "a redacted secret was found in files[1].content");
    assert.deepEqual(result.items, [], "no item survives");
    assert.deepEqual(result.dropped, []);
  }
});

test("marker conformance: what every redactor writes in place of a secret is found by the scan", async (t) => {
  const secrets = await processWide(t);
  const value = "conformance-secret-9081";
  const runRedactor = createGrowingRedactor({ RUN_KEY: value });
  runRedactor.add("RUN_KEY", "conformance-rotated-9082");
  const outputs: { label: string; text: string }[] = [
    { label: "the run's redactor", text: runRedactor.text(`use ${value} now`) },
    { label: "the run's redactor, rotated value", text: runRedactor.text("conformance-rotated-9082") },
    { label: "the run's redactor, payload", text: JSON.stringify(runRedactor.payload({ v: Buffer.from(value).toString("base64") })) },
    { label: "the run's stream redactor", text: ((s) => s.push(`a ${value.slice(0, 5)}`) + s.push(`${value.slice(5)} b`) + s.flush())(runRedactor.stream()) },
    { label: "a fixed redactor", text: createRedactor({ FIXED: value }).text(value) },
    { label: "the process-wide set", text: secrets.redactText(`key ${STORED_PLAIN}`) },
    { label: "the process-wide set, JSON", text: JSON.stringify(secrets.redactJson({ [STORED_PLAIN]: 1 })) },
    { label: "the process-wide set, a number", text: JSON.stringify((await (async () => {
      await secrets.set("PIN_CODE", "12345678");
      return secrets.redactPayload({ pin: 9123456789 });
    })())) },
    { label: "intake", text: await createWriteRedaction(secrets).text(`answer ${STORED_KEY}`) },
    { label: "the commit batch", text: JSON.stringify(asStored(secrets, { note: STORED_PLAIN })) },
    { label: "a provider error text", text: cleanProviderText(`bad key ${STORED_KEY}`, STORED_KEY) },
  ];
  for (const { label, text } of outputs) {
    assert.ok(!text.includes(value) && !text.includes(STORED_PLAIN) && !text.includes(STORED_KEY), `${label} redacted: ${text}`);
    assert.notEqual(scanForSecrets(text), null, `${label} wrote a marker the scan does not know: ${text}`);
  }
  assert.equal(scanForSecrets(runRedactor.text(value)), "the handed secret RUN_KEY");
  assert.equal(scanForSecrets(secrets.redactText(STORED_PLAIN)), "a redacted secret");
});

test("a marker in a title, a description, a name, a nested entry or a key drops the whole proposal", () => {
  for (const marker of [REDACTED_MARKER, "[redacted:SOME_KEY]"]) {
    const cases: { name: string; files: Json[] }[] = [
      { name: "title", files: [goodNote, { path: "notes/t.md", content: file(`Use ${marker}`, "A fact.", "Body.") }] },
      { name: "description", files: [goodSkill, { path: "notes/d.md", content: file("Title", `the key is ${marker}`, "Body.") }] },
      { name: "name", files: [goodNote, { path: `notes/${marker}.md`, content: goodNote.content }] },
      { name: "nested array entry", files: [goodNote, { path: "notes/n.md", content: goodNote.content, extra: [["fine", [`deep ${marker}`]]] }] },
      { name: "object key", files: [goodNote, { [`k${marker}`]: "v" }] },
      { name: "entry that is a bare string", files: [goodNote, marker] },
    ];
    for (const c of cases) {
      const result = checkProposal({ job_finished: true, files: c.files } as Json, LIMITS);
      assert.notEqual(result.dropAll, null, `${marker} in the ${c.name}`);
      assert.match(result.dropAll as string, marker === REDACTED_MARKER ? /^a redacted secret was found in files\[1\]/ : /^the handed secret SOME_KEY was found in files\[1\]/);
      assert.deepEqual(result.items, [], `${marker} in the ${c.name}: nothing survives`);
    }
  }
});

test("the word redacted without a marker is not a finding", () => {
  for (const text of [
    "The report was redacted by legal.", "redacted", "[redacted", "redacted]", "[ redacted ]", "[REDACTED]", "[redacted:]",
    "(redacted)", "[unredacted]", `[redacted:${"N".repeat(129)}]`, "[redacted:two\nlines]",
  ]) {
    assert.equal(scanForSecrets(text), null, text);
  }
  assert.equal(scanForSecrets("[redacted:any name.v2]"), "a redacted secret", "a named marker of any name is found");
  const awsId = `AKIA${"QWERTYUI12345678"}`;
  assert.equal(scanForSecrets(`[redacted:${awsId}]`), "a redacted secret", "a credential-shaped name is never quoted");
  assert.equal(scanForSecrets("[redacted:DEPLOY_TOKEN]"), "the handed secret DEPLOY_TOKEN");
  const result = checkProposal(proposal([goodNote, { path: "notes/legal.md", content: file("Legal", "What legal does.", "Legal redacted the names.") }]), LIMITS);
  assert.equal(result.dropAll, null);
  assert.equal(result.items.length, 2);
});

test("the marker scan is linear in the text length", () => {
  const long = `${"[redacted:".repeat(200_000)}x`;
  const started = performance.now();
  assert.equal(scanForSecrets(long), null);
  assert.ok(performance.now() - started < 2_000, "a long run of unterminated markers is scanned quickly");
});

test("(R15D-store-02) an unpaired surrogate is a hidden character and drops the whole proposal; a paired one is text", () => {
  for (const [char, code] of [["\ud800", 0xd800], ["\udfff", 0xdfff]] as const) {
    const result = checkProposal(proposal([goodSkill, { ...goodNote, content: file("Build", "desc", `run make${char} all`) }]), LIMITS);
    assert.match(result.dropAll ?? "", /hidden or bidirectional-control character \(U\+D[8F]/, code.toString(16));
    assert.deepEqual(findHiddenCharacters(`a${char}b${char}`), [code]);
  }
  assert.deepEqual(findHiddenCharacters("a 🚀 rocket and \u{1F600}"), []);
  assert.deepEqual(findHiddenCharacters("🚀\udc00"), [0xdc00], "a low surrogate after a pair is unpaired");
});
