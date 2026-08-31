# Installing this server, for an AI agent

You are setting up the Firefly III MCP server for someone who is watching you
do it. Follow this in order. Everything here is checkable, so check it rather
than assuming it worked.

## Before you start

Two values are needed and only the person can supply them. Ask for both in one
message rather than one at a time:

1. **Their Firefly III address** — a domain is enough (`firefly.example.com`);
   `https://` and `/api/v1` are filled in automatically. A full base URL is
   also accepted, and is required if their instance sits under a subpath, on a
   custom port, or on plain `http`.
2. **A Personal Access Token**, created in Firefly III under
   **Options → Profile → OAuth → Create New Personal Access Token**. Firefly
   shows it once, at creation.

The token can read and modify their entire financial history. Do not write it
into a file that is committed, do not echo it back in your reply, and do not
send it anywhere other than the configuration file below. If they want a
connection that cannot change anything, tell them to issue a **read-only**
token — this server has no permission setting of its own, and over stdio the
token is the only limit that exists.

Node.js 20.6 or newer is required. Check with `node --version`.

## The configuration

One stdio server, launched with `npx`. Add it to the MCP configuration file of
whichever client they use, merging into `mcpServers` rather than replacing the
object — they will have other servers there.

```json
{
  "mcpServers": {
    "firefly": {
      "command": "npx",
      "args": ["-y", "@yakupemreyerli/firefly-mcp"],
      "env": {
        "FIREFLY_API_URL": "firefly.example.com",
        "FIREFLY_API_TOKEN": "the-token-they-gave-you"
      }
    }
  }
}
```

For Claude Code, the equivalent one-liner writes the same thing:

```bash
claude mcp add firefly \
  --env FIREFLY_API_URL=firefly.example.com \
  --env FIREFLY_API_TOKEN=the-token \
  -- npx -y @yakupemreyerli/firefly-mcp
```

There is also an interactive installer, `npx -y @yakupemreyerli/firefly-mcp
setup`, which asks for both values, verifies them against the instance and
writes the configuration itself. Prefer it when the person is at a terminal
and can type the token themselves; prefer the file above when you are
configuring on their behalf.

## Verify before you report success

Do not tell them it is installed because the file was written. Run the
server's own read-only check, which makes one authenticated request and
reports what it found:

```bash
FIREFLY_API_URL=firefly.example.com FIREFLY_API_TOKEN=the-token \
  npx -y -p @yakupemreyerli/firefly-mcp firefly-mcp --version
```

That confirms the package runs. To confirm the credentials, the surest test is
in the client itself: restart it, then ask *"list my Firefly III accounts"*.
A client only reads its MCP configuration at startup, so **the restart is not
optional** — a correct configuration looks broken without it, and that is the
single most common thing to go wrong here.

## What they will have

Five tools rather than one per endpoint: `firefly_query` reads,
`firefly_mutate` creates and changes, `firefly_destructive` deletes or
rewrites many records at once, and `firefly_list_operations` and
`firefly_get_schema` describe what is available. The split is enforced by the
server, not merely advertised, so a client can require confirmation for the
destructive surface alone.

Every write accepts `dry_run: true`, which returns the exact request that
would be sent without sending it. When you are about to change something on
their behalf, use it first and show them the result.

## If it does not work

| What they see | What it is |
|---|---|
| No Firefly tools in the client | The client was not restarted, or the JSON is invalid |
| The server fails to launch, `npx` not found | The client cannot see `npx` — see below |
| `401` or an authentication error | The token is wrong, or was copied with whitespace |
| `404` on every call | The address is wrong — try the full URL including `/api/v1` |
| A certificate error | A self-signed certificate; `FIREFLY_DISABLE_SSL_VERIFY=true` is for local instances only |
| Writes refused | The Firefly token is read-only, which may well be deliberate |

## When the client cannot find `npx`

Version managers put `node` and `npx` on the `PATH` from a shell profile, and
an editor started from a desktop launcher or dock never reads one. The package
runs perfectly from their terminal and the same client reports that it cannot
launch it — which reads as a broken server rather than as a missing `PATH`.

Ask them for the absolute path and use it as `command`:

```bash
which npx
```

```json
{ "command": "/home/them/.nvm/versions/node/v24.16.0/bin/npx", "args": ["-y", "@yakupemreyerli/firefly-mcp"] }
```

The version number in that path changes when they upgrade Node, so mention
that this is the one line to revisit if the server stops launching later. If
they are not using a version manager, `npx` is on the system `PATH` and the
plain `"npx"` is right.

Full documentation: <https://yakupemreyerli.github.io/mcp-firefly-iii/>
