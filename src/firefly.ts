import { Agent } from "undici";
import type { Config } from "./config.js";
import { FireflyApiError } from "./errors.js";

/** A single query parameter value. */
export type QueryValue = string | number | boolean;

/** Query parameters. An array value is emitted as one repeated key per
 * element (`accounts=1&accounts=2`), which is what Firefly expects for its
 * repeated list parameters; comma-joining them would be accepted and quietly
 * mean something else. `undefined` values are dropped. */
export type Query = Record<string, QueryValue | QueryValue[] | undefined>;

export interface FireflyClient {
  get(path: string, query?: Query): Promise<unknown>;
  getText(path: string, query?: Query): Promise<string>;
  /** POST with an optional body and optional query parameters. Firefly's rule
   * test/trigger endpoints take query parameters and no body at all. */
  post(path: string, body?: unknown, query?: Query): Promise<unknown>;
  put(path: string, body: unknown): Promise<unknown>;
  del(path: string, query?: Query): Promise<unknown>;
  postBinary(path: string, content: Uint8Array, contentType?: string): Promise<unknown>;
}

const TIMEOUT_MS = 30_000;

function buildUrl(apiUrl: string, path: string, query?: Query): string {
  const url = new URL(apiUrl.replace(/\/$/, "") + path);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/** RequestInit with the undici-specific dispatcher option that global fetch
 * accepts at runtime but the standard lib.dom RequestInit type does not
 * declare. */
type RequestInitWithDispatcher = RequestInit & { dispatcher?: Agent };

export function createClient(config: Config): FireflyClient {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (config.apiToken.trim() !== "") {
    headers.Authorization = `Bearer ${config.apiToken}`;
  }

  // Self-signed certificates are common on self-hosted Firefly instances.
  const dispatcher = config.disableSslVerify
    ? new Agent({ connect: { rejectUnauthorized: false } })
    : undefined;

  async function request(
    method: string,
    path: string,
    query?: Query,
    body?: unknown,
  ): Promise<unknown> {
    const init: RequestInitWithDispatcher = {
      method,
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    if (dispatcher) init.dispatcher = dispatcher;

    const response = await fetch(buildUrl(config.apiUrl, path, query), init);
    if (!response.ok) throw await FireflyApiError.fromResponse(response);

    const text = await response.text();
    return text === "" ? null : (JSON.parse(text) as unknown);
  }

  return {
    get: (path, query) => request("GET", path, query),
    getText: async (path, query) => {
      const response = await fetch(buildUrl(config.apiUrl, path, query), {
        method: "GET", headers, signal: AbortSignal.timeout(TIMEOUT_MS),
        ...(dispatcher ? { dispatcher } : {}),
      } as RequestInitWithDispatcher);
      if (!response.ok) throw await FireflyApiError.fromResponse(response);
      return response.text();
    },
    post: (path, body, query) => request("POST", path, query, body),
    put: (path, body) => request("PUT", path, undefined, body),
    del: (path, query) => request("DELETE", path, query),
    postBinary: async (path, content, contentType = "application/octet-stream") => {
      const response = await fetch(buildUrl(config.apiUrl, path), {
        method: "POST",
        headers: { Authorization: headers.Authorization ?? "", Accept: "application/json", "Content-Type": contentType },
        body: content,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        ...(dispatcher ? { dispatcher } : {}),
      } as RequestInitWithDispatcher);
      if (!response.ok) throw await FireflyApiError.fromResponse(response);
      const text = await response.text();
      return text === "" ? null : (JSON.parse(text) as unknown);
    },
  };
}
