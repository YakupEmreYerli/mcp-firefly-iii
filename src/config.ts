import { EntityType, type Access } from "./types.js";

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
  readOnly: boolean;
  permissions: PermissionPolicy;
  directMode: boolean;
  enabledEntities: Set<EntityType>;
  disableSslVerify: boolean;
  /** Read but not yet consumed: this layer has no logging yet. */
  logLevel: string;
  httpHost?: string;
  httpPort?: number;
  httpToken?: string;
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

/** `all` is a sentinel meaning every entity, as in the Python version — the
 * shipped `.env`, `.env.example` and `.env.test` all use it. Entity names are
 * matched lowercased, also as in the Python version, so `Account` resolves.
 *
 * A list naming only unknown entities yields an empty set rather than falling
 * back to everything: `make check` then reports "0 entities" instead of a typo
 * quietly widening a safety knob. */
function parseEntities(raw: string | undefined): Set<EntityType> {
  if (!raw || raw.trim() === "") {
    return new Set(Object.values(EntityType));
  }
  const names = raw.split(",").map((name) => name.trim().toLowerCase()).filter(Boolean);
  if (names.includes("all")) {
    return new Set(Object.values(EntityType));
  }
  const entities = names.filter((name): name is EntityType => ENTITY_VALUES.has(name));
  return new Set(entities);
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
  return {
    apiUrl: env.FIREFLY_API_URL ?? "",
    apiToken: env.FIREFLY_API_TOKEN ?? "",
    readOnly: parseBool(env.FIREFLY_READ_ONLY),
    permissions: parsePermissions(env.FIREFLY_PERMISSIONS),
    directMode: parseBool(env.FIREFLY_DIRECT_MODE),
    enabledEntities: parseEntities(env.FIREFLY_ENABLED_ENTITIES),
    disableSslVerify: parseBool(env.FIREFLY_DISABLE_SSL_VERIFY),
    logLevel: env.FIREFLY_LOG_LEVEL ?? "INFO",
    httpHost: env.MCP_HTTP_HOST ?? "127.0.0.1",
    httpPort: Number(env.MCP_HTTP_PORT ?? "3000"),
    httpToken: env.MCP_HTTP_TOKEN ?? "",
    structuredOutput: parseBool(env.MCP_STRUCTURED_OUTPUT),
  };
}
