import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Registry, defineOperation, type EntityModule } from "../src/registry.js";
import { EntityType } from "../src/types.js";
import type { Config } from "../src/config.js";
import type { FireflyClient } from "../src/firefly.js";
import { ReadOnlyModeError, ValidationError, OperationNotFoundError } from "../src/errors.js";

const client: FireflyClient = {
  postBinary: vi.fn(async () => null),
  getText: vi.fn(async () => ""),
  get: vi.fn(async () => ({ data: [{ id: "1", type: "accounts", attributes: { name: "enpara", iban: null } }] })),
  post: vi.fn(async () => ({ data: {} })),
  put: vi.fn(async () => ({ data: {} })),
  del: vi.fn(async () => null),
};

function accountModule(): EntityModule {
  return {
    entity: EntityType.Account,
    hint: "asset, expense and revenue accounts; balances",
    operations: {
      list: defineOperation({
        description: "Which accounts exist?",
        access: "read",
        input: z.object({ type: z.string().optional() }).strict(),
        handler: (params, api) => api.get("/accounts", { type: params.type }),
      }),
      create: defineOperation({
        description: "Create a new account.",
        access: "write",
        input: z.object({ name: z.string() }).strict(),
        handler: (params, api) => api.post("/accounts", { name: params.name }),
      }),
    },
  };
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    apiUrl: "https://firefly.example/api/v1",
    apiToken: "token",
    readOnly: false,
    permissions: { fallback: "destructive", byEntity: new Map() },
    directMode: false,
    enabledEntities: new Set(Object.values(EntityType)),
    disableSslVerify: false,
    logLevel: "INFO",
    ...overrides,
  };
}

function makeRegistry(overrides: Partial<Config> = {}): Registry {
  const registry = new Registry(makeConfig(overrides), client);
  registry.register(accountModule());
  return registry;
}

describe("Registry.execute", () => {
  it("validates params against the operation's schema", async () => {
    await expect(makeRegistry().execute("account", "list", { nonsense: 1 })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("strips empty attributes from the response", async () => {
    const result = (await makeRegistry().execute("account", "list")) as {
      data: { attributes: Record<string, unknown> }[];
    };
    expect(result.data[0]!.attributes).toEqual({ name: "enpara" });
  });

  it("applies the field projection", async () => {
    const result = (await makeRegistry().execute("account", "list", {}, ["iban"])) as {
      data: { attributes: Record<string, unknown> }[];
    };
    expect(result.data[0]!.attributes).toEqual({});
  });

  it("puts the schema in the refusal, so the caller needs no second call", async () => {
    // Zod says "Required" and nothing about shape. Learning that a date is
    // YYYY-MM-DD should not cost a round-trip through firefly_get_schema.
    const error: Error = await makeRegistry()
      .execute("account", "list", { type: 7 })
      .then(
        () => new Error("expected a validation failure"),
        (caught: unknown) => (caught instanceof Error ? caught : new Error(String(caught))),
      );

    expect(error.message).toContain("Expected schema:");
    expect(error.message).toContain('"type"');
  });

  it("raises for an unknown operation", async () => {
    await expect(makeRegistry().execute("account", "nonsense")).rejects.toBeInstanceOf(
      OperationNotFoundError,
    );
  });
});

describe("read-only mode", () => {
  it("refuses a write operation", async () => {
    await expect(
      makeRegistry({ readOnly: true }).execute("account", "create", { name: "x" }),
    ).rejects.toBeInstanceOf(ReadOnlyModeError);
  });

  it("still allows reads", async () => {
    await expect(makeRegistry({ readOnly: true }).execute("account", "list")).resolves.toBeTruthy();
  });

  it("hides write operations from the catalogue", () => {
    expect(makeRegistry({ readOnly: true }).operationCatalogue()).not.toContain("create");
  });

  it("hides write operations from listOperations", () => {
    const names = makeRegistry({ readOnly: true })
      .listOperations()
      .map((op) => op.name);
    expect(names).toEqual(["account.list"]);
  });

  it("refuses the schema for a hidden operation", () => {
    expect(() => makeRegistry({ readOnly: true }).getSchema("account", "create")).toThrow(
      ReadOnlyModeError,
    );
  });
});

describe("entity enablement", () => {
  it("skips a provider whose entity is not enabled", () => {
    const registry = new Registry(makeConfig({ enabledEntities: new Set() }), client);
    registry.register(accountModule());
    expect(registry.listOperations()).toEqual([]);
  });
});

describe("operationCatalogue", () => {
  it("puts the entity hint on the line so the model can pick an entity", () => {
    expect(makeRegistry().operationCatalogue()).toBe(
      "  account: create, list — asset, expense and revenue accounts; balances",
    );
  });
});

describe("defineOperation", () => {
  it("passes the schema-typed parameters through to the handler", async () => {
    const seen: unknown[] = [];
    const operation = defineOperation({
      description: "Which accounts exist?",
      access: "read",
      input: z.object({ type: z.string() }).strict(),
      handler: async (params) => {
        seen.push(params.type);
        return { data: [] };
      },
    });
    const registry = new Registry(makeConfig(), client);
    registry.register({ entity: EntityType.Account, hint: "accounts", operations: { list: operation } });

    await registry.execute("account", "list", { type: "asset" });
    expect(seen).toEqual(["asset"]);
  });

  it("still runs through Registry's validation gate", async () => {
    const registry = new Registry(makeConfig(), client);
    registry.register({
      entity: EntityType.Account,
      hint: "accounts",
      operations: {
        list: defineOperation({
          description: "Which accounts exist?",
          access: "read",
          input: z.object({ type: z.string() }).strict(),
          handler: async () => ({ data: [] }),
        }),
      },
    });

    await expect(registry.execute("account", "list", { nonsense: 1 })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("still respects the read-only gate", async () => {
    const registry = new Registry(makeConfig({ readOnly: true }), client);
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

    await expect(registry.execute("account", "create", { name: "x" })).rejects.toBeInstanceOf(
      ReadOnlyModeError,
    );
  });
});

describe("getSchema", () => {
  it("returns a JSON Schema built from the Zod input", () => {
    const schema = makeRegistry().getSchema("account", "list") as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties)).toEqual(["type"]);
  });
});
