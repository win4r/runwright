import { test } from "node:test";
import assert from "node:assert/strict";
import { RunwrightError } from "../../src/core/errors.ts";
import { countFires, nextFire, parseCron } from "../../src/triggers/cron.ts";

const at = (iso: string): number => Date.parse(iso);
const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

function fires(expression: string, fromIso: string, zone: string, n: number): string[] {
  const schedule = parseCron(expression);
  const out: string[] = [];
  let cursor = at(fromIso);
  for (let i = 0; i < n; i++) {
    const next = nextFire(schedule, cursor, zone);
    if (next === null) break;
    out.push(new Date(next).toISOString());
    cursor = next;
  }
  return out;
}

test("parseCron supports numbers, *, lists, ranges and steps", () => {
  const all = parseCron("* * * * *");
  assert.equal(all.minutes.length, 60);
  assert.equal(all.hours.length, 24);
  assert.deepEqual(all.daysOfMonth, Array.from({ length: 31 }, (_, i) => i + 1));
  assert.deepEqual(all.months, Array.from({ length: 12 }, (_, i) => i + 1));
  assert.deepEqual(all.daysOfWeek, [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(all.domRestricted, false);
  assert.equal(all.dowRestricted, false);

  const s = parseCron("  */20 10-20/10 1,15,3 2-4 5-7 ");
  assert.deepEqual(s.minutes, [0, 20, 40]);
  assert.deepEqual(s.hours, [10, 20]);
  assert.deepEqual(s.daysOfMonth, [1, 3, 15]);
  assert.deepEqual(s.months, [2, 3, 4]);
  assert.deepEqual(s.daysOfWeek, [0, 5, 6]);
  assert.equal(s.domRestricted, true);
  assert.equal(s.dowRestricted, true);

  assert.deepEqual(parseCron("0 0 * * 7").daysOfWeek, [0]);
  assert.deepEqual(parseCron("0 0 * * 0,7").daysOfWeek, [0]);
  assert.deepEqual(parseCron("5,5,1 0 * * *").minutes, [1, 5]);
  assert.deepEqual(parseCron("0 0 */2 * *").daysOfMonth.slice(0, 3), [1, 3, 5]);
  assert.equal(parseCron("0 0 */2 * *").domRestricted, false);
  assert.deepEqual(parseCron("59 23 31 12 7").minutes, [59]);
});

test("parseCron rejects unsupported and malformed fields, naming the field and reason", () => {
  const cases: [string, RegExp][] = [
    ["* * * *", /expected 5 fields.*got 4/],
    ["0 * * * * *", /expected 5 fields.*got 6/],
    ["", /got 0/],
    ["60 * * * *", /minute field: 60 is out of range 0-59/],
    ["* 24 * * *", /hour field: 24 is out of range/],
    ["* * 0 * *", /day-of-month field: 0 is out of range 1-31/],
    ["* * 32 * *", /day-of-month field/],
    ["* * * 13 *", /month field: 13 is out of range 1-12/],
    ["* * * * 8", /day-of-week field: 8 is out of range 0-7/],
    ["5-1 * * * *", /minute field: range 5-1 is reversed/],
    ["*/0 * * * *", /minute field: a step of 0/],
    ["* * * * MON", /day-of-week field: names are not supported/],
    ["* * * JAN *", /month field: names are not supported/],
    ["* * * * WED", /names are not supported/],
    ["* * ? * *", /day-of-month field: "\?" is not supported/],
    ["* * L * *", /day-of-month field: "L" and "W" are not supported/],
    ["* * 15W * *", /"L" and "W"/],
    ["* * * * 5L", /"L" and "W"/],
    ["* * * * 5#2", /day-of-week field: "#"/],
    ["@daily", /macros/],
    ["@hourly", /macros/],
    ["5/10 * * * *", /a step needs/],
    ["1,,2 * * * *", /empty list item/],
    ["1-2-3 * * * *", /not a valid range/],
    ["-1 * * * *", /not a valid range/],
    ["*/- * * * *", /step "-" is not a number/],
    ["1.5 * * * *", /not a number/],
    ["*/5/2 * * * *", /not a valid item/],
  ];
  for (const [expression, pattern] of cases) {
    assert.throws(() => parseCron(expression), (error: unknown) => {
      assert.ok(error instanceof RunwrightError, expression);
      assert.equal(error.code, "cron_invalid", expression);
      assert.match(error.message, pattern, expression);
      return true;
    });
  }
});

test("nextFire returns the first matching whole minute strictly after the given time", () => {
  const every = parseCron("* * * * *");
  assert.equal(iso(nextFire(every, at("2026-01-01T00:00:00.000Z"), "UTC")), "2026-01-01T00:01:00.000Z");
  assert.equal(iso(nextFire(every, at("2026-01-01T00:00:59.999Z"), "UTC")), "2026-01-01T00:01:00.000Z");
  assert.equal(iso(nextFire(every, at("2026-01-01T00:00:00.001Z"), "UTC")), "2026-01-01T00:01:00.000Z");
  assert.deepEqual(fires("*/15 9-10 * * *", "2026-01-01T09:40:00Z", "UTC", 4), [
    "2026-01-01T09:45:00.000Z", "2026-01-01T10:00:00.000Z", "2026-01-01T10:15:00.000Z", "2026-01-01T10:30:00.000Z",
  ]);
  assert.deepEqual(fires("0 0 1 * *", "2026-12-15T00:00:00Z", "UTC", 2), ["2027-01-01T00:00:00.000Z", "2027-02-01T00:00:00.000Z"]);
});

test("day-of-month and day-of-week combine with OR only when both are restricted", () => {
  assert.deepEqual(fires("0 0 13 * 5", "2026-01-01T00:00:00Z", "UTC", 4), [
    "2026-01-02T00:00:00.000Z", "2026-01-09T00:00:00.000Z", "2026-01-13T00:00:00.000Z", "2026-01-16T00:00:00.000Z",
  ]);
  assert.deepEqual(fires("0 0 * * 0", "2026-01-01T00:00:00Z", "UTC", 2), ["2026-01-04T00:00:00.000Z", "2026-01-11T00:00:00.000Z"]);
  assert.deepEqual(fires("0 0 * * 7", "2026-01-01T00:00:00Z", "UTC", 1), ["2026-01-04T00:00:00.000Z"]);
  assert.deepEqual(fires("0 0 13 * *", "2026-01-01T00:00:00Z", "UTC", 2), ["2026-01-13T00:00:00.000Z", "2026-02-13T00:00:00.000Z"]);
  assert.deepEqual(fires("0 0 */10 * 1", "2026-01-01T00:00:00Z", "UTC", 3), [
    "2026-05-11T00:00:00.000Z", "2026-06-01T00:00:00.000Z", "2026-08-31T00:00:00.000Z",
  ], "a stepped star day-of-month still constrains: Mondays on day 1, 11, 21 or 31");
});

test("(R04-04) a stepped day-of-month star fires on its days only", () => {
  assert.equal(iso(nextFire(parseCron("0 0 */2 * *"), at("2026-11-01T00:00:00Z"), "UTC")), "2026-11-03T00:00:00.000Z");
  assert.deepEqual(fires("0 0 */2 * *", "2026-10-28T00:00:00Z", "UTC", 4), [
    "2026-10-29T00:00:00.000Z", "2026-10-31T00:00:00.000Z", "2026-11-01T00:00:00.000Z", "2026-11-03T00:00:00.000Z",
  ]);
  assert.deepEqual(fires("0 0 */3 * *", "2026-11-26T00:00:00Z", "UTC", 3), [
    "2026-11-28T00:00:00.000Z", "2026-12-01T00:00:00.000Z", "2026-12-04T00:00:00.000Z",
  ]);
});

test("(R04-04) a stepped day-of-week star fires on its weekdays only", () => {
  assert.deepEqual(fires("0 0 * * */2", "2026-11-01T00:00:00Z", "UTC", 4), [
    "2026-11-03T00:00:00.000Z", "2026-11-05T00:00:00.000Z", "2026-11-07T00:00:00.000Z", "2026-11-08T00:00:00.000Z",
  ]);
  assert.deepEqual(fires("0 0 * * 1-5/2", "2026-11-01T00:00:00Z", "UTC", 4), [
    "2026-11-02T00:00:00.000Z", "2026-11-04T00:00:00.000Z", "2026-11-06T00:00:00.000Z", "2026-11-09T00:00:00.000Z",
  ]);
});

test("(R04-04) a star day field never switches the other one to either", () => {
  assert.equal(iso(nextFire(parseCron("0 0 */2 * 1"), at("2026-11-01T00:00:00Z"), "UTC")), "2026-11-09T00:00:00.000Z",
    "2 November is a Monday but an even day");
  const either = fires("0 0 13 * 5", "2026-11-01T00:00:00Z", "UTC", 8);
  assert.equal(either[0], "2026-11-06T00:00:00.000Z");
  assert.ok(either.includes("2026-12-04T00:00:00.000Z"), "a Friday that is not the 13th");
  assert.ok(either.includes("2026-12-13T00:00:00.000Z"), "a Sunday that is the 13th");
  assert.deepEqual(either, [
    "2026-11-06T00:00:00.000Z", "2026-11-13T00:00:00.000Z", "2026-11-20T00:00:00.000Z", "2026-11-27T00:00:00.000Z",
    "2026-12-04T00:00:00.000Z", "2026-12-11T00:00:00.000Z", "2026-12-13T00:00:00.000Z", "2026-12-18T00:00:00.000Z",
  ]);
  assert.deepEqual(fires("0 0 * * 1", "2026-11-01T00:00:00Z", "UTC", 2), ["2026-11-02T00:00:00.000Z", "2026-11-09T00:00:00.000Z"]);
  assert.deepEqual(fires("0 0 15 * *", "2026-11-01T00:00:00Z", "UTC", 2), ["2026-11-15T00:00:00.000Z", "2026-12-15T00:00:00.000Z"]);
});

test("month ends, leap days and impossible dates", () => {
  assert.deepEqual(fires("0 0 31 * *", "2026-01-31T00:00:00Z", "UTC", 3), [
    "2026-03-31T00:00:00.000Z", "2026-05-31T00:00:00.000Z", "2026-07-31T00:00:00.000Z",
  ]);
  assert.deepEqual(fires("0 12 29 2 *", "2026-01-01T00:00:00Z", "UTC", 2), ["2028-02-29T12:00:00.000Z", "2032-02-29T12:00:00.000Z"]);
  const started = Date.now();
  assert.equal(nextFire(parseCron("0 0 30 2 *"), at("2026-01-01T00:00:00Z"), "UTC"), null);
  assert.equal(nextFire(parseCron("0 0 31 4,6,9,11 *"), at("2026-01-01T00:00:00Z"), "UTC"), null);
  assert.ok(Date.now() - started < 2000, "an impossible schedule gives up quickly");
});

test("time zones: wall-clock fields are matched in the trigger's zone", () => {
  assert.deepEqual(fires("0 9 * * *", "2026-01-01T00:00:00Z", "Asia/Kolkata", 1), ["2026-01-01T03:30:00.000Z"]);
  assert.deepEqual(fires("0 0 1 1 *", "2026-06-01T00:00:00Z", "Pacific/Auckland", 1), ["2026-12-31T11:00:00.000Z"]);
  assert.throws(() => nextFire(parseCron("* * * * *"), 0, "Mars/Olympus_Mons"), (error: unknown) =>
    error instanceof RunwrightError && error.code === "cron_invalid" && /time zone/.test(error.message));
});

test("weekdays at 09:00 in New York across both DST changes", () => {
  assert.deepEqual(fires("0 9 * * 1-5", "2026-03-06T00:00:00Z", "America/New_York", 3), [
    "2026-03-06T14:00:00.000Z", "2026-03-09T13:00:00.000Z", "2026-03-10T13:00:00.000Z",
  ]);
  assert.deepEqual(fires("0 9 * * 1-5", "2026-10-30T00:00:00Z", "America/New_York", 3), [
    "2026-10-30T13:00:00.000Z", "2026-11-02T14:00:00.000Z", "2026-11-03T14:00:00.000Z",
  ]);
});

test("a skipped local time does not fire and a repeated one fires only on its first occurrence", () => {
  assert.deepEqual(fires("30 2 * * *", "2026-03-07T00:00:00Z", "America/New_York", 2), [
    "2026-03-07T07:30:00.000Z", "2026-03-09T06:30:00.000Z",
  ]);
  assert.deepEqual(fires("30 2 * * *", "2026-10-31T00:00:00Z", "America/New_York", 3), [
    "2026-10-31T06:30:00.000Z", "2026-11-01T07:30:00.000Z", "2026-11-02T07:30:00.000Z",
  ]);
  assert.deepEqual(fires("30 1 * * *", "2026-11-01T00:00:00Z", "America/New_York", 2), [
    "2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z",
  ]);
  const s = parseCron("30 1 * * *");
  assert.equal(iso(nextFire(s, at("2026-11-01T05:45:00Z"), "America/New_York")), "2026-11-02T06:30:00.000Z");
  assert.equal(iso(nextFire(s, at("2026-11-01T06:10:00Z"), "America/New_York")), "2026-11-02T06:30:00.000Z");
  assert.deepEqual(fires("0 * * * *", "2026-11-01T04:30:00Z", "America/New_York", 3), [
    "2026-11-01T05:00:00.000Z", "2026-11-01T07:00:00.000Z", "2026-11-01T08:00:00.000Z",
  ]);
  assert.deepEqual(fires("*/30 * * * *", "2026-03-08T06:00:00Z", "America/New_York", 3), [
    "2026-03-08T06:30:00.000Z", "2026-03-08T07:00:00.000Z", "2026-03-08T07:30:00.000Z",
  ]);
});

test("countFires counts fire times in (from, to], stopping at max", () => {
  const hourly = parseCron("0 * * * *");
  assert.equal(countFires(hourly, at("2026-01-01T00:00:00Z"), at("2026-01-01T10:00:00Z"), "UTC", 100), 10);
  assert.equal(countFires(hourly, at("2026-01-01T00:00:00Z"), at("2026-01-01T10:00:00Z"), "UTC", 3), 3);
  assert.equal(countFires(hourly, at("2026-01-01T00:00:00Z") - 1, at("2026-01-01T00:00:00Z"), "UTC", 100), 1);
  assert.equal(countFires(hourly, at("2026-01-01T00:10:00Z"), at("2026-01-01T00:50:00Z"), "UTC", 100), 0);
  assert.equal(countFires(hourly, at("2026-11-01T04:00:00Z"), at("2026-11-01T08:00:00Z"), "America/New_York", 100), 3);
  assert.equal(countFires(parseCron("* * * * *"), 0, 10 * 86_400_000, "UTC", 1000), 1000);
});

test("(R04-04) countFires counts only the days a stepped day field holds", () => {
  const oddDays = parseCron("0 0 */2 * *");
  assert.equal(countFires(oddDays, at("2026-11-01T00:00:00Z"), at("2026-11-30T00:00:00Z"), "UTC", 100), 14);
  assert.equal(countFires(oddDays, at("2026-11-01T00:00:00Z"), at("2026-11-30T00:00:00Z"), "UTC", 5), 5);
  assert.equal(countFires(parseCron("0 0 * * */2"), at("2026-11-01T00:00:00Z"), at("2026-11-15T00:00:00Z"), "UTC", 100), 8);
});

const WEEKDAYS: Readonly<Record<string, number>> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

interface OracleMinute { ms: number; wall: string; month: number; day: number; weekday: number; hour: number; minute: number }

/**
 * Every whole minute in `[fromMs - 3h, toMs]` with its local fields in `timeZone`, read through `Intl` alone.
 * The three hours before the window let the oracle know which local times already occurred before it.
 */
function oracleMinutes(timeZone: string, fromMs: number, toMs: number): OracleMinute[] {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short",
  });
  const out: OracleMinute[] = [];
  for (let ms = Math.floor(fromMs / 60_000) * 60_000 - 3 * 3_600_000; ms <= toMs; ms += 60_000) {
    const parts: Record<string, string> = {};
    for (const part of format.formatToParts(ms)) parts[part.type] = part.value;
    const weekday = WEEKDAYS[parts["weekday"] ?? ""];
    assert.ok(weekday !== undefined);
    out.push({
      ms, weekday,
      wall: `${parts["year"]}-${parts["month"]}-${parts["day"]} ${parts["hour"]}:${parts["minute"]}`,
      month: Number(parts["month"]), day: Number(parts["day"]), hour: Number(parts["hour"]), minute: Number(parts["minute"]),
    });
  }
  return out;
}

/** The fire times in `(fromMs, toMs]` by a minute-by-minute walk: a repeated local time fires once. */
function oracleFires(expression: string, minutes: readonly OracleMinute[], fromMs: number, toMs: number): number[] {
  const s = parseCron(expression);
  const seen = new Set<string>();
  const out: number[] = [];
  for (const m of minutes) {
    if (m.ms > toMs) break;
    const first = !seen.has(m.wall);
    seen.add(m.wall);
    if (!first || m.ms <= fromMs) continue;
    const dom = s.daysOfMonth.includes(m.day);
    const dow = s.daysOfWeek.includes(m.weekday);
    const day = s.domRestricted && s.dowRestricted ? dom || dow : dom && dow;
    if (day && s.months.includes(m.month) && s.hours.includes(m.hour) && s.minutes.includes(m.minute)) out.push(m.ms);
  }
  return out;
}

const ORACLE_EXPRESSIONS = [
  "0 0 */2 * *", "30 6 */3 * *", "0 0 * * */2", "15 8 * * */3", "0 0 */2 * 1", "0 12 */5 * */2", "0 0 13 * 5",
  "0 9 * * 1-5", "0 9 * * 1-5/2", "*/15 * * * *", "*/15 0-3 * * *", "30 1 * * *", "30 2 * * *", "0 * * * 0",
  "0 1-3 * * *", "0 0 1,15 * *", "0 0 1-7 * 1", "0 0 */10 * 1", "45 23 28-31 * *", "0 0 * 3,4,10,11 */2",
  "0 0 */2 11 *", "5 4 * 2-3 6", "0 3 2-30/7 * *", "0 0 31 * *", "0 22 * * 6,0", "0 2 */2 * 0", "10,40 0-2 */2 3,10,11 *",
];

const ORACLE_WINDOWS: readonly { zone: string; from: string }[] = [
  { zone: "UTC", from: "2026-10-20T00:00:00Z" },
  { zone: "America/New_York", from: "2026-02-20T05:00:00Z" },
  { zone: "America/New_York", from: "2026-10-15T04:00:00Z" },
  { zone: "Europe/Berlin", from: "2026-03-10T23:00:00Z" },
  { zone: "Europe/Berlin", from: "2026-10-01T22:00:00Z" },
];

const WINDOW_DAYS = 42;

test("nextFire agrees with a minute-by-minute oracle across daylight-saving changes", () => {
  for (const { zone, from } of ORACLE_WINDOWS) {
    const fromMs = at(from);
    const toMs = fromMs + WINDOW_DAYS * 86_400_000;
    const minutes = oracleMinutes(zone, fromMs, toMs);
    const probes = Array.from({ length: Math.floor((toMs - fromMs) / 26_237_000) }, (_, i) => fromMs + 1 + i * 26_237_000);
    for (const expression of ORACLE_EXPRESSIONS) {
      const label = `${expression} in ${zone} from ${from}`;
      const expected = oracleFires(expression, minutes, fromMs, toMs);
      const schedule = parseCron(expression);
      const actual: number[] = [];
      let cursor = fromMs;
      for (;;) {
        const next = nextFire(schedule, cursor, zone);
        if (next === null || next > toMs) break;
        actual.push(next);
        cursor = next;
      }
      assert.deepEqual(actual.map(iso), expected.map(iso), label);
      for (const probe of probes) {
        const want = expected.find((ms) => ms > probe);
        if (want === undefined) continue;
        assert.equal(iso(nextFire(schedule, probe, zone)), iso(want), `${label}, after ${iso(probe)}`);
      }
    }
  }
});

test("the oracle windows cover both daylight-saving changes of each zone", () => {
  const changes: [string, string][] = [
    ["America/New_York", "2026-03-08T07:00:00Z"], ["America/New_York", "2026-11-01T06:00:00Z"],
    ["Europe/Berlin", "2026-03-29T01:00:00Z"], ["Europe/Berlin", "2026-10-25T01:00:00Z"],
  ];
  for (const [zone, change] of changes) {
    assert.ok(ORACLE_WINDOWS.some((w) => w.zone === zone && at(w.from) < at(change) && at(change) < at(w.from) + WINDOW_DAYS * 86_400_000), `${zone} ${change}`);
  }
});

test("the oracle matches known fires around the New York fall-back repeat", () => {
  const fromMs = at("2026-10-31T04:00:00Z");
  const toMs = at("2026-11-02T12:00:00Z");
  const minutes = oracleMinutes("America/New_York", fromMs, toMs);
  assert.deepEqual(oracleFires("30 1 * * *", minutes, fromMs, toMs).map(iso), [
    "2026-10-31T05:30:00.000Z", "2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z",
  ]);
  assert.deepEqual(oracleFires("30 1 * * *", minutes, at("2026-11-01T06:10:00Z"), toMs).map(iso), ["2026-11-02T06:30:00.000Z"]);
});

// ---- A schedule that fires at all has a next fire, however far away (R14D-tools-02) ----

/** The fire after `fromMs`, timed with a warm formatter: the fastest of five calls, so a scheduling pause is not counted. */
function timedNext(expression: string, fromMs: number, zone = "UTC"): { next: number | null; ms: number } {
  const schedule = parseCron(expression);
  nextFire(parseCron("* * * * *"), fromMs, zone);
  let next: number | null = null;
  let ms = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 5; i++) {
    const started = performance.now();
    next = nextFire(schedule, fromMs, zone);
    ms = Math.min(ms, performance.now() - started);
  }
  return { next, ms };
}

test("(R14D-tools-02) February 1st on a Monday fires in 2027 and next in 2038", () => {
  const first = timedNext("0 0 */30 2 1", at("2026-11-16T00:00:00Z"));
  assert.equal(iso(first.next), "2027-02-01T00:00:00.000Z");
  const second = timedNext("0 0 */30 2 1", at("2027-02-01T00:00:00Z"));
  assert.equal(iso(second.next), "2038-02-01T00:00:00.000Z");
  assert.ok(first.ms < 50 && second.ms < 50, `${first.ms} ms, ${second.ms} ms`);
});

test("(R14D-tools-02) leap days skip 2100, which is not a leap year", () => {
  assert.equal(iso(nextFire(parseCron("0 0 29 2 *"), at("2096-03-01T00:00:00Z"), "UTC")), "2104-02-29T00:00:00.000Z");
});

/** The first leap day after `fromYear` that falls on `weekday`, by plain Date arithmetic. */
function nextLeapDayOn(weekday: number, fromYear: number): number {
  for (let year = fromYear + 1; ; year++) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    if (leap && new Date(Date.UTC(year, 1, 29)).getUTCDay() === weekday) return Date.UTC(year, 1, 29);
  }
}

test("(R14D-tools-02) a leap day on a given weekday is found decades ahead, quickly", () => {
  // `0 0 29 2 1` restricts both day fields, so by the day rule it fires on February 29th *or* any Monday of
  // February. A leap day on a weekday needs a star weekday field: `*/7` holds Sunday alone and keeps "both".
  assert.equal(new Date(Date.UTC(2072, 1, 29)).getUTCDay(), 1, "2072-02-29 is a Monday");
  const either = timedNext("0 0 29 2 1", at("2072-03-01T00:00:00Z"));
  assert.equal(iso(either.next), "2073-02-06T00:00:00.000Z", "the first Monday of February 2073");
  for (const fromYear of [2072, 2088, 2128]) {
    const expected = nextLeapDayOn(0, fromYear);
    const { next, ms } = timedNext("0 0 29 2 */7", Date.UTC(fromYear, 2, 1));
    assert.equal(iso(next), iso(expected), `after ${fromYear}`);
    assert.ok(new Date(expected).getUTCFullYear() - fromYear > 5, `the gap after ${fromYear} is longer than the old five-year horizon`);
    assert.ok(ms < 50, `${ms} ms`);
  }
});

test("(R14D-tools-02) a schedule that never fires is null at once", () => {
  for (const expression of ["0 0 31 2 *", "0 0 30 2 *", "0 0 31 4,6,9,11 *", "0 0 30,31 2 */2", "5 5 31 2,4 */3"]) {
    const { next, ms } = timedNext(expression, at("2026-11-16T00:00:00Z"));
    assert.equal(next, null, expression);
    assert.ok(ms < 5, `${expression}: ${ms} ms`);
  }
  assert.equal(iso(nextFire(parseCron("0 0 31 2 1"), at("2026-11-16T00:00:00Z"), "UTC")), "2027-02-01T00:00:00.000Z",
    "both day fields restricted: the weekday alone fires, so a day that never exists does not make it never fire");
});

/** A small seeded generator (mulberry32), so a failure can be replayed. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomField(random: () => number, min: number, max: number): string {
  const pick = (): number => min + Math.floor(random() * (max - min + 1));
  const kind = random();
  if (kind < 0.25) return "*";
  if (kind < 0.4) return `*/${1 + Math.floor(random() * Math.min(30, max))}`;
  if (kind < 0.6) {
    const a = pick();
    const b = pick();
    return `${Math.min(a, b)}-${Math.max(a, b)}${random() < 0.4 ? `/${1 + Math.floor(random() * 5)}` : ""}`;
  }
  return Array.from({ length: 1 + Math.floor(random() * 3) }, pick).join(",");
}

const zoneFormat = new Map<string, Intl.DateTimeFormat>();
/** The local fields of `ms` in `zone`, read through `Intl` alone. */
function localFields(ms: number, zone: string): { month: number; day: number; weekday: number; hour: number; minute: number; wall: string } {
  let format = zoneFormat.get(zone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" });
    zoneFormat.set(zone, format);
  }
  const parts: Record<string, string> = {};
  for (const part of format.formatToParts(ms)) parts[part.type] = part.value;
  return {
    month: Number(parts["month"]), day: Number(parts["day"]), weekday: WEEKDAYS[parts["weekday"] ?? ""] ?? -1,
    hour: Number(parts["hour"]), minute: Number(parts["minute"]), wall: `${parts["year"]}-${parts["month"]}-${parts["day"]} ${parts["hour"]}:${parts["minute"]}`,
  };
}

function matchesAt(expression: string, ms: number, zone: string): boolean {
  const s = parseCron(expression);
  const f = localFields(ms, zone);
  const dom = s.daysOfMonth.includes(f.day);
  const dow = s.daysOfWeek.includes(f.weekday);
  const day = s.domRestricted && s.dowRestricted ? dom || dow : dom && dow;
  return day && s.months.includes(f.month) && s.hours.includes(f.hour) && s.minutes.includes(f.minute);
}

test("(R14D-tools-02) property: 200 random schedules give null or the next matching minute, with none skipped", () => {
  const random = seeded(20261116);
  const zones = ["UTC", "Europe/Berlin", "America/New_York", "Asia/Kolkata"];
  for (let i = 0; i < 200; i++) {
    const expression = [randomField(random, 0, 59), randomField(random, 0, 23), randomField(random, 1, 31), randomField(random, 1, 12), randomField(random, 0, 7)].join(" ");
    const zone = zones[i % zones.length] as string;
    const fromMs = Date.UTC(2020, 0, 1) + Math.floor(random() * 30 * 365 * 86_400_000) + Math.floor(random() * 60_000);
    const label = `${expression} in ${zone} after ${new Date(fromMs).toISOString()}`;
    const next = nextFire(parseCron(expression), fromMs, zone);
    if (next === null) {
      const s = parseCron(expression);
      const possible = s.domRestricted && s.dowRestricted
        ? true
        : s.months.some((month) => s.daysOfMonth.some((day) => day <= [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!));
      assert.equal(possible, false, `${label}: null for a schedule that can fire`);
      continue;
    }
    assert.ok(next > fromMs, label);
    assert.equal(next % 60_000, 0, label);
    assert.ok(matchesAt(expression, next, zone), `${label}: ${new Date(next).toISOString()} does not match`);
    if (next - fromMs < 3 * 86_400_000) {
      const seen = new Set<string>();
      for (let ms = Math.floor(fromMs / 60_000) * 60_000 - 3 * 3_600_000; ms < fromMs; ms += 60_000) seen.add(localFields(ms, zone).wall);
      for (let ms = Math.floor(fromMs / 60_000) * 60_000 + 60_000; ms < next; ms += 60_000) {
        const wall = localFields(ms, zone).wall;
        const first = !seen.has(wall);
        seen.add(wall);
        assert.ok(!(first && matchesAt(expression, ms, zone)), `${label}: ${new Date(ms).toISOString()} matches before ${new Date(next).toISOString()}`);
      }
    }
  }
});

test("(R14D-tools-02) the spring jump in Berlin still skips 02:30 on that day only", () => {
  assert.deepEqual(fires("30 2 * * *", "2027-03-26T12:00:00Z", "Europe/Berlin", 3), [
    "2027-03-27T01:30:00.000Z", "2027-03-29T00:30:00.000Z", "2027-03-30T00:30:00.000Z",
  ]);
});
