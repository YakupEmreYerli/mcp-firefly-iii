import { describe, expect, it } from "vitest";
import { ENTITY_MODULES } from "../../src/server.js";
import { EntityType } from "../../src/types.js";
import { Registry } from "../../src/registry.js";
import type { Config } from "../../src/config.js";
import type { FireflyClient } from "../../src/firefly.js";

function makeRegistry(): { registry: Registry; calls: string[] } {
  const calls: string[] = [];
  const client: FireflyClient = {
    get: async (path) => { calls.push(`GET ${path}`); return {}; },
    getText: async () => "",
    post: async (path) => { calls.push(`POST ${path}`); return {}; },
    put: async (path) => { calls.push(`PUT ${path}`); return {}; },
    del: async (path) => { calls.push(`DELETE ${path}`); return null; },
    postBinary: async (path) => { calls.push(`POST_BINARY ${path}`); return null; },
  };
  const config: Config = { apiUrl: "https://example.test/api/v1", apiToken: "", readOnly: false, permissions: { fallback: "destructive", byEntity: new Map() }, directMode: false, enabledEntities: new Set(Object.values(EntityType)), structuredOutput: false, disableSslVerify: false, logLevel: "INFO" };
  const registry = new Registry(config, client);
  for (const module of ENTITY_MODULES) registry.register(module);
  return { registry, calls };
}

describe("financial API extensions", () => {
  it("registers the prioritized financial surfaces", () => {
    const names = ENTITY_MODULES.map((module) => module.entity);
    expect(names).toEqual(expect.arrayContaining(["currency", "exchange_rate", "attachment", "recurring_transaction", "autocomplete"]));
  });

  it("maps currency and exchange-rate operations to Firefly endpoints", async () => {
    const { registry, calls } = makeRegistry();
    await registry.execute("currency", "list", {});
    await registry.execute("exchange_rate", "list", {});
    await registry.execute("currency", "get", { code: "TRY" });
    expect(calls).toEqual(["GET /currencies", "GET /exchange-rates", "GET /currencies/TRY"]);
  });

  it("maps attachments, recurrences, and autocomplete to their API families", async () => {
    const { registry, calls } = makeRegistry();
    await registry.execute("attachment", "list", {});
    await registry.execute("attachment", "upload", { id: "1", content_base64: "dGVzdA==" });
    await registry.execute("recurring_transaction", "list", {});
    await registry.execute("autocomplete", "accounts", { query: "cash" });
    expect(calls).toEqual(["GET /attachments", "POST_BINARY /attachments/1/upload", "GET /recurrences", "GET /autocomplete/accounts"]);
  });

  it("keeps every new input schema strict", () => {
    const { registry } = makeRegistry();
    for (const entity of ["currency", "exchange_rate", "attachment", "recurring_transaction", "autocomplete"]) {
      const module = registry.entityModules().find((item) => item.entity === entity);
      expect(module).toBeDefined();
      for (const operation of Object.values(module!.operations)) expect(operation.input.safeParse({ unexpected: true }).success).toBe(false);
    }
  });
});
