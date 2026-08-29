# Firefly III MCP Server

[![npm version](https://img.shields.io/npm/v/%40yakupemreyerli%2Ffirefly-mcp)](https://www.npmjs.com/package/@yakupemreyerli/firefly-mcp)
[![CI](https://github.com/YakupEmreYerli/mcp-firefly-iii/actions/workflows/ci.yml/badge.svg)](https://github.com/YakupEmreYerli/mcp-firefly-iii/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/%40yakupemreyerli%2Ffirefly-mcp)](LICENSE)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-active-brightgreen)](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.YakupEmreYerli%2Fmcp-firefly-iii/versions/latest)

Listed on the [MCP Registry](https://registry.modelcontextprotocol.io/) as
`io.github.YakupEmreYerli/mcp-firefly-iii`.

Give an AI assistant access to your own [Firefly III](https://www.firefly-iii.org/)
instance over the Model Context Protocol — with reading, writing and deleting
kept as three separate, explicitly-scoped surfaces, not one tool that can do
all three.

> Türkçe: [README.tr.md](README.tr.md)

- *"What did I spend the most on last month?"*
- *"Find uncategorised transactions from August and suggest categories."*
- *"Show me subscriptions whose amount went up."*

152 Firefly operations, exposed as 5 MCP tools. Every write supports
`dry_run`, and destructive actions — deleting a record, or rewriting one field
across many at once — sit behind their own scope: a connection granted only
`firefly:read` never even sees them.

Everyone runs this against their **own** Firefly instance with their **own**
token — there is no hosted backend or relay in between. What the AI client
or model you connect it to does with a response afterward is outside this
server's control.

## Why five tools?

Firefly III's API is large. Mapping every endpoint to its own MCP tool would
put 152 individual tools in front of the model — a flat catalogue that costs
context and gets harder for an MCP client to choose from as it grows.

```
152 Firefly operations
        │
        ▼
 typed operation registry
        │
        ▼
   5 MCP meta-tools
        │
        ▼
     your AI client
```

Read, write and destructive operations stay on separate tools instead of one
generic entry point, so a host — or a scoped OAuth connection — can apply a
different policy to each without ever loading the full catalogue into its
tool-selection step.

## Security & control

- **Scoped access, not a single on/off switch.** Over stdio, the limit is the
  Firefly token itself — issue a read-only Personal Access Token for a
  session that should only answer questions, since the server has no
  permission setting of its own to fall back on. Over HTTP with OAuth,
  `firefly:read`, `firefly:write` and `firefly:destructive` are granted per
  connection at the authorization screen, and a surface that was not granted
  is hidden as well as refused.
- **`dry_run` on every write.** Before a mutation or bulk operation runs,
  `dry_run: true` returns the exact request it would send — resolved record
  IDs included — without sending it.
- **Bulk writes can't run blind.** A filter-driven bulk update requires
  `max_matches`; if the scan finds more rows than that, or Firefly's paging
  doesn't confirm the scan was complete, the operation stops before the
  first write. Multi-split transaction groups are rejected outright by bulk
  operations that could silently fold their amounts together — `update` on
  a single transaction is the way to change those.
- **Remote mode won't start unqualified.** Remote HTTP can use a static
  bearer token, or embedded OAuth when you need per-connection scopes. In
  token mode, the server refuses to boot without `MCP_HTTP_TOKEN`, and every
  request to `/mcp` needs `Authorization: Bearer <token>`.
- **What this doesn't cover:** this server doesn't send your data to a third
  party, but it doesn't control what the AI client or model you connect it
  to does with a response once it has one — that's a property of your
  client, not of this server.

Full threat model in
[SECURITY.md](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/SECURITY.md).

## Quick Start

Requires Node.js 20.6+. The quickest way is to let setup do it:

```bash
npx -y @yakupemreyerli/firefly-mcp setup
```

It asks for your Firefly III address and API token, **checks that they actually
work** against your instance, and then configures Claude Code and Claude Desktop
if it finds them — backing up anything it touches and leaving your other MCP
servers alone. For any other client it prints the configuration to paste.

If you would rather do it by hand:

### Claude Code

```bash
claude mcp add firefly \
  --env FIREFLY_API_URL=your-firefly.example \
  --env FIREFLY_API_TOKEN=your-token \
  -- npx -y @yakupemreyerli/firefly-mcp
```

### Claude Desktop, Cursor, and other clients

Add this to the client's MCP configuration file:

```json
{
  "mcpServers": {
    "firefly": {
      "command": "npx",
      "args": ["-y", "@yakupemreyerli/firefly-mcp"],
      "env": {
        "FIREFLY_API_URL": "your-firefly.example",
        "FIREFLY_API_TOKEN": "your-token"
      }
    }
  }
}
```

Get the token from Firefly III → **Options → Profile → OAuth → Create New
Personal Access Token**. For the URL, your domain is enough — `https://` and
`/api/v1` are filled in. Give the full URL if your instance sits behind a
subpath, on a custom port, or on plain http.

## What the assistant sees

The five meta-tools, in full — execution is split by risk, so a host can tell
reading a balance from deleting a transaction:

| Tool | Answers | Risk |
| --- | --- | --- |
| `firefly_query` | Read anything. Its description carries the catalogue, so choosing an operation costs no extra call. | read-only |
| `firefly_mutate` | Create or change a record. | writes |
| `firefly_destructive` | Delete a record, or rewrite one field across many records at once. | cannot be undone |
| `firefly_list_operations` | What can I do with this entity? | read-only |
| `firefly_get_schema` | What parameters does this operation take? | read-only |

Each carries MCP tool annotations (`readOnlyHint`, `destructiveHint`,
`idempotentHint`), and the split is enforced, not merely advertised: a delete
reached through `firefly_query` is refused. A connection granted only
`firefly:read` never sees the two writing tools at all.

Responses are trimmed before they reach the model: empty and null attributes are
always dropped, and every execution tool takes a `fields` list that keeps only the
attributes you name — on a large transaction list that is roughly a 90% cut.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `FIREFLY_API_URL` | — | Required. A bare domain, or a full base URL including `/api/v1`. |
| `FIREFLY_API_TOKEN` | — | Required. Personal Access Token. |
| `FIREFLY_DISABLE_SSL_VERIFY` | `false` | Only for a local instance with a self-signed certificate. |

## Remote HTTP mode

For clients that connect over HTTP rather than spawning a process — n8n, for
example — the same server speaks streamable HTTP:

```bash
export MCP_HTTP_TOKEN=$(openssl rand -hex 32)
npx -y -p @yakupemreyerli/firefly-mcp firefly-mcp-http
```

`firefly-mcp-http` is a second binary inside the same package, which is why
`npx` needs `-p` to name the package and the command separately.

It refuses to start without `MCP_HTTP_TOKEN`, and every request to `/mcp` must
carry `Authorization: Bearer <token>`. `/health` is open, for container probes.
A `Dockerfile` and `compose.example.yml` are in the repository.

Put it behind TLS. The token is the only thing between the internet and write
access to your financial history — do not expose the port directly.

## Documentation

| Page | What it covers |
| --- | --- |
| [Quickstart](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/docs/quickstart.md) | Getting a token, wiring up your client, first things to try, troubleshooting |
| [Configuration](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/docs/configuration.md) | Every environment variable, the permission policy, HTTP mode |
| [MCP Integration](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/docs/integrations.md) | Claude Code, Claude Desktop, Cursor, VS Code, n8n and remote HTTP |
| [Operations](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/docs/api/operations.md) | All 152 operations, response trimming, the Firefly quirks that bite |
| [Analysis Operations](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/docs/api/analysis.md) | `summary.overview`, search, and the eight insight endpoints |
| [MCP Inspector](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/docs/development/mcp-inspector.md) | Poking at the server interactively while developing |

## Docker

For the HTTP mode there is a prebuilt image, for `linux/amd64` and
`linux/arm64`:

```bash
docker run -d \
  -e FIREFLY_API_URL=your-firefly.example \
  -e FIREFLY_API_TOKEN=your-token \
  -e MCP_HTTP_HOST=0.0.0.0 \
  -e MCP_HTTP_TOKEN="$(openssl rand -hex 32)" \
  -p 3000:3000 \
  ghcr.io/yakupemreyerli/mcp-firefly-iii:latest
```

`/health` answers without a token, for container probes. Everything on `/mcp`
needs `Authorization: Bearer <MCP_HTTP_TOKEN>`.

Pin a version tag (see the
[releases page](https://github.com/YakupEmreYerli/mcp-firefly-iii/releases)
— for example `:v1.1.1`) rather than `:latest` for anything you depend on.

## Development

```bash
git clone https://github.com/YakupEmreYerli/mcp-firefly-iii.git
cd mcp-firefly-iii
npm install
cp .env.example .env    # fill in your instance
npm test                # mocked; never touches a live instance
npm run build
npm run check           # read-only connection check against .env
```

Tests are mocked and never reach the network. `npm run smoke:live` is a
maintainer tool that walks every read operation against the instance in `.env`;
it is read-only and is not part of the published package.

## Contributing

Bug reports and pull requests are welcome. See
[CONTRIBUTING.md](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/CONTRIBUTING.md) for the layout of the code, how to run
the tests, and the Firefly III quirks worth knowing before you touch anything.

Found a security problem? Please report it privately — see
[SECURITY.md](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/SECURITY.md).

## License

MIT — see [LICENSE](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/LICENSE).
