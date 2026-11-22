import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { composeOverride, envFile, generatePassword, proxySnippet, validateResourceUrl, type RemoteAnswers } from "../../src/remote/files.js";

const base: RemoteAnswers = {
  fireflyService: "app",
  fireflyNetwork: "firefly_iii",
  apiToken: "token-value-123",
  resourceUrl: "https://mcp.example.com",
  password: "generated-password-0123456789abcdef",
  proxy: { kind: "docker", network: "proxy" },
  version: "1.3.0",
};
const onHost: RemoteAnswers = { ...base, proxy: { kind: "host", port: 3000 } };

type Doc = { services: Record<string, Record<string, unknown>>; networks?: Record<string, Record<string, unknown>>; volumes?: Record<string, unknown> };

describe("composeOverride", () => {
  it("adds a pinned firefly-mcp service that reaches Firefly over its network", () => {
    const doc = parse(composeOverride(base)) as Doc;
    const service = doc.services["firefly-mcp"]!;
    expect(service.image).toBe("ghcr.io/yakupemreyerli/mcp-firefly-iii:1.3.0");
    expect(service.env_file).toEqual(["firefly-mcp.env"]);
    expect(service.environment).toMatchObject({ FIREFLY_API_URL: "http://app:8080", MCP_AUTH_STATE_DIR: "/data/firefly-mcp-auth" });
    expect(service.networks).toEqual(expect.arrayContaining(["firefly_iii"]));
    expect(service.volumes).toEqual(["firefly-mcp-auth:/data/firefly-mcp-auth"]);
    expect(doc.volumes).toHaveProperty("firefly-mcp-auth");
  });

  it("joins a proxy running in Docker over its external network and publishes no port", () => {
    const doc = parse(composeOverride(base)) as Doc;
    expect(doc.services["firefly-mcp"]!.networks).toEqual(["firefly_iii", "proxy"]);
    expect(doc.networks!.proxy).toEqual({ external: true });
    expect(doc.services["firefly-mcp"]!.ports).toBeUndefined();
  });

  it("publishes on loopback only for a proxy on the host", () => {
    const doc = parse(composeOverride(onHost)) as Doc;
    expect(doc.services["firefly-mcp"]!.ports).toEqual(["127.0.0.1:3000:3000"]);
    expect(doc.services["firefly-mcp"]!.networks).toEqual(["firefly_iii"]);
  });

  it("never writes a secret into the compose file", () => {
    const text = composeOverride(base);
    expect(text).not.toContain(base.apiToken);
    expect(text).not.toContain(base.password);
  });
});

describe("envFile", () => {
  it("holds the token, password and public address, and nothing else secret", () => {
    const text = envFile(base);
    expect(text).toContain("FIREFLY_API_TOKEN=token-value-123");
    expect(text).toContain(`MCP_AUTH_PASSWORD=${base.password}`);
    expect(text).toContain("MCP_RESOURCE_URL=https://mcp.example.com");
    expect(text.split("\n").filter((line) => /^[A-Z_]+=/.test(line))).toHaveLength(3);
  });
});

describe("validateResourceUrl", () => {
  it("accepts a bare domain as https", () => {
    expect(validateResourceUrl("mcp.example.com")).toEqual({ ok: true, url: "https://mcp.example.com" });
  });

  it("refuses http, a path, the /mcp endpoint and an empty answer, saying why", () => {
    for (const input of ["http://mcp.example.com", "https://mcp.example.com/mcp", "https://example.com/firefly", ""]) {
      const result = validateResourceUrl(input);
      expect(result.ok, input).toBe(false);
      if (!result.ok) expect(result.reason.length).toBeGreaterThan(10);
    }
  });
});

describe("generatePassword", () => {
  it("is long and different every time", () => {
    const a = generatePassword();
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(generatePassword()).not.toBe(a);
  });
});

describe("proxySnippet", () => {
  it("points a Docker proxy at the service and a host proxy at loopback", () => {
    expect(proxySnippet("caddy", base)).toContain("reverse_proxy firefly-mcp:3000");
    expect(proxySnippet("caddy", onHost)).toContain("reverse_proxy 127.0.0.1:3000");
  });

  it("names the public host in every snippet", () => {
    for (const kind of ["caddy", "traefik", "npm", "cloudflare", "other"] as const) {
      expect(proxySnippet(kind, base), kind).toContain("mcp.example.com");
    }
  });
});
