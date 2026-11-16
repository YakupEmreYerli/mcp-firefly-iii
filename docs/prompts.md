# Prompts

The server ships three [MCP prompts](https://modelcontextprotocol.io/specification/latest/server/prompts): ready-made workflows you pick from your client's prompt or slash-command menu instead of typing the request yourself. In Claude Code they appear as `/mcp__firefly__month_end_review` and so on; Claude Desktop offers them from the + menu, under the server's name.

A prompt adds no new capability. It only writes the request for you, and everything it asks for goes through the same three execution tools, the same access checks and the same `dry_run` preview as a request typed by hand. What it adds is the order of steps on real money: read, preview, show you the preview, wait for your yes, apply, then verify with a separate read.

| Prompt | Argument | What it does | Writes |
| --- | --- | --- | --- |
| `month_end_review` | `month` (`YYYY-MM`, optional) | An overview of the month with `summary.overview`, then categorises the uncategorised spending. | After you confirm |
| `categorise_uncategorised` | `month` (`YYYY-MM`, optional) | Only the categorisation part: uncategorised spending grouped by payee, a proposed category for each, preview, apply. | After you confirm |
| `budget_summary` | `month` (`YYYY-MM`, optional) | Compares the month with the one before it: income, spending, the categories that moved most, and budgets against their limits. | Never |

`month` defaults to last month. The server works out the first and last day itself — leap years and year boundaries included — and writes the dates into the prompt, because a month boundary computed wrong returns a believable total rather than an error.

## How the categorising prompts stay safe

1. They read first: `analysis.uncategorized` groups uncategorised spending by payee, and `category.list` shows which categories exist.
2. They propose one category per payee and skip payees the model cannot place with confidence.
3. Every change is sent first with `dry_run: true` through `transaction.bulk_update_where`, filtered to that payee's uncategorised withdrawals in the month, with `max_matches` set to the count the analysis reported. If more rows match, the server refuses and the model is told to stop and ask rather than raise the cap.
4. Nothing is applied until you confirm the previews. New categories are proposed, never created on the model's own initiative.
5. After applying, the model runs `analysis.uncategorized` again: Firefly answers some writes that changed nothing with 200, so a success response is not treated as proof.

Text inside transactions — descriptions, notes, payee names — is written by whoever moved the money. Every prompt repeats that it is data and never instruction.

## Who sees which prompt

Prompts follow the same access rules as the tools. A connection without `transaction.bulk_update_where` — an OAuth connection granted only `firefly:read`, for example — is offered `budget_summary` alone, since the other two end in a write it cannot make.
