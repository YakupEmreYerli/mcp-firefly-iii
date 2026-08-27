import { EntityType, type Access } from "./types.js";
import { ConfigurationError } from "./errors.js";

/** How far a caller may go on one entity.
 *
 * Ordered: each level contains the ones before it. `write` allows reads and
 * ordinary writes but not deletes, which is the level this setting exists to
 * make expressible — before it, "may add a transaction" and "may wipe an
 * account" were the same permission.
 */
export type Config = {
  apiUrl: string;
  apiToken: string;
  disableSslVerify: boolean;
  httpHost?: string;
  httpPort?: number;
  httpToken?: string;
  /** Canonical URI of this MCP server, as an OAuth resource identifier. */
  resourceUrl: string;
  /** Issuers whose tokens this server will accept. Empty disables OAuth. */
  authorizationServers: string[];
  /** Enables the embedded authorization server when non-empty. */
  authPassword?: string;
  /** Directory containing the embedded authorization server state. */
  authStateDir?: string;
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

/** Retired permission settings, refused rather than ignored.
 *
 * All three narrowed the server centrally, and all three could be widened by
 * editing the same file the Firefly token sits in — so they read as boundaries
 * without being ones. Access now belongs to the connection: a stdio client can
 * do whatever its token can, and an OAuth client carries the scopes a person
 * approved on the consent screen.
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
      "FIREFLY_READ_ONLY is no longer supported. Withhold the firefly:write scope on the " +
        "consent screen instead, or point the client at a read-only Firefly token. " +
        "Remove FIREFLY_READ_ONLY to start.",
    );
  }

  const permissions = (env.FIREFLY_PERMISSIONS ?? "").trim().toLowerCase();
  if (permissions !== "" && permissions !== "full" && permissions !== "all") {
    throw new ConfigurationError(
      `FIREFLY_PERMISSIONS is no longer supported, and ${JSON.stringify(permissions)} would have narrowed access. ` +
        "What the assistant may do is now decided per connection: a stdio client gets everything, " +
        "and an OAuth client gets what was approved on the consent screen. Remove FIREFLY_PERMISSIONS to start.",
    );
  }

  const entities = (env.FIREFLY_ENABLED_ENTITIES ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  if (entities.length > 0 && !entities.includes("all")) {
    const named = entities.filter((name) => ENTITY_VALUES.has(name));
    throw new ConfigurationError(
      "FIREFLY_ENABLED_ENTITIES is no longer supported: entities can no longer be hidden " +
        `individually (it named ${named.length > 0 ? named.join(", ") : "none that exist"}). ` +
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

/** Parse the MCP resource as a clean origin so Firefly Passport paths cannot collide. */
function cleanResourceUrl(raw: string | undefined): string {
  const text = (raw ?? "").trim();
  if (text === "") return "";
  const candidate = text.includes("://") ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new ConfigurationError(`MCP_RESOURCE_URL must be a domain such as mcp.example.com; got ${JSON.stringify(text)}.`);
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new ConfigurationError(
      "MCP_RESOURCE_URL must be a clean domain without a path. Remove the path and use a separate hostname because Firefly III Laravel Passport owns /oauth/* paths and subpath hosting would collide with it.",
    );
  }
  return url.origin;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  refuseRetiredSettings(env);
  const authPassword = (env.MCP_AUTH_PASSWORD ?? "").trim();
  const authorizationServers = (env.MCP_AUTHORIZATION_SERVERS ?? "")
    .split(",")
    .map((issuer) => issuer.trim().replace(/\/$/, ""))
    .filter(Boolean);
  const resourceUrl = cleanResourceUrl(env.MCP_RESOURCE_URL);
  if (authPassword !== "" && authPassword.length < 12) {
    throw new ConfigurationError("MCP_AUTH_PASSWORD must be at least 12 characters long.");
  }
  if (authPassword !== "" && authorizationServers.length > 0) {
    throw new ConfigurationError(
      "MCP_AUTH_PASSWORD and MCP_AUTHORIZATION_SERVERS cannot be used together. Remove MCP_AUTHORIZATION_SERVERS to use the builtin authorization server, or remove MCP_AUTH_PASSWORD to use the external issuer.",
    );
  }
  if (authPassword !== "" && resourceUrl === "") {
    throw new ConfigurationError("MCP_RESOURCE_URL must be set when MCP_AUTH_PASSWORD enables the builtin authorization server.");
  }
  return {
    apiUrl: baseUrl(env.FIREFLY_API_URL, "/api/v1"),
    apiToken: env.FIREFLY_API_TOKEN ?? "",
    disableSslVerify: parseBool(env.FIREFLY_DISABLE_SSL_VERIFY),
    httpHost: env.MCP_HTTP_HOST ?? "127.0.0.1",
    httpPort: Number(env.MCP_HTTP_PORT ?? "3000"),
    httpToken: env.MCP_HTTP_TOKEN ?? "",
    structuredOutput: parseBool(env.MCP_STRUCTURED_OUTPUT),
    resourceUrl,
    // Trailing slashes are stripped: an issuer is compared to a token's `iss`
    // by exact string, and "…/realm/" would never match "…/realm".
    authorizationServers,
    authPassword,
    authStateDir: env.MCP_AUTH_STATE_DIR?.trim() || "/data/firefly-mcp-auth",
  };
}
