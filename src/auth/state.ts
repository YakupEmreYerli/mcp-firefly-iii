import { accessSync, chmodSync, constants, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import type { Config } from "../config.js";
import { TOMBSTONE_MS, refreshReuseGraceMs } from "./tokens.js";

export type StoredClient = {
  client_id: string;
  redirect_uris: string[];
  token_endpoint_auth_method: "none";
  grant_types: ["authorization_code", "refresh_token"];
  response_types: ["code"];
};

export type StoredRefresh = {
  hash: string;
  clientId: string;
  subject: string;
  scopes: string[];
  expiresAt: number;
  /** Hash of the first token of this login; every rotation inherits it. Absent on pre-upgrade records (= own hash). */
  familyId?: string;
  /** The token this one was minted from. */
  parentHash?: string;
  /** When a successor of this token was first used: from then on it is superseded. */
  committedAt?: number;
  /** Which successor that was. */
  committedChild?: string;
};

type StateDocument = {
  privateJwk: JsonWebKey;
  publicJwk: JsonWebKey;
  clients: StoredClient[];
  refreshTokens: StoredRefresh[];
};

/** Registered clients kept at once. Far above what any real deployment reaches
 * once identical registrations are handed back rather than duplicated. */
const MAX_CLIENTS = 200;

export class AuthState {
  readonly filePath: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly publicJwk: JsonWebKey;
  private document: StateDocument;

  constructor(config: Config) {
    const directory = config.authStateDir ?? "/data/firefly-mcp-auth";
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      // A Docker volume is mounted 0755 and `mode` on mkdir only applies to a
      // directory this process creates, so tighten it here instead of refusing
      // to start. Refusing would make every default `volumes:` line fatal. If
      // the chmod is not permitted (a bind mount owned by another user), the
      // 0600 on state.json below is what actually keeps the key private.
      try {
        chmodSync(directory, 0o700);
      } catch {
        // Not ours to chmod; the file mode still holds.
      }
      accessSync(directory, constants.W_OK);
    } catch (error) {
      throw new Error(
        `MCP_AUTH_STATE_DIR is not usable (${directory}): ${error instanceof Error ? error.message : String(error)}. ` +
          `This process runs as uid ${process.getuid?.() ?? "unknown"}; a volume mounted here has to be writable by it.`,
      );
    }
    this.filePath = join(directory, "state.json");
    try {
      const raw = readFileSync(this.filePath, "utf8");
      chmodSync(this.filePath, 0o600);
      this.document = JSON.parse(raw) as StateDocument;
      this.privateKey = createPrivateKey({
        key: this.document.privateJwk as import("node:crypto").JsonWebKey,
        format: "jwk",
      });
      this.publicKey = createPublicKey({
        key: this.document.publicJwk as import("node:crypto").JsonWebKey,
        format: "jwk",
      });
      this.publicJwk = this.document.publicJwk;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(
          `MCP_AUTH_STATE_DIR state cannot be read: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
      this.privateKey = pair.privateKey;
      this.publicKey = pair.publicKey;
      this.document = {
        privateJwk: pair.privateKey.export({ format: "jwk" }) as JsonWebKey,
        publicJwk: pair.publicKey.export({ format: "jwk" }) as JsonWebKey,
        clients: [],
        refreshTokens: [],
      };
      this.publicJwk = this.document.publicJwk;
      this.save();
    }
  }

  get clients(): StoredClient[] { return this.document.clients; }
  get refreshTokens(): StoredRefresh[] { return this.document.refreshTokens; }

  save(): void {
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(this.document), { mode: 0o600 });
      renameSync(temporary, this.filePath);
    } catch (error) {
      throw new Error(
        `MCP_AUTH_STATE_DIR cannot be written: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  addClient(client: StoredClient): void {
    this.document.clients.push(client);
    // Registration is open by necessity — a client has nothing to present
    // before it has registered — so this store cannot be bounded by good
    // behaviour and is bounded by size instead. The oldest goes first, and a
    // client whose registration is gone simply registers again: doing that
    // without being asked is what dynamic registration is for.
    const overflow = this.document.clients.length - MAX_CLIENTS;
    if (overflow > 0) {
      const evicted = new Set(this.document.clients.splice(0, overflow).map((entry) => entry.client_id));
      this.document.refreshTokens = this.document.refreshTokens.filter((token) => !evicted.has(token.clientId));
    }
    this.save();
  }

  addRefresh(refresh: StoredRefresh, now: number = Date.now()): void {
    // Sweep on write so the store stays the size of what is live: expired
    // tokens, superseded tokens past their day as reuse tombstones, and
    // successors that lost a race to a sibling that has since been used.
    const graceMs = refreshReuseGraceMs();
    const byHash = new Map(this.document.refreshTokens.map((token) => [token.hash, token]));
    this.document.refreshTokens = this.document.refreshTokens.filter((token) => {
      if (token.expiresAt <= now) return false;
      if (token.committedAt !== undefined && now - token.committedAt > TOMBSTONE_MS) return false;
      const parent = token.parentHash ? byHash.get(token.parentHash) : undefined;
      if (parent?.committedAt !== undefined && parent.committedChild !== token.hash && now - parent.committedAt > graceMs) return false;
      return true;
    });
    this.document.refreshTokens.push(refresh);
    this.save();
  }
  commitRefresh(hash: string, child: string, at: number): void {
    const record = this.document.refreshTokens.find((item) => item.hash === hash);
    if (record && record.committedAt === undefined) {
      record.committedAt = at;
      record.committedChild = child;
    }
    this.save();
  }
  /** Remove every refresh token of one login. Returns how many went. */
  revokeFamily(familyId: string): number {
    const before = this.document.refreshTokens.length;
    this.document.refreshTokens = this.document.refreshTokens.filter((item) => (item.familyId ?? item.hash) !== familyId);
    this.save();
    return before - this.document.refreshTokens.length;
  }
  removeRefresh(hash: string): void {
    this.document.refreshTokens = this.document.refreshTokens.filter((item) => item.hash !== hash);
    this.save();
  }
}
