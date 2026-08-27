# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `transaction.bulk_categorize` and `transaction.bulk_tag` never worked.
  Firefly's `/data/bulk/transactions` only moves transactions between accounts;
  it cannot set a category or tags, and it answered the old `category_name=<name>`
  query with a 500 "Syntax error". Both now fan out into a per-group PUT, which
  is the only API path that sets these fields on existing transactions.

## [0.3.2] - 2026-08-27

### Added

- A prebuilt container image at `ghcr.io/yakupemreyerli/mcp-firefly-iii`, for
  `linux/amd64` and `linux/arm64`, published on every tag. Self-hosting the HTTP
  mode no longer means cloning and building — and arm64 is there because a
  Raspberry Pi is a common place to run Firefly III.

### Changed

- Releases publish to npm through trusted publishing rather than a token. A
  classic publish token still demands a one-time password, which nothing in a
  workflow can supply; trusted publishing leaves no credential in the
  repository at all.

## [0.3.1] - 2026-08-27

### Fixed

- The Docker image did not build. The Dockerfile copied `test`, which
  `.dockerignore` excludes, so `docker build` failed at that step. The build
  stage compiles `src` only and never needed the tests. CI now builds the image
  and starts it — checking that it refuses to run without `MCP_HTTP_TOKEN`, that
  `/health` answers, that `/mcp` is 401 without a token and serves the tools
  with one — so a Dockerfile nobody builds cannot rot again.

## [0.3.0] - 2026-08-27

### Changed

- **Transaction responses are flattened to one row per split.** Firefly stores a
  transaction as a group of splits, so its own API buries the fields you want at
  `data[].attributes.transactions[0].amount` — three levels down even for a
  single purchase. Every response that carries transactions now lifts the
  split's fields into `attributes`. The shape is the same for one split or
  five; a group with several produces several rows, each marked `split_count`.

  `id` remains the **group** id, which is what `get`, `update` and `delete`
  take; each row also keeps `transaction_journal_id`, which updates need inside
  the split. `meta.pagination` is left as Firefly sent it and therefore counts
  groups rather than rows.

- Validation failures now carry the operation's schema. Zod says "Required" and
  nothing about shape, which cost a second call through `firefly_get_schema`
  just to learn that a date is `YYYY-MM-DD`.

## [0.2.2] - 2026-08-27

### Added

- `setup` checks npm for a newer version and says so. A copy left behind by
  `npm install` in some directory shadows the registry — `npx` prefers a local
  install — so the stale copy keeps running with nothing to indicate it. The
  check never blocks setup: offline or a slow registry is silently ignored.

## [0.2.1] - 2026-08-27

### Fixed

- An unrecognised argument started the stdio server instead of being refused.
  Someone on an older version typing `firefly-mcp setup` got a process sitting
  silently on stdin, which is indistinguishable from a hang. Unknown commands
  and extra arguments now print usage to stderr and exit 1.

### Added

- `firefly-mcp --help` and `firefly-mcp --version`.

## [0.2.0] - 2026-08-27

### Added

- `firefly-mcp setup`: an interactive first-run command. It asks for the Firefly
  III address and API token and verifies them against the live instance before
  anything depends on them, reporting which of the two was wrong rather than a
  stack trace. It then configures Claude Code (through `claude mcp add`) and
  Claude Desktop if it finds them, backing up any file it changes and merging
  into the existing configuration so other MCP servers survive untouched. For
  any other client it prints the configuration to paste.

### Fixed

- `firefly-mcp-http` did nothing when installed from npm. npm installs binaries
  as symlinks, and the entry-point check compared the invoked path against the
  resolved module path, so the server exited 0 without starting. Both sides are
  now resolved before comparing.

## [0.1.0] - 2026-08-27

First release.

### Added

- 139 operations across 24 entities, reached through three meta-tools
  (`firefly_execute`, `firefly_list_operations`, `firefly_get_schema`).
- `FIREFLY_DIRECT_MODE` for clients that prefer one tool per operation.
- `FIREFLY_READ_ONLY`, which refuses write operations and hides them from the
  catalogue.
- `summary.overview`, which answers "how did this period go" in a single call,
  normalising Firefly's negative expense figures and grouping per currency.
- Response trimming: empty and null attributes are always dropped, and `fields`
  keeps only the attributes the caller names.
- A remote HTTP mode (`firefly-mcp-http`) speaking streamable HTTP behind a
  required bearer token, with a `Dockerfile` and Compose example.

[Unreleased]: https://github.com/YakupEmreYerli/mcp-firefly-iii/compare/v0.3.2...HEAD
[0.3.2]: https://github.com/YakupEmreYerli/mcp-firefly-iii/releases/tag/v0.3.2
[0.3.1]: https://github.com/YakupEmreYerli/mcp-firefly-iii/releases/tag/v0.3.1
[0.3.0]: https://github.com/YakupEmreYerli/mcp-firefly-iii/releases/tag/v0.3.0
[0.2.2]: https://github.com/YakupEmreYerli/mcp-firefly-iii/releases/tag/v0.2.2
[0.2.1]: https://github.com/YakupEmreYerli/mcp-firefly-iii/releases/tag/v0.2.1
[0.2.0]: https://github.com/YakupEmreYerli/mcp-firefly-iii/releases/tag/v0.2.0
[0.1.0]: https://github.com/YakupEmreYerli/mcp-firefly-iii/releases/tag/v0.1.0
