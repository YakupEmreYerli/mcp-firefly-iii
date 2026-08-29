import { z } from "zod";
import { entityId, isoDate } from "./common.js";

/** Transaction types accepted as a list filter.
 *
 * Firefly accepts several spellings for the same thing (`withdrawal`,
 * `withdrawals`, `expense`); all of them are kept so a caller repeating what
 * Firefly's own docs say is not rejected.
 */
export const transactionTypeFilter = z.enum([
  "all",
  "withdrawal",
  "withdrawals",
  "expense",
  "deposit",
  "deposits",
  "income",
  "transfer",
  "transfers",
  "opening_balance",
  "reconciliation",
  "special",
  "specials",
  "default",
]);

/** The split type as stored, not as filtered. */
const splitType = z.enum(["withdrawal", "deposit", "transfer", "opening balance", "reconciliation"]);

/** Fields a split carries on both create and update.
 *
 * These are the attributes this server actually reads or writes — not the 61
 * the OpenAPI schema declares. An attribute nobody uses is an attribute nobody
 * maintains.
 */
const splitCommon = {
  // Firefly accepts YYYY-MM-DD and full ISO datetimes here, so the shape is
  // validated as a non-empty string rather than pinned to one format.
  date: z.string().min(1).describe("Transaction date, YYYY-MM-DD or ISO datetime"),
  amount: z.string().min(1).describe("Amount as a decimal string, e.g. \"25.50\""),
  description: z.string().min(1),
  source_id: entityId.optional(),
  source_name: z.string().optional(),
  destination_id: entityId.optional(),
  destination_name: z.string().optional(),
  category_id: entityId.optional(),
  category_name: z.string().optional(),
  budget_id: entityId.optional(),
  budget_name: z.string().optional(),
  bill_id: entityId.optional(),
  bill_name: z.string().optional(),
  currency_code: z.string().optional(),
  foreign_amount: z.string().optional(),
  foreign_currency_code: z.string().optional(),
  tags: z.array(z.string()).optional().describe(
    "Sent as a complete list: Firefly REPLACES the whole set rather than merging into it, so any value already there and not repeated here is removed. To add one, read the current values first and send them all back.",
  ),
  notes: z.string().optional(),
  reconciled: z.boolean().optional(),
};

/** One split of a new transaction. */
export const transactionSplitStore = z
  .object({ type: splitType, ...splitCommon })
  .strict();

/** One split of an updated transaction.
 *
 * `transaction_journal_id` is REQUIRED, though the OpenAPI schema marks it
 * optional. Without it Firefly cannot match the split: the update returns 200
 * and changes nothing. Making it required is the whole reason this schema is
 * hand-written.
 */
export const transactionSplitUpdate = z
  .object({
    transaction_journal_id: entityId.describe(
      "Required. Firefly cannot match the split without it — the update would return 200 and change nothing.",
    ),
    type: splitType.optional(),
    date: splitCommon.date.optional(),
    amount: splitCommon.amount.optional(),
    description: splitCommon.description.optional(),
    source_id: splitCommon.source_id,
    source_name: splitCommon.source_name,
    destination_id: splitCommon.destination_id,
    destination_name: splitCommon.destination_name,
    category_id: splitCommon.category_id,
    category_name: splitCommon.category_name,
    budget_id: splitCommon.budget_id,
    budget_name: splitCommon.budget_name,
    bill_id: splitCommon.bill_id,
    bill_name: splitCommon.bill_name,
    currency_code: splitCommon.currency_code,
    foreign_amount: splitCommon.foreign_amount,
    foreign_currency_code: splitCommon.foreign_currency_code,
    tags: splitCommon.tags,
    notes: splitCommon.notes,
    reconciled: splitCommon.reconciled,
  })
  .strict();

/** Fields a bulk rewrite sets on the splits of one transaction.
 *
 * `transaction_journal_id` is deliberately absent. The caller names a
 * transaction id and the server reads each group to fill the journal ids in —
 * requiring them here would push a read per row back onto the caller, which is
 * the exact work a bulk operation exists to remove.
 *
 * At least one field must be present: an empty object would spend a GET and a
 * PUT per id to change nothing, and report it as a successful rewrite.
 */
export const transactionBulkFields = z
  .object({
    type: splitType.optional().describe(
      "Converting a type (deposit → transfer) also needs the new source_id and destination_id",
    ),
    date: splitCommon.date.optional(),
    amount: splitCommon.amount.optional(),
    description: splitCommon.description.optional(),
    source_id: splitCommon.source_id,
    source_name: splitCommon.source_name,
    destination_id: splitCommon.destination_id,
    destination_name: splitCommon.destination_name,
    category_id: splitCommon.category_id,
    category_name: splitCommon.category_name,
    budget_id: splitCommon.budget_id,
    budget_name: splitCommon.budget_name,
    bill_id: splitCommon.bill_id,
    bill_name: splitCommon.bill_name,
    tags: splitCommon.tags,
    notes: splitCommon.notes,
    reconciled: splitCommon.reconciled,
  })
  .strict()
  .refine((fields) => Object.keys(fields).length > 0, {
    message: "Give at least one field to change; an empty set would rewrite nothing.",
  });

/** The fields a filter-driven write may set.
 *
 * `tags` is missing on purpose. Firefly replaces a split's whole tag list
 * rather than merging into it, so one `set` object shared by every matched row
 * would delete whatever each of them already carried — the failure CLAUDE.md
 * records `bulk_tag` causing once. The mitigation the field's own description
 * gives ("read the current values first and send them all back") cannot be
 * followed when the caller never names the rows. Use `bulk_tag`, which merges,
 * or `bulk_update`, where each row carries its own list.
 */
export const transactionBulkSetFields = transactionBulkFields.innerType()
  .omit({ tags: true })
  .strict()
  .refine((fields) => Object.keys(fields).length > 0, {
    message: "Give at least one field to change; an empty set would rewrite nothing.",
  });

/** One row of a bulk rewrite: which transaction, and what to set on it. */
export const transactionBulkEdit = z
  .object({
    transaction_id: entityId,
    fields: transactionBulkFields,
  })
  .strict();

/** Which transactions a bulk operation acts on.
 *
 * Firefly's own `/transactions` endpoint filters only on date range and type,
 * so everything else is applied while paging. That is deliberate: the point of
 * these operations is that the *server* walks the ledger, so the caller never
 * has to pull a few hundred records into its context to decide which ones it
 * meant.
 *
 * Every field is optional and they combine with AND. An empty filter selects
 * everything, which is why the write operations that take one also require an
 * explicit `max_matches`.
 */
/** An amount a filter can compare.
 *
 * Pinned to a plain decimal because `Number("1.000,00")` is NaN and every
 * comparison against NaN is false — an unparseable bound silently stopped
 * narrowing the selection and the filter matched everything behind it.
 */
const filterAmount = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, 'expected a plain decimal such as "1000.00"');

export const transactionFilter = z
  .object({
    start: isoDate.optional().describe("Start date, YYYY-MM-DD. `end` is INCLUSIVE."),
    end: isoDate.optional().describe("End date, YYYY-MM-DD, inclusive"),
    type: transactionTypeFilter.optional(),
    description_contains: z.string().min(1).optional().describe("Case-insensitive substring"),
    description_like: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Pattern over the WHOLE description: `#` is one run of digits, `*` is any run of characters, everything else is literal. '#-* ISTANBUL TR' matches '086200000023377-TRENDYOL.COM ISTANBUL TR'. Not a regular expression, and case-sensitive — use description_contains for a case-insensitive substring.",
      ),
    notes_contains: z.string().min(1).optional(),
    source_name: z.string().min(1).optional().describe("Exact source account name"),
    destination_name: z.string().min(1).optional().describe("Exact destination account name"),
    category_name: z.string().min(1).optional().describe("Exact category name"),
    has_no_category: z.boolean().optional().describe("Only transactions with no category set"),
    tag: z.string().min(1).optional().describe("Only transactions carrying this tag"),
    amount_equals: filterAmount.optional().describe("Exact amount, unsigned, as Firefly stores it"),
    amount_min: filterAmount.optional(),
    amount_max: filterAmount.optional(),
  })
  .strict();

/** How `group_patterns` collapses transactions into shapes. */
export const patternGrouping = z
  .enum(["description", "description_shape", "counterpart", "category"])
  .describe(
    "description_shape replaces every run of digits with '#', which is what turns a hundred raw card lines into the handful of patterns behind them",
  );

/** Which text field a rewrite reads and writes. */
export const rewriteField = z.enum(["description", "notes"]);

/** One row of an external statement, for reconciliation. */
export const statementRow = z
  .object({
    date: isoDate.describe("YYYY-MM-DD"),
    amount: filterAmount.describe(
      "Signed plain decimal: negative leaves the account, positive enters it",
    ),
    label: z.string().optional().describe("Carried through to the result so the row is recognisable"),
  })
  .strict();
