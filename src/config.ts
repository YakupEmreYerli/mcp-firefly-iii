import { EntityType } from "./types.js";

export type Config = {
  apiUrl: string;
  apiToken: string;
  readOnly: boolean;
  directMode: boolean;
  enabledEntities: Set<EntityType>;
  disableSslVerify: boolean;
  /** Read but not yet consumed: this layer has no logging yet. */
  logLevel: string;
  httpHost?: string;
  httpPort?: number;
  httpToken?: string;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    apiUrl: env.FIREFLY_API_URL ?? "",
    apiToken: env.FIREFLY_API_TOKEN ?? "",
    readOnly: parseBool(env.FIREFLY_READ_ONLY),
    directMode: parseBool(env.FIREFLY_DIRECT_MODE),
    enabledEntities: parseEntities(env.FIREFLY_ENABLED_ENTITIES),
    disableSslVerify: parseBool(env.FIREFLY_DISABLE_SSL_VERIFY),
    logLevel: env.FIREFLY_LOG_LEVEL ?? "INFO",
    httpHost: env.MCP_HTTP_HOST ?? "127.0.0.1",
    httpPort: Number(env.MCP_HTTP_PORT ?? "3000"),
    httpToken: env.MCP_HTTP_TOKEN ?? "",
  };
}
