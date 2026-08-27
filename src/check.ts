#!/usr/bin/env node
/** Read-only smoke test against the live instance in .env.
 *
 * Confirms the token works, the registry loads, and one cheap read returns.
 * Never writes.
 */
import { loadConfig } from "./config.js";
import { createClient } from "./firefly.js";
import { Registry } from "./registry.js";
import { ENTITY_MODULES } from "./server.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pull `data.version` out of an unknown JSON payload without a type
 * assertion — narrows in two guarded steps instead. */
function extractVersion(payload: unknown): string {
  if (!isRecord(payload) || !isRecord(payload.data)) return "unknown";
  const { version } = payload.data;
  return typeof version === "string" ? version : "unknown";
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.apiUrl === "") throw new Error("FIREFLY_API_URL is not set");

  const client = createClient(config);
  const registry = new Registry(config, client);
  for (const module of ENTITY_MODULES) registry.register(module);

  const about = await client.get("/about");
  console.log(`Firefly III ${extractVersion(about)} reachable at ${config.apiUrl}`);

  const operations = registry.listOperations();
  console.log(`${registry.entityModules().length} entities, ${operations.length} operations`);
  const level = config.permissions.fallback;
  if (level !== "destructive" || config.permissions.byEntity.size > 0) {
    console.log(`FIREFLY_PERMISSIONS is narrowing access: operations beyond '${level}' are hidden`);
  }
}

main().catch((caught: unknown) => {
  console.error(caught);
  process.exit(1);
});
