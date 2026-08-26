# Quickstart

Get the Firefly III MCP server running in a few minutes.

## Prerequisites

- ✅ Node.js 20.6+
- ✅ A running Firefly III instance
- ✅ A Firefly III Personal Access Token
- ✅ An MCP client (Claude Code, Claude Desktop, or a configured IDE)

## Get a token

1. Sign in to Firefly III
2. **Options** → **Profile** → **OAuth**
3. **Create New Personal Access Token**
4. Give it a name you will recognise later (for example "MCP server")
5. Copy the generated token

The token is shown once. If you lose it you have to create a new one. Treat it
as a password: it grants full access to your financial data.

## Install

There is no install step. Your MCP client runs the server through `npx`.

=== "Claude Code"

    ```bash
    claude mcp add firefly \
      --env FIREFLY_API_URL=https://your-firefly.example/api/v1 \
      --env FIREFLY_API_TOKEN=your-token \
      -- npx -y @yakupemreyerli/firefly-mcp
    ```

=== "Claude Desktop"

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

=== "Cursor"

    Add this to the workspace or global settings:

    ```json
    {
      "mcp.servers": {
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

=== "VS Code"

    Create an `mcp.json` in the project root:

    ```json
    {
      "servers": {
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

The `/api/v1` suffix on the URL is required.

!!! tip "If you only mean to ask questions"

    Add `"FIREFLY_READ_ONLY": "true"`. The server talks to live financial data,
    and a wrong write costs far more than a refused call. In read-only mode
    write operations are hidden from the catalogue as well as refused, so the
    assistant does not attempt them.

Other optional variables are covered in [Configuration](configuration.md).

## Verify

Restart your MCP client, then ask it something harmless — "list my accounts".
If the tools are there, the assistant will answer from your instance.

If you cloned the repository instead of installing from npm, the fastest check
is:

```bash
make check
```

It verifies the environment variables, reachability of Firefly III, and that the
MCP tools work against the live instance. It only reads; it writes nothing.

```
✔ Environment: https://your-firefly.example/api/v1 (token: 1027 chars)
✔ Firefly III 6.6.3 (API 6.6.3, mysql)
✔ MCP server exposes 4 tool(s): firefly_execute, firefly_list_operations, ...
✔ 139 Firefly operations reachable
✔ Read 3 asset account(s) through MCP
All checks passed.
```

To poke at the tools interactively in a browser:

```bash
make inspector
```

## First things to try

**Overview**

- "How much did I spend this month?"
- "Summarise August for me"
- "How does my spending break down by category?"

**Accounts**

- "List all my accounts"
- "What is the balance on my checking account?"
- "How much have I transferred to savings in total?"

**Finding records**

- "Find transactions mentioning 'battery'"
- "What did I spend yesterday?"

**Creating records**

- "I spent 30 at the corner shop on drinks, take it from cash"
- "500 came in from my salary, put it in checking"

## Troubleshooting

### ❌ "Connection failed"

Test the token and URL directly:

```bash
curl -H "Authorization: Bearer TOKEN" \
     "https://your-firefly.example/api/v1/about"
```

### ❌ "No tools available"

1. Restart your MCP client. This is required after a configuration change —
   the client starts the server once and the running process keeps the old
   settings.
2. Check the JSON syntax of your configuration.
3. If you point at a local checkout rather than npx, make sure the paths are
   absolute. Relative paths do not work.

### ❌ "Server not starting"

```bash
node --version    # must be 20.6+
npx -y @yakupemreyerli/firefly-mcp    # should start and wait on stdin
```

### ❌ SSL or certificate errors

Only for a local instance with a self-signed certificate:

```bash
FIREFLY_DISABLE_SSL_VERIFY=true
```

Never turn this on for a publicly reachable instance.

### ❌ Writes are not working

`FIREFLY_READ_ONLY=true` is probably on. Write operations then never appear in
the tool list, and are refused explicitly if called.

## What next?

- 🔧 [Configuration](configuration.md)
- 📊 [Analysis Operations](api/analysis.md)
- 🎯 [All Operations](api/operations.md)
