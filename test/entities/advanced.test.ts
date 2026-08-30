import { describe, expect, it } from "vitest";
import { ENTITY_MODULES } from "../../src/server.js";
import { EntityType } from "../../src/types.js";
import { Registry } from "../../src/registry.js";
import type { Config } from "../../src/config.js";
import type { FireflyClient } from "../../src/firefly.js";

function setup() {
  const calls: string[] = [];
  const client: FireflyClient = {
    get: async (path) => { calls.push(`GET ${path}`); return {}; },
    getText: async (path) => { calls.push(`GET_TEXT ${path}`); return "csv"; },
    post: async (path) => { calls.push(`POST ${path}`); return {}; },
    put: async (path) => { calls.push(`PUT ${path}`); return {}; },
    del: async (path) => { calls.push(`DELETE ${path}`); return null; },
    postBinary: async () => null,
  };
  const config: Config = { apiUrl: "https://example.test/api/v1", apiToken: "", structuredOutput: false, resourceUrl: "", authorizationServers: [], disableSslVerify: false, };
  const registry = new Registry(config, client);
  for (const module of ENTITY_MODULES) registry.register(module);
  return { registry, calls };
}

describe("advanced financial API surfaces", () => {
  it("maps available budgets, links, groups, preferences and configuration", async () => {
    const { registry, calls } = setup();
    await registry.execute("available_budget", "list", { start: "2026-08-01", end: "2026-08-31" });
    await registry.execute("transaction_link", "list", {});
    await registry.execute("link_type", "list", {});
    await registry.execute("object_group", "list", {});
    await registry.execute("preference", "list", {});
    await registry.execute("configuration", "list", {});
    expect(calls).toEqual(["GET /available-budgets", "GET /transaction-links", "GET /link-types", "GET /object-groups", "GET /preferences", "GET /configuration"]);
  });

  it("uses text responses for exports", async () => {
    const { registry, calls } = setup();
    await registry.execute("data_export", "accounts", {});
    await registry.execute("data_export", "accounts", { format: "json" });
    expect(calls).toContain("GET_TEXT /data/export/accounts");
  });

  it("keeps advanced inputs strict", () => {
    const { registry } = setup();
    for (const entity of ["available_budget", "transaction_link", "link_type", "object_group", "preference", "configuration", "data_export"]) {
      const module = registry.entityModules().find((item) => item.entity === entity);
      expect(module).toBeDefined();
      for (const operation of Object.values(module!.operations)) expect(operation.input.safeParse({ unexpected: true }).success).toBe(false);
    }
  });
});

describe("what bulk_rewrite tells the model to send", () => {
  /** The schema is the only instruction the model gets, and this one used to
   * ask for "a JavaScript regular expression" with "$1..$9 for capture
   * groups". The implementation has never accepted a regular expression: it
   * parses the `#`/`*` language, in which `.` and `\` and `$` match
   * themselves. A model doing as it was told therefore sent a pattern that
   * matched nothing, or — worse, since this operation is destructive and runs
   * to `max_matches` rows — matched something else. */
  it("describes the pattern language it actually parses", async () => {
    const { transactionOperations } = await import("../../src/entities/transactions.js");
    const rewrite = transactionOperations.bulk_rewrite!;
    const shape = (rewrite.input as unknown as { shape: Record<string, { description?: string }> }).shape;
    const match = shape.match?.description ?? "";

    expect(match).toContain("`#`");
    expect(match).toContain("`*`");
    expect(match).toMatch(/NOT a regular expression/i);
    // The operation description must not promise one either.
    expect(rewrite.description).not.toMatch(/regular expression/i);
  });
});
