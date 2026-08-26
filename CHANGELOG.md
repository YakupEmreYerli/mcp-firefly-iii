# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/YakupEmreYerli/mcp-firefly-iii/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/YakupEmreYerli/mcp-firefly-iii/releases/tag/v0.1.0
