import { test } from "node:test";
import assert from "node:assert/strict";
import { ControlSignal, isControlSignal, mapLimit, settleAll } from "../../src/engine/control.ts";

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("ControlSignal carries its reason", () => {
  const signal = new ControlSignal("paused");
  assert.equal(signal.reason, "paused");
  assert.ok(signal instanceof Error);
  assert.equal(isControlSignal(signal), true);
  assert.equal(isControlSignal(new Error("x")), false);
});

test("settleAll resolves values in order", async () => {
  assert.deepEqual(await settleAll([Promise.resolve(1), wait(5).then(() => 2), Promise.resolve(3)]), [1, 2, 3]);
});

test("settleAll waits for every task and rethrows the strongest control signal", async () => {
  let slowDone = false;
  const tasks = [
    Promise.reject(new Error("plain")),
    Promise.reject(new ControlSignal("waiting")),
    wait(20).then(() => {
      slowDone = true;
      throw new ControlSignal("cancelled");
    }),
    Promise.reject(new ControlSignal("paused")),
  ];
  await assert.rejects(settleAll(tasks), (e: unknown) => isControlSignal(e) && e.reason === "cancelled");
  assert.equal(slowDone, true);
  const order = ["waiting", "paused", "released", "cancelled", "lease_lost"] as const;
  for (let i = 0; i < order.length; i++) {
    const signals = order.slice(0, i + 1).map((r) => Promise.reject(new ControlSignal(r)));
    await assert.rejects(settleAll(signals.reverse()), (e: unknown) => isControlSignal(e) && e.reason === order[i]);
  }
});

test("settleAll rethrows the first plain error in task order when there is no signal", async () => {
  const first = new Error("first");
  await assert.rejects(settleAll([wait(10).then(() => { throw first; }), Promise.reject(new Error("second"))]), (e) => e === first);
});

test("mapLimit respects its bound and keeps input order", async () => {
  let inFlight = 0;
  let peak = 0;
  const results = await mapLimit([5, 1, 4, 2, 3, 1, 2], 3, async (ms, index) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await wait(ms * 3);
    inFlight--;
    return index * 10;
  });
  assert.deepEqual(results, [0, 10, 20, 30, 40, 50, 60]);
  assert.equal(peak, 3);
  assert.deepEqual(await mapLimit([], 4, async () => 1), []);
});

test("mapLimit starts nothing new after a rejection and awaits in-flight items", async () => {
  const started: number[] = [];
  const finished: number[] = [];
  const run = mapLimit([0, 1, 2, 3, 4, 5], 2, async (item) => {
    started.push(item);
    if (item === 0) {
      await wait(5);
      throw new ControlSignal("waiting");
    }
    await wait(30);
    finished.push(item);
    return item;
  });
  await assert.rejects(run, (e: unknown) => isControlSignal(e) && e.reason === "waiting");
  assert.deepEqual(started, [0, 1]);
  assert.deepEqual(finished, [1]);
});

test("mapLimit reports the strongest signal among settled items", async () => {
  const run = mapLimit([0, 1], 2, async (item) => {
    if (item === 0) throw new ControlSignal("waiting");
    await wait(10);
    throw new ControlSignal("lease_lost");
  });
  await assert.rejects(run, (e: unknown) => isControlSignal(e) && e.reason === "lease_lost");
});

test("mapLimit handles a synchronous throw from fn", async () => {
  const fn = ((item: number) => {
    if (item === 1) throw new Error("sync");
    return Promise.resolve(item);
  }) as (item: number) => Promise<number>;
  await assert.rejects(mapLimit([0, 1, 2], 1, fn), /sync/);
});
