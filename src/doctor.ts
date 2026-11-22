import { accessSync, constants, readFileSync } from "node:fs";
import { FireflyApiError } from "./errors.js";
import { validateResourceUrl } from "./remote/files.js";
import { describeConnectionFailure, normalizeApiUrl } from "./setup.js";
import { compareVersions } from "./version.js";

/** One line of `firefly-mcp doctor`: what was checked, how it went, and what
 * to do about it. A remote setup fails in ways that otherwise surface only as
 * "invalid token" in the client; each check names one of them. */
export type CheckResult = { name: string; status: "pass" | "warn" | "fail"; detail: string; fix?: string };

export type DoctorDeps = {
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  isWritableDir(path: string): boolean;
  isMountPoint(path: string): boolean;
};

const MIN_PASSWORD = 12;
const COLOR_SINCE = "6.7.8";
const TIMEOUT_MS = 8000;

function checkAuth(env: NodeJS.ProcessEnv): CheckResult {
  const password = (env.MCP_AUTH_PASSWORD ?? "").trim();
  if (password !== "") {
    if (password.length < MIN_PASSWORD) {
      return { name: "auth", status: "fail", detail: `MCP_AUTH_PASSWORD is ${password.length} characters; the server needs at least ${MIN_PASSWORD}.`, fix: "Run setup --remote again, or set a longer password in firefly-mcp.env." };
    }
    return { name: "auth", status: "pass", detail: "Password sign-in (OAuth) is on, for Claude and ChatGPT." };
  }
  if ((env.MCP_HTTP_TOKEN ?? "") !== "") {
    return { name: "auth", status: "pass", detail: "Static bearer token. Claude web, Claude mobile and ChatGPT need password sign-in (MCP_AUTH_PASSWORD) instead." };
  }
  return { name: "auth", status: "fail", detail: "No auth mode reached the server: neither MCP_AUTH_PASSWORD nor MCP_HTTP_TOKEN is set.", fix: "Check that firefly-mcp.env is listed under env_file and holds MCP_AUTH_PASSWORD." };
}

function checkPublicAddress(env: NodeJS.ProcessEnv): CheckResult & { url?: string } {
  const result = validateResourceUrl(env.MCP_RESOURCE_URL ?? "");
  if (!result.ok) return { name: "public address", status: "fail", detail: `MCP_RESOURCE_URL: ${result.reason}`, fix: "Set MCP_RESOURCE_URL in firefly-mcp.env to the https origin clients use, e.g. https://mcp.example.com." };
  return { name: "public address", status: "pass", detail: result.url, url: result.url };
}

function checkStateDir(env: NodeJS.ProcessEnv, deps: DoctorDeps): CheckResult {
  const dir = env.MCP_AUTH_STATE_DIR?.trim() || "/data/firefly-mcp-auth";
  if (!deps.isWritableDir(dir)) {
    return { name: "sign-in storage", status: "fail", detail: `${dir} is not writable, so sign-ins cannot be saved.`, fix: "Mount a volume there that the container's user can write (setup --remote writes one)." };
  }
  if (!deps.isMountPoint(dir)) {
    return { name: "sign-in storage", status: "warn", detail: `${dir} is inside the container, not on a volume: every restart signs every client out.`, fix: `Mount a named volume at ${dir}.` };
  }
  return { name: "sign-in storage", status: "pass", detail: `${dir} is on a volume.` };
}

async function getJson(deps: DoctorDeps, url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  const response = await deps.fetch(url, { headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  let body: unknown;
  try { body = await response.json(); } catch { body = undefined; }
  return { status: response.status, body };
}

async function checkFirefly(env: NodeJS.ProcessEnv, deps: DoctorDeps): Promise<CheckResult> {
  const apiUrl = normalizeApiUrl(env.FIREFLY_API_URL ?? "");
  if (apiUrl === "" || (env.FIREFLY_API_TOKEN ?? "") === "") {
    return { name: "firefly", status: "fail", detail: "FIREFLY_API_URL or FIREFLY_API_TOKEN is missing.", fix: "Run setup --remote again, or fill them in." };
  }
  try {
    const { status, body } = await getJson(deps, `${apiUrl}/about`, { Authorization: `Bearer ${env.FIREFLY_API_TOKEN}` });
    if (status >= 400) {
      const message = (body as { message?: unknown } | undefined)?.message;
      throw new FireflyApiError(status, typeof message === "string" ? message : `HTTP ${status}`);
    }
    const version = (body as { data?: { version?: unknown } } | undefined)?.data?.version;
    const shown = typeof version === "string" ? version : "an unknown version";
    const note = typeof version === "string" && /^v?\d/.test(version) && compareVersions(version, COLOR_SINCE) < 0
      ? ` Category color needs Firefly III ${COLOR_SINCE}; on ${version} it is refused.`
      : "";
    return { name: "firefly", status: "pass", detail: `Reached Firefly III ${shown} at ${apiUrl}; the token works.${note}` };
  } catch (error) {
    return { name: "firefly", status: "fail", detail: describeConnectionFailure(error), fix: `The server reaches Firefly at ${apiUrl}; check the service name and that both share a network.` };
  }
}

async function checkReachable(publicUrl: string, deps: DoctorDeps): Promise<CheckResult> {
  const metadata = `${publicUrl}/.well-known/oauth-protected-resource`;
  let result: { status: number; body: unknown };
  try {
    result = await getJson(deps, metadata);
  } catch {
    // From inside a home network the public address often does not loop back.
    return {
      name: "reachable from outside",
      status: "warn",
      detail: `Could not reach ${publicUrl} from here. That can be your network, not the setup.`,
      fix: `Open ${publicUrl}/health on your phone, off Wi-Fi. {"ok":true,...} means clients can connect.`,
    };
  }
  if (result.status >= 400) {
    return { name: "reachable from outside", status: "fail", detail: `${metadata} answered HTTP ${result.status}.`, fix: "Check that your proxy routes this host to the firefly-mcp service and keeps the path." };
  }
  const resource = (result.body as { resource?: unknown } | undefined)?.resource;
  if (resource !== publicUrl) {
    return {
      name: "reachable from outside",
      status: "fail",
      detail: `The server announces ${JSON.stringify(resource)} but MCP_RESOURCE_URL is ${publicUrl}. Clients reject the token when these differ.`,
      fix: "Make sure this host reaches this server, not another one, and that MCP_RESOURCE_URL matches the address exactly.",
    };
  }
  return { name: "reachable from outside", status: "pass", detail: `${publicUrl} answers and announces itself correctly.` };
}

export async function runDoctor(deps: DoctorDeps): Promise<CheckResult[]> {
  const { env } = deps;
  const results: CheckResult[] = [checkAuth(env)];
  const oauth = (env.MCP_AUTH_PASSWORD ?? "").trim() !== "";
  let publicUrl: string | undefined;
  if (oauth) {
    const address = checkPublicAddress(env);
    publicUrl = address.url;
    const { url: _url, ...shown } = address;
    results.push(shown, checkStateDir(env, deps));
  }
  results.push(await checkFirefly(env, deps));
  if (publicUrl) results.push(await checkReachable(publicUrl, deps));
  return results;
}

export function formatResults(results: CheckResult[]): string {
  return results
    .map((r) => {
      const line = `${r.status.toUpperCase().padEnd(5)} ${r.name.padEnd(24)} ${r.detail}`;
      return r.fix && r.status !== "pass" ? `${line}\n${" ".repeat(31)}→ ${r.fix}` : line;
    })
    .join("\n");
}

export function exitCodeFor(results: CheckResult[]): 0 | 1 {
  return results.some((r) => r.status === "fail") ? 1 : 0;
}

/** The real filesystem side of the checks. */
export const systemDeps = (env: NodeJS.ProcessEnv): DoctorDeps => ({
  env,
  fetch,
  isWritableDir(path) {
    try { accessSync(path, constants.W_OK); return true; } catch { return false; }
  },
  isMountPoint(path) {
    try {
      // Field 5 of /proc/self/mountinfo is the mount point.
      return readFileSync("/proc/self/mountinfo", "utf8").split("\n").some((line) => line.split(" ")[4] === path);
    } catch {
      return true; // Not Linux, or not readable: do not warn about what cannot be checked.
    }
  },
});
