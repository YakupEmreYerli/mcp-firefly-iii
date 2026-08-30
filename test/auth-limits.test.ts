import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createHttpServer } from "../src/http.js";
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
