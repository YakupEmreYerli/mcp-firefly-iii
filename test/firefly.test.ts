import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "../src/firefly.js";
import { FireflyApiError } from "../src/errors.js";
import type { Config } from "../src/config.js";

const config: Config = {
  apiUrl: "https://firefly.example/api/v1",
  apiToken: "token",
  readOnly: false,
  directMode: false,
  enabledEntities: new Set(),
  disableSslVerify: false,
  logLevel: "INFO",
};

function mockFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createClient", () => {
  it("sends the bearer token and JSON headers", async () => {
    const fetchMock = mockFetch(200, { data: [] });
    await createClient(config).get("/accounts");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://firefly.example/api/v1/accounts");
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get("Authorization")).toBe("Bearer token");
    expect(headers.get("Accept")).toBe("application/json");
  });

  it("omits the Authorization header when no token is configured", async () => {
    const fetchMock = mockFetch(200, { data: [] });
    await createClient({ ...config, apiToken: "  " }).get("/accounts");

    const headers = new Headers((fetchMock.mock.calls[0]![1] as RequestInit).headers);
    expect(headers.has("Authorization")).toBe(false);
  });

  it("drops undefined query parameters instead of sending 'undefined'", async () => {
    const fetchMock = mockFetch(200, { data: [] });
    await createClient(config).get("/accounts", { type: "asset", page: undefined });

    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "https://firefly.example/api/v1/accounts?type=asset",
    );
  });

  it("raises the message Firefly returned, not a generic HTTP error", async () => {
    mockFetch(422, { message: "The given data was invalid.", errors: { start: ["bad"] } });

    await expect(createClient(config).get("/accounts/1/transactions")).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("The given data was invalid."),
    });
  });

  it("keeps Firefly's per-field errors on the error object", async () => {
    mockFetch(422, { message: "Invalid", errors: { start: ["bad"] } });

    const error = (await createClient(config)
      .get("/accounts/1/transactions")
      .catch((caught: unknown) => caught)) as FireflyApiError;

    expect(error.errors).toEqual({ start: ["bad"] });
  });

  it("survives an error response that is not JSON", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response("<html>502</html>", { status: 502 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(createClient(config).get("/accounts")).rejects.toMatchObject({ status: 502 });
  });

  it("sends the body unwrapped on PUT", async () => {
    const fetchMock = mockFetch(200, { data: {} });
    await createClient(config).put("/transactions/1", { transactions: [{ amount: "1" }] });

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ transactions: [{ amount: "1" }] });
  });

  it("carries query parameters on POST, which rule test/trigger needs", async () => {
    const fetchMock = mockFetch(200, { data: [] });
    await createClient(config).post("/rules/1/trigger", undefined, { start: "2026-08-01" });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://firefly.example/api/v1/rules/1/trigger?start=2026-08-01");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).body).toBeUndefined();
  });

  it("repeats the key for an array query value instead of comma-joining it", async () => {
    const fetchMock = mockFetch(200, { data: [] });
    await createClient(config).post("/rules/1/test", undefined, { accounts: [1, 2] });

    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "https://firefly.example/api/v1/rules/1/test?accounts=1&accounts=2",
    );
  });

  it("passes an SSL-bypassing dispatcher only when the flag is on", async () => {
    const withVerify = mockFetch(200, { data: [] });
    await createClient(config).get("/about");
    expect(Object.keys(withVerify.mock.calls[0]![1] ?? {})).not.toContain("dispatcher");

    const withoutVerify = mockFetch(200, { data: [] });
    await createClient({ ...config, disableSslVerify: true }).get("/about");
    expect(Object.keys(withoutVerify.mock.calls[0]![1] ?? {})).toContain("dispatcher");
  });

  it("returns null for a 204 with no body", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(createClient(config).del("/accounts/1")).resolves.toBeNull();
  });
});
