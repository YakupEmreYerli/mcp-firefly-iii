/** Entity types this server can expose. */
export enum EntityType {
  Account = "account",
  Transaction = "transaction",
  Budget = "budget",
  Category = "category",
  Tag = "tag",
  Rule = "rule",
  RuleGroup = "rule_group",
  Bill = "bill",
  PiggyBank = "piggy_bank",
  Summary = "summary",
  Search = "search",
  Insight = "insight",
  Currency = "currency",
  ExchangeRate = "exchange_rate",
  Attachment = "attachment",
  RecurringTransaction = "recurring_transaction",
  Autocomplete = "autocomplete",
  AvailableBudget = "available_budget",
  TransactionLink = "transaction_link",
  LinkType = "link_type",
  ObjectGroup = "object_group",
  Preference = "preference",
  Configuration = "configuration",
  DataExport = "data_export",
  Analysis = "analysis",
}

/** Whether an operation reads from or writes to Firefly III.
 *
 * Required on every operation: read-only mode keys off this field, and a
 * missing one would leave a write silently callable.
 */
export type Access = "read" | "write";
