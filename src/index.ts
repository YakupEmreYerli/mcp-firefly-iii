#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createClient } from "./firefly.js";
import { Registry } from "./registry.js";
import { ENTITY_MODULES, createServer } from "./server.js";
import { SetupAborted, runSetup } from "./setup.js";

async function main(): Promise<void> {
  // An MCP client spawns this with no arguments, so the no-argument path must
  // stay exactly what it was: connect stdio and say nothing on stdout.
  if (process.argv[2] === "setup") {
    await runSetup();
    return;
  }

  const config = loadConfig();
  const registry = new Registry(config, createClient(config));
  for (const module of ENTITY_MODULES) registry.register(module);

  const server = createServer(registry, config);
  await server.connect(new StdioServerTransport());
}

main().catch((caught: unknown) => {
  // stdout carries the MCP protocol; diagnostics must go to stderr.
  // An aborted setup is a user situation, not a crash: say what happened
  // rather than printing a stack trace at someone running an install command.
  console.error(caught instanceof SetupAborted ? caught.message : caught);
  process.exit(1);
});
