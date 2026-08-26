#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createClient } from "./firefly.js";
import { Registry } from "./registry.js";
import { ENTITY_MODULES, createServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const registry = new Registry(config, createClient(config));
  for (const module of ENTITY_MODULES) registry.register(module);

  const server = createServer(registry, config);
  await server.connect(new StdioServerTransport());
}

main().catch((caught: unknown) => {
  // stdout carries the MCP protocol; diagnostics must go to stderr.
  console.error(caught);
  process.exit(1);
});
