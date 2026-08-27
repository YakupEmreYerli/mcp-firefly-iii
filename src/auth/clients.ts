import { randomBytes } from "node:crypto";
import type { StoredClient, AuthState } from "./state.js";

export type RegistrationRequest = {
  redirect_uris?: unknown;
  token_endpoint_auth_method?: unknown;
  grant_types?: unknown;
  response_types?: unknown;
};

function validRedirect(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  } catch { return false; }
}

export function registerClient(state: AuthState, input: RegistrationRequest): StoredClient {
  if (!Array.isArray(input.redirect_uris) || input.redirect_uris.length === 0 || !input.redirect_uris.every(validRedirect)) {
    throw new Error("redirect_uris must contain only https:// URLs, or http://localhost and http://127.0.0.1 URLs.");
  }
  if (input.token_endpoint_auth_method !== undefined && input.token_endpoint_auth_method !== "none") {
    throw new Error("Only public clients with token_endpoint_auth_method=none are supported.");
  }
  const client: StoredClient = {
    client_id: randomBytes(18).toString("base64url"),
    redirect_uris: input.redirect_uris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };
  state.addClient(client);
  return client;
}

export function findClient(state: AuthState, clientId: string): StoredClient | undefined {
  return state.clients.find((client) => client.client_id === clientId);
}
