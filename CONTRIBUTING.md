# Contributing

## Getting set up

```bash
git clone https://github.com/YakupEmreYerli/mcp-firefly-iii.git
cd mcp-firefly-iii
npm install
npm test
```

Node.js 20.6 or newer. Tests are mocked and never reach the network, so you do
not need a Firefly III instance to work on most of the code.

To run against a real instance, copy `.env.example` to `.env` and fill in your
URL and token. `make check` then verifies the connection read-only.

## The shape of the code

```
src/
  index.ts        stdio entry point
  http.ts         HTTP entry point
  server.ts       MCP server and the three meta-tools
  registry.ts     entity registry, read-only gate, schema generation
  firefly.ts      HTTP layer: auth, TLS, error translation
  projection.ts   response trimming
  entities/       one module per entity
  schemas/        shared Zod pieces
```

`src/registry.ts` binds entities to operations and exposes everything through
three meta-tools (`firefly_execute`, `firefly_list_operations`,
`firefly_get_schema`) rather than 139 separate tools, because most MCP clients
degrade past roughly 40.

## Adding an operation

1. Add an entry to the entity's `*Operations` object with `defineOperation`
2. Register the entity module in `src/server.ts` if it is new

Two things are easy to miss:

**Tag every operation `read` or `write`.** Read-only mode keys off `access`. It
is a required field, so a missing tag is a compile error rather than a silently
callable write.

**Write the description as the question the operation answers.** The catalogue
embedded in `firefly_execute` is the only guidance the model has when choosing
an operation. "How much was spent per category in a period?" beats "expense
category insight".

## Testing

Tests are mocked; `fetch` is stubbed and nothing reaches a live instance.

Write tests where a bug would otherwise stay silent: request shapes,
normalisations, and the Firefly quirks documented below. A test that only
confirms a mock returned what it was told to return does not earn its
maintenance.

**When fixing a bug, confirm the new test fails against the old code** before
keeping it. If it passes either way, it is not testing the fix.

## Firefly III behaviours that answer wrongly rather than failing

Verified live against Firefly III 6.6.3. What these have in common is that they
produce a **wrong answer, not an error** — which is why they are written down.

- **`end` is inclusive in date ranges.** `start=2026-08-25&end=2026-08-26`
  returns both days. Do not shift `end` forward to mean "one day"; that pulls in
  the next day.
- **`start == end` is rejected only on `/accounts/{id}/transactions`** (422).
  The other transaction endpoints accept it. `src/entities/accounts.ts` carries
  the workaround.
- **A PUT with an unknown wrapper key returns 200 and changes nothing.** Firefly
  does not reject top-level keys it does not recognise, so a malformed update
  looks successful. Strict input schemas are what prevent constructing one.
- **Transaction updates need `transaction_journal_id` in every split**, or the
  split does not match and nothing happens.
- **`/search/accounts` requires the `field` parameter**, or it answers 422.
- **Insight expenses are negative**; income and transfers are positive.

**Verify writes with an independent read.** A 200 from Firefly is not proof that
anything changed.

## Before opening a pull request

```bash
npm run typecheck
npm test
npm run build
```

Comments, identifiers and commit messages are English.

## Releases

Write the version's section in `CHANGELOG.md`, then:

```bash
npm version <patch|minor|major>
git push --follow-tags
```

Pushing the tag does the rest. A workflow builds the GitHub release from that
version's `CHANGELOG.md` section, then publishes to npm with provenance.

Three things stop a bad release:

- The release job fails if `CHANGELOG.md` has no section for the version, or if
  the section is empty.
- The publish job fails if `package.json` disagrees with the tag, so a
  mistyped tag cannot put the wrong version on npm.
- `prepublishOnly` runs the typecheck, the tests and the build, so a broken
  tree cannot be published from anywhere.

Publishing needs an `NPM_TOKEN` repository secret — a granular access token
with publish rights, added with `gh secret set NPM_TOKEN`.
