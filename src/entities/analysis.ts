import { defineOperation, type EntityModule, type Operation } from "../registry.js";
import { EntityType } from "../types.js";
import type { FireflyClient } from "../firefly.js";
import { comparePeriodsInput } from "../schemas/analysis.js";
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

export const analysisOperations: Record<string, Operation> = {
  compare_periods: defineOperation({
    description: "What changed between this period and an earlier one, in income, spending, and per category?",
    access: "read",
    input: comparePeriodsInput,
    handler: (q, c) => comparePeriods(q, c),
  }),
};

export const analysisModule: EntityModule = {
  entity: EntityType.Analysis,
  hint: "derived comparisons across periods, computed rather than fetched",
  operations: analysisOperations,
};
