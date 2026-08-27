import { describe, expect, it } from "vitest";
import { Registry } from "../../src/registry.js";
import { analysisModule } from "../../src/entities/analysis.js";
import { EntityType } from "../../src/types.js";
import { ValidationError } from "../../src/errors.js";
import type { Config } from "../../src/config.js";
import type { FireflyClient, Query } from "../../src/firefly.js";

const AUGUST = { start: "2026-08-01", end: "2026-08-31" };
const JULY = { baseline_start: "2026-07-01", baseline_end: "2026-07-31" };
const BOTH = { ...AUGUST, ...JULY };

/** One insight row as Firefly returns it: expenses NEGATIVE, income positive. */
function row(difference_float: number, currency_code = "TRY", name?: string) {
  return { difference_float, difference: String(difference_float), currency_code, ...(name ? { name } : {}) };
}

type Period = {
  income?: unknown[];
  expense?: unknown[];
  transfers?: unknown[];
  categories?: unknown[];
};

/** Answers each insight path differently per period.
 *
 * `buildOverview` runs twice against the same client, so the mock has to split
 * on `query.start` — otherwise both periods would read identical and every
 * delta below would be zero no matter what the code did.
 */
function clientForPeriods(current: Period, baseline: Period): { client: FireflyClient; queries: Query[] } {
  const queries: Query[] = [];
  const pick = (query: Query | undefined) => (query?.start === AUGUST.start ? current : baseline);
  const client: FireflyClient = {
    get: async (path, query) => {
      queries.push(query ?? {});
      const period = pick(query);
      if (path === "/insight/income/total") return period.income ?? [];
      if (path === "/insight/expense/total") return period.expense ?? [];
      if (path === "/insight/transfer/total") return period.transfers ?? [];
      if (path === "/insight/expense/category") return period.categories ?? [];
      return { data: {} };
    },
    getText: async () => "",
    post: async () => ({}),
    put: async () => ({}),
    del: async () => null,
    postBinary: async () => ({}),
  };
  return { client, queries };
}

function makeRegistry(client: FireflyClient): Registry {
  const config: Config = {
    apiUrl: "https://firefly.example/api/v1",
    apiToken: "token",
        permissions: { fallback: "destructive", byEntity: new Map() },
        structuredOutput: false, resourceUrl: "", authorizationServers: [], disableSslVerify: false,
    logLevel: "INFO",
  };
  const registry = new Registry(config, client);
  registry.register(analysisModule);
  return registry;
}

type Delta = { current: number; baseline: number; change: number; change_pct: number | null };
type Comparison = {
  period: { start: string; end: string; end_is_inclusive: boolean; days: number };
  baseline: { start: string; end: string; end_is_inclusive: boolean; days: number };
  equal_length: boolean;
  totals: Record<string, Record<"income" | "expense" | "transfers" | "net", Delta>>;
  expense_by_category: ({ name: string; currency_code: string } & Delta)[];
  expense_category_count: number;
};

async function compare(current: Period, baseline: Period, params: Record<string, unknown> = BOTH): Promise<Comparison> {
  const { client } = clientForPeriods(current, baseline);
  return (await makeRegistry(client).execute("analysis", "compare_periods", params)) as Comparison;
}

describe("analysis.compare_periods", () => {
  it("answers from one call instead of making the caller run two overviews and subtract", async () => {
    const { client, queries } = clientForPeriods({ expense: [row(-1800)] }, { expense: [row(-1200)] });
    await makeRegistry(client).execute("analysis", "compare_periods", BOTH);
    expect(queries.some((q) => q.start === AUGUST.start)).toBe(true);
    expect(queries.some((q) => q.start === JULY.baseline_start)).toBe(true);
  });

  it("reports spending as a positive magnitude even though Firefly returns it negative", async () => {
    const result = await compare({ expense: [row(-1800)] }, { expense: [row(-1200)] });
    expect(result.totals.TRY?.expense.current).toBe(1800);
    expect(result.totals.TRY?.expense.baseline).toBe(1200);
  });

  it("computes change as current minus baseline", async () => {
    const result = await compare({ expense: [row(-1800)] }, { expense: [row(-1200)] });
    expect(result.totals.TRY?.expense.change).toBe(600);
  });

  it("reports a drop as a negative change rather than a magnitude", async () => {
    const result = await compare({ expense: [row(-900)] }, { expense: [row(-1200)] });
    expect(result.totals.TRY?.expense.change).toBe(-300);
    expect(result.totals.TRY?.expense.change_pct).toBe(-25);
  });

  it("omits change_pct when the baseline is zero instead of reporting Infinity", async () => {
    // The handler sets it to null; stripEmpty then drops the key entirely, so
    // the readable signal is `baseline: 0` sitting next to a missing percentage.
    const result = await compare({ expense: [row(-500)] }, {});
    expect(result.totals.TRY?.expense.baseline).toBe(0);
    expect(result.totals.TRY?.expense.change_pct).toBeUndefined();
  });

  it("keeps a genuine zero percent change, which is not the same as no baseline", async () => {
    const result = await compare({ expense: [row(-500)] }, { expense: [row(-500)] });
    expect(result.totals.TRY?.expense.change_pct).toBe(0);
  });

  it("does not let floating point noise into a change", async () => {
    const result = await compare({ expense: [row(-0.3)] }, { expense: [row(-0.1)] });
    expect(result.totals.TRY?.expense.change).toBe(0.2);
  });

  it("keeps each currency's totals apart rather than summing them", async () => {
    const result = await compare(
      { expense: [row(-1800, "TRY"), row(-90, "EUR")] },
      { expense: [row(-1200, "TRY"), row(-30, "EUR")] },
    );
    expect(result.totals.TRY?.expense.change).toBe(600);
    expect(result.totals.EUR?.expense.change).toBe(60);
  });

  it("still reports a currency that appears in only one of the two periods", async () => {
    const result = await compare({ expense: [row(-90, "EUR")] }, { expense: [row(-1200, "TRY")] });
    expect(result.totals.EUR?.expense.current).toBe(90);
    expect(result.totals.EUR?.expense.baseline).toBe(0);
    expect(result.totals.TRY?.expense.current).toBe(0);
    expect(result.totals.TRY?.expense.baseline).toBe(1200);
  });

  it("keeps transfers out of net on both sides", async () => {
    const result = await compare(
      { income: [row(5000)], expense: [row(-2000)], transfers: [row(900)] },
      { income: [row(4000)], expense: [row(-1000)], transfers: [row(100)] },
    );
    expect(result.totals.TRY?.net.current).toBe(3000);
    expect(result.totals.TRY?.net.baseline).toBe(3000);
    expect(result.totals.TRY?.net.change).toBe(0);
    expect(result.totals.TRY?.transfers.change).toBe(800);
  });

  it("reports a category spent only in the current period as growth from zero", async () => {
    const result = await compare({ categories: [row(-400, "TRY", "Abonelik")] }, { categories: [] });
    const entry = result.expense_by_category.find((item) => item.name === "Abonelik");
    expect(entry?.current).toBe(400);
    expect(entry?.baseline).toBe(0);
    expect(entry?.change_pct).toBeUndefined();
  });

  it("keeps a category that stopped instead of dropping it from the comparison", async () => {
    const result = await compare({ categories: [] }, { categories: [row(-350, "TRY", "Spor")] });
    const entry = result.expense_by_category.find((item) => item.name === "Spor");
    expect(entry?.current).toBe(0);
    expect(entry?.baseline).toBe(350);
    expect(entry?.change).toBe(-350);
  });

  it("does not merge same-named categories billed in different currencies", async () => {
    const result = await compare(
      { categories: [row(-100, "TRY", "Market"), row(-40, "EUR", "Market")] },
      { categories: [] },
    );
    const entries = result.expense_by_category.filter((item) => item.name === "Market");
    expect(entries).toHaveLength(2);
    expect(entries.map((item) => item.currency_code).sort()).toEqual(["EUR", "TRY"]);
  });

  it("orders categories by how much they moved, counting a drop as movement", async () => {
    const result = await compare(
      { categories: [row(-100, "TRY", "Market"), row(-10, "TRY", "Ulaşım")] },
      { categories: [row(-90, "TRY", "Market"), row(-500, "TRY", "Tatil")] },
    );
    expect(result.expense_by_category.map((item) => item.name)).toEqual(["Tatil", "Market", "Ulaşım"]);
  });

  it("counts an inclusive range so a single day is one day", async () => {
    const result = await compare({}, {}, {
      start: "2026-08-26",
      end: "2026-08-26",
      baseline_start: "2026-08-25",
      baseline_end: "2026-08-25",
    });
    expect(result.period.days).toBe(1);
    expect(result.baseline.days).toBe(1);
    expect(result.period.end_is_inclusive).toBe(true);
  });

  it("flags periods of unequal length rather than scaling them to match", async () => {
    const result = await compare({}, {}, { ...AUGUST, baseline_start: "2026-02-01", baseline_end: "2026-02-28" });
    expect(result.period.days).toBe(31);
    expect(result.baseline.days).toBe(28);
    expect(result.equal_length).toBe(false);
  });

  it("rejects a reversed range instead of reporting the empty period Firefly returns", async () => {
    await expect(compare({}, {}, { ...JULY, start: "2026-08-31", end: "2026-08-01" })).rejects.toThrow(
      /end must not fall before start/,
    );
  });

  it("rejects a reversed baseline range too", async () => {
    await expect(
      compare({}, {}, { ...AUGUST, baseline_start: "2026-07-31", baseline_end: "2026-07-01" }),
    ).rejects.toThrow(/baseline_end must not fall before baseline_start/);
  });

  it("requires both periods", async () => {
    await expect(compare({}, {}, AUGUST)).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects a date that is not YYYY-MM-DD", async () => {
    await expect(compare({}, {}, { ...BOTH, start: "01/08/2026" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("passes a currency filter to both periods", async () => {
    const { client, queries } = clientForPeriods({}, {});
    await makeRegistry(client).execute("analysis", "compare_periods", { ...BOTH, currency_code: "TRY" });
    const filtered = queries.filter((q) => q.currency_code !== undefined);
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((q) => q.currency_code === "TRY")).toBe(true);
  });

  it("survives an insight endpoint answering with an unexpected shape", async () => {
    const client: FireflyClient = {
      get: async () => "not json at all",
      getText: async () => "",
      post: async () => ({}),
      put: async () => ({}),
      del: async () => null,
      postBinary: async () => ({}),
    };
    const result = (await makeRegistry(client).execute("analysis", "compare_periods", BOTH)) as Comparison;
    // stripEmpty drops the empty list, so the count is what carries "none".
    expect(result.expense_by_category).toBeUndefined();
    expect(result.expense_category_count).toBe(0);
  });

  it("is a read operation, so read-only mode keeps it available", () => {
    expect(analysisModule.operations.compare_periods?.access).toBe("read");
  });
});
