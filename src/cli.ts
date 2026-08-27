import { ConfigurationError, SetupAborted } from "./errors.js";
/** Argument handling for the stdio binary.
 *
 * An MCP client spawns this with no arguments, so "no arguments" must mean
 * "be the server" and nothing else may. Anything unrecognised is refused
 * loudly: the alternative is what an older version did, which was to ignore
 * the argument and sit there as a server waiting on stdin — indistinguishable,
 * to the person who typed it, from a hang.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type Command =
  | { kind: "serve" }
  | { kind: "setup" }
  | { kind: "help"; toStderr: boolean; unknown?: string }
  | { kind: "version" };

export function parseArgs(argv: readonly string[]): Command {
  if (argv.length === 0) return { kind: "serve" };

  const [first, ...rest] = argv;
  if (rest.length > 0) return { kind: "help", toStderr: true, unknown: argv.join(" ") };

  switch (first) {
    case "setup":
      return { kind: "setup" };
    case "--help":
    case "-h":
    case "help":
      return { kind: "help", toStderr: false };
    case "--version":
    case "-v":
      return { kind: "version" };
    default:
      return { kind: "help", toStderr: true, unknown: first };
  }
}

export function packageVersion(): string {
  try {
    const path = fileURLToPath(new URL("../package.json", import.meta.url));
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
      const { version } = parsed as { version: unknown };
      if (typeof version === "string") return version;
    }
  } catch {
    // Reading our own manifest is not worth failing a command over.
  }
  return "unknown";
}

export function usage(): string {
  return [
    "firefly-mcp — Model Context Protocol server for Firefly III",
    "",
    "Usage:",
    "  firefly-mcp                Run the MCP server over stdio. This is how an",
    "                             MCP client starts it; you rarely run it yourself.",
    "  firefly-mcp setup          Configure it interactively: address, token, and",
    "                             the client to write the configuration into.",
    "  firefly-mcp --version      Print the version.",
    "  firefly-mcp --help         Print this.",
    "",
    "  firefly-mcp-http           Run the server over authenticated HTTP instead.",
    "                             Requires MCP_HTTP_TOKEN.",
    "",
    "Configuration comes from the environment: FIREFLY_API_URL and",
    "FIREFLY_API_TOKEN are required. See",
    "https://github.com/YakupEmreYerli/mcp-firefly-iii",
  ].join("\n");
}

/** What to print when a run ends in an error.
 *
 * Two kinds arrive here and they deserve different treatment. A configuration
 * the server will not accept, or a setup the operator abandoned, is a
 * situation they can fix — the one sentence saying which line to change is the
 * whole value, and a stack trace above it buries that sentence. Anything else
 * is a crash, where there is nothing to fix by hand and the trace is the
 * useful part.
 */
export function diagnostic(caught: unknown): unknown {
  return caught instanceof ConfigurationError || caught instanceof SetupAborted ? caught.message : caught;
}
