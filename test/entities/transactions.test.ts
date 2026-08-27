import { describe, expect, it, vi } from "vitest";
import { Registry } from "../../src/registry.js";
import { transactionOperations, transactionsModule } from "../../src/entities/transactions.js";
import { EntityType } from "../../src/types.js";
import { FireflyApiError, ValidationError } from "../../src/errors.js";
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
      // A single-split transaction group — the shape bulk operations fetch
      // before rewriting it.
      return {
        data: {
          type: "transactions",
          id: "7",
          attributes: { transactions: [{ transaction_journal_id: "9" }] },
        },
      };
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
    permissions: { fallback: "destructive", byEntity: new Map() },
    directMode: false,
    enabledEntities: new Set(Object.values(EntityType)),
    structuredOutput: false, resourceUrl: "", authorizationServers: [], disableSslVerify: false,
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
  // Firefly III's `/data/bulk/transactions` only moves transactions between
  // accounts; it cannot set a category or tags. The earlier implementation
  // sent `category_name=<name>` as the `query` string, which the endpoint
  // rejected with 500 "Syntax error" — so it never worked on a live instance.
  // The current implementation fans out into a GET + PUT per id, applying the
  // field to every split.

  it("fetches each group and rewrites every split with the category", async () => {
    const { client, calls } = spyClient();
    const result = await makeRegistry(client).execute("transaction", "bulk_categorize", {
      transaction_ids: [1, 2],
      category_name: "Market",
    });

    expect(calls.get!.map((c) => c.path)).toEqual(["/transactions/1", "/transactions/2"]);
    expect(calls.put).toEqual([
      {
        path: "/transactions/1",
        body: { transactions: [{ transaction_journal_id: "9", category_name: "Market" }] },
      },
      {
        path: "/transactions/2",
        body: { transactions: [{ transaction_journal_id: "9", category_name: "Market" }] },
      },
    ]);
    expect(result).toMatchObject({
      updated: 2, failed: 0, skipped: 0, category_name: "Market",
      results: [{ id: 1, status: "updated" }, { id: 2, status: "updated" }],
    });
  });

  it("accepts a category name with spaces and Turkish characters", async () => {
    const { client, calls } = spyClient();
    await makeRegistry(client).execute("transaction", "bulk_categorize", {
      transaction_ids: [1],
      category_name: "Ulaşım gideri",
    });

    expect(calls.put![0]!.body).toEqual({
      transactions: [{ transaction_journal_id: "9", category_name: "Ulaşım gideri" }],
    });
  });

  it("accepts '=' and '&' in a category name — they are JSON now, not a query expression", async () => {
    // The old implementation embedded the name into `category_name=<name>` and
    // refused '='/'&' because they would re-shape the expression. With the
    // field travelling as JSON, those characters are ordinary values.
    const { client, calls } = spyClient();
    for (const category_name of ["A=B", "A&B"]) {
      await makeRegistry(client).execute("transaction", "bulk_categorize", {
        transaction_ids: [1],
        category_name,
      });
    }
    expect(
      calls.put!.map((c) => (c.body as { transactions: { category_name: string }[] }).transactions[0]!.category_name),
    ).toEqual(["A=B", "A&B"]);
  });

  it("fetches each group and rewrites every split with the tags", async () => {
    const { client, calls } = spyClient();
    const result = await makeRegistry(client).execute("transaction", "bulk_tag", {
      transaction_ids: [1],
      tag_names: ["market", "nakit"],
    });

    expect(calls.put![0]).toEqual({
      path: "/transactions/1",
      body: { transactions: [{ transaction_journal_id: "9", tags: ["market", "nakit"] }] },
    });
    expect(result).toMatchObject({
      updated: 1, failed: 0, skipped: 0, tag_names: ["market", "nakit"],
      results: [{ id: 1, status: "updated" }],
    });
  });

  it("accepts a tag containing a comma — tags are an array now, not a joined string", async () => {
    // The old implementation joined tags with commas and refused a comma in a
    // tag because it would split into two. With tags travelling as a JSON
    // array, a comma is an ordinary character.
    const { client, calls } = spyClient();
    await makeRegistry(client).execute("transaction", "bulk_tag", {
      transaction_ids: [1],
      tag_names: ["market", "a,b"],
    });

    expect((calls.put![0]!.body as { transactions: { tags: string[] }[] }).transactions[0]!.tags).toEqual([
      "market",
      "a,b",
    ]);
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

    expect(writes).toEqual(["create", "update"]);
  });

  it("separates what cannot be undone from an ordinary write", () => {
    // A delete removes the record; a bulk call rewrites one field across many
    // records at once. Neither is recoverable through this server, so a host
    // can raise confirmation on exactly these without gating every write.
    const destructive = Object.entries(transactionOperations)
      .filter(([, op]) => op.access === "destructive")
      .map(([name]) => name)
      .sort();

    expect(destructive).toEqual(["bulk_categorize", "bulk_tag", "delete"]);
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

describe("bulk_tag preserves what is already there", () => {
  /** A group whose split already carries tags, which is the ordinary case on a
   * ledger anyone has been using. */
  function taggedClient(existing: string[]) {
    const puts: { path: string; body: unknown }[] = [];
    const client: FireflyClient = {
      get: async () => ({
        data: { attributes: { transactions: [{ transaction_journal_id: "9", tags: existing }] } },
      }),
      getText: async () => "",
      post: async () => ({ data: {} }),
      put: async (path, body) => { puts.push({ path, body }); return { data: {} }; },
      del: async () => null,
      postBinary: async () => null,
    };
    return { client, puts };
  }

  it("adds to the existing tags instead of replacing them", async () => {
    // Firefly replaces the whole tag set on a journal update; it does not
    // merge. Sending only the new tag wiped every tag already on the
    // transaction, reported it as {updated: n}, and left nothing to recover
    // from — on real financial data.
    const { client, puts } = taggedClient(["vacation", "reimbursable"]);
    await makeRegistry(client).execute("transaction", "bulk_tag", {
      transaction_ids: [1],
      tag_names: ["2026"],
    });
    const body = puts[0]!.body as { transactions: { tags: string[] }[] };
    expect(body.transactions[0]!.tags.sort()).toEqual(["2026", "reimbursable", "vacation"]);
  });

  it("does not duplicate a tag the transaction already carries", async () => {
    const { client, puts } = taggedClient(["2026"]);
    await makeRegistry(client).execute("transaction", "bulk_tag", {
      transaction_ids: [1],
      tag_names: ["2026", "food"],
    });
    const body = puts[0]!.body as { transactions: { tags: string[] }[] };
    expect(body.transactions[0]!.tags.sort()).toEqual(["2026", "food"]);
  });
});

describe("bulk operations report what they actually did", () => {
  /** Fails on one id in the middle, succeeds on the rest. */
  function flakyClient(failingId: string) {
    const puts: string[] = [];
    const client: FireflyClient = {
      get: async (path) => {
        if (path === `/transactions/${failingId}`) throw new FireflyApiError(404, "Not found");
        return { data: { attributes: { transactions: [{ transaction_journal_id: "9", tags: [] }] } } };
      },
      getText: async () => "",
      post: async () => ({ data: {} }),
      put: async (path) => { puts.push(path); return { data: {} }; },
      del: async () => null,
      postBinary: async () => null,
    };
    return { client, puts };
  }

  it("keeps the record of the ids it already rewrote when one fails", async () => {
    // Throwing out of the handler returned {error: …} and lost the list, so a
    // caller of a destructive operation could not tell whether 0 or 9 of 10
    // transactions had been changed.
    const { client } = flakyClient("2");
    const result = (await makeRegistry(client).execute("transaction", "bulk_categorize", {
      transaction_ids: [1, 2, 3],
      category_name: "Market",
    })) as { updated: number; failed: number; results: { id: number; status: string }[] };

    expect(result.updated).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.results.map((r) => [r.id, r.status])).toEqual([
      [1, "updated"],
      [2, "failed"],
      [3, "updated"],
    ]);
  });

  it("names why an id failed", async () => {
    const { client } = flakyClient("1");
    const result = (await makeRegistry(client).execute("transaction", "bulk_tag", {
      transaction_ids: [1],
      tag_names: ["x"],
    })) as { results: { reason?: string }[] };
    expect(result.results[0]!.reason).toContain("404");
  });
});
