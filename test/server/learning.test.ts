import { test } from "node:test";
import assert from "node:assert/strict";
import type { LearningItem } from "../../src/store/types.ts";
import { seedLearningItems } from "../helpers/learning.ts";
import { authed, errorOf, seedRun, startTestServer, type TestServer } from "./support.ts";

async function seedItems(s: TestServer): Promise<{ active: LearningItem; held: LearningItem }> {
  await seedRun(s.store, "learner");
  const [active, held] = await seedLearningItems(s.store, "learner", [
    { kind: "note", name: "build-cmd", title: "Build command", description: "How to build", body: "npm run build", status: "active" },
    { kind: "skill", name: "deploy", title: "Deploy", description: "How to deploy", body: "steps", status: "held" },
  ]);
  return { active: active as LearningItem, held: held as LearningItem };
}

test("items are listed with filters and fetched with an ETag", async (t) => {
  const s = await startTestServer(t);
  const { active, held } = await seedItems(s);
  assert.equal((await s.client.listLearning()).length, 2);
  assert.deepEqual((await s.client.listLearning({ status: "held" })).map((i) => i.id), [held.id]);
  assert.deepEqual((await s.client.listLearning({ kind: "note", agentId: "learner" })).map((i) => i.id), [active.id]);
  assert.equal((await errorOf(await authed(s, "/v1/learning?status=gone"))).code, "bad_request");
  const response = await authed(s, `/v1/learning/${active.id}`);
  assert.equal(response.headers.get("etag"), `"${active.etag}"`);
  assert.equal(((await response.json()) as { item: LearningItem }).item.id, active.id);
  assert.equal((await errorOf(await authed(s, "/v1/learning/lrn_nope"))).status, 404);
  assert.equal((await errorOf(await authed(s, "/v1/learning/lrn_nope/history"))).status, 404);
});

test("retire needs If-Match (428), rejects a stale ETag (412) and works with the current one", async (t) => {
  const s = await startTestServer(t);
  const { active } = await seedItems(s);
  const missing = await errorOf(await authed(s, `/v1/learning/${active.id}/retire`, { method: "POST" }));
  assert.equal(missing.status, 428);
  assert.equal(missing.code, "precondition_required");
  const stale = await errorOf(await authed(s, `/v1/learning/${active.id}/retire`, { method: "POST", headers: { "If-Match": '"0-deadbeef"' } }));
  assert.equal(stale.status, 412);
  assert.equal(stale.code, "etag_mismatch");

  const response = await authed(s, `/v1/learning/${active.id}/retire`, { method: "POST", headers: { "If-Match": active.etag } });
  assert.equal(response.status, 200);
  const retired = ((await response.json()) as { item: LearningItem }).item;
  assert.equal(retired.status, "retired");
  assert.notEqual(retired.etag, active.etag);
  assert.equal(response.headers.get("etag"), `"${retired.etag}"`);

  const again = await errorOf(await authed(s, `/v1/learning/${active.id}/retire`, { method: "POST", headers: { "If-Match": `"${retired.etag}"` } }));
  assert.equal(again.status, 409);

  const restored = await s.client.restoreLearning(active.id, retired.etag);
  assert.equal(restored.status, "active");
  const history = await s.client.learningHistory(active.id);
  assert.deepEqual(history.map((h) => h.action), ["created", "retired", "restored"]);
  assert.ok(history.slice(1).every((h) => h.actor === "person"));
});

test("a held item is approved and any item can be edited, conditionally", async (t) => {
  const s = await startTestServer(t);
  const { held, active } = await seedItems(s);
  const approved = await s.client.approveLearning(held.id, held.etag);
  assert.equal(approved.status, "active");
  const edited = await s.client.editLearning(active.id, `"${active.etag}"`, { body: "npm run build -- --prod" });
  assert.equal(edited.body, "npm run build -- --prod");
  assert.equal(edited.title, "Build command");
  const staleEdit = await errorOf(await authed(s, `/v1/learning/${active.id}`, { method: "PATCH", json: { title: "x" }, headers: { "If-Match": active.etag } }));
  assert.equal(staleEdit.status, 412);
  const emptyEdit = await errorOf(await authed(s, `/v1/learning/${active.id}`, { method: "PATCH", json: {}, headers: { "If-Match": edited.etag } }));
  assert.equal(emptyEdit.code, "validation_failed");
  const noHeader = await errorOf(await authed(s, `/v1/learning/${active.id}`, { method: "PATCH", json: { title: "x" } }));
  assert.equal(noHeader.status, 428);
  assert.equal((await s.client.getLearning(active.id)).etag, edited.etag);
});

const STORED = "plain-stored-secret-99";
const BAD_TEXTS: { name: string; text: string; keyword: string; says: RegExp }[] = [
  { name: "a stored secret", text: `use ${STORED} here`, keyword: "secret", says: /^a stored secret was found in / },
  { name: "an sk- key", text: "key sk-abcdefghijklmnopqrstuvwxyz0123", keyword: "secret", says: /^an API key \(sk-…\) was found in / },
  { name: "a zero-width character", text: "build\u200b now", keyword: "hidden_character", says: /\(U\+200B\) was found in / },
  { name: "a bidi override", text: "safe \u202Etxt.exe", keyword: "hidden_character", says: /\(U\+202E\) was found in / },
];

async function assertRefused(
  s: TestServer, item: LearningItem, path: string, method: "PATCH" | "POST", json: Record<string, string>, field: string,
  bad: (typeof BAD_TEXTS)[number],
): Promise<void> {
  const response = await authed(s, path, { method, json, headers: { "If-Match": `"${item.etag}"` } });
  const text = await response.text();
  assert.equal(response.status, 400, `${bad.name} in ${field}: validation_failed`);
  const body = JSON.parse(text) as { error: { code: string; message: string; details: { problems: { path: string; keyword: string; message: string }[] } } };
  assert.equal(body.error.code, "validation_failed");
  assert.match(body.error.message, bad.says);
  assert.ok(body.error.message.endsWith(` ${field}`), body.error.message);
  assert.deepEqual(body.error.details.problems.map((p) => [p.path, p.keyword]), [[`$.${field}`, bad.keyword]]);
  assert.ok(!text.includes(bad.text) && !text.includes(STORED) && !text.includes("sk-abcdefghij"), "the response never holds the text");
  const now = await s.client.getLearning(item.id);
  assert.equal(now.etag, item.etag, "the item is unchanged");
  assert.deepEqual(now, item);
}

test("an edit carrying a secret, a credential or a hidden character is refused per field; a clean edit works", async (t) => {
  const s = await startTestServer(t);
  await s.client.setSecret("STORED_KEY", STORED);
  const { active } = await seedItems(s);
  const history = (await s.client.learningHistory(active.id)).length;
  for (const field of ["title", "description", "body", "note"]) {
    for (const bad of BAD_TEXTS) {
      const json = field === "note" ? { body: "clean body", note: bad.text } : { [field]: bad.text };
      await assertRefused(s, active, `/v1/learning/${active.id}`, "PATCH", json, field, bad);
    }
  }
  assert.equal((await s.client.learningHistory(active.id)).length, history, "nothing was recorded");
  const edited = await s.client.editLearning(active.id, `"${active.etag}"`, { title: "Build it", body: "npm run build\n\tthen test" });
  assert.equal(edited.title, "Build it");
  assert.notEqual(edited.etag, active.etag);
});

test("the note of retire, restore and approve is checked the same way", async (t) => {
  const s = await startTestServer(t);
  await s.client.setSecret("STORED_KEY", STORED);
  const { active, held } = await seedItems(s);
  for (const bad of BAD_TEXTS) {
    await assertRefused(s, active, `/v1/learning/${active.id}/retire`, "POST", { note: bad.text }, "note", bad);
    await assertRefused(s, held, `/v1/learning/${held.id}/approve`, "POST", { note: bad.text }, "note", bad);
  }
  const retired = (await (await authed(s, `/v1/learning/${active.id}/retire`, {
    method: "POST", json: { note: "outdated" }, headers: { "If-Match": `"${active.etag}"` },
  })).json() as { item: LearningItem }).item;
  assert.equal(retired.status, "retired");
  for (const bad of BAD_TEXTS) await assertRefused(s, retired, `/v1/learning/${active.id}/restore`, "POST", { note: bad.text }, "note", bad);
  const restored = await s.client.restoreLearning(active.id, retired.etag);
  assert.equal(restored.status, "active");
  const approved = await s.client.approveLearning(held.id, held.etag);
  assert.equal(approved.status, "active");
});
