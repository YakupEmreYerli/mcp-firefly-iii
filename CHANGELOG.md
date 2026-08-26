# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/YakupEmreYerli/mcp-firefly-iii/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/YakupEmreYerli/mcp-firefly-iii/releases/tag/v0.2.0
[0.1.0]: https://github.com/YakupEmreYerli/mcp-firefly-iii/releases/tag/v0.1.0
