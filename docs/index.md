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
- **5 meta-tools, 146 operations.** Most MCP clients degrade past roughly 40
  tools, so operations are reached through meta-tools rather than exposed one by
  one. Execution is split across three of them by risk — query, mutate,
  destructive — and the split is enforced, not just advertised.
- **Validated inputs.** Every operation declares a strict schema: unknown
  parameters are refused rather than silently dropped, which is what keeps a
  malformed update from succeeding with no effect.
- **Context economy.** Empty and null attributes are stripped from every
  response, and `fields` keeps only the attributes you name.

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

146 operations across 26 entities.

| Entity | Purpose | Operations |
|--------|---------|------------|
| **summary** | Period summary and overview | overview, basic |
| **analysis** | Questions answered from the ledger rather than fetched | compare_periods, recurring_expenses, uncategorized |
| **resolve** | Turning a name a user said into the record they meant | account, budget, category, tag |
| **search** | Finding records without knowing an ID | transactions, accounts |
| **insight** | Spending and income analysis | expense_total, expense_category, expense_budget, expense_tag, expense_no_category, income_total, income_category, transfer_total |
| **account** | Asset, expense, revenue and liability accounts | list, get, create, update, delete, list_transactions, list_attachments, list_piggy_banks |
| **transaction** | Transactions and transfers | list, get, create, update, delete, list_attachments, list_piggy_bank_events, bulk_categorize, bulk_tag |
| **budget** | Budgets and spending limits | list, get, create, update, delete, list_limits, create_limit, get_limit, update_limit, delete_limit, list_transactions, list_transactions_without_budget, list_attachments |
| **category** | Transaction categories | list, get, create, update, delete, list_transactions, list_attachments |
| **tag** | Transaction tags | list, get, create, update, delete, list_transactions, list_attachments |
| **bill** | Recurring bills | list, get, create, update, delete, list_transactions, list_attachments, list_rules |
| **piggy_bank** | Savings goals | list, get, create, update, delete, list_events, list_attachments |
| **rule** | Automation rules | list, get, create, update, delete, test, trigger |
| **rule_group** | Rule groups | list, get, create, update, delete, list_rules, test, trigger |
| **currency** | Currencies | list, get, create, update, delete, enable, disable |
| **exchange_rate** | Currency conversion rates | list, get, create, update, delete |
| **attachment** | Files attached to financial records | list, get, create, upload, update, delete, download |
| **recurring_transaction** | Scheduled recurring transactions | list, get, create, update, delete |
| **autocomplete** | Fast lookup suggestions | accounts, bills, budgets, categories, currencies, piggy_banks, tags, transactions |
| **available_budget** | Budget available within a period | list |
| **transaction_link** | Relationships between transactions | list, get, create, update, delete |
| **link_type** | Names for those relationships | list, get, list_transactions |
| **object_group** | Groups of accounts and records | list, get |
| **preference** | User preferences | list, get |
| **configuration** | Firefly system settings | list, get |
| **data_export** | Exporting financial data | accounts, bills, budgets, categories, piggy_banks, recurring |

For the analysis operations in detail see
[Analysis Operations](api/analysis.md); for the full CRUD list see
[Operations](api/operations.md).

Export operations return Firefly's raw CSV by default. Pass `format: "json"`
for programmatic use.

## Requirements

- Node.js 20.6+
- npm
- A running Firefly III instance
- A Firefly III Personal Access Token
- An MCP-capable client (Claude Code, Claude Desktop, Cursor, and others)

The server runs on TypeScript/Node.js. No Python installation or `uv` required.

## Support

- 📖 [Documentation](https://github.com/YakupEmreYerli/mcp-firefly-iii/tree/main/docs)
- 🐛 [Issues](https://github.com/YakupEmreYerli/mcp-firefly-iii/issues)
