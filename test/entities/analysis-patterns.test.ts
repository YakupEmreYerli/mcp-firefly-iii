import { describe, expect, it } from "vitest";
import { Registry } from "../../src/registry.js";
import { analysisModule } from "../../src/entities/analysis.js";
import { EntityType } from "../../src/types.js";
import { ValidationError } from "../../src/errors.js";
import type { Config } from "../../src/config.js";
import type { FireflyClient, Query } from "../../src/firefly.js";

type Split = {
  date: string; amount: string; type?: string;
  destination_name?: string; currency_code?: string; category_name?: string; description?: string;
};

/** Serves splits the way Firefly does: wrapped in a group, and paged. */
function client(splits: Split[], perPage = 100): { client: FireflyClient; queries: Query[] } {
  const queries: Query[] = [];
  const groups = splits.map((split, index) => ({
    id: String(index + 1),
    attributes: { transactions: [{ type: "withdrawal", currency_code: "TRY", description: "x", ...split }] },
  }));
  return {
    queries,
    client: {
      get: async (path, query) => {
        queries.push(query ?? {});
        if (path !== "/transactions") return { data: [] };
        const page = Number(query?.page ?? 1);
        const totalPages = Math.max(1, Math.ceil(groups.length / perPage));
        return {
          data: groups.slice((page - 1) * perPage, page * perPage),
          meta: { pagination: { total_pages: totalPages } },
        };
      },
      getText: async () => "", post: async () => ({}), put: async () => ({}),
      del: async () => null, postBinary: async () => ({}),
    },
  };
}

function registry(c: FireflyClient): Registry {
  const config: Config = {
    apiUrl: "https://firefly.example/api/v1", apiToken: "",
    structuredOutput: false,     resourceUrl: "", authorizationServers: [], disableSslVerify: false,
  };
  const result = new Registry(config, c);
  result.register(analysisModule);
  return result;
}

const PERIOD = { start: "2026-03-01", end: "2026-08-31" };
const monthly = (payee: string, amount: string, days: string[]) =>
  days.map((date) => ({ date, amount, destination_name: payee }));

type Recurring = {
  recurring_count: number;
  recurring: {
    payee: string; currency_code: string; occurrences: number; months_covered: number;
    amount_is_identical_every_time: boolean; amount_min: number; amount_max: number;
    amount_median: number; total: number; typical_interval_days?: number;
    first_seen: string; last_seen: string; days_since_last_seen: number; categories?: string[];
  }[];
};

const run = async (splits: Split[], params: Record<string, unknown> = PERIOD, perPage = 100): Promise<Recurring> => {
  const { client: c } = client(splits, perPage);
  return (await registry(c).execute("analysis", "recurring_expenses", params)) as Recurring;
};

describe("analysis.recurring_expenses", () => {
  const three = monthly("Netvay", "432.00", ["2026-06-11", "2026-07-11", "2026-08-09"]);

  it("reports a payment that repeats to the same payee", async () => {
    const result = await run(three);
    expect(result.recurring.map((r) => r.payee)).toEqual(["Netvay"]);
    expect(result.recurring[0]?.occurrences).toBe(3);
  });

  it("leaves out a payee seen fewer times than asked for", async () => {
    const result = await run(three.slice(0, 2));
    expect(result.recurring_count).toBe(0);
  });

  it("honours a lower threshold when the caller sets one", async () => {
    const result = await run(three.slice(0, 2), { ...PERIOD, min_occurrences: 2 });
    expect(result.recurring_count).toBe(1);
  });

  it("says when every payment was the same amount, which is the subscription tell", async () => {
    const result = await run(monthly("Discord", "104.99", ["2026-06-24", "2026-07-31", "2026-08-24"]));
    expect(result.recurring[0]?.amount_is_identical_every_time).toBe(true);
  });

  it("does not claim that of a payee whose amount moves", async () => {
    const result = await run([
      { date: "2026-06-11", amount: "432.00", destination_name: "Netvay" },
      { date: "2026-07-11", amount: "348.00", destination_name: "Netvay" },
      { date: "2026-08-09", amount: "432.00", destination_name: "Netvay" },
    ]);
    expect(result.recurring[0]?.amount_is_identical_every_time).toBe(false);
    expect(result.recurring[0]?.amount_min).toBe(348);
    expect(result.recurring[0]?.amount_max).toBe(432);
  });

  it("measures the gap between payments, which is what separates a subscription from shopping", async () => {
    const result = await run(monthly("Netvay", "432.00", ["2026-06-01", "2026-07-01", "2026-07-31"]));
    expect(result.recurring[0]?.typical_interval_days).toBe(30);
  });

  it("measures staleness against the end of the period, not against today", async () => {
    // Otherwise the same query would answer differently tomorrow.
    const result = await run(three);
    expect(result.recurring[0]?.days_since_last_seen).toBe(22);
  });

  it("keeps one payee's two currencies apart rather than merging them", async () => {
    const result = await run([
      ...monthly("Steam", "100.00", ["2026-06-01", "2026-07-01", "2026-08-01"]),
      ...monthly("Steam", "10.00", ["2026-06-02", "2026-07-02", "2026-08-02"]).map((s) => ({ ...s, currency_code: "USD" })),
    ]);
    expect(result.recurring).toHaveLength(2);
    expect(new Set(result.recurring.map((r) => r.currency_code))).toEqual(new Set(["TRY", "USD"]));
  });

  it("counts only spending, so an allowance arriving monthly is not a recurring expense", async () => {
    const result = await run(monthly("İşveren", "5000.00", ["2026-06-01", "2026-07-01", "2026-08-01"])
      .map((s) => ({ ...s, type: "deposit" })));
    expect(result.recurring_count).toBe(0);
  });

  it("reads every page, since a pattern is a claim about all the payments", async () => {
    const { client: c, queries } = client(monthly("Netvay", "432.00", ["2026-06-11", "2026-07-11", "2026-08-09"]), 1);
    const result = (await registry(c).execute("analysis", "recurring_expenses", PERIOD)) as Recurring;
    expect(result.recurring[0]?.occurrences).toBe(3);
    expect(queries.filter((q) => q.page !== undefined).length).toBeGreaterThan(1);
  });

  it("orders by what the payee costs in total, largest first", async () => {
    const result = await run([
      ...monthly("Küçük", "10.00", ["2026-06-01", "2026-07-01", "2026-08-01"]),
      ...monthly("Büyük", "500.00", ["2026-06-02", "2026-07-02", "2026-08-02"]),
    ]);
    expect(result.recurring.map((r) => r.payee)).toEqual(["Büyük", "Küçük"]);
  });

  it("rejects a reversed range rather than reporting the empty period Firefly returns", async () => {
    await expect(run([], { start: "2026-08-31", end: "2026-03-01" })).rejects.toThrow(/end must not fall before start/);
  });

  it("rejects a threshold below two, which would make every payment a pattern", async () => {
    await expect(run([], { ...PERIOD, min_occurrences: 1 })).rejects.toBeInstanceOf(ValidationError);
  });
});

type Uncategorized = {
  uncategorized_transactions: number;
  payees_without_a_category: number;
  payees_shown: number;
  total_by_currency: { currency_code: string; total: number }[];
  payees: { payee: string; count: number; total: number; first_seen: string; last_seen: string }[];
};

const runU = async (splits: Split[], params: Record<string, unknown> = PERIOD): Promise<Uncategorized> => {
  const { client: c } = client(splits);
  return (await registry(c).execute("analysis", "uncategorized", params)) as Uncategorized;
};

describe("analysis.uncategorized", () => {
  it("leaves out spending that already has a category", async () => {
    const result = await runU([
      { date: "2026-06-01", amount: "10.00", destination_name: "A", category_name: "Market" },
      { date: "2026-06-02", amount: "20.00", destination_name: "B" },
    ]);
    expect(result.uncategorized_transactions).toBe(1);
    expect(result.payees[0]?.payee).toBe("B");
  });

  it("treats an empty category as no category, not as a category named nothing", async () => {
    const result = await runU([{ date: "2026-06-01", amount: "10.00", destination_name: "A", category_name: "" }]);
    expect(result.uncategorized_transactions).toBe(1);
  });

  it("groups by payee, because one decision there settles every payment to it", async () => {
    const result = await runU([
      { date: "2026-06-01", amount: "10.00", destination_name: "Trendyol" },
      { date: "2026-06-05", amount: "30.00", destination_name: "Trendyol" },
    ]);
    expect(result.payees).toHaveLength(1);
    expect(result.payees[0]).toMatchObject({ count: 2, total: 40, first_seen: "2026-06-01", last_seen: "2026-06-05" });
  });

  it("orders by what is at stake, largest total first", async () => {
    const result = await runU([
      { date: "2026-06-01", amount: "10.00", destination_name: "Küçük" },
      { date: "2026-06-02", amount: "900.00", destination_name: "Büyük" },
    ]);
    expect(result.payees.map((p) => p.payee)).toEqual(["Büyük", "Küçük"]);
  });

  it("keeps totals per currency instead of adding them together", async () => {
    const result = await runU([
      { date: "2026-06-01", amount: "100.00", destination_name: "A" },
      { date: "2026-06-02", amount: "10.00", destination_name: "B", currency_code: "USD" },
    ]);
    expect(result.total_by_currency).toEqual(
      expect.arrayContaining([{ currency_code: "TRY", total: 100 }, { currency_code: "USD", total: 10 }]),
    );
  });

  it("still reports how many payees exist when it only shows some", async () => {
    const splits = ["A", "B", "C"].map((p, i) => ({ date: "2026-06-0" + (i + 1), amount: "10.00", destination_name: p }));
    const result = await runU(splits, { ...PERIOD, limit: 2 });
    expect(result.payees_shown).toBe(2);
    expect(result.payees_without_a_category).toBe(3);
  });

  it("rejects a reversed range", async () => {
    await expect(runU([], { start: "2026-08-31", end: "2026-03-01" })).rejects.toThrow(/end must not fall before start/);
  });
});

describe("the page cap is reported, not hidden", () => {
  /** 21 pages of 100, one past the 20-page cap the scan stops at. */
  const overCap = Array.from({ length: 2100 }, (_unused, index) => ({
    date: "2026-08-01",
    amount: "1.00",
    destination_name: `Payee ${index % 3}`,
  }));

  it("says so when recurring_expenses could not read the whole period", async () => {
    // The counts are the answer to the question, and a truncated scan reports
    // occurrences and totals that look like complete ones. Better a lower bound
    // the caller can see than a wrong number they cannot.
    const { client: c } = client(overCap);
    const result = (await registry(c).execute("analysis", "recurring_expenses", {
      start: "2026-08-01", end: "2026-08-31",
    })) as Record<string, unknown>;
    expect(result.truncated).toBe(true);
  });

  it("says so when uncategorized could not read the whole period", async () => {
    const { client: c } = client(overCap);
    const result = (await registry(c).execute("analysis", "uncategorized", {
      start: "2026-08-01", end: "2026-08-31",
    })) as Record<string, unknown>;
    expect(result.truncated).toBe(true);
  });

  it("stays quiet when the whole period fitted", async () => {
    const { client: c } = client([{ date: "2026-08-01", amount: "1.00", destination_name: "Payee" }]);
    const result = (await registry(c).execute("analysis", "uncategorized", {
      start: "2026-08-01", end: "2026-08-31",
    })) as Record<string, unknown>;
    expect(result.truncated).toBeUndefined();
  });
});
