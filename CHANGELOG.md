# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Removed

- `FIREFLY_LOG_LEVEL`. It was read into the config and never consumed — this
  layer has no logging — so the only thing it did was tell operators to set
  something. Setting it now does nothing at all.

- `FIREFLY_PERMISSIONS`, and with it every server-wide permission setting. What
  the assistant may do is now decided by the connection: a stdio client can do
  whatever its Firefly token can — issue a read-only token if that is the limit
  you want — and an OAuth client carries the scopes its password grant gave it,
  with a surface it was not granted hidden as well as refused. The
  setting narrowed a token its own operator had issued at full scope, and could
  be widened by editing the same file the token sits in, so it read as a
  boundary without being one.

  A deployment that still sets it to a **restricting** value refuses to start.
  `full`, `all` and an empty value restricted nothing and are accepted in
  silence.

- `FIREFLY_READ_ONLY` and `FIREFLY_ENABLED_ENTITIES`. Both said something
  the permission policy already said — read-only is `FIREFLY_PERMISSIONS=read`,
  and hiding entities is `<entity>:none` — and two settings for one decision is
  how they drift apart. The read-only switch had its own branch in the registry,
  so a refusal had to guess which of the two settings the operator had actually
  written.

  A deployment that still sets either one to a **restricting** value now refuses
  to start. Ignoring them silently would
  leave a server more permissive than its operator wrote, which is the failure
  this project is built against. A value that restricted nothing — `false`,
  `all`, empty — is ignored in silence, because `.env.example` shipped exactly
  those.

- `FIREFLY_DIRECT_MODE`, which listed every operation as its own tool. It cost
  93.5% more of the model's context than the meta-tools — 154 KB against 10 KB,
  measured — and most clients degrade past roughly forty tools, so it made the
  server worse on the clients it was meant to help. It also meant every feature
  had to be built twice, and the second copy is where a defect landed: tool
  names there are `<entity>_<operation>` rather than surface names, so the
  OAuth scope check found nothing to match and read every call as a read.
  Setting the variable now does nothing.

### Changed

- The OAuth consent screen is gone. Entering `MCP_AUTH_PASSWORD` now grants the
  connection all three scopes and redirects straight back to the client. The
  screen asked the same person the same question twice: they had just proved
  they hold the server's password, and every box on it was theirs to tick.
  Clients that request `firefly:read` alone — ChatGPT does — are granted more
  than they asked for, which RFC 6749 §3.3 allows as long as the token response
  reports what was granted.



- `FIREFLY_API_URL` and `MCP_RESOURCE_URL` accept a bare domain.
  `FIREFLY_API_URL=firefly.example.com` becomes
  `https://firefly.example.com/api/v1`, and `MCP_RESOURCE_URL=mcp.example.com`
  becomes `https://mcp.example.com/mcp`. A value carrying a scheme or a path is
  a URL and is taken as written, so an instance behind a subpath, on a custom
  port, or on plain http keeps working exactly as before. Not a breaking change
  — only a shorter spelling for the ordinary case.

### Added

- OAuth 2.1 support in HTTP mode, as a resource server. `MCP_AUTHORIZATION_SERVERS`
  and `MCP_RESOURCE_URL` turn it on; leaving them empty keeps the bearer token
  exactly as it was. The server publishes RFC 9728 protected resource metadata,
  points an unauthenticated caller at it through `WWW-Authenticate`, and
  verifies tokens against the issuer's published keys.
- Scopes over the three execution surfaces: `firefly:read`, `firefly:write` and
  `firefly:destructive`, with broader implying narrower. A call beyond the
  token's reach is refused with 403 `insufficient_scope` before the tool runs,
  naming the scope that would have worked, and the granted scopes are also what
  the registry gates on, so enforcement does not rest on that check alone.
- The scope check reads direct mode too, where a tool is named after its entity
  and operation rather than after a surface. The lookup comes from the registry,
  which is the one place the access level is declared.
- Audience binding per RFC 8707: a token issued for another service is refused.
  A bearer token is whoever holds it, so without this any token a client had
  would have worked here.

## [1.0.0] - 2026-08-27

First stable release. The tool surface is now covered by semantic versioning:
anything that breaks a caller from here on needs a major version.

### Removed

- `firefly_execute`. **This is the breaking change.** One tool that could both
  list a balance and delete a transaction left the host nothing to annotate, so
  it is replaced by `firefly_query`, `firefly_mutate` and `firefly_destructive`
  — see Changed. A caller that named `firefly_execute` must pick the surface
  matching what it is doing; `entity`, `operation`, `params` and `fields` are
  unchanged.

### Added

- Every execution surface now states that record content is data and never
  instruction, naming the fields that carry third-party text. Descriptions,
  notes, tags and counterparty account names are written by whoever moved the
  money, which on an incoming payment is not the account holder, and that text
  reaches the model alongside tools that can write. The split between query,
  mutate and destructive is the structural half of the answer; this is the half
  that says which part of the payload is trusted.
- A response carrying third-party text now repeats, beside the records, that it
  is data rather than instruction. The execution tools already say so, but a
  result running to tens of kilobytes leaves that far behind the data it
  describes. Added only where such a field is present, only to an object, and
  measured at 0.4–3% of a real response.
- The arrays Firefly replaces wholesale rather than merging into — transaction
  tags, rule triggers and actions, piggy bank accounts, recurrence repetitions
  — now say so in their schema, with what to do instead. Measured against 6.6.3:
  omitting the field preserves what is there, sending a partial list destroys
  the rest. This is the class of defect that made `bulk_tag` erase tags.

### Removed

- `firefly_execute`. **This is a breaking change** and needs a major version
  when it ships. One tool that could both list a balance and delete a
  transaction left the host nothing to annotate, so it is replaced by
  `firefly_query`, `firefly_mutate` and `firefly_destructive` — see Changed
  below. A caller that named `firefly_execute` must pick the surface matching
  what it is doing; the `entity`, `operation`, `params` and `fields` arguments
  are unchanged.

### Fixed

- `transaction.bulk_tag` no longer erases the tags a transaction already
  carries. Firefly rewrites the whole tag set on a journal update rather than
  merging into it, so tagging an already-tagged transaction dropped every other
  tag and reported `{updated: n}` — a silent loss on real data. The existing
  tags are now read back and merged.
- `MCP_STRUCTURED_OUTPUT` responses validate against the schema they advertise.
  The declared output schema named a single optional `result` property, which
  compiles to `additionalProperties: false`, while object payloads travel
  unwrapped — so every object response, which is nearly all of them, was
  rejected client-side with "data must NOT have additional properties". The
  schema is now an open object, as the payload always was.
- `FIREFLY_PERMISSIONS=write` and `=destructive` grant what they name. A bare
  level name fell through the clause parser and left the fallback at `none`, so
  asking for full access silently blocked every operation including reads.
- `analysis.compare_periods` honours `currency_code`. It was accepted,
  forwarded only to the balance endpoint, and then discarded with that
  endpoint's result, so a multi-currency ledger came back unfiltered while the
  schema promised one currency.
- `analysis.recurring_expenses` and `analysis.uncategorized` report `truncated`
  when a period holds more transactions than the scan reads. The counts and
  totals were presented as complete figures when they were lower bounds.
- The duplicate warning shown before a transaction write reads every page of
  the day, not just the first. On a busy day the existing transaction sat on
  page two and the write went ahead unwarned.
- A failed balance query is no longer reported as a refused period.
  `summary.overview` rescues the 422 Firefly returns for a single-day range,
  but the rescue caught every error, so an expired token or a 500 came back as
  a property of the date range.

### Changed

- `transaction.bulk_categorize` and `transaction.bulk_tag` return a per-id
  record — `updated`, `failed`, `skipped` and a `results` list — instead of a
  bare `{updated: n}`. A failure part-way through used to throw, discarding the
  list of ids already rewritten, and a caller of a destructive operation could
  not tell whether none or nearly all of them had changed. Remaining ids are
  now still attempted and each outcome is named.
- A tool surface with an empty catalogue is not registered. Only
  `FIREFLY_READ_ONLY` used to skip the writing surfaces; `FIREFLY_PERMISSIONS`
  narrowing to reads left `firefly_mutate` and `firefly_destructive` advertised
  with no operations and every call failing.
- `firefly_execute` is replaced by three tools split by risk: `firefly_query`,
  `firefly_mutate` and `firefly_destructive`. One tool that could both list a
  balance and delete a transaction gave the host nothing to annotate. The split
  is enforced in `Registry.execute`, not merely advertised — a delete reached
  through `firefly_query` is refused and told which tool to use — and in
  read-only mode the two writing tools are not registered at all. Each surface
  carries only its own catalogue, and only the reading one repeats the entity
  hints, which keeps the added description text to about 12%.

### Added

- `analysis.recurring_expenses`, which finds payments that repeat to the same
  payee and reports how often, how far apart, and how much they vary. It stops
  at what the ledger records: it does not call anything a subscription and does
  not decide whether one is still running, because a fixed monthly charge paid
  three days ago may have been cancelled yesterday. The interval and the gap
  since the last payment are given so the caller can ask.
- `analysis.uncategorized`, grouping spending that carries no category by who
  was paid, largest total first — one decision per payee closes every payment
  to it.
- `MCP_STRUCTURED_OUTPUT`, returning results as MCP `structuredContent` with an
  advertised output schema instead of JSON inside a text block. Off by default,
  and the two are never sent together: mirroring both, as the specification
  suggests for older clients, would double every response — `account.list` is
  18 KB against a personal instance — and give back much of what the response
  trimming saves. Arrays travel under a `result` key, since `structuredContent`
  must be an object and the insight endpoints answer with a bare list.
- A `resolve` entity, turning a name a user said into the Firefly record it
  means: `resolve.account`, `resolve.category`, `resolve.budget`,
  `resolve.tag`. Matching folds Turkish letters (a plain `toLowerCase` gets `I`
  and `İ` wrong), treats a shorter query as an abbreviation, and bridges a
  Turkish suffix — so "nakit" finds `Nakit (Cüzdan)` and "yemek" finds
  `Yeme & İçme`. When two names fit equally it returns the candidates and
  declines to choose, and Firefly's internal "Initial balance for …" accounts
  are excluded so they cannot cause an ambiguity the user cannot even see.
- `dry_run` on `firefly_mutate` and `firefly_destructive`. It runs the operation
  against a client that reads for real but only records what it would write, so
  the preview comes back with ids resolved and the payload shaped exactly as
  Firefly would receive it, rather than an echo of the parameters. Nothing is
  written, and the result says so.
- A duplicate guard on previewed transaction creates: if the same amount already
  moved between the same two accounts on that day, the preview carries a warning
  with the matching records. It only ever warns — Firefly's
  `error_if_duplicate_hash` is what blocks an exact repeat, and a threshold
  invented here would block writes the caller meant to make.
- `FIREFLY_PERMISSIONS`, for the ground between "reads only" and "may do
  anything". Either a preset (`read`, `safe`, `full`) or a per-entity list such
  as `transaction:safe;account:read;rule:none;*:read`. `safe` is the level that
  had no name before: reads, creates and updates, but nothing that cannot be
  undone. Whichever of this and `FIREFLY_READ_ONLY` is stricter wins, and a
  refusal names the setting the operator actually wrote. An unparseable clause
  is dropped rather than widened, so a typo fails closed.
- A `destructive` access level, separating what cannot be undone — deletes, and
  the two bulk operations that rewrite a field across many records at once —
  from an ordinary write. Read-only mode is unchanged, but a host can now raise
  confirmation exactly where it matters instead of gating every write.
- MCP tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
  `openWorldHint`) on every tool, stated from the access level the registry
  already carries. In direct mode each tool is annotated exactly; the single
  `firefly_execute` still reaches everything, so it claims read-only only when
  read-only mode makes that true.

- `analysis.compare_periods`, answering "what changed since last month?" in one
  call instead of two overviews plus arithmetic the caller has to get right.
  Currencies stay separate, transfers stay out of net, a category spent in only
  one of the two periods is reported as started or stopped rather than dropped,
  and a percentage change is omitted rather than fabricated when the baseline is
  zero. It opens a new `analysis` entity for figures the server computes rather
  than fetches.

### Fixed

- The server introduced itself to MCP clients as `0.1.0` regardless of the
  published version, because the version was written down a second time next to
  the one in `package.json`. It now reports the manifest version.
- `summary.overview` failed outright for a single-day period. Firefly rejects
  `start == end` on `/summary/basic` with a 422 while every insight endpoint
  accepts it, and only the balances come from there. The balance query is no
  longer fatal, and when it is refused the answer says so through
  `balances_unavailable` instead of leaving balances to read as zero. Widening
  the range is not a fix: `balance-in-*` moves with `start`, so it is period
  movement rather than a point-in-time figure.

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
[1.0.0]: https://github.com/YakupEmreYerli/mcp-firefly-iii/releases/tag/v1.0.0
[0.3.2]: https://github.com/YakupEmreYerli/mcp-firefly-iii/releases/tag/v0.3.2
[0.3.1]: https://github.com/YakupEmreYerli/mcp-firefly-iii/releases/tag/v0.3.1
[0.3.0]: https://github.com/YakupEmreYerli/mcp-firefly-iii/releases/tag/v0.3.0
[0.2.2]: https://github.com/YakupEmreYerli/mcp-firefly-iii/releases/tag/v0.2.2
[0.2.1]: https://github.com/YakupEmreYerli/mcp-firefly-iii/releases/tag/v0.2.1
[0.2.0]: https://github.com/YakupEmreYerli/mcp-firefly-iii/releases/tag/v0.2.0
[0.1.0]: https://github.com/YakupEmreYerli/mcp-firefly-iii/releases/tag/v0.1.0
