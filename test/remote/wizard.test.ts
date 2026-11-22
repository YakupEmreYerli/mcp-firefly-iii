import { describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRemoteSetup, type WizardIO } from "../../src/remote/wizard.js";

const officialCompose = `services:
  app:
    image: fireflyiii/core:latest
    networks:
      - firefly_iii
networks:
  firefly_iii:
    driver: bridge
  proxy:
    external: true
`;

function scripted(answers: string[]): WizardIO & { out: string; asked: string[] } {
  const queue = [...answers];
  const io = {
    out: "",
    asked: [] as string[],
    async ask(q: string) { io.asked.push(q); const a = queue.shift(); if (a === undefined) throw new Error(`no answer for: ${q}`); return a; },
    async askSecret(q: string) { return io.ask(q); },
    print(s: string) { io.out += `${s}\n`; },
  };
  return io;
}

function dirWith(compose?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ffmcp-wizard-"));
  if (compose !== undefined) writeFileSync(join(dir, "docker-compose.yml"), compose);
  return dir;
}

// token, public address, proxy in Docker (1), its network, Caddy (1)
const happy = ["firefly-token", "mcp.example.com", "1", "proxy", "1"];

describe("runRemoteSetup", () => {
  it("writes the two files next to Firefly's compose and leaves that file alone", async () => {
    const dir = dirWith(officialCompose);
    const io = scripted(happy);
    expect(await runRemoteSetup(io, dir, "1.3.0")).toBe(0);
    expect(readFileSync(join(dir, "docker-compose.yml"), "utf8")).toBe(officialCompose);
    const override = readFileSync(join(dir, "compose.firefly-mcp.yml"), "utf8");
    expect(override).toContain("http://app:8080");
    expect(override).toContain("mcp-firefly-iii:1.3.0");
    const env = readFileSync(join(dir, "firefly-mcp.env"), "utf8");
    expect(env).toContain("FIREFLY_API_TOKEN=firefly-token");
    expect(statSync(join(dir, "firefly-mcp.env")).mode & 0o777).toBe(0o600);
  });

  it("ends with the commands to run, the connector address, and the password once", async () => {
    const dir = dirWith(officialCompose);
    const io = scripted(happy);
    await runRemoteSetup(io, dir, "1.3.0");
    const password = /MCP_AUTH_PASSWORD=(.+)/.exec(readFileSync(join(dir, "firefly-mcp.env"), "utf8"))![1]!;
    expect(io.out).toContain("docker compose -f docker-compose.yml -f compose.firefly-mcp.yml up -d");
    expect(io.out).toContain("docker compose -f docker-compose.yml -f compose.firefly-mcp.yml run --rm firefly-mcp doctor");
    expect(io.out).toContain("https://mcp.example.com/mcp");
    expect(io.out).toContain("reverse_proxy firefly-mcp:3000");
    expect(io.out.split(password).length - 1).toBe(1);
  });

  it("asks again after an address it cannot use, saying why", async () => {
    const dir = dirWith(officialCompose);
    const io = scripted(["firefly-token", "http://mcp.example.com", "mcp.example.com", "1", "proxy", "1"]);
    expect(await runRemoteSetup(io, dir, "1.3.0")).toBe(0);
    expect(io.out).toMatch(/HTTPS/);
  });

  it("asks for the service when there is no compose file", async () => {
    const dir = dirWith();
    const io = scripted(["firefly", "backend", ...happy]);
    expect(await runRemoteSetup(io, dir, "1.3.0")).toBe(0);
    expect(readFileSync(join(dir, "compose.firefly-mcp.yml"), "utf8")).toContain("http://firefly:8080");
  });

  it("asks which Firefly service to use when there are several", async () => {
    const dir = dirWith("services:\n  one:\n    image: fireflyiii/core\n  two:\n    image: fireflyiii/core\n");
    const io = scripted(["2", ...happy]);
    expect(await runRemoteSetup(io, dir, "1.3.0")).toBe(0);
    expect(readFileSync(join(dir, "compose.firefly-mcp.yml"), "utf8")).toContain("http://two:8080");
  });

  it("publishes on loopback when the proxy runs on the host", async () => {
    const dir = dirWith(officialCompose);
    const io = scripted(["firefly-token", "mcp.example.com", "2", "3100", "1"]);
    expect(await runRemoteSetup(io, dir, "1.3.0")).toBe(0);
    expect(readFileSync(join(dir, "compose.firefly-mcp.yml"), "utf8")).toContain("127.0.0.1:3100:3000");
    expect(io.out).toContain("reverse_proxy 127.0.0.1:3100");
  });

  it("keeps an existing file when told not to overwrite it", async () => {
    const dir = dirWith(officialCompose);
    writeFileSync(join(dir, "compose.firefly-mcp.yml"), "mine\n");
    const io = scripted([...happy, "n"]);
    expect(await runRemoteSetup(io, dir, "1.3.0")).toBe(1);
    expect(readFileSync(join(dir, "compose.firefly-mcp.yml"), "utf8")).toBe("mine\n");
  });

  it("backs up an existing file before overwriting it", async () => {
    const dir = dirWith(officialCompose);
    writeFileSync(join(dir, "compose.firefly-mcp.yml"), "mine\n");
    const io = scripted([...happy, "y"]);
    expect(await runRemoteSetup(io, dir, "1.3.0")).toBe(0);
    expect(readFileSync(join(dir, "compose.firefly-mcp.yml.bak"), "utf8")).toBe("mine\n");
  });

  it("stops with the right docker command when it cannot write the folder", async () => {
    const dir = dirWith(officialCompose);
    chmodSync(dir, 0o500);
    const io = scripted(happy);
    try {
      expect(await runRemoteSetup(io, dir, "1.3.0")).toBe(1);
      expect(io.out).toContain('--user "$(id -u):$(id -g)"');
      expect(existsSync(join(dir, "firefly-mcp.env"))).toBe(false);
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});
