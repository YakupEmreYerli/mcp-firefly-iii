/** Interactive first-run setup.
 *
 * `npm install` leaves a user holding a package that does nothing on its own —
 * this server is spawned by an MCP client, not run by hand. This command closes
 * that gap: it asks for the two values that matter, proves they work against
 * the live instance before anything depends on them, and writes the client
 * configuration.
 */
import { createInterface, type Interface } from "node:readline/promises";
import * as ui from "./ui.js";
import { isNewer, latestVersion, updateCheckEnabled } from "./update.js";
import { Writable } from "node:stream";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "./firefly.js";
import { FireflyApiError, SetupAborted } from "./errors.js";

export { SetupAborted };
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

export type Answers = { apiUrl: string; apiToken: string };

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

/** Normalize the public MCP address while refusing a path owned by Firefly Passport. */
export function normalizeMcpResourceUrl(input: string): string {
  const text = input.trim();
  if (text === "") return "";
  const candidate = text.includes("://") ? text : `https://${text}`;
  try {
    const url = new URL(candidate);
    if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return "";
    return url.origin;
  } catch {
    return "";
  }
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
        // Input that ended between two questions closes the interface while
        // nothing is pending, so the next `question` throws instead of firing
        // the close handler above. Same situation, same answer — otherwise
        // Ctrl+D during setup printed a readline stack trace.
        const closed = (error as NodeJS.ErrnoException | undefined)?.code === "ERR_USE_AFTER_CLOSE";
        reject(closed ? new SetupAborted() : error instanceof Error ? error : new Error(String(error)));
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
    structuredOutput: false,
    resourceUrl: "",
    authorizationServers: [],
    disableSslVerify: false,
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
  args.push("--", "npx", "-y", PACKAGE_NAME);
  return spawnSync("claude", args, { stdio: "inherit" }).status === 0;
}

/** Warn when the running copy is behind what npm publishes.
 *
 * A stale copy is easy to end up with by accident: `npm install` into a
 * directory leaves a version there, and `npx` prefers a local install over
 * the registry, so it silently keeps running the old one — which is worth
 * saying here, where someone is configuring the thing.
 *
 * The lookup itself belongs to `update.ts`: it already asks this question,
 * with a cache, a timeout and an off switch. A second copy here had its own
 * of each and honoured none of the settings, so someone who had turned update
 * checks off still got one.
 */
async function warnIfOutdated(): Promise<void> {
  const running = packageVersion();
  if (running === "unknown" || !updateCheckEnabled()) return;

  const latest = await latestVersion();
  if (latest === undefined || !isNewer(latest, running)) return;

  ui.warn(`You are running ${running}; npm has ${ui.bold(latest)}.`);
  ui.note("If that is a copy installed into a directory, npx keeps using it:");
  ui.note(`  npm uninstall ${PACKAGE_NAME}`);
  ui.note(`Then run: npx -y ${PACKAGE_NAME}@latest setup`);
  process.stdout.write("\n");
}

export async function runSetup(): Promise<void> {
  const output = new MutableOutput();
  const rl = createInterface({ input: process.stdin, output, terminal: true });

  try {
    ui.heading("Firefly III MCP server — setup", [
      "Asks for your Firefly III address and API token, checks that they",
      "work, and writes the configuration your AI client needs.",
    ]);

    await warnIfOutdated();

    let apiUrl = "";
    let apiToken = "";
    let version: string | undefined;

    while (version === undefined) {
      ui.step(1, 3, "Where is your Firefly III?");
      ui.note("A bare domain is enough — https:// and /api/v1 are filled in.");
      const typed = await ask(rl, `\n  ${ui.bold("Address")} ${ui.dim("(e.g. firefly.example.com)")}: `);
      apiUrl = normalizeApiUrl(typed);
      if (apiUrl === "") {
        ui.bad("An address is required.");
        continue;
      }
      if (apiUrl !== typed.trim()) ui.note(`Reading it as ${apiUrl}`);

      ui.step(2, 3, "Personal Access Token");
      ui.note("Firefly III -> Options -> Profile -> OAuth -> Create New Personal");
      ui.note("Access Token. Nothing is shown as you type.");
      apiToken = await askSecret(rl, output, `\n  ${ui.bold("Token")}: `);
      if (apiToken === "") {
        ui.bad("A token is required.");
        continue;
      }

      ui.step(3, 3, "Checking the connection");
      const check = ui.spinner("Asking your instance who it is...");
      version = await verifyConnection(apiUrl, apiToken);
      if (version === undefined) check.fail("Could not reach it with those details.");
      else check.succeed(`Connected to Firefly III ${ui.bold(version)}.`);
    }

    // No read-only question any more: a stdio client holds the Firefly token
    // itself, so the narrowing it would write was never a boundary the person
    // at this prompt could not undo. Issue a read-only Firefly token instead.
    const answers: Answers = { apiUrl, apiToken };
    const entry = serverEntry(answers);
    let configured = 0;

    if (claudeCodeAvailable()) {
      const answer = await ask(rl, "Claude Code found. Add this server to it? [Y/n]: ");
      if (!/^n(o)?$/i.test(answer.trim())) {
        if (addToClaudeCode(answers)) {
          ui.ok("Added to Claude Code.");
          configured += 1;
        } else {
          ui.bad("`claude mcp add` failed. Add it by hand, or run this again later.");
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
        ui.ok(`${replaced ? "Replaced" : "Added"} the "firefly" entry in ${target.path}`);
        if (backup !== undefined) ui.note(`The previous file is at ${backup}`);
        configured += 1;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        ui.bad(`Left ${target.path} untouched: ${reason}`);
      }
    }

    if (configured === 0) {
      ui.heading("Nothing was configured", ["Add this to your client's MCP configuration:"]);
      console.log(JSON.stringify({ mcpServers: { firefly: entry } }, null, 2));
      console.log("");
    } else {
      ui.heading("Done", [
        `${configured === 1 ? "One client is" : `${configured} clients are`} configured.`,
        "Restart it to pick up the change.",
      ]);
      ui.note("Then try:");
      console.log(`    ${ui.cyan('"list my Firefly III accounts"')}\n`);
    }
  } finally {
    rl.close();
  }
}
