import { randomBytes } from "node:crypto";

export type AuthorizationCode = {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  expiresAt: number;
};

export class AuthorizationCodes {
  private readonly codes = new Map<string, AuthorizationCode>();

  issue(input: Omit<AuthorizationCode, "code" | "expiresAt">): string {
    const code = randomBytes(32).toString("base64url");
    this.codes.set(code, { ...input, code, expiresAt: Date.now() + 60_000 });
    return code;
  }

  consume(code: string): AuthorizationCode | undefined {
    const value = this.codes.get(code);
    this.codes.delete(code);
    if (!value || value.expiresAt < Date.now()) return undefined;
    return value;
  }
}
