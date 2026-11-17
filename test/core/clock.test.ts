import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_TIMER_MS, createFakeClock, delay, intervalMs, startTimer, systemClock } from "../../src/core/clock.ts";
import { isRunwrightError } from "../../src/core/errors.ts";

test("system clock reads the time", () => {
  const before = Date.now();
  const now = systemClock.now();
  assert.ok(now >= before && now <= Date.now());
});

test("fake clock advances and sets", () => {
  const clock = createFakeClock(1000);
  assert.equal(clock.now(), 1000);
  clock.advance(250);
  assert.equal(clock.now(), 1250);
  clock.set(5);
  assert.equal(clock.now(), 5);
});

test("delay resolves after the time", async () => {
  const start = Date.now();
  await delay(20);
  assert.ok(Date.now() - start >= 15);
});

test("delay rejects with aborted when the signal aborts", async () => {
  const controller = new AbortController();
  const pending = delay(10_000, controller.signal);
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(pending, (e: unknown) => isRunwrightError(e) && e.code === "aborted");
});

test("delay rejects at once on an aborted signal", async () => {
  await assert.rejects(delay(10_000, AbortSignal.abort()), (e: unknown) => isRunwrightError(e) && e.code === "aborted");
});

// Node turns a timer delay above 2^31 − 1 ms, Infinity or NaN into 1 ms; these pin that no delay is shortened.
const wait = (ms: number): Promise<"waited"> => new Promise((resolve) => setTimeout(() => resolve("waited"), ms));

function watchOverflowWarnings(t: { after(fn: () => void): void }): () => number {
  let count = 0;
  const onWarning = (warning: Error): void => {
    if (warning.name === "TimeoutOverflowWarning") count += 1;
  };
  process.on("warning", onWarning);
  t.after(() => process.off("warning", onWarning));
  return () => count;
}

for (const ms of [2147483648, Number.MAX_SAFE_INTEGER, Infinity]) {
  test(`delay(${ms}) keeps waiting and rejects aborted when its signal aborts`, async (t) => {
    const overflows = watchOverflowWarnings(t);
    const controller = new AbortController();
    const pending = delay(ms, controller.signal);
    const settled = pending.then(() => "resolved", () => "rejected");
    assert.equal(await Promise.race([settled, wait(150)]), "waited");
    controller.abort();
    await assert.rejects(pending, (e: unknown) => isRunwrightError(e) && e.code === "aborted");
    await wait(10);
    assert.equal(overflows(), 0);
  });
}

test("MAX_TIMER_MS is 2^31 - 1", () => {
  assert.equal(MAX_TIMER_MS, 2 ** 31 - 1);
});

test("startTimer with a delay above the limit does not fire, and clear stops it", async (t) => {
  const overflows = watchOverflowWarnings(t);
  let calls = 0;
  const timer = startTimer(() => calls++, 2147483648);
  await wait(150);
  assert.equal(calls, 0);
  timer.clear();
  await wait(50);
  assert.equal(calls, 0);
  assert.equal(overflows(), 0);
});

test("a delay longer than one chunk is waited in full and fires once", async () => {
  const fire = (ms: number, chunkMs: number): Promise<{ elapsed: number; calls: number }> => {
    const start = Date.now();
    let calls = 0;
    let elapsed = -1;
    return new Promise((resolve, reject) => {
      const guard = setTimeout(() => reject(new Error(`startTimer(${ms}, ${chunkMs}) did not fire within 2 s`)), 2000);
      startTimer(() => {
        calls += 1;
        if (calls > 1) return;
        elapsed = Date.now() - start;
        setTimeout(() => {
          clearTimeout(guard);
          resolve({ elapsed, calls });
        }, 80);
      }, ms, chunkMs);
    });
  };
  const [five, two] = await Promise.all([fire(240, 50), fire(100, 50)]);
  assert.equal(five.calls, 1);
  assert.equal(two.calls, 1);
  assert.ok(five.elapsed >= 230, `fired after ${five.elapsed} ms`);
  assert.ok(two.elapsed >= 90, `fired after ${two.elapsed} ms`);
});

test("clear between chunks cancels the rest; clear is idempotent and safe after firing", async () => {
  let calls = 0;
  const timer = startTimer(() => calls++, 300, 50);
  await wait(120);
  timer.clear();
  await wait(300);
  assert.equal(calls, 0);
  timer.clear();
  const fired = startTimer(() => calls++, 0);
  await wait(30);
  assert.equal(calls, 1);
  fired.clear();
  fired.clear();
  assert.equal(calls, 1);
});

test("NaN, zero and negative delays fire once on the next turn; unref returns the handle", async () => {
  const calls = [0, 0, 0];
  const handles = [NaN, 0, -5].map((ms, i) => startTimer(() => (calls[i] = (calls[i] ?? 0) + 1), ms));
  await wait(100);
  assert.deepEqual(calls, [1, 1, 1]);
  const timer = startTimer(() => undefined, 10_000);
  assert.equal(timer.unref(), timer);
  timer.clear();
  for (const handle of handles) handle.clear();
});

test("an unref'd chained timer keeps chaining and fires", async () => {
  let calls = 0;
  startTimer(() => calls++, 60, 20).unref();
  const keepAlive = setTimeout(() => undefined, 1000);
  await wait(200);
  clearTimeout(keepAlive);
  assert.equal(calls, 1);
});

test("intervalMs gives a period setInterval can hold", () => {
  assert.equal(intervalMs(500), 500);
  assert.equal(intervalMs(0), 1);
  assert.equal(intervalMs(-3), 1);
  assert.equal(intervalMs(NaN), 1);
  assert.equal(intervalMs(2.9), 2);
  assert.equal(intervalMs(2147483648), 2147483647);
  assert.equal(intervalMs(Infinity), 2147483647);
  assert.equal(intervalMs(3, 5), 5);
  assert.equal(intervalMs(NaN, 5), 5);
});
