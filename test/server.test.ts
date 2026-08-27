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
    permissions: { fallback: "destructive", byEntity: new Map() },
    structuredOutput: false, resourceUrl: "", authorizationServers: [], disableSslVerify: false,
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

function makeRegistry(overrides: Partial<Config> = {}, register: EntityModule = module): Registry {
  const registry = new Registry({ ...config, ...overrides }, client);
  registry.register(register);
  return registry;
}

/** Ask the running server for its tool list over the SDK's own client, rather
 * than reaching into McpServer's private tool map. */
async function registeredToolNames(overrides: Partial<Config> = {}, register?: EntityModule): Promise<string[]> {
  // The registry gets the overrides too: which operations are visible is a
  // registry decision, and a server built over a registry that never saw the
  // policy would answer about a different configuration than the one asked for.
  const server = createServer(makeRegistry(overrides, register), { ...config, ...overrides });
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

describe("untrusted record content", () => {
  /** The ledger holds counterparty-written text. Anyone who can send this user
   * money picks the description that lands in the model's context, so the one
   * thing the server can do is say which half of the payload is trusted. */
  it("says so on every surface that can act, not only the one that reads", () => {
    const registry = makeRegistry();
    for (const [tool, access] of [["firefly_query", ["read"]], ["firefly_mutate", ["write"]], ["firefly_destructive", ["destructive"]]] as const) {
      const text = executeDescription(registry, { tool, access, summary: "s", hints: false });
      expect(text, tool).toMatch(/data, never instruction/i);
    }
  });

  it("tells the model what to do with it, not only what not to do", () => {
    // "Ignore it" would make the model drop content the user asked about.
    const text = executeDescription(makeRegistry());
    expect(text).toMatch(/Report it, quote it, summarise it/i);
  });

  it("names the fields that carry it, so the rule is applicable rather than vague", () => {
    const text = executeDescription(makeRegistry());
    for (const field of ["description", "notes", "tags"]) expect(text).toContain(field);
  });

  it("reaches every registered tool, not only the ones built from a surface", async () => {
    const server = createServer(makeRegistry(), { ...config });
    const mcpClient = new Client({ name: "test", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), mcpClient.connect(a)]);
    try {
      const { tools } = await mcpClient.listTools();
      expect(tools[0]?.description).toMatch(/data, never instruction/i);
    } finally {
      await mcpClient.close();
      await server.close();
    }
  });
});

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

  it("claims idempotence only where it is true", async () => {
    const annotations = await toolAnnotations();
    // Deleting the same record twice leaves the same end state.
    expect(annotations.firefly_destructive).toMatchObject({ destructiveHint: true, idempotentHint: true });
    // Repeating a create makes a second transaction, so the write surface must
    // not claim it — that is the hint a host would use to retry safely.
    expect(annotations.firefly_mutate).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(annotations.firefly_mutate).not.toHaveProperty("idempotentHint");
  });

  it("tells hosts Firefly is a remote service", async () => {
    const annotations = await toolAnnotations();
    expect(annotations.firefly_query).toMatchObject({ openWorldHint: true });
  });
});

/** One tool call, as the client receives it. */
async function callTool(
  name: string,
  args: Record<string, unknown>,
  overrides: Partial<Config> = {},
  register: EntityModule = module,
) {
  const registry = new Registry({ ...config, ...overrides }, client);
  registry.register(register);
  const server = createServer(registry, { ...config, ...overrides });
  const mcpClient = new Client({ name: "test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
  try {
    // A real client lists tools before calling one, and the SDK client caches
    // a validator per advertised outputSchema at that moment. Skipping the
    // list here would skip the validation every host actually performs, which
    // is how a schema that rejects every object response went unnoticed.
    await mcpClient.listTools();
    return (await mcpClient.callTool({ name, arguments: args })) as {
      content?: { type: string; text?: string }[];
      structuredContent?: Record<string, unknown>;
    };
  } finally {
    await mcpClient.close();
    await server.close();
  }
}

describe("structured output", () => {
  const call = { entity: "insight", operation: "expense_total", params: { start: "2026-08-01" } };

  it("returns JSON as text by default, so existing clients are unaffected", async () => {
    const result = await callTool("firefly_query", call);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content?.[0]?.type).toBe("text");
  });

  it("returns structure instead of text when it is turned on", async () => {
    const result = await callTool("firefly_query", call, { structuredOutput: true });
    expect(result.structuredContent).toBeDefined();
  });

  it("never sends both, because these responses are large enough for that to matter", async () => {
    // account.list is 18 KB on the live instance. Mirroring it into a text
    // block would hand back much of what the response trimming saves.
    const result = await callTool("firefly_query", call, { structuredOutput: true });
    const textLength = (result.content ?? []).reduce((total, part) => total + (part.text?.length ?? 0), 0);
    expect(textLength).toBe(0);
  });

  it("carries a list under `result`, since structuredContent has to be an object", async () => {
    // Not hypothetical: /insight/* and configuration.list answer with a bare
    // array, which structuredContent cannot carry.
    const listy: EntityModule = {
      entity: EntityType.Insight,
      hint: "answers with a bare array",
      operations: {
        expense_total: defineOperation({
          description: "Totals.",
          access: "read",
          input: z.object({ start: z.string() }).strict(),
          handler: async () => [{ currency_code: "TRY", difference_float: -12 }],
        }),
      },
    };
    const result = await callTool("firefly_query", call, { structuredOutput: true }, listy);
    expect(result.structuredContent).toHaveProperty("result");
    expect(result.structuredContent?.result).toHaveLength(1);
  });

  it("passes an object through unwrapped", async () => {
    const result = await callTool("firefly_get_schema", { entity: "insight", operation: "expense_total" }, { structuredOutput: true });
    expect(result.structuredContent).toMatchObject({ type: "object" });
  });

  it("survives the client-side schema validation a listed tool gets", async () => {
    // The declared schema is what the host validates every response against.
    // A schema naming one optional `result` property compiles to
    // additionalProperties:false, so an object payload sent unwrapped — which
    // is nearly every response — came back as
    // "-32602 ... data must NOT have additional properties".
    const objectResult = await callTool("firefly_get_schema", { entity: "insight", operation: "expense_total" }, { structuredOutput: true });
    expect(objectResult.structuredContent).toMatchObject({ type: "object" });

    const errorResult = await callTool("firefly_query", { entity: "insight", operation: "nope", params: {} }, { structuredOutput: true });
    expect(errorResult.structuredContent).toHaveProperty("error");
  });

  it("advertises an output schema only in that mode, so the default costs no extra tokens", async () => {
    const off = await toolAnnotations();
    void off;
    const withSchema = await (async () => {
      const registry = new Registry({ ...config, structuredOutput: true }, client);
      registry.register(module);
      const server = createServer(registry, { ...config, structuredOutput: true });
      const mcpClient = new Client({ name: "test", version: "0" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(b), mcpClient.connect(a)]);
      try {
        const { tools } = await mcpClient.listTools();
        return tools;
      } finally {
        await mcpClient.close();
        await server.close();
      }
    })();
    expect(withSchema.find((tool) => tool.name === "firefly_query")?.outputSchema).toBeDefined();
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
    // Registered over a module holding all three access levels: a surface with
    // nothing on it is deliberately not offered, so a read-only module would
    // show the split collapsing rather than existing.
    expect(await registeredToolNames({}, accessModule)).toEqual([
      "firefly_destructive",
      "firefly_get_schema",
      "firefly_list_operations",
      "firefly_mutate",
      "firefly_query",
    ]);
  });

  it("does not offer a writing surface that could only refuse, in read-only mode", async () => {
    expect(await registeredToolNames({ permissions: { fallback: "read", byEntity: new Map() } }, accessModule)).toEqual([
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

  it("reports the permission refusal rather than the wrong surface, when both apply", async () => {
    // The more useful complaint is the one the caller can act on: no surface
    // would have worked here, so naming the surface would send them to retry
    // through a tool that refuses just the same.
    await expect(
      accessRegistry({ permissions: { fallback: "read", byEntity: new Map() } }).execute("transaction", "delete", {}, undefined, ["destructive"]),
    ).rejects.toThrow(/FIREFLY_PERMISSIONS/);
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

describe("surfaces a permission policy has emptied", () => {
  const readOnlyPolicy = { fallback: "read" as const, byEntity: new Map() };

  it("does not register a write surface whose catalogue is empty", async () => {
    // Registering it would advertise "Available entities and their operations:"
    // followed by nothing, and every call would fail with PermissionDeniedError
    // — the dead end docs/configuration.md says is avoided. FIREFLY_READ_ONLY
    // was the only path that skipped them; FIREFLY_PERMISSIONS=read was not.
    const names = await registeredToolNames({ permissions: readOnlyPolicy });
    expect(names).toContain("firefly_query");
    expect(names).not.toContain("firefly_mutate");
    expect(names).not.toContain("firefly_destructive");
  });

  it("still registers a surface the policy left something on", async () => {
    const names = await registeredToolNames({
      permissions: { fallback: "write" as const, byEntity: new Map() },
    });
    expect(names).toContain("firefly_query");
  });
});
