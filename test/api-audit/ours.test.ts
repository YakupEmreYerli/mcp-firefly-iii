import { describe, expect, it } from "vitest";
import { collectWriteOperations } from "../../scripts/api-audit/ours.mjs";
import { ENTITY_MODULES } from "../../src/server.js";

type Recorded = { name: string; method: string; path: string; bodyKeys: string[]; queryKeys: string[]; error?: string };

const operations = (await collectWriteOperations(ENTITY_MODULES)) as Recorded[];
const find = (name: string) => operations.find((op) => op.name === name);

describe("collectWriteOperations", () => {
  it("records the endpoint and every body field an operation can send", () => {
    const op = find("bill.create");
    expect(op).toMatchObject({ method: "POST", path: "/bills" });
    expect(op!.bodyKeys).toEqual(expect.arrayContaining(["name", "currency_code", "currency_id", "notes"]));
  });

  it("templates ids in the path and keeps path parameters and wrappers out of the body", () => {
    const op = find("bill.update")!;
    expect(op.path).toBe("/bills/{id}");
    expect(op.bodyKeys).toContain("name");
    expect(op.bodyKeys).not.toContain("id");
    expect(op.bodyKeys).not.toContain("bill_update");
  });

  it("names fields inside arrays of objects as array.*.field", () => {
    expect(find("transaction.create")!.bodyKeys).toEqual(expect.arrayContaining(["transactions", "transactions.*.amount"]));
  });

  it("records query fields of query-only writes", () => {
    const op = find("rule.trigger")!;
    expect(op.method).toBe("POST");
    expect(op.queryKeys).toEqual(expect.arrayContaining(["start", "end"]));
  });

  it("lists write and destructive operations only", () => {
    expect(find("bill.list")).toBeUndefined();
    expect(find("bill.delete")).toMatchObject({ method: "DELETE", path: "/bills/{id}" });
  });
});
