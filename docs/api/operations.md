# Operations

**152 operations** across 26 entities. This page covers the CRUD side; for the
operations that answer questions about your data — spending totals, category
breakdowns, period comparisons, search — see [Analysis Operations](analysis.md).

## How operations are called

Operations are not individual tools. There are five meta-tools, and everything
goes through them. Execution is split across
three of them by risk, so a host can annotate a delete differently from a read:

| Tool | Purpose |
|------|---------|
| `firefly_query` | Runs a read operation |
| `firefly_mutate` | Runs a create or update |
| `firefly_destructive` | Runs a delete, or a bulk rewrite |
| `firefly_list_operations` | Lists the operations |
| `firefly_get_schema` | Returns an operation's parameters |

```json
{
  "entity": "account",
  "operation": "list",
  "params": { "type": "asset", "limit": 10 }
}
```

An operation called through the wrong surface is refused rather than quietly
run — a delete reached through `firefly_query` is told which tool to use. And a
surface your configuration has left with no operations on it is not registered
at all, so it cannot be called only to fail.

A flat, one-tool-per-operation mapping (`account_list`, `transaction_create`,
...) would register 152 separate tools. Most MCP clients degrade past roughly
40 — the five meta-tools exist to stay well under that.

### Trimming responses

Firefly III returns every attribute it knows about, and most of them are null.
Empty and null attributes are dropped from every response automatically. Beyond
that, `fields` keeps only the attributes you name — on large result sets it cuts
the response by as much as 90%:

```json
{
  "entity": "transaction",
  "operation": "list",
  "fields": ["date", "amount", "description", "category_name"]
}
```

Omit `fields` when you do not yet know which attributes matter.

## Entities and their operations

| Entity | Count | Operations |
|--------|-------|------------|
| `summary` | 2 | basic, overview |
| `analysis` | 3 | compare_periods, recurring_expenses, uncategorized |
| `resolve` | 4 | account, budget, category, tag |
| `search` | 2 | accounts, transactions |
| `insight` | 8 | expense_budget, expense_category, expense_no_category, expense_tag, expense_total, income_category, income_total, transfer_total |
| `account` | 8 | create, delete, get, list, list_attachments, list_piggy_banks, list_transactions, update |
| `transaction` | 15 | bulk_categorize, bulk_delete, bulk_rewrite, bulk_tag, bulk_update, bulk_update_where, create, delete, get, group_patterns, list, list_attachments, list_piggy_bank_events, reconcile, update |
| `budget` | 13 | create, create_limit, delete, delete_limit, get, get_limit, list, list_attachments, list_limits, list_transactions, list_transactions_without_budget, update, update_limit |
| `category` | 7 | create, delete, get, list, list_attachments, list_transactions, update |
| `tag` | 7 | create, delete, get, list, list_attachments, list_transactions, update |
| `bill` | 8 | create, delete, get, list, list_attachments, list_rules, list_transactions, update |
| `piggy_bank` | 7 | create, delete, get, list, list_attachments, list_events, update |
| `rule` | 7 | create, delete, get, list, test, trigger, update |
| `rule_group` | 8 | create, delete, get, list, list_rules, test, trigger, update |
| `currency` | 7 | create, delete, disable, enable, get, list, update |
| `exchange_rate` | 5 | create, delete, get, list, update |
| `attachment` | 7 | create, delete, download, get, list, update, upload |
| `recurring_transaction` | 5 | create, delete, get, list, update |
| `autocomplete` | 8 | accounts, bills, budgets, categories, currencies, piggy_banks, tags, transactions |
| `available_budget` | 1 | list |
| `transaction_link` | 5 | create, delete, get, list, update |
| `link_type` | 3 | get, list, list_transactions |
| `object_group` | 2 | get, list |
| `preference` | 2 | get, list |
| `configuration` | 2 | get, list |
| `data_export` | 6 | accounts, bills, budgets, categories, piggy_banks, recurring |

For an operation's exact parameters call `firefly_get_schema`. This page does
not repeat them, because a copied list drifts from the code sooner or later.

### Export format

`data_export` operations return Firefly III's raw CSV output (`format: "raw"`)
by default. `format: "json"` converts the CSV rows into JSON objects keyed by
the header row.

## Accounts

`list` can be filtered by account type: `asset`, `expense`, `revenue`, `cash`,
`liability`, and others. Pass `date` to have balances computed as of that day.

`list_transactions` returns an account's transactions. The `start` and `end`
range treats **`end` as inclusive**.

!!! note "Single-day queries"

    Firefly III answers 422 on this endpoint when `start == end`, even though
    the other transaction endpoints accept it. The server works around this
    internally: it widens the range by a day and filters the extra day back out.
    You do not have to do anything to query a single day.

    Because the widened query also returns Firefly's own counts for two days,
    the server restates `meta.pagination.count` from what survived the filter
    and drops `total` and `total_pages` — those describe pages of the wider
    range and cannot be restated truthfully for one day.

## Transactions

### The shape of a transaction response

In Firefly a transaction is a *group* holding one or more splits, so its own API
buries the fields you want at `data[].attributes.transactions[0].amount`. This
server lifts them out: every response gives **one row per split**, with the
split's fields directly in `attributes`.

```json
{
  "data": [
    {
      "id": "7",
      "type": "transactions",
      "attributes": {
        "transaction_journal_id": "900",
        "date": "2026-08-01T10:00:00+03:00",
        "amount": "25.50",
        "description": "market",
        "category_name": "Groceries"
      }
    }
  ]
}
```

The shape does not change between a single purchase and a split transaction — a
group with several splits simply produces several rows, each carrying
`split_count`.

`id` stays the **group** id, because that is what `get`, `update` and `delete`
take. The split's own `transaction_journal_id` is on the row as well, since
updates need it inside the split.

One caveat: Firefly paginates *groups*, so `meta.pagination` counts groups
rather than rows. The two differ only for split transactions, which say so with
`split_count`.

### Creating and updating

`create` creates a transaction group. In Firefly every transaction is stored as
a group containing one or more "splits" — even a single purchase is written that
way.

Types: `withdrawal` (an expense), `deposit` (income), `transfer` (between your
own accounts), `opening balance`, `reconciliation`.

Source and destination rules depend on the type:

| Type | Source | Destination |
|------|--------|-------------|
| `withdrawal` | asset account | expense account |
| `deposit` | revenue account | asset account |
| `transfer` | asset account | asset account |

Expense and revenue accounts are created automatically when passed by name; a
transfer requires both accounts to exist already.

!!! danger "`transaction_journal_id` is required on update"

    If an `update` call omits `transaction_journal_id` inside a split, the split
    does not match. Firefly **does not report an error**: it answers 200 and
    changes nothing. The schema therefore requires the field. Verify updates
    with an independent read.

`bulk_categorize` and `bulk_tag` categorise or tag many transactions in one
call. Both fan out into a `GET` plus a `PUT` per id: Firefly's own
`/data/bulk/transactions` endpoint only moves transactions between accounts and
cannot set a category or tags at all.

Because the field travels as JSON rather than inside a query expression, a name
containing `=`, `&` or a comma is an ordinary value and is accepted.

!!! note "`bulk_tag` adds; it does not replace"

    Firefly rewrites the whole tag set on a journal update rather than merging
    into it. `bulk_tag` therefore reads the existing tags back and merges yours
    into them, so tagging an already-tagged transaction keeps what was there.
    To remove a tag, use `transaction.update`.

Both return a record per id rather than a single count, because these are
destructive operations and a failure part-way through would otherwise leave you
unable to tell how much had already changed:

```json
{
  "updated": 2,
  "failed": 1,
  "skipped": 0,
  "results": [
    { "id": 1, "status": "updated" },
    { "id": 2, "status": "failed", "reason": "404 – Not found" },
    { "id": 3, "status": "updated" }
  ],
  "category_name": "Market"
}
```

A failing id does not stop the ones after it: you named each id deliberately,
and one stale entry is not a reason to abandon the rest.

## Budgets

The largest entity (13 operations), because budget limits are their own
sub-resource: `list_limits`, `create_limit`, `get_limit`, `update_limit`,
`delete_limit`.

`list_transactions_without_budget` returns transactions attached to no budget —
useful for finding the gaps in budget coverage.

## Rules

`test` shows which transactions a rule would affect **without changing
anything**. `trigger` actually runs it.

Looking with `test` before running a rule that could be destructive is a good
habit.

## Error handling

Errors surface with the message Firefly III returned; the server does not
replace it with its own text.

| Status | Meaning |
|--------|---------|
| 401 / 403 | Token invalid or unauthorised |
| 404 | No such record |
| 422 | Validation error — missing or invalid parameter |
| 5xx | Something wrong on the Firefly III side |

A write or destructive operation beyond what the connection's Firefly token or
OAuth scope allows is refused before reaching Firefly at all — see
[what the assistant may do](../configuration.md#what-the-assistant-may-do).

### Rate limiting

The server **does not retry**. Rate-limit responses from Firefly III are passed
straight to the caller with the message Firefly returned.

## Security

- Every operation is subject to Firefly III's own authorisation model
- The server's reach is exactly what your API token allows
- No query or personal data is cached; the only outbound call is to the Firefly
  III instance you configured
- To turn writes off entirely, issue a read-only Firefly token or withhold the
  `firefly:write` OAuth scope — see
  [what the assistant may do](../configuration.md#what-the-assistant-may-do)
