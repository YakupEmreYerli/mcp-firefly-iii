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

## Where it is not yet, and what each one needs

Searching for "firefly iii mcp" today returns four competing servers, two
directories and a Firefly III discussion thread — and none of them us. The
gap is not quality; it is that none of these pages has heard of the project.
Each row below is a page that already ranks, and what it takes to appear on
it. The artefacts they ask for are committed: `docs/assets/icon-400.png` for
the ones wanting a square icon, `llms-install.md` for the ones that install
by handing a file to an agent.

| Where | How | Worth it because |
|-------|-----|------------------|
| [Firefly III Discussions](https://github.com/orgs/firefly-iii/discussions) | Post in General | The maintainer answered the last MCP announcement there with "Very cool, I'll add it to the documentation for sure!" — and that thread now ranks for the search this project loses |
| [Cline MCP Marketplace](https://github.com/cline/mcp-marketplace) | An issue from their template: repo URL, a 400×400 PNG, and why | One-click install for every Cline user. They warn of "increased scrutiny to projects in sensitive domains (such as financial services)" — so lead with the threat model, which is the strongest thing here |
| [MCP Market](https://mcpmarket.com/submit) | A web form; it reads the repository | Already ranks on the front page for this search |
| [punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers) | Pull request | 93k stars, and the word "firefly" appears in it nowhere at all — no competitor holds this either |
| [wong2/awesome-mcp-servers](https://github.com/wong2/awesome-mcp-servers) | Pull request | The same, smaller and faster to merge |

Two things not to bother with. **Renaming the repository** to match the search
phrase exactly, the way three competitors are named, would break the MCP
Registry entry that publishing was just automated for, move the documentation
site, and churn every link written so far — for one ranking signal among many.
And **buying attention** for a tool that asks people for a token to their bank
history is the wrong trade: the reason to trust this one is that its threat
model is written down, and that argument only works where it can be read.

## What an entry hosted elsewhere may say

**No number that changes.** The operation count is the obvious one: it moves
whenever an operation is added, and `npm run docs:update` rewrites it
everywhere it appears in this repository — the two READMEs, every page under
`docs/`, `package.json` and `server.json` — precisely because a hand-maintained
copy goes stale without anyone noticing. A copy on someone else's website is a
hand-maintained copy that also needs their review to correct.

The generated images are the exception, and only because they are covered:
`npm run media` renders the count from the registry rather than from anything
typed, and stamps it into the PNG's own text field, which `docs:check` reads
back out. The image is the only copy of what it was rendered from, and a stale
card fails the same check a stale page does.

So the counts stay here, where the pipeline can reach them, and an entry
written for somewhere else describes what the server *is*:

> A security-first, self-hosted MCP server for Firefly III, developed by
> @YakupEmreYerli, for use with Claude Code, Claude Desktop, Claude web and
> mobile, and ChatGPT. Firefly III's API is exposed through a small set of
> meta-tools rather than one tool per endpoint, split into separate read, write
> and destructive surfaces so a host can annotate and confirm each risk level
> independently. Writes support dry-run previews, bulk writes are guarded by an
> explicit match limit, and it runs over stdio or authenticated HTTP with
> OAuth 2.1. Published on npm with provenance and in the official MCP Registry.

That paragraph names its author the way the pages that carry it do — the
Firefly III listing credits "@dreautall", "@bahuma20" and the rest in the same
sentence — and has no version, no count, and no claim that a release can
invalidate. It has needed no correction across every release so far, which is
the whole point: the cheapest listing to keep current is one that was never
written to go out of date.

## The demo video, and the step that cannot be automated

GitHub will not play a video from a repository path: its raw API serves mp4 as
`application/octet-stream`, so the browser downloads it. The only URL that
renders as a player is a `user-attachments` one, and those come from dragging
the file into a GitHub comment box. There is no API for it.

So rebuilding `docs/assets/demo.mp4` changes what the documentation site shows
and nothing else. Both READMEs keep playing whatever was uploaded last — which
is how they spent several days showing a closing card that recommended
`npm i -g`, the one install `setup` warns about, after the file here had
stopped saying it.

`docs/assets/demo.json` records the URL and the byte count of the file that was
uploaded to it, and `docs:check` holds both against reality. Rebuild the video
and the count stops matching; change the URL in one README and not the other
and it says which. The upload stays manual, in three steps:

1. Drag `docs/assets/demo.mp4` into any GitHub comment box and copy the
   `user-attachments` URL it produces. Do not submit the comment.
2. Put that URL and the file's size in `docs/assets/demo.json`.
3. `npm run docs:check` — it fails until both READMEs carry the new URL.

## Ready to send

Written out here so submitting costs nothing later. Each is complete; check
the facts still hold, then paste.

### Firefly III Discussions — General

> **A security-first MCP server for Firefly III**
>
> I have been running Firefly III against an AI assistant through the Model
> Context Protocol, and put the server behind it up as
> [mcp-firefly-iii](https://github.com/YakupEmreYerli/mcp-firefly-iii).
>
> It is self-hosted, like Firefly III itself — your own instance, your own
> token, nothing hosted in between. What is different from the other MCP
> servers around: reading, writing and deleting are three separate tools with
> separate scopes, enforced by the server rather than advertised, so a client
> can require confirmation for the destructive one alone. Every write takes
> `dry_run`, which returns the exact request it would send without sending it.
> Bulk edits driven by a filter refuse to run unless you say how many rows you
> expect, because Firefly answers 200 to every write and there is no undo.
>
> The Firefly quirks it works around are written down rather than patched over
> — `opening_balance: "0"` being silently ignored, a PUT with an unknown
> wrapper key returning 200 and changing nothing, splits collapsing when one
> amount is spread across a group. They are in the docs with what was measured.
>
> Works over stdio with Claude Code, Claude Desktop and Cursor, and over
> authenticated HTTP with OAuth for Claude web, Claude mobile and ChatGPT.
> Feedback welcome, especially from anyone whose ledger is shaped differently
> from mine.

### Cline MCP Marketplace — issue body

> **GitHub Repo URL:** https://github.com/YakupEmreYerli/mcp-firefly-iii
> **Logo:** `docs/assets/icon-400.png` in the repository (400×400 PNG)
>
> **Reason for addition:** Firefly III is a widely self-hosted personal
> finance manager, and this connects it to Cline over MCP. Since this is a
> financial-services tool, the parts your review looks at are deliberate:
> reading, writing and deleting are separate tools behind separate scopes and
> the split is enforced in the server, so Cline can confirm destructive
> actions specifically instead of treating every call alike; every write
> supports a dry run that returns the exact request without sending it; and
> filter-driven bulk edits refuse to run unless the caller states how many
> rows they expect. The threat model, including how untrusted record text is
> handled, is in SECURITY.md. Releases are published by CI from a tagged
> commit with npm provenance, and the server is listed in the official MCP
> Registry and in Firefly III's own third-party documentation.
>
> `llms-install.md` is in the repository for the one-click install path.

### awesome-mcp-servers — the list entry

> - [Firefly III](https://github.com/YakupEmreYerli/mcp-firefly-iii) 📇 🏠 — Self-hosted personal finance. Read, write and delete are separate scoped tools; every write supports a dry run.
