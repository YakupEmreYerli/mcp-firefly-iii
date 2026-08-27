import { describe, expect, it } from "vitest";
import { loadConfig, permits } from "../src/config.js";
import { Registry } from "../src/registry.js";
import { PermissionDeniedError } from "../src/errors.js";
import { EntityType } from "../src/types.js";
import { defineOperation, type EntityModule } from "../src/registry.js";
import type { Config } from "../src/config.js";
import type { FireflyClient } from "../src/firefly.js";
import { z } from "zod";

const client: FireflyClient = {
  get: async () => ({}), getText: async () => "", post: async () => ({}),
  put: async () => ({}), del: async () => null, postBinary: async () => null,
};

const module: EntityModule = {
  entity: EntityType.Transaction,
  hint: "one of each access level",
  operations: {
    list: defineOperation({ description: "Read.", access: "read", input: z.object({}).strict(), handler: async () => ({}) }),
    create: defineOperation({ description: "Write.", access: "write", input: z.object({}).strict(), handler: async () => ({}) }),
    delete: defineOperation({ description: "Delete.", access: "destructive", input: z.object({}).strict(), handler: async () => ({}) }),
  },
};

const other: EntityModule = {
  entity: EntityType.Account,
  hint: "accounts",
  operations: {
    delete: defineOperation({ description: "Delete.", access: "destructive", input: z.object({}).strict(), handler: async () => ({}) }),
  },
};

function policy(raw?: string): Config["permissions"] {
  return loadConfig({ FIREFLY_PERMISSIONS: raw } as NodeJS.ProcessEnv).permissions;
}

function registry(raw?: string): Registry {
  const config: Config = {
    apiUrl: "https://firefly.example/api/v1", apiToken: "",
    permissions: policy(raw),
    structuredOutput: false, resourceUrl: "", authorizationServers: [], disableSslVerify: false, logLevel: "INFO",
  };
  const result = new Registry(config, client);
  result.register(module);
  result.register(other);
  return result;
}

describe("parsing FIREFLY_PERMISSIONS", () => {
  it("leaves an existing deployment unrestricted when it is unset", () => {
    const parsed = policy(undefined);
    expect(permits(parsed, EntityType.Transaction, "destructive")).toBe(true);
  });

  it("reads `safe` as write but not delete, which is the level that had no name before", () => {
    const parsed = policy("safe");
    expect(permits(parsed, EntityType.Transaction, "write")).toBe(true);
    expect(permits(parsed, EntityType.Transaction, "destructive")).toBe(false);
  });

  it("reads `read` as reads only", () => {
    const parsed = policy("read");
    expect(permits(parsed, EntityType.Transaction, "read")).toBe(true);
    expect(permits(parsed, EntityType.Transaction, "write")).toBe(false);
  });

  it("lets one entity be wider than the rest", () => {
    const parsed = policy("transaction:full;*:read");
    expect(permits(parsed, EntityType.Transaction, "destructive")).toBe(true);
    expect(permits(parsed, EntityType.Account, "destructive")).toBe(false);
    expect(permits(parsed, EntityType.Account, "read")).toBe(true);
  });

  it("shuts an entity out entirely with `none`", () => {
    const parsed = policy("transaction:none;*:full");
    expect(permits(parsed, EntityType.Transaction, "read")).toBe(false);
    expect(permits(parsed, EntityType.Account, "read")).toBe(true);
  });

  it("fails closed on a policy it cannot read, rather than widening", () => {
    // A typo must not turn into a permission nobody granted.
    const parsed = policy("transaktion:full");
    expect(permits(parsed, EntityType.Transaction, "read")).toBe(false);
  });

  it("drops an unknown level instead of treating the clause as full access", () => {
    const parsed = policy("transaction:everything;*:read");
    expect(permits(parsed, EntityType.Transaction, "write")).toBe(false);
    expect(permits(parsed, EntityType.Transaction, "read")).toBe(true);
  });
});

describe("the registry enforces the policy", () => {
  it("runs an operation the policy allows", async () => {
    await expect(registry("safe").execute("transaction", "create", {})).resolves.toBeDefined();
  });

  it("refuses a delete under `safe`", async () => {
    await expect(registry("safe").execute("transaction", "delete", {})).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("names the setting the operator would have to change", async () => {
    await expect(registry("safe").execute("transaction", "delete", {})).rejects.toThrow(/FIREFLY_PERMISSIONS/);
  });

  it("hides what it would refuse, so the model is not sent down a dead end", () => {
    const names = registry("safe").listOperations(EntityType.Transaction).map((op) => op.operation).sort();
    expect(names).toEqual(["create", "list"]);
  });

  it("narrows the catalogue per entity, not globally", () => {
    const text = registry("transaction:full;*:read").operationCatalogue();
    expect(text).toContain("transaction: create, delete, list");
    expect(text).not.toContain("account: delete");
  });
});

describe("whole-value levels", () => {
  // docs/configuration.md lists none|read|write|destructive as the level
  // vocabulary and says the preset names are interchangeable with it, so an
  // operator writing a bare level is writing something the docs offered.
  it("accepts a bare level name as a preset", () => {
    expect(policy("write").fallback).toBe("write");
    expect(policy("destructive").fallback).toBe("destructive");
    expect(policy("read").fallback).toBe("read");
    expect(policy("none").fallback).toBe("none");
  });

  it("does not turn a request for everything into a block on everything", () => {
    // The failure this guards is silent: `destructive` fell through the clause
    // parser to fallback "none", so asking for full access closed every read.
    expect(policy("destructive").fallback).not.toBe("none");
  });
});
