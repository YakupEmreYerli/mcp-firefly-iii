# Security Policy

## What this software touches

This server holds a Firefly III Personal Access Token and can read — and unless
`FIREFLY_READ_ONLY=true` is set, modify — the full financial history of whoever
configured it. Treat a vulnerability here as you would one in a banking client.

## Reporting a vulnerability

Please report privately, not in a public issue.

Use GitHub's [private vulnerability
reporting](https://github.com/YakupEmreYerli/mcp-firefly-iii/security/advisories/new)
on this repository. You should get an acknowledgement within a week.

When reporting, the most useful things to include are what an attacker can
reach, the conditions required (in particular whether HTTP mode is involved),
and the smallest reproduction you have. Please do not include a real token or
anyone's real financial data in the report.

## Supported versions

This project is pre-1.0. Fixes land on the latest release only.

## Record content is written by other people

Descriptions, notes, tags and counterparty account names are typed by whoever
moved the money. On an incoming payment that is not the account holder: a payer
chooses the description their bank records, and an import carries it into the
ledger verbatim. Anyone able to send this user a payment can therefore choose
text that reaches the model, in the same session as tools that can write.

Two things stand between that and a write nobody asked for.

The first is structural. Execution is split into `firefly_query`,
`firefly_mutate` and `firefly_destructive`, and the split is enforced in the
registry rather than advertised — a delete reached through the reading surface
is refused. Each carries the MCP annotations a host uses to decide what to
confirm, so acting on an injected instruction means calling a tool the host can
hold. `dry_run` returns the exact request a write would send without sending
it.

The second is that the server says which half of a response it vouches for. A
tool description is written here and is trusted; a tool result is not. Every
execution surface carries that statement, and any response containing
third-party text repeats it beside the records, because a long result puts the
description far behind the data.

None of this makes the content safe to follow. It makes following it require a
step a host can see. If you connect this server to an agent that writes without
review, that step is where you have chosen to remove the check.

## Deployment notes that are your responsibility

- **Never expose the HTTP server directly to the internet.** `MCP_HTTP_TOKEN` is
  the only credential in front of it, and there is no rate limiting or lockout.
  Put it behind TLS and, ideally, behind a reverse proxy that rate-limits.
- **`MCP_HTTP_HOST` defaults to `127.0.0.1`.** Changing it to `0.0.0.0` publishes
  the server on every interface. Do that only when something else terminates TLS
  in front of it.
- **`FIREFLY_DISABLE_SSL_VERIFY=true` disables certificate verification
  entirely.** It exists for local instances with self-signed certificates. On
  anything reachable over a network it makes the connection interceptable.
- **Prefer `FIREFLY_READ_ONLY=true`** for any session that only needs to answer
  questions. Write operations are then refused before the request reaches
  Firefly III, and hidden from the tool catalogue so the model does not attempt
  them.
- **Your MCP client's configuration file holds your token.** Those files are
  usually not git-ignored and do end up in backups.

## What is out of scope

- Vulnerabilities in Firefly III itself — report those to
  [the Firefly III project](https://github.com/firefly-iii/firefly-iii/security).
- An AI assistant taking an action you did not intend, when writes were enabled.
  That is what read-only mode is for.
