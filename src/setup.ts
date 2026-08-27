/** Interactive first-run setup.
 *
 * `npm install` leaves a user holding a package that does nothing on its own —
 * this server is spawned by an MCP client, not run by hand. This command closes
 * that gap: it asks for the two values that matter, proves they work against
 * the live instance before anything depends on them, and writes the client
 * configuration.
 */
import { createInterface, type Interface } from "node:readline/promises";
import { Writable } from "node:stream";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "./firefly.js";
import { FireflyApiError } from "./errors.js";
import type { Config } from "./config.js";
import { packageVersion } from "./cli.js";

const PACKAGE_NAME = "@yakupemreyerli/firefly-mcp";

const KEY_ENTER = ["\r", "\n"];
const KEY_INTERRUPT = "\u0003";
const KEY_BACKSPACE = ["\u007f", "\b"];

/** Where a client keeps its MCP servers, and under which key. */
export type ClientTarget = {
  name: string;
  path: string;
  /** Top-level key holding the server map. Claude and Cursor say `mcpServers`;
   * VS Code says `servers`. */
  wrapperKey: "mcpServers" | "servers";
};

export type Answers = { apiUrl: string; apiToken: string; readOnly: boolean };

/** Normalise what a person types into the base URL Firefly actually serves.
 *
 * A missing `/api/v1` and a trailing slash account for most failed setups, and
 * neither produces a useful error later: the first 404s on every call, the
 * second doubles a slash in every path.
 */
export function normalizeApiUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, "");
  if (url === "") return "";
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  if (!/\/api\/v1$/i.test(url)) url = `${url}/api/v1`;
  return url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Merge one server entry into a client's existing configuration.
 *
 * Returns the whole document rather than the entry: other MCP servers the
 * person has configured must survive untouched, which is the entire reason
 * this is a merge and not a write.
 */
export function mergeServerEntry(
  document: unknown,
  wrapperKey: string,
  serverName: string,
  entry: unknown,
): { merged: Record<string, unknown>; replaced: boolean } {
  const base: Record<string, unknown> = isRecord(document) ? { ...document } : {};
  const wrapper = base[wrapperKey];
  const servers: Record<string, unknown> = isRecord(wrapper) ? { ...wrapper } : {};

  const replaced = Object.prototype.hasOwnProperty.call(servers, serverName);
  servers[serverName] = entry;
  base[wrapperKey] = servers;
  return { merged: base, replaced };
}

/** Client configuration files worth offering on this machine.
 *
 * A target is offered when its *directory* exists, not the file: Claude Desktop
 * writes its config only once something is configured, so requiring the file
 * would hide the client from everyone who has never added a server.
 *
 * Only Claude Desktop is written to. Claude Code is handled separately through
 * its own CLI. Every other client is configured by hand from the JSON this
 * command prints, rather than by guessing at file formats we do not track.
 *
 * Claude Desktop ships for macOS and Windows; the Linux path serves the
 * community builds and simply never matches elsewhere.
 */
export function clientTargets(home: string = homedir(), os: string = platform()): ClientTarget[] {
  const claudeDir =
    os === "darwin"
      ? join(home, "Library", "Application Support", "Claude")
      : os === "win32"
        ? join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude")
        : join(home, ".config", "Claude");

  const candidates: ClientTarget[] = [
    {
      name: "Claude Desktop",
      path: join(claudeDir, "claude_desktop_config.json"),
      wrapperKey: "mcpServers",
    },
  ];

  return candidates.filter((target) => existsSync(dirname(target.path)));
}

export function serverEntry(answers: Answers): unknown {
  const env: Record<string, string> = {
    FIREFLY_API_URL: answers.apiUrl,
    FIREFLY_API_TOKEN: answers.apiToken,
  };
  if (answers.readOnly) env.FIREFLY_READ_ONLY = "true";
  return { command: "npx", args: ["-y", PACKAGE_NAME], env };
}

/** Turn a failed connection into something a person can act on.
 *
 * A raw stack trace tells nobody which of the two values they just typed was
 * the wrong one.
 */
export function describeConnectionFailure(error: unknown): string {
  if (error instanceof FireflyApiError) {
    if (error.status === 401 || error.status === 403) {
      return "Firefly rejected the token. Check that you copied all of it and that it has not been revoked.";
    }
    if (error.status === 404) {
      return "Reached the server, but not the API. Is the address right, including /api/v1?";
    }
    return `Firefly answered ${error.status}: ${error.message}`;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/ENOTFOUND|EAI_AGAIN/.test(message)) return "That address does not resolve. Check the hostname.";
  if (/ECONNREFUSED/.test(message)) {
    return "The connection was refused. Is Firefly III running and reachable from here?";
  }
  if (/certificate|self-signed|SSL|TLS/i.test(message)) {
    return "The TLS certificate was rejected. For a local instance with a self-signed certificate, set FIREFLY_DISABLE_SSL_VERIFY=true.";
  }
  if (/timeout|abort/i.test(message)) return "The request timed out before Firefly answered.";
  return message;
}

function versionOf(payload: unknown): string {
  if (!isRecord(payload) || !isRecord(payload.data)) return "an unknown version";
  const { version } = payload.data;
  return typeof version === "string" ? version : "an unknown version";
}

/** Raised when stdin ends before setup has what it needs.
 *
 * Without this the pending question never settles and the process exits 0,
 * which reads as "setup succeeded" to anything running it non-interactively.
 */
export class SetupAborted extends Error {
  constructor() {
    super("Setup needs an interactive terminal; input ended early.");
  }
}

/** Ask a question, failing loudly if the input stream ends instead.
 *
 * `rl.question` never settles once stdin closes, so it is raced against the
 * interface closing.
 */
function ask(rl: Interface, question: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;

    const onClose = (): void => {
      // A pipe emits its last line and closes back to back. The answer wins
      // that tie: queueing the rejection puts it behind the microtask the
      // resolved question already scheduled, so a complete scripted run is
      // not mistaken for an abandoned one.
      queueMicrotask(() => {
        if (settled) return;
        settled = true;
        reject(new SetupAborted());
      });
    };

    rl.once("close", onClose);

    rl.question(question).then(
      (answer) => {
        if (settled) return;
        settled = true;
        rl.off("close", onClose);
        resolve(answer);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        rl.off("close", onClose);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** Stdout that can be silenced for one question.
 *
 * Hiding the token is done by dropping readline's echo rather than by reading
 * raw keystrokes: raw mode means re-implementing backspace, interrupt and
 * encoding by hand, and it breaks the moment anything sits between the
 * terminal and this process.
 */
class MutableOutput extends Writable {
  muted = false;

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.muted) process.stdout.write(chunk);
    callback();
  }
}

/** Ask for a value without echoing it. The token is a password. */
async function askSecret(rl: Interface, output: MutableOutput, question: string): Promise<string> {
  // The prompt goes out before the mute; only the typing is hidden.
  process.stdout.write(question);
  output.muted = true;
  try {
    return await ask(rl, "");
  } finally {
    output.muted = false;
    process.stdout.write("\n");
  }
}

async function verifyConnection(apiUrl: string, apiToken: string): Promise<string | undefined> {
  const config: Config = {
    apiUrl,
    apiToken,
    readOnly: true,
    permissions: { fallback: "read", byEntity: new Map() },
    structuredOutput: false,
    directMode: false,
    enabledEntities: new Set(),
    disableSslVerify: false,
    logLevel: "INFO",
  };
  try {
    return versionOf(await createClient(config).get("/about"));
  } catch (error) {
    console.log(`\n  ${describeConnectionFailure(error)}\n`);
    return undefined;
  }
}

function writeTarget(target: ClientTarget, entry: unknown): { replaced: boolean; backup?: string } {
  const existing = existsSync(target.path) ? readFileSync(target.path, "utf8") : "";
  // A parse failure means a hand-edited file we do not understand. Let it
  // throw: leaving the file alone beats replacing it with our idea of it.
  const document: unknown = existing.trim() === "" ? {} : JSON.parse(existing);
  const { merged, replaced } = mergeServerEntry(document, target.wrapperKey, "firefly", entry);

  let backup: string | undefined;
  if (existing !== "") {
    backup = `${target.path}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(target.path, backup);
  }

  mkdirSync(dirname(target.path), { recursive: true });
  writeFileSync(target.path, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return { replaced, backup };
}

function claudeCodeAvailable(): boolean {
  return spawnSync("claude", ["--version"], { stdio: "ignore" }).status === 0;
}

function addToClaudeCode(answers: Answers): boolean {
  // `claude mcp add` owns its own configuration file and handles scopes and
  // duplicates. Hand-editing that file would be a worse version of a command
  // that already exists.
  const args = [
    "mcp",
    "add",
    "firefly",
    "--env",
    `FIREFLY_API_URL=${answers.apiUrl}`,
    "--env",
    `FIREFLY_API_TOKEN=${answers.apiToken}`,
  ];
  if (answers.readOnly) args.push("--env", "FIREFLY_READ_ONLY=true");
  args.push("--", "npx", "-y", PACKAGE_NAME);
  return spawnSync("claude", args, { stdio: "inherit" }).status === 0;
}

/** True when `running` is an earlier release than `latest`.
 *
 * Only the numeric triple is compared. A maintainer running an unpublished
 * build is ahead, not behind, and must not be told to uninstall it.
 */
export function isOlder(running: string, latest: string): boolean {
  const parse = (value: string): number[] =>
    value.split("-")[0]!.split(".").map((part) => Number.parseInt(part, 10));

  const a = parse(running);
  const b = parse(latest);
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return false;

  for (let i = 0; i < 3; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left < right;
  }
  return false;
}

/** Warn when the running copy is behind what npm publishes.
 *
 * A stale copy is easy to end up with by accident: `npm install` into a
 * directory leaves a version there, and `npx` prefers a local install over the
 * registry, so it silently keeps running the old one. Never fails setup — a
 * version check is not worth blocking a working install over.
 */
async function warnIfOutdated(): Promise<void> {
  const running = packageVersion();
  if (running === "unknown") return;

  try {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/latest`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return;

    const payload: unknown = await response.json();
    if (!isRecord(payload) || typeof payload.version !== "string") return;
    const latest = payload.version;
    if (!isOlder(running, latest)) return;

    console.log(`  You are running ${running}; npm has ${latest}.`);
    console.log("  If that is a copy installed into a directory, npx will keep using it:");
    console.log(`    npm uninstall ${PACKAGE_NAME}`);
    console.log(`  Then run this again with: npx -y ${PACKAGE_NAME}@latest setup\n`);
  } catch {
    // Offline, slow, or the registry is down. None of that should stop setup.
  }
}

export async function runSetup(): Promise<void> {
  const output = new MutableOutput();
  const rl = createInterface({ input: process.stdin, output, terminal: true });

  try {
    console.log("\nFirefly III MCP server — setup\n");
    console.log("This asks for your Firefly III address and API token, checks that they");
    console.log("work, and writes the configuration your AI client needs.\n");

    await warnIfOutdated();

    let apiUrl = "";
    let apiToken = "";
    let version: string | undefined;

    while (version === undefined) {
      const typed = await ask(rl, "Firefly III address (e.g. https://firefly.example.com): ");
      apiUrl = normalizeApiUrl(typed);
      if (apiUrl === "") {
        console.log("  An address is required.\n");
        continue;
      }
      if (apiUrl !== typed.trim()) console.log(`  Using ${apiUrl}`);

      console.log("\n  Find the token in Firefly III under Options -> Profile -> OAuth ->");
      console.log("  Create New Personal Access Token. It is not shown as you type.\n");
      apiToken = await askSecret(rl, output, "Personal Access Token: ");
      if (apiToken === "") {
        console.log("  A token is required.\n");
        continue;
      }

      process.stdout.write("\nChecking the connection... ");
      version = await verifyConnection(apiUrl, apiToken);
      if (version !== undefined) console.log(`connected to Firefly III ${version}.\n`);
    }

    const writes = await ask(rl, "Let the assistant create and change records? [Y/n]: ");
    const readOnly = /^n(o)?$/i.test(writes.trim());
    console.log(
      readOnly
        ? "  Read-only. Write operations are refused and hidden from the assistant.\n"
        : "  Writes enabled. Recording a purchase by asking for it will work.\n",
    );

    const answers: Answers = { apiUrl, apiToken, readOnly };
    const entry = serverEntry(answers);
    let configured = 0;

    if (claudeCodeAvailable()) {
      const answer = await ask(rl, "Claude Code found. Add this server to it? [Y/n]: ");
      if (!/^n(o)?$/i.test(answer.trim())) {
        if (addToClaudeCode(answers)) {
          console.log("  Added to Claude Code.\n");
          configured += 1;
        } else {
          console.log("  `claude mcp add` failed. Add it by hand, or run this again later.\n");
        }
      }
    }

    for (const target of clientTargets()) {
      const exists = existsSync(target.path);
      const answer = await ask(
        rl,
        `${target.name} found. ${exists ? "Update" : "Create"} ${target.path}? [Y/n]: `,
      );
      if (/^n(o)?$/i.test(answer.trim())) continue;

      try {
        const { replaced, backup } = writeTarget(target, entry);
        if (backup !== undefined) console.log(`  Backed up to ${backup}`);
        console.log(`  ${replaced ? "Replaced" : "Added"} the "firefly" entry in ${target.path}\n`);
        configured += 1;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.log(`  Left ${target.path} untouched: ${reason}\n`);
      }
    }

    if (configured === 0) {
      console.log("Nothing was configured. Add this to your client's MCP configuration:\n");
      console.log(JSON.stringify({ mcpServers: { firefly: entry } }, null, 2));
      console.log("");
    } else {
      console.log("Restart your client to pick up the change.");
      console.log('Then try: "list my Firefly III accounts"\n');
    }
  } finally {
    rl.close();
  }
}
