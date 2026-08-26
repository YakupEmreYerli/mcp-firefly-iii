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
