# Firefly III MCP Server

A Model Context Protocol (MCP) server that opens your
[Firefly III](https://www.firefly-iii.org/) personal finance instance to Claude
Code, Claude Desktop, Cursor and other MCP-capable AI clients.

## What is MCP?

The Model Context Protocol is an open standard for connecting AI assistants to
external data sources and tools. This server makes your Firefly III data
answerable in plain language: you ask "how much did I spend this month", and the
assistant looks at your own instance and answers.

## Highlights

- **An analysis surface, not just CRUD.** Reading and writing records is one
  thing; answering questions about them is another. `summary.overview` returns a
  whole period in a single call.
- **Access belongs to the connection.** A stdio client can do whatever its
  Firefly token can. Over HTTP, OAuth scopes are approved per connection, and a
  surface that was not granted is refused as well as hidden from the catalogue.
- **5 meta-tools, 152 operations.** Most MCP clients degrade past roughly 40
  tools, so operations are reached through meta-tools rather than exposed one by
  one. Execution is split across three of them by risk — query, mutate,
  destructive — and the split is enforced, not just advertised.
- **Validated inputs.** Every operation declares a strict schema: unknown
  parameters are refused rather than silently dropped, which is what keeps a
  malformed update from succeeding with no effect.
- **Context economy.** Empty and null attributes are stripped from every
  response, and `fields` keeps only the attributes you name.

## Demo

<video controls preload="metadata" style="width:100%;max-width:960px;border-radius:8px">
  <source src="assets/demo.mp4" type="video/mp4">
  <a href="assets/demo.mp4">Download the demo (MP4, 38s)</a>
</video>

A 38-second run in Claude Desktop: ask a financial question, read the answer
through MCP, preview a change with `dry_run`, approve it, and write it back to
Firefly III. All financial data in the demo is fabricated.

## What it looks like

Once installed, you talk to your assistant in plain language:

!!! example "Managing money in plain language"

    === "Asking questions"

        ```
        "Show me my account balances"
        "How much did I spend this month, broken down by category?"
        "List last week's transactions"
        "How am I doing against this month's budget?"
        "How much have I transferred to my brokerage account in total?"
        ```

    === "Creating records"

        ```
        "I spent 30 at the corner shop on drinks, take it from cash"
        "I transferred 800 from my checking account to my brokerage account"
        "Create a new category called 'Home & Kitchen'"
        ```

## Getting started

1. **[Quickstart](quickstart.md)** — install and first run
2. **[Configuration](configuration.md)** — environment variables and read-only mode
3. **[MCP Integration](integrations.md)** — connecting your client

## Operations

152 operations across 26 entities.

| Entity | Purpose | Operations |
|--------|---------|------------|
| **summary** | Period summary and overview | basic, overview |
| **analysis** | Questions answered from the ledger rather than fetched | compare_periods, recurring_expenses, uncategorized |
| **resolve** | Turning a name a user said into the record they meant | account, budget, category, tag |
| **search** | Finding records without knowing an ID | accounts, transactions |
| **insight** | Spending and income analysis | expense_budget, expense_category, expense_no_category, expense_tag, expense_total, income_category, income_total, transfer_total |
| **account** | Asset, expense, revenue and liability accounts | create, delete, get, list, list_attachments, list_piggy_banks, list_transactions, update |
| **transaction** | Transactions and transfers | bulk_categorize, bulk_delete, bulk_rewrite, bulk_tag, bulk_update, bulk_update_where, create, delete, get, group_patterns, list, list_attachments, list_piggy_bank_events, reconcile, update |
| **budget** | Budgets and spending limits | create, create_limit, delete, delete_limit, get, get_limit, list, list_attachments, list_limits, list_transactions, list_transactions_without_budget, update, update_limit |
| **category** | Transaction categories | create, delete, get, list, list_attachments, list_transactions, update |
| **tag** | Transaction tags | create, delete, get, list, list_attachments, list_transactions, update |
| **bill** | Recurring bills | create, delete, get, list, list_attachments, list_rules, list_transactions, update |
| **piggy_bank** | Savings goals | create, delete, get, list, list_attachments, list_events, update |
| **rule** | Automation rules | create, delete, get, list, test, trigger, update |
| **rule_group** | Rule groups | create, delete, get, list, list_rules, test, trigger, update |
| **currency** | Currencies | create, delete, disable, enable, get, list, update |
| **exchange_rate** | Currency conversion rates | create, delete, get, list, update |
| **attachment** | Files attached to financial records | create, delete, download, get, list, update, upload |
| **recurring_transaction** | Scheduled recurring transactions | create, delete, get, list, update |
| **autocomplete** | Fast lookup suggestions | accounts, bills, budgets, categories, currencies, piggy_banks, tags, transactions |
| **available_budget** | Budget available within a period | list |
| **transaction_link** | Relationships between transactions | create, delete, get, list, update |
| **link_type** | Names for those relationships | get, list, list_transactions |
| **object_group** | Groups of accounts and records | get, list |
| **preference** | User preferences | get, list |
| **configuration** | Firefly system settings | get, list |
| **data_export** | Exporting financial data | accounts, bills, budgets, categories, piggy_banks, recurring |