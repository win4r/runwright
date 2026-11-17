import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_QUERY_TERMS, rankBm25, tokenize } from "../../src/learning/bm25.ts";

const docs = [
  { id: "deploy", title: "Deploying to staging", description: "Steps for a staging deploy.", body: "Run the deploy script with the staging flag." },
  { id: "tests", title: "Running tests", description: "How the test suite runs.", body: "Use npm test; the suite needs a database." },
  { id: "db", title: "Database migrations", description: "Migrations run on start.", body: "The database schema is migrated by the app." },
];

test("tokenize keeps Unicode letters and digits, lower-cases, drops one-character tokens", () => {
  assert.deepEqual(tokenize("Ünïcode-Test a B 42 x9 ß"), ["ünïcode", "test", "42", "x9"]);
});

test("the most relevant document ranks first and the title weighs more than the body", () => {
  const ranked = rankBm25("how do I deploy to staging", docs);
  assert.equal(ranked[0]?.id, "deploy");
  assert.ok((ranked[0]?.score ?? 0) > 0);
  const db = rankBm25("database", docs);
  assert.equal(db[0]?.id, "db", "title match beats body-only match");
  assert.equal(db[1]?.id, "tests");
  assert.equal(db[2]?.score, 0);
});

test("scores follow BM25 with k1 1.2, b 0.75 and the documented idf", () => {
  const single = [{ id: "a", title: "", description: "", body: "alpha beta" }, { id: "b", title: "", description: "", body: "gamma delta" }];
  const [top] = rankBm25("alpha", single);
  // N = 2, n = 1 → idf = ln(1 + 1.5 / 1.5) = ln 2; tf = 1, dl = avgdl → tf part = 2.2 / 2.2 = 1.
  assert.equal(top?.id, "a");
  assert.ok(Math.abs((top?.score ?? 0) - Math.log(2)) < 1e-12);
});

test("an empty query or no overlap scores 0 for all and keeps the input order", () => {
  assert.deepEqual(rankBm25("", docs).map((s) => [s.id, s.score]), [["deploy", 0], ["tests", 0], ["db", 0]]);
  assert.deepEqual(rankBm25("zebra", docs).map((s) => s.id), ["deploy", "tests", "db"]);
  assert.deepEqual(rankBm25("anything", []), []);
});

test("only the first 256 distinct words of a query are scored", () => {
  const filler = Array.from({ length: 256 }, (_, i) => `filler${i}`).join(" ");
  assert.equal(MAX_QUERY_TERMS, 256);
  const late = rankBm25(`${filler} database`, docs);
  assert.ok(late.every((s) => s.score === 0), "a word after the first 256 distinct ones is not scored");
  const early = rankBm25(`database ${filler}`, docs);
  assert.equal(early[0]?.id, "db");
  const repeated = rankBm25(`${"filler0 ".repeat(1000)}database`, docs);
  assert.equal(repeated[0]?.id, "db", "repeats count once towards the limit");
});

test("tokenize keeps every character of a script written without spaces as a word", () => {
  assert.deepEqual(tokenize("abc設備def a 校准"), ["abc", "設", "備", "def", "校", "准"]);
  assert.deepEqual(tokenize("テスト의 ok"), ["テ", "ス", "ト", "의", "ok"]);
});

test("an item whose body contains the query's Chinese term ranks first", () => {
  const zh = [
    { id: "deploy", title: "部署", description: "如何部署服务。", body: "运行部署脚本，然后检查日志。" },
    { id: "calibrate", title: "设备", description: "设备的说明。", body: "设备必须每天早晨校准，否则测量结果无效。" },
    { id: "tests", title: "测试", description: "如何运行测试。", body: "测试需要数据库。" },
  ];
  const ranked = rankBm25("怎么校准", zh);
  assert.equal(ranked[0]?.id, "calibrate");
  assert.ok((ranked[0]?.score ?? 0) > 0);
  assert.equal(ranked[1]?.score, 0);
});
