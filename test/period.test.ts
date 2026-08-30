import { describe, expect, it } from "vitest";
import { PERIODS, localToday, resolvePeriod, type Period } from "../src/period.js";

/** Every case is written as the range a person would name, because the failure
 * this guards against is not a crash: an off-by-one range returns a plausible
 * total and nobody notices. */
const cases: [Period, string, string, string][] = [
  // Ordinary mid-month Wednesday.
  ["today", "2026-08-19", "2026-08-19", "2026-08-19"],
  ["yesterday", "2026-08-19", "2026-08-18", "2026-08-18"],
  ["this_week", "2026-08-19", "2026-08-17", "2026-08-23"],
  ["last_week", "2026-08-19", "2026-08-10", "2026-08-16"],
  ["this_month", "2026-08-19", "2026-08-01", "2026-08-31"],
  ["last_month", "2026-08-19", "2026-07-01", "2026-07-31"],
  ["this_quarter", "2026-08-19", "2026-07-01", "2026-09-30"],
  ["last_quarter", "2026-08-19", "2026-04-01", "2026-06-30"],
  ["this_year", "2026-08-19", "2026-01-01", "2026-12-31"],
  ["last_year", "2026-08-19", "2025-01-01", "2025-12-31"],

  // Month lengths: a naive "subtract 30 days" gets these wrong.
  ["last_month", "2026-03-15", "2026-02-01", "2026-02-28"],
  ["last_month", "2026-05-31", "2026-04-01", "2026-04-30"],
  ["this_month", "2026-02-10", "2026-02-01", "2026-02-28"],
  ["this_month", "2028-02-10", "2028-02-01", "2028-02-29"],
  ["last_month", "2028-03-01", "2028-02-01", "2028-02-29"],

  // Leap day itself, and the year after it.
  ["today", "2028-02-29", "2028-02-29", "2028-02-29"],
  ["yesterday", "2028-03-01", "2028-02-29", "2028-02-29"],
  ["last_year", "2029-06-01", "2028-01-01", "2028-12-31"],

  // Year boundary in both directions.
  ["yesterday", "2027-01-01", "2026-12-31", "2026-12-31"],
  ["last_month", "2027-01-15", "2026-12-01", "2026-12-31"],
  ["last_quarter", "2027-02-10", "2026-10-01", "2026-12-31"],
  ["this_quarter", "2026-12-31", "2026-10-01", "2026-12-31"],

  // ISO weeks start on Monday, and Sunday belongs to the week that just ended.
  ["this_week", "2026-08-17", "2026-08-17", "2026-08-23"], // Monday
  ["this_week", "2026-08-23", "2026-08-17", "2026-08-23"], // Sunday
  ["last_week", "2026-08-17", "2026-08-10", "2026-08-16"],
  ["this_week", "2027-01-01", "2026-12-28", "2027-01-03"], // week spanning New Year

  // Rolling windows are inclusive of today, so 7 days means 7 dates.
  ["last_7_days", "2026-08-19", "2026-08-13", "2026-08-19"],
  ["last_30_days", "2026-08-19", "2026-07-21", "2026-08-19"],
  ["last_90_days", "2026-08-19", "2026-05-22", "2026-08-19"],
  ["last_365_days", "2026-08-19", "2025-08-20", "2026-08-19"],
  ["last_30_days", "2026-01-15", "2025-12-17", "2026-01-15"],
  ["last_365_days", "2029-03-01", "2028-03-02", "2029-03-01"], // crosses a leap year
];

describe("resolvePeriod", () => {
  for (const [period, today, start, end] of cases) {
    it(`${period} on ${today} is ${start}..${end}`, () => {
      expect(resolvePeriod(period, today)).toEqual({ start, end });
    });
  }

  it("covers every period the schema advertises", () => {
    expect(new Set(cases.map(([period]) => period))).toEqual(new Set(PERIODS));
  });

  /** Firefly treats `end` as part of the range, so the day count a shortcut
   * names has to be the day count it spans. */
  it("spans the number of days its name claims", () => {
    const days = (period: Period): number => {
      const { start, end } = resolvePeriod(period, "2026-08-19");
      return (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000 + 1;
    };
    expect(days("today")).toBe(1);
    expect(days("yesterday")).toBe(1);
    expect(days("last_7_days")).toBe(7);
    expect(days("last_30_days")).toBe(30);
    expect(days("last_90_days")).toBe(90);
    expect(days("last_365_days")).toBe(365);
    expect(days("this_week")).toBe(7);
    expect(days("last_week")).toBe(7);
  });

  it("never returns an end before its start, on any day of a leap year", () => {
    const day = new Date(Date.UTC(2028, 0, 1));
    while (day.getUTCFullYear() === 2028) {
      const today = day.toISOString().slice(0, 10);
      for (const period of PERIODS) {
        const { start, end } = resolvePeriod(period, today);
        expect(start <= end, `${period} on ${today}`).toBe(true);
      }
      day.setUTCDate(day.getUTCDate() + 1);
    }
  });

  it("refuses a date that does not exist rather than rolling it forward", () => {
    expect(() => resolvePeriod("today", "2026-02-30")).toThrow(/Not a real date/);
    expect(() => resolvePeriod("today", "19-08-2026")).toThrow(/YYYY-MM-DD/);
  });
});

describe("localToday", () => {
  /** A container running UTC would otherwise answer for yesterday until 03:00
   * for a user in UTC+3, and the range would be a day out with no error. */
  it("reads the calendar date in the machine's zone, not UTC's", () => {
    const offset = new Date().getTimezoneOffset();
    const lateEvening = new Date(Date.UTC(2026, 7, 19, 22, 30) + offset * 60_000);
    expect(localToday(lateEvening)).toBe("2026-08-19");
    const justAfterMidnight = new Date(Date.UTC(2026, 7, 19, 0, 15) + offset * 60_000);
    expect(localToday(justAfterMidnight)).toBe("2026-08-19");
  });
});
