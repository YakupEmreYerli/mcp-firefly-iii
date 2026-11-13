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

/**
 * Refresh-token rotation that survives a lost response, with reuse detection.
 *
 * Upstream deleted the presented token the moment its successor was minted.
 * If that response never reached the client (a proxy timeout, a VPN blip, a
 * restart mid-request), or two of the client's sessions refreshed at once, the
 * client was left holding a deleted token and had to be connected again by
 * hand. Nothing was logged.
 *
 * Here a rotated token is only *superseded* once one of its successors has
 * actually been used, which is the proof the client received it:
 *   - presenting the old token while no successor has been used mints another
 *     successor (the lost-response retry, however much later it comes);
 *   - presenting it within `graceMs` of the first successor's use is allowed
 *     (two requests that were in flight together);
 *   - presenting it after that is reuse of a superseded token, which only a
 *     copy of the token can do. Every refresh token descended from the same
 *     login is revoked, so a thief and the real client are both cut off and
 *     the owner sees a reconnect prompt instead of a silent second session.
 * Successors that lost the race are refused once the grace has passed, and
 * superseded records are kept for a day so reuse is recognised, then dropped.
 */
export const DEFAULT_REFRESH_GRACE_SECONDS = 120;
export const TOMBSTONE_MS = 24 * 60 * 60 * 1000;
const REFRESH_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

export function refreshReuseGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.MCP_REFRESH_REUSE_GRACE_SECONDS ?? String(DEFAULT_REFRESH_GRACE_SECONDS));
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 3600) * 1000 : 0;
}

export type RefreshRejectReason =
  | "unknown_token" | "client_mismatch" | "expired" | "superseded_sibling" | "reuse_detected";

/** Why a refresh was refused, for the operator's log. Never sent to the client. */
export class RefreshRejected extends Error {
  constructor(readonly reason: RefreshRejectReason, readonly revoked = 0) {
    super("invalid_grant");
  }
}

export function issueRefreshToken(
  state: AuthState,
  clientId: string,
  scopes: string[],
  lineage: { familyId?: string; parentHash?: string } = {},
  now: number = Date.now(),
): string {
  const token = randomBytes(48).toString("base64url");
  const hash = hashToken(token);
  state.addRefresh({
    hash, clientId, subject: AUTH_SUBJECT, scopes,
    expiresAt: now + REFRESH_LIFETIME_MS,
    familyId: lineage.familyId ?? hash,
    ...(lineage.parentHash ? { parentHash: lineage.parentHash } : {}),
  }, now);
  return token;
}

export async function rotateRefreshToken(
  state: AuthState,
  token: string,
  clientId: string,
  issuer: string,
  resource: string,
  options: { graceMs?: number; now?: number } = {},
): Promise<{ access_token: string; refresh_token: string; scope: string }> {
  const graceMs = options.graceMs ?? refreshReuseGraceMs();
  const now = options.now ?? Date.now();
  const wanted = Buffer.from(hashToken(token), "hex");
  const record = state.refreshTokens.find((item) => {
    const a = Buffer.from(item.hash, "hex");
    return a.length === wanted.length && timingSafeEqual(a, wanted);
  });
  if (!record) throw new RefreshRejected("unknown_token");
  if (record.clientId !== clientId) throw new RefreshRejected("client_mismatch");
  if (record.expiresAt <= now) throw new RefreshRejected("expired");
  const familyId = record.familyId ?? record.hash;

  if (record.committedAt !== undefined && now - record.committedAt > graceMs) {
    const revoked = state.revokeFamily(familyId);
    throw new RefreshRejected("reuse_detected", revoked);
  }
  const parent = record.parentHash ? state.refreshTokens.find((item) => item.hash === record.parentHash) : undefined;
  if (parent?.committedAt !== undefined && parent.committedChild !== record.hash && now - parent.committedAt > graceMs) {
    state.removeRefresh(record.hash);
    throw new RefreshRejected("superseded_sibling");
  }
  if (parent && parent.committedAt === undefined) state.commitRefresh(parent.hash, record.hash, now);

  const access = await issueAccessToken(state, issuer, resource, record.scopes);
  return {
    access_token: access,
    refresh_token: issueRefreshToken(state, clientId, record.scopes, { familyId, parentHash: record.hash }, now),
    scope: record.scopes.join(" "),
  };
}

export async function publicJwk(state: AuthState): Promise<JsonWebKey> {
  return exportJWK(state.publicKey);
}
