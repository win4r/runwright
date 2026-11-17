import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSchema } from "../../src/schema/validate.ts";
import { checkDecisionValue, decisionSchema } from "../../src/workflow/decision.ts";

test("decision schemas", () => {
  const yes = decisionSchema({ type: "yes_no" });
  assert.deepEqual(yes["required"], ["value", "confidence"]);
  assert.equal(yes["additionalProperties"], false);
  assert.deepEqual(validateSchema(yes, { value: true, confidence: 0.9, reason: "ok" }), []);
  assert.ok(validateSchema(yes, { value: "yes", confidence: 0.9 }).length > 0);
  assert.ok(validateSchema(yes, { value: true, confidence: 1.5 }).length > 0);
  assert.ok(validateSchema(yes, { value: true, confidence: 0.5, extra: 1 }).length > 0);
  const pick = decisionSchema({ type: "pick_one", options: ["a", "b"] });
  assert.deepEqual(validateSchema(pick, { value: "b", confidence: 0 }), []);
  assert.ok(validateSchema(pick, { value: "c", confidence: 0 }).length > 0);
  const score = decisionSchema({ type: "score", min: 1, max: 5 });
  assert.deepEqual(validateSchema(score, { value: 5, confidence: 1 }), []);
  assert.ok(validateSchema(score, { value: 6, confidence: 1 }).length > 0);
});

test("checkDecisionValue", () => {
  assert.equal(checkDecisionValue({ type: "yes_no" }, false), true);
  assert.equal(checkDecisionValue({ type: "yes_no" }, "no"), false);
  assert.equal(checkDecisionValue({ type: "pick_one", options: ["a", "b"] }, "a"), true);
  assert.equal(checkDecisionValue({ type: "pick_one", options: ["a", "b"] }, "z"), false);
  assert.equal(checkDecisionValue({ type: "score", min: 0, max: 10 }, 10), true);
  assert.equal(checkDecisionValue({ type: "score", min: 0, max: 10 }, -1), false);
  assert.equal(checkDecisionValue({ type: "score", min: 0, max: 10 }, "5"), false);
});
