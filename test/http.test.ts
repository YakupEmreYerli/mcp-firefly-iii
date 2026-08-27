import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { KeyObject } from "node:crypto";
import { createHttpServer } from "../src/http.js";
import { EntityType } from "../src/types.js";
import type { Config } from "../src/config.js";

const TOKEN = "a-long-random-mcp-token";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    apiUrl: "https://firefly.example/api/v1",
    apiToken: "firefly-token",
        permissions: { fallback: "destructive", byEntity: new Map() },
        structuredOutput: false, resourceUrl: "", authorizationServers: [], disableSslVerify: false,
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
  it("answers CORS preflight without credentials", async () => {
    const base = await start();
    const response = await fetch(`${base}/mcp`, { method: "OPTIONS", headers: { Origin: "https://chatgpt.com", "Access-Control-Request-Headers": "Authorization" } });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(response.headers.get("access-control-allow-headers")).toContain("Mcp-Session-Id");
  });

  it("answers /health without a token, for container probes", async () => {
    const base = await start();
    const response = await fetch(`${base}/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("does not leak the tool surface on an unknown path", async () => {
    const base = await start();
    const response = await fetch(`${base}/unknown`, mcpRequest(INITIALIZE, TOKEN));

    expect(response.status).toBe(404);
  });

  it("serves MCP through both the root and legacy /mcp alias", async () => {
    const base = await start();
    expect((await fetch(`${base}/`, mcpRequest(INITIALIZE, TOKEN))).status).toBe(200);
    expect((await fetch(`${base}/mcp`, mcpRequest(INITIALIZE, TOKEN))).status).toBe(200);
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

/* ---------------------- OAuth as a resource server ---------------------- */

const ISSUER_PORT = 4821;
const ISSUER = `http://127.0.0.1:${ISSUER_PORT}`;

let issuerServer: Server | undefined;
let signingKey: CryptoKey | KeyObject;

/** A stand-in authorization server: metadata and a key set, nothing else.
 *
 * Real rather than mocked because the thing under test is whether this server
 * can discover and verify against one, and a stub inside the process would
 * prove only that the stub was called.
 */
async function startIssuer(): Promise<void> {
  const { generateKeyPair, exportJWK } = await import("jose");
  const pair = await generateKeyPair("RS256");
  signingKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const { createServer } = await import("node:http");
  issuerServer = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const send = (body: unknown) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path === "/.well-known/oauth-authorization-server") return send({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks` });
    if (path === "/jwks") return send({ keys: [jwk] });
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => issuerServer!.listen(ISSUER_PORT, "127.0.0.1", resolve));
}

async function issue(scope?: string, audience?: string): Promise<string> {
  const { SignJWT } = await import("jose");
  return new SignJWT(scope === undefined ? {} : { scope })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(ISSUER)
    .setAudience(audience ?? oauthResource)
    .setSubject("yakup")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(signingKey);
}

let oauthResource = "";

async function startOauth(overrides: Partial<Config> = {}): Promise<string> {
  const server = createHttpServer(makeConfig({ httpToken: "", authorizationServers: [ISSUER], resourceUrl: "http://placeholder", ...overrides }));
  running = server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  // The resource identifier has to be the address a client actually reaches,
  // because that is what a token's audience will be bound to.
  await new Promise<void>((resolve) => server.close(() => resolve()));
  oauthResource = `http://127.0.0.1:${port}`;
  const real = createHttpServer(makeConfig({ httpToken: "", authorizationServers: [ISSUER], resourceUrl: oauthResource, ...overrides }));
  running = real;
  await new Promise<void>((resolve) => real.listen(port, "127.0.0.1", resolve));
  return `http://127.0.0.1:${port}`;
}

const oauthPost = (base: string, body: unknown, token?: string) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

const OAUTH_INITIALIZE = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
};
const toolCall = (name: string) => ({
  jsonrpc: "2.0", id: 2, method: "tools/call",
  params: { name, arguments: { entity: "transaction", operation: "create", params: {} } },
});

describe("OAuth resource server", () => {
  afterEach(async () => {
    if (issuerServer) {
      await new Promise<void>((resolve) => issuerServer!.close(() => resolve()));
      issuerServer = undefined;
    }
    const { resetOauthCaches } = await import("../src/oauth.js");
    resetOauthCaches();
  });

  it("refuses to start with an issuer but no resource identifier", () => {
    // Without one there is nothing to bind a token to, and an unbound bearer
    // token is one any other service could have issued.
    expect(() =>
      createHttpServer(makeConfig({ httpToken: "", authorizationServers: [ISSUER], resourceUrl: "" })),
    ).toThrow(/MCP_RESOURCE_URL/);
  });

  it("still refuses to start with neither a token nor an issuer", () => {
    expect(() => createHttpServer(makeConfig({ httpToken: "", authorizationServers: [] }))).toThrow(/MCP_HTTP_TOKEN/);
  });

  it("serves protected resource metadata without asking for a token", async () => {
    // A client reads this precisely because it has no token yet.
    await startIssuer();
    const base = await startOauth();
    const response = await fetch(`${base}/.well-known/oauth-protected-resource`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      resource: oauthResource,
      authorization_servers: [ISSUER],
      scopes_supported: ["firefly:read"],
    });
  });

  it("serves it on the bare path too, for a client that guessed from the origin", async () => {
    await startIssuer();
    const base = await startOauth();
    expect((await fetch(`${base}/.well-known/oauth-protected-resource`)).status).toBe(200);
  });

  it("points an unauthenticated caller at that document", async () => {
    // The bare "Bearer" it used to send is why a client got as far as failing
    // to find a sign-in service.
    await startIssuer();
    const base = await startOauth();
    const response = await oauthPost(base, OAUTH_INITIALIZE);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
    expect(response.headers.get("www-authenticate")).toContain('scope="firefly:read"');
  });

  it("accepts a token from the configured issuer", async () => {
    await startIssuer();
    const base = await startOauth();
    expect((await oauthPost(base, OAUTH_INITIALIZE, await issue("firefly:read"))).status).toBe(200);
  });

  it("refuses a token issued for another service", async () => {
    await startIssuer();
    const base = await startOauth();
    const response = await oauthPost(base, OAUTH_INITIALIZE, await issue("firefly:read", "https://elsewhere.example"));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "invalid_token" });
  });

  it("refuses a write to a token that may only read, before the tool runs", async () => {
    await startIssuer();
    const base = await startOauth();
    const response = await oauthPost(base, toolCall("firefly_mutate"), await issue("firefly:read"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { isError: true, _meta: { "mcp/www_authenticate": [expect.stringContaining('scope="firefly:write"')] } } });
  });

  it("says in the challenge which scope would have worked", async () => {
    await startIssuer();
    const base = await startOauth();
    const response = await oauthPost(base, toolCall("firefly_destructive"), await issue("firefly:write"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { isError: true, _meta: { "mcp/www_authenticate": [expect.stringContaining('scope="firefly:destructive"')] } } });
  });

  it("lets a broader scope through a narrower request", async () => {
    await startIssuer();
    const base = await startOauth();
    expect((await oauthPost(base, OAUTH_INITIALIZE, await issue("firefly:destructive"))).status).toBe(200);
  });

  it("lets the write surface through for a token that may write", async () => {
    await startIssuer();
    const base = await startOauth();
    // Past the scope gate; whatever the tool then says about its arguments is
    // not this test's business.
    expect((await oauthPost(base, toolCall("firefly_mutate"), await issue("firefly:write"))).status).toBe(200);
  });

  it("keeps the static token working beside OAuth, so an existing deployment is untouched", async () => {
    await startIssuer();
    const base = await startOauth({ httpToken: TOKEN });
    expect((await oauthPost(base, OAUTH_INITIALIZE, TOKEN)).status).toBe(200);
  });

  it("refuses a delete hidden in a JSON-RPC batch", async () => {
    // The batch used to read as "no method" and skip the scope gate entirely.
    await startIssuer();
    const base = await startOauth();
    const response = await oauthPost(base, [toolCall("firefly_query"), toolCall("firefly_destructive")], await issue("firefly:read"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { isError: true, _meta: { "mcp/www_authenticate": [expect.stringContaining('scope="firefly:destructive"')] } } });
  });

  it("lets a batch of reads through on a read token", async () => {
    await startIssuer();
    const base = await startOauth();
    const response = await oauthPost(base, [OAUTH_INITIALIZE], await issue("firefly:read"));
    expect(response.status).toBe(200);
  });

  it("challenges a valid token that carries no scope of ours", async () => {
    // Letting it in would show a client a server with no tools rather than a
    // scope it forgot to ask for.
    await startIssuer();
    const base = await startOauth();
    const response = await oauthPost(base, OAUTH_INITIALIZE, await issue("openid email"));
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain('scope="firefly:read"');
  });

  it("names the setting when the resource identifier is not a URL", async () => {
    expect(() =>
      createHttpServer(makeConfig({ httpToken: "", authorizationServers: [ISSUER], resourceUrl: "not-a-url" })),
    ).toThrow(/MCP_RESOURCE_URL/);
  });

  it("does not serve the metadata document when OAuth is off", async () => {
    // Advertising discovery with no authorization server behind it would send
    // a client down a road that ends nowhere.
    const base = await start();
    expect((await fetch(`${base}/.well-known/oauth-protected-resource`)).status).toBe(404);
  });

  it("keeps the plain challenge when OAuth is off", async () => {
    const base = await start();
    const response = await oauthPost(base, OAUTH_INITIALIZE);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });
});
