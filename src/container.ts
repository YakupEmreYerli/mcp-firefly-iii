import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { diagnostic, packageVersion } from "./cli.js";
import { exitCodeFor, formatResults, runDoctor, systemDeps } from "./doctor.js";
import { startHttpServer } from "./http.js";
import { runRemoteSetup, terminalIO } from "./remote/wizard.js";

/** The Docker image's entry point.
 *
 * No arguments runs the HTTP server, as the image always has. `setup` runs
 * the remote setup against the folder mounted at /work, and `doctor` checks a
 * running setup — so `docker run IMAGE setup` and `docker compose run --rm
 * firefly-mcp doctor` work with nothing but Docker installed.
 */
export function containerCommand(argv: readonly string[]): "http" | "setup" | "doctor" | { exec: string[] } {
  if (argv.length === 0) return "http";
  if (argv[0] === "setup" && (argv.length === 1 || (argv.length === 2 && argv[1] === "--remote"))) return "setup";
  if (argv[0] === "doctor" && argv.length === 1) return "doctor";
  // Anything else runs as given, as `docker run IMAGE <command>` and compose
  // `command:` overrides did before this entry point existed.
  return { exec: [...argv] };
}

async function main(): Promise<number> {
  const command = containerCommand(process.argv.slice(2));
  if (command === "http") {
    await startHttpServer();
    return -1; // keep running
  }
  if (command === "setup") {
    const io = terminalIO();
    try {
      return await runRemoteSetup(io, existsSync("/work") ? "/work" : process.cwd(), packageVersion());
    } finally {
      io.close();
    }
  }
  if (command === "doctor") {
    const results = await runDoctor(systemDeps(process.env));
    console.log(formatResults(results));
    return exitCodeFor(results);
  }
  const [file, ...args] = command.exec;
  const child = spawnSync(file!, args, { stdio: "inherit" });
  if (child.error) {
    console.error(`Could not run "${command.exec.join(" ")}": ${child.error.message}. The image also takes: setup, doctor, or no arguments to run the server.`);
    return 1;
  }
  return child.status ?? 1;
}

if (process.argv[1]?.endsWith("container.js")) {
  main().then(
    (code) => { if (code >= 0) process.exit(code); },
    (error: unknown) => { console.error(diagnostic(error)); process.exit(1); },
  );
}
