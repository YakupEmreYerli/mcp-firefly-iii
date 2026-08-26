import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createHttpServer } from "../src/http.js";
import { EntityType } from "../src/types.js";
import type { Config } from "../src/config.js";

const TOKEN = "a-long-random-mcp-token";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    apiUrl: "https://firefly.example/api/v1",
    apiToken: "firefly-token",
    readOnly: false,
    directMode: false,
    enabledEntities: new Set(Object.values(EntityType)),
    disableSslVerify: false,
    logLevel: "INFO",
    httpHost: "127.0.0.1",
    httpPort: 0,
    httpToken: TOKEN,
    ...overrides,
  };
}

let running: Server | undefined;

afterEach(async () => {
  if (running) {
    await new Promise<void>((resolve) => running!.close(() => resolve()));
    running = undefined;
  }
});

async function start(config: Config = makeConfig()): Promise<string> {
  const server = createHttpServer(config);
  running = server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function mcpRequest(body: unknown, token?: string): RequestInit {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  return { method: "POST", headers, body: JSON.stringify(body) };
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  },
};

describe("startup", () => {
  it("refuses to start without a token rather than listening unauthenticated", () => {
    expect(() => createHttpServer(makeConfig({ httpToken: "" }))).toThrow(/MCP_HTTP_TOKEN/);
  });

  it("treats a whitespace-only token as unset", () => {
    expect(() => createHttpServer(makeConfig({ httpToken: "   " }))).toThrow(/MCP_HTTP_TOKEN/);
  });
});

describe("authentication", () => {
  it("rejects a request with no Authorization header", async () => {
    const base = await start();
    const response = await fetch(`${base}/mcp`, mcpRequest(INITIALIZE));

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  it("rejects a wrong token", async () => {
    const base = await start();
    const response = await fetch(`${base}/mcp`, mcpRequest(INITIALIZE, "wrong"));

    expect(response.status).toBe(401);
  });

  it("rejects a token that is a prefix of the real one", async () => {
    const base = await start();
    const response = await fetch(`${base}/mcp`, mcpRequest(INITIALIZE, TOKEN.slice(0, -1)));

    expect(response.status).toBe(401);
  });

  it("rejects a non-Bearer authorization scheme carrying the right token", async () => {
    const base = await start();
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${TOKEN}` },
      body: JSON.stringify(INITIALIZE),
    });

    expect(response.status).toBe(401);
  });

  it("accepts the configured token and speaks MCP", async () => {
    const base = await start();
    const response = await fetch(`${base}/mcp`, mcpRequest(INITIALIZE, TOKEN));

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { result?: { serverInfo?: { name?: string } } };
    expect(payload.result?.serverInfo?.name).toBe("Firefly MCP Server");
  });
});

describe("routing", () => {
  it("answers /health without a token, for container probes", async () => {
    const base = await start();
    const response = await fetch(`${base}/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("does not leak the tool surface on an unknown path", async () => {
    const base = await start();
    const response = await fetch(`${base}/`, mcpRequest(INITIALIZE, TOKEN));

    expect(response.status).toBe(404);
  });

  it("ignores a query string when matching the path", async () => {
    const base = await start();
    const response = await fetch(`${base}/health?probe=1`);

    expect(response.status).toBe(200);
  });

  it("refuses a method the transport does not handle", async () => {
    const base = await start();
    const response = await fetch(`${base}/mcp`, { method: "PUT" });

    expect(response.status).toBe(404);
  });
});

describe("request body", () => {
  it("refuses a body larger than the limit instead of buffering it", async () => {
    const base = await start();
    const huge = { jsonrpc: "2.0", id: 1, method: "initialize", params: { pad: "x".repeat(1_100_000) } };
    const response = await fetch(`${base}/mcp`, mcpRequest(huge, TOKEN));

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error?: string };
    expect(payload.error).toMatch(/too large/i);
  });

  it("answers malformed JSON with an error rather than crashing the process", async () => {
    const base = await start();
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: "{not json",
    });

    expect(response.status).toBe(400);
  });
});

describe("statelessness", () => {
  it("serves repeated requests reusing the same JSON-RPC id", async () => {
    const base = await start();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await fetch(`${base}/mcp`, mcpRequest(INITIALIZE, TOKEN));
      expect(response.status).toBe(200);
    }
  });

  it("serves concurrent requests without their ids colliding", async () => {
    const base = await start();
    const responses = await Promise.all(
      [0, 1, 2, 3, 4].map(() => fetch(`${base}/mcp`, mcpRequest(INITIALIZE, TOKEN))),
    );

    for (const response of responses) expect(response.status).toBe(200);
    const payloads = await Promise.all(
      responses.map((response) => response.json() as Promise<{ id?: number }>),
    );
    expect(payloads.map((payload) => payload.id)).toEqual([1, 1, 1, 1, 1]);
  });
});
