# Configuration

The server reads every setting from environment variables. Your MCP client
usually passes them in its own configuration; a local checkout can use a `.env`
file in the project root instead.

```bash
cp .env.example .env
```

## Every variable

```bash
# Required: your Firefly III API base URL (the trailing /api/v1 is required)
FIREFLY_API_URL=https://your-firefly.example/api/v1

# Required: a Personal Access Token from Firefly III
FIREFLY_API_TOKEN=your-token

# Which entities to expose (default: all)
FIREFLY_ENABLED_ENTITIES=all

# false → 3 meta-tools; true → one tool per operation (default: false)
FIREFLY_DIRECT_MODE=false

# true → write operations are refused and hidden (default: false)
FIREFLY_READ_ONLY=false

# Only for a local instance with a self-signed certificate
FIREFLY_DISABLE_SSL_VERIFY=false
```

## API connection

| Variable | Default | Purpose |
|----------|---------|---------|
| `FIREFLY_API_URL` | *(required)* | Firefly III API base URL |
| `FIREFLY_API_TOKEN` | *(required)* | Personal Access Token |
| `FIREFLY_DISABLE_SSL_VERIFY` | `false` | Disables certificate verification |

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

## Read-only mode

| Variable | Default | Purpose |
|----------|---------|---------|
| `FIREFLY_READ_ONLY` | `false` | Refuses every write operation |

With `FIREFLY_READ_ONLY=true`, operations tagged `write` (create, update,
delete) are both **refused** and **hidden** — from the tool catalogue and from
schema lookups. Read operations are unaffected.

```bash
# Ask questions, change nothing
FIREFLY_READ_ONLY=true
```

Writes are on by default. Read-only is there for the sessions where you want a
guarantee rather than a habit — a shared screen, a demo, or an agent you have
not watched work yet.

The two behaviours work together and both are deliberate. Hiding alone would not
be enforcement; refusing alone would send the model down a dead end every time.
The refusal happens before the request reaches Firefly III, and reports itself
as a read-only error rather than a generic failure — so the caller can tell
"refused by policy" from "something broke".

## Operating mode

| Variable | Default | Purpose |
|----------|---------|---------|
| `FIREFLY_DIRECT_MODE` | `false` | How operations are presented as tools |

**Consolidated mode (default)** exposes three meta-tools: `firefly_execute`,
`firefly_list_operations`, `firefly_get_schema`. All 139 operations are reached
through those three. This is the default because most MCP clients degrade past
roughly 40 tools.

**Direct mode** gives every operation its own tool (`account_list`,
`transaction_create`, and so on). The tool names are more explicit, but 139
tools is too many for most clients. It makes sense in narrow automations where
you enable only a few entities.

## Entity filter

| Variable | Default | Purpose |
|----------|---------|---------|
| `FIREFLY_ENABLED_ENTITIES` | `all` | Which entities to expose |

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

```bash
# Everything
FIREFLY_ENABLED_ENTITIES=all

# Accounts and transactions only
FIREFLY_ENABLED_ENTITIES=account,transaction

# A question-answering setup
FIREFLY_ENABLED_ENTITIES=account,transaction,summary,search,insight

# Budget tracking
FIREFLY_ENABLED_ENTITIES=account,budget,category,tag
```

An unrecognised entity name is ignored; the server still starts.

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
