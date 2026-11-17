import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RUN_STATUSES, TERMINAL_STATUSES, TRANSITIONS, assertTransition, canTransition, isTerminal,
} from "../../src/store/state-machine.ts";
import { isRunwrightError } from "../../src/core/errors.ts";
import type { RunStatus } from "../../src/store/types.ts";

const LEGAL: [RunStatus, RunStatus][] = [
  ["queued", "running"],
  ["running", "running"],
  ["running", "waiting"],
  ["running", "paused"],
  ["running", "queued"],
  ["running", "completed"],
  ["running", "failed"],
  ["running", "cancelled"],
  ["waiting", "queued"],
  ["paused", "queued"],
];

test("statuses and terminal set", () => {
  assert.deepEqual([...RUN_STATUSES], ["queued", "running", "waiting", "paused", "completed", "failed", "cancelled"]);
  assert.deepEqual([...TERMINAL_STATUSES], ["completed", "failed", "cancelled"]);
  for (const s of RUN_STATUSES) assert.equal(isTerminal(s), TERMINAL_STATUSES.includes(s));
});

test("every legal transition is allowed and every other pair is rejected", () => {
  const legal = new Set(LEGAL.map(([a, b]) => `${a}>${b}`));
  for (const from of RUN_STATUSES) {
    for (const to of RUN_STATUSES) {
      const expected = legal.has(`${from}>${to}`);
      assert.equal(canTransition(from, to), expected, `${from} -> ${to}`);
      assert.equal(TRANSITIONS[from].includes(to), expected);
      if (expected) assertTransition(from, to);
      else assert.throws(() => assertTransition(from, to), (e: unknown) => isRunwrightError(e) && e.code === "illegal_transition");
    }
  }
  assert.equal(canTransition("bogus" as RunStatus, "queued"), false);
});
