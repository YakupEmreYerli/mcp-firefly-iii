import { describe, expect, it } from "vitest";
import { exitCodeFor, formatResults, runDoctor, type CheckResult, type DoctorDeps } from "../src/doctor.js";

const good: NodeJS.ProcessEnv = {
  FIREFLY_API_URL: "http://app:8080",
  FIREFLY_API_TOKEN: "token",
  MCP_AUTH_PASSWORD: "a-long-enough-password",
  MCP_RESOURCE_URL: "https://mcp.example.com",
  MCP_AUTH_STATE_DIR: "/data/firefly-mcp-auth",
};

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const healthy: Route = (url) => {
  if (url === "http://app:8080/api/v1/about") return json({ data: { version: "6.7.9" } });
  if (url === "https://mcp.example.com/.well-known/oauth-protected-resource") return json({ resource: "https://mcp.example.com" });
  throw new Error(`unexpected ${url}`);
};

function deps(over: Partial<DoctorDeps> & { route?: Route } = {}): DoctorDeps {
  const route = over.route ?? healthy;
  return {
    env: over.env ?? good,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => route(String(input), init)) as typeof fetch,
    isWritableDir: over.isWritableDir ?? (() => true),
    isMountPoint: over.isMountPoint ?? (() => true),
  };
}

const byName = (results: CheckResult[], name: string) => results.find((r) => r.name === name)!;

describe("runDoctor", () => {
  it("passes a healthy remote setup and exits 0", async () => {
    const results = await runDoctor(deps());
    expect(results.map((r) => r.status)).toEqual(results.map(() => "pass"));
    expect(exitCodeFor(results)).toBe(0);
  });

  it("fails when no auth mode reached the process", async () => {
    const { MCP_AUTH_PASSWORD, ...env } = good;
    const results = await runDoctor(deps({ env }));
    expect(byName(results, "auth").status).toBe("fail");
    expect(exitCodeFor(results)).toBe(1);
  });

  it("fails a password shorter than the server accepts", async () => {
    expect(byName(await runDoctor(deps({ env: { ...good, MCP_AUTH_PASSWORD: "short" } })), "auth").status).toBe("fail");
  });

  it("fails an http or path-carrying public address", async () => {
    for (const value of ["http://mcp.example.com", "https://mcp.example.com/mcp"]) {
      expect(byName(await runDoctor(deps({ env: { ...good, MCP_RESOURCE_URL: value } })), "public address").status, value).toBe("fail");
    }
  });

  it("fails a state directory it cannot write, and warns when it is not on a volume", async () => {
    expect(byName(await runDoctor(deps({ isWritableDir: () => false })), "sign-in storage").status).toBe("fail");
    const notMounted = byName(await runDoctor(deps({ isMountPoint: () => false })), "sign-in storage");
    expect(notMounted.status).toBe("warn");
    expect(notMounted.detail).toMatch(/restart/i);
  });

  it("explains a rejected Firefly token", async () => {
    const route: Route = (url) => url.endsWith("/about") ? json({ message: "Unauthenticated." }, 401) : healthy(url);
    const check = byName(await runDoctor(deps({ route })), "firefly");
    expect(check.status).toBe("fail");
    expect(check.detail).toMatch(/rejected the token/);
  });

  it("notes the category color limit on Firefly older than 6.7.8", async () => {
    const route: Route = (url) => url.endsWith("/about") ? json({ data: { version: "6.6.3" } }) : healthy(url);
    const check = byName(await runDoctor(deps({ route })), "firefly");
    expect(check.status).toBe("pass");
    expect(check.detail).toMatch(/6\.6\.3.*color.*6\.7\.8/);
  });

  // From inside a home network the public address often does not loop back;
  // that says nothing about whether a phone can reach it.
  it("warns, not fails, when the public address cannot be reached from here", async () => {
    const route: Route = (url) => { if (url.startsWith("https://mcp.example.com")) throw new TypeError("fetch failed"); return healthy(url); };
    const results = await runDoctor(deps({ route }));
    const check = byName(results, "reachable from outside");
    expect(check.status).toBe("warn");
    expect(check.fix).toContain("https://mcp.example.com/health");
    expect(exitCodeFor(results)).toBe(0);
  });

  it("fails when the published resource does not match the configured address, showing both", async () => {
    const route: Route = (url) => url.endsWith("oauth-protected-resource") ? json({ resource: "https://firefly-mcp.example.com" }) : healthy(url);
    const check = byName(await runDoctor(deps({ route })), "reachable from outside");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("https://firefly-mcp.example.com");
    expect(check.detail).toContain("https://mcp.example.com");
  });
});

describe("formatResults", () => {
  it("prints one line per check and the fix under a failure", () => {
    const text = formatResults([{ name: "auth", status: "fail", detail: "no auth mode", fix: "set MCP_AUTH_PASSWORD" }, { name: "firefly", status: "pass", detail: "6.7.9" }]);
    expect(text).toMatch(/FAIL\s+auth/);
    expect(text).toContain("set MCP_AUTH_PASSWORD");
    expect(text).toMatch(/PASS\s+firefly/);
  });
});
