import { test } from "node:test";
import assert from "node:assert/strict";
import { createEphemeralEvents, type EphemeralEvent } from "../../src/core/events.ts";

test("events reach subscribers of that run only, until they unsubscribe", () => {
  const events = createEphemeralEvents();
  const a: EphemeralEvent[] = [];
  const b: EphemeralEvent[] = [];
  const offA = events.subscribe("run_a", (e) => a.push(e));
  events.subscribe("run_b", (e) => b.push(e));
  const delta: EphemeralEvent = { runId: "run_a", type: "model.delta", key: "t1", text: "hi" };
  events.publish(delta);
  assert.deepEqual(a, [delta]);
  assert.deepEqual(b, []);
  offA();
  offA();
  events.publish(delta);
  assert.equal(a.length, 1);
});

test("a throwing subscriber does not stop the others", () => {
  const events = createEphemeralEvents();
  const seen: string[] = [];
  events.subscribe("r", () => {
    throw new Error("boom");
  });
  events.subscribe("r", (e) => seen.push(e.text));
  events.publish({ runId: "r", type: "model.delta", key: "k", text: "x" });
  assert.deepEqual(seen, ["x"]);
});

test("publishing with no subscribers is a no-op", () => {
  assert.doesNotThrow(() => createEphemeralEvents().publish({ runId: "none", type: "model.delta", key: "k", text: "" }));
});
