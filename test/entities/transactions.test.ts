import { describe, expect, it, vi } from "vitest";
import { Registry } from "../../src/registry.js";
import { transactionOperations, transactionsModule } from "../../src/entities/transactions.js";
import { EntityType, type Access } from "../../src/types.js";
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

function makeRegistry(client: FireflyClient, granted?: ReadonlySet<Access>): Registry {
  const config: Config = {
    apiUrl: "https://firefly.example/api/v1",
    apiToken: "token",
        structuredOutput: false, resourceUrl: "", authorizationServers: [], disableSslVerify: false,
  };
  const registry = new Registry(config, client, granted);
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

    expect(destructive).toEqual([
      "bulk_categorize",
      "bulk_delete",
      "bulk_rewrite",
      "bulk_tag",
      "bulk_update",
      "bulk_update_where",
      "delete",
    ]);
  });

  it("hides all of them from a connection granted only firefly:read", () => {
    const { client } = spyClient();
    const names = makeRegistry(client, new Set<Access>(["read"]))
      .listOperations()
      .map((op) => op.operation)
      .sort();

    expect(names).toEqual([
      "get",
      "group_patterns",
      "list",
      "list_attachments",
      "list_piggy_bank_events",
      "reconcile",
    ]);
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
    bulk_update: { updates: [{ transaction_id: "7", fields: { description: "x" } }] },
    bulk_delete: { transaction_ids: ["7"] },
    group_patterns: { where: { start: "2026-08-01" } },
    bulk_update_where: {
      where: { source_name: "Annem" },
      set: { category_name: "Harçlık" },
      max_matches: 5,
    },
    bulk_rewrite: {
      where: { description_contains: "TRENDYOL" },
      match: "^\\d+-",
      replace: "",
      max_matches: 5,
    },
    reconcile: {
      account_id: "1",
      rows: [{ date: "2026-08-18", amount: "-75.00" }],
      start: "2026-08-01",
      end: "2026-08-31",
    },
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

describe("bulk_update", () => {
  // A client whose groups carry the journal ids Firefly would return, so the
  // test can tell a filled-in journal id from a fabricated one.
  function groupClient(splitsPerGroup = 1): { client: FireflyClient; calls: Record<string, Call[]> } {
    const calls: Record<string, Call[]> = { get: [], post: [], put: [], del: [] };
    const client: FireflyClient = {
      postBinary: async () => null,
      getText: async () => "",
      get: async (path, query) => {
        calls.get!.push({ path, query });
        const id = path.split("/").pop()!;
        return {
          data: {
            attributes: {
              transactions: Array.from({ length: splitsPerGroup }, (_, index) => ({
                transaction_journal_id: `${id}0${index}`,
                tags: ["kept"],
              })),
            },
          },
        };
      },
      post: async () => ({}),
      put: async (path, body) => {
        calls.put!.push({ path, body });
        return {};
      },
      del: async (path, query) => {
        calls.del!.push({ path, query });
        return null;
      },
    };
    return { client, calls };
  }

  it("sends each id its own fields, not the first row's", async () => {
    // The failure this guards against is silent: one shared payload, or a map
    // keyed by array index, rewrites every transaction with row one's text and
    // Firefly answers 200 for all of them.
    const { client, calls } = groupClient();
    const result = await makeRegistry(client).execute("transaction", "bulk_update", {
      updates: [
        { transaction_id: "7", fields: { description: "Clash of Clans" } },
        { transaction_id: "9", fields: { description: "Nitro aylık abonelik", category_name: "Dijital abonelikler" } },
      ],
    });

    expect(calls.put).toEqual([
      {
        path: "/transactions/7",
        body: { transactions: [{ transaction_journal_id: "700", description: "Clash of Clans" }] },
      },
      {
        path: "/transactions/9",
        body: {
          transactions: [
            {
              transaction_journal_id: "900",
              description: "Nitro aylık abonelik",
              category_name: "Dijital abonelikler",
            },
          ],
        },
      },
    ]);
    expect(result).toMatchObject({ updated: 2, failed: 0, skipped: 0 });
  });

  it("fills in the journal id Firefly returned, per split", async () => {
    // Without transaction_journal_id the PUT returns 200 and changes nothing,
    // so an operation that omitted it would look like it worked. A single-split
    // group exercises the fill: multi-split groups are refused altogether (see
    // the refusal tests below), so the per-split path only runs on one split.
    const { client, calls } = groupClient(1);
    await makeRegistry(client).execute("transaction", "bulk_update", {
      updates: [{ transaction_id: "4", fields: { category_name: "Market" } }],
    });

    expect(calls.put![0]!.body).toEqual({
      transactions: [
        { transaction_journal_id: "400", category_name: "Market" },
      ],
    });
  });

  it("refuses to write an amount across a multi-split group", async () => {
    // Fanning one amount out to every split triples a three-way split's total
    // and Firefly reports success. Skipping is the only safe answer.
    const { client, calls } = groupClient(3);
    const result = (await makeRegistry(client).execute("transaction", "bulk_update", {
      updates: [{ transaction_id: "5", fields: { amount: "73.00" } }],
    })) as { skipped: number; updated: number; results: { id: string; reason?: string }[] };

    expect(calls.put).toEqual([]);
    expect(result).toMatchObject({ updated: 0, skipped: 1 });
    expect(result.results[0]!.reason).toContain("3 splits");
  });

  it("refuses to rewrite one id twice instead of silently dropping a row", async () => {
    // Two rows naming the same transaction used to keep only the last row's
    // fields while reporting both as updated — an edit vanished and the caller
    // was told it landed. The schema refuses the second naming instead, so the
    // caller has to merge the fields it meant to set.
    const { client, calls } = groupClient();
    await expect(
      makeRegistry(client).execute("transaction", "bulk_update", {
        updates: [
          { transaction_id: "7", fields: { description: "a" } },
          { transaction_id: "7", fields: { category_name: "Market" } },
        ],
      }),
    ).rejects.toThrow(/may appear once/);
    expect(calls.put).toEqual([]);
  });

  it("refuses even a group-wide field on a multi-split group", async () => {
    // An earlier build allowed notes/description/category on a group with
    // several splits while refusing amount/type/source. That list was not
    // completable (source_id and destination_id are also per-split), so the
    // rule became a flat refusal: it is not worth keeping a list of the fields
    // whose repeats a split group happens to tolerate.
    const { client, calls } = groupClient(2);
    const result = (await makeRegistry(client).execute("transaction", "bulk_update", {
      updates: [{ transaction_id: "6", fields: { notes: "ham metin" } }],
    })) as { updated: number; skipped: number; results: { reason?: string }[] };
    expect(calls.put).toEqual([]);
    expect(result).toMatchObject({ updated: 0, skipped: 1 });
    expect(result.results[0]!.reason).toContain("2 splits");
  });

  it("rejects an empty field set instead of spending two requests on nothing", async () => {
    const { client, calls } = groupClient();
    await expect(
      makeRegistry(client).execute("transaction", "bulk_update", {
        updates: [{ transaction_id: "7", fields: {} }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(calls.get).toEqual([]);
  });

  it("carries a failure without abandoning the ids after it", async () => {
    const { client } = groupClient();
    const failing: FireflyClient = {
      ...client,
      put: async (path, body) => {
        if (path === "/transactions/2") throw new FireflyApiError(404, "not found", { path });
        return client.put(path, body);
      },
    };
    const result = (await makeRegistry(failing).execute("transaction", "bulk_update", {
      updates: [
        { transaction_id: "1", fields: { notes: "a" } },
        { transaction_id: "2", fields: { notes: "b" } },
        { transaction_id: "3", fields: { notes: "c" } },
      ],
    })) as { updated: number; failed: number; results: { id: string; status: string }[] };

    expect(result).toMatchObject({ updated: 2, failed: 1 });
    expect(result.results.map((entry) => [entry.id, entry.status])).toEqual([
      ["1", "updated"],
      ["2", "failed"],
      ["3", "updated"],
    ]);
  });

  it("is reachable only from the destructive surface", async () => {
    const { client } = groupClient();
    await expect(
      makeRegistry(client).execute(
        "transaction",
        "bulk_update",
        { updates: [{ transaction_id: "1", fields: { notes: "a" } }] },
        undefined,
        ["write"],
      ),
    ).rejects.toThrow();
  });
});

describe("bulk_delete", () => {
  it("deletes every id and reports each one", async () => {
    const { client, calls } = spyClient();
    const result = await makeRegistry(client).execute("transaction", "bulk_delete", {
      transaction_ids: ["29", "55"],
    });

    expect(calls.del!.map((call) => call.path)).toEqual(["/transactions/29", "/transactions/55"]);
    expect(result).toMatchObject({
      deleted: 2,
      failed: 0,
      results: [
        { id: "29", status: "deleted" },
        { id: "55", status: "deleted" },
      ],
    });
  });

  it("keeps deleting after one id fails, and names it", async () => {
    const calls: string[] = [];
    const { client } = spyClient();
    const failing: FireflyClient = {
      ...client,
      del: async (path) => {
        calls.push(path);
        if (path === "/transactions/2") throw new FireflyApiError(404, "not found", { path });
        return null;
      },
    };
    const result = (await makeRegistry(failing).execute("transaction", "bulk_delete", {
      transaction_ids: ["1", "2", "3"],
    })) as { deleted: number; failed: number; results: { id: string; reason?: string }[] };

    expect(calls).toEqual(["/transactions/1", "/transactions/2", "/transactions/3"]);
    expect(result).toMatchObject({ deleted: 2, failed: 1 });
    expect(result.results[1]!.reason).toContain("404");
  });
});
