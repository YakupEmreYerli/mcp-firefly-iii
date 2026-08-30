import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { packageVersion } from "./cli.js";

/** Tells the person running this server that a newer one exists.
 *
 * This project moves quickly and ships from a single `main`, and the version
 * already published carried a refusal-to-serve bug that one severed socket
 * could trigger. An operator who never learns a fix exists is running the old
 * one indefinitely, so the check earns the one thing this server otherwise
 * never does: a request to somewhere that is not the operator's own Firefly.
 *
 * What that request is, exactly: an unauthenticated GET of this package's
 * public metadata on the npm registry, carrying nothing that identifies the
 * caller, sent no more than once a day, at most once per process, never on the
 * path of a tool call, and silent about every failure. `MCP_UPDATE_CHECK=false`
 * turns it off, as does `NO_UPDATE_NOTIFIER`, which the npm ecosystem already
 * uses for exactly this.
 */

const PACKAGE = "@yakupemreyerli/firefly-mcp";
const REGISTRY = `https://registry.npmjs.org/${encodeURIComponent(PACKAGE)}`;

/** Long enough that a person opening ten sessions in a morning asks once. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Short enough that a registry that has stopped answering costs nothing. The
 * check is never on the path of a tool call, but a socket held open for a
 * minute is still a socket held open for a minute. */
const TIMEOUT_MS = 3000;

type Version = [number, number, number];

/** `1.2.3` as numbers, or undefined for anything else. */
function parse(version: string): Version | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Is `latest` a release beyond `current`?
 *
 * The two sides are read differently, on purpose.
 *
 * `latest` must be a plain triple. A prerelease is refused rather than
 * resolved to its release: npm's `latest` tag never points at one, so a
 * suffix here means something unexpected, and announcing it would push
 * someone onto a build nobody released.
 *
 * `current` may carry a suffix, which is dropped. A maintainer running
 * `1.2.0-beta.1` built from their own tree is *ahead* of the published
 * `1.2.0` and must not be told to reinstall over it — but they are still
 * behind `1.3.0`, and saying nothing would be the less useful mistake.
 */
export function isNewer(latest: string, current: string): boolean {
  const a = parse(latest);
  const b = parse(current.split("-")[0] ?? "");
  if (!a || !b) return false;
  for (let index = 0; index < 3; index++) {
    if (a[index]! !== b[index]!) return a[index]! > b[index]!;
  }
  return false;
}

function cacheFile(): string {
  const base = process.env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache");
  return join(base, "firefly-mcp", "update.json");
}

type Cached = { checkedAt: number; latest: string };

function readCache(): Cached | undefined {
  try {
    const parsed = JSON.parse(readFileSync(cacheFile(), "utf8")) as Cached;
    if (typeof parsed.checkedAt !== "number" || typeof parsed.latest !== "string") return undefined;
    // A clock that has moved backwards would otherwise pin the answer forever.
    if (Date.now() - parsed.checkedAt > CACHE_TTL_MS || parsed.checkedAt > Date.now()) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function writeCache(latest: string): void {
  // A read-only filesystem is the normal case in a hardened container. Failing
  // to remember the answer costs one request a day, so it is not worth saying
  // anything about.
  try {
    const file = cacheFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ checkedAt: Date.now(), latest } satisfies Cached));
  } catch {
    /* not remembered; asked again tomorrow */
  }
}

/** The version npm currently serves as `latest`, or undefined.
 *
 * The abbreviated metadata document is asked for by name: the full one carries
 * every version ever published and is megabytes on a package with any history.
 */
export async function latestVersion(
  fetchImpl: typeof fetch = fetch,
  cancel?: AbortSignal,
): Promise<string | undefined> {
  const cached = readCache();
  if (cached) return cached.latest;
  try {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const response = await fetchImpl(REGISTRY, {
      headers: { Accept: "application/vnd.npm.install-v1+json" },
      signal: cancel ? AbortSignal.any([timeout, cancel]) : timeout,
    });
    if (!response.ok) return undefined;
    const document = (await response.json()) as { "dist-tags"?: { latest?: unknown } };
    const latest = document["dist-tags"]?.latest;
    if (typeof latest !== "string" || parse(latest) === undefined) return undefined;
    writeCache(latest);
    return latest;
  } catch {
    return undefined;
  }
}

/** Module-level, not per-server: HTTP mode builds a fresh McpServer for every
 * request, so anything held on the instance would ask again on each one and
 * repeat the notice forever. */
let pending: Promise<void> | undefined;
let notice: string | undefined;
let delivered = false;
let inFlight: AbortController | undefined;

export function updateCheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  // NO_UPDATE_NOTIFIER is what the npm ecosystem already uses for this, so
  // someone who has turned notices off everywhere has turned this one off too.
  // CI is here because a pipeline is not a person who can act on the answer.
  if ((env.NO_UPDATE_NOTIFIER ?? "").trim() !== "") return false;
  if ((env.CI ?? "").trim() !== "") return false;
  const raw = (env.MCP_UPDATE_CHECK ?? "").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}

/** Start the check, if it is wanted and not already running. Returns at once. */
export function startUpdateCheck(options: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {}): void {
  if (!updateCheckEnabled(options.env)) return;
  if (pending || notice) return;
  const current = packageVersion();
  inFlight = new AbortController();
  pending = latestVersion(options.fetchImpl ?? fetch, inFlight.signal)
    .then((latest) => {
      if (latest === undefined || !isNewer(latest, current)) return;
      notice = `Note from the Firefly MCP server itself, not from any record it read: version ${latest} is available and this one is ${current}. Mention it once, briefly, and carry on — nothing about it changes the answer above, and nothing needs installing to continue.`;
      // stdout belongs to the protocol on stdio; the operator reads stderr.
      console.error(`firefly-mcp ${current} is out of date; ${latest} is available.`);
    })
    .catch(() => undefined);
}

/** The notice, once, and never again in this process.
 *
 * Once because it rides in a tool result, and a line repeated on every call
 * would spend the caller's context on something they read the first time.
 */
export function takeUpdateNotice(): string | undefined {
  if (delivered || notice === undefined) return undefined;
  delivered = true;
  return notice;
}

/** Drop the check if it is still running when the server shuts down.
 *
 * An in-flight request is an open handle, and an open handle keeps Node alive:
 * a stdio server whose client had already gone away sat there for up to the
 * timeout, doing nothing anyone was waiting for. Nothing is lost by abandoning
 * it — the notice had nowhere left to be delivered.
 */
export function cancelUpdateCheck(): void {
  inFlight?.abort();
  inFlight = undefined;
}

/** Test seam: the state above outlives a single test otherwise. */
export function resetUpdateState(): void {
  inFlight = undefined;
  pending = undefined;
  notice = undefined;
  delivered = false;
}

/** Test seam: skip the network and the clock. */
export function setUpdateNoticeForTest(value: string | undefined): void {
  notice = value;
  delivered = false;
}
