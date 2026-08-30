import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clientTargets,
  describeConnectionFailure,
  mergeServerEntry,
  normalizeApiUrl,
  normalizeMcpResourceUrl,
  serverEntry,
} from "../src/setup.js";
import { FireflyApiError } from "../src/errors.js";

describe("normalizeMcpResourceUrl", () => {
  it("accepts a bare domain and root URL", () => {
    expect(normalizeMcpResourceUrl("mcp.example.com")).toBe("https://mcp.example.com");
    expect(normalizeMcpResourceUrl("https://mcp.example.com/")).toBe("https://mcp.example.com");
  });

  it("rejects a subpath owned by Firefly Passport", () => {
    expect(normalizeMcpResourceUrl("https://mcp.example.com/mcp")).toBe("");
  });
});

describe("normalizeApiUrl", () => {
  it("appends the API path a person will not think to type", () => {
    expect(normalizeApiUrl("https://firefly.example.com")).toBe("https://firefly.example.com/api/v1");
  });

  it("leaves an address that already ends in the API path alone", () => {
    expect(normalizeApiUrl("https://firefly.example.com/api/v1")).toBe(
      "https://firefly.example.com/api/v1",
    );
  });

  it("strips trailing slashes rather than doubling them into every request path", () => {
    expect(normalizeApiUrl("https://firefly.example.com///")).toBe(
      "https://firefly.example.com/api/v1",
    );
    expect(normalizeApiUrl("https://firefly.example.com/api/v1/")).toBe(
      "https://firefly.example.com/api/v1",
    );
  });

  it("assumes https when no scheme is given", () => {
    expect(normalizeApiUrl("firefly.example.com")).toBe("https://firefly.example.com/api/v1");
  });

  it("keeps an explicit http scheme, for a local instance", () => {
    expect(normalizeApiUrl("http://localhost:8080")).toBe("http://localhost:8080/api/v1");
  });

  it("keeps a subpath that is not the API path", () => {
    expect(normalizeApiUrl("https://example.com/firefly")).toBe("https://example.com/firefly/api/v1");
  });

  it("returns empty for empty input rather than inventing an address", () => {
    expect(normalizeApiUrl("   ")).toBe("");
  });
});

describe("mergeServerEntry", () => {
  const entry = { command: "npx", args: ["-y", "@yakupemreyerli/firefly-mcp"] };

  it("leaves other MCP servers untouched", () => {
    const existing = {
      mcpServers: {
        github: { command: "gh-mcp" },
        notion: { command: "notion-mcp" },
      },
    };

    const { merged } = mergeServerEntry(existing, "mcpServers", "firefly", entry);
    const servers = merged.mcpServers as Record<string, unknown>;

    expect(Object.keys(servers).sort()).toEqual(["firefly", "github", "notion"]);
    expect(servers.github).toEqual({ command: "gh-mcp" });
  });

  it("keeps unrelated top-level keys", () => {
    const existing = { globalShortcut: "Cmd+Space", mcpServers: {} };

    const { merged } = mergeServerEntry(existing, "mcpServers", "firefly", entry);

    expect(merged.globalShortcut).toBe("Cmd+Space");
  });

  it("reports when it is overwriting an existing entry", () => {
    const existing = { mcpServers: { firefly: { command: "old" } } };

    expect(mergeServerEntry(existing, "mcpServers", "firefly", entry).replaced).toBe(true);
    expect(mergeServerEntry({ mcpServers: {} }, "mcpServers", "firefly", entry).replaced).toBe(false);
  });

  it("creates the wrapper when the file has none", () => {
    const { merged } = mergeServerEntry({}, "mcpServers", "firefly", entry);

    expect(merged.mcpServers).toEqual({ firefly: entry });
  });

  it("does not mutate the document it was given", () => {
    const existing = { mcpServers: { github: { command: "gh-mcp" } } };

    mergeServerEntry(existing, "mcpServers", "firefly", entry);

    expect(Object.keys(existing.mcpServers)).toEqual(["github"]);
  });

  it("replaces a wrapper that is not an object instead of throwing", () => {
    const { merged } = mergeServerEntry({ mcpServers: "nonsense" }, "mcpServers", "firefly", entry);

    expect(merged.mcpServers).toEqual({ firefly: entry });
  });

  it("writes under whichever wrapper key it is given", () => {
    const { merged } = mergeServerEntry({}, "servers", "firefly", entry);

    expect(merged.servers).toEqual({ firefly: entry });
    expect(merged.mcpServers).toBeUndefined();
  });
});

describe("serverEntry", () => {
  const answers = { apiUrl: "https://f.example/api/v1", apiToken: "t" };

  it("runs the published package through npx", () => {
    expect(serverEntry(answers)).toEqual({
      command: "npx",
      args: ["-y", "@yakupemreyerli/firefly-mcp"],
      env: { FIREFLY_API_URL: "https://f.example/api/v1", FIREFLY_API_TOKEN: "t" },
    });
  });

  it("writes no permission setting at all", () => {
    // Both retired settings now stop the server this wizard just configured
    // from starting, so writing either one would hand back a broken install.
    const { env } = serverEntry(answers) as { env: Record<string, string> };

    expect(env).not.toHaveProperty("FIREFLY_PERMISSIONS");
    expect(env).not.toHaveProperty("FIREFLY_READ_ONLY");
  });
});

describe("clientTargets", () => {
  it("offers a client whose directory exists but whose config file does not", () => {
    // Claude Desktop writes its config only once something is configured, so
    // requiring the file would hide the client from every first-time user.
    const home = mkdtempSync(join(tmpdir(), "fmcp-home-"));
    mkdirSync(join(home, ".config", "Claude"), { recursive: true });

    const names = clientTargets(home, "linux").map((target) => target.name);

    expect(names).toEqual(["Claude Desktop"]);
  });

  it("does not offer a client that is not installed", () => {
    const home = mkdtempSync(join(tmpdir(), "fmcp-home-"));

    expect(clientTargets(home, "linux")).toEqual([]);
  });

  it("looks in the macOS location on macOS", () => {
    const home = mkdtempSync(join(tmpdir(), "fmcp-home-"));
    mkdirSync(join(home, "Library", "Application Support", "Claude"), { recursive: true });

    const [target] = clientTargets(home, "darwin");

    expect(target?.path).toBe(
      join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    );
  });

});

describe("describeConnectionFailure", () => {
  it("names the token when Firefly rejects it", () => {
    expect(describeConnectionFailure(new FireflyApiError(401, "Unauthenticated"))).toMatch(/token/i);
  });

  it("points at the address when the API is not where it looked", () => {
    expect(describeConnectionFailure(new FireflyApiError(404, "Not found"))).toMatch(/api\/v1/);
  });

  it("explains an unresolvable hostname in words", () => {
    const error = new Error("getaddrinfo ENOTFOUND firefly.invalid");

    expect(describeConnectionFailure(error)).toMatch(/does not resolve/i);
  });

  it("suggests the SSL flag for a self-signed certificate", () => {
    const error = new Error("self-signed certificate in certificate chain");

    expect(describeConnectionFailure(error)).toMatch(/FIREFLY_DISABLE_SSL_VERIFY/);
  });

  it("passes an unrecognised error through rather than swallowing it", () => {
    expect(describeConnectionFailure(new Error("something else entirely"))).toBe(
      "something else entirely",
    );
  });
});

