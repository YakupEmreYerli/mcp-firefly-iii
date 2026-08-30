/** Calendar arithmetic for the relative period shortcuts.
 *
 * A model asked for "last month" has to turn that into two ISO dates, and it
 * gets them wrong in the ways calendars are hard: month lengths, leap days,
 * year boundaries. Worse, it fails silently — a range off by one day returns a
 * plausible number rather than an error, which is the failure this whole
 * project is built against.
 *
 * Everything here is pure and takes `today` as an argument. A function that
 * reads the clock itself cannot be tested across a leap day or a New Year
 * without moving the machine's clock.
 *
 * These shortcuts only compute dates. They deliberately do not paper over
 * Firefly's endpoint quirks: `period: "today"` produces `start == end`, and an
 * endpoint that refuses that (`/summary/basic`) still refuses it. Widening the
 * range to avoid the 422 would change what is being measured — `balance-in-*`
 * is period movement, not an instant balance — so a caller would receive a
 * different number, silently, instead of an error.
 */

/** The vocabulary, in the order the schema advertises it. */
export const PERIODS = [
  "today",
  "yesterday",
  "this_week",
  "last_week",
  "this_month",
  "last_month",
  "this_quarter",
  "last_quarter",
  "this_year",
  "last_year",
  "last_7_days",
  "last_30_days",
  "last_90_days",
  "last_365_days",
] as const;

export type Period = (typeof PERIODS)[number];

export type DateRange = { start: string; end: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Days are handled as UTC midnights so that arithmetic never crosses a
 * daylight-saving boundary and lands on the previous day. The calendar date the
 * caller passes in already carries whatever zone they meant. */
function toUtc(date: string): Date {
  if (!ISO_DATE.test(date)) throw new RangeError(`Expected YYYY-MM-DD, got ${JSON.stringify(date)}`);
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) throw new RangeError(`Not a real date: ${date}`);
  // `new Date("2026-02-30T00:00:00Z")` is valid input to the parser on some
  // engines and rolls forward, so a round-trip is what actually rejects it.
  if (parsed.toISOString().slice(0, 10) !== date) throw new RangeError(`Not a real date: ${date}`);
  return parsed;
}

const iso = (date: Date): string => date.toISOString().slice(0, 10);

const addDays = (date: Date, days: number): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));

const firstOfMonth = (year: number, month: number): Date => new Date(Date.UTC(year, month, 1));

/** Day 0 of the next month is the last day of this one, which is how February
 * gets 29 in a leap year without a leap-year rule living here. */
const lastOfMonth = (year: number, month: number): Date => new Date(Date.UTC(year, month + 1, 0));

/** Monday, per ISO-8601. `getUTCDay()` calls Sunday 0, so Sunday is six days
 * into its week rather than the start of the next one. */
function startOfIsoWeek(date: Date): Date {
  const weekday = date.getUTCDay();
  return addDays(date, -(weekday === 0 ? 6 : weekday - 1));
}

const range = (start: Date, end: Date): DateRange => ({ start: iso(start), end: iso(end) });

/** The inclusive range a shortcut names, relative to `today` (YYYY-MM-DD).
 *
 * `end` is inclusive because Firefly's own date filters are: `last_7_days`
 * therefore spans today and the six days before it, not eight days.
 */
export function resolvePeriod(period: Period, today: string): DateRange {
  const now = toUtc(today);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const quarterMonth = Math.floor(month / 3) * 3;
  const rolling = (days: number): DateRange => range(addDays(now, -(days - 1)), now);

  switch (period) {
    case "today":
      return range(now, now);
    case "yesterday":
      return range(addDays(now, -1), addDays(now, -1));
    case "this_week":
      return range(startOfIsoWeek(now), addDays(startOfIsoWeek(now), 6));
    case "last_week":
      return range(addDays(startOfIsoWeek(now), -7), addDays(startOfIsoWeek(now), -1));
    case "this_month":
      return range(firstOfMonth(year, month), lastOfMonth(year, month));
    case "last_month":
      return range(firstOfMonth(year, month - 1), lastOfMonth(year, month - 1));
    case "this_quarter":
      return range(firstOfMonth(year, quarterMonth), lastOfMonth(year, quarterMonth + 2));
    case "last_quarter":
      return range(firstOfMonth(year, quarterMonth - 3), lastOfMonth(year, quarterMonth - 1));
    case "this_year":
      return range(firstOfMonth(year, 0), lastOfMonth(year, 11));
    case "last_year":
      return range(firstOfMonth(year - 1, 0), lastOfMonth(year - 1, 11));
    case "last_7_days":
      return rolling(7);
    case "last_30_days":
      return rolling(30);
    case "last_90_days":
      return rolling(90);
    case "last_365_days":
      return rolling(365);
  }
}

/** Today on the machine's own calendar, not UTC's.
 *
 * "Today" is a local idea: a container running UTC would otherwise answer for
 * yesterday until 03:00 for a user in UTC+3. The zone comes from the standard
 * `TZ` environment variable, so a deployment that needs a different one sets it
 * the way every other Unix service does.
 */
export function localToday(now: Date = new Date()): string {
  return iso(new Date(now.getTime() - now.getTimezoneOffset() * 60_000));
}
