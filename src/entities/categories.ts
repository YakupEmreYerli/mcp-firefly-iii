import { z } from "zod";
import { defineOperation, type EntityModule, type Operation } from "../registry.js";
import { dateRange, entityId, pagination } from "../schemas/common.js";
import { EntityType } from "../types.js";

const categoryData = z.object({ name: z.string().min(1), notes: z.string().optional() }).strict();
const listInput = z.object({ ...pagination }).strict();
export const categoryOperations: Record<string, Operation> = {
  list: defineOperation({ description: "Which categories exist?", access: "read", input: listInput, handler: (query, client) => client.get("/categories", query) }),
  get: defineOperation({ description: "What are the details of this category?", access: "read", input: z.object({ id: entityId, ...dateRange }).strict(), handler: ({ id, ...query }, client) => client.get(`/categories/${id}`, query) }),
  create: defineOperation({ description: "Create a new category.", access: "write", input: categoryData, handler: (body, client) => client.post("/categories", body) }),
  update: defineOperation({ description: "Change an existing category.", access: "write", input: z.object({ id: entityId, category_update: categoryData }).strict(), handler: ({ id, category_update }, client) => client.put(`/categories/${id}`, category_update) }),
  delete: defineOperation({ description: "Delete a category.", access: "write", input: z.object({ id: entityId }).strict(), handler: async ({ id }, client) => { await client.del(`/categories/${id}`); return { deleted: true, id }; } }),
  list_transactions: defineOperation({ description: "Which transactions are in this category?", access: "read", input: z.object({ id: entityId, ...pagination, ...dateRange }).strict(), handler: ({ id, ...query }, client) => client.get(`/categories/${id}/transactions`, query) }),
  list_attachments: defineOperation({ description: "Which files are attached to this category?", access: "read", input: z.object({ id: entityId, ...pagination }).strict(), handler: ({ id, ...query }, client) => client.get(`/categories/${id}/attachments`, query) }),
};
export const categoriesModule: EntityModule = { entity: EntityType.Category, hint: "spending categories and their transactions", operations: categoryOperations };
