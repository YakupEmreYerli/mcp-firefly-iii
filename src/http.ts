#!/usr/bin/env node
import { createServer as createNodeServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "./config.js";
import { loadConfig } from "./config.js";
import { createClient } from "./firefly.js";
import { Registry } from "./registry.js";
import { ENTITY_MODULES, createServer } from "./server.js";

/** Bodies above this are refused unread. An MCP request is kilobytes; anything
 * larger is a mistake or an attempt to exhaust memory. */
const MAX_BODY_BYTES = 1_048_576;

const MCP_METHODS = new Set(["GET", "POST", "DELETE"]);

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

function authorized(req: IncomingMessage, expected: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  return tokenMatches(header.slice("Bearer ".length), expected);
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
  const httpToken = config.httpToken ?? "";
  if (httpToken.trim() === "") throw new Error("MCP_HTTP_TOKEN must be set for HTTP mode.");

  const registry = new Registry(config, createClient(config));
  for (const module of ENTITY_MODULES) registry.register(module);

  return createNodeServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "").split("?")[0];

    if (path === "/health" && req.method === "GET") {
      writeJson(res, 200, { ok: true });
      return;
    }
    if (path !== "/mcp" || !MCP_METHODS.has(req.method ?? "")) {
      writeJson(res, 404, { error: "Not found" });
      return;
    }
    if (!authorized(req, httpToken)) {
      res.setHeader("WWW-Authenticate", "Bearer");
      writeJson(res, 401, { error: "Unauthorized" });
      return;
    }

    const mcp = createServer(registry, config);
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
      const body = req.method === "POST" ? await readJson(req) : undefined;
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
    console.error(error);
    process.exit(1);
  });
}
