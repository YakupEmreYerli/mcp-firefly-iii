import { z } from "zod";
import { defineOperation, type EntityModule, type Operation } from "../registry.js";
import { dateRange, entityId, isoDate, pagination } from "../schemas/common.js";
import { EntityType } from "../types.js";

const accountType = z.enum([
  "all", "asset", "cash", "expense", "revenue", "special", "hidden",
  "liability", "liabilities", "Default account", "Cash account", "Asset account",
  "Expense account", "Revenue account", "Initial balance account", "Beneficiary account",
  "Import account", "Reconciliation account", "Loan", "Debt", "Mortgage",
]);
const transactionType = z.enum([
  "all", "withdrawal", "withdrawals", "expense", "deposit", "deposits", "income",
  "transfer", "transfers", "opening_balance", "reconciliation", "special", "specials", "default",
]);
const accountRole = z.enum(["defaultAsset", "sharedAsset", "savingAsset", "ccAsset", "cashWalletAsset"]);
const accountFields = {
  name: z.string().min(1), iban: z.string().optional(), bic: z.string().optional(),
  account_number: z.string().optional(), opening_balance: z.string().optional(),
  opening_balance_date: z.string().optional(), virtual_balance: z.string().optional(),
  currency_id: z.string().optional(), currency_code: z.string().optional(), active: z.boolean().optional(),
  order: z.number().int().optional(), include_net_worth: z.boolean().optional(),
  account_role: accountRole.optional(), credit_card_type: z.string().optional(),
  monthly_payment_date: z.string().optional(), liability_type: z.string().optional(),
  liability_direction: z.string().optional(), interest: z.string().optional(),
  interest_period: z.string().optional(), notes: z.string().optional(), latitude: z.number().optional(),
  longitude: z.number().optional(), zoom_level: z.number().int().optional(),
};
const accountStore = z.object({ ...accountFields, type: z.string().min(1) }).strict();
const accountUpdate = z.object(accountFields).strict();

export const accountOperations: Record<string, Operation> = {
  list: defineOperation({
    description: "Which accounts exist? Filter by account type, balance date, and pagination.", access: "read",
    input: z.object({ type: accountType.default("all"), date: isoDate.optional(), ...pagination }).strict(),
    handler: (params, client) => client.get("/accounts", params),
  }),
  get: defineOperation({
    description: "What are the details and balance of this account?", access: "read",
    input: z.object({ id: entityId, date: isoDate.optional() }).strict(),
    handler: ({ id, ...query }, client) => client.get(`/accounts/${id}`, query),
  }),
  create: defineOperation({ description: "Create a new account.", access: "write", input: accountStore, handler: (body, client) => client.post("/accounts", body) }),
  update: defineOperation({
    description: "Change an existing account.", access: "write",
    input: z.object({ id: entityId, account_update: accountUpdate }).strict(),
    handler: ({ id, account_update }, client) => client.put(`/accounts/${id}`, account_update),
  }),
  delete: defineOperation({
    description: "Delete an account.", access: "destructive", input: z.object({ id: entityId }).strict(),
    handler: async ({ id }, client) => { await client.del(`/accounts/${id}`); return { deleted: true, id }; },
  }),
  list_transactions: defineOperation({
    description: "Which transactions belong to this account in a date range?", access: "read",
    input: z.object({ id: entityId, ...pagination, ...dateRange, type: transactionType.optional() }).strict(),
    handler: async ({ id, ...query }, client) => {
      const start = query.start;
      const end = query.end;
      if (start && start === end) {
        const next = new Date(`${end}T00:00:00Z`);
        next.setUTCDate(next.getUTCDate() + 1);
        query.end = next.toISOString().slice(0, 10);
        const result = await client.get(`/accounts/${id}/transactions`, query);
        if (!isRecord(result) || !Array.isArray(result.data)) return result;
        const kept = result.data.filter((record) => recordMatchesDay(record, start));
        return { ...result, data: kept, ...narrowPagination(result.meta, kept.length) };
      }
      return client.get(`/accounts/${id}/transactions`, query);
    },
  }),
  list_attachments: defineOperation({
    description: "Which files are attached to this account?", access: "read",
    input: z.object({ id: entityId, ...pagination }).strict(),
    handler: ({ id, ...query }, client) => client.get(`/accounts/${id}/attachments`, query),
  }),
  list_piggy_banks: defineOperation({
    description: "Which piggy banks are linked to this account?", access: "read",
    input: z.object({ id: entityId, ...pagination }).strict(),
    handler: ({ id, ...query }, client) => client.get(`/accounts/${id}/piggy-banks`, query),
  }),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Restate the pagination block for the narrowed day.
 *
 * The widening above asks Firefly for two days, so the counts it answers with
 * describe two days. Left alone beside one day of records they read as a
 * larger day than actually happened. `count` is restated from what survived
 * the filter; `total` and `total_pages` describe pages of the wider range and
 * cannot be restated truthfully here, so they are dropped rather than
 * reported wrong.
 */
function narrowPagination(meta: unknown, kept: number): { meta?: unknown } {
  if (!isRecord(meta) || !isRecord(meta.pagination)) return {};
  const { total: _total, total_pages: _totalPages, ...rest } = meta.pagination;
  return { meta: { ...meta, pagination: { ...rest, count: kept } } };
}

function recordMatchesDay(value: unknown, day: string): boolean {
  if (!isRecord(value) || !isRecord(value.attributes) || !Array.isArray(value.attributes.transactions)) return false;
  return value.attributes.transactions.some((split) => isRecord(split) && typeof split.date === "string" && split.date.startsWith(day));
}

export const accountsModule: EntityModule = {
  entity: EntityType.Account,
  hint: "accounts and their transactions, attachments, and piggy banks",
  operations: accountOperations,
};
