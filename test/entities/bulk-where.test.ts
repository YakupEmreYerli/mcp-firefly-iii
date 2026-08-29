import { describe, expect, it } from "vitest";
import { Registry } from "../../src/registry.js";
import { transactionsModule } from "../../src/entities/transactions.js";
import { ValidationError } from "../../src/errors.js";
import type { Config } from "../../src/config.js";
import type { FireflyClient, Query } from "../../src/firefly.js";

type Split = Record<string, unknown>;

/** A ledger the scan pages through, one group per split unless `splits` says
 * otherwise. Paged for real, because the page loop is where a filter silently
 * stops seeing the rest of the data. */
function ledgerClient(
  groups: { id: string; splits: Split[] }[],
  pageSize = 100,
  withMeta = true,
) {
  const puts: { path: string; body: unknown }[] = [];
  const gets: { path: string; query?: Query }[] = [];
  const pages = Math.max(1, Math.ceil(groups.length / pageSize));
  const client: FireflyClient = {
    getText: async () => "",
    postBinary: async () => null,
    post: async () => ({}),
    del: async () => null,
    put: async (path, body) => {
      puts.push({ path, body });
      return {};
    },
    get: async (path, query) => {
      gets.push({ path, query });
      const page = Number((query as Record<string, unknown> | undefined)?.page ?? 1);
      const slice = groups.slice((page - 1) * pageSize, page * pageSize);
      const data = slice.map((group) => ({
        id: group.id,
        attributes: { transactions: group.splits },
      }));
      return withMeta ? { data, meta: { pagination: { total_pages: pages, current_page: page } } } : { data };
    },
  };
  return { client, puts, gets };
}

function split(over: Split = {}): Split {
  return {
    transaction_journal_id: "9",
    type: "withdrawal",
    date: "2026-08-18T00:00:00+00:00",
    amount: "75.000000000000",
    description: "086200000023377-TRENDYOL.COM ISTANBUL TR Pos satış",
    source_id: "1",
    source_name: "Enpara (Vadesiz TL)",
    destination_id: "26",
    destination_name: "Trendyol",
    category_name: "",
    notes: "",
    tags: [],
    ...over,
  };
}

function registry(client: FireflyClient): Registry {
  const config: Config = {
    apiUrl: "https://firefly.example/api/v1",
    apiToken: "token",
    structuredOutput: false,
    resourceUrl: "",
    authorizationServers: [],
    disableSslVerify: false,
  };
  const created = new Registry(config, client);
  created.register(transactionsModule);
  return created;
}

describe("group_patterns", () => {
  it("collapses card lines that differ only in their terminal number", async () => {
    // The whole point: 3 raw rows come back as 1 shape, so a caller can decide
    // what to do without reading 3 rows — or 300.
    const { client } = ledgerClient([
      { id: "1", splits: [split({ description: "086200000023377-TRENDYOL.COM ISTANBUL TR Pos satış" })] },
      { id: "2", splits: [split({ description: "105100000049403-TRENDYOL.COM ISTANBUL TR Pos satış" })] },
      { id: "3", splits: [split({ description: "086200000023377-TRENDYOL.COM ISTANBUL TR Pos satış" })] },
      { id: "4", splits: [split({ description: "Ice tea", destination_name: "A101" })] },
    ]);
    const result = (await registry(client).execute("transaction", "group_patterns", {})) as {
      distinct: number;
      patterns: { key: string; count: number; total: number }[];
    };

    expect(result.distinct).toBe(2);
    expect(result.patterns[0]).toMatchObject({
      key: "#-TRENDYOL.COM ISTANBUL TR Pos satış",
      count: 3,
      total: 225,
    });
  });

  it("groups by the counterpart account when asked", async () => {
    const { client } = ledgerClient([
      { id: "1", splits: [split({ destination_name: "Trendyol" })] },
      { id: "2", splits: [split({ destination_name: "A101" })] },
    ]);
    const result = (await registry(client).execute("transaction", "group_patterns", {
      by: "counterpart",
    })) as { patterns: { key: string }[] };
    expect(result.patterns.map((entry) => entry.key).sort()).toEqual(["A101", "Trendyol"]);
  });
});

describe("bulk_update_where", () => {
  it("writes nothing at all when more rows match than the caller expected", async () => {
    // The safety valve. A filter one word too broad would otherwise rewrite the
    // ledger and report success on every row.
    const { client, puts } = ledgerClient(
      Array.from({ length: 5 }, (_, index) => ({ id: `${index + 1}`, splits: [split()] })),
    );
    const result = (await registry(client).execute("transaction", "bulk_update_where", {
      where: { destination_name: "Trendyol" },
      set: { category_name: "Dijital Alışveriş" },
      max_matches: 3,
    })) as { refused: boolean; matched: number; updated: number };

    expect(puts).toEqual([]);
    expect(result).toMatchObject({ refused: true, matched: 5, max_matches: 3 });
  });

  it("refuses to set tags on every matched row, which would delete each one's set", async () => {
    // Firefly replaces a split's whole tag list rather than merging into it, so
    // one `set.tags` shared by every row would wipe whatever each already had —
    // the failure CLAUDE.md records bulk_tag causing once. The mitigation "read
    // current values first" cannot be followed when the caller never names the
    // rows, so the field simply is not offered here.
    const { client } = ledgerClient([{ id: "7", splits: [split()] }]);
    await expect(
      registry(client).execute("transaction", "bulk_update_where", {
        where: {},
        set: { tags: ["Market"] },
        max_matches: 1,
      }),
    ).rejects.toThrow();
  });

  it("applies the fields once the count is the one the caller named", async () => {
    const { client, puts } = ledgerClient([
      { id: "7", splits: [split({ transaction_journal_id: "70" })] },
      { id: "8", splits: [split({ transaction_journal_id: "80" })] },
    ]);
    const result = await registry(client).execute("transaction", "bulk_update_where", {
      where: { destination_name: "Trendyol" },
      set: { category_name: "Dijital Alışveriş" },
      max_matches: 2,
    });

    expect(puts).toEqual([
      {
        path: "/transactions/7",
        body: { transactions: [{ transaction_journal_id: "70", category_name: "Dijital Alışveriş" }] },
      },
      {
        path: "/transactions/8",
        body: { transactions: [{ transaction_journal_id: "80", category_name: "Dijital Alışveriş" }] },
      },
    ]);
    expect(result).toMatchObject({ updated: 2, failed: 0, skipped: 0 });
  });

  it("reads each page once and never re-reads a group it is about to write", async () => {
    // The scan already carries the journal id. A GET per row would double the
    // request count on exactly the operations meant to reduce it.
    const { client, gets, puts } = ledgerClient([{ id: "7", splits: [split()] }]);
    await registry(client).execute("transaction", "bulk_update_where", {
      where: {},
      set: { notes: "x" },
      max_matches: 1,
    });
    expect(gets.map((call) => call.path)).toEqual(["/transactions"]);
    expect(puts).toHaveLength(1);
  });

  it("matches description_contains through a Turkish fold", async () => {
    // The dotted İ is the case a plain toLowerCase gets wrong: it lowercases to
    // "i̇" (i plus a combining dot above), which is not a substring of "istanbul"
    // and would match nothing. The fold collapses I/ı/İ/i to one letter first,
    // so a caller typing the properly-Turkish form finds the ASCII row. Using
    // ASCII "ISTANBUL" here would make the test pass even if the fold were
    // already broken — toLowerCase handles plain ASCII correctly — so the
    // description carries the dotted form on purpose.
    const { client } = ledgerClient([{ id: "1", splits: [split({ description: "TRENDYOL İSTANBUL" })] }]);
    const result = (await registry(client).execute("transaction", "group_patterns", {
      where: { description_contains: "istanbul" },
      by: "description",
    })) as { matched: number };
    expect(result.matched).toBe(1);
  });

  it("selects only uncategorised rows for has_no_category", async () => {
    const { client } = ledgerClient([
      { id: "1", splits: [split({ category_name: "Market" })] },
      { id: "2", splits: [split({ category_name: "" })] },
    ]);
    const result = (await registry(client).execute("transaction", "group_patterns", {
      where: { has_no_category: true },
    })) as { matched: number };
    expect(result.matched).toBe(1);
  });

  it("skips a multi-split group rather than guessing what one split of three means", async () => {
    const { client, puts } = ledgerClient([
      {
        id: "5",
        splits: [
          split({ transaction_journal_id: "50" }),
          split({ transaction_journal_id: "51" }),
        ],
      },
    ]);
    const result = (await registry(client).execute("transaction", "bulk_update_where", {
      where: {},
      set: { category_name: "Market" },
      max_matches: 5,
    })) as { updated: number; skipped: number; results: { reason?: string }[] };

    expect(puts).toEqual([]);
    expect(result).toMatchObject({ updated: 0, skipped: 1 });
    expect(result.results[0]!.reason).toContain("2 splits");
  });
});

describe("bulk_rewrite", () => {
  it("strips the terminal number and leaves rows the pattern misses untouched", async () => {
    const { client, puts } = ledgerClient([
      { id: "1", splits: [split({ transaction_journal_id: "10" })] },
      { id: "2", splits: [split({ transaction_journal_id: "20", description: "Ice tea" })] },
    ]);
    const result = (await registry(client).execute("transaction", "bulk_rewrite", {
      where: {},
      match: "#-* ISTANBUL TR*",
      replace: "$2",
      max_matches: 5,
    })) as { updated: number; unchanged: number; samples: { before: string; after: string }[] };

    expect(puts).toEqual([
      {
        path: "/transactions/1",
        body: { transactions: [{ transaction_journal_id: "10", description: "TRENDYOL.COM" }] },
      },
    ]);
    expect(result).toMatchObject({ updated: 1, unchanged: 1 });
    expect(result.samples[0]).toMatchObject({ after: "TRENDYOL.COM" });
  });

  it("keeps the original in the notes, and does not stack it on a second run", async () => {
    const already = "Original import text: 086200000023377-TRENDYOL.COM ISTANBUL TR Pos satış";
    const { client, puts } = ledgerClient([
      { id: "1", splits: [split({ transaction_journal_id: "10" })] },
      { id: "2", splits: [split({ transaction_journal_id: "20", notes: already })] },
    ]);
    await registry(client).execute("transaction", "bulk_rewrite", {
      where: {},
      match: "#-* ISTANBUL*",
      replace: "$2",
      max_matches: 5,
      keep_original_in_notes: true,
    });

    const bodies = puts.map((call) => (call.body as { transactions: Record<string, unknown>[] }).transactions[0]!);
    expect(bodies[0]!.notes).toBe(already);
    expect(bodies[1]!.notes).toBeUndefined();
  });

  it("refuses a replacement that would leave the description empty", async () => {
    // Firefly requires a description; an empty one fails per row and would be
    // reported as a partial success on a rewrite that was simply wrong.
    const { client, puts } = ledgerClient([{ id: "1", splits: [split()] }]);
    const result = (await registry(client).execute("transaction", "bulk_rewrite", {
      where: {},
      match: "*",
      replace: "",
      max_matches: 5,
    })) as { updated: number; unchanged: number };

    expect(puts).toEqual([]);
    expect(result).toMatchObject({ updated: 0, unchanged: 1 });
  });

  it("rejects a pattern with two wildcards side by side", async () => {
    // The pattern language has no regular expressions, so a malformed regex
    // cannot be the reject case. Adjacent wildcards (`**`) have no single
    // answer either, and a rewrite that guesses one lands text in the wrong
    // capture — so it is refused rather than tolerated.
    const { client } = ledgerClient([{ id: "1", splits: [split()] }]);
    await expect(
      registry(client).execute("transaction", "bulk_rewrite", {
        where: {},
        match: "a**b",
        replace: "x",
        max_matches: 1,
      }),
    ).rejects.toThrow(/two wildcards next to each other/);
  });
});

describe("the scan pages for real and says when it stopped", () => {
  it("reads every page of a ledger that spans several", async () => {
    // A scan that stops at the first page would report an empty-looking subset
    // as a complete answer. Driving the page size down forces real pagination,
    // so this fails the moment the loop forgets the `page` query.
    const { client, gets } = ledgerClient(
      Array.from({ length: 60 }, (_unused, index) => ({ id: `${index + 1}`, splits: [split()] })),
      20,
    );
    const result = (await registry(client).execute("transaction", "group_patterns", {
      where: {},
    })) as { matched: number; truncated: boolean };
    expect(gets.map((call) => call.query?.page)).toEqual([1, 2, 3]);
    expect(result).toMatchObject({ matched: 60, truncated: false });
  });

  it("reports the ledger as truncated when it could not confirm the last page", async () => {
    // The page cap is the only thing left after a scan has read MAX_PAGES
    // pages; Firefly is still answering, but the caller must be told the count
    // is a lower bound. Absent this, a filter-driven write would act on the
    // first few thousand matches silently.
    const { client } = ledgerClient(
      Array.from({ length: 5200 }, (_unused, index) => ({ id: `${index + 1}`, splits: [split()] })),
    );
    const result = (await registry(client).execute("transaction", "group_patterns", {
      where: {},
    })) as { matched: number; scanned: number; truncated: boolean };
    expect(result).toMatchObject({ truncated: true });
  });

  it("does not hide a match count that only reached the page cap", async () => {
    // Same ceiling, different shape: a read surface reports the match count it
    // reached, but the scan was cut off, so truncated must be true rather than
    // the count reading as a complete answer.
    const { client } = ledgerClient(
      Array.from({ length: 5200 }, (_unused, index) => ({ id: `${index + 1}`, splits: [split()] })),
    );
    const result = (await registry(client).execute("transaction", "group_patterns", {
      where: {},
    })) as { matched: number; scanned: number; truncated: boolean };
    expect(result.scanned).toBeLessThan(5200);
    expect(result.truncated).toBe(true);
  });

  it("refuses a write when Firefly returns no pagination meta", async () => {
    // Firefly's metadata is what tells the scan how many pages it must read. A
    // reply that omits it and fills a page is exactly the silent cut-off a
    // filter-driven write must not act on. The client here keeps answering a
    // full page but never says how many follow, so the scan has to conclude
    // "possibly truncated" and the write has to refuse.
    const puts_metaLess: { path: string; body: unknown }[] = [];
    const metaLess: FireflyClient = {
      getText: async () => "",
      postBinary: async () => null,
      post: async () => ({}),
      del: async () => null,
      put: async (path, body) => {
        puts_metaLess.push({ path, body });
        return {};
      },
      get: async () => ({
        // A full page, but no pagination meta. A filter-driven write below
        // waits for the refusal: the scan cannot prove it saw everything.
        data: Array.from({ length: 100 }, (_unused, index) => ({
          id: `${index + 1}`,
          attributes: { transactions: [split()] },
        })),
      }),
    };
    const result = (await registry(metaLess).execute("transaction", "bulk_update_where", {
      where: {},
      set: { category_name: "Market" },
      max_matches: 200,
    })) as { refused: boolean; truncated: boolean; matched: number; max_matches: number };
    expect(puts_metaLess).toEqual([]);
    expect(result).toMatchObject({ refused: true, truncated: true });
  });
});

describe("reconcile", () => {
  it("names what each side is missing and the amount they differ by", async () => {
    const { client } = ledgerClient([
      { id: "1", splits: [split({ amount: "75.00", date: "2026-08-18T00:00:00+00:00" })] },
      { id: "2", splits: [split({ amount: "30.00", date: "2026-08-26T00:00:00+00:00" })] },
    ]);
    const result = (await registry(client).execute("transaction", "reconcile", {
      account_id: "1",
      start: "2026-08-01",
      end: "2026-08-31",
      rows: [
        { date: "2026-08-18", amount: "-75.00" },
        { date: "2026-08-20", amount: "-247.07", label: "ANOMALY SAN FRANCISCO US" },
      ],
    })) as {
      matched: number;
      difference: number;
      missing_in_firefly: { label?: string }[];
      missing_in_statement: { id: string }[];
    };

    expect(result.matched).toBe(1);
    expect(result.missing_in_firefly).toEqual([
      { date: "2026-08-20", amount: "-247.07", label: "ANOMALY SAN FRANCISCO US" },
    ]);
    expect(result.missing_in_statement.map((entry) => entry.id)).toEqual(["2"]);
    // ledger −105,00 against statement −322,07
    expect(result.difference).toBe(217.07);
  });

  it("matches a value date that lands a day off when told it may", async () => {
    const { client } = ledgerClient([
      { id: "1", splits: [split({ amount: "75.00", date: "2026-08-18T00:00:00+00:00" })] },
    ]);
    const result = (await registry(client).execute("transaction", "reconcile", {
      account_id: "1",
      start: "2026-08-01",
      end: "2026-08-31",
      rows: [{ date: "2026-08-17", amount: "-75.00" }],
      day_tolerance: 1,
    })) as { matched: number };
    expect(result.matched).toBe(1);
  });

  it("signs a deposit into the account as positive", async () => {
    const { client } = ledgerClient([
      {
        id: "1",
        splits: [
          split({ type: "deposit", amount: "110.00", source_id: "30", destination_id: "1" }),
        ],
      },
    ]);
    const result = (await registry(client).execute("transaction", "reconcile", {
      account_id: "1",
      start: "2026-08-01",
      end: "2026-08-31",
      rows: [{ date: "2026-08-18", amount: "110.00" }],
    })) as { matched: number; difference: number };
    expect(result).toMatchObject({ matched: 1, difference: 0 });
  });
});

describe("dry_run on a filter-driven write", () => {
  it("carries the refusal, so an empty plan is not read as an empty filter", async () => {
    // Without the handler's own answer a preview shows `would_send: []` both
    // when nothing matched and when 500 rows matched and the operation
    // refused — opposite situations that need opposite next steps.
    const { client, puts } = ledgerClient(
      Array.from({ length: 4 }, (_, index) => ({ id: `${index + 1}`, splits: [split()] })),
    );
    const result = (await registry(client).execute(
      "transaction",
      "bulk_update_where",
      { where: {}, set: { category_name: "Market" }, max_matches: 2 },
      undefined,
      ["destructive"],
      true,
    )) as { dry_run: boolean; would_send: unknown[]; outcome: { refused?: boolean; matched?: number } };

    expect(puts).toEqual([]);
    expect(result.would_send).toEqual([]);
    expect(result.outcome).toMatchObject({ refused: true, matched: 4, max_matches: 2 });
  });

  it("shows the payloads it would send when the filter is within bounds", async () => {
    const { client, puts } = ledgerClient([{ id: "7", splits: [split({ transaction_journal_id: "70" })] }]);
    const result = (await registry(client).execute(
      "transaction",
      "bulk_update_where",
      { where: {}, set: { category_name: "Market" }, max_matches: 5 },
      undefined,
      ["destructive"],
      true,
    )) as { would_send: { method: string; path: string; body: unknown }[] };

    expect(puts).toEqual([]);
    expect(result.would_send).toEqual([
      {
        method: "PUT",
        path: "/transactions/7",
        body: { transactions: [{ transaction_journal_id: "70", category_name: "Market" }] },
      },
    ]);
  });
});

describe("the scan's own limits", () => {
  it("reads every page, not just the first", async () => {
    // The helper has always been able to page; no test used it, so a scan that
    // stopped after page one passed the whole suite.
    const { client, gets } = ledgerClient(
      Array.from({ length: 250 }, (_, index) => ({ id: `${index + 1}`, splits: [split()] })),
      100,
    );
    const result = (await registry(client).execute("transaction", "group_patterns", {})) as {
      matched: number;
    };
    expect(result.matched).toBe(250);
    expect(gets).toHaveLength(3);
  });

  it("refuses to write when Firefly returns no pagination meta and the page was full", async () => {
    // Without meta the loop breaks after page one. Reporting that as a
    // complete scan is what let a filter-driven write act on 100 of 250
    // matches and call it a success.
    const { client, puts } = ledgerClient(
      Array.from({ length: 250 }, (_, index) => ({ id: `${index + 1}`, splits: [split()] })),
      100,
      false,
    );
    const result = (await registry(client).execute("transaction", "bulk_update_where", {
      where: {},
      set: { category_name: "Market" },
      max_matches: 200,
    })) as { refused: boolean; truncated: boolean };

    expect(puts).toEqual([]);
    expect(result).toMatchObject({ refused: true, truncated: true });
  });

  it("does not cry truncation on a short last page with no meta", async () => {
    const { client } = ledgerClient([{ id: "1", splits: [split()] }], 100, false);
    const result = (await registry(client).execute("transaction", "group_patterns", {})) as {
      truncated: boolean;
      matched: number;
    };
    expect(result).toMatchObject({ truncated: false, matched: 1 });
  });
});

describe("amount filters", () => {
  it("refuses a bound it cannot compare instead of dropping the condition", async () => {
    // Number("1.000,00") is NaN and every comparison against NaN is false, so
    // the bound stopped narrowing and the filter matched the whole ledger —
    // then wrote to it.
    const { client, puts } = ledgerClient([
      { id: "1", splits: [split({ amount: "5.00" })] },
      { id: "2", splits: [split({ amount: "9999.00" })] },
    ]);
    await expect(
      registry(client).execute("transaction", "bulk_update_where", {
        where: { amount_min: "1.000,00" },
        set: { category_name: "X" },
        max_matches: 5,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(puts).toEqual([]);
  });

  it("refuses a bound that overflows past the schema's regex", async () => {
    // A 400-digit integer satisfies the decimal pattern and then becomes
    // Infinity, so Number.isFinite is false and money() yields NaN. Without
    // the second check the condition would silently stop narrowing — the same
    // failure as the Turkish decimal, reached through the field that is meant
    // to have been validated already.
    const { client, puts } = ledgerClient([{ id: "1", splits: [split({ amount: "5.00" })] }]);
    await expect(
      registry(client).execute("transaction", "bulk_update_where", {
        where: { amount_min: "9".repeat(400) },
        set: { category_name: "X" },
        max_matches: 5,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(puts).toEqual([]);
  });

  it("narrows on a bound it can compare", async () => {
    const { client } = ledgerClient([
      { id: "1", splits: [split({ amount: "5.00" })] },
      { id: "2", splits: [split({ amount: "9999.00" })] },
    ]);
    const result = (await registry(client).execute("transaction", "group_patterns", {
      where: { amount_min: "1000.00" },
    })) as { matched: number };
    expect(result.matched).toBe(1);
  });

  it("excludes a row whose own amount will not parse", async () => {
    const { client } = ledgerClient([{ id: "1", splits: [split({ amount: "n/a" })] }]);
    const result = (await registry(client).execute("transaction", "group_patterns", {
      where: { amount_min: "0" },
    })) as { matched: number };
    expect(result.matched).toBe(0);
  });
});

describe("bulk_rewrite safety", () => {
  it("refuses keep_original_in_notes when the notes are what it would overwrite", async () => {
    // The flag used to be accepted and silently ignored, destroying the exact
    // text the caller set it to preserve.
    const { client, puts } = ledgerClient([{ id: "1", splits: [split({ notes: "IMPORTANT" })] }]);
    await expect(
      registry(client).execute("transaction", "bulk_rewrite", {
        where: {},
        field: "notes",
        match: "*",
        replace: "gone",
        max_matches: 5,
        keep_original_in_notes: true,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(puts).toEqual([]);
  });

  it("lets a note be cleared, which a description may not be", async () => {
    const { client, puts } = ledgerClient([{ id: "1", splits: [split({ notes: "eski not" })] }]);
    const result = (await registry(client).execute("transaction", "bulk_rewrite", {
      where: {},
      field: "notes",
      match: "*",
      replace: "",
      max_matches: 5,
    })) as { updated: number };

    expect(result).toMatchObject({ updated: 1 });
    expect((puts[0]!.body as { transactions: Record<string, unknown>[] }).transactions[0]!.notes).toBe("");
  });

  it("is idempotent: a second run changes nothing", async () => {
    // The old regex had no `g` flag, so it replaced the first match only and a
    // second run ate the next one — three different results from one rule.
    const { client, puts } = ledgerClient([{ id: "1", splits: [split({ transaction_journal_id: "10" })] }]);
    await registry(client).execute("transaction", "bulk_rewrite", {
      where: {},
      match: "#-* ISTANBUL TR *",
      replace: "$2",
      max_matches: 5,
    });
    const rewritten = (puts[0]!.body as { transactions: Record<string, unknown>[] }).transactions[0]!
      .description as string;

    const second = ledgerClient([
      { id: "1", splits: [split({ transaction_journal_id: "10", description: rewritten })] },
    ]);
    const result = (await registry(second.client).execute("transaction", "bulk_rewrite", {
      where: {},
      match: "#-* ISTANBUL TR *",
      replace: "$2",
      max_matches: 5,
    })) as { updated: number; unchanged: number };

    expect(rewritten).toBe("TRENDYOL.COM");
    expect(second.puts).toEqual([]);
    expect(result).toMatchObject({ updated: 0, unchanged: 1 });
  });

  it("skips a split Firefly gave no journal id for", async () => {
    // Two such rows used to collide on the empty-string key and both were
    // written with the last row's replacement.
    const { client, puts } = ledgerClient([
      { id: "1", splits: [{ ...split({ description: "AAA 1" }), transaction_journal_id: undefined }] },
      { id: "2", splits: [{ ...split({ description: "BBB 2" }), transaction_journal_id: undefined }] },
    ]);
    const result = (await registry(client).execute("transaction", "bulk_rewrite", {
      where: {},
      match: "* #",
      replace: "Z$1",
      max_matches: 5,
    })) as { updated: number; skipped: number; results: { reason?: string }[] };

    expect(puts).toEqual([]);
    expect(result).toMatchObject({ updated: 0, skipped: 2 });
    expect(result.results[0]!.reason).toContain("journal_id");
  });
});

describe("bulk_update_where refuses tags", () => {
  it("will not take a shared tag list that would wipe each row's own", async () => {
    // Firefly replaces a split's whole tag list. One `set` for many rows can
    // only delete what each of them carried, and the mitigation the field's
    // description gives cannot be followed when no ids are named.
    const { client, puts } = ledgerClient([{ id: "1", splits: [split({ tags: ["vergi", "2025"] })] }]);
    await expect(
      registry(client).execute("transaction", "bulk_update_where", {
        where: {},
        set: { tags: ["yeni"] },
        max_matches: 5,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(puts).toEqual([]);
  });
});

describe("reconcile input", () => {
  it("rejects a date it would silently fail to match", async () => {
    // Date.parse("18.08.2026T00:00:00Z") is NaN, NaN <= tolerance is false, so
    // every row came back as missing on both sides — which a caller fixes by
    // creating a duplicate and deleting a real record.
    const { client } = ledgerClient([{ id: "1", splits: [split()] }]);
    await expect(
      registry(client).execute("transaction", "reconcile", {
        account_id: "1",
        start: "2026-08-01",
        end: "2026-08-31",
        rows: [{ date: "18.08.2026", amount: "-75.00" }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects a Turkish decimal that would make the difference NaN", async () => {
    const { client } = ledgerClient([{ id: "1", splits: [split()] }]);
    await expect(
      registry(client).execute("transaction", "reconcile", {
        account_id: "1",
        start: "2026-08-01",
        end: "2026-08-31",
        rows: [{ date: "2026-08-18", amount: "-75,00" }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("dry_run honesty", () => {
  it("does not report rows as updated when nothing was written", async () => {
    // The preview client's writes all "succeed", so the handler's counters are
    // fiction. A caller reading `updated: 1` beside "nothing was written" does
    // not run it for real.
    const { client, puts } = ledgerClient([{ id: "7", splits: [split({ transaction_journal_id: "70" })] }]);
    const result = (await registry(client).execute(
      "transaction",
      "bulk_update_where",
      { where: {}, set: { category_name: "Market" }, max_matches: 5 },
      undefined,
      ["read", "write", "destructive"] as const,
      true,
    )) as Record<string, unknown>;

    expect(puts).toEqual([]);
    expect(result.would_send).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('"updated"');
  });
});
