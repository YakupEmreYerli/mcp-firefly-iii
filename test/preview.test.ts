import { describe, expect, it } from "vitest";
import { Registry } from "../src/registry.js";
import { EntityType } from "../src/types.js";
import { transactionsModule } from "../src/entities/transactions.js";
import type { Config } from "../src/config.js";
import type { FireflyClient, Query } from "../src/firefly.js";

type Call = { method: string; path: string; body?: unknown; query?: Query };

/** `existing` is what /transactions returns for the queried day. */
function setup(existing: unknown[] = []): { registry: Registry; calls: Call[] } {
  const calls: Call[] = [];
  const client: FireflyClient = {
    get: async (path, query) => {
      calls.push({ method: "GET", path, query });
      if (path === "/transactions") {
        return { data: existing.map((attributes, index) => ({ id: String(index + 1), attributes })) };
      }
      return { data: { attributes: { transactions: [{ transaction_journal_id: "9" }] } } };
    },
    getText: async () => "",
    post: async (path, body, query) => { calls.push({ method: "POST", path, body, query }); return {}; },
    put: async (path, body) => { calls.push({ method: "PUT", path, body }); return {}; },
    del: async (path) => { calls.push({ method: "DELETE", path }); return null; },
    postBinary: async () => null,
  };
  const config: Config = {
    apiUrl: "https://firefly.example/api/v1", apiToken: "",     permissions: { fallback: "destructive", byEntity: new Map() },
    structuredOutput: false, resourceUrl: "", authorizationServers: [], disableSslVerify: false, logLevel: "INFO",
  };
  const registry = new Registry(config, client);
  registry.register(transactionsModule);
  return { registry, calls };
}

const SPLIT = {
  type: "deposit", date: "2026-08-26", amount: "200.00", description: "Harçlık",
  source_name: "Aile", destination_name: "Nakit", currency_code: "TRY",
};

function existing(overrides: Record<string, unknown> = {}) {
  return { transactions: [{ ...SPLIT, ...overrides }] };
}

type Preview = { dry_run: true; would_send: Call[]; warnings?: { kind: string; matches?: unknown[] }[] };

async function preview(registry: Registry, params: unknown, operation = "create"): Promise<Preview> {
  return (await registry.execute("transaction", operation, params, undefined, undefined, true)) as Preview;
}

describe("dry_run", () => {
  it("returns the request that would be sent instead of sending it", async () => {
    const { registry, calls } = setup();
    const result = await preview(registry, { transactions: [SPLIT] });

    expect(result.would_send).toEqual([
      { method: "POST", path: "/transactions", body: { transactions: [SPLIT] }, query: undefined },
    ]);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("says plainly that nothing happened, so the result is not read as a receipt", async () => {
    const { registry } = setup();
    const result = (await preview(registry, { transactions: [SPLIT] })) as unknown as { note: string };
    expect(result.note).toMatch(/Nothing was written/);
  });

  it("records a delete without issuing it", async () => {
    const { registry, calls } = setup();
    const result = await preview(registry, { id: "7" }, "delete");
    expect(result.would_send).toEqual([{ method: "DELETE", path: "/transactions/7", query: undefined }]);
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("still performs the reads a handler needs, so the plan is resolved and not an echo", async () => {
    // bulk_categorize fetches each group before it PUTs; without live reads the
    // preview could not show the journal ids Firefly requires.
    const { registry, calls } = setup();
    const result = await preview(registry, { transaction_ids: [4], category_name: "Market" }, "bulk_categorize");

    expect(calls.some((call) => call.method === "GET" && call.path === "/transactions/4")).toBe(true);
    expect(result.would_send[0]).toMatchObject({ method: "PUT", path: "/transactions/4" });
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("leaves a read alone, because there is nothing to preview", async () => {
    const { registry, calls } = setup();
    const result = await registry.execute("transaction", "list", {}, undefined, undefined, true);
    expect(result).not.toHaveProperty("dry_run");
    expect(calls.some((call) => call.method === "GET" && call.path === "/transactions")).toBe(true);
  });
});

describe("the duplicate guard", () => {
  it("warns when the same amount already moved between the same accounts that day", async () => {
    const { registry } = setup([existing()]);
    const result = await preview(registry, { transactions: [SPLIT] });
    expect(result.warnings?.[0]?.kind).toBe("possible_duplicate");
    expect(result.warnings?.[0]?.matches).toHaveLength(1);
  });

  it("queries exactly the one day, which /transactions accepts as start === end", async () => {
    const { registry, calls } = setup([existing()]);
    await preview(registry, { transactions: [SPLIT] });
    const lookup = calls.find((call) => call.path === "/transactions" && call.method === "GET");
    // start === end is the assertion; the paging parameters ride along.
    expect(lookup?.query).toMatchObject({ start: "2026-08-26", end: "2026-08-26" });
    expect(lookup?.query?.start).toBe(lookup?.query?.end);
  });

  it("stays quiet when the amount differs", async () => {
    const { registry } = setup([existing({ amount: "250.00" })]);
    const result = await preview(registry, { transactions: [SPLIT] });
    expect(result.warnings).toBeUndefined();
  });

  it("stays quiet when the accounts differ, so two coffees on one day are not conflated", async () => {
    const { registry } = setup([existing({ destination_name: "Kredi kartı" })]);
    const result = await preview(registry, { transactions: [SPLIT] });
    expect(result.warnings).toBeUndefined();
  });

  it("matches on the amount rather than its sign, since Firefly stores expenses negative", async () => {
    const { registry } = setup([existing({ amount: "-200.000000000000" })]);
    const result = await preview(registry, { transactions: [SPLIT] });
    expect(result.warnings?.[0]?.matches).toHaveLength(1);
  });

  it("says nothing rather than guessing when an account name is absent", async () => {
    const { registry } = setup([existing()]);
    const { source_name, ...withoutSource } = SPLIT;
    void source_name;
    const result = await preview(registry, { transactions: [{ ...withoutSource, source_id: "3" }] });
    expect(result.warnings).toBeUndefined();
  });

  it("does not look for duplicates of a delete", async () => {
    const { registry, calls } = setup([existing()]);
    await preview(registry, { id: "7" }, "delete");
    expect(calls.filter((call) => call.path === "/transactions" && call.method === "GET")).toHaveLength(0);
  });
});

describe("the duplicate scan reads the whole day", () => {
  /** Serves one day of transactions across pages, the way Firefly does. */
  function pagedSetup(rows: unknown[], perPage: number): { registry: Registry; gets: Query[] } {
    const gets: Query[] = [];
    const groups = rows.map((attributes, index) => ({ id: String(index + 1), attributes }));
    const client: FireflyClient = {
      get: async (path, query) => {
        if (path !== "/transactions") {
          return { data: { attributes: { transactions: [{ transaction_journal_id: "9" }] } } };
        }
        gets.push(query ?? {});
        const page = Number(query?.page ?? 1);
        return {
          data: groups.slice((page - 1) * perPage, page * perPage),
          meta: { pagination: { total_pages: Math.max(1, Math.ceil(groups.length / perPage)) } },
        };
      },
      getText: async () => "", post: async () => ({}), put: async () => ({}),
      del: async () => null, postBinary: async () => null,
    };
    const config: Config = {
      apiUrl: "https://firefly.example/api/v1", apiToken: "",       permissions: { fallback: "destructive", byEntity: new Map() },
      structuredOutput: false, resourceUrl: "", authorizationServers: [], disableSslVerify: false, logLevel: "INFO",
    };
    const registry = new Registry(config, client);
    registry.register(transactionsModule);
    return { registry, gets };
  }

  it("finds a duplicate sitting past the first page", async () => {
    // The point of the warning is to catch a repeat before it is written. A
    // scan that stops at page one misses it silently on any busy day, which is
    // worse than missing it on a read: the write goes ahead unwarned.
    const filler = Array.from({ length: 3 }, () => existing({ amount: "1.00", description: "other" }));
    const { registry } = pagedSetup([...filler, existing()], 2);
    const result = (await registry.execute(
      "transaction", "create", { transactions: [SPLIT] }, undefined, undefined, true,
    )) as { warnings?: { kind: string }[] };
    expect(result.warnings?.map((w) => w.kind)).toContain("possible_duplicate");
  });

  it("reads a day once however many splits are being created on it", async () => {
    const { registry, gets } = pagedSetup([existing()], 100);
    await registry.execute(
      "transaction", "create",
      { transactions: [SPLIT, { ...SPLIT, amount: "300.00" }, { ...SPLIT, amount: "400.00" }] },
      undefined, undefined, true,
    );
    expect(gets).toHaveLength(1);
  });
});
