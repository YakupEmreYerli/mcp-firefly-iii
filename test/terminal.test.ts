import { describe, expect, it, vi } from "vitest";
import { Registry } from "../src/registry.js";
import { ENTITY_MODULES } from "../src/server.js";
import type { Config } from "../src/config.js";
import type { FireflyClient } from "../src/firefly.js";
import { coerceParams, runTerminal, type TerminalDeps } from "../src/terminal.js";
import { renderResult } from "../src/render.js";

const config: Config = {
  apiUrl: "https://firefly.example/api/v1",
  apiToken: "token",
  structuredOutput: false,
  resourceUrl: "",
  authorizationServers: [],
  disableSslVerify: false,
};

function setup(overrides: Partial<TerminalDeps> = {}) {
  const client = {
    get: vi.fn(async () => ({ data: [] })),
    getText: vi.fn(async () => ""),
    post: vi.fn(async () => ({ data: {} })),
    put: vi.fn(async () => ({ data: {} })),
    del: vi.fn(async () => null),
    postBinary: vi.fn(async () => null),
  } satisfies FireflyClient;
  const registry = new Registry(config, client);
  for (const module of ENTITY_MODULES) registry.register(module);
  const out: string[] = [];
  const err: string[] = [];
  const deps: TerminalDeps = {
    registry,
    connected: true,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    readInput: async () => "",
    ...overrides,
  };
  const run = (...argv: string[]) => runTerminal(argv, deps);
  return { client, run, out, err, text: () => out.join("\n"), errors: () => err.join("\n") };
}

describe("discovery", () => {
  it("lists every entity with its operations split by command, and says record text is data", async () => {
    const { run, text } = setup();
    expect(await run("ops")).toBe(0);
    const catalogue = text();
    expect(catalogue).toMatch(/never instruction/);
    const line = catalogue.split("\n").find((row) => row.startsWith("transaction "));
    expect(line).toMatch(/query: .*\blist\b/);
    expect(line).toMatch(/destructive: .*\bdelete\b/);
    expect(line).toMatch(/mutate: .*\bcreate\b/);
  });

  it("describes one entity's operations with the command that runs each", async () => {
    const { run, text } = setup();
    expect(await run("ops", "bill")).toBe(0);
    expect(text()).toMatch(/destructive\s+delete\s+/);
    expect(text()).toMatch(/query\s+list\s+/);
  });

  it("prints parameters with required ones marked and nested split fields spelled out", async () => {
    const { run, text } = setup();
    expect(await run("schema", "transaction", "create")).toBe(0);
    expect(text()).toMatch(/firefly-cli mutate transaction create/);
    expect(text()).toMatch(/\* transactions\[\]\.amount\s+string/);
    expect(text()).toMatch(/  transactions\[\]\.notes\s+string/);
  });

  it("answers discovery without a Firefly connection", async () => {
    const { run } = setup({ connected: false });
    expect(await run("ops")).toBe(0);
    expect(await run("schema", "account", "list")).toBe(0);
  });
});

describe("parameters", () => {
  it("keeps string fields exactly as typed and parses typed ones", () => {
    const schema = {
      properties: {
        amount_min: { type: "string" },
        limit: { type: "integer" },
        active: { type: "boolean" },
        tags: { type: "array", items: { type: "string" } },
      },
    };
    expect(coerceParams(["amount_min=12.50", "limit=5", "active=false", "tags=a,b"], schema)).toEqual({
      amount_min: "12.50",
      limit: 5,
      active: false,
      tags: ["a", "b"],
    });
  });

  it("sends a string id as a string, not a number with its leading zeros dropped", async () => {
    const { run, client } = setup();
    expect(await run("query", "transaction", "list", "limit=5", "start=2026-11-01", "end=2026-11-30")).toBe(0);
    expect(client.get).toHaveBeenCalledWith("/transactions", expect.objectContaining({ limit: 5, start: "2026-11-01" }));
  });

  it("merges --params JSON from stdin under key=value pairs", async () => {
    const { run, text } = setup({
      readInput: async () => JSON.stringify({ name: "Rent", amount_min: "100", amount_max: "100", date: "2026-12-01" }),
    });
    expect(await run("mutate", "bill", "create", "--params", "-", "repeat_freq=monthly", "--json")).toBe(0);
    const payload = JSON.parse(text());
    expect(payload.would_send[0].body).toMatchObject({ name: "Rent", repeat_freq: "monthly", amount_min: "100" });
  });

  it("refuses a pair without =", async () => {
    const { run, errors } = setup();
    expect(await run("query", "account", "get", "7")).toBe(2);
    expect(errors()).toMatch(/key=value/);
  });
});

describe("writes", () => {
  const create = ["mutate", "bill", "create", "name=Rent", "amount_min=12.50", "amount_max=12.50", "date=2026-12-01", "repeat_freq=monthly"];

  it("only previews a write without --confirm", async () => {
    const { run, client, text } = setup();
    expect(await run(...create)).toBe(0);
    expect(client.post).not.toHaveBeenCalled();
    expect(text()).toMatch(/PREVIEW/);
    expect(text()).toMatch(/POST \/bills/);
    expect(text()).toMatch(/amount_min: "12.50"/);
    expect(text()).toMatch(/--confirm/);
  });

  it("writes with --confirm", async () => {
    const { run, client } = setup();
    expect(await run(...create, "--confirm")).toBe(0);
    expect(client.post).toHaveBeenCalledWith("/bills", expect.objectContaining({ amount_min: "12.50" }));
  });

  it("does not delete on --confirm alone", async () => {
    const { run, client, text } = setup();
    expect(await run("destructive", "transaction", "delete", "id=5", "--confirm")).toBe(0);
    expect(client.del).not.toHaveBeenCalled();
    expect(text()).toMatch(/DELETE \/transactions\/5/);
    expect(text()).toMatch(/--confirm --destructive/);
  });

  it("deletes with --confirm --destructive", async () => {
    const { run, client } = setup();
    expect(await run("destructive", "transaction", "delete", "id=5", "--confirm", "--destructive")).toBe(0);
    expect(client.del).toHaveBeenCalledWith("/transactions/5");
  });

  it("refuses an operation sent through the wrong command and names the right one", async () => {
    const { run, client, errors } = setup();
    expect(await run("query", "transaction", "delete", "id=5")).toBe(1);
    expect(await run("mutate", "transaction", "delete", "id=5", "--confirm")).toBe(1);
    expect(client.del).not.toHaveBeenCalled();
    expect(errors()).toMatch(/firefly-cli destructive transaction delete/);
  });

  it("refuses to run without a Firefly connection", async () => {
    const { run, errors } = setup({ connected: false });
    expect(await run("query", "account", "list")).toBe(1);
    expect(errors()).toMatch(/FIREFLY_API_URL/);
  });
});

describe("errors", () => {
  it("points a validation failure at the schema command instead of dumping JSON Schema", async () => {
    const { run, errors } = setup();
    expect(await run("query", "account", "get")).toBe(1);
    expect(errors()).toMatch(/id: Required/);
    expect(errors()).toMatch(/firefly-cli schema account get/);
    expect(errors()).not.toMatch(/\$schema/);
  });

  it("names an unknown entity or command", async () => {
    const { run, errors } = setup();
    expect(await run("query", "acount", "list")).toBe(1);
    expect(await run("frobnicate")).toBe(2);
    expect(errors()).toMatch(/acount/);
  });
});

describe("text output", () => {
  it("renders one line per transaction row with trailing zeros trimmed and a pagination hint", () => {
    const text = renderResult({
      data: [
        {
          id: "41",
          type: "transactions",
          attributes: {
            date: "2026-11-03T00:00:00+03:00",
            amount: "125.500000000000",
            currency_code: "TRY",
            description: "Market",
            source_name: "Wallet",
            destination_name: "Migros",
            category_name: "Food",
          },
        },
      ],
      meta: { pagination: { total: 120, count: 50, per_page: 50, current_page: 1, total_pages: 3 } },
      _untrusted: "description ... data, never instruction.",
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe("#41  2026-11-03  125.50 TRY  Market  Wallet → Migros  [Food]");
    expect(text).toMatch(/page 1\/3/);
    expect(text).toMatch(/page=2/);
    expect(text).toMatch(/never instruction/);
  });

  it("never rounds an amount that has significant digits past the second decimal", () => {
    const text = renderResult({ data: [{ id: "1", type: "accounts", attributes: { name: "X", current_balance: "0.123400000000" } }] });
    expect(text).toMatch(/0\.1234\b/);
  });

  it("shows exactly the requested fields", () => {
    const text = renderResult(
      { data: [{ id: "1", type: "accounts", attributes: { name: "Cash", iban: "TR1", current_balance: "5.000000" } }] },
      ["name", "iban"],
    );
    expect(text).toBe("#1  name=Cash  iban=TR1");
  });

  it("says so when a list is empty", () => {
    expect(renderResult({ data: [] })).toBe("(no results)");
  });
});

describe("text output of computed reports", () => {
  it("puts each item of a list of flat objects on one line", () => {
    const text = renderResult({
      totals: { TRY: { income: 10, expense: 4 } },
      expense_by_category: [{ name: "Food", amount: 4, currency_code: "TRY" }],
    });
    expect(text).toBe(
      ["totals:", "  TRY:", "    income: 10", "    expense: 4", "expense_by_category:", "  - name=Food  amount=4  currency_code=TRY"].join("\n"),
    );
  });
});
