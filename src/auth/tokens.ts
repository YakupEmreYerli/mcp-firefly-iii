import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { SignJWT, exportJWK } from "jose";
import type { Config } from "../config.js";
import type { AuthState } from "./state.js";

export const AUTH_SUBJECT = "firefly-user";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function issueAccessToken(state: AuthState, issuer: string, resource: string, scopes: string[]): Promise<string> {
  return new SignJWT({ scope: scopes.join(" ") })
    .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: "firefly-embedded" })
    .setIssuer(issuer)
    .setAudience(resource)
    .setSubject(AUTH_SUBJECT)
    .setIssuedAt()
    .setJti(randomBytes(16).toString("hex"))
    .setExpirationTime("1h")
    .sign(state.privateKey);
}

export function issueRefreshToken(state: AuthState, clientId: string, scopes: string[]): string {
  const token = randomBytes(48).toString("base64url");
  state.addRefresh({
    hash: hashToken(token), clientId, subject: AUTH_SUBJECT, scopes,
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
  });
  return token;
}

export async function rotateRefreshToken(
  state: AuthState,
  token: string,
  clientId: string,
  issuer: string,
  resource: string,
): Promise<{ access_token: string; refresh_token: string; scope: string }> {
  const wanted = hashToken(token);
  const record = state.refreshTokens.find((item) => {
    const a = Buffer.from(item.hash, "hex");
    const b = Buffer.from(wanted, "hex");
    return a.length === b.length && timingSafeEqual(a, b) && item.clientId === clientId && item.expiresAt > Date.now();
  });
  if (!record) throw new Error("invalid_grant");
  state.removeRefresh(record.hash);
  const access = await issueAccessToken(state, issuer, resource, record.scopes);
  return { access_token: access, refresh_token: issueRefreshToken(state, clientId, record.scopes), scope: record.scopes.join(" ") };
}

export async function publicJwk(state: AuthState): Promise<JsonWebKey> {
  return exportJWK(state.publicKey);
}
