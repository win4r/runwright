import { test } from "node:test";
import assert from "node:assert/strict";
import { createIdSource } from "../../src/core/ids.ts";
import { createFakeClock } from "../../src/core/clock.ts";

test("ids have the documented shape", () => {
  const id = createIdSource().next("run");
  assert.match(id, /^run_[0-9A-HJKMNP-TV-Z]{26}$/);
});

test("ids created in a loop are unique and sort by creation order", () => {
  const ids = createIdSource();
  const made: string[] = [];
  for (let i = 0; i < 10_000; i++) made.push(ids.next("x"));
  assert.equal(new Set(made).size, made.length);
  assert.deepEqual([...made].sort(), made);
});

test("ids within one millisecond increment; later times sort later", () => {
  const clock = createFakeClock(1_700_000_000_000);
  const ids = createIdSource({ clock, randomBytes: (n) => new Uint8Array(n).fill(31) });
  const a = ids.next("p");
  const b = ids.next("p");
  assert.ok(a < b, "increment past an all-max random part carries into time");
  clock.advance(1);
  const c = ids.next("p");
  assert.ok(b < c);
  clock.set(1_600_000_000_000);
  const d = ids.next("p");
  assert.ok(c < d, "a clock that goes backwards still yields increasing ids");
});

test("time part encodes the clock", () => {
  const clock = createFakeClock(0);
  const ids = createIdSource({ clock, randomBytes: (n) => new Uint8Array(n) });
  assert.equal(ids.next("t"), "t_" + "0".repeat(26));
  clock.set(32);
  assert.equal(ids.next("t").slice(2, 12), "0000000010");
});
