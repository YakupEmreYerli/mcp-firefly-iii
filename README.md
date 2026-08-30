# Firefly III MCP Server

[![npm version](https://img.shields.io/npm/v/%40yakupemreyerli%2Ffirefly-mcp)](https://www.npmjs.com/package/@yakupemreyerli/firefly-mcp) [![CI](https://github.com/YakupEmreYerli/mcp-firefly-iii/actions/workflows/ci.yml/badge.svg)](https://github.com/YakupEmreYerli/mcp-firefly-iii/actions/workflows/ci.yml) [![license](https://img.shields.io/npm/l/%40yakupemreyerli%2Ffirefly-mcp)](LICENSE) [![MCP Registry](https://img.shields.io/badge/MCP%20Registry-active-brightgreen)](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.YakupEmreYerli%2Fmcp-firefly-iii/versions/latest) [![Glama](https://img.shields.io/badge/Glama-listed-6f42c1)](https://glama.ai/mcp/servers/@YakupEmreYerli/mcp-firefly-iii)

A Model Context Protocol server that gives an AI assistant access to your own [Firefly III](https://www.firefly-iii.org/) instance — 152 operations behind 5 scoped tools, with reading, writing and deleting kept as three separate, explicitly-authorized surfaces instead of one tool that can do all three.

> Türkçe: [README.tr.md](README.tr.md)

- *"What did I spend the most on last month?"*
- *"Find uncategorised transactions from August and suggest categories."*
- *"Show me subscriptions whose amount went up."*

Everyone runs this against their own Firefly instance with their own token — there is no hosted backend or relay in between.

Listed in the official [MCP Registry](https://registry.modelcontextprotocol.io/) as `io.github.YakupEmreYerli/mcp-firefly-iii`, on [Glama](https://glama.ai/mcp/servers/@YakupEmreYerli/mcp-firefly-iii), and in Firefly III's own [third-party apps](https://docs.firefly-iii.org/references/firefly-iii/third-parties/apps/) documentation. Every release is built and published by CI from a tagged commit, with [npm provenance](https://docs.npmjs.com/generating-provenance-statements) attesting that the tarball came from this repository.

## Demo

https://github.com/user-attachments/assets/4452cc05-387d-44c6-8db4-c71bf3cf21cc

38-second demo: ask a financial question, read the answer through MCP, preview a change with `dry_run`, approve it, and write it back to Firefly III. Recorded against a synthetic instance — all financial data shown is fabricated.

## Features

- **5 meta-tools, not 152.** `firefly_query`, `firefly_mutate`, `firefly_destructive`, plus `firefly_list_operations` and `firefly_get_schema` for discovery — a typed registry maps every Firefly endpoint onto these instead of flooding the model's tool list.
- **`dry_run` on every write**, returning the exact request — resolved record IDs included — without sending it.
- **Bulk writes can't run blind.** Filter-driven updates require `max_matches` and refuse an incomplete scan before the first write; multi-split transaction groups are rejected outright rather than risk folding their amounts together.
- **Read/write/destructive are separately scoped and enforced**, not just annotated — over stdio by the Firefly token, over HTTP by OAuth scope or a static token.
- **Embedded OAuth 2.1 authorization server** for Claude web, Claude mobile, and ChatGPT — no separate Keycloak or Authentik install.
- **Docker images** for `linux/amd64`/`linux/arm64`, and a self-checking documentation pipeline that keeps the tool catalogue in sync with the code.
- **It tells you when it is out of date.** Once a day it checks whether a newer version exists and, if so, says so once — a line on stderr, a sentence beside the next answer. `MCP_UPDATE_CHECK=false` turns it off.

## Prerequisites

- A running Firefly III instance and a Personal Access Token (Firefly III → **Options → Profile → OAuth → Create New Personal Access Token**)
- Node.js 20.6+, unless you're using Docker

## Usage

| Method | Transport | Best for |
| --- | --- | --- |
| [`npx` — stdio](#1-stdio-claude-code-claude-desktop-cursor) | stdio | Claude Code, Claude Desktop, Cursor — simplest setup |
| [Static token](#2-remote-http-with-a-static-token) | HTTP | n8n, automation, headless callers |
| [OAuth](#3-remote-http-with-oauth-claude-web-claude-mobile-chatgpt) | HTTP + OAuth | Claude web, Claude mobile, ChatGPT — can't hold a static token |
| [Docker](#4-docker) | HTTP | Self-hosted, either auth mode above |

### 1. stdio (Claude Code, Claude Desktop, Cursor)

Let setup do it — it asks for your Firefly III address and token, checks that they actually work, then configures Claude Code and Claude Desktop if it finds them: `npx -y @yakupemreyerli/firefly-mcp setup`. For any other client it prints the configuration to paste.

By hand, Claude Code:

```bash
claude mcp add firefly --env FIREFLY_API_URL=your-firefly.example --env FIREFLY_API_TOKEN=your-token -- npx -y @yakupemreyerli/firefly-mcp
```

By hand, Claude Desktop / Cursor / other clients — add to the MCP config file:

```json
{
  "mcpServers": {
    "firefly": {
      "command": "npx",
      "args": ["-y", "@yakupemreyerli/firefly-mcp"],
      "env": { "FIREFLY_API_URL": "your-firefly.example", "FIREFLY_API_TOKEN": "your-token" }
    }
  }
}
```

### 2. Remote HTTP with a static token

For n8n, automation, or any caller that can't drive a browser-based OAuth flow. Set `MCP_HTTP_TOKEN` in `.env`, then run `npx -y -p @yakupemreyerli/firefly-mcp firefly-mcp-http`. Every request to `/mcp` must carry `Authorization: Bearer <token>` — one token, full access, no per-connection scoping.

### 3. Remote HTTP with OAuth (Claude web, Claude mobile, ChatGPT)

None of these clients can hold a static token, and none of them can spawn a local process — they connect to a public HTTPS URL and expect OAuth. With `MCP_AUTH_PASSWORD` set, this server *is* the OAuth 2.1 authorization server: it handles client registration, PKCE and token exchange itself, so there is no Keycloak, no Google sign-in, and no token to copy anywhere.

**Step 1 — give the server a public HTTPS address.** Cloudflare Tunnel is the easiest route for a home server (no port forwarding, no certificate); Caddy or Traefik work on a VPS. `compose.example.yml` ships `cloudflare` and `caddy` profiles for exactly this. Say the result is `https://mcp.example.com`.

**Step 2 — configure `.env`:**

```dotenv
MCP_AUTH_PASSWORD=a-strong-password-of-at-least-12-characters
MCP_RESOURCE_URL=https://mcp.example.com
MCP_AUTH_STATE_DIR=/data/firefly-mcp-auth
```

`MCP_RESOURCE_URL` is the **external origin, character for character, with no path** — not the internal `http://firefly-mcp:3000`, and not the `/mcp` connection URL. A mismatch fails the token audience check and the client only reports "invalid token". `MCP_AUTH_STATE_DIR` must sit on a persistent volume (`compose.example.yml` mounts one) or every restart de-authorizes every client.

**Step 3 — start it and verify:**

```bash
docker compose -f compose.example.yml up -d
curl https://mcp.example.com/health     # {"ok":true,"auth":"oauth-builtin"}
```

If `auth` says `bearer` instead, the password never reached the process and the client will report that the server doesn't support OAuth.

**Step 4a — Claude (web, Desktop, iOS/Android).** **Settings → Connectors → Add custom connector**, URL `https://mcp.example.com/mcp`. Leave the authentication choices as detected — Claude probes the server and picks the flow it supports. The connector then works on every Claude surface you're signed into, phone included.

**Step 4b — ChatGPT.** In the custom connector / MCP screen, enter the same `https://mcp.example.com/mcp` and choose **OAuth** as the authentication method.

**Step 5 — enter the password.** A Firefly login screen opens in the browser; type `MCP_AUTH_PASSWORD`. That one screen is the whole decision — the connection is granted all three scopes (`firefly:read`, `firefly:write`, `firefly:destructive`), whatever the client itself asked for. There is no second consent screen: whoever holds the password could have ticked every box on it. To hand out a connection that genuinely cannot write, give the server a read-only Firefly Personal Access Token instead.

Full TLS recipes and troubleshooting: [docs/oauth.md](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/docs/oauth.md).

### 4. Docker

Recommended for either HTTP mode above:

```bash
cp .env.example .env    # fill in the values for the mode you need
docker compose -f compose.example.yml up -d
```

Swap `build: .` in `compose.example.yml` for `image: ghcr.io/yakupemreyerli/mcp-firefly-iii:latest` to use the prebuilt image — pin a version tag, not `:latest`, for anything you depend on. Single container without Compose: `docker run -d --env-file .env -p 3000:3000 ghcr.io/yakupemreyerli/mcp-firefly-iii:latest`. It refuses to start without one of the two auth modes above, and `/mcp` needs TLS in front — `compose.example.yml` has optional `cloudflare` and `caddy` profiles for that. `/health` is open, for container probes.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `FIREFLY_API_URL` | — | Required. A bare domain, or a full base URL including `/api/v1`. |
| `FIREFLY_API_TOKEN` | — | Required. Personal Access Token. |
| `FIREFLY_DISABLE_SSL_VERIFY` | `false` | Only for a local instance with a self-signed certificate. |
| `MCP_UPDATE_CHECK` | `true` | Daily check for a newer release. The only request this server makes to anywhere but your Firefly instance, and it carries no data. |

Every variable, including HTTP and OAuth mode: [docs/configuration.md](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/docs/configuration.md).

## Tools

| Tool | Answers | Risk |
| --- | --- | --- |
| `firefly_query` | Read anything. Its description carries the catalogue, so choosing an operation costs no extra call. | read-only |
| `firefly_mutate` | Create or change a record. | writes |
| `firefly_destructive` | Delete a record, or rewrite one field across many records at once. | cannot be undone |
| `firefly_list_operations` | What can I do with this entity? | read-only |
| `firefly_get_schema` | What parameters does this operation take? | read-only |

The split is enforced, not just advertised — a delete reached through `firefly_query` is refused, and a connection granted only `firefly:read` never even sees the two writing tools. Responses are trimmed before they reach the model: empty and null attributes are always dropped, and every execution tool takes a `fields` list — roughly a 90% cut on a large transaction list. Full reference: [docs/api/operations.md](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/docs/api/operations.md).

## Security

This server never sends your data to a third party, but it doesn't control what the AI client or model you connect it to does with a response once it has one. Full threat model: [SECURITY.md](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/SECURITY.md). Found a vulnerability? Report it privately there.

## Documentation

| Page | What it covers |
| --- | --- |
| [Quickstart](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/docs/quickstart.md) | Getting a token, wiring up your client, first things to try, troubleshooting |
| [Configuration](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/docs/configuration.md) | Every environment variable, the permission policy, HTTP mode |
| [Remote access with embedded OAuth](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/docs/oauth.md) | Deploying for Claude web, Claude mobile, and ChatGPT |
| [MCP Integration](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/docs/integrations.md) | Claude Code, Claude Desktop, Cursor, VS Code, n8n and remote HTTP |
| [Operations](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/docs/api/operations.md) | All 152 operations, response trimming, the Firefly quirks that bite |
| [Analysis Operations](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/docs/api/analysis.md) | `summary.overview`, search, and the eight insight endpoints |
| [MCP Inspector](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/docs/development/mcp-inspector.md) | Poking at the server interactively while developing |

## Development

```bash
git clone https://github.com/YakupEmreYerli/mcp-firefly-iii.git && cd mcp-firefly-iii
npm install
cp .env.example .env    # fill in your instance
npm test                # mocked; never touches a live instance
npm run build
npm run check           # read-only connection check against .env
```

Tests are mocked and never reach the network. `npm run smoke:live` is a maintainer tool that walks every read operation against the instance in `.env`; it is read-only and not part of the published package. Bug reports and pull requests are welcome — see [CONTRIBUTING.md](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/CONTRIBUTING.md).

## License

MIT — see [LICENSE](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/LICENSE).
