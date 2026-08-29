import { describe, expect, it } from "vitest";
import { renderIndex, renderOperationsPage, renderCountOnly, planEdits } from "../../scripts/docs/render.mjs";

function op(entity: string, operation: string, access: "read" | "write" | "destructive" = "read") {
  return { name: `${entity}.${operation}`, entity, operation, description: "x", access, schema: {}, fingerprint: "f" };
}

function model(operations: ReturnType<typeof op>[], overrides: Record<string, unknown> = {}) {
  return {
    operations,
    entities: [...new Set(operations.map((o) => o.entity))].sort(),
    envVars: [],
    retiredEnvVars: [],
    docFiles: [],
    ...overrides,
  };
}

describe("renderIndex", () => {
  it("rewrites the operation table from the current registry, not from the page", () => {
    const text = [
      "# Title",
      "",
      "| Entity | Purpose | Operations |",
      "|--------|---------|------------|",
      "| **account** | Asset, expense, revenue and liability accounts | get, list |",
      "",
      "All 2 operations across 1 entities.",
    ].join("\n");
    const m = model([op("account", "get"), op("account", "list"), op("account", "delete", "destructive")]);
    const { text: next, changed } = renderIndex(text, m as never);

    expect(changed).toBe(true);
    expect(next).toContain("| **account** | Asset, expense, revenue and liability accounts | delete, get, list |");
    expect(next).toContain("All 3 operations across 1 entities.");
  });

  it("is a no-op once the page already matches the model", () => {
    const m = model([op("account", "get")]);
    const first = renderIndex(
      ["| Entity | Purpose | Operations |", "|---|---|---|", "| **account** | x | old |", "", "0 operations across 0 entities"].join("\n"),
      m as never,
    );
    const second = renderIndex(first.text, m as never);
    expect(second.changed).toBe(false);
    expect(second.text).toBe(first.text);
  });

  it("leaves prose outside the table and the count sentence alone", () => {
    // The purpose column comes from render.mjs's own ENTITY_ROWS constant, not
    // from whatever the page currently says — so this checks the one kind of
    // prose the renderer genuinely cannot touch: an unrelated paragraph below
    // the table that is not the count sentence.
    const text = [
      "| Entity | Purpose | Operations |",
      "|---|---|---|",
      "| **account** | old purpose | old |",
      "",
      "Some unrelated paragraph mentioning 42 apples, not operations.",
    ].join("\n");
    const { text: next } = renderIndex(text, model([op("account", "get")]) as never);
    expect(next).toContain("42 apples"); // untouched: not followed by "operations"
  });

  it("replaces a page's purpose column with the authored one from ENTITY_ROWS", () => {
    // Documents the actual contract: the purpose lives in render.mjs, keyed by
    // entity name, not in the page. A page written with a stale or placeholder
    // purpose is corrected to what the source of truth in this file says.
    const text = ["| Entity | Purpose | Operations |", "|---|---|---|", "| **account** | placeholder | old |"].join("\n");
    const { text: next } = renderIndex(text, model([op("account", "get")]) as never);
    expect(next).toContain("| **account** | Asset, expense, revenue and liability accounts | get |");
    expect(next).not.toContain("placeholder");
  });

  it("leaves a parenthetical entity-specific count alone", () => {
    const text = "the largest entity (13 operations) and 40 operations overall";
    const { text: next } = renderIndex(text, model(Array.from({ length: 7 }, (_, i) => op("x", `op${i}`))) as never);
    expect(next).toContain("(13 operations)"); // parenthetical count is untouched
    expect(next).toContain("7 operations overall");
  });
});

describe("renderOperationsPage", () => {
  it("rewrites the Count/Operations table", () => {
    const text = ["| Entity | Count | Operations |", "|---|---|---|", "| `account` | 1 | get |"].join("\n");
    const { text: next } = renderOperationsPage(text, model([op("account", "get"), op("account", "list")]) as never);
    expect(next).toContain("| `account` | 2 | get, list |");
  });
});

describe("renderCountOnly", () => {
  it("rewrites the Turkish count sentence too", () => {
    const text = "Toplam 3 operasyon mevcuttur.";
    const { text: next } = renderCountOnly(text, model([op("a", "x"), op("a", "y")]) as never);
    expect(next).toBe("Toplam 2 operasyon mevcuttur.");
  });

  it("does not invent a table where the page has none", () => {
    const text = "Just prose, 5 operations mentioned once.";
    const { text: next, changed } = renderCountOnly(text, model([op("a", "x")]) as never);
    expect(changed).toBe(true);
    expect(next).toBe("Just prose, 1 operations mentioned once.");
    expect(next).not.toContain("|");
  });
});

describe("ENTITY_ROWS ordering", () => {
  it("keeps a stable, sorted position for an entity the source no longer declares purpose for", () => {
    // A brand-new entity with no authored purpose yet must still render
    // deterministically, sorted after the known ones, not wherever the
    // registry happened to enumerate it.
    const m = model([op("zzz_new_entity", "list"), op("account", "get")]);
    const { text } = renderIndex(
      ["| Entity | Purpose | Operations |", "|---|---|---|", "", "0 operations across 0 entities"].join("\n"),
      m as never,
    );
    const lines: string[] = text.split("\n");
    const accountLine = lines.findIndex((l: string) => l.includes("**account**"));
    const newLine = lines.findIndex((l: string) => l.includes("**zzz_new_entity**"));
    expect(accountLine).toBeGreaterThan(-1);
    expect(newLine).toBeGreaterThan(accountLine);
  });
});

describe("planEdits", () => {
  it("skips a doc file that does not exist rather than throwing", () => {
    const m = model([op("account", "get")], { docFiles: ["docs/does-not-exist.md"] });
    expect(planEdits(m as never)).toEqual([]);
  });
});
