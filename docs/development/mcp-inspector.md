# MCP Inspector

[MCP Inspector](https://github.com/modelcontextprotocol/inspector) is a tool for
poking at MCP servers interactively from a browser. It is the fastest way to see
what an operation actually returns.

## Running it

```bash
make inspector
```

That is shorthand for:

```bash
npm run build && npx @modelcontextprotocol/inspector node dist/index.js
```

Node.js is required; there is nothing to install — `npx` fetches and runs it.
The interface usually opens at `http://localhost:5173`.

To point it at a different instance:

```bash
FIREFLY_API_URL=https://another-instance.example/api/v1 \
FIREFLY_API_TOKEN=token \
npm run build && npx @modelcontextprotocol/inspector node dist/index.js
```

!!! danger "The Inspector talks to your live data"

    Every `create`, `update` and `delete` you try writes to your real Firefly III
    data. If you are only exploring, set `FIREFLY_PERMISSIONS=read` in `.env` —
    write operations then never appear in the tool list at all.

## The interface

| Tab | Contents |
|-----|----------|
| **Tools** | The tools the server exposes, their parameter schemas, and a place to run them |
| **Resources** | Resources the server exposes (this server has none) |
| **Server Info** | Capabilities, connection state, and the message log |

In the default consolidated mode the Tools tab shows five tools:
`firefly_query`, `firefly_mutate`, `firefly_destructive`,
`firefly_list_operations` and `firefly_get_schema`. All 146 operations are
reached through them. With `FIREFLY_PERMISSIONS=read` the two writing tools are
absent.

## Things to try first

**List the operations**

`firefly_list_operations` dumps which operations exist under which entity. Pass
`entity` to narrow it to one.

**Learn an operation's parameters**

```json
// Tool: firefly_get_schema
{ "entity": "budget", "operation": "create" }
```

**Read something**

```json
// Tool: firefly_query
{
  "entity": "account",
  "operation": "list",
  "params": { "type": "asset", "limit": 5 }
}
```

**Summarise a period**

```json
{
  "entity": "summary",
  "operation": "overview",
  "params": { "start": "2026-08-01", "end": "2026-08-31" }
}
```

**Try a write** *(with read-only mode off)*

```json
{
  "entity": "transaction",
  "operation": "create",
  "params": {
    "transactions": [{
      "type": "withdrawal",
      "date": "2026-08-26T12:00:00+03:00",
      "amount": "30.00",
      "description": "Test expense",
      "source_name": "Cash wallet",
      "destination_name": "Test Shop"
    }]
  }
}
```

Delete the record with `transaction.delete` when you are done experimenting.

## Common problems

### The server will not connect

```bash
# Does the server run on its own?
make check

# Are the dependencies installed?
npm install
```

`make check` reports each step separately, from environment variables through to
Firefly reachability; it locates the problem more precisely than the Inspector
does.

### My changes are not showing up

The Inspector starts the server once. If you changed the code you have to stop
and restart the Inspector — it does not hot-reload.

### 422 validation errors

Firefly III's own message surfaces unchanged, and usually names the field at
fault. Two are confusing:

- **"start must be dated before end"** — only on
  `/accounts/{id}/transactions`, when `start == end`. The server works around it
  internally; you can see it if you hit the raw endpoint yourself.
- **Missing `field`** — `search.accounts` does not work without it. The request
  schema sends `all` by default.

### The write succeeds but nothing changes

Firefly III answers **200 and changes nothing** for a PUT carrying top-level
keys it does not recognise. If an update looks successful, verify it with a
separate read.

For transaction updates, the usual cause is a missing `transaction_journal_id`
inside the split.

## Development loop

The Inspector is good for exploration and verification, not for regression. To
lock a behaviour in permanently, the place is `test/` — it never touches the
network and runs in seconds:

```bash
make test
```

The order that works in practice:

1. See in the Inspector what the operation actually returns
2. Turn what you saw into a test
3. Write or fix the code
4. Verify with `make test`
5. Run `make check` for a live end-to-end check

When fixing a bug, confirm once that your new test **fails against the old
code**. If it does not, the test is not catching that bug.
