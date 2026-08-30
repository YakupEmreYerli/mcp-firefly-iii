#!/usr/bin/env node
import { createServer as createNodeServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "./config.js";
import { diagnostic } from "./cli.js";
import { loadConfig } from "./config.js";
import { createClient } from "./firefly.js";
import { Registry } from "./registry.js";
import { ENTITY_MODULES, createServer } from "./server.js";
import {
  MINIMUM_SCOPE,
  accessForRequest,
  allowedBy,
  challenge,
  grantsAnything,
  resourceMetadata,
  scopeFor,
  verifyToken,
} from "./oauth.js";
import { BuiltinAuth } from "./auth/routes.js";

/** Bodies above this are refused unread. An MCP request is kilobytes; anything
 * larger is a mistake or an attempt to exhaust memory. */
const MAX_BODY_BYTES = 1_048_576;

const MCP_METHODS = new Set(["GET", "POST", "DELETE"]);
const MCP_PATHS = new Set(["/", "/mcp"]);

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(encoded),
  });
  res.end(encoded);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body === "" ? undefined : (JSON.parse(body) as unknown);
}

/** Compare the presented token against the configured one in constant time.
 *
 * A plain `===` returns as soon as two bytes differ, so the time it takes to
 * refuse leaks how long a guessed prefix was. The token guards write access to
 * someone's entire financial history; it is worth the extra allocation.
 */
function tokenMatches(presented: string, expected: string): boolean {
  // Digest first: `timingSafeEqual` throws on a length mismatch, and refusing
  // early on length would leak how long the real token is. Two SHA-256 digests
  // are always the same size, so the comparison is uniform for every input.
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** The presented bearer token, or undefined when none was offered. */
function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return undefined;
  const token = header.slice("Bearer ".length).trim();
  return token === "" ? undefined : token;
}

/** Build the HTTP listener for MCP over streamable HTTP.
 *
 * The registry and the Firefly client are built once: they hold no per-request
 * state. The MCP server and its transport are per request because this runs in
 * stateless mode (`sessionIdGenerator: undefined`), where two concurrent
 * requests sharing one transport would collide on JSON-RPC request ids. Both
 * are closed when the response ends, so a long-lived process does not
 * accumulate them.
 */
export function createHttpServer(config: Config): Server {
  const httpToken = (config.httpToken ?? "").trim();
  if (config.authPassword && config.resourceUrl === "") {
    throw new Error("MCP_RESOURCE_URL must be set when MCP_AUTH_PASSWORD enables the builtin authorization server.");
  }
  if (config.resourceUrl !== "") {
    try {
      const resource = new URL(config.resourceUrl);
      if (resource.pathname !== "/" || resource.search !== "" || resource.hash !== "") {
        throw new Error("path");
      }
    } catch {
      throw new Error("MCP_RESOURCE_URL must be a clean domain without a path; use a separate hostname because Firefly III Laravel Passport owns /oauth/* paths.");
    }
  }
  const builtin = config.authPassword ? new BuiltinAuth(config) : undefined;
  const issuers = builtin ? [new URL(config.resourceUrl).origin] : config.authorizationServers;
  const oauth = issuers.length > 0;

  // One of the two has to be there. Starting with neither would serve a
  // stranger's financial history to anyone who found the address.
  if (httpToken === "" && !oauth) {
    throw new Error("HTTP mode needs MCP_HTTP_TOKEN, or MCP_AUTHORIZATION_SERVERS for OAuth.");
  }
  // A resource identifier is what a token is bound to. Without it the audience
  // check has nothing to compare against, and an unbound bearer token is one
  // any other service could have issued.
  if (oauth && config.resourceUrl === "") {
    throw new Error("MCP_RESOURCE_URL must be set when MCP_AUTHORIZATION_SERVERS is.");
  }

  const client = createClient(config);
  const registry = new Registry(config, client);
  for (const module of ENTITY_MODULES) registry.register(module);

  const metadataPaths = oauth ? new Set(["/.well-known/oauth-protected-resource"]) : new Set<string>();


  /** The registry a request runs against.
   *
   * A static token carries no scopes and keeps every surface. An
   * OAuth token is narrowed to what it was actually granted, so the gate the
   * rest of the server already goes through does the enforcing.
   */
  function registryFor(scopes: Set<string> | undefined): Registry {
    if (scopes === undefined) return registry;
    const scoped = new Registry(config, client, allowedBy(scopes));
    for (const module of ENTITY_MODULES) scoped.register(module);
    return scoped;
  }

  return createNodeServer((req, res) => {
    // Every rejection has to land somewhere. A client that hangs up mid-body
    // rejects the read in flight with ECONNRESET, and Node turns an unhandled
    // rejection into an uncaught exception: one aborted request — a phone
    // losing signal during the login POST, or one deliberate socket — used to
    // take the whole server down, from an endpoint that runs before any
    // credential is checked.
    handle(req, res).catch((error: unknown) => {
      if (res.writableEnded || res.destroyed) return;
      const message = error instanceof Error ? error.message : String(error);
      if (res.headersSent) res.end();
      else writeJson(res, 400, { error: message });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "").split("?")[0] ?? "";

    // Browser-based clients preflight the MCP endpoint and the OAuth routes.
    // Nothing here is cookie-authenticated, so a wildcard origin grants no
    // ambient authority: every request still has to carry its own token.
    const corsPath =
      MCP_PATHS.has(path) ||
      metadataPaths.has(path) ||
      path.startsWith("/oauth/") ||
      path.startsWith("/.well-known/oauth-authorization-server");
    if (corsPath) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version");
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");
      if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
        res.writeHead(204);
        res.end();
        return;
      }
    }

    if (path === "/health" && req.method === "GET") {
      // `auth` names the mode the process actually started in. Which settings
      // reached the container is otherwise invisible from outside, and the
      // symptom of a missing MCP_AUTH_PASSWORD — a client reporting that this
      // server "does not implement OAuth" — points nowhere near the cause.
      writeJson(res, 200, { ok: true, auth: builtin ? "oauth-builtin" : oauth ? "oauth-external" : "bearer" });
      return;
    }
    if (builtin && (path.startsWith("/oauth/") || path.startsWith("/.well-known/oauth-authorization-server"))) {
      if (await builtin.handle(req, res, path)) return;
    }
    // Discovery is deliberately unauthenticated: a client reads it precisely
    // because it does not yet have a token, and RFC 9728 carries nothing
    // secret — only where to go and ask.
    if (metadataPaths.has(path) && req.method === "GET") {
      writeJson(res, 200, resourceMetadata(config.resourceUrl, issuers));
      return;
    }
    if (!MCP_PATHS.has(path) || !MCP_METHODS.has(req.method ?? "")) {
      writeJson(res, 404, { error: "Not found" });
      return;
    }

    const presented = bearerToken(req);
    let scopes: Set<string> | undefined;

    // The static token is tried first and answers with the bare challenge it
    // always did, so an existing deployment sees no change.
    if (httpToken !== "" && presented !== undefined && tokenMatches(presented, httpToken)) {
      scopes = undefined;
    } else if (oauth && presented !== undefined) {
      const checked = await verifyToken(presented, { resource: config.resourceUrl, issuers, local: builtin ? { issuer: issuers[0]!, publicKey: builtin.state.publicKey } : undefined });
      if (!checked.ok) {
        res.setHeader(
          "WWW-Authenticate",
          challenge({ resource: config.resourceUrl, scope: MINIMUM_SCOPE, error: "invalid_token", description: checked.reason }),
        );
        writeJson(res, 401, { error: "invalid_token", error_description: checked.reason });
        return;
      }
      // A token carrying nothing this server understands is refused with a
      // challenge rather than let in to find every tool missing.
      if (!grantsAnything(checked.scopes)) {
        res.setHeader(
          "WWW-Authenticate",
          challenge({ resource: config.resourceUrl, scope: MINIMUM_SCOPE, error: "insufficient_scope" }),
        );
        writeJson(res, 403, { error: "insufficient_scope", scope: MINIMUM_SCOPE });
        return;
      }
      scopes = checked.scopes;
    } else {
      if (oauth) {
        res.setHeader("WWW-Authenticate", challenge({ resource: config.resourceUrl, scope: MINIMUM_SCOPE }));
      } else {
        res.setHeader("WWW-Authenticate", "Bearer");
      }
      writeJson(res, 401, { error: "Unauthorized" });
      return;
    }

    // Read the body once, here, so an under-scoped call is refused before it
    // reaches a tool rather than failing somewhere inside one.
    let body: unknown;
    if (req.method === "POST") {
      try {
        body = await readJson(req);
      } catch (error) {
        writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        return;
      }
    }

    if (scopes !== undefined) {
      const needed = accessForRequest(body);
      if (needed !== undefined && !allowedBy(scopes).has(needed)) {
        const scope = scopeFor(needed);
        // A tool call the token cannot make is answered as a JSON-RPC tool
        // error, not an HTTP 403: clients surface the text to the model, and
        // the challenge rides along in both the header and `_meta` so a host
        // that can step up the grant still sees what scope to ask for.
        const challengeValue = challenge({ resource: config.resourceUrl, scope, error: "insufficient_scope" });
        res.setHeader("WWW-Authenticate", challengeValue);
        const requestId = typeof body === "object" && body !== null && "id" in body ? (body as { id?: unknown }).id : null;
        writeJson(res, 200, {
          jsonrpc: "2.0",
          id: requestId,
          result: {
            isError: true,
            content: [{ type: "text", text: `Insufficient scope: ${scope}` }],
            _meta: { "mcp/www_authenticate": [challengeValue] },
          },
        });
        return;
      }
    }

    const mcp = createServer(registryFor(scopes), config);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });

    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (!res.headersSent) {
        writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      } else {
        res.end();
      }
    }
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const server = createHttpServer(config);
  await new Promise<void>((resolve) => {
    server.listen(config.httpPort, config.httpHost, resolve);
  });
  // stdout is reserved for protocol output in the stdio sibling; keep both on stderr.
  console.error(`Firefly MCP HTTP listening on http://${config.httpHost}:${config.httpPort}/mcp`);
}

/** True when this file is the process entry point rather than an import.
 *
 * `process.argv[1]` is whatever path was invoked, and npm installs a bin as a
 * symlink in `node_modules/.bin`. Comparing that path directly against
 * `import.meta.url` — which Node has already resolved to the real file — never
 * matches for an installed package, so the server would exit 0 having done
 * nothing at all. Both sides are resolved before comparing.
 */
function isEntryPoint(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((error: unknown) => {
    console.error(diagnostic(error));
    process.exit(1);
  });
}
