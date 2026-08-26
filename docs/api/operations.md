# Operations

**139 operations** across 24 entities. This page covers the CRUD side; for the
operations that answer questions about your data — spending totals, category
breakdowns, search — see [Analysis Operations](analysis.md).

## How operations are called

In the default **consolidated mode** operations are not individual tools. There
are three meta-tools, and everything goes through them:

| Tool | Purpose |
|------|---------|
| `firefly_execute` | Runs an operation |
| `firefly_list_operations` | Lists the operations |
| `firefly_get_schema` | Returns an operation's parameters |

```json
{
  "entity": "account",
  "operation": "list",
  "params": { "type": "asset", "limit": 10 }
}
```

With `FIREFLY_DIRECT_MODE=true` every operation becomes its own tool
(`account_list`, `transaction_create`). That registers 139 tools, and most
clients degrade past roughly 40.

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
| `summary` | 2 | overview, basic |
| `search` | 2 | transactions, accounts |
| `insight` | 8 | expense_total, expense_category, expense_budget, expense_tag, expense_no_category, income_total, income_category, transfer_total |
| `account` | 8 | list, get, create, update, delete, list_transactions, list_attachments, list_piggy_banks |
| `transaction` | 9 | list, get, create, update, delete, list_attachments, list_piggy_bank_events, bulk_categorize, bulk_tag |
| `budget` | 13 | list, get, create, update, delete, list_limits, create_limit, get_limit, update_limit, delete_limit, list_transactions, list_transactions_without_budget, list_attachments |
| `category` | 7 | list, get, create, update, delete, list_transactions, list_attachments |
| `tag` | 7 | list, get, create, update, delete, list_transactions, list_attachments |
| `bill` | 8 | list, get, create, update, delete, list_transactions, list_attachments, list_rules |
| `piggy_bank` | 7 | list, get, create, update, delete, list_events, list_attachments |
| `rule` | 7 | list, get, create, update, delete, test, trigger |
| `rule_group` | 8 | list, get, create, update, delete, list_rules, test, trigger |
| `currency` | 7 | list, get, create, update, delete, enable, disable |
| `exchange_rate` | 5 | list, get, create, update, delete |
| `attachment` | 7 | list, get, create, upload, update, delete, download |
| `recurring_transaction` | 5 | list, get, create, update, delete |
| `autocomplete` | 8 | accounts, bills, budgets, categories, currencies, piggy_banks, tags, transactions |
| `available_budget` | 1 | list |
| `transaction_link` | 5 | list, get, create, update, delete |
| `link_type` | 3 | list, get, list_transactions |
| `object_group` | 2 | list, get |
| `preference` | 2 | list, get |
| `configuration` | 2 | list, get |
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
call. Names containing `=`, `&`, or (for tags) a comma are refused: Firefly
parses the bulk instruction as an expression, and such a name would change what
the expression means — landing the update somewhere other than where you asked,
with a 200 in response.

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

In read-only mode, write operations are refused before reaching Firefly at all,
and this is reported as a read-only error rather than a generic failure.

### Rate limiting

The server **does not retry**. Rate-limit responses from Firefly III are passed
straight to the caller with the message Firefly returned.

## Security

- Every operation is subject to Firefly III's own authorisation model
- The server's reach is exactly what your API token allows
- No query or personal data is cached; the only outbound call is to the Firefly
  III instance you configured
- To turn writes off entirely see
  [read-only mode](../configuration.md#read-only-mode)
