import { RunwrightError } from "../core/errors.ts";

/**
 * Five-field cron: `minute hour day-of-month month day-of-week`.
 *
 * Supported in every field: a number, `*`, a range `a-b`, a step `*\/n` or `a-b/n`, and comma lists of those.
 * Day of week is 0-7, where 0 and 7 are both Sunday. Rejected with `cron_invalid`: names (`MON`, `JAN`), `?`,
 * `L`, `W`, `#`, macros such as `@daily`, a sixth (seconds) field, `a/n` without a range, and out-of-range,
 * reversed or zero-step values.
 *
 * Day rule. A day field is "restricted" when its text does not start with `*`. When both day fields are
 * restricted, a day matches if either field matches; in every other case it matches only if both fields hold
 * the day. A plain `*` holds every value, so it never excludes a day, but a stepped star (`*\/2`) does:
 * - `0 0 *\/2 * *`: days 1, 3, 5, ... 31 of every month (the step restarts at 1 each month, so the 31st is
 *   followed by the 1st);
 * - `0 0 * * *\/2`: Sunday, Tuesday, Thursday and Saturday;
 * - `0 0 *\/2 * 1`: Mondays that fall on an odd day of the month (a star field never switches to "either");
 * - `0 0 13 * 5`: the 13th and every Friday (both fields restricted: either).
 */
export interface CronSchedule {
  minutes: number[]; hours: number[]; daysOfMonth: number[]; months: number[]; daysOfWeek: number[];
  domRestricted: boolean; dowRestricted: boolean;
}

interface FieldSpec { name: string; min: number; max: number }

const FIELDS: readonly FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day-of-week", min: 0, max: 7 },
];

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** The Gregorian calendar repeats every 400 years: 146 097 days, a whole number of weeks. */
const CYCLE_DAYS = 146_097;
/** The most days a month can have, by month (February counted with its leap day). */
const MAX_MONTH_DAYS: readonly number[] = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const ALL_DAYS: readonly number[] = Array.from({ length: 31 }, (_, i) => i + 1);

function cronError(expression: string, message: string, field?: string): RunwrightError {
  return new RunwrightError("cron_invalid", field === undefined ? message : `${field} field: ${message}`, {
    details: field === undefined ? { expression } : { expression, field },
  });
}

function parseNumber(text: string, spec: FieldSpec, expression: string): number {
  if (!/^\d{1,2}$/.test(text)) throw cronError(expression, `${JSON.stringify(text)} is not a number`, spec.name);
  const value = Number(text);
  if (value < spec.min || value > spec.max) {
    throw cronError(expression, `${value} is out of range ${spec.min}-${spec.max}`, spec.name);
  }
  return value;
}

function parseField(text: string, spec: FieldSpec, expression: string): number[] {
  if (text.includes("?")) throw cronError(expression, '"?" is not supported (use "*")', spec.name);
  if (text.includes("#")) throw cronError(expression, '"#" (nth weekday) is not supported', spec.name);
  if (/[LW]/.test(text) && !/[A-KM-VX-Za-z]/.test(text)) {
    throw cronError(expression, '"L" and "W" are not supported', spec.name);
  }
  if (/[A-Za-z]/.test(text)) throw cronError(expression, "names are not supported; use numbers", spec.name);
  const values = new Set<number>();
  for (const item of text.split(",")) {
    if (item === "") throw cronError(expression, "empty list item", spec.name);
    const [rangeText, stepText, extra] = item.split("/");
    if (extra !== undefined || rangeText === undefined || rangeText === "") {
      throw cronError(expression, `${JSON.stringify(item)} is not a valid item`, spec.name);
    }
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d{1,2}$/.test(stepText)) throw cronError(expression, `step ${JSON.stringify(stepText)} is not a number`, spec.name);
      step = Number(stepText);
      if (step === 0) throw cronError(expression, "a step of 0 is not allowed", spec.name);
    }
    let low: number;
    let high: number;
    if (rangeText === "*") {
      low = spec.min;
      high = spec.max;
    } else if (rangeText.includes("-")) {
      const [a, b, more] = rangeText.split("-");
      if (a === undefined || b === undefined || more !== undefined || a === "" || b === "") {
        throw cronError(expression, `${JSON.stringify(rangeText)} is not a valid range`, spec.name);
      }
      low = parseNumber(a, spec, expression);
      high = parseNumber(b, spec, expression);
      if (low > high) throw cronError(expression, `range ${low}-${high} is reversed`, spec.name);
    } else {
      if (stepText !== undefined) {
        throw cronError(expression, `${JSON.stringify(item)}: a step needs "*" or a range before it`, spec.name);
      }
      low = parseNumber(rangeText, spec, expression);
      high = low;
    }
    for (let v = low; v <= high; v += step) values.add(v);
  }
  return [...values].sort((a, b) => a - b);
}

/** Throws `cron_invalid` naming the field and the reason. */
export function parseCron(expression: string): CronSchedule {
  if (typeof expression !== "string") throw cronError(String(expression), "a cron expression must be a string");
  const trimmed = expression.trim();
  if (trimmed.startsWith("@")) throw cronError(expression, `macros such as ${trimmed.split(/\s+/)[0]} are not supported`);
  const parts = trimmed === "" ? [] : trimmed.split(/\s+/);
  if (parts.length !== 5) {
    throw cronError(expression, `expected 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`);
  }
  const [minuteText, hourText, domText, monthText, dowText] = parts as [string, string, string, string, string];
  const fields = [minuteText, hourText, domText, monthText, dowText].map((text, i) =>
    parseField(text, FIELDS[i] as FieldSpec, expression));
  const daysOfWeek = [...new Set((fields[4] as number[]).map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b);
  return {
    minutes: fields[0] as number[],
    hours: fields[1] as number[],
    daysOfMonth: fields[2] as number[],
    months: fields[3] as number[],
    daysOfWeek,
    domRestricted: !domText.startsWith("*"),
    dowRestricted: !dowText.startsWith("*"),
  };
}

interface LocalTime { year: number; month: number; day: number; hour: number; minute: number; second: number }

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached !== undefined) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", second: "numeric", era: "short",
    });
  } catch {
    throw new RunwrightError("cron_invalid", `unknown time zone ${JSON.stringify(timeZone)}`, { details: { timeZone } });
  }
  if (formatters.size >= 256) formatters.clear();
  formatters.set(timeZone, formatter);
  return formatter;
}

/** Throws `cron_invalid` for a time zone `Intl` does not know. */
export function checkTimeZone(timeZone: string): void {
  formatterFor(timeZone);
}

function localTime(formatter: Intl.DateTimeFormat, ms: number): LocalTime {
  const out: LocalTime = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  let bc = false;
  for (const part of formatter.formatToParts(ms)) {
    switch (part.type) {
      case "year": out.year = Number(part.value); break;
      case "month": out.month = Number(part.value); break;
      case "day": out.day = Number(part.value); break;
      case "hour": out.hour = Number(part.value); break;
      case "minute": out.minute = Number(part.value); break;
      case "second": out.second = Number(part.value); break;
      case "era": bc = part.value.startsWith("B"); break;
      default: break;
    }
  }
  if (bc) out.year = 1 - out.year;
  return out;
}

/** Local wall-clock time as if it were UTC, in ms. */
function wallMs(t: LocalTime): number {
  return Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second);
}

function offsetAt(formatter: Intl.DateTimeFormat, ms: number): number {
  const instant = Math.floor(ms / 1000) * 1000;
  return wallMs(localTime(formatter, instant)) - instant;
}

/**
 * The earliest instant whose local wall clock reads `wall` (whole minute, as UTC ms), or null when that local
 * time does not exist (skipped by a DST jump). Offsets a day either side cover every real transition.
 */
function resolveLocal(formatter: Intl.DateTimeFormat, wall: number): number | null {
  let best: number | null = null;
  const offsets = new Set([offsetAt(formatter, wall - DAY_MS), offsetAt(formatter, wall), offsetAt(formatter, wall + DAY_MS)]);
  for (const offset of offsets) {
    const instant = wall - offset;
    const back = localTime(formatter, instant);
    if (wallMs(back) - back.second * 1000 === wall && (best === null || instant < best)) best = instant;
  }
  return best;
}

function dayMatches(schedule: CronSchedule, year: number, month: number, day: number): boolean {
  const dom = schedule.daysOfMonth.includes(day);
  const dow = schedule.daysOfWeek.includes(new Date(Date.UTC(year, month - 1, day)).getUTCDay());
  if (schedule.domRestricted && schedule.dowRestricted) return dom || dow;
  return dom && dow;
}

/** True when the day rule lets a day match on its weekday alone (both day fields restricted: either). */
function eitherDayField(schedule: CronSchedule): boolean {
  return schedule.domRestricted && schedule.dowRestricted;
}

/**
 * Whether the schedule matches any day at all, decided without a search. With both day fields restricted, the
 * weekday alone suffices and every month has every weekday. Otherwise a day needs both fields, and that is
 * possible exactly when some listed month has a listed day that exists in it (February with 29 days): within one
 * 400-year cycle every month-day that exists falls on every weekday.
 */
export function canFire(schedule: CronSchedule): boolean {
  if (eitherDayField(schedule)) return true;
  return schedule.months.some((month) => schedule.daysOfMonth.some((day) => day <= (MAX_MONTH_DAYS[month - 1] as number)));
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The first whole minute strictly after `afterMs` whose local wall-clock time in `timeZone` matches, or null when
 * the schedule never fires (`canFire`). The search covers one whole 400-year calendar cycle from `afterMs`, so a
 * schedule that fires at all is always found, however far away its next fire is. It visits only the listed
 * months and, when a day needs both day fields, only the listed days of the month. A local time skipped by a DST
 * jump does not fire on that day (the search goes on); a repeated local time fires only on its first occurrence.
 * Throws `cron_invalid` for an unknown time zone.
 */
export function nextFire(schedule: CronSchedule, afterMs: number, timeZone: string): number | null {
  const formatter = formatterFor(timeZone);
  if (!canFire(schedule)) return null;
  const start = localTime(formatter, afterMs);
  const startDay = Date.UTC(start.year, start.month - 1, start.day);
  const lastDay = startDay + CYCLE_DAYS * DAY_MS;
  const candidates = eitherDayField(schedule) ? ALL_DAYS : schedule.daysOfMonth;
  for (let year = start.year, month = start.month; Date.UTC(year, month - 1, 1) <= lastDay; month === 12 ? (year++, month = 1) : month++) {
    if (!schedule.months.includes(month)) continue;
    const monthDays = daysInMonth(year, month);
    for (const day of candidates) {
      if (day > monthDays) break;
      const dayStart = Date.UTC(year, month - 1, day);
      if (dayStart < startDay) continue;
      if (dayStart > lastDay) return null;
      if (!dayMatches(schedule, year, month, day)) continue;
      const first = dayStart === startDay;
      for (const hour of schedule.hours) {
        if (first && hour < start.hour) continue;
        for (const minute of schedule.minutes) {
          if (first && hour === start.hour && minute < start.minute) continue;
          const instant = resolveLocal(formatter, dayStart + hour * 3_600_000 + minute * MINUTE_MS);
          if (instant === null || instant <= afterMs) continue;
          return instant;
        }
      }
    }
  }
  return null;
}

/** Fire times in `(fromMs, toMs]`, counting at most `max`. */
export function countFires(schedule: CronSchedule, fromMs: number, toMs: number, timeZone: string, max: number): number {
  let count = 0;
  let cursor = fromMs;
  while (count < max) {
    const next = nextFire(schedule, cursor, timeZone);
    if (next === null || next > toMs) break;
    count++;
    cursor = next;
  }
  return count;
}
