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

/** A real client registers one or two callbacks. The cap is here because the
 * list was stored verbatim: a single unauthenticated request carrying twenty
 * thousand URLs wrote six hundred kilobytes to the state file, permanently. */
const MAX_REDIRECT_URIS = 8;

/** The same client, by the callbacks it registers? Hosts re-register on every
 * connection — Anthropic's own connector dialog warns that this "creates many
 * client registrations on busy servers" — and handing back the existing
 * registration keeps a working setup from writing a new one each time. */
function sameClient(client: StoredClient, uris: string[]): boolean {
  if (client.redirect_uris.length !== uris.length) return false;
  const known = new Set(client.redirect_uris);
  return uris.every((uri) => known.has(uri));
}

export function registerClient(state: AuthState, input: RegistrationRequest): StoredClient {
  if (!Array.isArray(input.redirect_uris) || input.redirect_uris.length === 0 || !input.redirect_uris.every(validRedirect)) {
    throw new Error("redirect_uris must contain only https:// URLs, or http://localhost and http://127.0.0.1 URLs.");
  }
  if (input.redirect_uris.length > MAX_REDIRECT_URIS) {
    throw new Error(`redirect_uris may name at most ${MAX_REDIRECT_URIS} callbacks.`);
  }
  if (input.token_endpoint_auth_method !== undefined && input.token_endpoint_auth_method !== "none") {
    throw new Error("Only public clients with token_endpoint_auth_method=none are supported.");
  }
  const existing = state.clients.find((candidate) => sameClient(candidate, input.redirect_uris as string[]));
  if (existing) return existing;

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
