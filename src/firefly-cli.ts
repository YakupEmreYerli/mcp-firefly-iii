#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { createClient } from "./firefly.js";
import { Registry } from "./registry.js";
import { ENTITY_MODULES } from "./server.js";
import { diagnostic } from "./cli.js";
import { runTerminal } from "./terminal.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<number> {
  const config = loadConfig();
  const registry = new Registry(config, createClient(config));
  for (const module of ENTITY_MODULES) registry.register(module);
  return runTerminal(process.argv.slice(2), {
    registry,
    connected: config.apiUrl !== "" && config.apiToken.trim() !== "",
    stdout: (text) => console.log(text),
    stderr: (text) => console.error(text),
    readInput: readStdin,
  });
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((caught: unknown) => {
    console.error(diagnostic(caught));
    process.exitCode = 1;
  });
