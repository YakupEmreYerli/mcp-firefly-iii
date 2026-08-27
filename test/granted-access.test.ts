import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Registry, defineOperation, type EntityModule } from "../src/registry.js";
import { PermissionDeniedError } from "../src/errors.js";
import { EntityType, type Access } from "../src/types.js";
import type { Config } from "../src/config.js";
import type { FireflyClient } from "../src/firefly.js";

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

const config: Config = {
  apiUrl: "https://firefly.example/api/v1", apiToken: "",
  structuredOutput: false, resourceUrl: "", authorizationServers: [], disableSslVerify: false,
};

function registry(granted?: ReadonlySet<Access>): Registry {
  const result = new Registry(config, client, granted);
  result.register(module);
  return result;
}

describe("what a connection was granted", () => {
  it("holds every surface when nothing narrowed it", async () => {
    // The stdio case, and the static-token case: whoever holds the Firefly
    // token has already made the access decision, and a server-wide setting
    // narrowing it further was a boundary they could edit in the same file.
    await expect(registry().execute("transaction", "delete", {}, undefined, ["destructive"])).resolves.toBeDefined();
  });

  it("refuses an operation above the scopes the connection was granted", async () => {
    const scoped = registry(new Set<Access>(["read"]));

    await expect(scoped.execute("transaction", "create", {}, undefined, ["write"])).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });

  it("hides what it refuses, rather than listing an operation that can only fail", () => {
    const catalogue = registry(new Set<Access>(["read"])).operationCatalogue(["read", "write", "destructive"]);

    expect(catalogue).toContain("list");
    expect(catalogue).not.toContain("delete");
  });

  it("names the scope that was missing, not a setting nobody wrote", async () => {
    const scoped = registry(new Set<Access>(["read", "write"]));

    await expect(
      scoped.execute("transaction", "delete", {}, undefined, ["destructive"]),
    ).rejects.toThrow(/firefly:destructive/);
  });
});
