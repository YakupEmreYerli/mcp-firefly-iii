import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  cancelUpdateCheck,
  isNewer,
  latestVersion,
  resetUpdateState,
  setUpdateNoticeForTest,
  startUpdateCheck,
  takeUpdateNotice,
  updateCheckEnabled,
} from "../src/update.js";
import { Registry, defineOperation, type EntityModule } from "../src/registry.js";
import { createServer } from "../src/server.js";
import { EntityType } from "../src/types.js";
import type { Config } from "../src/config.js";
import type { FireflyClient } from "../src/firefly.js";

const config = {
  apiUrl: "https://firefly.example/api/v1",
  apiToken: "x",
  disableSslVerify: false,
  resourceUrl: "",
  authorizationServers: [],
  structuredOutput: false,
} as Config;

const client = { get: async () => ({ ok: true }) } as unknown as FireflyClient;

const module: EntityModule = {
  entity: EntityType.Account,
  hint: "accounts",
  operations: {
    list: defineOperation({
      description: "What accounts are there?",
      access: "read",
      input: (await import("zod")).z.object({}).strict(),
      handler: (_q, c) => c.get("/accounts"),
    }),
  },
};

let cacheDir = "";

beforeEach(() => {
  resetUpdateState();
  cacheDir = mkdtempSync(join(tmpdir(), "firefly-update-"));
  process.env.XDG_CACHE_HOME = cacheDir;
});

afterEach(() => {
  resetUpdateState();
  delete process.env.XDG_CACHE_HOME;
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
  cacheDir = "";
});

function registry(): Registry {
  const built = new Registry(config, client);
  built.register(module);
  return built;
}

/** Call one read tool and return every text block that came back. */
async function callTool(): Promise<string[]> {
  const server = createServer(registry(), config);
  const mcpClient = new Client({ name: "test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
  try {
    const result = (await mcpClient.callTool({
      name: "firefly_query",
      arguments: { entity: "account", operation: "list", params: {} },
    })) as { content: { type: string; text: string }[] };
    return result.content.filter((block) => block.type === "text").map((block) => block.text);
  } finally {
    await mcpClient.close();
    await server.close();
  }
}

describe("comparing versions", () => {
  it("orders each field numerically, not as text", () => {
    expect(isNewer("1.10.0", "1.9.0")).toBe(true);
    expect(isNewer("2.0.0", "1.99.99")).toBe(true);
    expect(isNewer("1.1.2", "1.1.1")).toBe(true);
    expect(isNewer("1.1.1", "1.1.1")).toBe(false);
    expect(isNewer("1.0.0", "1.0.1")).toBe(false);
  });

  it("reads the running version leniently and the published one strictly", () => {
    // These moved here with isOlder, which said the same things in reverse.
    // A maintainer's own build of 0.2.2 is ahead of the published 0.2.2 and
    // must not be told to reinstall over it...
    expect(isNewer("0.2.2", "0.2.2-beta.1")).toBe(false);
    // ...but a build of 0.2.1 is still behind 0.2.2, and saying nothing there
    // would be the less useful mistake.
    expect(isNewer("0.2.2", "0.2.1-beta.1")).toBe(true);
    expect(isNewer("0.2.2", "unknown")).toBe(false);
  });

  it("says nothing about a version it cannot read", () => {
    // A prerelease resolving to its release would announce an "update" to
    // someone who is already ahead of it.
    expect(isNewer("1.2.0-rc.1", "1.1.0")).toBe(false);
    expect(isNewer("latest", "1.1.0")).toBe(false);
    expect(isNewer("1.2", "1.1.0")).toBe(false);
  });
});

describe("asking the registry", () => {
  it("reads dist-tags.latest and remembers it for a day", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify({ "dist-tags": { latest: "9.9.9" } }), { status: 200 });
    }) as unknown as typeof fetch;

    expect(await latestVersion(fetchImpl)).toBe("9.9.9");
    // The second call is answered from the file, not the network: ten sessions
    // in a morning should ask once.
    expect(await latestVersion(fetchImpl)).toBe("9.9.9");
    expect(calls).toBe(1);
    const cached = JSON.parse(readFileSync(join(cacheDir, "firefly-mcp", "update.json"), "utf8")) as { latest: string };
    expect(cached.latest).toBe("9.9.9");
  });

  it("ignores a cache written in the future", async () => {
    // A clock that moved backwards would otherwise pin the answer forever.
    mkdirSync(join(cacheDir, "firefly-mcp"), { recursive: true });
    writeFileSync(
      join(cacheDir, "firefly-mcp", "update.json"),
      JSON.stringify({ checkedAt: Date.now() + 86_400_000, latest: "0.0.1" }),
    );
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ "dist-tags": { latest: "9.9.9" } }), { status: 200 })) as unknown as typeof fetch;
    expect(await latestVersion(fetchImpl)).toBe("9.9.9");
  });

  it("stays quiet when the registry is unreachable or unhelpful", async () => {
    const refuse = (async () => {
      throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
    }) as unknown as typeof fetch;
    expect(await latestVersion(refuse)).toBeUndefined();

    resetUpdateState();
    rmSync(join(cacheDir, "firefly-mcp"), { recursive: true, force: true });
    const rubbish = (async () => new Response("<html>502</html>", { status: 502 })) as unknown as typeof fetch;
    expect(await latestVersion(rubbish)).toBeUndefined();
  });
});

describe("turning it off", () => {
  it("honours MCP_UPDATE_CHECK, NO_UPDATE_NOTIFIER and CI", () => {
    expect(updateCheckEnabled({})).toBe(true);
    expect(updateCheckEnabled({ MCP_UPDATE_CHECK: "false" })).toBe(false);
    expect(updateCheckEnabled({ MCP_UPDATE_CHECK: "0" })).toBe(false);
    expect(updateCheckEnabled({ NO_UPDATE_NOTIFIER: "1" })).toBe(false);
    expect(updateCheckEnabled({ CI: "true" })).toBe(false);
  });

  it("asks nothing at all when it is off", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    startUpdateCheck({ fetchImpl, env: { MCP_UPDATE_CHECK: "false" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(called).toBe(false);
    expect(takeUpdateNotice()).toBeUndefined();
  });
});

describe("shutting down mid-check", () => {
  it("abandons the request instead of holding the process open", async () => {
    let seen: AbortSignal | undefined;
    const fetchImpl = ((_url: string, init: { signal?: AbortSignal }) => {
      seen = init.signal;
      // A request that never answers, which is what a hung registry looks like.
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }) as unknown as typeof fetch;

    startUpdateCheck({ fetchImpl, env: {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen?.aborted).toBe(false);

    // An in-flight request is an open handle, and an open handle keeps Node
    // alive well past the client that was waiting for the answer.
    cancelUpdateCheck();
    expect(seen?.aborted).toBe(true);
    expect(takeUpdateNotice()).toBeUndefined();
  });
});

describe("the notice a caller sees", () => {
  it("rides beside the answer without touching it, and only once", async () => {
    setUpdateNoticeForTest("version 9.9.9 is available");

    const first = await callTool();
    // The payload is still a JSON document on its own: a sentence appended to
    // it would stop it parsing.
    expect(JSON.parse(first[0]!)).toEqual({ ok: true });
    expect(first).toHaveLength(2);
    expect(first[1]).toContain("9.9.9");

    // A line repeated on every call spends the caller's context on something
    // they read the first time.
    const second = await callTool();
    expect(second).toHaveLength(1);
    expect(JSON.parse(second[0]!)).toEqual({ ok: true });
  });

  it("is absent entirely when the running version is current", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ "dist-tags": { latest: "0.0.1" } }), { status: 200 })) as unknown as typeof fetch;
    startUpdateCheck({ fetchImpl, env: {} });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(takeUpdateNotice()).toBeUndefined();
    expect(await callTool()).toHaveLength(1);
  });
});
