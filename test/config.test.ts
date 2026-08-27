import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { EntityType } from "../src/types.js";

describe("loadConfig", () => {
  it("reads the API url and token", () => {
    const config = loadConfig({
      FIREFLY_API_URL: "https://firefly.example/api/v1",
      FIREFLY_API_TOKEN: "token",
    });
    expect(config.apiUrl).toBe("https://firefly.example/api/v1");
    expect(config.apiToken).toBe("token");
  });

  it("enables every entity when FIREFLY_ENABLED_ENTITIES is unset", () => {
    const config = loadConfig({});
    expect(config.enabledEntities.size).toBe(Object.values(EntityType).length);
  });

  it("enables only the named entities", () => {
    const config = loadConfig({ FIREFLY_ENABLED_ENTITIES: "account, transaction" });
    expect([...config.enabledEntities].sort()).toEqual([
      EntityType.Account,
      EntityType.Transaction,
    ].sort());
  });

  it("ignores unknown entity names rather than failing to start", () => {
    const config = loadConfig({ FIREFLY_ENABLED_ENTITIES: "account,nonsense" });
    expect([...config.enabledEntities]).toEqual([EntityType.Account]);
  });

  it("treats 'all' as every entity", () => {
    const config = loadConfig({ FIREFLY_ENABLED_ENTITIES: "all" });
    expect(config.enabledEntities.size).toBe(Object.values(EntityType).length);
  });

  it("treats 'all' as every entity wherever it appears in the list", () => {
    const config = loadConfig({ FIREFLY_ENABLED_ENTITIES: "account, ALL " });
    expect(config.enabledEntities.size).toBe(Object.values(EntityType).length);
  });

  it("matches entity names case-insensitively, as Python does", () => {
    const config = loadConfig({ FIREFLY_ENABLED_ENTITIES: "Account, TRANSACTION" });
    expect([...config.enabledEntities].sort()).toEqual(
      [EntityType.Account, EntityType.Transaction].sort(),
    );
  });

  it("enables nothing when only unknown names are listed", () => {
    // An empty set is honest: `make check` reports "0 entities". Falling back
    // to everything would reward a typo by widening a safety knob.
    const config = loadConfig({ FIREFLY_ENABLED_ENTITIES: "nonsense,typo" });
    expect(config.enabledEntities.size).toBe(0);
  });

  it("treats an unparseable boolean as false", () => {
    const config = loadConfig({ FIREFLY_READ_ONLY: "evet" });
    expect(config.readOnly).toBe(false);
  });

  it("reads booleans case-insensitively", () => {
    const config = loadConfig({ FIREFLY_READ_ONLY: "TRUE", });
    expect(config.readOnly).toBe(true);
  });

  it.each(["1", "yes", "on", "YES", " On "])(
    "accepts %s as a true boolean, like the Python version did",
    (raw) => {
      expect(loadConfig({ FIREFLY_READ_ONLY: raw }).readOnly).toBe(true);
    },
  );
});
