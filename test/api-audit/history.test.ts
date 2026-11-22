import { describe, expect, it } from "vitest";
import { fieldIntroductions } from "../../scripts/api-audit/history.mjs";

describe("fieldIntroductions", () => {
  it("names the first release that reads each new field", () => {
    expect(fieldIntroductions([
      { ref: "v6.6.3", reads: { "category.create": ["name"] } },
      { ref: "v6.7.0", reads: { "category.create": ["name"] } },
      { ref: "v6.7.8", reads: { "category.create": ["name", "color"] } },
      { ref: "v6.7.9", reads: { "category.create": ["name", "color"] } },
    ])).toEqual([{ operation: "category.create", field: "color", since: "v6.7.8" }]);
  });

  it("does not list fields the oldest release already reads", () => {
    expect(fieldIntroductions([
      { ref: "v6.6.3", reads: { "bill.create": ["name", "end_date"] } },
      { ref: "v6.7.9", reads: { "bill.create": ["name", "end_date"] } },
    ])).toEqual([]);
  });

  it("counts an operation first seen in a later release from that release", () => {
    expect(fieldIntroductions([
      { ref: "v6.6.3", reads: {} },
      { ref: "v6.7.0", reads: { "webhook.create": ["url"] } },
    ])).toEqual([{ operation: "webhook.create", field: "url", since: "v6.7.0" }]);
  });
});
