import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Registry } from "../src/registry.js";
import { ENTITY_MODULES, createServer } from "../src/server.js";
import { monthRange, previousMonth } from "../src/prompts.js";
import type { Access } from "../src/types.js";
import type { Config } from "../src/config.js";
import type { FireflyClient } from "../src/firefly.js";

const config: Config = {
  apiUrl: "https://firefly.example/api/v1",
  apiToken: "token",
  structuredOutput: false,
  resourceUrl: "",
  authorizationServers: [],
  disableSslVerify: false,
};

function realRegistry(granted?: ReadonlySet<Access>): Registry {
  const registry = new Registry(config, {} as FireflyClient, granted);
  for (const module of ENTITY_MODULES) registry.register(module);
  return registry;
}

async function withClient<T>(registry: Registry, run: (client: Client) => Promise<T>): Promise<T> {
  const server = createServer(registry, config);
  const client = new Client({ name: "test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

async function promptText(name: string, args: Record<string, string> = {}): Promise<string> {
  return withClient(realRegistry(), async (client) => {
    const result = await client.getPrompt({ name, arguments: args });
    const content = result.messages[0]!.content;
    if (content.type !== "text") throw new Error("expected a text prompt");
    return content.text;
  });
}

describe("monthRange", () => {
  it("ends on the month's real last day", () => {
    expect(monthRange("2028-02")).toEqual({ month: "2028-02", start: "2028-02-01", end: "2028-02-29" });
    expect(monthRange("2026-02")).toEqual({ month: "2026-02", start: "2026-02-01", end: "2026-02-28" });
    expect(monthRange("2026-12")).toEqual({ month: "2026-12", start: "2026-12-01", end: "2026-12-31" });
  });

  it("defaults to last month, across a year boundary", () => {
    expect(monthRange(undefined, "2026-01-10")).toEqual({ month: "2025-12", start: "2025-12-01", end: "2025-12-31" });
  });

  it("refuses anything but YYYY-MM", () => {
    expect(() => monthRange("2026-13")).toThrow();
    expect(() => monthRange("October")).toThrow();
  });
});

describe("previousMonth", () => {
  it("steps back over January", () => {
    expect(previousMonth("2026-01")).toBe("2025-12");
    expect(previousMonth("2026-10")).toBe("2026-09");
  });
});

describe("prompts", () => {
  it("are all offered to a connection that can write", async () => {
    const names = await withClient(realRegistry(), async (client) =>
      (await client.listPrompts()).prompts.map((prompt) => prompt.name).sort(),
    );
    expect(names).toEqual(["budget_summary", "categorise_uncategorised", "month_end_review"]);
  });

  it("that end in a write are hidden from a read-only connection", async () => {
    // Offering a workflow whose last step is a tool this connection does not
    // have sends the model down the same dead end as an empty tool would.
    const names = await withClient(realRegistry(new Set<Access>(["read"])), async (client) =>
      (await client.listPrompts()).prompts.map((prompt) => prompt.name),
    );
    expect(names).toEqual(["budget_summary"]);
  });

  it("fill in the month's dates rather than leaving them to the model", async () => {
    const text = await promptText("month_end_review", { month: "2028-02" });
    expect(text).toContain('"start": "2028-02-01", "end": "2028-02-29"');

    const summary = await promptText("budget_summary", { month: "2026-01" });
    expect(summary).toContain('"baseline_start": "2025-12-01", "baseline_end": "2025-12-31"');
  });

  it("preview before writing and cap filter-driven writes", async () => {
    for (const name of ["month_end_review", "categorise_uncategorised"]) {
      const text = await promptText(name, { month: "2026-10" });
      expect(text, name).toContain('"dry_run": true');
      expect(text, name).toContain("max_matches");
      expect(text, name).toMatch(/wait for my (explicit yes|confirmation)/);
    }
  });

  it("reject a malformed month", async () => {
    await expect(promptText("budget_summary", { month: "10/2026" })).rejects.toThrow();
  });

  /** A prompt names operations as plain text, which no compiler checks. A
   * renamed operation or one moved to another surface would leave a prompt
   * that sends the model to a call the server refuses. */
  it("only name operations that exist, through the tool that serves them", async () => {
    const operations = new Map(realRegistry().listOperations().map((op) => [op.name, op.access]));
    const surface: Record<string, Access> = {
      firefly_query: "read",
      firefly_mutate: "write",
      firefly_destructive: "destructive",
    };
    for (const name of ["month_end_review", "categorise_uncategorised", "budget_summary"]) {
      const text = await promptText(name, { month: "2026-10" });
      const named = [...text.matchAll(/entity "([a-z_]+)", operation "([a-z_]+)"/g)];
      expect(named.length, name).toBeGreaterThan(0);
      for (const [, entity, operation] of named) {
        expect(operations.has(`${entity}.${operation}`), `${name}: ${entity}.${operation}`).toBe(true);
      }
      for (const [, tool, entity, operation] of text.matchAll(
        /(firefly_[a-z]+)(?: with|:) entity "([a-z_]+)", operation "([a-z_]+)"/g,
      )) {
        expect(operations.get(`${entity}.${operation}`), `${name}: ${tool} ${entity}.${operation}`).toBe(surface[tool!]);
      }
      for (const [, reference] of text.matchAll(/`([a-z_]+\.[a-z_]+)`/g)) {
        expect(operations.has(reference!), `${name}: ${reference}`).toBe(true);
      }
    }
  });
});
