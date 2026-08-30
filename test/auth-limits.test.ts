import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createHttpServer } from "../src/http.js";
import { BuiltinAuth } from "../src/auth/routes.js";
import { registerClient } from "../src/auth/clients.js";
import type { Config } from "../src/config.js";

/** Everything here reaches the server before it has asked for a credential.
 *
 * /oauth/register, /oauth/authorize and /oauth/token have to answer a stranger
 * — a client cannot present a registration it does not have yet — so whatever
 * they allocate, a stranger decides how much of it to allocate.
 */

let server: Server | undefined;
let stateDir = "";

afterEach(() => {
  server?.close();
  server = undefined;
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  stateDir = "";
});

function configFor(resourceUrl: string): Config {
  return {
    apiUrl: "https://firefly.example/api/v1",
    apiToken: "x",
    disableSslVerify: false,
    httpHost: "127.0.0.1",
    httpPort: 0,
    httpToken: "",
    resourceUrl,
    authorizationServers: [],
    authPassword: "a-strong-password-here",
    authStateDir: stateDir,
    structuredOutput: false,
  };
}

/** Listen on a port, then rebuild on the same port so MCP_RESOURCE_URL can name
 * it — the audience check compares against the address clients actually use. */
async function start(): Promise<string> {
  stateDir = mkdtempSync(join(tmpdir(), "firefly-limits-"));
  const probe = createHttpServer(configFor("https://placeholder.example"));
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const resource = `http://127.0.0.1:${port}`;
  server = createHttpServer(configFor(resource));
  await new Promise<void>((resolve) => server!.listen(port, "127.0.0.1", resolve));
  return resource;
}

describe("a request that is cut off", () => {
  it("does not take the process down with it", async () => {
    const base = await start();
    const rejections: unknown[] = [];
    const record = (reason: unknown): void => void rejections.push(reason);
    process.on("unhandledRejection", record);
    try {
      // Announce a body, send a fragment, then rip the socket away. The read in
      // flight rejects with ECONNRESET; nothing used to catch it, and Node
      // turns an unhandled rejection into an uncaught exception, so one aborted
      // login — a phone losing signal mid-POST — killed the server.
      await new Promise<void>((resolve) => {
        const port = Number(new URL(base).port);
        const socket = connect(port, "127.0.0.1", () => {
          socket.write(
            "POST /oauth/token HTTP/1.1\r\nHost: 127.0.0.1\r\n" +
              "Content-Type: application/x-www-form-urlencoded\r\nContent-Length: 100000\r\n\r\n",
          );
          socket.write("grant_type=refresh_token&refresh_token=");
          setTimeout(() => {
            socket.destroy();
            resolve();
          }, 50);
        });
        socket.on("error", () => resolve());
      });
      await new Promise((resolve) => setTimeout(resolve, 250));

      expect(rejections).toEqual([]);
      // Still serving, which is the point of the exercise.
      expect((await fetch(`${base}/health`)).status).toBe(200);
    } finally {
      process.off("unhandledRejection", record);
    }
  });
});

describe("the OAuth routes", () => {
  it("refuse a body larger than the MCP endpoint would take", async () => {
    const base = await start();
    // Eight times the limit /mcp enforces. These routes read with their own
    // reader, which had no limit at all, so this arrived in memory whole and
    // was only then rejected for its contents.
    const huge = "x".repeat(8 * 1024 * 1024);
    const response = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: huge,
    });
    expect(await response.text()).toContain("too large");
  });

  it("cap how many callbacks one registration may name", async () => {
    const base = await start();
    const uris = Array.from({ length: 20_000 }, (_, index) => `https://client.example/cb${index}`);
    const response = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: uris }),
    });
    expect(response.status).toBe(400);
    // Nothing of it reached the file: one request wrote 600 KB of callbacks
    // there before, and nothing ever removed them.
    expect(statSync(join(stateDir, "state.json")).size).toBeLessThan(4096);
  });

  it("hand back the existing registration rather than storing another", async () => {
    const base = await start();
    const register = async (): Promise<string> => {
      const response = await fetch(`${base}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["https://client.example/callback"] }),
      });
      return ((await response.json()) as { client_id: string }).client_id;
    };
    // A host re-registers on every connection; Anthropic's own connector dialog
    // warns that this "creates many client registrations on busy servers".
    const first = await register();
    expect(await register()).toBe(first);
    expect(await register()).toBe(first);
  });
});

describe("pending login forms", () => {
  /** The store is private because nothing outside should spend a form token.
   * Its size is the property under test, and there is no other way to see it. */
  function pendingCount(auth: BuiltinAuth): number {
    return (auth as unknown as { formTokens: Map<string, number> }).formTokens.size;
  }

  it("are not minted for a method the endpoint refuses", async () => {
    stateDir = mkdtempSync(join(tmpdir(), "firefly-forms-"));
    const auth = new BuiltinAuth(configFor("http://127.0.0.1:1"));
    const state = (auth as unknown as { state: Parameters<typeof registerClient>[0] }).state;
    const client = registerClient(state, { redirect_uris: ["https://client.example/callback"] });

    const query = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: "https://client.example/callback",
      code_challenge: "x".repeat(43),
      code_challenge_method: "S256",
      resource: "http://127.0.0.1:1",
    });
    const url = new URL(`/oauth/authorize?${query}`, "http://127.0.0.1:1");

    // A PUT is answered 405. It used to mint and store a token first, so a
    // method the endpoint never serves still cost memory that was never freed.
    for (let attempt = 0; attempt < 50; attempt++) {
      const request = { method: "PUT", url: url.pathname + url.search, socket: { remoteAddress: "127.0.0.1" } };
      const response = { writeHead(): void {}, end(): void {} };
      await auth.handle(
        request as unknown as Parameters<typeof auth.handle>[0],
        response as unknown as Parameters<typeof auth.handle>[1],
        "/oauth/authorize",
      );
    }
    expect(pendingCount(auth)).toBe(0);
  });
});
