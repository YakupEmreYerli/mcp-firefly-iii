import { z } from "zod";
import { entityId } from "./common.js";

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
