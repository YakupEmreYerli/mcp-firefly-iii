import { describe, expect, it } from "vitest";
import { Registry } from "../../src/registry.js";
import { insightModule, summaryModule } from "../../src/entities/remaining.js";
import { EntityType } from "../../src/types.js";
import { FireflyApiError, ValidationError } from "../../src/errors.js";
import type { Config } from "../../src/config.js";
import type { FireflyClient, Query } from "../../src/firefly.js";

const PERIOD = { start: "2026-08-01", end: "2026-08-31" };

/** One insight row as Firefly returns it.
 *
 * Expenses come back NEGATIVE; income and transfers positive. Every
 * expectation about signs below rests on that.
 */
function row(difference_float: number, currency_code = "TRY", name?: string) {
  return { difference_float, difference: String(difference_float), currency_code, ...(name ? { name } : {}) };
}

function clientReturning(byPath: Record<string, unknown>): {
  client: FireflyClient;
  paths: { path: string; query?: Query }[];
} {
  const paths: { path: string; query?: Query }[] = [];
  const client: FireflyClient = {
    get: async (path, query) => {
      paths.push({ path, query });
      return byPath[path] ?? { data: [] };
    },
    getText: async () => "",
    post: async () => ({}),
    put: async () => ({}),
    del: async () => null,
    postBinary: async () => ({}),
  };
  return { client, paths };
}

function makeRegistry(client: FireflyClient): Registry {
  const config: Config = {
    apiUrl: "https://firefly.example/api/v1",
    apiToken: "token",
    readOnly: false,
    permissions: { fallback: "destructive", byEntity: new Map() },
    directMode: false,
    enabledEntities: new Set(Object.values(EntityType)),
    structuredOutput: false, disableSslVerify: false,
    logLevel: "INFO",
  };
  const registry = new Registry(config, client);
  registry.register(insightModule);
  registry.register(summaryModule);
  return registry;
}

const BASIC = {
  data: {
    "balance-in-TRY": { key: "balance-in-TRY", monetary_value: 1500.25 },
    "net-worth-in-TRY": { key: "net-worth-in-TRY", monetary_value: 42000 },
    "spent-in-TRY": { key: "spent-in-TRY", monetary_value: -800 },
  },
};

function overviewPayloads(overrides: Record<string, unknown> = {}) {
  return {
    "/insight/income/total": [row(5000)],
    "/insight/expense/total": [row(-1800.5)],
    "/insight/transfer/total": [row(250)],
    "/insight/expense/category": [row(-1200, "TRY", "Market"), row(-600.5, "TRY", "Ulaşım")],
    "/summary/basic": BASIC,
    ...overrides,
  };
}

type Overview = {
  period: { start: string; end: string; end_is_inclusive: boolean };
  totals: Record<string, { income: number; expense: number; transfers: number; net: number }>;
  expense_by_category: { name: string; amount: number; currency_code: string }[];
  expense_category_count: number;
  balances: Record<string, unknown>;
};

async function runOverview(overrides: Record<string, unknown> = {}): Promise<{
  result: Overview;
  paths: { path: string; query?: Query }[];
}> {
  const { client, paths } = clientReturning(overviewPayloads(overrides));
  const result = (await makeRegistry(client).execute("summary", "overview", PERIOD)) as Overview;
  return { result, paths };
}

describe("insight operations", () => {
  it("maps every operation name to its Firefly path", async () => {
    const expected: Record<string, string> = {
      expense_total: "/insight/expense/total",
      expense_category: "/insight/expense/category",
      expense_budget: "/insight/expense/budget",
      expense_tag: "/insight/expense/tag",
      expense_no_category: "/insight/expense/no-category",
      income_total: "/insight/income/total",
      income_category: "/insight/income/category",
      transfer_total: "/insight/transfer/total",
    };

    for (const [operation, path] of Object.entries(expected)) {
      const { client, paths } = clientReturning({});
      await makeRegistry(client).execute("insight", operation, PERIOD);
      expect(paths[0]?.path, operation).toBe(path);
    }
  });

  it("requires both ends of the period", async () => {
    const { client } = clientReturning({});
    await expect(
      makeRegistry(client).execute("insight", "expense_total", { start: "2026-08-01" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects a date that is not YYYY-MM-DD", async () => {
    const { client } = clientReturning({});
    await expect(
      makeRegistry(client).execute("insight", "expense_total", { ...PERIOD, start: "01.08.2026" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("passes the period straight through without shifting the end date", async () => {
    // `end` is inclusive in Firefly. Nudging it by a day to mean "one day"
    // would pull the next day in, so the value must reach the API untouched.
    const { client, paths } = clientReturning({});
    await makeRegistry(client).execute("insight", "expense_total", {
      start: "2026-08-25",
      end: "2026-08-25",
    });

    expect(paths[0]?.query).toEqual({ start: "2026-08-25", end: "2026-08-25" });
  });
});

describe("summary.basic", () => {
  it("returns Firefly's own summary block untouched apart from trimming", async () => {
    const { client, paths } = clientReturning({ "/summary/basic": BASIC });
    const result = await makeRegistry(client).execute("summary", "basic", PERIOD);

    expect(paths[0]?.path).toBe("/summary/basic");
    expect(result).toEqual(BASIC);
  });
});

describe("summary.overview", () => {
  it("answers from one call instead of four insight round-trips", async () => {
    const { paths } = await runOverview();

    expect(paths.map((call) => call.path).sort()).toEqual([
      "/insight/expense/category",
      "/insight/expense/total",
      "/insight/income/total",
      "/insight/transfer/total",
      "/summary/basic",
    ]);
  });

  it("reports spending as a positive magnitude even though Firefly returns it negative", async () => {
    const { result } = await runOverview();

    expect(result.totals.TRY?.expense).toBe(1800.5);
  });

  it("keeps income positive", async () => {
    const { result } = await runOverview();

    expect(result.totals.TRY?.income).toBe(5000);
  });

  it("computes net as income minus spending", async () => {
    const { result } = await runOverview();

    expect(result.totals.TRY?.net).toBe(3199.5);
  });

  it("does not let floating point noise into net", async () => {
    const { result } = await runOverview({
      "/insight/income/total": [row(0.3)],
      "/insight/expense/total": [row(-0.1)],
    });

    expect(result.totals.TRY?.net).toBe(0.2);
  });

  it("fills a missing currency's fields with zero rather than leaving them absent", async () => {
    // Firefly omits a currency entirely when it has no movement of that kind.
    const { result } = await runOverview({ "/insight/income/total": [] });

    expect(result.totals.TRY).toEqual({ income: 0, expense: 1800.5, transfers: 250, net: -1800.5 });
  });

  it("groups the totals per currency", async () => {
    const { result } = await runOverview({
      "/insight/income/total": [row(5000, "TRY"), row(120, "EUR")],
      "/insight/expense/total": [row(-1800.5, "TRY"), row(-40, "EUR")],
      "/insight/transfer/total": [],
    });

    expect(result.totals.EUR).toEqual({ income: 120, expense: 40, transfers: 0, net: 80 });
  });

  it("orders the category breakdown by amount, largest first", async () => {
    const { result } = await runOverview({
      "/insight/expense/category": [row(-600.5, "TRY", "Ulaşım"), row(-1200, "TRY", "Market")],
    });

    expect(result.expense_by_category.map((entry) => entry.name)).toEqual(["Market", "Ulaşım"]);
  });

  it("reports category amounts as positive magnitudes", async () => {
    const { result } = await runOverview();

    expect(result.expense_by_category[0]).toEqual({
      name: "Market",
      amount: 1200,
      currency_code: "TRY",
    });
  });

  it("names an unlabelled category rather than dropping it", async () => {
    const { result } = await runOverview({ "/insight/expense/category": [row(-50)] });

    expect(result.expense_by_category[0]?.name).toBe("unknown");
  });

  it("counts the categories it returned", async () => {
    const { result } = await runOverview();

    expect(result.expense_category_count).toBe(result.expense_by_category.length);
  });

  it("keeps only balance and net-worth entries out of the basic summary", async () => {
    const { result } = await runOverview();

    expect(result.balances).toEqual({ "balance-in-TRY": 1500.25, "net-worth-in-TRY": 42000 });
  });

  it("states in the payload that the end date is inclusive", async () => {
    const { result } = await runOverview();

    expect(result.period).toEqual({ start: "2026-08-01", end: "2026-08-31", end_is_inclusive: true });
  });

  it("still answers when Firefly refuses the balance query, as it does for a single day", async () => {
    // /summary/basic returns 422 when start === end, while every insight endpoint
    // accepts it. Losing the balances must not cost the whole period.
    const client: FireflyClient = {
      get: async (path, query) => {
        if (path === "/summary/basic") throw new FireflyApiError(422, "start must be before end");
        if (path === "/insight/expense/total") return [row(-204.99)];
        if (path === "/insight/expense/category") return [row(-204.99, "TRY", "Market")];
        void query;
        return [];
      },
      getText: async () => "", post: async () => ({}), put: async () => ({}),
      del: async () => null, postBinary: async () => ({}),
    };
    const result = (await makeRegistry(client).execute("summary", "overview", {
      start: "2026-08-26", end: "2026-08-26",
    })) as Overview & { balances_unavailable?: string };
    expect(result.totals.TRY?.expense).toBe(204.99);
    expect(result.expense_by_category[0]?.name).toBe("Market");
  });

  it("says the balances are missing rather than letting them read as zero", async () => {
    const client: FireflyClient = {
      get: async (path) => {
        if (path === "/summary/basic") throw new FireflyApiError(422, "start must be before end");
        return [];
      },
      getText: async () => "", post: async () => ({}), put: async () => ({}),
      del: async () => null, postBinary: async () => ({}),
    };
    const result = (await makeRegistry(client).execute("summary", "overview", {
      start: "2026-08-26", end: "2026-08-26",
    })) as { balances_unavailable?: string };
    expect(result.balances_unavailable).toMatch(/refused the balance query/);
  });

  it("survives an insight endpoint answering with an unexpected shape", async () => {
    const { result } = await runOverview({ "/insight/expense/total": { unexpected: true } });

    expect(result.totals.TRY?.expense).toBe(0);
  });
});
