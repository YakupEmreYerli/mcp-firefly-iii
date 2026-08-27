import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("reads the API url and token", () => {
    const config = loadConfig({
      FIREFLY_API_URL: "https://firefly.example/api/v1",
      FIREFLY_API_TOKEN: "token",
    });
    expect(config.apiUrl).toBe("https://firefly.example/api/v1");
    expect(config.apiToken).toBe("token");
  });

  it("treats an unparseable boolean as false", () => {
    const config = loadConfig({ FIREFLY_DISABLE_SSL_VERIFY: "evet" });
    expect(config.disableSslVerify).toBe(false);
  });

  it("reads booleans case-insensitively", () => {
    const config = loadConfig({ FIREFLY_DISABLE_SSL_VERIFY: "TRUE" });
    expect(config.disableSslVerify).toBe(true);
  });

  it.each(["1", "yes", "on", "YES", " On "])(
    "accepts %s as a true boolean, like the Python version did",
    (raw) => {
      expect(loadConfig({ FIREFLY_DISABLE_SSL_VERIFY: raw }).disableSslVerify).toBe(true);
    },
  );
});

describe("retired permission settings", () => {
  // All three narrowed what the server would do. Removing them is safe only if
  // a deployment that still sets one cannot start with a *different* meaning
  // than it had — a server that silently becomes writable is exactly the class
  // of failure this project is built against.

  it("refuses to start when FIREFLY_PERMISSIONS would have narrowed access", () => {
    expect(() => loadConfig({ FIREFLY_PERMISSIONS: "read" })).toThrow(/no longer supported/);
    expect(() => loadConfig({ FIREFLY_PERMISSIONS: "transaction:safe;*:read" })).toThrow(/no longer supported/);
  });

  it("starts when FIREFLY_PERMISSIONS restricted nothing", () => {
    // `full` and an empty value both meant "everything", which is now the only
    // thing the server does. Stopping for them would be friction with nothing
    // gained, and .env.example shipped the empty one.
    expect(() => loadConfig({ FIREFLY_PERMISSIONS: "full" })).not.toThrow();
    expect(() => loadConfig({ FIREFLY_PERMISSIONS: "" })).not.toThrow();
  });

  it("refuses to start when FIREFLY_READ_ONLY would have restricted writes", () => {
    expect(() => loadConfig({ FIREFLY_READ_ONLY: "true" })).toThrow(/no longer supported/);
  });

  it("refuses every truthy spelling the old setting took", () => {
    for (const value of ["true", "1", "yes", "on", "TRUE"]) {
      expect(() => loadConfig({ FIREFLY_READ_ONLY: value }), value).toThrow(/no longer supported/);
    }
  });

  it("starts normally when FIREFLY_READ_ONLY said false", () => {
    // .env.example shipped FIREFLY_READ_ONLY=false, so most existing files
    // carry it. It meant "no restriction", which is now the default — stopping
    // for it would be friction with nothing gained.
    expect(() => loadConfig({ FIREFLY_READ_ONLY: "false" })).not.toThrow();
    expect(() => loadConfig({ FIREFLY_READ_ONLY: "" })).not.toThrow();
  });

  it("refuses to start when FIREFLY_ENABLED_ENTITIES would have hidden entities", () => {
    expect(() => loadConfig({ FIREFLY_ENABLED_ENTITIES: "account,transaction" })).toThrow(
      /no longer supported/,
    );
  });

  it("starts normally when FIREFLY_ENABLED_ENTITIES said all", () => {
    // Also shipped in .env.example, and 'all' is the new default.
    expect(() => loadConfig({ FIREFLY_ENABLED_ENTITIES: "all" })).not.toThrow();
    expect(() => loadConfig({ FIREFLY_ENABLED_ENTITIES: "" })).not.toThrow();
  });
});

describe("a domain is enough", () => {
  it("builds the Firefly API url from a bare domain", () => {
    expect(loadConfig({ FIREFLY_API_URL: "firefly.example.com" }).apiUrl).toBe(
      "https://firefly.example.com/api/v1",
    );
  });

  it("leaves a full url alone, including a subpath and a port", () => {
    // Self-hosted Firefly behind a subpath or on a custom port is common, and
    // deriving from a domain would break exactly those installs.
    for (const url of [
      "https://firefly.example/api/v1",
      "https://host:8080/firefly/api/v1",
      "http://192.168.1.10:8080/api/v1",
    ]) {
      expect(loadConfig({ FIREFLY_API_URL: url }).apiUrl, url).toBe(url);
    }
  });

  it("builds the MCP resource url from a bare domain", () => {
    expect(loadConfig({ MCP_RESOURCE_URL: "mcp.example.com" }).resourceUrl).toBe(
      "https://mcp.example.com",
    );
  });

  it("leaves an empty url empty rather than inventing one", () => {
    expect(loadConfig({}).apiUrl).toBe("");
    expect(loadConfig({}).resourceUrl).toBe("");
  });

  it("rejects a resource URL with a path because Firefly Passport owns OAuth paths", () => {
    expect(() => loadConfig({ MCP_RESOURCE_URL: "https://mcp.example.com/mcp" })).toThrow(/clean domain|Passport|subpath/i);
  });

  it("normalizes a root path away", () => {
    expect(loadConfig({ MCP_RESOURCE_URL: "https://mcp.example.com/" }).resourceUrl).toBe("https://mcp.example.com");
  });
});

describe("embedded authorization server settings", () => {
  it("reads the password and state directory", () => {
    const config = loadConfig({ MCP_AUTH_PASSWORD: "a-password-longer-than-12", MCP_AUTH_STATE_DIR: "/tmp/firefly-auth", MCP_RESOURCE_URL: "https://mcp.example" });
    expect(config.authPassword).toBe("a-password-longer-than-12");
    expect(config.authStateDir).toBe("/tmp/firefly-auth");
  });

  it("rejects a short embedded auth password", () => {
    expect(() => loadConfig({ MCP_AUTH_PASSWORD: "too-short" })).toThrow(/12 characters/);
  });

  it("rejects embedded auth together with external authorization servers", () => {
    expect(() => loadConfig({
      MCP_AUTH_PASSWORD: "a-password-longer-than-12",
      MCP_AUTHORIZATION_SERVERS: "https://idp.example",
      MCP_RESOURCE_URL: "https://mcp.example",
    })).toThrow(/MCP_AUTH_PASSWORD.*MCP_AUTHORIZATION_SERVERS|MCP_AUTHORIZATION_SERVERS.*MCP_AUTH_PASSWORD/);
  });

  it("requires a resource URL for embedded auth", () => {
    expect(() => loadConfig({ MCP_AUTH_PASSWORD: "a-password-longer-than-12" })).toThrow(/MCP_RESOURCE_URL/);
  });
});
