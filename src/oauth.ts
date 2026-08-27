import { createRemoteJWKSet, customFetch, decodeJwt, jwtVerify, type JWTPayload } from "jose";
import type { KeyObject } from "node:crypto";
import type { Access } from "./types.js";

/** The scopes this resource server understands.
 *
 * One per access level, because the risk split already exists: the three
 * execution surfaces were separated so a host could tell reading a balance
 * from deleting a transaction, and that is exactly the distinction a scope has
 * to carry. Inventing a second vocabulary would leave two things to keep in
 * step.
 */
export const SCOPES = {
  read: "firefly:read",
  write: "firefly:write",
  destructive: "firefly:destructive",
} as const satisfies Record<Access, string>;

/** Least privilege for a client that has not been told otherwise: the scope a
 * 401 challenges for, and what `scopes_supported` advertises as the minimum. */
export const MINIMUM_SCOPE = SCOPES.read;

/** Every scope this server defines, narrowest first. */
const ALL_SCOPE_VALUES: string[] = [SCOPES.read, SCOPES.write, SCOPES.destructive];

/** Broader implies narrower.
 *
 * The specification requires a server to account for this rather than making a
 * client hold three scopes to do one thing: a token good enough to delete is
 * good enough to read.
 */
const IMPLIES: Record<string, Access[]> = {
  [SCOPES.read]: ["read"],
  [SCOPES.write]: ["read", "write"],
  [SCOPES.destructive]: ["read", "write", "destructive"],
};

/** The access levels a set of granted scopes actually permits. */
export function allowedBy(scopes: Iterable<string>): Set<Access> {
  const allowed = new Set<Access>();
  for (const scope of scopes) for (const access of IMPLIES[scope] ?? []) allowed.add(access);
  return allowed;
}


/** Every scope worth asking for.
 *
 * What `scopes_supported` advertises and what a client that asks for nothing
 * is taken to want. The narrowing happens on the consent screen, by a person.
 */
export function scopesWithin(): string[] {
  return [...ALL_SCOPE_VALUES];
}

/** Keep only scopes this server defines; anything else is dropped in silence. */
export function grantedScopes(scopes: Iterable<string>): string[] {
  const known = new Set<string>(ALL_SCOPE_VALUES);
  return [...new Set(scopes)].filter((scope) => known.has(scope));
}

/** Which surface a tool name belongs to, in the default meta-tool mode. */
const SURFACE_ACCESS: Record<string, Access> = {
  firefly_mutate: "write",
  firefly_destructive: "destructive",
};

/** What a tool name needs, or undefined for a read.
 *
 * Direct mode names a tool after its entity and operation rather than after a
 * surface, so the default table finds nothing there and every call reads as a
 * read. The registry still refuses what the token cannot do, but the client is
 * told the wrong thing about why — the same failure a JSON-RPC batch caused.
 * `createHttpServer` supplies the map for that mode.
 */
export type AccessLookup = (tool: string) => Access | undefined;

const defaultLookup: AccessLookup = (tool) => SURFACE_ACCESS[tool];

const RANK: Record<Access, number> = { read: 1, write: 2, destructive: 3 };

/** The access a request needs, or undefined when the minimum is enough.
 *
 * Read off the surface rather than the entity and operation inside it. The
 * surfaces exist precisely to make the risk visible without inspecting the
 * call, and reproducing that judgement here would be a second place for it to
 * drift.
 *
 * JSON-RPC allows a batch, and a batch is where this went wrong first: an
 * array carrying a delete alongside a read read as "no method" and skipped the
 * check entirely. The registry still refused the call, so nothing got through
 * that should not have, but the client was told the wrong thing about why.
 * The answer for a batch is the widest access any member needs.
 */
export function accessForRequest(body: unknown, lookup: AccessLookup = defaultLookup): Access | undefined {
  if (Array.isArray(body)) {
    let widest: Access | undefined;
    for (const member of body) {
      const needed = accessForRequest(member, lookup);
      if (needed && (!widest || RANK[needed] > RANK[widest])) widest = needed;
    }
    return widest;
  }
  if (typeof body !== "object" || body === null) return undefined;
  const request = body as { method?: unknown; params?: { name?: unknown } };
  if (request.method !== "tools/call") return undefined;
  const tool = request.params?.name;
  return typeof tool === "string" ? lookup(tool) : undefined;
}

/** The scope that grants an access level, for a challenge. */
export function scopeFor(access: Access): string {
  return SCOPES[access];
}

/** Whether a token carries any scope this server recognises.
 *
 * A token that carries none is valid but useless here: every surface would be
 * empty and every call refused, which reads to a client as a server with
 * nothing in it rather than as a scope it forgot to ask for.
 */
export function grantsAnything(scopes: Iterable<string>): boolean {
  return allowedBy(scopes).size > 0;
}

export type ResourceMetadata = {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
};

/** RFC 9728 Protected Resource Metadata.
 *
 * `scopes_supported` lists all three, not the minimum: a client reads this to
 * decide what to ask for, and one that asks for `firefly:read` alone can never
 * be consented up to writing, however the consent screen is answered.
 */
export function resourceMetadata(resource: string, authorizationServers: string[]): ResourceMetadata {
  return {
    resource,
    authorization_servers: authorizationServers,
    scopes_supported: scopesWithin(),
    bearer_methods_supported: ["header"],
  };
}

/** Where a client discovers the protected-resource document at the clean origin. */
export function metadataUrlFor(resource: string): string {
  let url: URL;
  try {
    url = new URL(resource);
  } catch {
    // Reached from startup, where "Invalid URL" alone leaves an operator
    // hunting through every setting to find which one.
    throw new Error(`MCP_RESOURCE_URL must be an absolute https:// URL; got ${JSON.stringify(resource)}`);
  }
  return `${url.origin}/.well-known/oauth-protected-resource`;
}

/** A `WWW-Authenticate` challenge, per RFC 6750.
 *
 * `resource_metadata` is what turns a refusal into something a client can act
 * on: without it the 401 says only that a token is missing, which is why a
 * client trying to connect gets as far as failing to find a sign-in service.
 */
export function challenge(options: {
  resource: string;
  scope: string;
  error?: "invalid_token" | "insufficient_scope";
  description?: string;
}): string {
  const parts = [`Bearer resource_metadata="${metadataUrlFor(options.resource)}"`, `scope="${options.scope}"`];
  if (options.error) parts.splice(1, 0, `error="${options.error}"`);
  if (options.description) parts.push(`error_description="${options.description.replace(/"/g, "'")}"`);
  return parts.join(", ");
}

export type TokenCheck =
  | { ok: true; scopes: Set<string>; subject?: string }
  | { ok: false; reason: string };

/** Authorization server metadata, cached per issuer for the process lifetime.
 *
 * Discovery is two fetches on the first token from an issuer and none after.
 * A JWKS is cached by `jose` itself, which also refetches when a token arrives
 * signed by a key it has not seen, so a rotation does not need a restart.
 */
const metadataCache = new Map<string, Promise<{ jwks_uri: string }>>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** RFC 8414 inserts the path after the well-known segment; OpenID Connect
 * appends it. Clients are required to try both, and a server reading its own
 * authorization server's metadata is in the same position. */
function metadataCandidates(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  return [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}${path}/.well-known/openid-configuration`,
    `${url.origin}/.well-known/openid-configuration${path}`,
  ];
}

async function authorizationServerMetadata(issuer: string, fetchImpl: typeof fetch): Promise<{ jwks_uri: string }> {
  const cached = metadataCache.get(issuer);
  if (cached) return cached;

  const pending = (async () => {
    const failures: string[] = [];
    for (const candidate of metadataCandidates(issuer)) {
      try {
        const response = await fetchImpl(candidate, { headers: { Accept: "application/json" } });
        if (!response.ok) {
          failures.push(`${candidate} -> ${response.status}`);
          continue;
        }
        const document = (await response.json()) as { issuer?: unknown; jwks_uri?: unknown };
        // The issuer in the document must be the one asked for, or a rogue
        // metadata host could point verification at keys it controls.
        if (document.issuer !== issuer) {
          failures.push(`${candidate} -> issuer mismatch`);
          continue;
        }
        if (typeof document.jwks_uri !== "string") {
          failures.push(`${candidate} -> no jwks_uri`);
          continue;
        }
        return { jwks_uri: document.jwks_uri };
      } catch (error) {
        failures.push(`${candidate} -> ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`No usable metadata for issuer ${issuer}: ${failures.join("; ")}`);
  })();

  metadataCache.set(issuer, pending);
  // A failed discovery must not be cached, or one restart of the authorization
  // server would leave this process refusing every token until it is restarted
  // too.
  pending.catch(() => metadataCache.delete(issuer));
  return pending;
}

function scopesOf(payload: JWTPayload): Set<string> {
  const raw = payload.scope ?? (payload as { scp?: unknown }).scp;
  if (typeof raw === "string") return new Set(raw.split(" ").filter(Boolean));
  if (Array.isArray(raw)) return new Set(raw.filter((value): value is string => typeof value === "string"));
  return new Set();
}

/** Verify a bearer token as an OAuth 2.1 resource server.
 *
 * The audience check is the one that cannot be skipped. A token is a bearer
 * credential: without binding it to this server, any token the client holds
 * for any other service would be accepted here, and a malicious server could
 * collect one and replay it. The specification states it twice — accept only
 * tokens issued for this resource, and pass none of them on.
 */
export async function verifyToken(
  token: string,
  options: { resource: string; issuers: string[]; fetchImpl?: typeof fetch; local?: { issuer: string; publicKey: KeyObject } },
): Promise<TokenCheck> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let issuer: string;
  try {
    const claims = decodeJwt(token);
    if (typeof claims.iss !== "string") return { ok: false, reason: "token has no issuer" };
    issuer = claims.iss;
  } catch {
    return { ok: false, reason: "token is not a JWT" };
  }

  // Checked before any network call: an unknown issuer must not become a
  // request to a host of the caller's choosing.
  if (!options.issuers.includes(issuer)) return { ok: false, reason: `issuer ${issuer} is not configured` };

  if (options.local?.issuer === issuer) {
    try {
      const { payload } = await jwtVerify(token, options.local.publicKey, { issuer, audience: options.resource });
      return { ok: true, scopes: scopesOf(payload), ...(typeof payload.sub === "string" ? { subject: payload.sub } : {}) };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  try {
    const { jwks_uri } = await authorizationServerMetadata(issuer, fetchImpl);
    let jwks = jwksCache.get(jwks_uri);
    if (!jwks) {
      // The same fetch as discovery: a caller that supplied one meant it for
      // every request this makes, and a key set fetched around it would be the
      // one place verification still reached the network unbidden.
      jwks = createRemoteJWKSet(new URL(jwks_uri), { [customFetch]: fetchImpl });
      jwksCache.set(jwks_uri, jwks);
    }
    const { payload } = await jwtVerify(token, jwks, { issuer, audience: options.resource });
    return { ok: true, scopes: scopesOf(payload), ...(typeof payload.sub === "string" ? { subject: payload.sub } : {}) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Test seam: discovery is cached for the process, which would otherwise carry
 * one test's stub into the next. */
export function resetOauthCaches(): void {
  metadataCache.clear();
  jwksCache.clear();
}
