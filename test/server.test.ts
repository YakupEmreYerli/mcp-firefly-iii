import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
  permissions: { fallback: "destructive", byEntity: new Map() },
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

/** A module covering all three access levels, so direct-mode annotations have
 * something to be right or wrong about. Kept separate from `module` so the
 * tool-name expectations elsewhere in this file stay untouched. */
const accessModule: EntityModule = {
  entity: EntityType.Transaction,
  hint: "one of each access level",
  operations: {
    list: defineOperation({
      description: "Which transactions are there?",
      access: "read",
      input: z.object({}).strict(),
      handler: (_params, api) => api.get("/transactions"),
    }),
    create: defineOperation({
      description: "Create a transaction.",
      access: "write",
      input: z.object({}).strict(),
      handler: (_params, api) => api.post("/transactions", {}),
    }),
    delete: defineOperation({
      description: "Delete a transaction.",
      access: "destructive",
      input: z.object({}).strict(),
      handler: (_params, api) => api.del("/transactions/1"),
    }),
  },
};

/** Tool annotations as the client receives them, keyed by tool name. */
async function toolAnnotations(overrides: Partial<Config> = {}): Promise<Record<string, unknown>> {
  const registry = new Registry({ ...config, ...overrides }, client);
  registry.register(module);
  registry.register(accessModule);
  const server = createServer(registry, { ...config, ...overrides });
  const mcpClient = new Client({ name: "test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
  try {
    const { tools } = await mcpClient.listTools();
    return Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));
  } finally {
    await mcpClient.close();
    await server.close();
  }
}

describe("tool annotations", () => {
  it("marks the two catalogue tools read-only", async () => {
    const annotations = await toolAnnotations();
    expect(annotations.firefly_list_operations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(annotations.firefly_get_schema).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });

  it("annotates each execution surface with the risk it actually carries", async () => {
    const annotations = await toolAnnotations();
    expect(annotations.firefly_query).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(annotations.firefly_mutate).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(annotations.firefly_destructive).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it("annotates each direct-mode tool from its own access level", async () => {
    const annotations = await toolAnnotations({ directMode: true });
    expect(annotations.transaction_list).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });

  it("flags a delete as destructive and idempotent, and a create as neither", async () => {
    const annotations = await toolAnnotations({ directMode: true });
    expect(annotations.transaction_delete).toMatchObject({ destructiveHint: true, idempotentHint: true });
    // Repeating a create makes a second transaction, so it must not claim to
    // be idempotent — that is the hint a host would use to retry safely.
    expect(annotations.transaction_create).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(annotations.transaction_create).not.toHaveProperty("idempotentHint");
  });

  it("tells hosts Firefly is a remote service", async () => {
    const annotations = await toolAnnotations();
    expect(annotations.firefly_query).toMatchObject({ openWorldHint: true });
  });
});

describe("server identity", () => {
  it("introduces itself with the published package version, not a second copy", async () => {
    // It shipped as 0.1.0 through three releases because the version was
    // written down twice. Bind it to the manifest so it cannot drift again.
    const manifest: unknown = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    );
    const expected = (manifest as { version: string }).version;

    const server = createServer(makeRegistry(), config);
    const mcpClient = new Client({ name: "test", version: "0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
    try {
      expect(mcpClient.getServerVersion()?.version).toBe(expected);
    } finally {
      await mcpClient.close();
      await server.close();
    }
  });
});

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

describe("the meta-tools", () => {
  it("splits execution by risk instead of offering one tool that can do anything", async () => {
    expect(await registeredToolNames()).toEqual([
      "firefly_destructive",
      "firefly_get_schema",
      "firefly_list_operations",
      "firefly_mutate",
      "firefly_query",
    ]);
  });

  it("does not offer a writing surface that could only refuse, in read-only mode", async () => {
    expect(await registeredToolNames({ readOnly: true })).toEqual([
      "firefly_get_schema",
      "firefly_list_operations",
      "firefly_query",
    ]);
  });
});

describe("access surfaces are enforced, not merely advertised", () => {
  function accessRegistry(overrides: Partial<Config> = {}): Registry {
    const registry = new Registry({ ...config, ...overrides }, client);
    registry.register(accessModule);
    return registry;
  }

  it("refuses a delete reached through the read-only surface", async () => {
    // Without this the destructiveHint on firefly_query would be a claim the
    // server does not keep.
    await expect(
      accessRegistry().execute("transaction", "delete", {}, undefined, ["read"]),
    ).rejects.toThrow(/cannot be called through this tool/);
  });

  it("refuses a delete reached through the ordinary write surface", async () => {
    await expect(
      accessRegistry().execute("transaction", "create", {}, undefined, ["destructive"]),
    ).rejects.toThrow(/cannot be called through this tool/);
  });

  it("names the surface that would have worked", async () => {
    await expect(
      accessRegistry().execute("transaction", "delete", {}, undefined, ["write"]),
    ).rejects.toThrow(/firefly_destructive/);
  });

  it("still runs an operation reached through its own surface", async () => {
    await expect(
      accessRegistry().execute("transaction", "list", {}, undefined, ["read"]),
    ).resolves.toBeDefined();
  });

  it("leaves an unrestricted call alone, which is how direct mode runs", async () => {
    await expect(accessRegistry().execute("transaction", "delete", {})).resolves.toBeDefined();
  });

  it("reports read-only mode rather than the wrong surface, when both apply", async () => {
    // The more useful complaint is the one the caller can act on: no surface
    // would have worked here.
    await expect(
      accessRegistry({ readOnly: true }).execute("transaction", "delete", {}, undefined, ["destructive"]),
    ).rejects.toThrow(/FIREFLY_READ_ONLY/);
  });
});

describe("each surface carries only its own catalogue", () => {
  const registry = (): Registry => {
    const result = new Registry(config, client);
    result.register(accessModule);
    return result;
  };

  it("keeps writes out of the read-only surface's catalogue", () => {
    const text = executeDescription(registry(), { tool: "firefly_query", access: ["read"], summary: "s", hints: true });
    expect(text).toContain("list");
    expect(text).not.toContain("delete");
  });

  it("keeps deletes out of the ordinary write surface's catalogue", () => {
    const text = executeDescription(registry(), { tool: "firefly_mutate", access: ["write"], summary: "s", hints: false });
    expect(text).toContain("create");
    expect(text).not.toContain("delete");
  });

  it("repeats the entity hints only on the reading surface, where they guide the choice", () => {
    // Repeating them on all three measured at +55% over the single catalogue;
    // by the time a caller is deleting, the entity is already settled.
    const read = executeDescription(registry(), { tool: "firefly_query", access: ["read"], summary: "s", hints: true });
    const write = executeDescription(registry(), { tool: "firefly_mutate", access: ["write"], summary: "s", hints: false });
    expect(read).toContain("one of each access level");
    expect(write).not.toContain("one of each access level");
  });

  it("drops an entity that has nothing at this level instead of listing it empty", () => {
    const result = new Registry(config, client);
    result.register(module); // read-only fake module
    const text = executeDescription(result, { tool: "firefly_destructive", access: ["destructive"], summary: "s", hints: false });
    expect(text).not.toContain("insight");
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
