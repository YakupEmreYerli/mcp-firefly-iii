import { describe, expect, it } from "vitest";
import { Registry } from "../../src/registry.js";
import { EntityType } from "../../src/types.js";
import type { Config } from "../../src/config.js";
import type { FireflyClient, Query } from "../../src/firefly.js";
import { ENTITY_MODULES } from "../../src/server.js";
import { FireflyApiError } from "../../src/errors.js";
import { localToday, resolvePeriod } from "../../src/period.js";

type Call = { method: string; path: string; body?: unknown; query?: Query };

function setup(): { registry: Registry; calls: Call[] } {
  const calls: Call[] = [];
  const client: FireflyClient = {
    get: async (path, query) => { calls.push({ method: "GET", path, query }); return {}; },
    getText: async () => "",
    post: async (path, body, query) => { calls.push({ method: "POST", path, body, query }); return {}; },
    put: async (path, body) => { calls.push({ method: "PUT", path, body }); return {}; },
    del: async (path, query) => { calls.push({ method: "DELETE", path, query }); return null; },
    postBinary: async () => null,
  };
  const config: Config = {
    apiUrl: "https://firefly.example/api/v1", apiToken: "",
    structuredOutput: false, resourceUrl: "", authorizationServers: [], disableSslVerify: false,
  };
  const registry = new Registry(config, client);
  for (const module of ENTITY_MODULES) registry.register(module);
  return { registry, calls };
}

describe("entity parity surface", () => {
  // 139 mirror a Firefly endpoint; the rest are computed here — three analyses
  // and four name resolvers.
  it("registers every operation the modules declare", () => {
    const { registry } = setup();
    expect(registry.listOperations()).toHaveLength(152);
  });

  it("uses the Python insight paths", async () => {
    const { registry, calls } = setup();
    await registry.execute("insight", "expense_category", { start: "2026-08-01", end: "2026-08-31" });
    expect(calls[0]!.path).toBe("/insight/expense/category");
  });

  it("keeps search accounts field default explicit", async () => {
    const { registry, calls } = setup();
    await registry.execute("search", "accounts", { query: "cash" });
    expect(calls[0]!.query).toEqual({ query: "cash", field: "all" });
  });

  it("sends nested update payloads to their resource endpoint", async () => {
    const { registry, calls } = setup();
    await registry.execute("budget", "update", { id: "2", budget_update: { name: "Food" } });
    await registry.execute("bill", "update", { id: "3", bill_update: { name: "Rent" } });
    await registry.execute("piggy_bank", "update", { id: "4", piggy_bank_update: { name: "Trip" } });
    expect(calls.map(({ path, body }) => ({ path, body }))).toEqual([
      { path: "/budgets/2", body: { name: "Food" } },
      { path: "/bills/3", body: { name: "Rent" } },
      { path: "/piggy-banks/4", body: { name: "Trip" } },
    ]);
  });

  it("uses query-only POSTs for rule triggers", async () => {
    const { registry, calls } = setup();
    await registry.execute("rule", "trigger", { id: "8", start: "2026-08-01", end: "2026-08-02" });
    expect(calls[0]).toEqual({ method: "POST", path: "/rules/8/trigger", body: undefined, query: { start: "2026-08-01", end: "2026-08-02" } });
  });

  it("rejects unknown input keys across migrated modules", async () => {
    const { registry } = setup();
    await expect(registry.execute("bill", "list", { unexpected: true })).rejects.toThrow("Unrecognized key");
  });

  it("gives every migrated operation a strict input schema and access tag", () => {
    for (const module of ENTITY_MODULES) {
      for (const [name, operation] of Object.entries(module.operations)) {
        expect(["read", "write", "destructive"], `${module.entity}.${name}`).toContain(operation.access);
        expect(operation.description.length, `${module.entity}.${name} description`).toBeGreaterThan(0);
        const result = operation.input.safeParse({ __unknown_test_key__: true });
        expect(result.success, `${module.entity}.${name} must reject unknown keys`).toBe(false);
      }
    }
  });

  it("keeps the direct operation schemas usable for schema discovery", () => {
    const { registry } = setup();
    for (const module of ENTITY_MODULES) {
      for (const name of Object.keys(module.operations)) {
        const schema = registry.getSchema(module.entity, name);
        expect(schema).toMatchObject({ type: "object", additionalProperties: false });
      }
    }
  });

  it("exercises every operation through Registry.execute", async () => {
    const { registry, calls } = setup();
    const samples: Record<string, unknown> = {
      "account.list": {}, "account.get": { id: "1" }, "account.create": { name: "Cash", type: "asset" },
      "account.update": { id: "1", account_update: { name: "Cash" } }, "account.delete": { id: "1" },
      "account.list_transactions": { id: "1" }, "account.list_attachments": { id: "1" }, "account.list_piggy_banks": { id: "1" },
      "transaction.list": {}, "transaction.get": { id: "1" }, "transaction.list_attachments": { id: "1" },
      "transaction.list_piggy_bank_events": { id: "1" }, "transaction.create": { transactions: [{ type: "withdrawal", date: "2026-08-01", amount: "1", description: "x" }] },
      "transaction.update": { id: "1", transactions: [{ transaction_journal_id: "1", amount: "1", description: "x" }] },
      "transaction.delete": { id: "1" }, "transaction.bulk_categorize": { transaction_ids: [1], category_name: "Food" },
      "transaction.bulk_tag": { transaction_ids: [1], tag_names: ["x"] },
      "category.list": {}, "category.get": { id: "1" }, "category.create": { name: "Food" },
      "category.update": { id: "1", category_update: { name: "Food" } }, "category.delete": { id: "1" },
      "category.list_transactions": { id: "1" }, "category.list_attachments": { id: "1" },
      "tag.list": {}, "tag.get": { id: "1" }, "tag.create": { tag: "x" }, "tag.update": { id: "1", tag_update: {} },
      "tag.delete": { id: "1" }, "tag.list_transactions": { id: "1" }, "tag.list_attachments": { id: "1" },
      "budget.list": {}, "budget.get": { id: "1" }, "budget.create": { name: "Food" },
      "budget.update": { id: "1", budget_update: { name: "Food" } }, "budget.delete": { id: "1" },
      "budget.list_limits": { id: "1" }, "budget.get_limit": { budget_id: "1", limit_id: "2" },
      "budget.create_limit": { budget_id: "1", budget_limit_store: { amount: "10", start: "2026-08-01", end: "2026-08-31" } },
      "budget.update_limit": { budget_id: "1", limit_id: "2", budget_limit: { amount: "10", start: "2026-08-01", end: "2026-08-31" } },
      "budget.delete_limit": { budget_id: "1", limit_id: "2" }, "budget.list_transactions": { id: "1" },
      "budget.list_attachments": { id: "1" }, "budget.list_transactions_without_budget": {},
      "bill.list": {}, "bill.get": { id: "1" }, "bill.create": { name: "Rent", amount_min: "1", amount_max: "1", date: "2026-08-27T00:00:00+03:00", repeat_freq: "monthly" },
      "bill.update": { id: "1", bill_update: { name: "Rent" } }, "bill.delete": { id: "1" },
      "bill.list_transactions": { id: "1" }, "bill.list_attachments": { id: "1" }, "bill.list_rules": { id: "1" },
      "piggy_bank.list": {}, "piggy_bank.get": { id: "1" }, "piggy_bank.create": { name: "Trip", target_amount: "1", start_date: "2026-08-27", accounts: [{ account_id: "1" }] },
      "piggy_bank.update": { id: "1", piggy_bank_update: { name: "Trip" } }, "piggy_bank.delete": { id: "1" },
      "piggy_bank.list_events": { id: "1" }, "piggy_bank.list_attachments": { id: "1" },
      "rule.list": {}, "rule.get": { id: "1" }, "rule.create": { title: "Rule", rule_group_id: "1", trigger: "store-journal", triggers: [{ type: "description_is", value: "x" }], actions: [{ type: "set_description", value: "x" }] },
      "rule.update": { id: "1", rule_update: { title: "Rule" } }, "rule.delete": { id: "1" },
      "rule.test": { id: "1" }, "rule.trigger": { id: "1" },
      "rule_group.list": {}, "rule_group.get": { id: "1" }, "rule_group.create": { title: "Group" },
      "rule_group.update": { id: "1", rule_group_update: { title: "Group" } }, "rule_group.delete": { id: "1" },
      "rule_group.list_rules": { id: "1" }, "rule_group.test": { id: "1" }, "rule_group.trigger": { id: "1" },
      "insight.expense_total": { start: "2026-08-01", end: "2026-08-31" }, "insight.expense_category": { start: "2026-08-01", end: "2026-08-31" },
      "insight.expense_budget": { start: "2026-08-01", end: "2026-08-31" }, "insight.expense_tag": { start: "2026-08-01", end: "2026-08-31" },
      "insight.expense_no_category": { start: "2026-08-01", end: "2026-08-31" }, "insight.income_total": { start: "2026-08-01", end: "2026-08-31" },
      "insight.income_category": { start: "2026-08-01", end: "2026-08-31" }, "insight.transfer_total": { start: "2026-08-01", end: "2026-08-31" },
      "summary.basic": { start: "2026-08-01", end: "2026-08-31" }, "summary.overview": { start: "2026-08-01", end: "2026-08-31" },
      "search.transactions": { query: "rent" }, "search.accounts": { query: "cash" },
    };
    expect(Object.keys(samples)).toHaveLength(86);
    for (const [name, params] of Object.entries(samples)) {
      const [entity, operation] = name.split(".");
      await expect(registry.execute(entity!, operation!, params), name).resolves.toBeDefined();
    }
    // summary.overview is intentionally composed from five read endpoints,
    // matching the Python implementation rather than a Firefly endpoint.
    expect(calls).toHaveLength(90);
  });
});

/** An overview over a client that answers each path from a table, so a single
 * endpoint can fail while the rest succeed — which is the only situation the
 * balance rescue is reached in. */
function overviewClient(handlers: Record<string, () => Promise<unknown>>): FireflyClient {
  return {
    get: async (path) => (handlers[path] ?? (async () => ({ data: [] })))(),
    getText: async () => "", post: async () => ({}), put: async () => ({}),
    del: async () => null, postBinary: async () => null,
  };
}

async function overview(client: FireflyClient, query: Record<string, unknown>): Promise<Record<string, unknown>> {
  const config: Config = {
    apiUrl: "https://firefly.example/api/v1", apiToken: "",
    structuredOutput: false, resourceUrl: "", authorizationServers: [], disableSslVerify: false,
  };
  const registry = new Registry(config, client);
  for (const module of ENTITY_MODULES) registry.register(module);
  return (await registry.execute("summary", "overview", query)) as Record<string, unknown>;
}

const range = { start: "2026-08-01", end: "2026-08-31" };

describe("overview balance rescue", () => {
  it("names the period when Firefly refused the range", async () => {
    const client = overviewClient({
      "/summary/basic": () => Promise.reject(new FireflyApiError(422, "The given data was invalid.")),
    });
    const result = await overview(client, range);
    expect(String(result.balances_unavailable)).toContain("this period");
  });

  it("does not report a broken connection as a refused period", async () => {
    // An expired token or a 500 is a property of the instance, not the dates.
    // Reporting it as "Firefly refused the balance query for this period" sends
    // the model to look at the range while the instance is the problem — and
    // the totals it is told are unaffected came from that same instance.
    const client = overviewClient({
      "/summary/basic": () => Promise.reject(new FireflyApiError(401, "Unauthenticated.")),
    });
    const result = await overview(client, range);
    expect(String(result.balances_unavailable)).toContain("Unauthenticated");
    expect(String(result.balances_unavailable)).not.toContain("this period");
  });
});

describe("overview currency filter", () => {
  const insight = (rows: unknown[]) => () => Promise.resolve(rows);

  it("restricts totals and categories to the currency asked for", async () => {
    const client = overviewClient({
      "/insight/income/total": insight([
        { currency_code: "TRY", difference_float: 100 },
        { currency_code: "EUR", difference_float: 50 },
      ]),
      "/insight/expense/total": insight([
        { currency_code: "TRY", difference_float: -40 },
        { currency_code: "EUR", difference_float: -10 },
      ]),
      "/insight/expense/category": insight([
        { name: "Market", currency_code: "TRY", difference_float: -30 },
        { name: "Reise", currency_code: "EUR", difference_float: -10 },
      ]),
    });
    const result = await overview(client, { ...range, currency_code: "TRY" });
    expect(Object.keys(result.totals as object)).toEqual(["TRY"]);
    expect((result.expense_by_category as { currency_code: string }[]).map((e) => e.currency_code)).toEqual(["TRY"]);
  });

  it("leaves every currency in place when none was asked for", async () => {
    const client = overviewClient({
      "/insight/income/total": insight([
        { currency_code: "TRY", difference_float: 100 },
        { currency_code: "EUR", difference_float: 50 },
      ]),
    });
    const result = await overview(client, range);
    expect(Object.keys(result.totals as object).sort()).toEqual(["EUR", "TRY"]);
  });
});

describe("period shortcuts on the analysis operations", () => {
  /** "What did I spend last month" lands on an insight endpoint, so a shortcut
   * that skipped these would leave the question it was built for unanswered. */
  it("reaches Firefly as the two dates the shortcut names", async () => {
    const { registry, calls } = setup();
    await registry.execute("insight", "expense_category", { period: "last_month" });
    const { start, end } = resolvePeriod("last_month", localToday());
    expect(calls[0]?.query).toEqual({ start, end });
  });

  it("works the same way on the composite overview", async () => {
    const { registry, calls } = setup();
    await registry.execute("summary", "overview", { period: "this_month" });
    const { start, end } = resolvePeriod("this_month", localToday());
    for (const call of calls) expect(call.query).toMatchObject({ start, end });
  });

  /** Firefly answers a range-less insight query with a period of its own
   * choosing, so a missing date would return a real-looking total for a period
   * nobody asked about. Loosening the schema to admit the shortcut must not
   * open that door. */
  it("still refuses when neither a shortcut nor dates arrive", async () => {
    const { registry, calls } = setup();
    await expect(registry.execute("insight", "expense_total", {})).rejects.toThrow(/needs a period/);
    await expect(registry.execute("summary", "basic", {})).rejects.toThrow(/needs a period/);
    expect(calls).toEqual([]);
  });

  it("names both accepted forms when it refuses, so the retry is obvious", async () => {
    const { registry } = setup();
    await expect(registry.execute("summary", "overview", {})).rejects.toThrow(
      /start and end .*or a period shortcut such as last_month/s,
    );
  });

  it("still refuses a half-given range", async () => {
    const { registry, calls } = setup();
    await expect(registry.execute("insight", "expense_total", { start: "2026-08-01" })).rejects.toThrow(
      /needs a period/,
    );
    expect(calls).toEqual([]);
  });
});

describe("Firefly's single-day refusal is made actionable", () => {
  function refusing(status: number, message = "Unprocessable"): { registry: Registry; calls: Call[] } {
    const { registry, calls } = setup();
    const client = (registry as unknown as { client: FireflyClient }).client;
    client.get = async (path, query) => {
      calls.push({ method: "GET", path, query });
      if (path === "/summary/basic") throw new FireflyApiError(status, message);
      return {};
    };
    return { registry, calls };
  }

  /** A bare "422 – Unprocessable" leaves the model to guess between malformed
   * dates, an empty period and a wrong endpoint, and guessing costs a retry
   * that fails the same way. */
  it("names the cause and a period that works", async () => {
    const { registry } = refusing(422);
    await expect(registry.execute("summary", "basic", { period: "today" })).rejects.toThrow(
      /single-day range.*last_7_days/s,
    );
  });

  it("keeps Firefly's own wording rather than replacing it", async () => {
    const { registry } = refusing(422, "The given data was invalid.");
    await expect(registry.execute("summary", "basic", { period: "today" })).rejects.toThrow(
      /The given data was invalid\./,
    );
  });

  /** The hint is an explanation, and an explanation that might be wrong is
   * worse than none: a 422 over a real range has some other cause. */
  it("says nothing extra about a 422 it cannot account for", async () => {
    const { registry } = refusing(422);
    await expect(
      registry.execute("summary", "basic", { start: "2026-07-01", end: "2026-07-31" }),
    ).rejects.toThrow(/^(?!.*single-day).*Unprocessable/s);
  });

  it("does not explain a refusal that is not a 422 at all", async () => {
    const { registry } = refusing(500, "Server exploded");
    await expect(registry.execute("summary", "basic", { period: "today" })).rejects.toThrow(
      /^(?!.*single-day).*Server exploded/s,
    );
  });

  /** overview survives this refusal by design — it reports the loss instead of
   * failing whole — so the report is where the advice has to appear. */
  it("tells the overview's reader the same thing, without failing the call", async () => {
    const { registry } = refusing(422);
    const result = await registry.execute("summary", "overview", { period: "today" });
    expect(JSON.stringify(result)).toMatch(/single-day range.*last_7_days/s);
  });
});
