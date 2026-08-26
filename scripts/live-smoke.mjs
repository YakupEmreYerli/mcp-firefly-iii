// Maintainer tool, not part of the published package.
//
// Walks every read operation against the live instance in .env and reports
// which ones answer. It exists because most entities have no unit test that
// touches a real Firefly: a schema can be well-formed and still ask the wrong
// endpoint. Read-only — it never writes.
//
// Run with: npm run smoke:live

import { loadConfig } from "../dist/config.js";
import { createClient } from "../dist/firefly.js";
import { Registry } from "../dist/registry.js";
import { ENTITY_MODULES } from "../dist/server.js";

const config = loadConfig();
if (config.apiUrl === "") throw new Error("FIREFLY_API_URL is not set");
const registry = new Registry(config, createClient(config));
for (const module of ENTITY_MODULES) registry.register(module);

function firstId(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.data)) return undefined;
  const item = payload.data[0];
  return item && typeof item === "object" && typeof item.id === "string" ? item.id : undefined;
}

const discovered = new Map();
async function discover(entity, operation) {
  if (discovered.has(entity)) return discovered.get(entity);
  try {
    const result = await registry.execute(entity, operation, {});
    const value = firstId(result);
    if (value) discovered.set(entity, value);
    return value;
  } catch {
    return undefined;
  }
}

async function sample(entity, operation) {
  if (entity === "insight" || entity === "summary") return { start: "2026-08-01", end: "2026-08-31" };
  if (entity === "search") return operation === "accounts" ? { query: "cash" } : { query: "rent" };
  if (entity === "currency" && operation === "get") return { code: "TRY" };
  if (entity === "budget" && operation === "get_limit") {
    const budgetId = await discover("budget", "list");
    return budgetId ? { budget_id: budgetId, limit_id: "1" } : undefined;
  }
  if (entity === "budget" && operation === "list_transactions_without_budget") return {};
  if (operation === "download") {
    const value = await discover(entity, "list");
    return value ? { id: value } : undefined;
  }
  if (operation === "get" || operation.startsWith("list_") || operation === "test") {
    const value = await discover(entity, "list");
    return value ? { id: value } : undefined;
  }
  return {};
}

let passed = 0;
let skipped = 0;
let failed = 0;
for (const module of registry.entityModules()) {
  for (const [operation, spec] of Object.entries(module.operations)) {
    if (spec.access !== "read") continue;
    try {
      const params = await sample(module.entity, operation);
      if (params === undefined) {
        skipped += 1;
        console.log(`SKIP ${module.entity}.${operation}: no live record available`);
        continue;
      }
      await registry.execute(module.entity, operation, params, ["id"]);
      passed += 1;
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${module.entity}.${operation}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
console.log(`Live read parity: ${passed} passed, ${skipped} skipped (no data), ${failed} failed`);
if (failed !== 0) process.exit(1);
