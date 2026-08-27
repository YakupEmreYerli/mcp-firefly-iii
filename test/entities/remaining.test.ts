import { describe, expect, it } from "vitest";
import { Registry } from "../../src/registry.js";
import { EntityType } from "../../src/types.js";
import type { Config } from "../../src/config.js";
import type { FireflyClient, Query } from "../../src/firefly.js";
import { ENTITY_MODULES } from "../../src/server.js";

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
    apiUrl: "https://firefly.example/api/v1", apiToken: "", readOnly: false, permissions: { fallback: "destructive", byEntity: new Map() }, directMode: false,
    enabledEntities: new Set(Object.values(EntityType)), disableSslVerify: false, logLevel: "INFO",
  };
  const registry = new Registry(config, client);
  for (const module of ENTITY_MODULES) registry.register(module);
  return { registry, calls };
}

describe("entity parity surface", () => {
  // 139 mirror a Firefly endpoint; the rest are computed here — one comparison
  // and four name resolvers.
  it("registers every operation the modules declare", () => {
    const { registry } = setup();
    expect(registry.listOperations()).toHaveLength(144);
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
