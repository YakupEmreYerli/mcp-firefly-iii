import { describe, expect, it } from "vitest";
import { projectFields, stripEmpty } from "../src/projection.js";

describe("stripEmpty", () => {
  it("drops null-valued keys", () => {
    expect(stripEmpty({ name: "enpara", iban: null })).toEqual({ name: "enpara" });
  });

  it("drops empty strings and collections", () => {
    expect(stripEmpty({ name: "enpara", notes: "", tags: [], meta: {} })).toEqual({
      name: "enpara",
    });
  });

  it("keeps falsy values that carry meaning", () => {
    const payload = { balance: "0", active: false, count: 0 };
    expect(stripEmpty(payload)).toEqual(payload);
  });

  it("strips inside nested structures", () => {
    const payload = { data: [{ attributes: { name: "enpara", iban: null } }] };
    expect(stripEmpty(payload)).toEqual({ data: [{ attributes: { name: "enpara" } }] });
  });

  it("keeps an empty result set", () => {
    const payload = { data: [] };
    expect(stripEmpty(payload)).toEqual(payload);
  });

  it("leaves scalars untouched", () => {
    expect(stripEmpty("enpara")).toBe("enpara");
    expect(stripEmpty(42)).toBe(42);
  });
});

describe("projectFields", () => {
  const accounts = {
    data: [{ id: "1", type: "accounts", attributes: { name: "enpara", iban: "TR00", notes: "x" } }],
    meta: { pagination: { total: 9 } },
  };

  it("keeps only the requested attribute keys", () => {
    const result = projectFields(accounts, ["name"]) as typeof accounts;
    expect(result.data[0]!.attributes).toEqual({ name: "enpara" });
  });

  it("preserves the JSON:API envelope keys", () => {
    const result = projectFields(accounts, ["name"]) as typeof accounts;
    expect(result.data[0]!.id).toBe("1");
    expect(result.data[0]!.type).toBe("accounts");
    expect(result.meta).toEqual({ pagination: { total: 9 } });
  });

  it("projects transaction splits", () => {
    const payload = {
      data: [
        {
          id: "7",
          type: "transactions",
          attributes: {
            created_at: "2026-08-01",
            transactions: [
              { date: "2026-08-01", amount: "25.50", notes: "x", transaction_journal_id: "9" },
            ],
          },
        },
      ],
    };
    const result = projectFields(payload, ["date", "amount"]) as typeof payload;
    expect(result.data[0]!.attributes.transactions[0]).toEqual({
      date: "2026-08-01",
      amount: "25.50",
    });
  });

  it("returns the payload unchanged when no fields are requested", () => {
    expect(projectFields(accounts, undefined)).toEqual(accounts);
    expect(projectFields(accounts, [])).toEqual(accounts);
  });

  it("ignores unknown field names rather than failing", () => {
    const result = projectFields(accounts, ["name", "nonsense"]) as typeof accounts;
    expect(result.data[0]!.attributes).toEqual({ name: "enpara" });
  });

  it("projects a single-record payload as well as a list", () => {
    const single = { data: { id: "1", type: "accounts", attributes: { name: "enpara", iban: "TR00" } } };
    const result = projectFields(single, ["name"]) as typeof single;
    expect(result.data.attributes).toEqual({ name: "enpara" });
  });
});
