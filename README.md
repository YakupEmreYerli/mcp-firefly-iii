# Firefly III MCP Server

Give an AI assistant read — and, if you allow it, write — access to your own
[Firefly III](https://www.firefly-iii.org/) instance over the Model Context
Protocol.

139 operations across 24 entities: transactions, accounts, budgets, categories,
tags, bills, piggy banks, rules, plus search and period analysis.

> Türkçe: [README.tr.md](README.tr.md)

Everyone runs this against their **own** Firefly instance with their **own**
token. Nothing is shared, and no data passes through a third party.

## Install

Requires Node.js 20.6+. No install step — your MCP client runs it via `npx`.

### Claude Code

```bash
claude mcp add firefly \
  --env FIREFLY_API_URL=https://your-firefly.example/api/v1 \
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
        "FIREFLY_API_URL": "https://your-firefly.example/api/v1",
        "FIREFLY_API_TOKEN": "your-token"
      }
    }
  }
}
```

Get the token from Firefly III → **Options → Profile → OAuth → Create New
Personal Access Token**. The `/api/v1` suffix on the URL is required.

## Start read-only

Set `FIREFLY_READ_ONLY=true` and every create, update and delete is refused —
and hidden from the tool catalogue, so the assistant does not try. This is worth
doing for any session meant only to answer questions about your money.

```json
"env": {
  "FIREFLY_API_URL": "https://your-firefly.example/api/v1",
  "FIREFLY_API_TOKEN": "your-token",
  "FIREFLY_READ_ONLY": "true"
}
```

## What the assistant sees

Three tools, not 139:

| Tool | Answers |
| --- | --- |
| `firefly_execute` | Run any operation. Its description carries the full catalogue, so choosing one costs no extra call. |
| `firefly_list_operations` | What can I do with this entity? |
| `firefly_get_schema` | What parameters does this operation take? |

Most MCP clients degrade past roughly 40 tools, which is why the surface is
three. Set `FIREFLY_DIRECT_MODE=true` to get one tool per operation instead.

Responses are trimmed before they reach the model: empty and null attributes are
always dropped, and `firefly_execute` takes a `fields` list that keeps only the
attributes you name — on a large transaction list that is roughly a 90% cut.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `FIREFLY_API_URL` | — | Required. Base URL including `/api/v1`. |
| `FIREFLY_API_TOKEN` | — | Required. Personal Access Token. |
| `FIREFLY_READ_ONLY` | `false` | Refuse and hide every write operation. |
| `FIREFLY_DIRECT_MODE` | `false` | One tool per operation instead of three meta-tools. |
| `FIREFLY_ENABLED_ENTITIES` | `all` | Comma-separated entity names to expose. |
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
| [Configuration](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/docs/configuration.md) | Every environment variable, read-only mode, the entity filter, HTTP mode |
| [MCP Integration](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/docs/integrations.md) | Claude Code, Claude Desktop, Cursor, VS Code, n8n and remote HTTP |
| [Operations](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/docs/api/operations.md) | All 139 operations, response trimming, the Firefly quirks that bite |
| [Analysis Operations](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/docs/api/analysis.md) | `summary.overview`, search, and the eight insight endpoints |
| [MCP Inspector](https://github.com/YakupEmreYerli/mcp-firefly-iii/blob/main/docs/development/mcp-inspector.md) | Poking at the server interactively while developing |

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
