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

## `summary.basic`

Firefly III's own summary block: balance, spent, earned, bills paid and unpaid,
left to spend, and net worth — per currency.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `start` | yes | `YYYY-MM-DD` |
| `end` | yes | `YYYY-MM-DD`, inclusive |
| `currency_code` | no | Limit to one currency, e.g. `EUR` |

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
