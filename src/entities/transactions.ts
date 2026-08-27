import { z } from "zod";
import { defineOperation, type EntityModule, type Operation } from "../registry.js";
import { EntityType } from "../types.js";
import { dateRange, entityId, pagination } from "../schemas/common.js";
import {
  transactionSplitStore,
  transactionSplitUpdate,
  transactionTypeFilter,
} from "../schemas/transactions.js";

export const transactionOperations: Record<string, Operation> = {
  list: defineOperation({
    description:
      "Which transactions happened in this period? Filterable by date range and type, paginated.",
    access: "read",
    input: z
      .object({
        ...pagination,
        ...dateRange,
        type: transactionTypeFilter.optional().describe("Filter on the transaction type(s) returned"),
      })
      .strict(),
    handler: (params, client) => client.get("/transactions", params),
  }),

  get: defineOperation({
    description: "What are the details of this transaction?",
    access: "read",
    input: z.object({ id: entityId }).strict(),
    handler: ({ id }, client) => client.get(`/transactions/${id}`),
  }),

  list_attachments: defineOperation({
    description: "Which files are attached to this transaction?",
    access: "read",
    input: z.object({ id: entityId, ...pagination }).strict(),
    handler: ({ id, ...query }, client) => client.get(`/transactions/${id}/attachments`, query),
  }),

  list_piggy_bank_events: defineOperation({
    description: "Which piggy bank events did this transaction cause?",
    access: "read",
    input: z.object({ id: entityId, ...pagination }).strict(),
    handler: ({ id, ...query }, client) =>
      client.get(`/transactions/${id}/piggy-bank-events`, query),
  }),

  create: defineOperation({
    description: "Record a new transaction.",
    access: "write",
    input: z
      .object({
        transactions: z.array(transactionSplitStore).min(1),
        group_title: z.string().optional().describe("Title for a split transaction group"),
        apply_rules: z.boolean().optional(),
        fire_webhooks: z.boolean().optional(),
        error_if_duplicate_hash: z.boolean().optional(),
      })
      .strict(),
    handler: (body, client) => client.post("/transactions", body),
  }),

  update: defineOperation({
    description: "Change an existing transaction.",
    access: "write",
    // `id` sits beside the update fields rather than wrapping them. Firefly
    // does not reject unknown top-level keys: a body sent under a wrapper key
    // returns 200 and changes nothing. `.strict()` plus this flat shape means
    // such a body cannot be built in the first place.
    input: z
      .object({
        id: entityId,
        transactions: z.array(transactionSplitUpdate).min(1),
        group_title: z.string().optional(),
        apply_rules: z.boolean().optional(),
        fire_webhooks: z.boolean().optional(),
      })
      .strict(),
    handler: ({ id, ...body }, client) => client.put(`/transactions/${id}`, body),
  }),

  delete: defineOperation({
    description: "Delete a transaction.",
    access: "write",
    input: z.object({ id: entityId }).strict(),
    handler: async ({ id }, client) => {
      // Firefly answers 204 with no body. Reporting the id back is a fact;
      // a fabricated "deleted successfully" message would be an unverified
      // claim dressed as a response.
      await client.del(`/transactions/${id}`);
      return { deleted: true, id };
    },
  }),

  // Firefly III's `/data/bulk/transactions` only moves transactions between
  // accounts (a `{where,update}` JSON over `account_id`); it cannot set a
  // category or tags. The earlier implementation sent `category_name=<name>`
  // as the `query` string, which the endpoint rejects with 500 "Syntax error"
  // — it never worked. The only API path that sets a category or tags on
  // existing transactions is a per-group PUT, so these operations fan out
  // into a GET + PUT per id.
  bulk_categorize: defineOperation({
    description: "Assign one category to several transactions at once.",
    access: "write",
    input: z
      .object({
        transaction_ids: z.array(z.number().int().positive()).min(1),
        category_name: z.string().min(1),
      })
      .strict(),
    handler: async ({ transaction_ids, category_name }, client) => {
      let updated = 0;
      for (const id of transaction_ids) {
        const group = (await client.get(`/transactions/${id}`)) as {
          data?: { attributes?: { transactions?: { transaction_journal_id: string }[] } };
        };
        const journals = group.data?.attributes?.transactions ?? [];
        if (journals.length === 0) continue;
        await client.put(`/transactions/${id}`, {
          transactions: journals.map((j) => ({ transaction_journal_id: j.transaction_journal_id, category_name })),
        });
        updated++;
      }
      return { updated, category_name };
    },
  }),

  bulk_tag: defineOperation({
    description: "Assign one or more tags to several transactions at once.",
    access: "write",
    input: z
      .object({
        transaction_ids: z.array(z.number().int().positive()).min(1),
        tag_names: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    handler: async ({ transaction_ids, tag_names }, client) => {
      let updated = 0;
      for (const id of transaction_ids) {
        const group = (await client.get(`/transactions/${id}`)) as {
          data?: { attributes?: { transactions?: { transaction_journal_id: string }[] } };
        };
        const journals = group.data?.attributes?.transactions ?? [];
        if (journals.length === 0) continue;
        await client.put(`/transactions/${id}`, {
          transactions: journals.map((j) => ({ transaction_journal_id: j.transaction_journal_id, tags: tag_names })),
        });
        updated++;
      }
      return { updated, tag_names };
    },
  }),
};

export const transactionsModule: EntityModule = {
  entity: EntityType.Transaction,
  hint: "individual transactions; create, edit, bulk categorise",
  operations: transactionOperations,
};
