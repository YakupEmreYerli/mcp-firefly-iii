import { describe, expect, it } from "vitest";
import { compareVersions, fireflyVersion } from "../src/version.js";
import type { FireflyClient } from "../src/firefly.js";

function clientAnswering(get: FireflyClient["get"]): FireflyClient {
  return { get, getText: async () => "", post: async () => ({}), put: async () => ({}), del: async () => null, postBinary: async () => null };
}

describe("compareVersions", () => {
  it("compares numerically, not as text", () => {
    expect(compareVersions("6.7.8", "6.7.10")).toBeLessThan(0);
    expect(compareVersions("6.10.0", "6.9.9")).toBeGreaterThan(0);
  });

  it("ignores a leading v", () => {
    expect(compareVersions("v6.7.9", "6.7.9")).toBe(0);
  });
});

describe("fireflyVersion", () => {
  it("asks Firefly once per client", async () => {
    let calls = 0;
    const client = clientAnswering(async () => { calls++; return { data: { version: "6.7.9" } }; });
    expect(await fireflyVersion(client)).toBe("6.7.9");
    expect(await fireflyVersion(client)).toBe("6.7.9");
    expect(calls).toBe(1);
  });

  it("returns undefined when the version cannot be read", async () => {
    expect(await fireflyVersion(clientAnswering(async () => { throw new Error("down"); }))).toBeUndefined();
    expect(await fireflyVersion(clientAnswering(async () => ({ data: {} })))).toBeUndefined();
  });

  // A development build reports a branch name; treating it as 0.0.0 would
  // refuse features it has.
  it("treats a version that is not numeric as unknown", async () => {
    expect(await fireflyVersion(clientAnswering(async () => ({ data: { version: "develop/2026-11-20" } })))).toBeUndefined();
  });
});
