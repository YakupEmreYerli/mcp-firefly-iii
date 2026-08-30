# Where this server is listed

Five places describe this project to people who have never opened the
repository. Each one goes stale differently, and the ones that cannot be
automated are the reason for the rule at the bottom of this page.

| Listing | Kept current by | Carries |
|---------|-----------------|---------|
| [npm](https://www.npmjs.com/package/@yakupemreyerli/firefly-mcp) | `release.yml`, on a `v*` tag | `package.json` description, version, README |
| [MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.YakupEmreYerli%2Fmcp-firefly-iii/versions/latest) | `release.yml`, on the same tag | `server.json` |
| [Glama](https://glama.ai/mcp/servers/@YakupEmreYerli/mcp-firefly-iii) | Glama re-reads the repository itself | README, `glama.json` |
| [Firefly III third-party apps](https://docs.firefly-iii.org/references/firefly-iii/third-parties/apps/) | A pull request, by hand | A paragraph written once |
| GitHub repository description and topics | By hand, in repository settings | One sentence, the same one `package.json` carries |

## The two that are automated

A tagged release publishes to npm and then to the MCP Registry, in that order —
the registry validates that the npm package it points at exists, so publishing
to it first fails. Neither needs a stored credential: both trust this
repository and workflow by name over OIDC.

The registry does **not** follow npm, and for a while nothing told it anything:
its entry sat at 1.1.1 while releases carried on without it. That is why
`release.yml` now refuses a tag whose `server.json` version disagrees with it,
in the same step that already refused a mismatched `package.json`. A registry
entry pointing at a release that is not the current one is worse than a missing
one, because it looks current.

## The three that are not

Glama re-reads this repository on its own, so it is current as long as the
README is; `glama.json` only records who maintains it.

The Firefly III listing and the GitHub repository description are edited by
hand — the first through a pull request against
[`firefly-iii/docs`](https://github.com/firefly-iii/docs), in
`docs/docs/references/firefly-iii/third-parties/apps.md`.

## What an entry hosted elsewhere may say

**No number that changes.** The operation count is the obvious one: it moves
whenever an operation is added, and `npm run docs:update` rewrites it
everywhere it appears in this repository — the two READMEs, every page under
`docs/`, `package.json` and `server.json` — precisely because a hand-maintained
copy goes stale without anyone noticing. A copy on someone else's website is a
hand-maintained copy that also needs their review to correct.

So the counts stay here, where the pipeline can reach them, and an entry
written for somewhere else describes what the server *is*:

> A security-first, self-hosted MCP server for Firefly III, for use with Claude
> Code, Claude Desktop, Claude web and mobile, and ChatGPT. Firefly III's API is
> exposed through a small set of meta-tools rather than one tool per endpoint,
> split into separate read, write and destructive surfaces so a host can
> annotate and confirm each risk level independently. Writes support dry-run
> previews, bulk writes are guarded by an explicit match limit, and it runs over
> stdio or authenticated HTTP with OAuth 2.1. Published on npm with provenance
> and in the official MCP Registry.

That paragraph has no version, no count, and no claim that a release can
invalidate. It has needed no correction across every release so far, which is
the whole point: the cheapest listing to keep current is one that was never
written to go out of date.
