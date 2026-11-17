import { test } from "node:test";
import assert from "node:assert/strict";
import { nsToMs, percentile, round3, summarize } from "../../src/bench/stats.ts";

test("nearest-rank percentile on known inputs", () => {
  const samples = [15, 20, 35, 40, 50];
  assert.equal(percentile(samples, 0), 15);
  assert.equal(percentile(samples, 5), 15);
  assert.equal(percentile(samples, 30), 20);
  assert.equal(percentile(samples, 40), 20);
  assert.equal(percentile(samples, 50), 35);
  assert.equal(percentile(samples, 100), 50);
});

test("percentile does not need sorted input and does not reorder it", () => {
  const samples = [9, 1, 5, 3, 7, 2, 8, 4, 6, 10];
  assert.equal(percentile(samples, 50), 5);
  assert.equal(percentile(samples, 99), 10);
  assert.equal(percentile(samples, 90), 9);
  assert.deepEqual(samples, [9, 1, 5, 3, 7, 2, 8, 4, 6, 10]);
});

test("p99 of 1..100 is 99 and of a single sample is that sample", () => {
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(hundred, 99), 99);
  assert.equal(percentile(hundred, 50), 50);
  assert.equal(percentile([0.25], 99), 0.25);
});

test("percentile rejects an empty set and an out-of-range p", () => {
  assert.throws(() => percentile([], 50), { code: "bad_request" });
  assert.throws(() => percentile([1], -1), { code: "bad_request" });
  assert.throws(() => percentile([1], 101), { code: "bad_request" });
  assert.throws(() => percentile([1], Number.NaN), { code: "bad_request" });
});

test("summarize reports samples, p50 and p99 rounded to three decimals", () => {
  assert.deepEqual(summarize([1.23456, 2.5, 3.0004, 10]), { samples: 4, p50: 2.5, p99: 10 });
  assert.equal(round3(0.0001), 0.001);
  assert.equal(round3(0), 0);
  assert.equal(round3(1.23456), 1.235);
});

test("nsToMs converts hrtime differences to fractional milliseconds", () => {
  assert.equal(nsToMs(1_000_000n, 3_500_000n), 2.5);
});
