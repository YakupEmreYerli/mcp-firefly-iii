#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createClient } from "./firefly.js";
import { Registry } from "./registry.js";
import { ENTITY_MODULES, createServer } from "./server.js";
import { SetupAborted, runSetup } from "./setup.js";
import { packageVersion, parseArgs, usage } from "./cli.js";

async function serve(): Promise<void> {
  const config = loadConfig();
  const registry = new Registry(config, createClient(config));
  for (const module of ENTITY_MODULES) registry.register(module);

  const server = createServer(registry, config);
  await server.connect(new StdioServerTransport());
}

async function main(): Promise<number> {
  const command = parseArgs(process.argv.slice(2));

  switch (command.kind) {
    case "serve":
      await serve();
      return 0;
    case "setup":
      await runSetup();
      return 0;
    case "version":
      console.log(packageVersion());
      return 0;
    case "help":
      if (command.unknown !== undefined) {
        console.error(`firefly-mcp: unknown command "${command.unknown}"\n`);
      }
      // Usage goes to stderr when it is a refusal, so nothing reading stdout
      // mistakes it for output.
      (command.toStderr ? console.error : console.log)(usage());
      return command.toStderr ? 1 : 0;
  }
}

main()
  .then((code) => {
    // Serving keeps the process alive on its own; exiting here would kill it.
    if (code !== 0) process.exit(code);
  })
  .catch((caught: unknown) => {
    // stdout carries the MCP protocol; diagnostics must go to stderr.
    // An aborted setup is a user situation, not a crash: say what happened
    // rather than printing a stack trace at someone running an install command.
    console.error(caught instanceof SetupAborted ? caught.message : caught);
    process.exit(1);
  });
