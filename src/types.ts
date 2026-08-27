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

/** What an operation does to Firefly III.
 *
 * Required on every operation: read-only mode keys off this field, and a
 * missing one would leave a write silently callable.
 *
 * `destructive` is the subset the caller cannot undo — it removes a record, or
 * rewrites a field across many records in one call. It is split out from
 * `write` so a host can raise confirmation exactly where it matters, and so
 * "may write but may not delete" becomes expressible instead of being folded
 * into the same permission as creating a transaction.
 */
export type Access = "read" | "write" | "destructive";
