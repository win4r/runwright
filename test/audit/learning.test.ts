/**
 * Brief, section 4, "Learning", checked against wrong implementations the existing tests would let through
 * (finding class R09D-tests-01):
 * - "a bad item is dropped alone" stopped at the store: here the kept item is followed into the next run's
 *   prompt and its `learning.given` record, and the dropped one is shown never to reach it;
 * - "a secret anywhere" never put a secret in the title alone: here a title (and a skill's title) is the only
 *   place the secret is;
 * - "retire/restore with ETag" over HTTP only refused a stale ETag on retire: here a restore with the stale
 *   (pre-retire) ETag is refused and changes nothing.
 * - "run 2 receives run 1's notes" with a stored secret whose value is a field name of the stored step value
 *   (finding R12-02): here the secret is `promptSection`, through both redaction layers.
 * - "a secret anywhere" with a stored secret the agent was not handed (finding R14D-spec-02): the check sees only
 *   the process-wide `[redacted]`, which is itself a finding, so the whole proposal is dropped.
 * - "relevance selection over budget" end to end (rule S2): every item is given, the most relevant one whole.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRedactor } from "../../src/core/redact.ts";
import { checkProposal } from "../../src/learning/checks.ts";
import { renderItem } from "../../src/learning/proposal.ts";
import { textTokens } from "../../src/models/util.ts";
import type { LearningItem } from "../../src/store/types.ts";
import { seedLearningItems } from "../helpers/learning.ts";
import { twoLayerWiring } from "../helpers/two-layer.ts";
import { itemFile, keepAll, learningHarness } from "../learning/support.ts";
import { authed, errorOf, seedRun, startTestServer } from "../server/support.ts";

const GOOD = { path: "notes/deploy.md", content: itemFile("Deploy target", "Where releases go.", "Releases go to the blue cluster via `make ship`.") };
const BAD = { path: "notes/Bad Name!.md", content: itemFile("Bad", "An invalid name.", "This text must never reach a later run: zebra-quartz-9.") };

test("a bad item is dropped alone and the kept item is what the next run is given", async (t) => {
  const h = await learningHarness(t);
  const agent = await h.agent({
    turns: [{ text: "done" }],
    steps: { "learning.propose": { output: { job_finished: true, files: [BAD, GOOD] } }, "learning.grade": keepAll([GOOD.path, BAD.path]) },
  });
  const run1 = await h.start(agent.id, { message: "ship the release" });
  await h.until(run1.id, "completed");
  const checked = (await h.records(run1.id, "learning.checked"))[0];
  assert.equal(checked?.dropAll, null);
  assert.deepEqual(checked?.surviving, [GOOD.path]);
  assert.deepEqual(checked?.dropped.map((d) => d.path), [BAD.path]);

  const [kept] = await h.store.listLearningItems({ agentId: agent.id });
  assert.ok(kept !== undefined);
  const before = h.requests.length;
  const run2 = await h.start(agent.id, { message: "ship it again" });
  await h.until(run2.id, "completed");
  const job = h.requests.slice(before).find((r) => r.meta.purpose === "run" && r.meta.runId === run2.id);
  assert.ok(job !== undefined, "run 2 made a job request");
  assert.ok(job.system.includes("Releases go to the blue cluster"), "the kept note reaches run 2's model");
  assert.ok(!job.system.includes("zebra-quartz-9"), "the dropped item never reaches run 2");
  const given = (await h.records(run2.id, "learning.given"))[0];
  assert.deepEqual(given?.items.map((i) => [i.itemId, i.name, i.mode]), [[kept.id, "deploy", "full"]]);
});

test("run 2 receives run 1's notes with a stored secret equal to promptSection", async (t) => {
  const wiring = twoLayerWiring();
  const h = await learningHarness(t, { twoLayer: { wiring, values: { PROMPT_WORD: "promptSection" } } });
  const agent = await h.agent({
    turns: [{ text: "done" }],
    steps: { "learning.propose": { output: { job_finished: true, files: [GOOD] } }, "learning.grade": keepAll([GOOD.path]) },
  });
  const run1 = await h.start(agent.id, { message: "ship the release" });
  await h.until(run1.id, "completed");
  const [kept] = await h.store.listLearningItems({ agentId: agent.id, status: "active" });
  assert.ok(kept !== undefined, "run 1 kept its note");

  const run2 = await h.start(agent.id, { message: "ship it again" });
  await h.until(run2.id, "completed");
  const job = h.requests.find((r) => r.meta.purpose === "run" && r.meta.runId === run2.id);
  assert.ok(job?.system.includes("Releases go to the blue cluster"), "the note reaches run 2's model");
  const given = (await h.records(run2.id, "learning.given"))[0];
  assert.deepEqual(given?.items.map((i) => [i.itemId, i.name, i.mode]), [[kept.id, "deploy", "full"]]);
  assert.deepEqual(await h.store.learningUses(run2.id), [{ runId: run2.id, itemId: kept.id, version: 1, mode: "full", opened: false }]);
});

test("a secret in the title alone, of a note or of a skill, drops the whole proposal", () => {
  const limits = { maxNotes: 5, maxSkills: 2 };
  const key = `sk-${"Q7w8E9r0T1".repeat(3)}`;
  const handed = "handed-title-value-4455";
  const clean = { path: "notes/clean.md", content: itemFile("Clean", "A clean note.", "Nothing secret here.") };
  const cases = [
    { name: "a note title holding a key", files: [clean, { path: "notes/k.md", content: itemFile(`Use ${key}`, "A fact.", "Body.") }] },
    { name: "a skill title holding a key", files: [{ path: "skills/k.md", content: itemFile(`Login with ${key}`, "How to log in.", "1. Do it.") }, clean] },
    { name: "a note title holding a handed secret", files: [clean, { path: "notes/h.md", content: itemFile(`Token ${handed}`, "A fact.", "Body.") }], handed: true },
  ];
  for (const c of cases) {
    const redactor = c.handed === true ? createRedactor({ TITLE_TOKEN: handed }) : undefined;
    const result = checkProposal({ job_finished: true, files: c.files }, redactor === undefined ? limits : { ...limits, redactor });
    assert.notEqual(result.dropAll, null, c.name);
    assert.deepEqual(result.items, [], `${c.name}: the clean item is dropped too`);
  }
});

test("a restore with the ETag from before the retire is 412 and changes nothing", async (t) => {
  const s = await startTestServer(t);
  await seedRun(s.store, "learner");
  const [active] = await seedLearningItems(s.store, "learner", [
    { kind: "note", name: "build-cmd", title: "Build command", description: "How to build", body: "npm run build", status: "active" },
  ]);
  const item = active as LearningItem;
  const retired = await s.client.retireLearning(item.id, item.etag);
  assert.equal(retired.status, "retired");
  assert.notEqual(retired.etag, item.etag);

  const stale = await errorOf(await authed(s, `/v1/learning/${item.id}/restore`, { method: "POST", headers: { "If-Match": `"${item.etag}"` } }));
  assert.equal(stale.status, 412);
  assert.equal(stale.code, "etag_mismatch");
  const missing = await errorOf(await authed(s, `/v1/learning/${item.id}/restore`, { method: "POST" }));
  assert.equal(missing.status, 428);
  const after = await s.client.getLearning(item.id);
  assert.equal(after.status, "retired");
  assert.equal(after.etag, retired.etag);
  assert.deepEqual((await s.client.learningHistory(item.id)).map((e) => e.action), ["created", "retired"]);

  const restored = await s.client.restoreLearning(item.id, retired.etag);
  assert.equal(restored.status, "active");
});

test("a stored secret the agent was not handed, in a title alone, reaches the check as [redacted] and drops the whole proposal", async (t) => {
  const wiring = twoLayerWiring();
  const stored = "OrchidLedger7731";
  const h = await learningHarness(t, { twoLayer: { wiring, values: { OTHER_AGENT_WORD: stored } } });
  const titled = { path: "notes/ledger.md", content: itemFile(`${stored} totals`, "Where the totals are.", "In the shared sheet.") };
  const agent = await h.agent({
    turns: [{ text: "done" }],
    steps: { "learning.propose": { output: { job_finished: true, files: [GOOD, titled] } }, "learning.grade": keepAll([GOOD.path, titled.path]) },
  });
  const run1 = await h.start(agent.id, { message: "ship the release" });
  await h.until(run1.id, "completed");
  const checked = (await h.records(run1.id, "learning.checked"))[0];
  assert.equal(checked?.dropAll, "a redacted secret was found in files[1].content");
  assert.deepEqual(checked?.surviving, [], "the clean item is dropped too");
  assert.deepEqual(await h.store.listLearningItems({ agentId: agent.id }), []);
  assert.ok(!JSON.stringify(await h.journal(run1.id)).includes(stored));

  const run2 = await h.start(agent.id, { message: "ship it again" });
  await h.until(run2.id, "completed");
  const job = h.requests.find((r) => r.meta.purpose === "run" && r.meta.runId === run2.id);
  assert.ok(job !== undefined);
  assert.ok(!job.system.includes("Releases go to the blue cluster"), "nothing of the dropped proposal reaches run 2");
  assert.deepEqual(await h.records(run2.id, "learning.given"), []);
});

test("relevance selection over budget: the most relevant item is whole and every other item is one line", async (t) => {
  const kiln = { path: "notes/kiln.md", content: itemFile("Kiln firing schedule", "When and how hot to fire.", "Fire at 1240 degrees for six hours.") };
  const alpha = { path: "notes/alpha.md", content: itemFile("Alpha", "About alpha.", "useful alpha ".repeat(50).trim()) };
  const beta = { path: "notes/beta.md", content: itemFile("Beta", "About beta.", "useful beta ".repeat(50).trim()) };
  const files = [alpha, beta, kiln];
  const h = await learningHarness(t, { config: { budgetTokens: 150 } });
  const agent = await h.agent({
    turns: [{ text: "done" }],
    steps: { "learning.propose": { output: { job_finished: true, files } }, "learning.grade": keepAll(files.map((f) => f.path)) },
  });
  await h.until((await h.start(agent.id, { message: "learn the studio notes" })).id, "completed");
  const kept = await h.store.listLearningItems({ agentId: agent.id, status: "active" });
  assert.equal(kept.length, 3, "run 1 kept all three notes");
  assert.ok(textTokens(kept.map((i) => `${renderItem(i)}\n\n`).join("")) > 150, "they do not all fit whole");

  const run2 = await h.start(agent.id, { message: "what is the kiln firing schedule" });
  await h.until(run2.id, "completed");
  const given = (await h.records(run2.id, "learning.given"))[0]?.items ?? [];
  assert.deepEqual(given.map((g) => [g.name, g.mode]), [["kiln", "full"], ["alpha", "line"], ["beta", "line"]],
    "every item is given: the relevant one whole, the rest as lines (ties newest first, then name)");
  const job = h.requests.find((r) => r.meta.purpose === "run" && r.meta.runId === run2.id);
  assert.ok(job?.system.includes("Fire at 1240 degrees for six hours."), "the relevant note's body is in the prompt");
  assert.ok(job?.system.includes("- [note] alpha — Alpha: About alpha."), "a line names the other note");
  assert.ok(!job?.system.includes("useful alpha useful alpha"), "a line is not the body");
  assert.deepEqual((await h.store.learningUses(run2.id)).map((u) => u.mode).sort(), ["full", "line", "line"]);
});
