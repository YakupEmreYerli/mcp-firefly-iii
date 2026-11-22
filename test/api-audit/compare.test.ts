import { describe, expect, it } from "vitest";
import { compareStored } from "../../scripts/api-audit/compare.mjs";

describe("compareStored", () => {
  it("reports a stored value that differs from the one sent", () => {
    expect(compareStored({ name: "A" }, { name: "B" }).mismatches).toEqual(['name: sent "A", stored "B"']);
  });

  // A field Firefly does not echo back cannot be verified; passing it silently
  // is how a dropped field once looked like a success.
  it("lists sent fields the response does not carry as unverified", () => {
    const result = compareStored({ name: "Loan", liability_amount: "1000" }, { name: "Loan" });
    expect(result.mismatches).toEqual([]);
    expect(result.unverified).toEqual(["liability_amount"]);
  });

  it("treats dates, numbers and case-only differences as equal", () => {
    expect(compareStored({ date: "2026-11-01", amount: "12.50", code: "eur" }, { date: "2026-11-01T00:00:00+01:00", amount: "12.500000", code: "EUR" })).toEqual({ mismatches: [], unverified: [] });
  });
});
