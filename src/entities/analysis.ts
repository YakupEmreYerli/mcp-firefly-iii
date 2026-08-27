import { defineOperation, type EntityModule, type Operation } from "../registry.js";
import { EntityType } from "../types.js";
import type { FireflyClient } from "../firefly.js";
import { comparePeriodsInput, recurringInput, uncategorizedInput } from "../schemas/analysis.js";
import { buildOverview } from "./remaining.js";

/** One measure held against its baseline.
 *
 * `change_pct` is null rather than 0 or Infinity when the baseline is zero:
 * there is no percentage change from nothing, and reporting one would put a
 * fabricated number in front of the model. `stripEmpty` then drops the null on
 * the way out, so the model sees the field simply absent — which is why
 * `baseline` is always emitted, including as 0: it is what makes the absence
 * readable as "there was nothing to grow from" rather than as a missing field.
 * A genuine 0% change survives, since `stripEmpty` keeps zeroes.
 */
type Delta = { current: number; baseline: number; change: number; change_pct: number | null };

const MEASURES = ["income", "expense", "transfers", "net"] as const;

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Days in an inclusive range, so a single day counts as one. */
function inclusiveDays(start: string, end: string): number {
  const from = Date.parse(`${start}T00:00:00Z`);
  const to = Date.parse(`${end}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.floor((to - from) / 86_400_000) + 1;
}

function delta(current: number, baseline: number): Delta {
  const change = round(current - baseline);
  return {
    current: round(current),
    baseline: round(baseline),
    change,
    change_pct: baseline === 0 ? null : round((change / Math.abs(baseline)) * 100),
  };
}

type Overview = {
  totals: Record<string, Record<string, number>>;
  expense_by_category: { name: string; amount: number; currency_code: string }[];
};

/** `buildOverview` returns `unknown` because it mirrors Firefly's payload.
 * Read it defensively: an endpoint answering with an unexpected shape must
 * degrade to zeroes, not throw halfway through a comparison. */
function readOverview(value: unknown): Overview {
  const record = (value ?? {}) as Partial<Overview>;
  return {
    totals: typeof record.totals === "object" && record.totals !== null ? record.totals : {},
    expense_by_category: Array.isArray(record.expense_by_category) ? record.expense_by_category : [],
  };
}

async function comparePeriods(
  query: { start: string; end: string; baseline_start: string; baseline_end: string; currency_code?: string },
  client: FireflyClient,
): Promise<unknown> {
  // Firefly answers a reversed range with an empty period rather than an error,
  // which reads as "nothing was spent" instead of "bad input".
  if (query.end < query.start) throw new Error("end must not fall before start");
  if (query.baseline_end < query.baseline_start) throw new Error("baseline_end must not fall before baseline_start");

  const shared = query.currency_code === undefined ? {} : { currency_code: query.currency_code };
  const [currentRaw, baselineRaw] = await Promise.all([
    buildOverview({ start: query.start, end: query.end, ...shared }, client),
    buildOverview({ start: query.baseline_start, end: query.baseline_end, ...shared }, client),
  ]);
  const current = readOverview(currentRaw);
  const baseline = readOverview(baselineRaw);

  // Currencies stay separate all the way through. Summing them would need a
  // conversion rate this operation does not have, and a wrong total here is
  // indistinguishable from a right one.
  const totals: Record<string, Record<string, Delta>> = {};
  for (const code of new Set([...Object.keys(current.totals), ...Object.keys(baseline.totals)])) {
    const currentValues = current.totals[code] ?? {};
    const baselineValues = baseline.totals[code] ?? {};
    totals[code] = Object.fromEntries(
      MEASURES.map((measure) => [measure, delta(currentValues[measure] ?? 0, baselineValues[measure] ?? 0)]),
    );
  }

  // A category spent in only one of the two periods is the whole point of the
  // question — started or stopped — so it appears with a zero on the other
  // side rather than being dropped.
  const categories = new Map<string, { name: string; currency_code: string; current: number; baseline: number }>();
  const collect = (entries: Overview["expense_by_category"], side: "current" | "baseline") => {
    for (const entry of entries) {
      const key = `${entry.currency_code} ${entry.name}`;
      const existing = categories.get(key) ?? { name: entry.name, currency_code: entry.currency_code, current: 0, baseline: 0 };
      existing[side] += entry.amount;
      categories.set(key, existing);
    }
  };
  collect(current.expense_by_category, "current");
  collect(baseline.expense_by_category, "baseline");

  const expenseByCategory = [...categories.values()]
    .map((entry) => ({ name: entry.name, currency_code: entry.currency_code, ...delta(entry.current, entry.baseline) }))
    // Largest movement first: "what changed most" is the question being asked,
    // and a big drop matters as much as a big rise.
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

  const periodDays = inclusiveDays(query.start, query.end);
  const baselineDays = inclusiveDays(query.baseline_start, query.baseline_end);
  return {
    period: { start: query.start, end: query.end, end_is_inclusive: true, days: periodDays },
    baseline: { start: query.baseline_start, end: query.baseline_end, end_is_inclusive: true, days: baselineDays },
    // Stated rather than corrected for: comparing a 28-day month with a 31-day
    // one is legitimate, but the model should say so instead of reading the
    // difference as behaviour.
    equal_length: periodDays === baselineDays,
    totals,
    expense_by_category: expenseByCategory,
    expense_category_count: expenseByCategory.length,
  };
}


/** One withdrawal, flattened out of Firefly's split envelope. */
type Spend = { date: string; amount: number; payee: string; currency: string; category?: string; description: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every transaction in a period, one row per split.
 *
 * Paged rather than taking the first page: a pattern is a claim about all the
 * payments, and one silently left on page two would change the answer.
 */
async function spendingIn(start: string, end: string, client: FireflyClient): Promise<Spend[]> {
  const rows: Spend[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const payload = await client.get("/transactions", { start, end, limit: 100, page });
    if (!isRecord(payload) || !Array.isArray(payload.data)) break;
    for (const record of payload.data) {
      if (!isRecord(record)) continue;
      const attributes = isRecord(record.attributes) ? record.attributes : record;
      const splits = Array.isArray(attributes.transactions) ? attributes.transactions.filter(isRecord) : [attributes];
      for (const split of splits) {
        if (split.type !== "withdrawal") continue;
        const amount = Number(split.amount);
        if (!Number.isFinite(amount)) continue;
        rows.push({
          date: String(split.date ?? "").slice(0, 10),
          amount: Math.abs(amount),
          payee: String(split.destination_name ?? "").trim() || "unknown",
          currency: String(split.currency_code ?? "unknown"),
          category: typeof split.category_name === "string" && split.category_name !== "" ? split.category_name : undefined,
          description: String(split.description ?? ""),
        });
      }
    }
    const meta = isRecord(payload.meta) && isRecord(payload.meta.pagination) ? payload.meta.pagination : {};
    const total = Number(meta.total_pages);
    if (!Number.isFinite(total) || page >= total) break;
  }
  return rows;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? round((sorted[middle - 1]! + sorted[middle]!) / 2) : sorted[middle]!;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Payments that repeat to the same payee.
 *
 * Reports what was measured and stops there. It does not label anything a
 * "subscription", and it does not decide whether one is still running: that
 * needs knowledge the ledger does not hold — a fixed monthly charge last paid
 * three days ago may have been cancelled yesterday, as one was here. The
 * interval and the gap since the last payment are given so the caller can ask
 * the user rather than the server guessing on their behalf.
 */
async function recurringExpenses(
  query: { start: string; end: string; min_occurrences?: number },
  client: FireflyClient,
): Promise<unknown> {
  if (query.end < query.start) throw new Error("end must not fall before start");
  const minimum = query.min_occurrences ?? 3;
  const rows = await spendingIn(query.start, query.end, client);

  const groups = new Map<string, Spend[]>();
  for (const row of rows) {
    const key = `${row.currency}\u0000${row.payee}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  const found = [];
  for (const payments of groups.values()) {
    if (payments.length < minimum) continue;
    payments.sort((a, b) => a.date.localeCompare(b.date));
    const amounts = payments.map((p) => p.amount);
    const gaps = payments.slice(1).map((p, index) => daysBetween(payments[index]!.date, p.date)).filter((g) => g > 0);
    const distinctAmounts = new Set(amounts.map((a) => a.toFixed(2)));
    const first = payments[0]!;
    const last = payments[payments.length - 1]!;
    found.push({
      payee: first.payee,
      currency_code: first.currency,
      occurrences: payments.length,
      months_covered: new Set(payments.map((p) => p.date.slice(0, 7))).size,
      amount_is_identical_every_time: distinctAmounts.size === 1,
      amount_min: round(Math.min(...amounts)),
      amount_max: round(Math.max(...amounts)),
      amount_median: median(amounts),
      total: round(amounts.reduce((sum, value) => sum + value, 0)),
      typical_interval_days: gaps.length > 0 ? median(gaps) : undefined,
      first_seen: first.date,
      last_seen: last.date,
      days_since_last_seen: daysBetween(last.date, query.end),
      categories: [...new Set(payments.map((p) => p.category).filter((c): c is string => c !== undefined))],
    });
  }

  found.sort((a, b) => b.total - a.total);
  return {
    period: { start: query.start, end: query.end, end_is_inclusive: true },
    min_occurrences: minimum,
    recurring_count: found.length,
    recurring: found,
    note:
      "Repetition measured from the ledger. Whether a payment is still expected is not something " +
      "the ledger records — check days_since_last_seen against typical_interval_days, and ask the user.",
  };
}

/** Spending that carries no category, grouped by who was paid.
 *
 * Grouped rather than listed one by one because that is how the gap gets
 * closed: one decision per payee sets a category for every payment to it.
 */
async function uncategorized(
  query: { start: string; end: string; limit?: number },
  client: FireflyClient,
): Promise<unknown> {
  if (query.end < query.start) throw new Error("end must not fall before start");
  const rows = (await spendingIn(query.start, query.end, client)).filter((row) => row.category === undefined);

  const groups = new Map<string, Spend[]>();
  for (const row of rows) {
    const key = `${row.currency}\u0000${row.payee}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  const listed = [...groups.values()]
    .map((payments) => ({
      payee: payments[0]!.payee,
      currency_code: payments[0]!.currency,
      count: payments.length,
      total: round(payments.reduce((sum, p) => sum + p.amount, 0)),
      first_seen: payments.reduce((a, b) => (a.date < b.date ? a : b)).date,
      last_seen: payments.reduce((a, b) => (a.date > b.date ? a : b)).date,
      example_description: payments[0]!.description.slice(0, 120),
    }))
    .sort((a, b) => b.total - a.total);

  const shown = listed.slice(0, query.limit ?? 25);
  return {
    period: { start: query.start, end: query.end, end_is_inclusive: true },
    uncategorized_transactions: rows.length,
    payees_without_a_category: listed.length,
    payees_shown: shown.length,
    total_by_currency: [...new Set(rows.map((r) => r.currency))].map((currency) => ({
      currency_code: currency,
      total: round(rows.filter((r) => r.currency === currency).reduce((sum, r) => sum + r.amount, 0)),
    })),
    payees: shown,
    note: "One category per payee closes every payment to it — see transaction.bulk_categorize.",
  };
}

export const analysisOperations: Record<string, Operation> = {
  compare_periods: defineOperation({
    description: "What changed between this period and an earlier one, in income, spending, and per category?",
    access: "read",
    input: comparePeriodsInput,
    handler: (q, c) => comparePeriods(q, c),
  }),
  recurring_expenses: defineOperation({
    description: "Which payments repeat to the same payee, how often, and how much do they vary?",
    access: "read",
    input: recurringInput,
    handler: (q, c) => recurringExpenses(q, c),
  }),
  uncategorized: defineOperation({
    description: "Which spending has no category yet, and who was paid?",
    access: "read",
    input: uncategorizedInput,
    handler: (q, c) => uncategorized(q, c),
  }),
};

export const analysisModule: EntityModule = {
  entity: EntityType.Analysis,
  hint: "derived comparisons across periods, computed rather than fetched",
  operations: analysisOperations,
};
