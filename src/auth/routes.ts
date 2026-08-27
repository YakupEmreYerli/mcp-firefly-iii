import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { SignJWT, jwtVerify } from "jose";
import type { Config } from "../config.js";
import { SCOPES, grantedScopes } from "../oauth.js";
import { AuthState } from "./state.js";
import { findClient, registerClient } from "./clients.js";
import { AuthorizationCodes } from "./codes.js";
import { issueAccessToken, issueRefreshToken, rotateRefreshToken } from "./tokens.js";
import { consentPage, loginPage } from "./pages.js";

const ALL_SCOPES = [SCOPES.read, SCOPES.write, SCOPES.destructive];

type FormClaims = {
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  scopes: string[];
  ip: string;
  stage: "login" | "consent";
};

function issuer(config: Config): string {
  return new URL(config.resourceUrl!).origin;
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  contentType = "application/json",
): void {
  const value = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(value),
  });
  res.end(value);
}

function redirect(res: ServerResponse, uri: string, params: Record<string, string>): void {
  const target = new URL(uri);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  res.writeHead(302, { Location: target.toString() });
  res.end();
}

function formBody(body: string): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [key, value] of new URLSearchParams(body)) {
    const previous = result[key];
    result[key] = previous === undefined
      ? value
      : Array.isArray(previous)
        ? [...previous, value]
        : [previous, value];
  }
  return result;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export class BuiltinAuth {
  readonly state: AuthState;
  readonly codes = new AuthorizationCodes();
  private readonly formTokens = new Set<string>();
  private readonly failures = new Map<string, { count: number; at: number }>();

  constructor(private readonly config: Config) {
    this.state = new AuthState(config);
  }

  private async formToken(claims: FormClaims): Promise<string> {
    const token = await new SignJWT(claims as Record<string, unknown>)
      .setProtectedHeader({ alg: "ES256", typ: "JWT" })
      .setIssuer(issuer(this.config))
      .setIssuedAt()
      .setExpirationTime("10m")
      .setJti(randomBytes(16).toString("hex"))
      .sign(this.state.privateKey);
    this.formTokens.add(token);
    return token;
  }

  private async consumeForm(token: string): Promise<FormClaims | undefined> {
    if (!this.formTokens.delete(token)) return undefined;
    try {
      const { payload } = await jwtVerify(token, this.state.publicKey, {
        issuer: issuer(this.config),
      });
      return payload as unknown as FormClaims;
    } catch {
      return undefined;
    }
  }

  private responseError(
    res: ServerResponse,
    redirectUri: string | undefined,
    state: string | undefined,
    error: string,
    description: string,
  ): void {
    if (redirectUri) {
      redirect(res, redirectUri, {
        error,
        error_description: description,
        ...(state ? { state } : {}),
        iss: issuer(this.config),
      });
      return;
    }
    send(res, 400, { error, error_description: description, iss: issuer(this.config) });
  }

  private allowedIp(ip: string): boolean {
    const failure = this.failures.get(ip);
    if (!failure) return true;
    const delay = Math.min(30_000, 250 * 2 ** Math.min(failure.count - 1, 7));
    return Date.now() - failure.at >= delay;
  }

  private passwordOk(ip: string, password: string): boolean {
    const presented = createHash("sha256").update(password).digest();
    const expected = createHash("sha256").update(this.config.authPassword ?? "").digest();
    const ok = timingSafeEqual(presented, expected);
    if (ok) this.failures.delete(ip);
    else {
      const previous = this.failures.get(ip);
      this.failures.set(ip, { count: (previous?.count ?? 0) + 1, at: Date.now() });
    }
    return ok;
  }

  async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    const base = issuer(this.config);
    const resource = this.config.resourceUrl!;
    const url = new URL(req.url ?? path, base);
    const ip = req.socket.remoteAddress ?? "unknown";

    if (path === "/.well-known/oauth-authorization-server") {
      if (req.method !== "GET") return false;
      send(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/oauth/token`,
        registration_endpoint: `${base}/oauth/register`,
        jwks_uri: `${base}/oauth/jwks.json`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ALL_SCOPES,
        authorization_response_iss_parameter_supported: true,
      });
      return true;
    }
    if (path === "/oauth/jwks.json" && req.method === "GET") {
      send(res, 200, {
        keys: [{ ...this.state.publicJwk, kid: "firefly-embedded", alg: "ES256", use: "sig" }],
      });
      return true;
    }
    if (path === "/oauth/register" && req.method === "POST") {
      try {
        const input = JSON.parse(await readRequest(req)) as Parameters<typeof registerClient>[1];
        send(res, 201, registerClient(this.state, input));
      } catch (error) {
        send(res, 400, {
          error: "invalid_client_metadata",
          error_description: error instanceof Error ? error.message : String(error),
        });
      }
      return true;
    }
    if (path === "/oauth/authorize") return this.authorize(req, res, url, ip);
    if (path === "/oauth/token" && req.method === "POST") return this.token(req, res);
    return false;
  }

  private async authorize(req: IncomingMessage, res: ServerResponse, url: URL, ip: string): Promise<boolean> {
    const params = url.searchParams;
    const client = findClient(this.state, params.get("client_id") ?? "");
    const redirectUri = params.get("redirect_uri") ?? undefined;
    const state = params.get("state") ?? undefined;

    if (!client || !redirectUri || !client.redirect_uris.includes(redirectUri)) {
      this.responseError(res, undefined, state, "invalid_request", "Unknown client or redirect URI.");
      return true;
    }
    if (
      params.get("response_type") !== "code" ||
      params.get("code_challenge_method") !== "S256" ||
      !params.get("code_challenge") ||
      !params.get("resource") ||
      params.get("resource") !== this.config.resourceUrl
    ) {
      this.responseError(res, redirectUri, state, "invalid_request", "Authorization requires response_type=code, PKCE S256, and the exact resource.");
      return true;
    }

    const requested = (params.get("scope") ?? SCOPES.read)
      .split(" ")
      .filter((scope) => ALL_SCOPES.includes(scope as typeof SCOPES.read));
    const scopes = grantedScopes(requested, this.config.permissions);
    const formToken = await this.formToken({
      clientId: client.client_id,
      redirectUri,
      state,
      codeChallenge: params.get("code_challenge")!,
      scopes,
      ip,
      stage: "login",
    });

    if (req.method === "GET") {
      send(res, 200, loginPage(formToken), "text/html; charset=utf-8");
      return true;
    }
    if (req.method !== "POST") {
      send(res, 405, { error: "method_not_allowed", iss: issuer(this.config) });
      return true;
    }

    const values = formBody(await readRequest(req));
    const claims = await this.consumeForm(first(values.form_token) ?? "");
    if (!claims || claims.ip !== ip) {
      this.responseError(res, redirectUri, state, "invalid_request", "The authorization form expired.");
      return true;
    }
    if (!this.allowedIp(ip)) {
      this.responseError(res, redirectUri, state, "slow_down", "Please wait before trying again.");
      return true;
    }
    if (claims.stage === "login") {
      if (!this.passwordOk(ip, first(values.password) ?? "")) {
        const next = await this.formToken(claims);
        send(res, 401, loginPage(next, "Incorrect password."), "text/html; charset=utf-8");
        return true;
      }
      const consent = await this.formToken({ ...claims, stage: "consent" });
      send(res, 200, consentPage(consent, claims.scopes), "text/html; charset=utf-8");
      return true;
    }

    const selected = (Array.isArray(values.scope) ? values.scope : [values.scope])
      .filter((scope): scope is string => typeof scope === "string" && claims.scopes.includes(scope));
    if (selected.length === 0) {
      this.responseError(res, claims.redirectUri, claims.state, "access_denied", "At least one permission must be selected.");
      return true;
    }
    const code = this.codes.issue({
      clientId: claims.clientId,
      redirectUri: claims.redirectUri,
      codeChallenge: claims.codeChallenge,
      scopes: selected,
    });
    redirect(res, claims.redirectUri, {
      code,
      ...(claims.state ? { state: claims.state } : {}),
      iss: issuer(this.config),
    });
    return true;
  }

  private async token(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const values = formBody(await readRequest(req));
    const grant = first(values.grant_type);
    const clientId = first(values.client_id);
    const base = issuer(this.config);

    if (grant === "refresh_token") {
      if (first(values.resource) !== this.config.resourceUrl) {
        send(res, 400, { error: "invalid_grant" });
        return true;
      }
      try {
        send(res, 200, {
          ...(await rotateRefreshToken(this.state, first(values.refresh_token) ?? "", clientId ?? "", base, this.config.resourceUrl!)),
          token_type: "Bearer",
          expires_in: 3600,
        });
      } catch {
        send(res, 400, { error: "invalid_grant" });
      }
      return true;
    }
    if (grant !== "authorization_code") {
      send(res, 400, { error: "unsupported_grant_type" });
      return true;
    }

    const codeValue = this.codes.consume(first(values.code) ?? "");
    const verifier = first(values.code_verifier) ?? "";
    const verifierMatches = createHash("sha256").update(verifier).digest("base64url") === codeValue?.codeChallenge;
    if (
      !codeValue ||
      codeValue.clientId !== clientId ||
      codeValue.redirectUri !== first(values.redirect_uri) ||
      first(values.resource) !== this.config.resourceUrl ||
      !verifierMatches
    ) {
      send(res, 400, { error: "invalid_grant" });
      return true;
    }

    const access = await issueAccessToken(this.state, base, this.config.resourceUrl!, codeValue.scopes);
    send(res, 200, {
      access_token: access,
      refresh_token: issueRefreshToken(this.state, codeValue.clientId, codeValue.scopes),
      token_type: "Bearer",
      expires_in: 3600,
      scope: codeValue.scopes.join(" "),
    });
    return true;
  }
}

async function readRequest(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
