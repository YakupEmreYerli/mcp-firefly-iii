import { describe, expect, it } from "vitest";
import { extractEnvVars, extractRetiredEnvVars, fingerprint, buildModel } from "../../scripts/docs/extract.mjs";

describe("extractEnvVars", () => {
  it("finds every env.NAME access, in first-seen order, without duplicates", () => {
    const source = `
      const a = env.FIREFLY_API_URL;
      const b = env.FIREFLY_API_TOKEN ?? "";
      const c = env.FIREFLY_API_URL; // read twice
    `;
    expect(extractEnvVars(source)).toEqual(["FIREFLY_API_TOKEN", "FIREFLY_API_URL"]); // sorted
  });

  it("does not match a lowercase or mixed-case property access", () => {
    const source = `const x = env.notAnEnvVar; const y = someOtherObject.FIREFLY_X;`;
    expect(extractEnvVars(source)).toEqual([]);
  });
});

describe("extractRetiredEnvVars", () => {
  it("only reads names inside refuseRetiredSettings, not the rest of the file", () => {
    // Written flush-left, matching how a real top-level function closes in
    // config.ts (extractRetiredEnvVars's regex looks for an unindented "}" to
    // find the end of the function, the same shape the real source has).
    const source = [
      "function refuseRetiredSettings(env) {",
      "  if (env.FIREFLY_OLD_A) throw new Error();",
      "  if (env.FIREFLY_OLD_B) throw new Error();",
      "}",
      "function loadConfig(env) {",
      "  return { url: env.FIREFLY_API_URL };",
      "}",
    ].join("\n");
    expect(extractRetiredEnvVars(source)).toEqual(["FIREFLY_OLD_A", "FIREFLY_OLD_B"]);
  });

  it("returns an empty list when the function is not present", () => {
    expect(extractRetiredEnvVars("function loadConfig(env) { return env.X; }")).toEqual([]);
  });
});

describe("fingerprint", () => {
  it("is stable for the same value and differs for a different one", () => {
    expect(fingerprint({ a: 1 })).toBe(fingerprint({ a: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });
});

describe("buildModel against the real, built server", () => {
  it("finds every operation this project actually registers, and none of the retired env vars in the active list", async () => {
    const model = await buildModel();
    expect(model.operations.length).toBeGreaterThan(100);
    expect(model.operations.map((op: { name: string }) => op.name)).toContain("transaction.bulk_update_where");
    for (const retired of model.retiredEnvVars) expect(model.envVars).not.toContain(retired);
    // Sorted (localeCompare, matching registry.listOperations()), so
    // render.mjs and manifest.mjs can rely on stable order.
    const names = model.operations.map((op: { name: string }) => op.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});
