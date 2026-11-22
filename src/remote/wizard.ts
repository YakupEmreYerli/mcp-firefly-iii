import { accessSync, constants, copyFileSync, existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { COMPOSE_FILE_NAMES, readCompose } from "./compose.js";
import {
  ENV_FILE, OVERRIDE_FILE, composeOverride, envFile, generatePassword, proxySnippet, validateResourceUrl,
  type ProxyChoice, type ProxyKind, type RemoteAnswers,
} from "./files.js";

import { createInterface } from "node:readline/promises";
import { MutableOutput, ask, askSecret } from "../setup.js";

/** What the wizard needs from a terminal; tests script it. */
export type WizardIO = {
  ask(question: string): Promise<string>;
  askSecret(question: string): Promise<string>;
  print(text: string): void;
};

const PROXY_KINDS: Array<[ProxyKind, string]> = [
  ["caddy", "Caddy"],
  ["traefik", "Traefik"],
  ["npm", "Nginx Proxy Manager"],
  ["cloudflare", "Cloudflare Tunnel"],
  ["other", "Something else"],
];

function writable(dir: string): boolean {
  try { accessSync(dir, constants.W_OK); return true; } catch { return false; }
}

async function choose(io: WizardIO, question: string, options: string[]): Promise<number> {
  for (;;) {
    const answer = (await io.ask(`${question}\n${options.map((o, i) => `  ${i + 1}) ${o}`).join("\n")}\n> `)).trim();
    const index = Number.parseInt(answer, 10);
    if (index >= 1 && index <= options.length) return index - 1;
    io.print(`  Type a number from 1 to ${options.length}.`);
  }
}

async function askWithDefault(io: WizardIO, question: string, fallback: string): Promise<string> {
  const answer = (await io.ask(`${question} [${fallback}]: `)).trim();
  return answer === "" ? fallback : answer;
}

async function askPort(io: WizardIO): Promise<number> {
  for (;;) {
    const port = Number.parseInt(await askWithDefault(io, "Port on 127.0.0.1 for your proxy to forward to", "3000"), 10);
    if (port >= 1 && port <= 65535) return port;
    io.print("  A port is a number from 1 to 65535.");
  }
}

/** Write a file the user may already have, asking first and keeping a backup. */
async function writeOwnFile(io: WizardIO, path: string, content: string, mode?: number): Promise<boolean> {
  if (existsSync(path)) {
    const answer = (await io.ask(`${path} already exists. Replace it (a .bak copy is kept)? [y/N]: `)).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") return false;
    copyFileSync(path, `${path}.bak`);
  }
  writeFileSync(path, content, mode === undefined ? undefined : { mode });
  if (mode !== undefined) chmodSync(path, mode); // writeFileSync keeps an existing file's mode.
  return true;
}

/**
 * The remote setup: run from the folder holding Firefly III's compose file,
 * usually inside the published image. Writes a compose file to pass with -f
 * and an env file with the secrets; never edits the user's own files.
 * Returns the process exit code.
 */
export async function runRemoteSetup(io: WizardIO, dir: string, version: string): Promise<number> {
  io.print("Firefly III MCP server — remote setup\n");
  io.print("Sets the server up next to Firefly III, so Claude (web, desktop, phone) and ChatGPT can connect.\n");

  if (!writable(dir)) {
    io.print(`Cannot write to ${dir}. Run the setup as your own user from Firefly III's folder:`);
    io.print('  docker run --rm -it --user "$(id -u):$(id -g)" -v "$PWD":/work:z ghcr.io/yakupemreyerli/mcp-firefly-iii:' + version + " setup");
    io.print("The :z lets the container write the folder on SELinux hosts (Fedora, RHEL); elsewhere Docker ignores it.");
    return 1;
  }

  // 1. Firefly's service and network.
  const composeName = COMPOSE_FILE_NAMES.find((name) => existsSync(join(dir, name)));
  let fireflyService: string;
  let fireflyNetwork: string;
  let externalNetworks: string[] = [];
  const services = composeName ? readCompose(readFileSync(join(dir, composeName), "utf8")) : undefined;
  if (services) externalNetworks = services.networks.filter((n) => n.external).map((n) => n.key);
  if (!services || services.fireflyServices.length === 0) {
    io.print(composeName ? `No Firefly III service (image fireflyiii/core) in ${composeName}.` : "No compose file here (compose.yaml, docker-compose.yml…).");
    fireflyService = await askWithDefault(io, "Name of the Firefly III service in your compose file", "app");
    fireflyNetwork = await askWithDefault(io, "Docker network it is on", "default");
  } else {
    const pick = services.fireflyServices.length === 1
      ? services.fireflyServices[0]!
      : services.fireflyServices[await choose(io, "Which service is Firefly III?", services.fireflyServices.map((s) => s.name))]!;
    fireflyService = pick.name;
    // Prefer a network of the compose project itself over a shared proxy network.
    fireflyNetwork = pick.networks.find((n) => !externalNetworks.includes(n)) ?? pick.networks[0] ?? "default";
    io.print(`Found Firefly III: service "${fireflyService}" on network "${fireflyNetwork}" in ${composeName}.\n`);
  }

  // 2. Token. Checked by `doctor` once the server runs, from inside Docker:
  // the public address may not loop back from this machine.
  io.print("Create a token in Firefly III: Options → Profile → OAuth → Personal Access Tokens → Create.");
  let apiToken = "";
  while (apiToken === "") apiToken = (await io.askSecret("Firefly III token: ")).trim();

  // 3. Public address.
  io.print("\nThe server needs an address of its own that Claude and ChatGPT reach over HTTPS,");
  io.print("for example mcp.example.com. Firefly III keeps its own address.");
  let resourceUrl = "";
  while (resourceUrl === "") {
    const result = validateResourceUrl(await io.ask("Public address for the server: "));
    if (result.ok) resourceUrl = result.url;
    else io.print(`  ${result.reason}`);
  }

  // 4. Proxy placement and kind.
  const where = await choose(io, "\nWhere does your HTTPS reverse proxy run?", [
    "In Docker (a container)",
    "On this server, outside Docker",
    "Cloudflare Tunnel, outside Docker",
  ]);
  let proxy: ProxyChoice;
  if (where === 0) {
    const suggestion = externalNetworks[0] ?? "proxy";
    proxy = { kind: "docker", network: await askWithDefault(io, "Docker network your proxy is on", suggestion) };
  } else {
    proxy = { kind: where === 1 ? "host" : "tunnel", port: await askPort(io) };
  }
  const kind = PROXY_KINDS[await choose(io, "\nWhich proxy is it?", PROXY_KINDS.map(([, label]) => label))]![0];

  // 5. Files.
  const answers: RemoteAnswers = { fireflyService, fireflyNetwork, apiToken, resourceUrl, password: generatePassword(), proxy, version };
  const overridePath = join(dir, OVERRIDE_FILE);
  const envPath = join(dir, ENV_FILE);
  if (!(await writeOwnFile(io, overridePath, composeOverride(answers)))) { io.print("Nothing written."); return 1; }
  if (!(await writeOwnFile(io, envPath, envFile(answers), 0o600))) { io.print(`Kept your ${ENV_FILE}; ${OVERRIDE_FILE} was written.`); return 1; }

  // 6. What to do next.
  const compose = `docker compose -f ${composeName ?? "<your compose file>"} -f ${OVERRIDE_FILE}`;
  io.print(`\nWrote ${OVERRIDE_FILE} and ${ENV_FILE} (private, mode 600).\n`);
  io.print(`Sign-in password — you type it once when you connect a client. It is also in ${ENV_FILE}:`);
  io.print(`  ${answers.password}\n`);
  io.print("1. Add this to your proxy:\n");
  io.print(proxySnippet(kind, answers).split("\n").map((line) => `   ${line}`).join("\n"));
  io.print(`\n2. Start the server:\n   ${compose} up -d`);
  io.print(`\n3. Check it — every line should say PASS:\n   ${compose} run --rm firefly-mcp doctor`);
  io.print(`\n4. Connect: add a custom connector with this address, then sign in with the password:`);
  io.print(`   ${resourceUrl}/mcp`);
  io.print("   Claude: Settings → Connectors → Add custom connector.  ChatGPT: the connector screen, authentication OAuth.\n");
  return 0;
}

/** The real terminal, with the token typed blind. Close it when done. */
export function terminalIO(): WizardIO & { close(): void } {
  const output = new MutableOutput();
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return {
    ask: (q) => ask(rl, q),
    askSecret: (q) => askSecret(rl, output, q),
    print: (text) => process.stdout.write(`${text}\n`),
    close: () => rl.close(),
  };
}
