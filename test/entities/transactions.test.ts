import { describe, expect, it, vi } from "vitest";
import { Registry } from "../../src/registry.js";
import { transactionOperations, transactionsModule } from "../../src/entities/transactions.js";
import { EntityType } from "../../src/types.js";
import { ValidationError } from "../../src/errors.js";
import type { Config } from "../../src/config.js";
import type { FireflyClient, Query } from "../../src/firefly.js";

type Call = { path: string; body?: unknown; query?: Query };

function spyClient(): { client: FireflyClient; calls: Record<string, Call[]> } {
  const calls: Record<string, Call[]> = { get: [], post: [], put: [], del: [] };
  const client: FireflyClient = {
    postBinary: async () => null,
    getText: async () => "",
    get: async (path, query) => {
      calls.get!.push({ path, query });
      return { data: [] };
    },
    post: async (path, body, query) => {
      calls.post!.push({ path, body, query });
      return { data: {} };
    },
    put: async (path, body) => {
      calls.put!.push({ path, body });
      return { data: {} };
    },
    del: async (path, query) => {
      calls.del!.push({ path, query });
      return null;
    },
  };
  return { client, calls };
}

function makeRegistry(client: FireflyClient, readOnly = false): Registry {
  const config: Config = {
    apiUrl: "https://firefly.example/api/v1",
    apiToken: "token",
    readOnly,
    directMode: false,
    enabledEntities: new Set(Object.values(EntityType)),
    disableSslVerify: false,
    logLevel: "INFO",
  };
  const registry = new Registry(config, client);
  registry.register(transactionsModule);
  return registry;
}

describe("read operations", () => {
  it("passes the date range and type filter straight through", async () => {
    const { client, calls } = spyClient();
    await makeRegistry(client).execute("transaction", "list", {
      start: "2026-08-01",
      end: "2026-08-31",
      type: "withdrawal",
      limit: 50,
    });

    expect(calls.get![0]).toEqual({
      path: "/transactions",
      query: { start: "2026-08-01", end: "2026-08-31", type: "withdrawal", limit: 50 },
    });
  });

  it("rejects a date that is not YYYY-MM-DD", async () => {
    const { client } = spyClient();
    await expect(
      makeRegistry(client).execute("transaction", "list", { start: "01.08.2026" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("puts the id in the path, not the query", async () => {
    const { client, calls } = spyClient();
    await makeRegistry(client).execute("transaction", "get", { id: "7" });

    expect(calls.get![0]!.path).toBe("/transactions/7");
    expect(calls.get![0]!.query).toBeUndefined();
  });

  it("keeps pagination in the query for sub-resources", async () => {
    const { client, calls } = spyClient();
    await makeRegistry(client).execute("transaction", "list_attachments", { id: "7", page: 2 });

    expect(calls.get![0]).toEqual({ path: "/transactions/7/attachments", query: { page: 2 } });
  });

  it("reaches the piggy bank events endpoint", async () => {
    const { client, calls } = spyClient();
    await makeRegistry(client).execute("transaction", "list_piggy_bank_events", { id: "7" });

    expect(calls.get![0]!.path).toBe("/transactions/7/piggy-bank-events");
  });
});

describe("update", () => {
  const split = {
    transaction_journal_id: "9",
    amount: "25.50",
    description: "market",
  };

  it("sends the payload unwrapped", async () => {
    const { client, calls } = spyClient();
    await makeRegistry(client).execute("transaction", "update", {
      id: "7",
      transactions: [split],
    });

    expect(calls.put![0]).toEqual({
      path: "/transactions/7",
      body: { transactions: [split] },
    });
  });

  it("does not leak the id into the body", async () => {
    const { client, calls } = spyClient();
    await makeRegistry(client).execute("transaction", "update", {
      id: "7",
      transactions: [split],
    });

    expect(calls.put![0]!.body).not.toHaveProperty("id");
  });

  it("refuses a wrapper key instead of sending a PUT that changes nothing", async () => {
    const { client } = spyClient();
    await expect(
      makeRegistry(client).execute("transaction", "update", {
        id: "7",
        transaction_update: { transactions: [split] },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses a split without transaction_journal_id", async () => {
    const { client } = spyClient();
    await expect(
      makeRegistry(client).execute("transaction", "update", {
        id: "7",
        transactions: [{ amount: "25.50" }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("omits fields the caller left unset", async () => {
    const { client, calls } = spyClient();
    await makeRegistry(client).execute("transaction", "update", {
      id: "7",
      transactions: [split],
    });

    expect(Object.keys(calls.put![0]!.body as object)).toEqual(["transactions"]);
  });
});

describe("create", () => {
  it("posts the whole group as the body", async () => {
    const { client, calls } = spyClient();
    const body = {
      transactions: [
        { type: "withdrawal", date: "2026-08-01", amount: "25.50", description: "market" },
      ],
    };
    await makeRegistry(client).execute("transaction", "create", body);

    expect(calls.post![0]).toEqual({ path: "/transactions", body, query: undefined });
  });

  it("requires the fields Firefly cannot default", async () => {
    const { client } = spyClient();
    await expect(
      makeRegistry(client).execute("transaction", "create", {
        transactions: [{ type: "withdrawal", amount: "25.50" }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("bulk operations", () => {
  it("sends the category through the query channel and the ids through the body", async () => {
    const { client, calls } = spyClient();
    await makeRegistry(client).execute("transaction", "bulk_categorize", {
      transaction_ids: [1, 2],
      category_name: "Market",
    });

    expect(calls.post![0]).toEqual({
      path: "/data/bulk/transactions",
      body: { transaction_ids: [1, 2] },
      query: { query: "category_name=Market" },
    });
  });

  it("refuses a category name that would break the query expression", async () => {
    // The name is embedded into `category_name=<name>`, which Firefly parses as
    // an expression. A name carrying `=` or `&` changes what that expression
    // means, so the write would land on the wrong category rather than fail.
    const { client } = spyClient();
    for (const category_name of ["A=B", "A&B"]) {
      await expect(
        makeRegistry(client).execute("transaction", "bulk_categorize", {
          transaction_ids: [1],
          category_name,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it("accepts a category name with spaces and Turkish characters", async () => {
    const { client, calls } = spyClient();
    await makeRegistry(client).execute("transaction", "bulk_categorize", {
      transaction_ids: [1],
      category_name: "Ulaşım gideri",
    });

    expect(calls.post![0]!.query).toEqual({ query: "category_name=Ulaşım gideri" });
  });

  it("refuses a tag containing the separator it would be joined with", async () => {
    // Tags travel as one comma-separated list. A tag with a comma in it would
    // arrive as two different tags.
    const { client } = spyClient();
    await expect(
      makeRegistry(client).execute("transaction", "bulk_tag", {
        transaction_ids: [1],
        tag_names: ["market", "a,b"],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("joins tag names with commas", async () => {
    const { client, calls } = spyClient();
    await makeRegistry(client).execute("transaction", "bulk_tag", {
      transaction_ids: [1],
      tag_names: ["market", "nakit"],
    });

    expect(calls.post![0]!.query).toEqual({ query: "tags=market,nakit" });
  });
});

describe("delete", () => {
  it("reports the id it deleted rather than inventing a success message", async () => {
    const { client, calls } = spyClient();
    const result = await makeRegistry(client).execute("transaction", "delete", { id: "7" });

    expect(calls.del![0]!.path).toBe("/transactions/7");
    expect(result).toEqual({ deleted: true, id: "7" });
  });
});

describe("access tagging", () => {
  it("marks every mutating operation as a write", () => {
    const writes = Object.entries(transactionOperations)
      .filter(([, op]) => op.access === "write")
      .map(([name]) => name)
      .sort();

    expect(writes).toEqual(["bulk_categorize", "bulk_tag", "create", "delete", "update"]);
  });

  it("hides all of them in read-only mode", () => {
    const { client } = spyClient();
    const names = makeRegistry(client, true)
      .listOperations()
      .map((op) => op.operation)
      .sort();

    expect(names).toEqual(["get", "list", "list_attachments", "list_piggy_bank_events"]);
  });
});

describe("input schemas are idempotent", () => {
  // `defineOperation` parses a second time inside the handler, so a
  // field-level `.transform()` would see its own output and throw. Two parses
  // of the same payload must agree.
  const samples: Record<string, unknown> = {
    list: { start: "2026-08-01", limit: 10 },
    get: { id: "7" },
    list_attachments: { id: "7", page: 1 },
    list_piggy_bank_events: { id: "7" },
    create: {
      transactions: [
        { type: "withdrawal", date: "2026-08-01", amount: "1.00", description: "x" },
      ],
    },
    update: { id: "7", transactions: [{ transaction_journal_id: "9", amount: "1.00" }] },
    delete: { id: "7" },
    bulk_categorize: { transaction_ids: [1], category_name: "Market" },
    bulk_tag: { transaction_ids: [1], tag_names: ["x"] },
  };

  it.each(Object.keys(transactionOperations))("%s parses to the same value twice", (name) => {
    const operation = transactionOperations[name]!;
    const sample = samples[name];
    const once = operation.input.parse(sample);
    expect(operation.input.parse(once)).toEqual(once);
  });
});
