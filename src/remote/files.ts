import { randomBytes } from "node:crypto";
import { stringify } from "yaml";

/** Where the reverse proxy that serves HTTPS runs. A proxy container reaches
 * the server over a shared Docker network; anything outside Docker (a host
 * package, a tunnel daemon) reaches a port published on loopback. */
export type ProxyChoice =
  | { kind: "docker"; network: string; external: boolean }
  | { kind: "host"; port: number }
  | { kind: "tunnel"; port: number };

export type RemoteAnswers = {
  fireflyService: string;
  fireflyNetwork: string;
  apiToken: string;
  resourceUrl: string;
  password: string;
  proxy: ProxyChoice;
  version: string;
};

export type ProxyKind = "caddy" | "traefik" | "npm" | "cloudflare" | "other";

export const OVERRIDE_FILE = "compose.firefly-mcp.yml";
export const ENV_FILE = "firefly-mcp.env";
const SERVICE = "firefly-mcp";
const STATE_DIR = "/data/firefly-mcp-auth";
const VOLUME = "firefly-mcp-auth";

/** The public address clients connect to, as MCP_RESOURCE_URL wants it: an
 * https origin with no path. A mismatch here surfaces only as "invalid token". */
export function validateResourceUrl(input: string): { ok: true; url: string } | { ok: false; reason: string } {
  const text = input.trim();
  if (text === "") return { ok: false, reason: "Enter the address clients will connect to, e.g. mcp.example.com." };
  const candidate = text.includes("://") ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, reason: `"${text}" is not an address.` };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "Claude and ChatGPT connect only over HTTPS; use an https address." };
  if (url.pathname === "/mcp") return { ok: false, reason: "Leave out /mcp: give the bare origin, e.g. https://mcp.example.com. Clients add /mcp themselves." };
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return { ok: false, reason: "Use a host of its own with no path (e.g. mcp.example.com). Firefly III owns its own address, so the server cannot live under it." };
  }
  return { ok: true, url: url.origin };
}

export function generatePassword(): string {
  return randomBytes(24).toString("base64url");
}

function upstream(a: RemoteAnswers): string {
  return a.proxy.kind === "docker" ? `${SERVICE}:3000` : `127.0.0.1:${a.proxy.port}`;
}

/** A compose file to pass with -f next to the user's own; it never edits theirs. */
export function composeOverride(a: RemoteAnswers): string {
  // A proxy on a network of the user's own project (Firefly's, or another
  // one they declared) is joined as is; only a network from outside the
  // project is declared external. Declaring the project's own network
  // external, or listing it twice, breaks `up` for Firefly too.
  const networks = [...new Set(a.proxy.kind === "docker" ? [a.fireflyNetwork, a.proxy.network] : [a.fireflyNetwork])];
  const externalProxy = a.proxy.kind === "docker" && a.proxy.external && a.proxy.network !== a.fireflyNetwork;
  const service: Record<string, unknown> = {
    image: `ghcr.io/yakupemreyerli/mcp-firefly-iii:${a.version}`,
    restart: "unless-stopped",
    env_file: [ENV_FILE],
    environment: {
      FIREFLY_API_URL: `http://${a.fireflyService}:8080`,
      MCP_HTTP_HOST: "0.0.0.0",
      MCP_HTTP_PORT: "3000",
      MCP_AUTH_STATE_DIR: STATE_DIR,
    },
    networks,
    volumes: [`${VOLUME}:${STATE_DIR}`],
  };
  if (a.proxy.kind !== "docker") service.ports = [`127.0.0.1:${a.proxy.port}:3000`];
  const doc: Record<string, unknown> = { services: { [SERVICE]: service }, volumes: { [VOLUME]: {} } };
  if (externalProxy && a.proxy.kind === "docker") doc.networks = { [a.proxy.network]: { external: true } };
  return `# Written by firefly-mcp setup --remote. Start with:\n#   docker compose -f <your compose file> -f ${OVERRIDE_FILE} up -d\n${stringify(doc)}`;
}

/** The secrets, kept out of the compose file. Written with mode 600. */
export function envFile(a: RemoteAnswers): string {
  return [
    "# Written by firefly-mcp setup --remote. Keep this file private.",
    `FIREFLY_API_TOKEN=${a.apiToken}`,
    `MCP_AUTH_PASSWORD=${a.password}`,
    `MCP_RESOURCE_URL=${a.resourceUrl}`,
    "",
  ].join("\n");
}

/** Lines to add to the user's own proxy. The setup prints these; it does not edit proxy configuration. */
export function proxySnippet(kind: ProxyKind, a: RemoteAnswers): string {
  const host = new URL(a.resourceUrl).host;
  const target = upstream(a);
  switch (kind) {
    case "caddy":
      return `${host} {\n    reverse_proxy ${target}\n}`;
    case "traefik":
      return a.proxy.kind === "docker"
        ? [
            `# Add under services.${SERVICE} in ${OVERRIDE_FILE}; use your own entrypoint and certresolver names.`,
            "labels:",
            "  - traefik.enable=true",
            `  - traefik.http.routers.firefly-mcp.rule=Host(\`${host}\`)`,
            "  - traefik.http.routers.firefly-mcp.entrypoints=websecure",
            "  - traefik.http.routers.firefly-mcp.tls.certresolver=letsencrypt",
            "  - traefik.http.services.firefly-mcp.loadbalancer.server.port=3000",
            // The service sits on two networks; without this Traefik may pick
            // the address it cannot reach.
            `  - traefik.docker.network=${a.proxy.network}`,
          ].join("\n")
        : `# Traefik outside Docker: add a router for Host(\`${host}\`) to a service at http://${target}.`;
    case "npm":
      return [
        "Nginx Proxy Manager → Hosts → Proxy Hosts → Add Proxy Host:",
        `  Domain Names:       ${host}`,
        "  Scheme:             http",
        `  Forward Hostname:   ${target.split(":")[0]}`,
        `  Forward Port:       ${target.split(":")[1]}`,
        "  SSL tab:            request a certificate, Force SSL on",
      ].join("\n");
    case "cloudflare":
      return [
        "Cloudflare Zero Trust → Networks → Tunnels → your tunnel → Public Hostname → Add:",
        `  Hostname:  ${host}`,
        `  Service:   http://${target}`,
      ].join("\n");
    case "other":
      return `Route https://${host} to http://${target}. Keep the Host header and do not add a path.`;
  }
}
