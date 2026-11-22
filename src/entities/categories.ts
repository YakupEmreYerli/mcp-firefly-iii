import { z } from "zod";
import { defineOperation, type EntityModule, type Operation } from "../registry.js";
import { dateRange, entityId, pagination } from "../schemas/common.js";
import { EntityType } from "../types.js";
import type { FireflyClient } from "../firefly.js";
import { ValidationError } from "../errors.js";
import { compareVersions, fireflyVersion } from "../version.js";

const categoryData = z.object({ name: z.string().min(1), notes: z.string().optional(), color: z.string().regex(/^[0-9a-fA-F]{6}$/, "six hex digits, no #").optional().describe("Needs Firefly III 6.7.8 or later") }).strict();
const listInput = z.object({ ...pagination }).strict();

/** Firefly III reads a category's color from 6.7.8 on; an older instance
 * answers 200 and drops it. Refuse rather than report a change that did not
 * happen. An unreadable version does not block the call. */
const COLOR_SINCE = "6.7.8";
async function assertColorSupported(body: { color?: string }, client: FireflyClient): Promise<void> {
  if (body.color === undefined) return;
  const version = await fireflyVersion(client);
  if (version !== undefined && compareVersions(version, COLOR_SINCE) < 0) {
    throw new ValidationError(`category color needs Firefly III ${COLOR_SINCE} or later; this instance runs ${version}`);
  }
}
export const categoryOperations: Record<string, Operation> = {
  list: defineOperation({ description: "Which categories exist?", access: "read", input: listInput, handler: (query, client) => client.get("/categories", query) }),
  get: defineOperation({ description: "What are the details of this category?", access: "read", input: z.object({ id: entityId, ...dateRange }).strict(), handler: ({ id, ...query }, client) => client.get(`/categories/${id}`, query) }),
  create: defineOperation({ description: "Create a new category.", access: "write", input: categoryData, handler: async (body, client) => { await assertColorSupported(body, client); return client.post("/categories", body); } }),
  update: defineOperation({ description: "Change an existing category.", access: "write", input: z.object({ id: entityId, category_update: categoryData }).strict(), handler: async ({ id, category_update }, client) => { await assertColorSupported(category_update, client); return client.put(`/categories/${id}`, category_update); } }),
  delete: defineOperation({ description: "Delete a category.", access: "destructive", input: z.object({ id: entityId }).strict(), handler: async ({ id }, client) => { await client.del(`/categories/${id}`); return { deleted: true, id }; } }),
  list_transactions: defineOperation({ description: "Which transactions are in this category?", access: "read", input: z.object({ id: entityId, ...pagination, ...dateRange }).strict(), handler: ({ id, ...query }, client) => client.get(`/categories/${id}/transactions`, query) }),
  list_attachments: defineOperation({ description: "Which files are attached to this category?", access: "read", input: z.object({ id: entityId, ...pagination }).strict(), handler: ({ id, ...query }, client) => client.get(`/categories/${id}/attachments`, query) }),
};
export const categoriesModule: EntityModule = { entity: EntityType.Category, hint: "spending categories and their transactions", operations: categoryOperations };
