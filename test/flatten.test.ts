import { describe, expect, it } from "vitest";
import { flattenTransactions } from "../src/flatten.js";

type Row = { id?: string; type?: string; attributes: Record<string, unknown> };

function group(id: string, splits: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  return {
    id,
    type: "transactions",
    attributes: { created_at: "2026-08-01T10:00:00+03:00", ...extra, transactions: splits },
  };
}

const purchase = {
  transaction_journal_id: "900",
  type: "withdrawal",
  date: "2026-08-01T10:00:00+03:00",
  amount: "25.50",
  description: "market",
  category_name: "Groceries",
};

describe("flattenTransactions", () => {
  it("lifts a single split's fields up out of the nesting", () => {
    const result = flattenTransactions({ data: [group("7", [purchase])] }) as { data: Row[] };

    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.attributes).toMatchObject({
      amount: "25.50",
      description: "market",
      category_name: "Groceries",
    });
    expect(result.data[0]!.attributes).not.toHaveProperty("transactions");
  });

  it("keeps the group id, because that is what update and delete take", () => {
    // The split's transaction_journal_id is not an id Firefly matches on the
    // group endpoints, and a wrong id there returns 200 having changed nothing.
    const result = flattenTransactions({ data: [group("7", [purchase])] }) as { data: Row[] };

    expect(result.data[0]!.id).toBe("7");
    expect(result.data[0]!.attributes.transaction_journal_id).toBe("900");
  });

  it("keeps group-level attributes alongside the split", () => {
    const result = flattenTransactions({
      data: [group("7", [purchase], { group_title: "Weekly shop" })],
    }) as { data: Row[] };

    expect(result.data[0]!.attributes.group_title).toBe("Weekly shop");
    expect(result.data[0]!.attributes.created_at).toBe("2026-08-01T10:00:00+03:00");
  });

  it("gives a split transaction one row per split", () => {
    const second = { ...purchase, transaction_journal_id: "901", amount: "10.00", description: "drinks" };
    const result = flattenTransactions({ data: [group("7", [purchase, second])] }) as { data: Row[] };

    expect(result.data).toHaveLength(2);
    expect(result.data.map((row) => row.attributes.amount)).toEqual(["25.50", "10.00"]);
    expect(result.data.every((row) => row.id === "7")).toBe(true);
  });

  it("marks a split transaction so the extra rows are not a surprise", () => {
    const second = { ...purchase, transaction_journal_id: "901" };
    const result = flattenTransactions({ data: [group("7", [purchase, second])] }) as { data: Row[] };

    expect(result.data[0]!.attributes.split_count).toBe(2);
  });

  it("does not mark the ordinary single-split record", () => {
    const result = flattenTransactions({ data: [group("7", [purchase])] }) as { data: Row[] };

    expect(result.data[0]!.attributes).not.toHaveProperty("split_count");
  });

  it("flattens a single-record response without turning it into a list", () => {
    const result = flattenTransactions({ data: group("7", [purchase]) }) as { data: Row };

    expect(Array.isArray(result.data)).toBe(false);
    expect(result.data.attributes.amount).toBe("25.50");
  });

  it("turns a single record with several splits into a list rather than losing them", () => {
    const second = { ...purchase, transaction_journal_id: "901" };
    const result = flattenTransactions({ data: group("7", [purchase, second]) }) as { data: Row[] };

    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data).toHaveLength(2);
  });

  it("leaves Firefly's pagination exactly as it arrived", () => {
    // Firefly paginates groups, not rows. Restating its counts here would be
    // a guess about a page whose contents Firefly chose.
    const meta = { pagination: { total: 40, count: 1, per_page: 50, current_page: 1 } };
    const result = flattenTransactions({ data: [group("7", [purchase])], meta }) as {
      meta: unknown;
    };

    expect(result.meta).toEqual(meta);
  });

  it("leaves an account payload untouched", () => {
    const accounts = { data: [{ id: "1", type: "accounts", attributes: { name: "Checking" } }] };

    expect(flattenTransactions(accounts)).toEqual(accounts);
  });

  it("leaves an empty result set alone", () => {
    expect(flattenTransactions({ data: [] })).toEqual({ data: [] });
  });

  it("keeps a group that carries no splits rather than dropping the row", () => {
    const result = flattenTransactions({ data: [group("7", [])] }) as { data: Row[] };

    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.attributes).not.toHaveProperty("transactions");
  });

  it("passes through anything that is not a JSON:API document", () => {
    expect(flattenTransactions("text")).toBe("text");
    expect(flattenTransactions(null)).toBe(null);
    expect(flattenTransactions({ ok: true })).toEqual({ ok: true });
  });

  it("lets a later split win on a field the group also has", () => {
    const result = flattenTransactions({
      data: [group("7", [{ ...purchase, created_at: "2026-08-02T00:00:00+03:00" }])],
    }) as { data: Row[] };

    expect(result.data[0]!.attributes.created_at).toBe("2026-08-02T00:00:00+03:00");
  });
});
