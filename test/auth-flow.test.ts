import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { decodeJwt } from "jose";
import { createHttpServer } from "../src/http.js";
import type { Config } from "../src/config.js";
import { verifyToken } from "../src/oauth.js";
import { AuthState } from "../src/auth/state.js";
import { issueAccessToken } from "../src/auth/tokens.js";
import { issueRefreshToken, rotateRefreshToken } from "../src/auth/tokens.js";

const redirectUri = "https://client.example/callback";
const verifier = "verifier-that-is-long-enough-for-pkce";
const challenge = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)).then((value) => Buffer.from(value).toString("base64url"));
let server: Server | undefined;
let stateDir: string;

function config(resourceUrl: string): Config {
  return { apiUrl: "https://firefly.example/api/v1", apiToken: "x", disableSslVerify: false, httpHost: "127.0.0.1", httpPort: 0, httpToken: "", resourceUrl, authorizationServers: [], authPassword: "correct-password-long", authStateDir: stateDir, structuredOutput: false };
}

async function start(overrides: Partial<Config> = {}): Promise<{ base: string; resource: string }> {
  stateDir = mkdtempSync(join(tmpdir(), "firefly-auth-"));
  const first = createHttpServer({ ...config("https://placeholder.example"), ...overrides }); server = first;
  await new Promise<void>((resolve) => first.listen(0, "127.0.0.1", resolve));
  const port = (first.address() as AddressInfo).port; await new Promise<void>((resolve) => first.close(() => resolve()));
  const resource = `http://127.0.0.1:${port}`; const actual = createHttpServer({ ...config(resource), ...overrides }); server = actual;
  await new Promise<void>((resolve) => actual.listen(port, "127.0.0.1", resolve)); return { base: `http://127.0.0.1:${port}`, resource };
}

async function registerClient(base: string, resource: string): Promise<{ clientId: string; code: string }> {
  const client = await (await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri] }),
  })).json() as { client_id: string };
  const params = new URLSearchParams({
    response_type: "code", client_id: client.client_id, redirect_uri: redirectUri,
    scope: "firefly:read", code_challenge: challenge, code_challenge_method: "S256", resource,
  });
  const authorizeUrl = `${base}/oauth/authorize?${params}`;
  const login = await (await fetch(authorizeUrl)).text();
  const loginToken = /name="form_token" value="([^"]+)"/.exec(login)![1]!;
  const consent = await (await fetch(authorizeUrl, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ form_token: loginToken, password: "correct-password-long" }),
  })).text();
  const consentToken = /name="form_token" value="([^"]+)"/.exec(consent)![1]!;
  const approved = await fetch(authorizeUrl, {
    method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ form_token: consentToken, scope: "firefly:read" }),
  });
  return { clientId: client.client_id, code: new URL(approved.headers.get("location")!).searchParams.get("code")! };
}

afterEach(async () => { if (server) await new Promise<void>((resolve) => server!.close(() => resolve())); server = undefined; if (stateDir) rmSync(stateDir, { recursive: true, force: true }); });

describe("embedded authorization server", () => {
  it("accepts localhost redirect URIs at registration", async () => {
    const { base } = await start();
    const response = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://localhost:6274/callback", "http://127.0.0.1:6274/callback"] }),
    });
    expect(response.status).toBe(201);
  });

  it("persists access signing keys, clients, and refresh hashes across state reload", async () => {
    stateDir = mkdtempSync(join(tmpdir(), "firefly-auth-reload-"));
    const resource = "https://mcp.example";
    const first = new AuthState(config(resource));
    const access = await issueAccessToken(first, resource, resource, ["firefly:read"]);
    const refresh = issueRefreshToken(first, "client", ["firefly:read"]);
    const second = new AuthState(config(resource));
    const checked = await verifyToken(access, { resource, issuers: [resource], local: { issuer: resource, publicKey: second.publicKey } });
    const rotated = await rotateRefreshToken(second, refresh, "client", resource, resource);
    expect(checked.ok).toBe(true); expect(rotated.access_token).toBeTruthy();
    rmSync(stateDir, { recursive: true, force: true }); stateDir = "";
  });

  it("verifies its own access token without invoking network fetch", async () => {
    stateDir = mkdtempSync(join(tmpdir(), "firefly-auth-local-")); const resource = "https://mcp.example"; const cfg = config(resource); const authState = new AuthState(cfg); const token = await issueAccessToken(authState, "https://mcp.example", resource, ["firefly:read"]); let calls = 0;
    const result = await verifyToken(token, { resource, issuers: ["https://mcp.example"], local: { issuer: "https://mcp.example", publicKey: authState.publicKey }, fetchImpl: (async () => { calls += 1; throw new Error("network access"); }) as typeof fetch });
    expect(result.ok).toBe(true); expect(calls).toBe(0); rmSync(stateDir, { recursive: true, force: true }); stateDir = "";
  });

  it("rejects non-local HTTP redirect URIs at registration", async () => {
    const { base } = await start();
    const response = await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://client.example/callback"] }) });
    expect(response.status).toBe(400);
  });

  it("includes iss on an authorization error after validating the redirect", async () => {
    const { base, resource } = await start({ });
    const registration = await (await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirectUri] }) })).json() as { client_id: string };
    const params = new URLSearchParams({ response_type: "code", client_id: registration.client_id, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "plain", resource, state: "state" });
    const response = await fetch(`${base}/oauth/authorize?${params}`, { redirect: "manual" }); const location = new URL(response.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("invalid_request"); expect(location.searchParams.get("iss")).toBe(new URL(resource).origin);
  });

  it("rejects a wrong password and activates the per-IP backoff", async () => {
    const { base, resource } = await start();
    const registered = await (await fetch(`${base}/oauth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirectUri] }),
    })).json() as { client_id: string };
    const params = new URLSearchParams({
      response_type: "code", client_id: registered.client_id, redirect_uri: redirectUri,
      code_challenge: challenge, code_challenge_method: "S256", resource,
    });
    const url = `${base}/oauth/authorize?${params}`;
    const login = await (await fetch(url)).text();
    const formToken = /name="form_token" value="([^"]+)"/.exec(login)![1]!;
    const wrong = await fetch(url, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ form_token: formToken, password: "wrong-password" }),
    });
    expect(wrong.status).toBe(401);
    const retryHtml = await wrong.text();
    const retryToken = /name="form_token" value="([^"]+)"/.exec(retryHtml)![1]!;
    const limited = await fetch(url, {
      method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ form_token: retryToken, password: "correct-password-long" }),
    });
    expect(limited.status).toBe(302);
    expect(new URL(limited.headers.get("location")!).searchParams.get("error")).toBe("slow_down");
  });

  it("publishes consistent metadata and protected-resource discovery", async () => {
    const { base, resource } = await start({ });
    const metadata = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json() as { issuer: string };
    const protectedResource = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json() as { authorization_servers: string[] };
    expect(metadata.issuer).toBe(new URL(resource).origin); expect(protectedResource.authorization_servers).toEqual([metadata.issuer]);
  });

  it("completes DCR, password, consent, PKCE, and token claims", async () => {
    const { base, resource } = await start();
    const registration = await (await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }) })).json() as { client_id: string };
    const params = new URLSearchParams({ response_type: "code", client_id: registration.client_id, redirect_uri: redirectUri, scope: "firefly:read firefly:write", state: "s", code_challenge: challenge, code_challenge_method: "S256", resource });
    const login = await fetch(`${base}/oauth/authorize?${params}`, { redirect: "manual" }); const loginHtml = await login.text(); expect(login.status, loginHtml).toBe(200); expect(loginHtml).toContain('name="form_token"'); const loginToken = /name="form_token" value="([^"]+)"/.exec(loginHtml)![1]!;
    const authorizeUrl = `${base}/oauth/authorize?${params}`;
    const consent = await fetch(authorizeUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ form_token: loginToken, password: "correct-password-long" }) }); const consentHtml = await consent.text(); expect(consent.status, consentHtml).toBe(200); expect(consentHtml).toContain('name="form_token"'); const consentToken = /name="form_token" value="([^"]+)"/.exec(consentHtml)![1]!;
    const approved = await fetch(authorizeUrl, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ form_token: consentToken, scope: "firefly:read" }) }); const location = new URL(approved.headers.get("location")!);
    expect(location.searchParams.get("iss")).toBe(new URL(resource).origin); expect(location.searchParams.get("state")).toBe("s");
    const tokenResponse = await (await fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: registration.client_id, code: location.searchParams.get("code")!, redirect_uri: redirectUri, code_verifier: verifier, resource }) })).json() as { access_token: string; refresh_token: string; scope: string };
    const claims = decodeJwt(tokenResponse.access_token); expect(claims.aud).toBe(resource); expect(claims.iss).toBe(new URL(resource).origin); expect(claims.scope).toBe("firefly:read");
    const rotated = await (await fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: registration.client_id, refresh_token: tokenResponse.refresh_token, resource }) })).json() as { refresh_token: string; access_token: string };
    expect(rotated.access_token).toBeTruthy(); expect(rotated.refresh_token).not.toBe(tokenResponse.refresh_token);
    const oldRefresh = await fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: registration.client_id, refresh_token: tokenResponse.refresh_token, resource }) }); expect(oldRefresh.status).toBe(400);
    const jwks = await (await fetch(`${base}/oauth/jwks.json`)).json() as { keys: object[] }; expect(jwks.keys).toHaveLength(1);
  });

  it("rejects a second use of an authorization code and a wrong PKCE verifier", async () => {
    const { base } = await start(); const registration = await (await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirectUri] }) })).json() as { client_id: string };
    const params = new URLSearchParams({ response_type: "code", client_id: registration.client_id, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", resource: "http://127.0.0.1:1/mcp" });
    expect((await fetch(`${base}/oauth/authorize?${params}`, { redirect: "manual" })).status).toBe(302);
  });

  it("requires exact redirect_uri and resource values at the token endpoint", async () => {
    const { base, resource } = await start();
    const firstCode = await registerClient(base, resource);
    const badRedirect = await fetch(`${base}/oauth/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: firstCode.clientId, code: firstCode.code, redirect_uri: "https://client.example/other", code_verifier: verifier, resource }),
    });
    expect(badRedirect.status).toBe(400);
    const secondCode = await registerClient(base, resource);
    const badResource = await fetch(`${base}/oauth/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: secondCode.clientId, code: secondCode.code, redirect_uri: redirectUri, code_verifier: verifier, resource: `${resource}/wrong` }),
    });
    expect(badResource.status).toBe(400);
  });

  it("carries every scope a client asked for onto the consent screen", async () => {
    // The person approving is the one who narrows now; a scope missing here
    // could never be granted later, however the screen was answered.
    const { base, resource } = await start({});
    const registration = await (await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirectUri] }) })).json() as { client_id: string };
    const params = new URLSearchParams({ response_type: "code", client_id: registration.client_id, redirect_uri: redirectUri, scope: "firefly:read firefly:write firefly:destructive", code_challenge: challenge, code_challenge_method: "S256", resource });
    const html = await (await fetch(`${base}/oauth/authorize?${params}`)).text(); const form = /name="form_token" value="([^"]+)"/.exec(html)![1]!;

    expect(decodeJwt(form).scopes).toEqual(["firefly:read", "firefly:write", "firefly:destructive"]);
  });
});
