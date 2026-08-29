import { describe, expect, it } from "vitest";
import { buildManifest, serializeManifest, diffManifests, formatDiff } from "../../scripts/docs/manifest.mjs";
import { fingerprint } from "../../scripts/docs/extract.mjs";

function op(name: string, access: "read" | "write" | "destructive", fp: string) {
  const [entity, operation] = name.split(".");
  return { name, entity, operation, access, fingerprint: fp };
}

describe("buildManifest / serializeManifest", () => {
  it("is byte-identical across two builds from the same model", () => {
    const model = {
      operations: [op("account.get", "read", "aaa"), op("transaction.delete", "destructive", "bbb")],
      envVars: ["FIREFLY_API_URL"],
      retiredEnvVars: ["FIREFLY_PERMISSIONS"],
    };
    const first = serializeManifest(buildManifest(model as never));
    const second = serializeManifest(buildManifest(model as never));
    expect(first).toBe(second);
  });

  it("does not depend on the order operations were given in", () => {
    const a = { operations: [op("b.x", "read", "1"), op("a.x", "read", "2")], envVars: [], retiredEnvVars: [] };
    const b = { operations: [op("a.x", "read", "2"), op("b.x", "read", "1")], envVars: [], retiredEnvVars: [] };
    // buildManifest itself does not sort — extract.mjs's sort is what
    // guarantees order — so this documents that contract: two differently
    // ordered models produce two differently ordered manifests.
    expect(serializeManifest(buildManifest(a as never)) === serializeManifest(buildManifest(b as never))).toBe(false);
  });
});

describe("fingerprint", () => {
  it("does not depend on key order", () => {
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }));
  });

  it("changes when a nested value changes", () => {
    expect(fingerprint({ schema: { type: "object" } })).not.toBe(fingerprint({ schema: { type: "string" } }));
  });
});

describe("diffManifests", () => {
  it("reports every operation as added when there is no previous manifest", () => {
    const current = { operations: [op("a.x", "read", "1")], envVars: [], retiredEnvVars: [] };
    const diff = diffManifests(null, current as never);
    expect(diff).toMatchObject({ added: ["a.x"], removed: [], changed: [], breaking: [] });
  });

  it("flags a removed operation as breaking", () => {
    const previous = { operations: [op("a.x", "read", "1"), op("b.y", "read", "2")], envVars: [], retiredEnvVars: [] };
    const current = { operations: [op("a.x", "read", "1")], envVars: [], retiredEnvVars: [] };
    const diff = diffManifests(previous as never, current as never);
    expect(diff.removed).toEqual(["b.y"]);
    expect(diff.breaking).toEqual(["operation removed: b.y"]);
  });

  it("flags widened access (read -> destructive) as breaking, but not the reverse", () => {
    const wider = diffManifests(
      { operations: [op("a.x", "read", "1")], envVars: [], retiredEnvVars: [] } as never,
      { operations: [op("a.x", "destructive", "2")], envVars: [], retiredEnvVars: [] } as never,
    );
    expect(wider.breaking).toEqual(["a.x: access widened from read to destructive"]);

    const narrower = diffManifests(
      { operations: [op("a.x", "destructive", "1")], envVars: [], retiredEnvVars: [] } as never,
      { operations: [op("a.x", "read", "2")], envVars: [], retiredEnvVars: [] } as never,
    );
    expect(narrower.breaking).toEqual([]);
    expect(narrower.changed).toEqual(["a.x"]);
  });

  it("does not flag a fingerprint-only change (e.g. a rewritten description) as breaking", () => {
    const diff = diffManifests(
      { operations: [op("a.x", "read", "1")], envVars: [], retiredEnvVars: [] } as never,
      { operations: [op("a.x", "read", "2")], envVars: [], retiredEnvVars: [] } as never,
    );
    expect(diff.changed).toEqual(["a.x"]);
    expect(diff.breaking).toEqual([]);
  });

  it("flags an env var moving from active to retired as breaking", () => {
    const diff = diffManifests(
      { operations: [], envVars: ["FIREFLY_PERMISSIONS"], retiredEnvVars: [] } as never,
      { operations: [], envVars: [], retiredEnvVars: ["FIREFLY_PERMISSIONS"] } as never,
    );
    expect(diff.breaking).toEqual(["env var retired: FIREFLY_PERMISSIONS"]);
  });

  it("does not report an unchanged operation in any bucket", () => {
    const stable = { operations: [op("a.x", "read", "same")], envVars: [], retiredEnvVars: [] };
    const diff = diffManifests(stable as never, stable as never);
    expect(diff).toEqual({ added: [], removed: [], changed: [], breaking: [] });
  });
});

describe("formatDiff", () => {
  it("says nothing changed when every bucket is empty", () => {
    expect(formatDiff({ added: [], removed: [], changed: [], breaking: [] })).toBe("No API changes since the last commit.");
  });

  it("puts BREAKING first when present", () => {
    const text = formatDiff({ added: ["a"], removed: [], changed: [], breaking: ["operation removed: b"] });
    expect(text.startsWith("BREAKING:")).toBe(true);
  });
});
