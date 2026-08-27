# Analysis Operations

Reading and writing records is one thing; answering questions about them is
another. This page covers the second: what was spent, where it went, and where a
particular record lives.

In every date range, **`end` is inclusive**: `start=2026-08-01, end=2026-08-31`
covers the whole of August.

## Start here: `summary.overview`

A whole period in one call — income, spending, transfers, the category
breakdown, and closing balances.

```json
{
  "entity": "summary",
  "operation": "overview",
  "params": { "start": "2026-08-01", "end": "2026-08-31" }
}
```

```json
{
  "period": { "start": "2026-08-01", "end": "2026-08-31", "end_is_inclusive": true },
  "totals": {
    "EUR": { "income": 104.99, "expense": 204.99, "transfers": 2900.0, "net": -100.0 }
  },
  "expense_by_category": [
    { "name": "Subscriptions", "amount": 104.99, "currency_code": "EUR" },
    { "name": "Other",         "amount": 70.0,   "currency_code": "EUR" },
    { "name": "Eating out",    "amount": 30.0,   "currency_code": "EUR" }
  ],
  "expense_category_count": 3,
  "balances": { "balance-in-EUR": -100.0, "net-worth-in-EUR": 2881.0 }
}
```

Two normalisations are applied so the caller does not have to know Firefly's
habits:

- **Spending is a positive magnitude.** Firefly returns expenses as negative
  numbers; `expense: 204.99` reads directly as "204.99 was spent".
- **Figures are grouped per currency** and never added together. A single
  "total" that summed two currencies would be meaningless.

`transfers` is reported but does **not** enter `net` — moving money between your
own accounts is neither income nor expense and does not change your net worth.

Prefer this operation over making several `insight` calls and adding the numbers
up by hand. That is what it exists for.

!!! note "`balances_unavailable` instead of a silent zero"

    The balances come from `/summary/basic`, which rejects a single-day range
    with a 422 while every insight endpoint accepts it. Rather than failing the
    whole period, the overview reports `balances_unavailable` and keeps the
    totals. Widening the range is not a workaround: `balance-in-*` is period
    movement, not a point-in-time figure, so a widened range would report a
    balance that is simply wrong. If the balance query failed for some other
    reason — an expired token, a 500 — the message says so and names it, because
    then the totals came from the same broken instance.

### Restricting to one currency

`summary.overview` and `analysis.compare_periods` both take `currency_code`.
The filter is applied to what came back, so it holds whatever the underlying
endpoint does with the parameter. Asking for a currency the ledger never used
returns an empty result, which is the honest answer.

## `summary.basic`

Firefly III's own summary block: balance, spent, earned, bills paid and unpaid,
left to spend, and net worth — per currency.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `start` | yes | `YYYY-MM-DD` |
| `end` | yes | `YYYY-MM-DD`, inclusive |
| `currency_code` | no | Limit to one currency, e.g. `EUR` |

## `analysis.compare_periods`

Two periods held against each other — what changed in income, spending and per
category. The comparison is computed here rather than fetched: Firefly has no
endpoint that answers it.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `start`, `end` | yes | The period being examined, `YYYY-MM-DD`, `end` inclusive |
| `baseline_start`, `baseline_end` | yes | The earlier period to compare against |
| `currency_code` | no | Restrict both periods to one currency |

Each measure comes back as `current`, `baseline`, `change` and `change_pct`.
`change_pct` is absent when the baseline was zero — there is no percentage
change from nothing, and reporting one would put a fabricated number in front of
the model. `baseline: 0` is still emitted, which is what makes the absence
readable.

A category spent in only one of the two periods appears with a zero on the other
side rather than being dropped: started and stopped are the answer to the
question, not noise. `equal_length` is stated rather than corrected for —
comparing a 28-day month with a 31-day one is legitimate, but you should know
you are doing it.

## `analysis.recurring_expenses`

Payments that repeat to the same payee, with how often, how far apart, and how
much they vary.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `start`, `end` | yes | The period to scan, `end` inclusive |
| `min_occurrences` | no | How many payments before it counts as recurring. Default 3 |

It reports what the ledger records and stops there. It does not call anything a
subscription and does not decide whether one is still running: a fixed monthly
charge last paid three days ago may have been cancelled yesterday, and the
ledger cannot tell you. `typical_interval_days` and `days_since_last_seen` are
given so you can ask the user instead.

## `analysis.uncategorized`

Spending that carries no category, grouped by who was paid rather than listed
one transaction at a time — one decision per payee closes every payment to it,
via `transaction.bulk_categorize`.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `start`, `end` | yes | The period to scan, `end` inclusive |
| `limit` | no | How many payee groups to return, largest total first. Default 25 |

!!! warning "`truncated` means the numbers are lower bounds"

    Both scanning operations page through transactions and stop at a cap. If
    the period held more than the scan could read, the response carries
    `truncated: true` and a note. Every count and total is then at least the
    figure shown and possibly more — ask again over a shorter period for exact
    numbers.

## Resolving a name

`resolve.account`, `resolve.category`, `resolve.budget` and `resolve.tag` turn a
name a user said into the record they meant. Use them before writing against a
name that came out of a conversation.

```json
{ "entity": "resolve", "operation": "account", "params": { "query": "nakit" } }
```

```json
{
  "query": "nakit",
  "matched": true,
  "match": { "id": "3", "name": "Nakit (Cüzdan)", "matched_by": "contains", "score": 0.85 },
  "also_considered": []
}
```

Matching folds Turkish letters to ASCII, so `NAKİT` and `nakit` land on the same
token — `toLowerCase()` alone gets this language wrong.

The important case is the other one. When two names fit closely, the operation
**declines to choose**:

```json
{
  "query": "market",
  "matched": false,
  "reason": "ambiguous",
  "candidates": [ "..." ],
  "note": "Several names fit. Ask the user which one before writing anything."
}
```

That is a real answer, not a failure. Picking the highest score regardless would
turn "I am not sure" into a transaction recorded against the wrong account,
which nobody notices until reconciling. `matched_by` and `score` are carried so
you can tell the user how the name was matched, and `also_considered` so you can
say which name Firefly actually uses — the name a user says and the name on the
record differ often enough that hiding the difference reads as the server having
renamed something.

Firefly's internal bookkeeping accounts (`initial-balance`, `reconciliation`,
`import`) are excluded unless you ask for that `type` outright. Every asset
account has a matching "Initial balance for …" record, so including them would
report an ambiguity the user cannot even see in their own Firefly.

## Search

For finding a record whose ID you do not know.

### `search.transactions`

Full-text search over descriptions, notes and amounts. Cheaper and more direct
than listing a date range and filtering by hand.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `query` | yes | Text to search for |
| `limit`, `page` | no | Pagination |

### `search.accounts`

Finds accounts by name, IBAN, number or ID — a fragment of the name is enough.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `query` | yes | Text to search for |
| `field` | no | `all` (default), `name`, `iban`, `number`, `id` |
| `type` | no | Narrow by account type |
| `limit`, `page` | no | Pagination |

Firefly III answers 422 without the `field` parameter, so it is not left to the
caller: it defaults to `all`.

## Insight

Totals and breakdowns for a period. Every operation takes `start` and `end`.

Eight of Firefly's roughly twenty-five insight endpoints are wired up — the ones
that answer questions a finance assistant is actually asked.

| Operation | Question it answers |
|-----------|---------------------|
| `expense_total` | How much was spent in total? |
| `expense_category` | How does spending break down by category? |
| `expense_budget` | How does spending break down by budget? |
| `expense_tag` | How does spending break down by tag? |
| `expense_no_category` | How much spending has no category assigned? |
| `income_total` | How much was earned in total? |
| `income_category` | How does income break down by category? |
| `transfer_total` | How much moved between my own accounts? |

`expense_no_category` is worth calling before trusting a category breakdown: it
tells you how much of the total the breakdown cannot explain.

In raw insight responses, expenses come back **negative**. Only
`summary.overview` normalises them; if you call the thin operations directly,
the sign is yours to handle.

## Adding a new insight endpoint

The wired paths live in the `insightOperations` definitions in
`src/entities/remaining.ts`. For a new endpoint, add its Zod input schema and a
`defineOperation` entry there.
