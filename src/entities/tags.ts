import { z } from "zod";
import { defineOperation, type EntityModule, type Operation } from "../registry.js";
import { dateRange, entityId, isoDate, pagination } from "../schemas/common.js";
import { EntityType } from "../types.js";

const tagData = z.object({ tag: z.string().min(1), date: isoDate.optional(), description: z.string().optional(), latitude: z.number().optional(), longitude: z.number().optional(), zoom_level: z.number().int().optional() }).strict();
export const tagOperations: Record<string, Operation> = {
  list: defineOperation({ description: "Which tags exist?", access: "read", input: z.object({ ...pagination }).strict(), handler: (query, client) => client.get("/tags", query) }),
  get: defineOperation({ description: "What are the details of this tag?", access: "read", input: z.object({ id: entityId, ...pagination }).strict(), handler: ({ id, ...query }, client) => client.get(`/tags/${id}`, query) }),
  create: defineOperation({ description: "Create a new tag.", access: "write", input: tagData, handler: (body, client) => client.post("/tags", body) }),
  update: defineOperation({ description: "Change an existing tag.", access: "write", input: z.object({ id: entityId, tag_update: tagData.partial() }).strict(), handler: ({ id, tag_update }, client) => client.put(`/tags/${id}`, tag_update) }),
  delete: defineOperation({ description: "Delete a tag.", access: "destructive", input: z.object({ id: entityId }).strict(), handler: async ({ id }, client) => { await client.del(`/tags/${id}`); return { deleted: true, id }; } }),
  list_transactions: defineOperation({ description: "Which transactions have this tag?", access: "read", input: z.object({ id: entityId, ...pagination, ...dateRange }).strict(), handler: ({ id, ...query }, client) => client.get(`/tags/${id}/transactions`, query) }),
  list_attachments: defineOperation({ description: "Which files are attached to this tag?", access: "read", input: z.object({ id: entityId, ...pagination }).strict(), handler: ({ id, ...query }, client) => client.get(`/tags/${id}/attachments`, query) }),
};
export const tagsModule: EntityModule = { entity: EntityType.Tag, hint: "tags and tagged transactions", operations: tagOperations };
