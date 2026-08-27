import { z } from "zod";
import { defineOperation, type EntityModule, type Operation } from "../registry.js";
import { entityId, isoDate, pagination } from "../schemas/common.js";
import { EntityType } from "../types.js";

const id = z.object({ id: entityId }).strict();
const currencyCode = z.object({ code: z.string().min(1) }).strict();
const currencyData = z.object({ code: z.string().min(1), name: z.string().min(1), symbol: z.string().min(1), decimal_places: z.number().int().min(0).max(16).optional(), enabled: z.boolean().optional(), default: z.boolean().optional() }).strict();
const exchangeRateData = z.object({ date: isoDate, rate: z.string().min(1), from: z.string().min(1), to: z.string().min(1) }).strict();
const attachmentData = z.object({ attachable_type: z.enum(["Account", "Budget", "Bill", "TransactionJournal", "PiggyBank", "Tag"]), attachable_id: entityId, title: z.string().optional(), filename: z.string().min(1), notes: z.string().optional() }).strict();
const recurrenceTransaction = z.object({
  description: z.string().min(1), amount: z.string().min(1),
  currency_code: z.string().min(1).optional(), currency_id: entityId.optional(),
  source_id: entityId, destination_id: entityId,
  foreign_amount: z.string().optional(), foreign_currency_code: z.string().optional(),
  foreign_currency_id: entityId.optional(), budget_id: entityId.optional(),
  category_id: entityId.optional(), piggy_bank_id: entityId.optional(), bill_id: entityId.optional(),
  tags: z.array(z.string()).optional(),
}).strict();
const recurrenceRepetition = z.object({
  type: z.enum(["daily", "weekly", "ndom", "monthly", "yearly"]),
  moment: z.string(), skip: z.number().int().nonnegative().optional(), weekend: z.number().int().min(1).max(4).optional(),
}).strict();
const recurrenceData = z.object({
  type: z.enum(["withdrawal", "deposit", "transfer"]), title: z.string().min(1), first_date: isoDate,
  repeat_until: isoDate.optional(), nr_of_repetitions: z.number().int().positive().optional(),
  apply_rules: z.boolean().optional(), active: z.boolean().optional(), description: z.string().optional(), notes: z.string().optional(),
  repetitions: z.array(recurrenceRepetition).min(1), transactions: z.array(recurrenceTransaction).min(1),
}).strict();

export const currencyOperations: Record<string, Operation> = {
  list: defineOperation({ description: "Which currencies are available?", access: "read", input: z.object({ ...pagination }).strict(), handler: (q, c) => c.get("/currencies", q) }),
  get: defineOperation({ description: "What are the details of this currency?", access: "read", input: currencyCode, handler: ({ code }, c) => c.get(`/currencies/${code}`) }),
  create: defineOperation({ description: "Create a currency.", access: "write", input: currencyData, handler: (b, c) => c.post("/currencies", b) }),
  update: defineOperation({ description: "Change a currency.", access: "write", input: z.object({ code: z.string().min(1), currency_update: currencyData.partial() }).strict(), handler: ({ code, currency_update }, c) => c.put(`/currencies/${code}`, currency_update) }),
  delete: defineOperation({ description: "Delete a currency.", access: "destructive", input: currencyCode, handler: async ({ code }, c) => { await c.del(`/currencies/${code}`); return { deleted: true, code }; } }),
  enable: defineOperation({ description: "Enable a currency.", access: "write", input: currencyCode, handler: ({ code }, c) => c.post(`/currencies/${code}/enable`) }),
  disable: defineOperation({ description: "Disable a currency.", access: "write", input: currencyCode, handler: ({ code }, c) => c.post(`/currencies/${code}/disable`) }),
};
export const currenciesModule: EntityModule = { entity: EntityType.Currency, hint: "currencies used by accounts and transactions", operations: currencyOperations };

export const exchangeRateOperations: Record<string, Operation> = {
  list: defineOperation({ description: "Which exchange rates are configured?", access: "read", input: z.object({ ...pagination }).strict(), handler: (q, c) => c.get("/exchange-rates", q) }),
  get: defineOperation({ description: "What is this exchange rate?", access: "read", input: id, handler: ({ id }, c) => c.get(`/exchange-rates/${id}`) }),
  create: defineOperation({ description: "Create an exchange rate.", access: "write", input: exchangeRateData, handler: (b, c) => c.post("/exchange-rates", b) }),
  update: defineOperation({ description: "Change an exchange rate.", access: "write", input: z.object({ id: entityId, exchange_rate_update: exchangeRateData.partial() }).strict(), handler: ({ id, exchange_rate_update }, c) => c.put(`/exchange-rates/${id}`, exchange_rate_update) }),
  delete: defineOperation({ description: "Delete an exchange rate.", access: "destructive", input: id, handler: async ({ id }, c) => { await c.del(`/exchange-rates/${id}`); return { deleted: true, id }; } }),
};
export const exchangeRatesModule: EntityModule = { entity: EntityType.ExchangeRate, hint: "currency conversion rates", operations: exchangeRateOperations };

export const attachmentOperations: Record<string, Operation> = {
  list: defineOperation({ description: "Which attachments exist?", access: "read", input: z.object({ ...pagination }).strict(), handler: (q, c) => c.get("/attachments", q) }),
  get: defineOperation({ description: "What are the details of this attachment?", access: "read", input: id, handler: ({ id }, c) => c.get(`/attachments/${id}`) }),
  create: defineOperation({ description: "Create attachment metadata.", access: "write", input: attachmentData, handler: (b, c) => c.post("/attachments", b) }),
  upload: defineOperation({ description: "Upload the file content for an attachment (base64).", access: "write", input: z.object({ id: entityId, content_base64: z.string().min(1), mime_type: z.string().min(1).optional() }).strict(), handler: ({ id, content_base64, mime_type }, c) => c.postBinary(`/attachments/${id}/upload`, Uint8Array.from(Buffer.from(content_base64, "base64")), mime_type) }),
  update: defineOperation({ description: "Change attachment metadata.", access: "write", input: z.object({ id: entityId, attachment_update: attachmentData.partial() }).strict(), handler: ({ id, attachment_update }, c) => c.put(`/attachments/${id}`, attachment_update) }),
  delete: defineOperation({ description: "Delete an attachment.", access: "destructive", input: id, handler: async ({ id }, c) => { await c.del(`/attachments/${id}`); return { deleted: true, id }; } }),
  download: defineOperation({ description: "Download an attachment.", access: "read", input: id, handler: ({ id }, c) => c.get(`/attachments/${id}/download`) }),
};
export const attachmentsModule: EntityModule = { entity: EntityType.Attachment, hint: "files attached to financial records", operations: attachmentOperations };

export const recurringOperations: Record<string, Operation> = {
  list: defineOperation({ description: "Which recurring transactions exist?", access: "read", input: z.object({ ...pagination }).strict(), handler: (q, c) => c.get("/recurrences", q) }),
  get: defineOperation({ description: "What are the details of this recurring transaction?", access: "read", input: id, handler: ({ id }, c) => c.get(`/recurrences/${id}`) }),
  create: defineOperation({ description: "Create a recurring transaction.", access: "write", input: recurrenceData, handler: (b, c) => c.post("/recurrences", b) }),
  update: defineOperation({ description: "Change a recurring transaction.", access: "write", input: z.object({ id: entityId, recurrence_update: recurrenceData.partial().extend({ transactions: recurrenceData.shape.transactions }) }).strict(), handler: ({ id, recurrence_update }, c) => c.put(`/recurrences/${id}`, recurrence_update) }),
  delete: defineOperation({ description: "Delete a recurring transaction.", access: "destructive", input: id, handler: async ({ id }, c) => { await c.del(`/recurrences/${id}`); return { deleted: true, id }; } }),
};
export const recurringModule: EntityModule = { entity: EntityType.RecurringTransaction, hint: "scheduled recurring financial transactions", operations: recurringOperations };

const autocompleteKinds = ["accounts", "bills", "budgets", "categories", "currencies", "piggy-banks", "tags", "transactions"] as const;
export const autocompleteOperations: Record<string, Operation> = {};
for (const kind of autocompleteKinds) {
  autocompleteOperations[kind.replaceAll("-", "_")] = defineOperation({
    description: `Which ${kind} match this autocomplete query?`, access: "read",
    input: z.object({ query: z.string().optional(), ...pagination }).strict(),
    handler: (q, c) => c.get(`/autocomplete/${kind}`, q),
  });
}
export const autocompleteModule: EntityModule = { entity: EntityType.Autocomplete, hint: "fast lookup suggestions for financial records", operations: autocompleteOperations };
