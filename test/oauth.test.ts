import { beforeEach, describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyObject } from "jose";
import {
  MINIMUM_SCOPE,
  SCOPES,
  allowedBy,
  challenge,
  metadataUrlFor,
  policyForScopes,
  resetOauthCaches,
  resourceMetadata,
  accessForRequest,
  grantsAnything,
  scopeFor,
  verifyToken,
} from "../src/oauth.js";

const ISSUER = "https://as.example.com";
const RESOURCE = "https://mcp.example.com";

describe("scope hierarchy", () => {
  it("lets a read scope read", () => {
    expect([...allowedBy([SCOPES.read])]).toEqual(["read"]);
  });

  it("lets a write scope read as well, since broader implies narrower", () => {
    // Otherwise a client would have to hold three scopes to do one thing.
    expect(allowedBy([SCOPES.write])).toEqual(new Set(["read", "write"]));
  });

  it("lets a destructive scope do everything", () => {
    expect(allowedBy([SCOPES.destructive])).toEqual(new Set(["read", "write", "destructive"]));
  });

  it("ignores a scope from another resource server", () => {
    // A token may legitimately carry scopes for several audiences.
    expect(allowedBy(["email", "openid", "files:write"])).toEqual(new Set());
  });

  it("challenges for the least privilege that is useful", () => {
    expect(MINIMUM_SCOPE).toBe(SCOPES.read);
  });
});

describe("scopes become the permission policy the registry already gates on", () => {
  it("maps write to a policy that permits writes but not deletes", () => {
    const policy = policyForScopes([SCOPES.write]);
    expect(policy.fallback).toBe("write");
  });

  it("maps destructive to the widest policy", () => {
    expect(policyForScopes([SCOPES.destructive]).fallback).toBe("destructive");
  });

  it("grants nothing for a token carrying no scope of ours", () => {
    // Failing open here would make every unscoped token a full-access token.
    expect(policyForScopes([]).fallback).toBe("none");
    expect(policyForScopes(["openid"]).fallback).toBe("none");
  });
});

describe("the access a request needs", () => {
  const call = (name: string) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } });

  it("reads the risk off the surface rather than the operation inside it", () => {
    expect(accessForRequest(call("firefly_mutate"))).toBe("write");
    expect(accessForRequest(call("firefly_destructive"))).toBe("destructive");
  });

  it("asks no more than the minimum for a read surface", () => {
    expect(accessForRequest(call("firefly_query"))).toBeUndefined();
    expect(accessForRequest(call("firefly_get_schema"))).toBeUndefined();
  });

  it("asks no more than the minimum for handshake traffic", () => {
    expect(accessForRequest({ jsonrpc: "2.0", id: 1, method: "initialize" })).toBeUndefined();
    expect(accessForRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" })).toBeUndefined();
  });

  it("sees a delete hidden in a JSON-RPC batch", () => {
    // A batch read as "no method" and skipped the check entirely. The registry
    // still refused the call, so nothing got through — but the client was told
    // the wrong thing about why.
    expect(accessForRequest([call("firefly_query"), call("firefly_destructive")])).toBe("destructive");
  });

  it("takes the widest access in a batch, not the first", () => {
    expect(accessForRequest([call("firefly_destructive"), call("firefly_mutate")])).toBe("destructive");
    expect(accessForRequest([call("firefly_mutate"), call("firefly_destructive")])).toBe("destructive");
  });

  it("asks for nothing extra for a batch of reads", () => {
    expect(accessForRequest([call("firefly_query"), call("firefly_query")])).toBeUndefined();
  });

  it("does not fall over on a body that is not a request at all", () => {
    for (const body of [undefined, null, "", 7, [], {}, [null], [[]]]) {
      expect(() => accessForRequest(body)).not.toThrow();
    }
  });

  it("names the scope that grants an access level", () => {
    expect(scopeFor("write")).toBe(SCOPES.write);
    expect(scopeFor("destructive")).toBe(SCOPES.destructive);
  });
});

describe("a token that grants nothing this server understands", () => {
  it("is recognised as granting nothing", () => {
    expect(grantsAnything([])).toBe(false);
    expect(grantsAnything(["openid", "email"])).toBe(false);
  });

  it("is distinguished from one that grants something", () => {
    expect(grantsAnything([SCOPES.read])).toBe(true);
  });
});

describe("protected resource metadata", () => {
  it("names the resource a token must be bound to", () => {
    expect(resourceMetadata(RESOURCE, [ISSUER]).resource).toBe(RESOURCE);
  });

  it("points at the authorization servers a client should go to", () => {
    expect(resourceMetadata(RESOURCE, [ISSUER]).authorization_servers).toEqual([ISSUER]);
  });

  it("advertises the minimum rather than everything, so a client asks small first", () => {
    expect(resourceMetadata(RESOURCE, [ISSUER]).scopes_supported).toEqual([MINIMUM_SCOPE]);
  });

  it("has no path to insert when the resource is an origin", () => {
    expect(metadataUrlFor("https://mcp.example.com")).toBe(
      "https://mcp.example.com/.well-known/oauth-protected-resource",
    );
  });

  it("says which setting is wrong when the resource is not a URL", () => {
    // "Invalid URL" alone leaves an operator hunting through every setting.
    expect(() => metadataUrlFor("not-a-url")).toThrow(/MCP_RESOURCE_URL/);
  });

});

describe("the WWW-Authenticate challenge", () => {
  it("carries where to discover authorization, which is what makes a 401 actionable", () => {
    const header = challenge({ resource: RESOURCE, scope: MINIMUM_SCOPE });
    expect(header).toContain('resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"');
    expect(header).toContain('scope="firefly:read"');
    expect(header.startsWith("Bearer ")).toBe(true);
  });

  it("names the error when there is one", () => {
    expect(challenge({ resource: RESOURCE, scope: SCOPES.write, error: "insufficient_scope" })).toContain(
      'error="insufficient_scope"',
    );
  });

  it("keeps a quoted reason from breaking the header it travels in", () => {
    const header = challenge({ resource: RESOURCE, scope: MINIMUM_SCOPE, error: "invalid_token", description: 'bad "aud" claim' });
    expect(header).toContain("error_description=\"bad 'aud' claim\"");
    expect(header.match(/"/g)?.length ?? 0).toBe(8);
  });
});

/* ------------------------------------------------------------------ */

let privateKey: KeyObject | CryptoKey;
let jwk: JWK;

/** A stub authorization server: metadata plus a JWKS, nothing else. */
function stubFetch(overrides: { metadata?: unknown; metadataStatus?: number; seen?: string[] } = {}): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    overrides.seen?.push(url);
    if (url.endsWith("/jwks")) {
      return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "Content-Type": "application/json" } });
    }
    if (url.includes(".well-known")) {
      const status = overrides.metadataStatus ?? 200;
      if (status !== 200) return new Response("no", { status });
      const body = overrides.metadata ?? { issuer: ISSUER, jwks_uri: `${ISSUER}/jwks` };
      return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
    }
    return new Response("no", { status: 404 });
  }) as typeof fetch;
}

async function mint(claims: { scope?: string; aud?: string; iss?: string; expires?: string } = {}): Promise<string> {
  return new SignJWT({ ...(claims.scope === undefined ? {} : { scope: claims.scope }) })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(claims.iss ?? ISSUER)
    .setAudience(claims.aud ?? RESOURCE)
    .setSubject("someone")
    .setIssuedAt()
    .setExpirationTime(claims.expires ?? "5m")
    .sign(privateKey);
}

const check = (token: string, extra: Partial<Parameters<typeof verifyToken>[1]> = {}) =>
  verifyToken(token, { resource: RESOURCE, issuers: [ISSUER], fetchImpl: stubFetch(), ...extra });

describe("verifying a token as a resource server", () => {
  beforeEach(async () => {
    resetOauthCaches();
    if (!privateKey) {
      const pair = await generateKeyPair("RS256");
      privateKey = pair.privateKey;
      jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    }
  });

  it("accepts a token signed by the configured issuer for this resource", async () => {
    const result = await check(await mint({ scope: "firefly:read" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.scopes).toEqual(new Set(["firefly:read"]));
  });

  it("refuses a token issued for another service", async () => {
    // The check that cannot be skipped: a bearer token is whoever holds it, so
    // without binding it here any token the client has would work.
    const result = await check(await mint({ aud: "https://elsewhere.example" }));
    expect(result.ok).toBe(false);
  });

  it("refuses an issuer that is not configured", async () => {
    const result = await check(await mint({ iss: "https://rogue.example" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not configured/);
  });

  it("does not contact an issuer it has not been configured with", async () => {
    // Otherwise a token would be able to name a host and have the server
    // fetch from it.
    const seen: string[] = [];
    await verifyToken(await mint({ iss: "https://rogue.example" }), {
      resource: RESOURCE,
      issuers: [ISSUER],
      fetchImpl: stubFetch({ seen }),
    });
    expect(seen).toEqual([]);
  });

  it("refuses an expired token", async () => {
    const result = await check(await mint({ expires: "-1s" }));
    expect(result.ok).toBe(false);
  });

  it("refuses something that is not a JWT at all", async () => {
    const result = await check("not-a-token");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not a JWT/);
  });

  it("refuses a token signed by a key the authorization server does not publish", async () => {
    const other = await generateKeyPair("RS256");
    const forged = await new SignJWT({ scope: "firefly:destructive" })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(ISSUER)
      .setAudience(RESOURCE)
      .setExpirationTime("5m")
      .sign(other.privateKey);
    expect((await check(forged)).ok).toBe(false);
  });

  it("refuses metadata whose issuer is not the one asked for", async () => {
    // A rogue metadata host would otherwise point verification at its own keys.
    const result = await check(await mint(), {
      fetchImpl: stubFetch({ metadata: { issuer: "https://someone-else.example", jwks_uri: `${ISSUER}/jwks` } }),
    });
    expect(result.ok).toBe(false);
  });

  it("reads a scope list given as an array", async () => {
    const token = await new SignJWT({ scp: ["firefly:read", "firefly:write"] })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(ISSUER).setAudience(RESOURCE).setExpirationTime("5m").sign(privateKey);
    const result = await check(token);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.scopes).toEqual(new Set(["firefly:read", "firefly:write"]));
  });

  it("treats a token with no scope claim as carrying none", async () => {
    const result = await check(await mint());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.scopes.size).toBe(0);
  });

  it("falls back to OpenID discovery when RFC 8414 has nothing", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url.endsWith("/jwks")) return new Response(JSON.stringify({ keys: [jwk] }));
      if (url.endsWith("/.well-known/oauth-authorization-server")) return new Response("no", { status: 404 });
      if (url.endsWith("/.well-known/openid-configuration")) {
        return new Response(JSON.stringify({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks` }));
      }
      return new Response("no", { status: 404 });
    }) as typeof fetch;
    const result = await verifyToken(await mint(), { resource: RESOURCE, issuers: [ISSUER], fetchImpl });
    expect(result.ok).toBe(true);
    expect(seen.some((u) => u.endsWith("/.well-known/openid-configuration"))).toBe(true);
  });

  it("discovers once and reuses it, rather than on every request", async () => {
    const seen: string[] = [];
    const fetchImpl = stubFetch({ seen });
    await verifyToken(await mint(), { resource: RESOURCE, issuers: [ISSUER], fetchImpl });
    const afterFirst = seen.filter((u) => u.includes(".well-known")).length;
    await verifyToken(await mint(), { resource: RESOURCE, issuers: [ISSUER], fetchImpl });
    expect(seen.filter((u) => u.includes(".well-known")).length).toBe(afterFirst);
  });

  it("does not cache a failed discovery, so a restarted authorization server recovers", async () => {
    // Caching the failure would leave this process refusing every token until
    // it too was restarted.
    const down = await verifyToken(await mint(), {
      resource: RESOURCE, issuers: [ISSUER], fetchImpl: stubFetch({ metadataStatus: 503 }),
    });
    expect(down.ok).toBe(false);
    const up = await check(await mint());
    expect(up.ok).toBe(true);
  });
});
