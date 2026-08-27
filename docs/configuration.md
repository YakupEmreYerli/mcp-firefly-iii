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

# How far the assistant may go (default: unset, meaning everything)
FIREFLY_PERMISSIONS=

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

## Read-only mode

Read-only is a permission level, not a separate switch:

```bash
# Ask questions, change nothing
FIREFLY_PERMISSIONS=read
```

Operations tagged `write` and `destructive` are then both **refused** and
**hidden** — from the tool catalogue and from schema lookups — and the two
writing tools are not registered at all. Read operations are unaffected.

Writes are on by default. Read-only is there for the sessions where you want a
guarantee rather than a habit — a shared screen, a demo, or an agent you have
not watched work yet.

!!! warning "`FIREFLY_READ_ONLY` was removed in 2.0.0"

    It said the same thing as `FIREFLY_PERMISSIONS=read`, and two settings for
    one decision is how they drift apart. A server whose environment still sets
    it to a restricting value **refuses to start** and names the replacement,
    rather than starting silently writable.

The two behaviours work together and both are deliberate. Hiding alone would not
be enforcement; refusing alone would send the model down a dead end every time.
The refusal happens before the request reaches Firefly III, and reports itself
as a read-only error rather than a generic failure — so the caller can tell
"refused by policy" from "something broke".

## Operating mode

| Variable | Default | Purpose |
|----------|---------|---------|
| `FIREFLY_PERMISSIONS` | unset (full) | Finer access control than the read-only switch |
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

### `FIREFLY_PERMISSIONS`

Either a preset:

| Value | Allows |
|-------|--------|
| `read` | Reads only; every write is refused and hidden |
| `safe` | Reads, creates and updates; nothing that cannot be undone |
| `full` | Everything. This is the default when the variable is unset |

A bare level name works as a preset too, so `FIREFLY_PERMISSIONS=write` means
the same as `safe`, and `destructive` the same as `full`.

Or a per-entity list, where `*` sets the fallback for entities it does not name:

```
FIREFLY_PERMISSIONS=transaction:safe;account:read;rule:none;*:read
```

The levels are `none`, `read`, `write` and `destructive`; the preset names are
accepted in a list too, so `transaction:full` means `transaction:destructive`.

A clause that cannot be parsed is dropped
rather than widened — a misspelt entity or level fails closed, so a typo never
grants access nobody asked for.

A narrower policy is available, not advised by default: whoever issues a
full-scope Firefly token has already made the access decision, and this setting
exists to serve a narrower one rather than to second-guess it. `read` is worth
reaching for when a session is only meant to answer questions, and `safe` when
an agent should record transactions but never remove one.

Operations the policy refuses are hidden from the catalogue as well as blocked,
for the same reason writes are hidden in read-only mode: advertising an
operation that can only fail sends the model down a dead end. A surface left
with no operations at all — `firefly_mutate` and `firefly_destructive` under
`FIREFLY_PERMISSIONS=read`, for instance — is not registered as a tool either.

The server exposes five meta-tools: `firefly_query`, `firefly_mutate`,
`firefly_destructive`, `firefly_list_operations` and `firefly_get_schema`. All
146 operations are reached through those, split by risk so a host can annotate
them differently.

Listing every operation as its own tool was offered once and removed: it cost
93.5% more of the model's context — 154 KB against 10 KB, measured — and most
clients degrade past roughly forty tools.

## Hiding an entity

There is no separate entity switch. Giving an entity `none` in
`FIREFLY_PERMISSIONS` hides it completely — from the catalogue, from schema
lookups, and from execution:

```bash
# Accounts and transactions only
FIREFLY_PERMISSIONS=account:full;transaction:full;*:none

# A question-answering setup
FIREFLY_PERMISSIONS=account:read;transaction:read;summary:read;search:read;insight:read;*:none
```

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

!!! warning "`FIREFLY_ENABLED_ENTITIES` was removed in 2.0.0"

    It was a coarser spelling of the same policy. A server whose environment
    still narrows entities with it **refuses to start**, and the message names
    the `FIREFLY_PERMISSIONS` value that hides exactly the same entities.

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
