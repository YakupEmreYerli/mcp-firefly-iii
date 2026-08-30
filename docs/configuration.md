# Configuration

The server reads every setting from environment variables. Your MCP client
usually passes them in its own configuration; a local checkout can use a `.env`
file in the project root instead.

```bash
cp .env.example .env
```

## Every variable

```bash
# Required: your Firefly III instance. A bare domain is enough
FIREFLY_API_URL=your-firefly.example

# Required: a Personal Access Token from Firefly III
FIREFLY_API_TOKEN=your-token

# Only for a local instance with a self-signed certificate
FIREFLY_DISABLE_SSL_VERIFY=false
```

## API connection

| Variable | Default | Purpose |
|----------|---------|---------|
| `FIREFLY_API_URL` | *(required)* | Firefly III instance: a domain, or a full API base URL |
| `FIREFLY_API_TOKEN` | *(required)* | Personal Access Token |
| `FIREFLY_DISABLE_SSL_VERIFY` | `false` | Disables certificate verification |

A bare domain is expanded to `https://<domain>/api/v1`. Give the full URL when
your instance needs one — behind a subpath, on a custom port, or on plain http:

```bash
FIREFLY_API_URL=firefly.example.com                      # the ordinary case
FIREFLY_API_URL=https://your-server:8080/firefly/api/v1  # taken as written
```

### Getting a token

1. Sign in to Firefly III
2. **Options** → **Profile** → **OAuth**
3. **Create New Personal Access Token**
4. Give it a name you will recognise later
5. Copy the generated token into your configuration

!!! warning "Security"

    Never commit your `.env` file or your API token. `.env` is already in
    `.gitignore`. The token is displayed only once, when it is created.

`FIREFLY_DISABLE_SSL_VERIFY=true` is only for a local instance with a
self-signed certificate. Do not turn it on for a publicly reachable instance: it
disables certificate verification completely.

## Update notices

| Variable | Default | Purpose |
|----------|---------|---------|
| `MCP_UPDATE_CHECK` | `true` | Check once a day whether a newer version has been published |

This project ships from a single `main` and has published a release with a
remotely triggerable crash in it, so an operator who never hears that a fix
exists keeps running the broken one. When the check finds a newer version, the
server writes one line to stderr and adds one sentence to the next tool result
— once per process, never on every call.

It is the only request this server makes to anywhere other than your own
Firefly instance: an anonymous `GET` of this package's public metadata on the
npm registry, sending nothing about you, your instance or your records, at most
once a day, cached under `XDG_CACHE_HOME`, with every failure ignored in
silence. `MCP_UPDATE_CHECK=false` turns it off, as do `NO_UPDATE_NOTIFIER` and
`CI`, which the npm ecosystem already uses for this.

## Remote HTTP and embedded OAuth

| Variable | Default | Purpose |
|----------|---------|---------|
| `MCP_RESOURCE_URL` | *(required for OAuth)* | Public MCP hostname, for example `https://mcp.example.com` |
| `MCP_AUTH_PASSWORD` | empty | Enables the embedded OAuth 2.1 login flow |
| `MCP_AUTH_STATE_DIR` | `/data/firefly-mcp-auth` | Persistent key, client and refresh-token state directory |

`MCP_RESOURCE_URL` has to be a bare origin: `mcp.example.com` or
`https://mcp.example.com`. A subpath such as `/mcp` is not supported. Firefly
III's Laravel Passport already owns `/oauth/authorize`, `/oauth/token` and
`/oauth/clients` on its own hostname, so giving the MCP server a separate
hostname avoids the collision. The connection endpoint itself answers on both
`https://mcp.example.com/` and `https://mcp.example.com/mcp`, the latter kept
for backwards compatibility.

With embedded auth, back the state directory with a Docker volume, and do not
set `MCP_AUTH_PASSWORD` and `MCP_AUTHORIZATION_SERVERS` together. For HTTPS
reverse proxy recipes see
[Remote access with embedded OAuth](oauth.md).

## What the assistant may do

Everything the token can do, over stdio. There is no server-wide permission
setting: `FIREFLY_PERMISSIONS`, `FIREFLY_READ_ONLY` and
`FIREFLY_ENABLED_ENTITIES` were all removed, and a server whose environment
still narrows access with any of them **refuses to start** rather than starting
silently wider than its operator wrote.

Two things decide access instead, and both belong to whoever is connecting:

- **The Firefly token.** A Personal Access Token issued read-only is read-only
  here, enforced by Firefly III rather than by this server. This is the
  guarantee worth having for a shared screen or a demo.
- **The OAuth scopes**, in HTTP mode. `firefly:read`, `firefly:write` and
  `firefly:destructive` are granted per connection at the password screen; a
  surface the connection was not granted is refused *and* hidden — from the
  catalogue, from schema lookups, and from the tool list, since advertising an
  operation that can only fail sends the model down a dead end.

The refusal happens before the request reaches Firefly III and names the scope
that was missing, so a caller can tell "not granted" from "something broke".

## Operating mode

| Variable | Default | Purpose |
|----------|---------|---------|
| `MCP_STRUCTURED_OUTPUT` | `false` | Return `structuredContent` instead of JSON as text |

### `MCP_STRUCTURED_OUTPUT`

Off by default, where every result arrives as JSON inside a text block. Turned
on, results arrive as MCP `structuredContent` and the execution tools advertise
an output schema.

The two are never sent together. The specification suggests mirroring
structured output into a text block so older clients still see something, but
the responses here are not small — `account.list` measures 18 KB against a
personal instance and `transaction.list` 13.5 KB — and duplicating them would
give back much of what the response trimming exists to save. So this is the
operator's call: leave it off unless your client understands
`structuredContent`.

`structuredContent` has to be an object, while the insight endpoints and
`configuration.list` answer with a bare array. Those arrive under a `result`
key; objects pass through unchanged.

The server exposes five meta-tools: `firefly_query`, `firefly_mutate`,
`firefly_destructive`, `firefly_list_operations` and `firefly_get_schema`. All
152 operations are reached through those, split by risk so a host can annotate
them differently.

Listing every operation as its own tool was offered once and removed: it cost
93.5% more of the model's context — 154 KB against 10 KB, measured — and most
clients degrade past roughly forty tools.

## Entities

Every entity is always available. There is no switch that hides one: the
per-entity policy that used to do it is gone, and what a connection may reach
is decided by its scopes.

Available entities:

| Entity | Purpose |
|--------|---------|
| `summary` | Period summary and overview |
| `search` | Finding transactions and accounts without an ID |
| `insight` | Spending and income analysis |
| `account` | Asset, expense, revenue and liability accounts |
| `transaction` | Transactions and transfers |
| `budget` | Budgets and spending limits |
| `category` | Transaction categories |
| `tag` | Transaction tags |
| `bill` | Recurring bills |
| `piggy_bank` | Savings goals |
| `rule` | Automation rules |
| `rule_group` | Rule groups |
| `currency` | Currencies |
| `exchange_rate` | Currency conversion rates |
| `attachment` | Files attached to financial records |
| `recurring_transaction` | Scheduled recurring transactions |
| `autocomplete` | Fast lookup suggestions |
| `available_budget` | Budget available within a period |
| `transaction_link` | Relationships between transactions |
| `link_type` | Names for those relationships |
| `object_group` | Groups of accounts and records |
| `preference` | User preferences |
| `configuration` | Firefly system settings |
| `data_export` | Exporting financial data |

## Remote HTTP mode

These apply only to the `firefly-mcp-http` binary.

| Variable | Default | Purpose |
|----------|---------|---------|
| `MCP_HTTP_HOST` | `127.0.0.1` | Interface to bind |
| `MCP_HTTP_PORT` | `3000` | Port to listen on |
| `MCP_HTTP_TOKEN` | *(required)* | Bearer token every request must carry |

The server refuses to start without `MCP_HTTP_TOKEN`. Put it behind TLS: that
token is the only thing between the internet and write access to your financial
history.

## Verifying the configuration

From a local checkout:

```bash
make check
```

It checks the environment variables, reachability of Firefly III, and that the
MCP tools work against the live instance, in that order. It only reads.

For interactive exploration in a browser:

```bash
make inspector
```

!!! danger "Changes do not apply until the MCP client restarts"

    The MCP client starts the server once and keeps the process open. Changes to
    your configuration or to the source code do not take effect until you
    restart the client (in Claude Code, reconnect with `/mcp`).

## What next?

1. **[Quickstart](quickstart.md)** — test your setup
2. **[MCP Integration](integrations.md)** — connect your client
3. **[Analysis Operations](api/analysis.md)** — start asking questions
