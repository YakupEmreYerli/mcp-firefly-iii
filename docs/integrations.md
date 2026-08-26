# MCP Integrations

How to connect the Firefly III MCP server to common MCP clients.

`npx -y @yakupemreyerli/firefly-mcp setup` does all of this interactively —
including checking that your token works before writing anything. The pages
below are the manual equivalent.

The simplest setup runs the published package with `npx`, so there is nothing to
install and no path to get wrong. If you point a client at a local checkout
instead, **paths must be absolute** — a relative path is resolved against the
client's working directory and almost always points somewhere else.

## Claude Code

```bash
claude mcp add firefly \
  --env FIREFLY_API_URL=https://your-firefly.example/api/v1 \
  --env FIREFLY_API_TOKEN=your-token \
  -- npx -y @yakupemreyerli/firefly-mcp
```

Check the connection with `/mcp`, which is also how you reconnect after a
configuration change.

## Claude Desktop

**Where the configuration file lives:**

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "firefly": {
      "command": "npx",
      "args": ["-y", "@yakupemreyerli/firefly-mcp"],
      "env": {
        "FIREFLY_API_URL": "https://your-firefly.example/api/v1",
        "FIREFLY_API_TOKEN": "your-token",
        "FIREFLY_ENABLED_ENTITIES": "all"
      }
    }
  }
}
```

## VS Code

Create an `mcp.json` in the project root or workspace:

```json
{
  "servers": {
    "firefly": {
      "command": "npx",
      "args": ["-y", "@yakupemreyerli/firefly-mcp"],
      "env": {
        "FIREFLY_API_URL": "https://your-firefly.example/api/v1",
        "FIREFLY_API_TOKEN": "your-token",
        "FIREFLY_ENABLED_ENTITIES": "all",
        "FIREFLY_DIRECT_MODE": "false"
      }
    }
  }
}
```

## Cursor

Add this to your workspace or global settings:

```json
{
  "mcp.servers": {
    "firefly": {
      "command": "npx",
      "args": ["-y", "@yakupemreyerli/firefly-mcp"],
      "env": {
        "FIREFLY_API_URL": "https://your-firefly.example/api/v1",
        "FIREFLY_API_TOKEN": "your-token",
        "FIREFLY_ENABLED_ENTITIES": "all",
        "FIREFLY_DIRECT_MODE": "false"
      }
    }
  }
}
```

## Other MCP clients

Most clients follow the same shape:

- **Command**: `npx` with args `["-y", "@yakupemreyerli/firefly-mcp"]`
- **Environment**: your Firefly III configuration

### Running from a local checkout

```json
{
  "command": "node",
  "args": ["dist/index.js"],
  "cwd": "/absolute/path/to/mcp-firefly-iii",
  "env": {
    "FIREFLY_API_URL": "https://your-firefly.example/api/v1",
    "FIREFLY_API_TOKEN": "your-token",
    "FIREFLY_ENABLED_ENTITIES": "all",
    "FIREFLY_DIRECT_MODE": "false"
  }
}
```

Run `npm install && npm run build` in the checkout first, so `dist/` exists.

## Commonly used environment variables

| Variable | Purpose | Example |
|----------|---------|---------|
| `FIREFLY_API_URL` | Firefly III API address | `https://firefly.example.com/api/v1` |
| `FIREFLY_API_TOKEN` | Personal Access Token | `your-token` |
| `FIREFLY_ENABLED_ENTITIES` | Entities to expose | `all` or `account,transaction,summary` |
| `FIREFLY_READ_ONLY` | Refuse write operations | `false` (default) |
| `FIREFLY_DIRECT_MODE` | Individual tools or meta-tools | `false` (default) |

For the full list see [Configuration](configuration.md).

!!! warning "Putting a token in a client configuration file"

    Client configuration files are usually not covered by `.gitignore` and do end
    up in backups. Where the client supports it, prefer a secret store or a
    `.env` file over writing the token into the `env` block.

## Verifying

After configuring:

1. Restart your MCP client
2. Check that the tools appear (in Claude Code, `/mcp`)
3. Try it: "show me my Firefly III accounts"

To check the server's health independently of any client, from a local
checkout:

```bash
make check
```

## Troubleshooting

| Symptom | Where to look |
|---------|---------------|
| **Server not found** | Is the path absolute and correct? |
| **No tools appear** | Is the JSON valid, and did you restart the client? |
| **Connection error** | Verify the API URL and token with `curl`, or run `make check` |
| **SSL error** | For local development only: `"FIREFLY_DISABLE_SSL_VERIFY": "true"` |
| **Writes not working** | `FIREFLY_READ_ONLY` may be on |
| **Changes have no effect** | The client starts the server once; restart it |

That last row is the most common one: a change to your configuration or to the
code does not reach the running process until the MCP client reconnects.

## n8n and remote HTTP use

For remote use instead of local stdio, start the HTTP server:

```bash
export MCP_HTTP_HOST=0.0.0.0
export MCP_HTTP_PORT=3000
export MCP_HTTP_TOKEN=$(openssl rand -hex 32)
npx -y -p @yakupemreyerli/firefly-mcp firefly-mcp-http
```

In production, publish it behind HTTPS with Docker and Caddy or Nginx. In n8n's
MCP Client Tool set the connection type to `HTTP Streamable` and the URL to
`https://your-domain/mcp`; choose Bearer authentication and enter the same
`MCP_HTTP_TOKEN`. The `/health` endpoint needs no authentication.

With Docker, using the prebuilt image (`linux/amd64` and `linux/arm64`):

```bash
docker run -d \
  -e FIREFLY_API_URL=https://your-firefly.example/api/v1 \
  -e FIREFLY_API_TOKEN=your-token \
  -e MCP_HTTP_HOST=0.0.0.0 \
  -e MCP_HTTP_TOKEN="$(openssl rand -hex 32)" \
  -p 3000:3000 \
  ghcr.io/yakupemreyerli/mcp-firefly-iii:latest
```

Or from a checkout, building it yourself:

```bash
cp .env.example .env
# put your Firefly token and MCP_HTTP_TOKEN in .env
docker compose -f compose.example.yml up -d --build
```

Never expose the port directly. That bearer token is the only thing between the
internet and write access to your financial history.
