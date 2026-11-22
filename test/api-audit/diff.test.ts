import { describe, expect, it } from "vitest";
import { diffFields, requestClassFor } from "../../scripts/api-audit/diff.mjs";

describe("requestClassFor", () => {
  it("maps a collection POST to the store request and a record PUT to the update request", () => {
    expect(requestClassFor("POST", "/bills")).toBe("Models/Bill/StoreRequest.php");
    expect(requestClassFor("PUT", "/bills/{id}")).toBe("Models/Bill/UpdateRequest.php");
  });

  it("uses Firefly's folder name where it differs from the path", () => {
    expect(requestClassFor("POST", "/piggy-banks")).toBe("Models/PiggyBank/StoreRequest.php");
    expect(requestClassFor("PUT", "/currencies/{id}")).toBe("Models/TransactionCurrency/UpdateRequest.php");
    expect(requestClassFor("PUT", "/budgets/{id}/limits/{id}")).toBe("Models/BudgetLimit/UpdateRequest.php");
    expect(requestClassFor("POST", "/rules/{id}/trigger")).toBe("Models/Rule/TriggerRequest.php");
  });

  it("returns undefined for endpoints without a request body class", () => {
    expect(requestClassFor("DELETE", "/bills/{id}")).toBeUndefined();
    expect(requestClassFor("POST", "/currencies/{id}/enable")).toBeUndefined();
  });
});

describe("diffFields", () => {
  it("reports fields Firefly reads that we never send", () => {
    expect(diffFields(["name", "amount_min"], { read: ["name", "amount_min", "currency_code"], validated: [] }))
      .toEqual({ missing: ["currency_code"], ignored: [] });
  });

  it("reports fields we send that Firefly never reads", () => {
    expect(diffFields(["name", "bogus"], { read: ["name"], validated: ["name"] }))
      .toEqual({ missing: [], ignored: ["bogus"] });
  });

  it("diffs store and update against their own read lists", () => {
    const ours = ["name"];
    expect(diffFields(ours, { read: ["name", "end_date"], validated: [] }).missing).toEqual(["end_date"]);
    expect(diffFields(ours, { read: ["name"], validated: [] }).missing).toEqual([]);
  });
});
