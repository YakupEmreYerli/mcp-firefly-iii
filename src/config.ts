import { EntityType, type Access } from "./types.js";
import { ConfigurationError } from "./errors.js";

/** How far a caller may go on one entity.
 *
 * Ordered: each level contains the ones before it. `write` allows reads and
 * ordinary writes but not deletes, which is the level this setting exists to
 * make expressible — before it, "may add a transaction" and "may wipe an
 * account" were the same permission.
 */
export type PermissionLevel = "none" | "read" | "write" | "destructive";


const LEVEL_RANK: Record<PermissionLevel, number> = { none: 0, read: 1, write: 2, destructive: 3 };
const ACCESS_RANK: Record<Access, number> = { read: 1, write: 2, destructive: 3 };

/** Named shorthands, so the common cases need no per-entity list.
 *
 * These are accepted as per-entity levels too. An operator who writes
 * `FIREFLY_PERMISSIONS=safe` and then `transaction:full` is using one
 * vocabulary, and having the second spelling silently drop out would read as
 * "that entity has no permissions" — the opposite of what they wrote.
 */
const ALIASES: Record<string, PermissionLevel> = {
  read: "read",
  safe: "write",
  standard: "write",
  full: "destructive",
};

/** The level this word names, in either vocabulary, or undefined. */
function resolveLevel(word: string): PermissionLevel | undefined {
  if (word in LEVEL_RANK) return word as PermissionLevel;
  return ALIASES[word];
}

export type PermissionPolicy = {
  /** Applied to any entity the list does not name. */
  fallback: PermissionLevel;
  byEntity: Map<EntityType, PermissionLevel>;
};

/** Whether the policy lets this access level through for this entity. */
export function permits(policy: PermissionPolicy, entity: EntityType, access: Access): boolean {
  const level = policy.byEntity.get(entity) ?? policy.fallback;
  return ACCESS_RANK[access] <= LEVEL_RANK[level];
}

export type Config = {
  apiUrl: string;
  apiToken: string;
  permissions: PermissionPolicy;
  disableSslVerify: boolean;
  /** Read but not yet consumed: this layer has no logging yet. */
  logLevel: string;
  httpHost?: string;
  httpPort?: number;
  httpToken?: string;
  /** Canonical URI of this MCP server, as an OAuth resource identifier. */
  resourceUrl: string;
  /** Issuers whose tokens this server will accept. Empty disables OAuth. */
  authorizationServers: string[];
  structuredOutput: boolean;
};

const ENTITY_VALUES = new Set<string>(Object.values(EntityType));

/** The truthy spellings the Python version accepted; kept identical so an
 * existing `.env` keeps its meaning. `FIREFLY_READ_ONLY=1` in particular must
 * not silently produce a writable server. */
const TRUE_VALUES = new Set(["true", "1", "yes", "on"]);

function parseBool(raw: string | undefined): boolean {
  return TRUE_VALUES.has(raw?.trim().toLowerCase() ?? "");
}

/** Settings that FIREFLY_PERMISSIONS replaced, refused rather than ignored.
 *
 * Both were subsets of the permission policy: `FIREFLY_READ_ONLY=true` is
 * `FIREFLY_PERMISSIONS=read`, and a list of entities is the same as giving the
 * rest `:none`. Two settings for one decision is how they drift apart, so they
 * are gone.
 *
 * The refusal is narrow on purpose. Only a value that would have *restricted*
 * something stops the server: silently dropping it would leave a deployment
 * more permissive than its operator wrote, which is the failure this whole
 * project is built against. A value that restricted nothing — `false`, `all`,
 * empty — is ignored in silence, because `.env.example` shipped exactly those
 * and stopping for them would be friction with nothing gained.
 */
function refuseRetiredSettings(env: NodeJS.ProcessEnv): void {
  if (parseBool(env.FIREFLY_READ_ONLY)) {
    throw new ConfigurationError(
      "FIREFLY_READ_ONLY is no longer supported. Use FIREFLY_PERMISSIONS=read instead — " +
        "it means exactly the same thing. Remove FIREFLY_READ_ONLY to start.",
    );
  }

  const entities = (env.FIREFLY_ENABLED_ENTITIES ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  if (entities.length > 0 && !entities.includes("all")) {
    const named = entities.filter((name) => ENTITY_VALUES.has(name));
    const policy = named.length > 0 ? `${named.map((name) => `${name}:full`).join(";")};*:none` : "*:none";
    throw new ConfigurationError(
      "FIREFLY_ENABLED_ENTITIES is no longer supported. Express it with FIREFLY_PERMISSIONS " +
        `instead — FIREFLY_PERMISSIONS='${policy}' hides the same entities. ` +
        "Remove FIREFLY_ENABLED_ENTITIES to start.",
    );
  }
}

/** A base URL, from either a full URL or a bare domain.
 *
 * A domain is the ordinary case and should cost one word. A full URL is still
 * taken as written, because deriving from a domain would break the installs
 * that need it most: Firefly behind a subpath, on a custom port, or on plain
 * http inside a home network.
 *
 * The test is structural rather than a guess at what looks like a hostname: a
 * value carrying a scheme or a path is already a URL and is left alone.
 */
function baseUrl(raw: string | undefined, suffix: string): string {
  const text = (raw ?? "").trim().replace(/\/$/, "");
  if (text === "") return "";
  if (text.includes("://") || text.includes("/")) return text;
  return `https://${text}${suffix}`;
}

/** Parse FIREFLY_PERMISSIONS.
 *
 * Either a preset (`read`, `safe`, `full`) or a per-entity list such as
 * `transaction:full;account:read;rule:none`, with an optional `*:<level>` to
 * set the fallback. Unset means unrestricted, so an existing deployment keeps
 * its behaviour.
 *
 * An unreadable entry is dropped rather than widening anything: a typo must
 * not turn into a permission nobody granted. A list that names no valid entry
 * at all still narrows to its fallback, which stays `none` unless `*` said
 * otherwise — a misspelt policy fails closed.
 */
function parsePermissions(raw: string | undefined): PermissionPolicy {
  const text = raw?.trim().toLowerCase() ?? "";
  // Unset means unrestricted. Narrowing it would be friction for the person who
  // deliberately issued a full-scope Firefly token, and no obstacle to anything
  // else: whoever installs this has already made the access decision. The knob
  // is here for those who want a narrower one, not to second-guess them.
  if (text === "") return { fallback: "destructive", byEntity: new Map() };

  // Both vocabularies, not just the aliases: the docs offer `none|read|write|
  // destructive` as level names, and a bare one used to fall through to the
  // clause parser, where it parsed to nothing and left fallback "none" —
  // `FIREFLY_PERMISSIONS=destructive` asked for everything and blocked
  // everything, silently.
  const preset = resolveLevel(text);
  if (preset) return { fallback: preset, byEntity: new Map() };

  const byEntity = new Map<EntityType, PermissionLevel>();
  let fallback: PermissionLevel = "none";
  for (const clause of text.split(";")) {
    const [name, word] = clause.split(":").map((part) => part.trim());
    const level = word === undefined ? undefined : resolveLevel(word);
    if (!name || level === undefined) continue;
    if (name === "*") {
      fallback = level;
      continue;
    }
    if (ENTITY_VALUES.has(name)) byEntity.set(name as EntityType, level);
  }
  return { fallback, byEntity };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  refuseRetiredSettings(env);
  return {
    apiUrl: baseUrl(env.FIREFLY_API_URL, "/api/v1"),
    apiToken: env.FIREFLY_API_TOKEN ?? "",
    permissions: parsePermissions(env.FIREFLY_PERMISSIONS),
    disableSslVerify: parseBool(env.FIREFLY_DISABLE_SSL_VERIFY),
    logLevel: env.FIREFLY_LOG_LEVEL ?? "INFO",
    httpHost: env.MCP_HTTP_HOST ?? "127.0.0.1",
    httpPort: Number(env.MCP_HTTP_PORT ?? "3000"),
    httpToken: env.MCP_HTTP_TOKEN ?? "",
    structuredOutput: parseBool(env.MCP_STRUCTURED_OUTPUT),
    resourceUrl: baseUrl(env.MCP_RESOURCE_URL, "/mcp"),
    // Trailing slashes are stripped: an issuer is compared to a token's `iss`
    // by exact string, and "…/realm/" would never match "…/realm".
    authorizationServers: (env.MCP_AUTHORIZATION_SERVERS ?? "")
      .split(",")
      .map((issuer) => issuer.trim().replace(/\/$/, ""))
      .filter(Boolean),
  };
}
