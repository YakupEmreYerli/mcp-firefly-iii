import { describe, expect, it } from "vitest";
import { Registry } from "../src/registry.js";
import { EntityType } from "../src/types.js";
import { ENTITY_MODULES } from "../src/server.js";
import type { Config } from "../src/config.js";
import type { FireflyClient } from "../src/firefly.js";

const client: FireflyClient = {
  get: async () => ({}), getText: async () => "", post: async () => ({}),
  put: async () => ({}), del: async () => null, postBinary: async () => null,
};

function registry(): Registry {
  const config: Config = {
    apiUrl: "https://firefly.example/api/v1", apiToken: "",
    structuredOutput: false,     resourceUrl: "", authorizationServers: [], disableSslVerify: false,
  };
  const result = new Registry(config, client);
  for (const module of ENTITY_MODULES) result.register(module);
  return result;
}

type Schema = { properties?: Record<string, Schema>; items?: Schema; description?: string };

/** Walk a published JSON Schema to the field at `path`. */
function fieldAt(schema: Schema, path: string[]): Schema | undefined {
  let node: Schema | undefined = schema;
  for (const step of path) {
    node = step === "[]" ? node?.items : node?.properties?.[step];
    if (node === undefined) return undefined;
  }
  return node;
}

/** Every array Firefly overwrites wholesale rather than merging into.
 *
 * Measured against Firefly 6.6.3, not assumed: sending a rule one of its two
 * triggers left it with one, and sending a transaction one tag dropped the
 * others. Omitting the field entirely preserves what is there — it is only a
 * partial list that destroys.
 *
 * This cost real data once. `bulk_tag` read as "add a tag", replaced the set,
 * and reported success, so a caller tagging an already-tagged transaction
 * silently lost the rest. The operation was fixed to merge; these fields
 * cannot be, because replacing is what the caller is legitimately asking for.
 * What they can do is say so where the model actually looks.
 */
const REPLACED_WHOLESALE: [string, string, string[]][] = [
  ["transaction", "update", ["transactions", "[]", "tags"]],
  ["transaction", "create", ["transactions", "[]", "tags"]],
  ["rule", "update", ["rule_update", "triggers"]],
  ["rule", "update", ["rule_update", "actions"]],
  ["piggy_bank", "update", ["piggy_bank_update", "accounts"]],
  ["recurring_transaction", "create", ["repetitions"]],
  ["recurring_transaction", "create", ["transactions"]],
];

describe("arrays Firefly replaces rather than merges", () => {
  for (const [entity, operation, path] of REPLACED_WHOLESALE) {
    it(`warns on ${entity}.${operation} ${path.join(".")}`, () => {
      const field = fieldAt(registry().getSchema(entity, operation) as Schema, path);
      expect(field, `${entity}.${operation} has no field at ${path.join(".")}`).toBeDefined();
      expect(field?.description ?? "", `${entity}.${operation}.${path.join(".")}`).toMatch(/REPLACES/);
    });
  }

  it("says what to do instead, not only that it is dangerous", () => {
    const field = fieldAt(registry().getSchema("transaction", "update") as Schema, ["transactions", "[]", "tags"]);
    // A warning with no remedy just makes the model avoid the field.
    expect(field?.description).toMatch(/read the current values first/i);
  });
});
