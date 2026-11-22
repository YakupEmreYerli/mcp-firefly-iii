import { describe, expect, it } from "vitest";
import { Registry } from "../../src/registry.js";
import { categoriesModule } from "../../src/entities/categories.js";
import type { Config } from "../../src/config.js";
import type { FireflyClient } from "../../src/firefly.js";

// Firefly III added category color in 6.7.8; an older instance answers 200
// and drops it, which is the silent loss this server exists to refuse.
function setup(about: () => Promise<unknown>) {
  const calls: string[] = [];
  const posts: unknown[] = [];
  const client: FireflyClient = {
    get: async (path) => { calls.push(`GET ${path}`); return about(); },
    getText: async () => "",
    post: async (path, body) => { calls.push(`POST ${path}`); posts.push(body); return { data: {} }; },
    put: async (path, body) => { calls.push(`PUT ${path}`); posts.push(body); return { data: {} }; },
    del: async () => null,
    postBinary: async () => null,
  };
  const config: Config = { apiUrl: "https://firefly.example/api/v1", apiToken: "", structuredOutput: false, resourceUrl: "", authorizationServers: [], disableSslVerify: false };
  const registry = new Registry(config, client);
  registry.register(categoriesModule);
  return { registry, calls, posts };
}

describe("category color and the Firefly version", () => {
  it("refuses a color on Firefly older than 6.7.8 and sends nothing", async () => {
    const { registry, calls } = setup(async () => ({ data: { version: "6.6.3" } }));
    await expect(registry.execute("category", "create", { name: "Food", color: "ff8800" }))
      .rejects.toThrow("category color needs Firefly III 6.7.8 or later; this instance runs 6.6.3");
    await expect(registry.execute("category", "update", { id: "5", category_update: { name: "Food", color: "ff8800" } })).rejects.toThrow("6.7.8");
    expect(calls.filter((c) => !c.startsWith("GET"))).toEqual([]);
  });

  it("sends the color to Firefly 6.7.8 and later", async () => {
    const { registry, posts } = setup(async () => ({ data: { version: "6.7.9" } }));
    await registry.execute("category", "create", { name: "Food", color: "ff8800" });
    expect(posts[0]).toEqual({ name: "Food", color: "ff8800" });
  });

  it("does not block when the version cannot be read", async () => {
    const { registry, posts } = setup(async () => { throw new Error("about failed"); });
    await registry.execute("category", "create", { name: "Food", color: "ff8800" });
    expect(posts).toHaveLength(1);
  });

  it("does not ask for the version when no color is sent", async () => {
    const { registry, calls } = setup(async () => ({ data: { version: "6.6.3" } }));
    await registry.execute("category", "create", { name: "Food" });
    expect(calls).toEqual(["POST /categories"]);
  });
});
