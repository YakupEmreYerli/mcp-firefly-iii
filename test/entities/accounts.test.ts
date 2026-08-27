import { describe, expect, it } from "vitest";
import { accountsModule } from "../../src/entities/accounts.js";
import { EntityType } from "../../src/types.js";
import type { FireflyClient, Query } from "../../src/firefly.js";
import { Registry } from "../../src/registry.js";
import type { Config } from "../../src/config.js";

function clientWithCalls(): { client: FireflyClient; calls: Query[] } {
  const calls: Query[] = [];
  return {
    calls,
    client: {
      get: async (_path, query) => { calls.push(query ?? {}); return { data: [] }; },
      getText: async () => "",
      post: async () => ({}),
      put: async () => ({}),
      del: async () => null,
      postBinary: async () => null,
    },
  };
}

function registry(client: FireflyClient): Registry {
  const config: Config = {
    apiUrl: "https://firefly.example/api/v1", apiToken: "", readOnly: false, permissions: { fallback: "destructive", byEntity: new Map() },
    directMode: false, enabledEntities: new Set(Object.values(EntityType)),
    disableSslVerify: false, logLevel: "INFO",
  };
  const result = new Registry(config, client);
  result.register(accountsModule);
  return result;
}

describe("accounts", () => {
  it("lists accounts with filters", async () => {
    const { client, calls } = clientWithCalls();
    await registry(client).execute("account", "list", { type: "asset", page: 2 });
    expect(calls[0]).toEqual({ type: "asset", page: 2 });
  });

  it("corrects the pagination counts it widened the range to obtain", async () => {
    // The widened query answers for two days, so Firefly's own counts describe
    // two days. Returning them unchanged next to one day of records invites a
    // wrong total — the exact failure mode this project treats as worse than
    // a crash.
    const onDay = {
      id: "1", type: "transactions",
      attributes: { transactions: [{ date: "2026-08-26T10:00:00+03:00", amount: "10" }] },
    };
    const nextDay = {
      id: "2", type: "transactions",
      attributes: { transactions: [{ date: "2026-08-27T10:00:00+03:00", amount: "20" }] },
    };
    const client: FireflyClient = {
      get: async () => ({
        data: [onDay, nextDay],
        meta: { pagination: { total: 2, count: 2, per_page: 50, current_page: 1, total_pages: 1 } },
      }),
      getText: async () => "",
      post: async () => ({}),
      put: async () => ({}),
      del: async () => null,
      postBinary: async () => null,
    };

    const result = (await registry(client).execute("account", "list_transactions", {
      id: "4", start: "2026-08-26", end: "2026-08-26",
    })) as { data: unknown[]; meta: { pagination: Record<string, unknown> } };

    expect(result.data).toHaveLength(1);
    expect(result.meta.pagination.count).toBe(1);
    // `total` and `total_pages` describe the widened range and cannot be
    // restated truthfully for the narrowed day, so they are dropped rather
    // than reported wrong.
    expect(result.meta.pagination).not.toHaveProperty("total");
    expect(result.meta.pagination).not.toHaveProperty("total_pages");
  });

  it("widens and restores a single-day account transaction query", async () => {
    const { client, calls } = clientWithCalls();
    await registry(client).execute("account", "list_transactions", {
      id: "4", start: "2026-08-26", end: "2026-08-26",
    });
    expect(calls[0]).toEqual({ start: "2026-08-26", end: "2026-08-27" });
  });

  it("updates using the account_update body expected by Firefly", async () => {
    let body: unknown;
    const client: FireflyClient = {
      get: async () => ({}), getText: async () => "", post: async () => ({}), del: async () => null, postBinary: async () => null,
      put: async (_path, value) => { body = value; return {}; },
    };
    await registry(client).execute("account", "update", {
      id: "4", account_update: { name: "Cash" },
    });
    expect(body).toEqual({ name: "Cash" });
  });

  it("accepts Firefly's required asset account role", async () => {
    let body: unknown;
    const client: FireflyClient = {
      get: async () => ({}), getText: async () => "", put: async () => ({}), del: async () => null, postBinary: async () => null,
      post: async (_path, value) => { body = value; return {}; },
    };
    await registry(client).execute("account", "create", {
      name: "Cash", type: "asset", account_role: "cashWalletAsset",
    });
    expect(body).toEqual({ name: "Cash", type: "asset", account_role: "cashWalletAsset" });
  });
});
