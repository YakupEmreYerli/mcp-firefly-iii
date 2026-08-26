import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Registry, defineOperation, type EntityModule } from "../src/registry.js";
import { createServer, executeDescription } from "../src/server.js";
import { EntityType } from "../src/types.js";
import type { Config } from "../src/config.js";
import type { FireflyClient } from "../src/firefly.js";

const client: FireflyClient = {
  postBinary: vi.fn(async () => null),
  getText: vi.fn(async () => ""),
  get: vi.fn(async () => ({ data: [] })),
  post: vi.fn(async () => ({ data: {} })),
  put: vi.fn(async () => ({ data: {} })),
  del: vi.fn(async () => null),
};

const config: Config = {
  apiUrl: "https://firefly.example/api/v1",
  apiToken: "token",
  readOnly: false,
  directMode: false,
  enabledEntities: new Set(Object.values(EntityType)),
  disableSslVerify: false,
  logLevel: "INFO",
};

const module: EntityModule = {
  entity: EntityType.Insight,
  hint: "spending and income totals per period",
  operations: {
    expense_total: defineOperation({
      description: "How much was spent in total during the period?",
      access: "read",
      input: z.object({ start: z.string() }).strict(),
      handler: (params, api) => api.get("/insight/expense/total", { start: params.start }),
    }),
  },
};

function makeRegistry(): Registry {
  const registry = new Registry(config, client);
  registry.register(module);
  return registry;
}

/** Ask the running server for its tool list over the SDK's own client, rather
 * than reaching into McpServer's private tool map. */
async function registeredToolNames(overrides: Partial<Config> = {}): Promise<string[]> {
  const server = createServer(makeRegistry(), { ...config, ...overrides });
  const mcpClient = new Client({ name: "test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
  try {
    const { tools } = await mcpClient.listTools();
    return tools.map((tool) => tool.name).sort();
  } finally {
    await mcpClient.close();
    await server.close();
  }
}

describe("executeDescription", () => {
  it("embeds the operation catalogue so the model can choose without an extra call", () => {
    expect(executeDescription(makeRegistry())).toContain(
      "insight: expense_total — spending and income totals per period",
    );
  });

  it("tells the model that fields trims the response", () => {
    expect(executeDescription(makeRegistry())).toContain("fields");
  });
});

describe("the three meta-tools", () => {
  it("registers exactly the names the migration promises to keep", async () => {
    expect(await registeredToolNames()).toEqual([
      "firefly_execute",
      "firefly_get_schema",
      "firefly_list_operations",
    ]);
  });
});

describe("direct mode", () => {
  it("replaces the meta-tools rather than supplementing them", async () => {
    expect(await registeredToolNames({ directMode: true })).toEqual(["insight_expense_total"]);
  });

  it("hides write operations, as the catalogue does", async () => {
    const readOnly = { ...config, readOnly: true, directMode: true };
    const registry = new Registry(readOnly, client);
    registry.register(module);
    registry.register({
      entity: EntityType.Account,
      hint: "accounts",
      operations: {
        create: defineOperation({
          description: "Create a new account.",
          access: "write",
          input: z.object({ name: z.string() }).strict(),
          handler: async () => ({ data: {} }),
        }),
      },
    });

    const server = createServer(registry, readOnly);
    const mcpClient = new Client({ name: "test", version: "0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
    try {
      const names = (await mcpClient.listTools()).tools.map((tool) => tool.name);
      expect(names).toEqual(["insight_expense_total"]);
    } finally {
      await mcpClient.close();
      await server.close();
    }
  });
});

describe("direct mode", () => {
  async function callDirectTool(name: string, args: Record<string, unknown>) {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import(
      "@modelcontextprotocol/sdk/inMemory.js"
    );
    const { createClient } = await import("../src/firefly.js");
    const { transactionsModule } = await import("../src/entities/transactions.js");

    const directConfig: Config = { ...config, directMode: true };
    const registry = new Registry(directConfig, client);
    registry.register(transactionsModule);
    const server = createServer(registry, directConfig);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

    const tools = await mcpClient.listTools();
    const result = await mcpClient.callTool({ name, arguments: args });
    await mcpClient.close();
    return { tools, result };
  }

  it("advertises each parameter rather than one opaque params object", async () => {
    const { tools } = await callDirectTool("transaction_get", { id: "7" });
    const tool = tools.tools.find((candidate) => candidate.name === "transaction_get");

    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(["id"]);
  });

  it("refuses an unknown key instead of silently dropping it", async () => {
    const { result } = await callDirectTool("transaction_list", { nonsense: "x" });

    expect(JSON.stringify(result)).toMatch(/nonsense|unrecognized/i);
  });
});
